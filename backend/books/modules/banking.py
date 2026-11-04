"""Banking: bank / card / cash accounts, manual bank transactions, statement import + matching / categorization,
bank rules, deposits from Undeposited Funds and reconciliation (port of modules/banking.js)."""
import builtins
import datetime
import json
import math
import random
import re
import time

from books.core.db import all, get, run, update, tx, safe, parse_json
from books.core.router import bad, not_found, forbidden, HttpError
from books.core.util import audit, round2, assert_unlocked, clean_body
from books.core.auth import perm, can
from books.core.jsutil import jsstr, truthy, to_int, now_iso, today
from books.core.ledger import post, unpost, sys_account, account_class
from books.core.payments import save_payment

BANK_TYPES = ['bank', 'credit_card', 'cash', 'payment_clearing']
MAX_IMPORT_ROWS = 5000  # same cap as the contact and item imports
MAX_BULK = 1000  # lines per bulk categorize/exclude
ACC_FIELDS = ['name', 'type', 'code', 'account_number', 'bank_name', 'ifsc', 'currency', 'description', 'is_active']

# deposit-like and withdrawal-like transaction types (direction of money for the bank account)
TXN_IN = ['deposit', 'transfer_in', 'owner_contribution', 'other_income', 'expense_refund', 'interest_income', 'sales_without_invoice',
          'deposit_from_other', 'card_payment']
TXN_OUT = ['withdrawal', 'transfer_out', 'owner_drawings', 'card_payment', 'expense_other']
ALL_TXN = list(dict.fromkeys([*TXN_IN, *TXN_OUT, 'transfer']))
DEFAULT_OFFSET = {
    'owner_contribution': 'owners_equity', 'owner_drawings': 'drawings', 'interest_income': 'interest_income', 'other_income': 'general_income',
    'sales_without_invoice': 'sales', 'deposit_from_other': 'general_income', 'deposit': 'general_income', 'expense_refund': 'uncategorized',
    'withdrawal': 'uncategorized', 'expense_other': 'uncategorized',
}
TRANSFER_TYPES = ['transfer', 'transfer_in', 'transfer_out', 'card_payment']


# ---------------- JS-semantics helpers ----------------
class _Undefined:
    """JavaScript `undefined` (a key missing from a JSON object)."""

    def __repr__(self):
        return 'undefined'


UNDEF = _Undefined()
NAN = float('nan')
_NUM_RE = re.compile(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


def _int_if_whole(n):
    if isinstance(n, float) and math.isfinite(n) and n.is_integer() and abs(n) < 2 ** 53:
        return int(n)
    return n


def _js_number(v):
    """Number(v) (NaN as float('nan'))."""
    if v is UNDEF:
        return NAN
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s == '':
            return 0
        if _NUM_RE.match(s):
            return _int_if_whole(float(s))
        if s in ('Infinity', '+Infinity'):
            return math.inf
        if s == '-Infinity':
            return -math.inf
        m = re.match(r'0([xXoObB])([0-9a-fA-F]+)\Z', s)
        if m:
            try:
                return int(m.group(2), {'x': 16, 'o': 8, 'b': 2}[m.group(1).lower()])
            except ValueError:
                return NAN
        return NAN
    if isinstance(v, list):
        if not v:
            return 0
        if len(v) == 1:
            return _js_number(_js_string(v[0]) if v[0] is not None else '')
        return NAN
    return NAN


def _isnan(n):
    return isinstance(n, float) and math.isnan(n)


def _num_truthy(v):
    """Boolean(Number(v))"""
    n = _js_number(v)
    return not _isnan(n) and n != 0


def _js_string(v):
    """String(v)"""
    if v is UNDEF:
        return 'undefined'
    if isinstance(v, str):
        return v
    if v is None or isinstance(v, (bool, int, float)):
        return jsstr(v)
    if isinstance(v, list):
        return ','.join('' if (x is None or x is UNDEF) else _js_string(x) for x in v)
    if isinstance(v, dict):
        return '[object Object]'
    return str(v)


def _or(a, b):
    """a || b"""
    return a if truthy(a) else b


def _obj(v):
    return v if isinstance(v, dict) else {}


def _key(obj, k):
    """obj[k] for JSON values (missing -> UNDEF). Throws like JS on null/undefined."""
    if obj is None or obj is UNDEF:
        raise TypeError(f"Cannot read properties of {_js_string(obj)} (reading '{_js_string(k)}')")
    if isinstance(obj, dict):
        return obj.get(_js_string(k), UNDEF)
    if isinstance(obj, (list, str)):
        ks = _js_string(k)
        if ks == 'length':
            return len(obj)
        if re.fullmatch(r'0|[1-9][0-9]*', ks) and int(ks) < len(obj):
            return obj[int(ks)]
    return UNDEF


def _nn(v):
    """undefined -> None"""
    return None if v is UNDEF else v


def _dumps(v):
    """JSON.stringify (integral floats print as integers, like JS)."""
    def conv(x):
        if isinstance(x, float):
            return _int_if_whole(x)
        if isinstance(x, dict):
            return {k: conv(y) for k, y in x.items() if y is not UNDEF}
        if isinstance(x, (list, tuple)):
            return [None if y is UNDEF else conv(y) for y in x]
        return x
    return json.dumps(conv(v), separators=(',', ':'), ensure_ascii=False)


def _id(v):
    """A body/route value used as an integer id in SQL (Number(v); non-numeric -> matches nothing)."""
    if v is UNDEF:
        return None
    return to_int(v)


def _insert(table, obj):
    """db.js insert(): null values are written explicitly (only undefined keys fall back to column defaults)."""
    keys = [k for k, v in obj.items() if v is not UNDEF]
    return get(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)}) RETURNING id", *[obj[k] for k in keys])['id']


def _err_message(e):
    if isinstance(e, HttpError):
        return e.message
    return str(e)


# ---------------- helpers ----------------
def _sgn_of(typ):
    return -1 if account_class(typ) == 'liability' else 1


def _abs2(v):
    n = _js_number(v)
    return round2(abs(n) if not _isnan(n) and n else 0)


def bank_account(org_id, id):  # noqa: A002
    a = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not a or a['type'] not in BANK_TYPES:
        raise not_found('Bank account')
    return a


def _account_row(org_id, a):
    l = get('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c, COUNT(*) AS n FROM ledger WHERE account_id = ? AND org_id = ?', a['id'], org_id)
    sgn = _sgn_of(a['type'])
    counts = get("""SELECT SUM(CASE WHEN status = 'uncategorized' THEN 1 ELSE 0 END) AS unc,
                           SUM(CASE WHEN status IN ('categorized','matched') THEN 1 ELSE 0 END) AS done, COUNT(*) AS n
                    FROM bank_statement_lines WHERE account_id = ? AND org_id = ?""", a['id'], org_id)
    last_with_bal = get('SELECT balance, date FROM bank_statement_lines WHERE account_id = ? AND org_id = ? AND balance IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1',
                        a['id'], org_id)
    last_line = get('SELECT MAX(date) AS d FROM bank_statement_lines WHERE account_id = ? AND org_id = ?', a['id'], org_id)
    rec = get("SELECT MAX(end_date) AS d FROM reconciliations WHERE account_id = ? AND org_id = ? AND status = 'completed'", a['id'], org_id)
    return {
        'id': a['id'], 'name': a['name'], 'code': a['code'], 'type': a['type'], 'system_code': a['system_code'], 'is_system': a['is_system'],
        'is_active': a['is_active'], 'bank_name': a['bank_name'], 'account_number': a['account_number'], 'ifsc': a['ifsc'],
        'currency': a['currency'], 'description': a['description'],
        'debit': round2(l['d']), 'credit': round2(l['c']), 'balance': round2(sgn * (l['d'] - l['c'])), 'ledger_count': l['n'],
        'uncategorized': counts['unc'] or 0, 'categorized': counts['done'] or 0, 'statement_lines': counts['n'] or 0,
        'statement_balance': round2(last_with_bal['balance']) if last_with_bal else None,
        'statement_balance_date': _or((last_with_bal or {}).get('date'), None),
        'last_statement_date': _or((last_line or {}).get('d'), None), 'last_reconciled': _or((rec or {}).get('d'), None),
    }


def _list_accounts(org_id, include_inactive=True):
    rows = all(f"""SELECT * FROM accounts WHERE org_id = ? AND type IN ({','.join('?' for _ in BANK_TYPES)}) {'' if include_inactive else 'AND is_active = 1'}
                   ORDER BY CASE type WHEN 'bank' THEN 0 WHEN 'credit_card' THEN 1 WHEN 'cash' THEN 2 ELSE 3 END, name COLLATE "C", id""",
               org_id, *BANK_TYPES)
    return [_account_row(org_id, a) for a in rows]


def _check_account(org_id, id, label='account'):  # noqa: A002
    if not truthy(id):
        return None
    a = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not a:
        raise bad(f'Invalid {label}')
    return a


def _source_net(org_id, src_type, src_id, account_id):
    """Ledger lines for one source on one account, net debit - credit."""
    return round2(get('SELECT COALESCE(SUM(debit - credit),0) AS n FROM ledger WHERE org_id = ? AND src_type = ? AND src_id = ? AND account_id = ?',
                      org_id, src_type, src_id, account_id)['n'])


def _source_number(org_id, src_type, src_id):
    return get('SELECT number, contact_id, date FROM ledger WHERE org_id = ? AND src_type = ? AND src_id = ? ORDER BY id LIMIT 1', org_id, src_type, src_id)


def _assert_not_reconciled(org_id, src_type, src_id):
    r = get("""SELECT r.end_date FROM ledger l JOIN reconciliations r ON r.id = l.reconciliation_id
               WHERE l.org_id = ? AND l.src_type = ? AND l.src_id = ? AND r.status = 'completed' ORDER BY l.id LIMIT 1""", org_id, src_type, src_id)
    if r:
        raise bad(f"This transaction is part of a completed reconciliation (up to {r['end_date']}). Undo the reconciliation first.")


def heal_links(org_id):
    """Reset statement lines whose matched transaction no longer exists in the ledger (deleted, voided or turned into a draft elsewhere)."""
    run("""UPDATE bank_statement_lines SET status = 'uncategorized', matched_type = NULL, matched_id = NULL
           WHERE org_id = ? AND status IN ('categorized','matched') AND matched_type IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.org_id = bank_statement_lines.org_id AND l.src_type = bank_statement_lines.matched_type
                           AND l.src_id = bank_statement_lines.matched_id)""", org_id)


# ---------------- bank transactions ----------------
def load_txn(org_id, id):  # noqa: A002
    t = get("""SELECT t.*, a.name AS account_name, o.name AS offset_account_name, ta.name AS to_account_name, c.display_name AS contact_name
               FROM bank_txns t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts o ON o.id = t.offset_account_id
               LEFT JOIN accounts ta ON ta.id = t.to_account_id LEFT JOIN contacts c ON c.id = t.contact_id
               WHERE t.id = ? AND t.org_id = ?""", _id(id), org_id)
    if not t:
        raise not_found('Bank transaction')
    parse_json(t, ['splits'])
    t['payments'] = all("""SELECT bdp.payment_id, bdp.amount, p.number, p.date, c.display_name AS contact_name FROM bank_deposit_payments bdp
                           LEFT JOIN payments p ON p.id = bdp.payment_id LEFT JOIN contacts c ON c.id = p.contact_id WHERE bdp.bank_txn_id = ?
                           ORDER BY bdp.id""", t['id'])
    return t


def _post_txn(org, t):
    amt = round2(t['amount'])
    counter = []
    splits = t.get('splits')
    if isinstance(splits, (list, str)) and len(splits):
        for s in splits:
            counter.append({'account_id': _nn(_key(s, 'offset_account_id')), 'amount': round2(_nn(_key(s, 'amount'))),
                            'description': _or(_nn(_key(s, 'description')), t['description'])})
    else:
        counter.append({'account_id': _or(t['to_account_id'], t['offset_account_id']), 'amount': amt, 'description': t['description']})
    lines = []
    if t['direction'] == 'in':
        lines.append({'account_id': t['account_id'], 'debit': amt, 'description': t['description']})
        for l in counter:
            lines.append({'account_id': l['account_id'], 'credit': l['amount'], 'description': l['description']})
    else:
        for l in counter:
            lines.append({'account_id': l['account_id'], 'debit': l['amount'], 'description': l['description']})
        lines.append({'account_id': t['account_id'], 'credit': amt, 'description': t['description']})
    post(org['id'], 'bank_txn', t['id'], date=t['date'], number=_or(t['reference'], None), contact_id=_or(t['contact_id'], None), lines=lines)


TXN_FIELDS = ['account_id', 'date', 'txn_type', 'amount', 'direction', 'offset_account_id', 'to_account_id', 'contact_id', 'reference',
              'description', 'splits']


def save_txn(req, body, id=None):  # noqa: A002
    """Create or update a manual bank transaction.
    body: {account_id, date, txn_type, amount, direction?, offset_account_id, to_account_id, contact_id, reference, description, splits}"""
    org = req.org
    body = _obj(body)

    def _do():
        existing = load_txn(org['id'], id) if truthy(id) else None
        if existing:
            assert_unlocked(org, existing['date'], 'bank')
            _assert_not_reconciled(org['id'], 'bank_txn', existing['id'])
        b = {**(existing or {}), **clean_body(body, TXN_FIELDS)}
        date = _or(b.get('date'), None) or today()
        assert_unlocked(org, date, 'bank')
        acct = bank_account(org['id'], b.get('account_id', UNDEF))
        typ = _or(b.get('txn_type'), 'deposit')
        if typ not in ALL_TXN:
            raise bad(f'Unknown transaction type {_js_string(typ)}')
        direction = _or(body.get('direction'), None)
        if not truthy(direction):
            direction = existing['direction'] if (existing and not truthy(body.get('txn_type'))) else None
        if not truthy(direction):
            if typ in TXN_IN and typ not in TXN_OUT:
                direction = 'in'
            elif typ in TXN_OUT and typ not in TXN_IN:
                direction = 'out'
            elif typ == 'transfer':
                direction = 'out'
            else:
                direction = None
        if not truthy(direction):
            direction = 'in' if acct['type'] == 'credit_card' else 'out'  # card_payment: into the card / out of the bank
        if direction not in ('in', 'out'):
            raise bad('Invalid direction')
        if typ == 'transfer':
            typ = 'transfer_in' if direction == 'in' else 'transfer_out'
        amount = round2(b.get('amount'))
        if not amount > 0:
            raise bad('Enter an amount greater than zero')
        splits = None
        if isinstance(b.get('splits'), list):
            splits = [s for s in b['splits'] if isinstance(s, dict) and truthy(s.get('offset_account_id')) and _num_truthy(s.get('amount', UNDEF))]
        if splits is not None and not splits:
            splits = None
        offset = _js_number(b.get('offset_account_id')) if truthy(b.get('offset_account_id')) else None
        to_acc = _js_number(b.get('to_account_id')) if truthy(b.get('to_account_id')) else None
        if typ in TRANSFER_TYPES:
            to_acc = _or(to_acc, offset)
            if not truthy(to_acc):
                raise bad('Choose the account to transfer to' if direction == 'out' else 'Choose the account the money came from')
            if to_acc == acct['id']:
                raise bad('Transfer accounts must be different')
            _check_account(org['id'], to_acc, 'transfer account')
            offset = None
            splits = None
        elif splits:
            total = 0
            for x in splits:
                total = total + _js_number(x.get('amount', UNDEF))
            total = round2(total)
            if abs(total - amount) > 0.005:
                raise bad(f'Split amounts ({jsstr(total)}) must add up to {jsstr(amount)}')
            for s in splits:
                _check_account(org['id'], s.get('offset_account_id'))
                if _js_number(s.get('offset_account_id')) == acct['id']:
                    raise bad('Choose a different account')
            offset = None
            to_acc = None
        else:
            if not truthy(offset):
                offset = sys_account(org['id'], DEFAULT_OFFSET[typ]) if DEFAULT_OFFSET.get(typ) else None
            if not truthy(offset):
                raise bad('Choose an account')
            if offset == acct['id']:
                raise bad('Choose a different account')
            _check_account(org['id'], offset)
            to_acc = None
        contact = get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', _id(b.get('contact_id')), org['id']) if truthy(b.get('contact_id')) else None
        if truthy(b.get('contact_id')) and not contact:
            raise bad('Invalid contact')
        fields = {
            'account_id': acct['id'], 'date': date, 'txn_type': typ, 'direction': direction, 'amount': amount,
            'offset_account_id': None if _isnan(offset) else offset, 'to_account_id': None if _isnan(to_acc) else to_acc,
            'contact_id': _or((contact or {}).get('id'), None), 'reference': _or(b.get('reference'), None), 'description': _or(b.get('description'), None),
            'splits': _dumps([{'offset_account_id': _js_number(s.get('offset_account_id')), 'amount': round2(s.get('amount')),
                               'description': _or(s.get('description'), None)} for s in splits]) if splits else None,
        }
        tid = id
        if existing:
            update('bank_txns', id, fields)
        else:
            tid = _insert('bank_txns', {**fields, 'org_id': org['id'], 'statement_line_id': _or(body.get('statement_line_id'), None),
                                        'created_by': (req.user or {}).get('id')})
        t = load_txn(org['id'], tid)
        _post_txn(org, t)
        return t
    return tx(_do)


def delete_txn(req, id):  # noqa: A002
    org = req.org

    def _do():
        t = load_txn(org['id'], id)
        assert_unlocked(org, t['date'], 'bank')
        _assert_not_reconciled(org['id'], 'bank_txn', t['id'])
        unpost(org['id'], 'bank_txn', t['id'])
        run('DELETE FROM bank_deposit_payments WHERE bank_txn_id = ?', t['id'])
        run('DELETE FROM bank_txns WHERE id = ?', t['id'])
        run("UPDATE bank_statement_lines SET status = 'uncategorized', matched_type = NULL, matched_id = NULL WHERE org_id = ? AND matched_type = 'bank_txn' AND matched_id = ?",
            org['id'], t['id'])
        return {'ok': True}
    return tx(_do)


# ---------------- statement lines ----------------
def _load_line(org_id, id):  # noqa: A002
    l = get('SELECT * FROM bank_statement_lines WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not l:
        raise not_found('Statement line')
    return parse_json(l, ['suggestion'])


def _decorate_line(org_id, l):
    parse_json(l, ['suggestion'])
    l['deposit'] = round2(l['amount']) if l['amount'] > 0 else 0
    l['withdrawal'] = round2(-l['amount']) if l['amount'] < 0 else 0
    if truthy(l.get('matched_type')) and truthy(l.get('matched_id')):
        s = _source_number(org_id, l['matched_type'], l['matched_id'])
        l['matched_number'] = _or((s or {}).get('number'), None)
        if s and truthy(s.get('contact_id')):
            c = get('SELECT display_name FROM contacts WHERE id = ?', s['contact_id'])
            if c:
                l['matched_contact'] = c['display_name']
            # (contact row missing -> undefined -> key omitted from the JSON, as in Node)
        else:
            l['matched_contact'] = None
        if l['matched_type'] == 'bank_txn':
            t = get('SELECT txn_type, offset_account_id, to_account_id FROM bank_txns WHERE id = ?', l['matched_id'])
            if t:
                l['matched_txn_type'] = t['txn_type']
                acc = get('SELECT name FROM accounts WHERE id = ?', _or(t['to_account_id'], t['offset_account_id']))
                if acc:
                    l['matched_account'] = acc['name']
            else:
                l['matched_account'] = None
    return l


_MON = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12}


def norm_date(v, fmt='dmy'):
    """Normalise a date string to YYYY-MM-DD. fmt: 'dmy' (default) | 'mdy' | 'ymd'."""
    if not truthy(v) or v is UNDEF:
        return None
    s = _js_string(v).strip()
    m = re.match(r'([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})', s)
    if m:
        return f'{m[1]}-{m[2].rjust(2, "0")}-{m[3].rjust(2, "0")}'
    m = re.match(r'([0-9]{4})([0-9]{2})([0-9]{2})', s)  # OFX 20260131
    if m:
        return f'{m[1]}-{m[2]}-{m[3]}'
    m = re.match(r'([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{2,4})\Z', s)
    if m:
        a, b, y = m.groups()
        if len(y) == 2:
            y = f'20{y}'
        d, mo = (b, a) if fmt == 'mdy' else (a, b)
        if int(mo) > 12 and int(d) <= 12:
            d, mo = mo, d
        return f'{y}-{mo.rjust(2, "0")}-{d.rjust(2, "0")}'
    m = re.match(r'([0-9]{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+([0-9]{2,4})\Z', s)
    if m and _MON.get(m[2].lower()):
        y = f'20{m[3]}' if len(m[3]) == 2 else m[3]
        return f'{y}-{str(_MON[m[2].lower()]).rjust(2, "0")}-{m[1].rjust(2, "0")}'
    return None


def parse_amount(v):
    if v is None or v is UNDEF or v == '':
        return 0
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    s = _js_string(v).strip()
    neg = False
    if re.match(r'\([^\n\r\u2028\u2029]*\)\Z', s):
        neg = True
        s = s[1:-1]
    if re.search(r'\bDR\b', s, re.I | re.A):
        neg = True
    s = re.sub(r'\b(CR|DR)\b', '', s, flags=re.I | re.A)
    s = re.sub(r'[^0-9.-]', '', s)
    if s == '':
        n = 0
    else:
        try:
            n = _int_if_whole(float(s))
        except ValueError:
            return NAN
    return -abs(n) if neg else n


# ---- rules ----
def _load_rule(org_id, id):  # noqa: A002
    r = get('SELECT * FROM bank_rules WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not r:
        raise not_found('Rule')
    return parse_json(r, ['conditions', 'action'])


def _filter_list(v, pred):
    """arr.filter(pred) (TypeError like JS when v is not an array)."""
    if not isinstance(v, list):
        raise TypeError(f'{_js_string(v)}.filter is not a function')
    return [x for x in v if pred(x)]


def rule_matches(rule, line):
    if not truthy(rule.get('is_active')):
        return False
    if truthy(rule.get('account_id')) and _js_number(rule.get('account_id')) != _js_number(line.get('account_id')):
        return False
    amount = _js_number(line.get('amount', UNDEF))
    if rule.get('apply_to') == 'deposits' and not amount > 0:
        return False
    if rule.get('apply_to') == 'withdrawals' and not amount < 0:
        return False
    conds = _filter_list(_or(rule.get('conditions'), []),
                         lambda c: isinstance(c, dict) and truthy(c.get('field')) and truthy(c.get('op')))
    if not conds:
        return False

    def test(c):
        value = c.get('value', UNDEF)
        op = c.get('op')
        if c.get('field') == 'amount':
            n = _js_number(line.get('amount', UNDEF))
            a = abs(n) if not _isnan(n) and n else 0
            v = _js_number(value)
            if op == 'gt':
                return a > v
            if op == 'lt':
                return a < v
            if op == 'equals':
                return abs(a - v) < 0.005
            return _js_string(value) in jsstr(a)
        raw = line.get(_js_string(c.get('field')))
        s = _js_string(raw if truthy(raw) else '').lower()
        v = _js_string('' if value is UNDEF or value is None else value).lower()
        if op == 'contains':
            return v != '' and v in s
        if op == 'not_contains':
            return v not in s
        if op == 'equals':
            return s == v
        if op == 'starts_with':
            return v != '' and s.startswith(v)
        if op == 'ends_with':
            return v != '' and s.endswith(v)
        if op == 'gt':
            return _js_number(s) > _js_number(v)
        if op == 'lt':
            return _js_number(s) < _js_number(v)
        return False
    if rule.get('match') == 'any':
        return any(test(c) for c in conds)
    return builtins.all(test(c) for c in conds)


def _active_rules(org_id):
    return [parse_json(r, ['conditions', 'action']) for r in all('SELECT * FROM bank_rules WHERE org_id = ? AND is_active = 1 ORDER BY priority, id', org_id)]


def _apply_rules(req, line, rules):
    """Apply the first matching rule to an uncategorized line: store a suggestion, or categorize it when the rule says so."""
    rule = next((r for r in rules if rule_matches(r, line)), None)
    if not rule:
        return None
    a = _or(rule.get('action'), {})
    a = a if isinstance(a, dict) else {}
    suggestion = {
        'rule_id': rule['id'], 'rule_name': rule['name'], 'txn_type': _or(a.get('txn_type'), 'deposit' if line['amount'] > 0 else 'withdrawal'),
        'offset_account_id': _or(a.get('offset_account_id'), None), 'contact_id': _or(a.get('contact_id'), None), 'reference': _or(a.get('reference'), None),
    }
    update('bank_statement_lines', line['id'], {'rule_id': rule['id'], 'suggestion': _dumps(suggestion)})
    if truthy(a.get('auto_categorize')):
        try:
            categorize_line(req, _load_line(req.org['id'], line['id']), {**suggestion, 'reference': _or(suggestion['reference'], line.get('reference'))})
            return 'categorized'
        except Exception:  # noqa: BLE001
            return 'suggested'
    return 'suggested'


# ---- import ----
def _base36(n):
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while True:
        n, r = divmod(n, 36)
        out = chars[r] + out
        if not n:
            return out


def import_lines(req, account_id, body):
    org = req.org
    acct = bank_account(org['id'], account_id)
    body = _obj(body)
    rows = body['rows'] if isinstance(body.get('rows'), list) else []
    if not rows:
        raise bad('Nothing to import')
    if len(rows) > MAX_IMPORT_ROWS:
        raise bad(f'Import at most {MAX_IMPORT_ROWS} rows at a time')
    mp = _or(body.get('mapping'), {})
    fmt = _or(body.get('date_format'), None) or _or(_nn(_key(mp, 'date_format')), None) or 'dmy'

    def pick(r, k):
        mk = _key(mp, k)
        return _key(r, mk) if truthy(_nn(mk)) else _key(r, k)

    batch = f'{_base36(int(time.time() * 1000))}{"".join(random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(4))}'
    res = {'batch': batch, 'imported': 0, 'duplicates': 0, 'skipped': 0, 'categorized': 0, 'suggested': 0, 'errors': [], 'ids': []}

    def _do():
        rules = _active_rules(org['id'])
        for i, r in enumerate(rows):
            date = norm_date(_nn(pick(r, 'date')), fmt)

            def text(k):
                v = _nn(pick(r, k))
                return _js_string('' if v is None else v).strip() or None
            description = text('description')
            reference = text('reference')
            payee = text('payee')
            amt = _nn(pick(r, 'amount'))
            if amt is not None and amt != '':
                amount = parse_amount(amt)
            else:
                amount = abs(parse_amount(_nn(pick(r, 'deposit')))) - abs(parse_amount(_nn(pick(r, 'withdrawal'))))
            if truthy(_nn(_key(mp, 'invert'))) or truthy(body.get('invert')):
                amount = -amount
            amount = NAN if _isnan(amount) else round2(amount)
            bal_raw = _nn(pick(r, 'balance'))
            balance = round2(parse_amount(bal_raw)) if (bal_raw is not None and bal_raw != '' and not _isnan(parse_amount(bal_raw))) else None
            if not date:
                raw = _nn(pick(r, 'date'))
                res['skipped'] += 1
                res['errors'].append(f'Row {i + 1}: invalid date "{_js_string("" if raw is None else raw)}"')
                continue
            if not amount or _isnan(amount):
                res['skipped'] += 1
                res['errors'].append(f'Row {i + 1}: no amount')
                continue
            dup = get("""SELECT id FROM bank_statement_lines WHERE org_id = ? AND account_id = ? AND date = ? AND ABS(amount - ?) < 0.005
                         AND COALESCE(description,'') = COALESCE(?::text, '') LIMIT 1""", org['id'], acct['id'], date, amount, description)
            if dup:
                res['duplicates'] += 1
                continue
            lid = _insert('bank_statement_lines', {'org_id': org['id'], 'account_id': acct['id'], 'date': date, 'description': description,
                                                   'reference': reference, 'payee': payee, 'amount': amount, 'balance': balance,
                                                   'status': 'uncategorized', 'import_batch': batch})
            res['imported'] += 1
            res['ids'].append(lid)
            out = _apply_rules(req, _load_line(org['id'], lid), rules)
            if out == 'categorized':
                res['categorized'] += 1
            if out == 'suggested':
                res['suggested'] += 1
        return res
    return tx(_do)


# ---- match suggestions ----
MATCHABLE = ['payment_received', 'payment_made', 'expense', 'bank_txn', 'journal', 'salesreceipt', 'refund']
_LABEL = {'payment_received': 'Customer Payment', 'payment_made': 'Vendor Payment', 'expense': 'Expense', 'bank_txn': 'Bank Transaction',
          'journal': 'Journal', 'salesreceipt': 'Sales Receipt', 'refund': 'Refund'}


def _parse_day(d):
    """new Date('YYYY-MM-DD') as V8 parses it (UTC; day 1-31 accepted for every month and overflows), else None (Invalid Date)."""
    m = re.match(r'([0-9]{4})-([0-9]{2})-([0-9]{2})\Z', d) if isinstance(d, str) else None
    if not m:
        return None
    y, mo, dd = int(m[1]), int(m[2]), int(m[3])
    if not (1 <= mo <= 12 and 1 <= dd <= 31) or y < 1:
        return None
    try:
        return datetime.date(y, mo, 1) + datetime.timedelta(days=dd - 1)
    except (ValueError, OverflowError):
        return None


def _add_days(d, n):
    x = _parse_day(d)
    if x is None:
        raise ValueError('Invalid time value')
    return (x + datetime.timedelta(days=n)).isoformat()


def _is_taken(org_id, typ, id, except_line):  # noqa: A002
    return bool(get("""SELECT id FROM bank_statement_lines WHERE org_id = ? AND matched_type = ? AND matched_id = ? AND status IN ('categorized','matched') AND id != ?
                       LIMIT 1""", org_id, typ, id, except_line or 0))


def match_suggestions(org_id, line):
    amt = _abs2(line['amount'])
    net = amt if line['amount'] > 0 else -amt
    frm, to = _add_days(line['date'], -7), _add_days(line['date'], 7)
    rows = all(f"""SELECT src_type, src_id, MIN(date) AS date, MAX(number COLLATE "C") AS number, MAX(contact_id) AS contact_id,
                          MAX(description COLLATE "C") AS description, SUM(debit - credit) AS net
                   FROM ledger WHERE org_id = ? AND account_id = ? AND date >= ? AND date <= ? AND src_type IN ({','.join('?' for _ in MATCHABLE)})
                   GROUP BY src_type, src_id HAVING ABS(SUM(debit - credit) - ?) < 0.005
                   ORDER BY src_type COLLATE "C", src_id""", org_id, line['account_id'], frm, to, *MATCHABLE, net)
    line_day = _parse_day(line['date'])
    matches = []
    for r in rows:
        if _is_taken(org_id, r['src_type'], r['src_id'], line['id']):
            continue
        m = {'kind': 'transaction', 'matched_type': r['src_type'], 'matched_id': r['src_id'], 'label': _LABEL.get(r['src_type']) or r['src_type'],
             'number': r['number'], 'date': r['date'], 'amount': amt}
        if truthy(r['contact_id']):
            c = get('SELECT display_name FROM contacts WHERE id = ?', r['contact_id'])
            if c:
                m['contact_name'] = c['display_name']
        else:
            m['contact_name'] = None
        m['description'] = r['description']
        rd = _parse_day(r['date'])
        m['days_apart'] = abs((rd - line_day).days) if (rd and line_day) else NAN
        matches.append(m)
    matches.sort(key=lambda x: 0 if _isnan(x['days_apart']) else x['days_apart'])
    doc_type = 'invoice' if line['amount'] > 0 else 'bill'
    docs = []
    for d in all("""SELECT d.id, d.number, d.date, d.due_date, d.total, d.balance, d.contact_id, c.display_name AS contact_name FROM documents d
                    LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.org_id = ? AND d.doc_type = ? AND d.status = 'open' AND ABS(d.balance - ?) < 0.005
                    ORDER BY d.date, d.id LIMIT 20""", org_id, doc_type, amt):
        docs.append({'kind': doc_type, f'{doc_type}_id': d['id'], 'label': 'Invoice' if doc_type == 'invoice' else 'Bill', 'number': d['number'],
                     'date': d['date'], 'due_date': d['due_date'], 'amount': d['balance'], 'total': d['total'], 'contact_name': d['contact_name'],
                     'contact_id': d['contact_id']})
    return {'line': _decorate_line(org_id, dict(line)), 'matches': matches, 'documents': docs}


def _set_line(line_id, status, matched_type=None, matched_id=None):
    update('bank_statement_lines', line_id, {'status': status, 'matched_type': matched_type, 'matched_id': matched_id})


def _need(req, module, action='create'):
    """Recording a payment or expense from a statement line needs the same right as recording it directly."""
    if not can(req, module, action):
        raise forbidden()


def match_line(req, line, body):
    org = req.org
    body = _obj(body)
    if line['status'] != 'uncategorized':
        raise bad('This statement line is already categorized or excluded')
    amt = _abs2(line['amount'])

    def _do():
        if truthy(body.get('invoice_id')) or truthy(body.get('bill_id')):
            is_inv = truthy(body.get('invoice_id'))
            if is_inv and not line['amount'] > 0:
                raise bad('Only deposits can be matched to invoices')
            if not is_inv and not line['amount'] < 0:
                raise bad('Only withdrawals can be matched to bills')
            d = get('SELECT * FROM documents WHERE id = ? AND org_id = ? AND doc_type = ?', _id(_or(body.get('invoice_id'), body.get('bill_id'))),
                    org['id'], 'invoice' if is_inv else 'bill')
            if not d:
                raise not_found('Invoice' if is_inv else 'Bill')
            if d['status'] != 'open' or not (d['balance'] or 0) > 0:
                raise bad(f"{d['number']} is not open for payment")
            kind = 'received' if is_inv else 'made'
            alloc = min(amt, d['balance'])
            desc = line.get('description')
            _need(req, 'sales' if kind == 'received' else 'purchases')
            p = save_payment(req, kind, {
                'contact_id': d['contact_id'], 'date': line['date'], 'amount': amt, 'account_id': line['account_id'], 'mode': 'Bank Transfer',
                'reference': _or(line.get('reference'), None) or _or(desc[:60] if isinstance(desc, str) else None, None) or None,
                'notes': _or(desc, None),
                'allocations': [{'document_id': d['id'], 'amount': alloc}],
            })
            audit(req, f'payment_{kind}', p['id'], 'created', f"{p['number']} {jsstr(p['amount'])} (bank match)")
            audit(req, 'document', d['id'], f'payment of {jsstr(alloc)} recorded', p['number'])
            _set_line(line['id'], 'matched', f'payment_{kind}', p['id'])
            return {'ok': True, 'matched_type': f'payment_{kind}', 'matched_id': p['id'], 'payment': p}
        typ = body.get('matched_type')
        mid = _js_number(body.get('matched_id', UNDEF))
        if typ not in MATCHABLE or _isnan(mid) or not mid:
            raise bad('Choose a transaction to match')
        net = _source_net(org['id'], typ, mid, line['account_id'])
        if not net:
            raise bad('That transaction does not touch this bank account')
        if abs(net - line['amount']) > 0.005:
            raise bad(f"Amounts differ: the transaction is {jsstr(net)}, the statement line is {jsstr(line['amount'])}")
        if _is_taken(org['id'], typ, mid, line['id']):
            raise bad('That transaction is already matched to another statement line')
        _set_line(line['id'], 'matched', typ, mid)
        return {'ok': True, 'matched_type': typ, 'matched_id': mid}
    return tx(_do)


def categorize_line(req, line, body):
    """Categorize a statement line: creates a bank_txn, an expense or a payment and links it."""
    org = req.org
    body = _obj(body)
    if line['status'] != 'uncategorized':
        raise bad('This statement line is already categorized or excluded')
    amt = _abs2(line['amount'])
    dir_in = line['amount'] > 0
    typ = _or(body.get('txn_type'), 'deposit' if dir_in else 'withdrawal')

    def _do():
        nonlocal typ
        if typ == 'expense':
            from books.modules.expenses import save_expense  # noqa: PLC0415
            if dir_in:
                raise bad('Deposits cannot be categorized as an expense')
            splits = _filter_list(_or(body.get('splits'), []),
                                  lambda s: truthy(_nn(_key(s, 'offset_account_id'))) and _num_truthy(_key(s, 'amount')))
            expense_account = body.get('offset_account_id')
            if not truthy(expense_account):
                expense_account = None if splits else sys_account(org['id'], 'uncategorized')
            eb = {
                'date': line['date'], 'paid_through_id': line['account_id'],
                'account_id': expense_account,
                'amount': amt, 'tax_id': _or(body.get('tax_id'), None), 'tax_inclusive': 1, 'vendor_id': _or(body.get('contact_id'), None),
                'customer_id': _or(body.get('customer_id'), None), 'reference': _or(body.get('reference'), None) or _or(line.get('reference'), None),
                'notes': _or(body.get('description'), None) or _or(line.get('description'), None),
            }
            if splits:
                eb['splits'] = [{'account_id': s.get('offset_account_id'), 'amount': round2(s.get('amount')),
                                 **({'description': s['description']} if 'description' in s else {})} for s in splits]
            _need(req, 'purchases')
            e = save_expense(req, eb)
            if abs(e['total'] - amt) > 0.005:
                raise bad(f"The expense total {jsstr(e['total'])} does not equal the statement amount {jsstr(amt)}")
            audit(req, 'expense', e['id'], 'created', f"{jsstr(e['total'])} (bank categorization)")
            matched_type, matched_id, created = 'expense', e['id'], e
        elif typ in ('customer_payment', 'vendor_payment'):
            kind = 'received' if typ == 'customer_payment' else 'made'
            if kind == 'received' and not dir_in:
                raise bad('A customer payment must be a deposit')
            if kind == 'made' and dir_in:
                raise bad('A vendor payment must be a withdrawal')
            _need(req, 'sales' if kind == 'received' else 'purchases')
            p = save_payment(req, kind, {
                'contact_id': body.get('contact_id'), 'date': line['date'], 'amount': amt, 'account_id': line['account_id'],
                'mode': _or(body.get('mode'), 'Bank Transfer'),
                'reference': _or(body.get('reference'), None) or _or(line.get('reference'), None),
                'notes': _or(body.get('description'), None) or _or(line.get('description'), None),
                'allocations': _or(body.get('allocations'), []),
            })
            audit(req, f'payment_{kind}', p['id'], 'created', f"{p['number']} {jsstr(p['amount'])} (bank categorization)")
            matched_type, matched_id, created = f'payment_{kind}', p['id'], p
        else:
            if typ == 'transfer':
                typ = 'transfer_in' if dir_in else 'transfer_out'
            tb = {
                'account_id': line['account_id'], 'date': line['date'], 'txn_type': typ, 'direction': 'in' if dir_in else 'out', 'amount': amt,
                'reference': _or(body.get('reference'), None) or _or(line.get('reference'), None),
                'description': _or(body.get('description'), None) or _or(line.get('description'), None),
                'statement_line_id': line['id'],
            }
            for k in ('offset_account_id', 'to_account_id', 'contact_id', 'splits'):
                if k in body:  # undefined keys are skipped by cleanBody in Node
                    tb[k] = body[k]
            t = save_txn(req, tb)
            audit(req, 'bank_txn', t['id'], 'created', f"{_js_string(t['txn_type'])} {jsstr(t['amount'])} (bank categorization)")
            matched_type, matched_id, created = 'bank_txn', t['id'], t
        _set_line(line['id'], 'categorized', matched_type, matched_id)
        return {'ok': True, 'matched_type': matched_type, 'matched_id': matched_id, 'created': created}
    return tx(_do)


def uncategorize_line(req, line):
    def _do():
        if line['status'] not in ('categorized', 'matched'):
            raise bad('This statement line is not categorized')
        if line.get('matched_type') == 'bank_txn' and truthy(line.get('matched_id')):
            t = get('SELECT * FROM bank_txns WHERE id = ? AND org_id = ?', line['matched_id'], req.org['id'])
            if t and t['statement_line_id'] == line['id']:
                delete_txn(req, t['id'])
        _set_line(line['id'], 'uncategorized')
        return {'ok': True}
    return tx(_do)


# ---------------- reconciliation ----------------
def _load_recon(org_id, id):  # noqa: A002
    r = get('SELECT * FROM reconciliations WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not r:
        raise not_found('Reconciliation')
    return r


def _last_completed(org_id, account_id, except_id=0):
    return get("SELECT * FROM reconciliations WHERE org_id = ? AND account_id = ? AND status = 'completed' AND id != ? ORDER BY end_date DESC, id DESC LIMIT 1",
               org_id, account_id, except_id)


def recon_detail(org_id, id):  # noqa: A002
    r = _load_recon(org_id, id)
    acct = get('SELECT * FROM accounts WHERE id = ?', r['account_id'])
    sgn = _sgn_of(acct['type'])
    if r['status'] == 'in_progress':
        prev = _last_completed(org_id, r['account_id'], r['id'])
        opening = round2(prev['closing_balance']) if prev else 0
        if opening != r['opening_balance']:
            update('reconciliations', r['id'], {'opening_balance': opening})
        r['opening_balance'] = opening
    completed = r['status'] == 'completed'
    rows = all(f"""SELECT l.id, l.date, l.src_type, l.src_id, l.number, l.description, l.debit, l.credit, l.reconciliation_id, c.display_name AS contact_name
                   FROM ledger l LEFT JOIN contacts c ON c.id = l.contact_id
                   WHERE l.org_id = ? AND l.account_id = ? AND {'l.reconciliation_id = ?' if completed else 'l.date <= ? AND (l.reconciliation_id IS NULL OR l.reconciliation_id = ?)'}
                   ORDER BY l.date, l.id""", org_id, r['account_id'], *([r['id']] if completed else [r['end_date'], r['id']]))
    rows = [{**l, 'amount': round2(sgn * (l['debit'] - l['credit'])), 'cleared': l['reconciliation_id'] == r['id']} for l in rows]
    cleared = [x for x in rows if x['cleared']]
    dep = 0
    wd = 0
    amt = 0
    for x in cleared:
        dep = dep + x['debit']
    for x in cleared:
        wd = wd + x['credit']
    for x in cleared:
        amt = amt + x['amount']
    cleared_balance = round2((r['opening_balance'] or 0) + amt)
    return {
        **r, 'account': {'id': acct['id'], 'name': acct['name'], 'type': acct['type'], 'bank_name': acct['bank_name'],
                         'account_number': acct['account_number'], 'currency': acct['currency']},
        'rows': rows, 'cleared_count': len(cleared), 'cleared_deposits': round2(dep), 'cleared_withdrawals': round2(wd),
        'cleared_balance': cleared_balance, 'difference': round2((r['closing_balance'] or 0) - cleared_balance),
    }


RULE_FIELDS = ['account_id', 'name', 'priority', 'apply_to', 'conditions', 'match', 'action', 'is_active']


def _clean_rule(req, body, existing=None):
    o = clean_body(body, RULE_FIELDS)
    m = {**(existing or {}), **o}
    if not truthy(m.get('name')):
        raise bad('Rule name is required')
    if truthy(m.get('account_id')):
        bank_account(req.org['id'], m['account_id'])
    if truthy(m.get('apply_to')) and m['apply_to'] not in ('deposits', 'withdrawals', 'both'):
        raise bad('Invalid "apply to"')
    if truthy(m.get('match')) and m['match'] not in ('all', 'any'):
        raise bad('Invalid match')
    conds = _filter_list(_or(m.get('conditions'), []), lambda c: truthy(c) and truthy(_nn(_key(c, 'field'))))
    if not conds:
        raise bad('Add at least one condition')
    for c in conds:
        field = _key(c, 'field')
        if field not in ('description', 'reference', 'payee', 'amount'):
            raise bad(f'Invalid condition field {_js_string(field)}')
        op = _key(c, 'op')
        if op not in ('contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'gt', 'lt'):
            raise bad(f'Invalid condition operator {_js_string(op)}')
    act = _or(m.get('action'), {})
    a = act if isinstance(act, dict) else {}
    if truthy(a.get('offset_account_id')):
        _check_account(req.org['id'], a['offset_account_id'])
    if truthy(a.get('contact_id')) and not get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', _id(a['contact_id']), req.org['id']):
        raise bad('Invalid contact')
    if truthy(a.get('txn_type')) and a['txn_type'] not in [*ALL_TXN, 'expense', 'customer_payment', 'vendor_payment']:
        raise bad('Invalid transaction type')
    if 'conditions' in o:
        o['conditions'] = _dumps(conds)
    if 'action' in o:
        o['action'] = _dumps(act)
    if 'account_id' not in o and not existing:
        o['account_id'] = None
    return o


# ---------------- routes ----------------
def routes(r):
    V, C, E, D = perm('banking', 'view'), perm('banking', 'create'), perm('banking', 'edit'), perm('banking', 'delete')

    # ---- overview + accounts ----
    def overview(req):
        heal_links(req.org['id'])
        accounts = _list_accounts(req.org['id'], False)

        def total(types):
            s = 0
            for a in accounts:
                if a['type'] in types:
                    s = s + a['balance']
            return round2(s)
        undeposited = next((a for a in accounts if a['system_code'] == 'undeposited_funds'), None)
        unc = 0
        for a in accounts:
            unc = unc + a['uncategorized']
        return {
            'accounts': accounts,
            'totals': {
                'bank': total(['bank']), 'credit_card': total(['credit_card']), 'cash': total(['cash', 'payment_clearing']),
                'net': round2(total(['bank', 'cash', 'payment_clearing']) - total(['credit_card'])),
                'uncategorized': unc,
                'undeposited': undeposited['balance'] if undeposited else 0,
            },
        }
    r.get('/banking/overview', V, overview)

    r.get('/banking/accounts', V, lambda req: _list_accounts(req.org['id'], req.query.get('active') != '1'))
    r.get('/banking/accounts/:id', V, lambda req: _account_row(req.org['id'], bank_account(req.org['id'], req.params['id'])))

    def _text_param(v):
        return v if isinstance(v, str) else _js_string(v)

    def create_account(req):
        o = clean_body(_obj(req.body), ACC_FIELDS)
        if not truthy(o.get('type')):
            o['type'] = 'bank'
        if not truthy(o.get('name')):
            raise bad('Account name is required')
        if o['type'] not in BANK_TYPES:
            raise bad('Account type must be bank, credit card, cash or payment clearing')
        if get('SELECT id FROM accounts WHERE org_id = ? AND lower(name) = lower(?)', req.org['id'], _text_param(o['name'])):
            raise bad('An account with this name already exists')
        if truthy(o.get('code')) and get('SELECT id FROM accounts WHERE org_id = ? AND code = ?', req.org['id'], _text_param(o['code'])):
            raise bad('Account code already used')
        if not truthy(o.get('currency')):
            o['currency'] = req.org.get('currency')
        aid = _insert('accounts', {**o, 'org_id': req.org['id'], 'is_active': o['is_active'] if o.get('is_active') is not None else 1})
        audit(req, 'account', aid, 'created', o['name'])
        return _account_row(req.org['id'], bank_account(req.org['id'], aid))
    r.post('/banking/accounts', C, create_account)

    def update_account(req):
        a = bank_account(req.org['id'], req.params['id'])
        o = clean_body(_obj(req.body), ACC_FIELDS)
        if 'name' in o and o['name'] is None:
            raise bad('Account name is required')
        if truthy(o.get('type')) and o['type'] not in BANK_TYPES:
            raise bad('Invalid account type')
        if truthy(a['is_system']):
            o.pop('type', None)
        if (truthy(o.get('type')) and o['type'] != a['type'] and account_class(o['type']) != account_class(a['type'])
                and get('SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND org_id = ?', a['id'], a['org_id'])['n']):
            raise bad('The account type cannot change once transactions exist')
        if truthy(o.get('name')) and get('SELECT id FROM accounts WHERE org_id = ? AND lower(name) = lower(?) AND id != ?',
                                         req.org['id'], _text_param(o['name']), a['id']):
            raise bad('An account with this name already exists')
        if truthy(o.get('code')) and get('SELECT id FROM accounts WHERE org_id = ? AND code = ? AND id != ?', req.org['id'], _text_param(o['code']), a['id']):
            raise bad('Account code already used')
        update('accounts', a['id'], o)
        audit(req, 'account', a['id'], 'updated')
        return _account_row(req.org['id'], bank_account(req.org['id'], a['id']))
    r.put('/banking/accounts/:id', E, update_account)

    def delete_account(req):
        a = bank_account(req.org['id'], req.params['id'])
        if truthy(a['is_system']):
            raise bad('System accounts cannot be deleted')
        i = a['id']
        used = get("""SELECT (SELECT COUNT(*) FROM ledger WHERE account_id = ?) + (SELECT COUNT(*) FROM bank_statement_lines WHERE account_id = ?)
          + (SELECT COUNT(*) FROM bank_txns WHERE account_id = ? OR offset_account_id = ? OR to_account_id = ?)
          + (SELECT COUNT(*) FROM payments WHERE account_id = ?) + (SELECT COUNT(*) FROM expenses WHERE paid_through_id = ? OR account_id = ?)
          + (SELECT COUNT(*) FROM documents WHERE account_id = ?) + (SELECT COUNT(*) FROM document_lines WHERE account_id = ?)
          + (SELECT COUNT(*) FROM refunds WHERE account_id = ?) + (SELECT COUNT(*) FROM reconciliations WHERE account_id = ?)
          + (SELECT COUNT(*) FROM accounts WHERE parent_id = ? AND org_id = ?) AS n""", i, i, i, i, i, i, i, i, i, i, i, i, i, req.org['id'])['n']
        if used:
            raise bad('This account has transactions. Mark it inactive instead.')
        run('DELETE FROM bank_rules WHERE account_id = ? AND org_id = ?', i, req.org['id'])
        run('DELETE FROM accounts WHERE id = ?', i)
        audit(req, 'account', i, 'deleted', a['name'])
        return {'ok': True}
    r.delete('/banking/accounts/:id', D, delete_account)

    # ---- account transactions (ledger) ----
    def account_transactions(req):
        a = bank_account(req.org['id'], req.params['id'])
        sgn = _sgn_of(a['type'])
        frm = req.query.get('from') or '0000-01-01'
        to = req.query.get('to') or '9999-12-31'
        ob = get('SELECT COALESCE(SUM(debit - credit),0) AS n FROM ledger WHERE account_id = ? AND org_id = ? AND date < ?', a['id'], req.org['id'], frm)['n']
        run_ = round2(sgn * ob)
        rows = []
        for l in all("""SELECT l.*, c.display_name AS contact_name, rc.status AS recon_status, rc.end_date AS recon_end
                        FROM ledger l LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN reconciliations rc ON rc.id = l.reconciliation_id
                        WHERE l.account_id = ? AND l.org_id = ? AND l.date >= ? AND l.date <= ? ORDER BY l.date, l.id""", a['id'], req.org['id'], frm, to):
            run_ = round2(run_ + sgn * (l['debit'] - l['credit']))
            bt = get('SELECT txn_type FROM bank_txns WHERE id = ?', l['src_id']) if l['src_type'] == 'bank_txn' else None
            rows.append({
                'id': l['id'], 'date': l['date'], 'src_type': l['src_type'], 'src_id': l['src_id'], 'number': l['number'], 'description': l['description'],
                'contact_name': l['contact_name'], 'txn_type': _or((bt or {}).get('txn_type'), None), 'deposit': round2(l['debit']),
                'withdrawal': round2(l['credit']), 'balance': run_, 'reconciled': l['recon_status'] == 'completed',
                'reconciliation_id': l['reconciliation_id'],
                'matched': bool(get("SELECT id FROM bank_statement_lines WHERE org_id = ? AND matched_type = ? AND matched_id = ? AND status IN ('categorized','matched') LIMIT 1",
                                    req.org['id'], l['src_type'], l['src_id'])),
            })
        return {'account': _account_row(req.org['id'], a), 'opening_balance': round2(sgn * ob), 'closing_balance': run_, 'rows': rows}
    r.get('/banking/accounts/:id/transactions', V, account_transactions)

    # ---- manual bank transactions ----
    def list_txns(req):
        where = ['t.org_id = ?']
        p = [req.org['id']]
        q = req.query
        if q.get('account_id'):
            where.append('(t.account_id = ? OR t.to_account_id = ?)')
            p += [_id(q['account_id']), _id(q['account_id'])]
        if q.get('from'):
            where.append('t.date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('t.date <= ?')
            p.append(q['to'])
        return [parse_json(t, ['splits']) for t in all(f"""SELECT t.*, a.name AS account_name, o.name AS offset_account_name, ta.name AS to_account_name,
                       c.display_name AS contact_name
                FROM bank_txns t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts o ON o.id = t.offset_account_id
                LEFT JOIN accounts ta ON ta.id = t.to_account_id LEFT JOIN contacts c ON c.id = t.contact_id
                WHERE {' AND '.join(where)} ORDER BY t.date DESC, t.id DESC""", *p)]
    r.get('/banking/transactions', V, list_txns)
    r.get('/banking/transactions/:id', V, lambda req: load_txn(req.org['id'], req.params['id']))

    def create_txn(req):
        t = save_txn(req, req.body)
        audit(req, 'bank_txn', t['id'], 'created', f"{_js_string(t['txn_type'])} {jsstr(t['amount'])}")
        return t
    r.post('/banking/transactions', C, create_txn)

    def update_txn(req):
        cur = load_txn(req.org['id'], req.params['id'])
        if cur['payments']:
            raise bad('Delete and re-create a deposit of undeposited funds instead of editing it')
        t = save_txn(req, req.body, cur['id'])
        audit(req, 'bank_txn', t['id'], 'updated')
        return t
    r.put('/banking/transactions/:id', E, update_txn)

    def remove_txn(req):
        t = load_txn(req.org['id'], req.params['id'])
        res = delete_txn(req, t['id'])
        audit(req, 'bank_txn', t['id'], 'deleted', f"{_js_string(t['txn_type'])} {jsstr(t['amount'])}")
        return res
    r.delete('/banking/transactions/:id', D, remove_txn)

    # ---- statements ----
    def import_route(req):
        res = import_lines(req, req.params['id'], req.body or {})
        audit(req, 'account', _id(req.params['id']), 'statement imported', f"{res['imported']} lines ({res['duplicates']} duplicates skipped)")
        return res
    r.post('/banking/accounts/:id/import', C, import_route)

    def statement_lines(req):
        a = bank_account(req.org['id'], req.params['id'])
        heal_links(req.org['id'])
        where = ['org_id = ?', 'account_id = ?']
        p = [req.org['id'], a['id']]
        q = req.query
        st = q.get('status')
        if st == 'done':
            where.append("status IN ('categorized','matched')")
        elif st and st != 'all':
            where.append('status = ?')
            p.append(st)
        if q.get('from'):
            where.append('date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('date <= ?')
            p.append(q['to'])
        if q.get('q'):
            where.append('(description ILIKE ? OR reference ILIKE ? OR payee ILIKE ?)')
            p += [f"%{q['q']}%"] * 3
        return [_decorate_line(req.org['id'], l) for l in all(f"SELECT * FROM bank_statement_lines WHERE {' AND '.join(where)} ORDER BY date DESC, id DESC", *p)]
    r.get('/banking/accounts/:id/statement-lines', V, statement_lines)

    r.get('/banking/statement-lines/:id', V, lambda req: _decorate_line(req.org['id'], _load_line(req.org['id'], req.params['id'])))

    def suggest(req):
        return match_suggestions(req.org['id'], _load_line(req.org['id'], req.params['id']))
    r.post('/banking/statement-lines/:id/match-suggestions', V, suggest)
    r.get('/banking/statement-lines/:id/match-suggestions', V, suggest)

    def match_route(req):
        line = _load_line(req.org['id'], req.params['id'])
        res = match_line(req, line, req.body or {})
        audit(req, 'bank_statement_line', line['id'], 'matched', f"{_js_string(res['matched_type'])} #{jsstr(res['matched_id'])}")
        return {**res, 'line': _decorate_line(req.org['id'], _load_line(req.org['id'], line['id']))}
    r.post('/banking/statement-lines/:id/match', E, match_route)

    def categorize_route(req):
        line = _load_line(req.org['id'], req.params['id'])
        res = categorize_line(req, line, req.body or {})
        audit(req, 'bank_statement_line', line['id'], 'categorized', f"{_js_string(res['matched_type'])} #{jsstr(res['matched_id'])}")
        return {**res, 'line': _decorate_line(req.org['id'], _load_line(req.org['id'], line['id']))}
    r.post('/banking/statement-lines/:id/categorize', E, categorize_route)

    def uncategorize_route(req):
        line = _load_line(req.org['id'], req.params['id'])
        uncategorize_line(req, line)
        audit(req, 'bank_statement_line', line['id'], 'uncategorized')
        return _decorate_line(req.org['id'], _load_line(req.org['id'], line['id']))
    r.post('/banking/statement-lines/:id/uncategorize', E, uncategorize_route)

    def exclude_route(req):
        line = _load_line(req.org['id'], req.params['id'])
        if line['status'] != 'uncategorized':
            raise bad('Only uncategorized lines can be excluded')
        _set_line(line['id'], 'excluded')
        audit(req, 'bank_statement_line', line['id'], 'excluded')
        return _decorate_line(req.org['id'], _load_line(req.org['id'], line['id']))
    r.post('/banking/statement-lines/:id/exclude', E, exclude_route)

    def restore_route(req):
        line = _load_line(req.org['id'], req.params['id'])
        if line['status'] != 'excluded':
            raise bad('Only excluded lines can be restored')
        _set_line(line['id'], 'uncategorized')
        audit(req, 'bank_statement_line', line['id'], 'restored')
        return _decorate_line(req.org['id'], _load_line(req.org['id'], line['id']))
    r.post('/banking/statement-lines/:id/restore', E, restore_route)

    def delete_line_route(req):
        def _do():
            line = _load_line(req.org['id'], req.params['id'])
            if line['status'] in ('categorized', 'matched'):
                uncategorize_line(req, line)
            run('DELETE FROM bank_statement_lines WHERE id = ?', line['id'])
            audit(req, 'bank_statement_line', line['id'], 'deleted')
            return {'ok': True}
        return tx(_do)
    r.delete('/banking/statement-lines/:id', D, delete_line_route)

    def bulk_categorize(req):
        a = bank_account(req.org['id'], req.params['id'])
        src = req.body or {}
        if isinstance(src, dict):
            ids = src.get('ids', [])
            body = {k: v for k, v in src.items() if k != 'ids'}
        else:
            ids = []
            body = {}
        res = {'ok': 0, 'errors': []}
        if ids is None:
            raise TypeError('ids is not iterable')
        if isinstance(ids, list) and len(ids) > MAX_BULK:
            raise bad(f'Categorize at most {MAX_BULK} lines at a time')
        for i in ids:
            try:
                line = _load_line(req.org['id'], i)
                if line['account_id'] != a['id']:
                    raise bad('Line belongs to another account')
                out = categorize_line(req, line, body)
                audit(req, 'bank_statement_line', line['id'], 'categorized', f"{_js_string(out['matched_type'])} #{jsstr(out['matched_id'])}")
                res['ok'] += 1
            except Exception as e:  # noqa: BLE001
                res['errors'].append({'id': i, 'error': _err_message(e)})
        return res
    r.post('/banking/accounts/:id/statement-lines/bulk-categorize', E, bulk_categorize)

    def bulk_exclude(req):
        a = bank_account(req.org['id'], req.params['id'])
        raw = _or(_obj(req.body).get('ids'), [])
        if not isinstance(raw, list):
            raise TypeError('ids.map is not a function')
        if len(raw) > MAX_BULK:
            raise bad(f'Exclude at most {MAX_BULK} lines at a time')
        n = 0
        for i in raw:
            n += run("UPDATE bank_statement_lines SET status = 'excluded' WHERE id = ? AND org_id = ? AND account_id = ? AND status = 'uncategorized'",
                     _id(i), req.org['id'], a['id'])
        return {'ok': n}
    r.post('/banking/accounts/:id/statement-lines/bulk-exclude', E, bulk_exclude)

    def apply_rules_route(req):
        a = bank_account(req.org['id'], req.params['id'])
        rules = _active_rules(req.org['id'])
        res = {'suggested': 0, 'categorized': 0}

        def _do():
            for l in all("SELECT * FROM bank_statement_lines WHERE org_id = ? AND account_id = ? AND status = 'uncategorized' ORDER BY id", req.org['id'], a['id']):
                out = _apply_rules(req, parse_json(l, ['suggestion']), rules)
                if out:
                    res[out] += 1
        tx(_do)
        return res
    r.post('/banking/accounts/:id/apply-rules', E, apply_rules_route)

    # ---- rules ----
    def list_rules(req):
        p = [req.org['id']]
        w = ''
        if req.query.get('account_id'):
            w = ' AND (r.account_id IS NULL OR r.account_id = ?)'
            p.append(_id(req.query['account_id']))
        return [parse_json(x, ['conditions', 'action']) for x in
                all(f'SELECT r.*, a.name AS account_name FROM bank_rules r LEFT JOIN accounts a ON a.id = r.account_id WHERE r.org_id = ?{w} ORDER BY r.priority, r.id', *p)]
    r.get('/banking/rules', V, list_rules)
    r.get('/banking/rules/:id', V, lambda req: _load_rule(req.org['id'], req.params['id']))

    def create_rule(req):
        o = _clean_rule(req, _obj(req.body or {}))
        rid = _insert('bank_rules', {'apply_to': 'both', 'match': 'all', 'priority': 0, 'is_active': 1, 'action': '{}', **o, 'org_id': req.org['id']})
        audit(req, 'bank_rule', rid, 'created', o.get('name'))
        return _load_rule(req.org['id'], rid)
    r.post('/banking/rules', C, create_rule)

    def update_rule(req):
        cur = _load_rule(req.org['id'], req.params['id'])
        update('bank_rules', cur['id'], _clean_rule(req, _obj(req.body or {}), cur))
        audit(req, 'bank_rule', cur['id'], 'updated')
        return _load_rule(req.org['id'], cur['id'])
    r.put('/banking/rules/:id', E, update_rule)

    def delete_rule(req):
        cur = _load_rule(req.org['id'], req.params['id'])
        run('DELETE FROM bank_rules WHERE id = ?', cur['id'])
        run('UPDATE bank_statement_lines SET rule_id = NULL, suggestion = NULL WHERE rule_id = ? AND org_id = ?', cur['id'], req.org['id'])
        audit(req, 'bank_rule', cur['id'], 'deleted', cur['name'])
        return {'ok': True}
    r.delete('/banking/rules/:id', D, delete_rule)

    # ---- undeposited funds ----
    def undeposited(req):
        ud = sys_account(req.org['id'], 'undeposited_funds')
        return [{**p, 'deposit_amount': round2(p['deposit_amount'])} for p in all(
            """SELECT p.id, p.number, p.date, p.amount, p.mode, p.reference, p.currency, p.contact_id, c.display_name AS contact_name,
                 (SELECT COALESCE(SUM(l.debit - l.credit),0) FROM ledger l WHERE l.src_type = 'payment_received' AND l.src_id = p.id AND l.account_id = ?) AS deposit_amount
               FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
               WHERE p.org_id = ? AND p.type = 'received' AND p.account_id = ?
                 AND NOT EXISTS (SELECT 1 FROM bank_deposit_payments b WHERE b.payment_id = p.id AND b.org_id = p.org_id)
               ORDER BY p.date, p.id""", ud, req.org['id'], ud)]
    r.get('/banking/undeposited', V, undeposited)

    def create_deposit(req):
        b = _obj(req.body or {})
        payment_ids = b.get('payment_ids', [])
        ud = sys_account(req.org['id'], 'undeposited_funds')
        acct = bank_account(req.org['id'], b.get('account_id', UNDEF))
        if acct['id'] == ud:
            raise bad('Choose the bank account to deposit into')
        if payment_ids is None:
            raise TypeError("Cannot read properties of null (reading 'length')")
        if not isinstance(payment_ids, list):
            if not truthy(_nn(_key(payment_ids, 'length'))):
                raise bad('Select the payments to deposit')
            raise TypeError('payment_ids.map is not a function')
        if not payment_ids:
            raise bad('Select the payments to deposit')

        def _do():
            items = []
            for pid in payment_ids:
                p = get("SELECT * FROM payments WHERE id = ? AND org_id = ? AND type = 'received'", _id(pid), req.org['id'])
                if not p:
                    raise not_found('Payment')
                if p['account_id'] != ud:
                    raise bad(f"{p['number']} was not deposited to Undeposited Funds")
                if get('SELECT id FROM bank_deposit_payments WHERE payment_id = ? AND org_id = ? LIMIT 1', p['id'], req.org['id']):
                    raise bad(f"{p['number']} has already been deposited")
                items.append({'p': p, 'amount': _source_net(req.org['id'], 'payment_received', p['id'], ud)})
            s = 0
            for i in items:
                s = s + i['amount']
            total = round2(s)
            if not total > 0:
                raise bad('Nothing to deposit')
            t = save_txn(req, {
                'account_id': acct['id'], 'date': _or(b.get('date'), None) or today(), 'txn_type': 'transfer_in', 'direction': 'in', 'amount': total,
                'to_account_id': ud, 'reference': _or(b.get('reference'), None),
                'description': _or(b.get('description'), None) or f"Deposit of {', '.join(_js_string(i['p']['number']) for i in items)}",
            })
            for i in items:
                _insert('bank_deposit_payments', {'org_id': req.org['id'], 'bank_txn_id': t['id'], 'payment_id': i['p']['id'], 'amount': i['amount']})
            audit(req, 'bank_txn', t['id'], 'created', f'deposit {jsstr(total)} from undeposited funds')
            return load_txn(req.org['id'], t['id'])
        return tx(_do)
    r.post('/banking/deposits', C, create_deposit)

    # ---- reconciliation ----
    def list_recons(req):
        a = bank_account(req.org['id'], req.params['id'])
        out = []
        for x in all('SELECT * FROM reconciliations WHERE org_id = ? AND account_id = ? ORDER BY end_date DESC, id DESC', req.org['id'], a['id']):
            d = recon_detail(req.org['id'], x['id']) if x['status'] == 'in_progress' else None
            out.append({**x, 'cleared_count': get('SELECT COUNT(*) AS n FROM ledger WHERE reconciliation_id = ?', x['id'])['n'],
                        'difference': d['difference'] if d else 0})
        return out
    r.get('/banking/accounts/:id/reconciliations', V, list_recons)

    def start_recon(req):
        a = bank_account(req.org['id'], req.params['id'])
        b = _obj(req.body or {})
        start_date = b.get('start_date')
        end_date = b.get('end_date')
        closing_balance = b.get('closing_balance', UNDEF)
        if not truthy(end_date):
            raise bad('Enter the statement end date')
        if closing_balance is UNDEF or closing_balance is None or closing_balance == '' or _isnan(_js_number(closing_balance)):
            raise bad('Enter the statement closing balance')
        if get("SELECT id FROM reconciliations WHERE org_id = ? AND account_id = ? AND status = 'in_progress' LIMIT 1", req.org['id'], a['id']):
            raise bad('A reconciliation is already in progress for this account')
        prev = _last_completed(req.org['id'], a['id'])
        if prev and end_date <= prev['end_date']:
            raise bad(f"This account is reconciled up to {prev['end_date']}. Choose a later end date.")
        sd = _or(start_date, None) or (_add_days(prev['end_date'], 1) if prev else None)
        if truthy(sd) and sd > end_date:
            raise bad('Start date must be before the end date')
        rid = _insert('reconciliations', {'org_id': req.org['id'], 'account_id': a['id'], 'start_date': sd, 'end_date': end_date,
                                          'opening_balance': round2(prev['closing_balance']) if prev else 0,
                                          'closing_balance': round2(_js_number(closing_balance)), 'status': 'in_progress'})
        audit(req, 'reconciliation', rid, 'started', f"{a['name']} to {_js_string(end_date)}")
        return recon_detail(req.org['id'], rid)
    r.post('/banking/accounts/:id/reconciliations', C, start_recon)

    r.get('/banking/reconciliations/:id', V, lambda req: recon_detail(req.org['id'], req.params['id']))

    def update_recon(req):
        rc = _load_recon(req.org['id'], req.params['id'])
        if rc['status'] != 'in_progress':
            raise bad('Only an in-progress reconciliation can be changed')
        o = clean_body(_obj(req.body or {}), ['start_date', 'end_date', 'closing_balance'])
        if o.get('closing_balance') is not None:
            o['closing_balance'] = round2(_js_number(o['closing_balance']))
        if truthy(o.get('end_date')):
            prev = _last_completed(req.org['id'], rc['account_id'], rc['id'])
            if prev and o['end_date'] <= prev['end_date']:
                raise bad(f"Choose an end date after {prev['end_date']}")
            run('UPDATE ledger SET reconciliation_id = NULL WHERE reconciliation_id = ? AND date > ?', rc['id'], o['end_date'])
        update('reconciliations', rc['id'], o)
        return recon_detail(req.org['id'], rc['id'])
    r.put('/banking/reconciliations/:id', E, update_recon)

    def toggle_recon(req):
        rc = _load_recon(req.org['id'], req.params['id'])
        if rc['status'] != 'in_progress':
            raise bad('This reconciliation is already completed')
        b = _obj(req.body)
        raw = _or(b.get('ledger_ids'), [])
        if not isinstance(raw, list):
            raise TypeError('ledger_ids.map is not a function')
        ids = [n for n in (_js_number(x) for x in raw) if not _isnan(n) and n]
        cleared = b.get('cleared', UNDEF) is not False

        def _do():
            for lid in ids:
                l = get('SELECT * FROM ledger WHERE id = ? AND org_id = ? AND account_id = ?', lid, req.org['id'], rc['account_id'])
                if not l:
                    raise bad('Transaction does not belong to this account')
                if l['date'] > rc['end_date']:
                    raise bad('Transaction is dated after the statement end date')
                if l['reconciliation_id'] and l['reconciliation_id'] != rc['id']:
                    raise bad('Transaction is already reconciled')
                run('UPDATE ledger SET reconciliation_id = ? WHERE id = ?', rc['id'] if cleared else None, lid)
        tx(_do)
        return recon_detail(req.org['id'], rc['id'])
    r.post('/banking/reconciliations/:id/toggle', E, toggle_recon)

    def complete_recon(req):
        d = recon_detail(req.org['id'], req.params['id'])
        if d['status'] != 'in_progress':
            raise bad('This reconciliation is already completed')
        if abs(d['difference']) > 0.005:
            raise bad(f"The difference must be zero to complete the reconciliation (currently {jsstr(d['difference'])})")
        update('reconciliations', d['id'], {'status': 'completed', 'completed_at': now_iso()})
        audit(req, 'reconciliation', d['id'], 'completed', f"{d['account']['name']} to {d['end_date']}")
        return recon_detail(req.org['id'], d['id'])
    r.post('/banking/reconciliations/:id/complete', E, complete_recon)

    def undo(req):
        def _do():
            rc = _load_recon(req.org['id'], req.params['id'])
            if rc['status'] == 'completed':
                later = get('SELECT id, end_date FROM reconciliations WHERE org_id = ? AND account_id = ? AND id != ? AND end_date > ? ORDER BY id LIMIT 1',
                            req.org['id'], rc['account_id'], rc['id'], rc['end_date'])
                if later:
                    raise bad(f"Undo the later reconciliation (to {later['end_date']}) first")
            run('UPDATE ledger SET reconciliation_id = NULL WHERE reconciliation_id = ? AND org_id = ?', rc['id'], req.org['id'])
            run('DELETE FROM reconciliations WHERE id = ?', rc['id'])
            audit(req, 'reconciliation', rc['id'], 'undone', rc['end_date'])
            return {'ok': True}
        return tx(_do)
    r.post('/banking/reconciliations/:id/undo', D, undo)
    r.delete('/banking/reconciliations/:id', D, undo)


def job(org, sys_req):  # noqa: ARG001
    safe(lambda: heal_links(org['id']))
