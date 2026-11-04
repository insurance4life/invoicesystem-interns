"""Reports + dashboard (port of modules/reports.js). Everything is derived from the ledger, documents, payments and stock moves.

Each report returns { title, from, to, basis, columns, rows, totals?, extra? } so the client can render it generically.
Row hints: _kind ('section' | 'total' | 'grand'), _indent (0-3), and link ids (account_id, doc_type+doc_id, contact_id,
payment_id+payment_type, expense_id, journal_id, src_type+src_id, item_id).

Porting notes:
- Text ORDER BY keys use COLLATE "C" (SQLite compared text bytewise; the database default collation is en_US) and
  NULLS FIRST/LAST to keep SQLite's NULL placement; `, id` is appended wherever the original order could tie.
- JS `localeCompare` sorts are reproduced with `_lc()` (an ICU-like key: punctuation < digits < letters,
  case-insensitive first, lower case before upper case).
- Keys that the JS code set to `undefined` are omitted (JSON.stringify drops them).
"""
import json
import math
import re
import unicodedata

from django.db import transaction

from books.core.db import all, get, table_exists, column_names
from books.core.router import bad, HttpError
from books.core.util import round2, today
from books.core.auth import perm, can
from books.core.jsutil import jsstr, jsnum, num_or_none, truthy
from books.core.calc import ACCOUNT_CLASS, ACCOUNT_TYPE_LABELS, sum_js
from books.core.documents import display_status

NAN = float('nan')


def r2(v):
    return round2(v)


def _n(v):
    """JS ToNumber for arithmetic on DB values: null -> 0, numeric text -> number, other text -> NaN."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        if v.strip() == '':
            return 0
        x = num_or_none(v)
        return NAN if x is None else x
    return NAN


def _s(v):
    """String(v) as JavaScript prints it."""
    return v if isinstance(v, str) else jsstr(v)


def _js_max(a, b):
    """Math.max(a, b) (NaN wins)."""
    if (isinstance(a, float) and math.isnan(a)) or (isinstance(b, float) and math.isnan(b)):
        return NAN
    return a if a >= b else b


# ---------- String.prototype.localeCompare (ICU root collation, approximated) ----------
_PUNCT = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"


def _lc(v):
    s = _s(v)
    prim, sec, tert = [], [], []
    for ch in unicodedata.normalize('NFD', s):
        if unicodedata.combining(ch):
            sec.append(ord(ch))
            continue
        low = ch.lower()
        if ch.isspace():
            prim.append((0, 0, ''))
        elif ch in _PUNCT:
            prim.append((0, _PUNCT.index(ch) + 1, ''))
        elif ch.isdigit():
            prim.append((1, unicodedata.digit(ch, 0), ''))
        elif ch.isalpha():
            prim.append((2, 0, low))
        else:
            prim.append((0, 1000 + ord(ch), ''))
        tert.append(0 if ch == low else 1)
    return (tuple(prim), tuple(sec), tuple(tert))


ISO = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')


def is_iso(v):
    return isinstance(v, str) and ISO.fullmatch(v) is not None


def pad(n):
    return _s(n).rjust(2, '0')


LIVE = "('open','closed','paid')"


def q(arr):
    return ','.join(f"'{t}'" for t in arr)


def types_of(cls):
    return [t for t, c in ACCOUNT_CLASS.items() if c == cls]


PL_TYPES = [*types_of('income'), *types_of('expense')]
INCOME_TYPES = types_of('income')
EXPENSE_TYPES = types_of('expense')
CASH_TYPES = ['cash', 'bank']


def natural(typ, d, c):
    return r2(_n(d) - _n(c)) if (ACCOUNT_CLASS.get(typ) or 'expense') in ('asset', 'expense') else r2(_n(c) - _n(d))


def _type_label(typ):
    """{type_label: ...} or {} when the label is undefined in JS."""
    tl = ACCOUNT_TYPE_LABELS.get(typ) if isinstance(typ, str) else None
    return {} if tl is None else {'type_label': tl}


# ---------------- dates (JS Date in UTC) ----------------
def _days_from_civil(y, m, d):
    y -= 1 if m <= 2 else 0
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z):
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return y + (1 if m <= 2 else 0), m, d


def _iso_of(z):
    """Date(z days since epoch).toISOString().slice(0, 10)"""
    y, m, d = _civil_from_days(z)
    if 0 <= y <= 9999:
        ys = f'{y:04d}'
    elif y < 0:
        ys = f'-{-y:06d}'
    else:
        ys = f'+{y:06d}'
    return f'{ys}-{m:02d}-{d:02d}'


def _parse_days(d):
    """Date.parse(`${d}T00:00:00Z`) / 86400000, or None for NaN (V8 accepts month 1-12, day 1-31 and overflows)."""
    if not isinstance(d, str):
        return None
    mt = re.fullmatch(r'([0-9]{4})-([0-9]{2})-([0-9]{2})', d)
    if not mt:
        return None
    y, m, da = int(mt.group(1)), int(mt.group(2)), int(mt.group(3))
    if not (1 <= m <= 12 and 1 <= da <= 31):
        return None
    return _days_from_civil(y, m, 1) + da - 1


def _ym(d):
    """d.split('-').map(Number) -> [y, m, day]"""
    parts = _s(d).split('-')
    out = []
    for p in parts[:3]:
        x = num_or_none(p) if p.strip() != '' else 0
        if x is None:
            raise ValueError('Invalid time value')
        out.append(int(x))
    while len(out) < 3:
        out.append(None)
    return out


def _utc(y, m0, day):
    """Date.UTC(y, m0, day) in days (month index may overflow)."""
    y2 = y + m0 // 12
    m = m0 % 12 + 1
    return _days_from_civil(y2, m, 1) + day - 1


def fy_start_of(org, date):
    fs = jsnum((org or {}).get('fiscal_year_start'), 1)
    y, m, _ = _ym(date)
    return f'{jsstr(y if m >= fs else y - 1)}-{pad(fs)}-01'


def add_days(d, n):
    z = _parse_days(d)
    if z is None:
        raise ValueError('Invalid time value')
    return _iso_of(z + n)


def first_of_month(d, n=0):
    y, m, _ = _ym(d)
    if m is None:
        raise ValueError('Invalid time value')
    return _iso_of(_utc(y, m - 1 + n, 1))


def end_of_month(d):
    y, m, _ = _ym(d)
    if m is None:
        raise ValueError('Invalid time value')
    return _iso_of(_utc(y, m, 0))


def days_between(a, b):
    za, zb = _parse_days(a), _parse_days(b)
    if za is None or zb is None:
        return NAN
    return zb - za


def shift_year(d, n):
    y, m, day = _ym(d)
    last = _civil_from_days(_utc(y + n, m, 0))[2]
    return f'{jsstr(y + n)}-{pad(m)}-{pad(min(day, last))}'


MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _mon(mm):
    i = int(jsnum(mm)) - 1
    return MON[i] if 0 <= i < 12 else 'undefined'


def month_label(d):
    return f'{_mon(d[5:7])} {d[0:4]}'


def months_in(frm, to):
    out = []
    m = first_of_month(frm)
    while m <= to and len(out) < 60:
        out.append(m)
        m = first_of_month(m, 1)
    return out


def params(req):
    qy = req.query
    to = qy.get('to') if is_iso(qy.get('to')) else (qy.get('date') if is_iso(qy.get('date')) else today())
    frm = qy.get('from') if is_iso(qy.get('from')) else fy_start_of(req.org, to)
    if frm > to:
        raise bad('The start date must be on or before the end date')
    return {'from': frm, 'to': to, 'basis': 'cash' if qy.get('basis') == 'cash' else 'accrual', 'org': req.org, 'q': qy}


def head(title, p, extra=None):
    return {'title': title, 'from': p['from'], 'to': p['to'], 'basis': p['basis'], **(extra or {})}


def col(key, label, typ='text', extra=None):
    return {'key': key, 'label': label, 'type': typ, **(extra or {})}


# ---------------- shared ledger helpers ----------------
def movements(org_id, frm, to, extra_where='', *extra):
    """Account totals (debit, credit) for ledger lines between two dates. Only accounts with activity are returned."""
    return all(f'''SELECT a.id AS account_id, a.code, a.name, a.type, a.system_code, SUM(l.debit) AS d, SUM(l.credit) AS c
    FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.date >= ? AND l.date <= ? {extra_where}
    GROUP BY a.id ORDER BY a.code COLLATE "C" NULLS FIRST, a.name COLLATE "C", a.id''', org_id, frm, to, *extra)


# Settlement amounts (document currency) per document between two dates: payments, credits applied, refunds, write-offs.
SETTLE_SQL = '''SELECT document_id, SUM(amount) AS amt FROM (
    SELECT pa.document_id, pa.amount, p.date FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE p.org_id = ?
    UNION ALL SELECT document_id, amount, date FROM credit_applications WHERE org_id = ?
    UNION ALL SELECT source_id, amount, date FROM credit_applications WHERE org_id = ? AND source_type IN ('creditnote','vendorcredit')
    UNION ALL SELECT source_id, amount, date FROM refunds WHERE org_id = ? AND source_type IN ('creditnote','vendorcredit')
    UNION ALL SELECT id, write_off, date FROM documents WHERE org_id = ? AND write_off > 0
  ) x WHERE date >= ? AND date <= ? GROUP BY document_id'''


def pl_by_account(org_id, frm, to, basis='accrual'):
    """Income/expense per account for a period: net = credit - debit (positive = income).
    Cash basis: invoice/bill/credit-note lines count in proportion to the amount settled in the period (by settlement date);
    every other source (receipts, expenses, journals, payments...) counts directly."""
    sel = f'''SELECT a.id AS account_id, a.code, a.name, a.type, SUM(l.credit - l.debit) AS net
    FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.date >= ? AND l.date <= ? AND a.type IN ({q(PL_TYPES)})'''
    if basis != 'cash':
        return [{**r, 'net': r2(r['net'])} for r in all(
            f'{sel} GROUP BY a.id ORDER BY a.code COLLATE "C" NULLS FIRST, a.name COLLATE "C", a.id', org_id, frm, to)]
    direct = all(f"{sel} AND l.src_type NOT IN ('invoice','bill','creditnote','vendorcredit') GROUP BY a.id ORDER BY a.id", org_id, frm, to)
    settled = all(f'''WITH s AS ({SETTLE_SQL})
    SELECT a.id AS account_id, a.code, a.name, a.type, SUM((l.credit - l.debit) * s.amt / d.total) AS net
    FROM ledger l JOIN documents d ON d.id = l.src_id AND d.doc_type = l.src_type
    JOIN s ON s.document_id = d.id JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.src_type IN ('invoice','bill','creditnote','vendorcredit') AND d.total > 0 AND a.type IN ({q(PL_TYPES)})
    GROUP BY a.id ORDER BY a.id''', org_id, org_id, org_id, org_id, org_id, frm, to, org_id)
    mp = {}
    for r in [*direct, *settled]:
        cur = mp.get(r['account_id'])
        if cur:
            cur['net'] += r['net']
        else:
            mp[r['account_id']] = dict(r)
    out = [{**r, 'net': r2(r['net'])} for r in mp.values()]
    out.sort(key=lambda r: (_lc(r['code']), _lc(r['name'])))
    return out


def income_expense_totals(org_id, frm, to, basis):
    income = 0
    expense = 0
    for r in pl_by_account(org_id, frm, to, basis):
        if r['type'] in INCOME_TYPES:
            income += r['net']
        else:
            expense -= r['net']
    return {'income': r2(income), 'expense': r2(expense)}


# ---------------- Profit & Loss ----------------
PL_SECTIONS = [
    {'key': 'operating_income', 'label': 'Operating Income', 'types': ['income'], 'sign': 1},
    {'key': 'cogs', 'label': 'Cost of Goods Sold', 'types': ['cost_of_goods_sold'], 'sign': -1},
    {'key': 'operating_expense', 'label': 'Operating Expense', 'types': ['expense'], 'sign': -1},
    {'key': 'non_operating_income', 'label': 'Non Operating Income', 'types': ['other_income'], 'sign': 1},
    {'key': 'non_operating_expense', 'label': 'Non Operating Expense', 'types': ['other_expense'], 'sign': -1},
]


def pl_totals(sec):
    t = {s['key']: (sec.get(s['key']) or 0) for s in PL_SECTIONS}
    t['gross_profit'] = r2(t['operating_income'] - t['cogs'])
    t['operating_profit'] = r2(t['gross_profit'] - t['operating_expense'])
    t['net_profit'] = r2(t['operating_profit'] + t['non_operating_income'] - t['non_operating_expense'])
    t['total_income'] = r2(t['operating_income'] + t['non_operating_income'])
    t['total_expense'] = r2(t['cogs'] + t['operating_expense'] + t['non_operating_expense'])
    return t


def profit_loss(org, frm, to, basis, compare_range=None):
    cur = pl_by_account(org['id'], frm, to, basis)
    prev = pl_by_account(org['id'], compare_range['from'], compare_range['to'], basis) if compare_range else []
    prev_map = {r['account_id']: r for r in prev}
    accounts = {}
    for r in [*cur, *prev]:
        if r['account_id'] not in accounts:
            accounts[r['account_id']] = r
    cur_map = {r['account_id']: r for r in cur}
    sections = []
    for s in PL_SECTIONS:
        rows = []
        for a in accounts.values():
            if a['type'] not in s['types']:
                continue
            row = {'account_id': a['account_id'], 'code': a['code'], 'name': a['name'], 'type': a['type'],
                   'amount': r2(s['sign'] * ((cur_map.get(a['account_id']) or {}).get('net') or 0))}
            if compare_range:
                row['compare'] = r2(s['sign'] * ((prev_map.get(a['account_id']) or {}).get('net') or 0))
            if truthy(row['amount']) or truthy(row.get('compare')):
                rows.append(row)
        rows.sort(key=lambda x: (_lc(x['code']), _lc(x['name'])))
        sec = {'key': s['key'], 'label': s['label'], 'rows': rows, 'total': r2(sum_js(r['amount'] for r in rows))}
        if compare_range:
            sec['compare_total'] = r2(sum_js((r.get('compare') or 0) for r in rows))
        sections.append(sec)
    totals = pl_totals({s['key']: s['total'] for s in sections})
    compare_totals = pl_totals({s['key']: s.get('compare_total') for s in sections}) if compare_range else None
    rows = []

    def tot(label, key, kind='total'):
        row = {'name': label, 'amount': totals[key]}
        if compare_totals is not None:
            row['compare'] = compare_totals.get(key)
        row['_kind'] = kind
        rows.append(row)

    def sec_rows(s):
        rows.append({'name': s['label'], '_kind': 'section'})
        for r in s['rows']:
            rows.append({**r, '_indent': 1})
        row = {'name': f"Total for {s['label']}", 'amount': s['total']}
        if 'compare_total' in s:
            row['compare'] = s['compare_total']
        row['_kind'] = 'total'
        rows.append(row)

    by = {s['key']: s for s in sections}
    sec_rows(by['operating_income'])
    sec_rows(by['cogs'])
    tot('Gross Profit', 'gross_profit', 'grand')
    sec_rows(by['operating_expense'])
    tot('Operating Profit', 'operating_profit', 'grand')
    sec_rows(by['non_operating_income'])
    sec_rows(by['non_operating_expense'])
    tot('Net Profit/Loss', 'net_profit', 'grand')
    return {'sections': sections, 'totals': totals, 'compare_totals': compare_totals, 'rows': rows}


def compare_range_for(p, compare):
    if compare == 'previous_year':
        return {'from': shift_year(p['from'], -1), 'to': shift_year(p['to'], -1)}
    if compare == 'previous_period':
        # whole months shift by the same number of months, otherwise by the same number of days
        if p['from'] == first_of_month(p['from']) and p['to'] == end_of_month(p['to']):
            n = len(months_in(p['from'], p['to']))
            return {'from': first_of_month(p['from'], -n), 'to': add_days(p['from'], -1)}
        ln = days_between(p['from'], p['to'])
        return {'from': add_days(p['from'], -ln - 1), 'to': add_days(p['from'], -1)}
    return None


def rpt_profit_loss(req):
    p = params(req)
    compare = p['q'].get('compare') if p['q'].get('compare') in ('previous_period', 'previous_year') else None
    cr = compare_range_for(p, compare)
    pl = profit_loss(p['org'], p['from'], p['to'], p['basis'], cr)
    columns = [col('name', 'Account', 'account'), col('amount', f"{p['from']} – {p['to']}", 'money')]
    if cr:
        columns.append(col('compare', f"{cr['from']} – {cr['to']}", 'money'))
    extra = {'compare': compare}
    if cr:
        extra['compare_from'] = cr['from']
        extra['compare_to'] = cr['to']
    return {**head('Profit and Loss', p, extra), 'columns': columns, **pl}


# ---------------- Balance Sheet ----------------
BS = [
    {'key': 'assets', 'label': 'Assets', 'subs': [
        {'key': 'current_assets', 'label': 'Current Assets', 'types': ['cash', 'bank', 'accounts_receivable', 'other_current_asset', 'stock', 'payment_clearing']},
        {'key': 'fixed_assets', 'label': 'Fixed Assets', 'types': ['fixed_asset']},
        {'key': 'other_assets', 'label': 'Other Assets', 'types': ['other_asset']}]},
    {'key': 'liabilities', 'label': 'Liabilities', 'subs': [
        {'key': 'current_liabilities', 'label': 'Current Liabilities', 'types': ['accounts_payable', 'other_current_liability', 'credit_card']},
        {'key': 'long_term_liabilities', 'label': 'Long Term Liabilities', 'types': ['long_term_liability']},
        {'key': 'other_liabilities', 'label': 'Other Liabilities', 'types': ['other_liability']}]},
    {'key': 'equity', 'label': 'Equities', 'subs': [{'key': 'equity', 'label': 'Equity', 'types': ['equity']}]},
]


def balance_sheet(org, to):
    fy = fy_start_of(org, to)
    bal = movements(org['id'], '0000-01-01', to)
    prior = sum_js(r['net'] for r in pl_by_account(org['id'], '0000-01-01', add_days(fy, -1)))
    current = sum_js(r['net'] for r in pl_by_account(org['id'], fy, to))
    groups = []
    for g in BS:
        subs = []
        for s in g['subs']:
            rows = []
            for a in bal:
                if a['type'] not in s['types']:
                    continue
                row = {'account_id': a['account_id'], 'code': a['code'], 'name': a['name'], 'type': a['type'], **_type_label(a['type']),
                       'amount': natural(a['type'], a['d'], a['c'])}
                if truthy(row['amount']):
                    rows.append(row)
            if s['key'] == 'equity':
                if r2(prior):
                    rows.append({'name': "Retained Earnings (Prior Years' Profit)", 'amount': r2(prior), 'computed': True})
                rows.append({'name': 'Current Year Earnings', 'amount': r2(current), 'computed': True})
            subs.append({'key': s['key'], 'label': s['label'], 'rows': rows, 'total': r2(sum_js(r['amount'] for r in rows))})
        groups.append({'key': g['key'], 'label': g['label'], 'subs': subs, 'total': r2(sum_js(s['total'] for s in subs))})
    A, L, E = groups
    totals = {'total_assets': A['total'], 'total_liabilities': L['total'], 'total_equity': E['total'],
              'total_liabilities_equity': r2(L['total'] + E['total']), 'current_year_earnings': r2(current), 'prior_years_earnings': r2(prior)}
    rows = []

    def push_group(g, indent):
        rows.append({'name': g['label'], '_kind': 'section', '_indent': indent})
        for s in g['subs']:
            if not s['rows'] and s['key'] != 'current_assets' and s['key'] != 'current_liabilities':
                continue
            rows.append({'name': s['label'], '_kind': 'section', '_indent': indent + 1})
            for r in s['rows']:
                rows.append({**r, '_indent': indent + 2})
            rows.append({'name': f"Total for {s['label']}", 'amount': s['total'], '_kind': 'total', '_indent': indent + 1})
        rows.append({'name': f"Total for {g['label']}", 'amount': g['total'], '_kind': 'total', '_indent': indent})

    push_group(A, 0)
    rows.append({'name': 'Total Assets', 'amount': A['total'], '_kind': 'grand'})
    rows.append({'name': 'Liabilities & Equities', '_kind': 'section'})
    push_group(L, 1)
    push_group(E, 1)
    rows.append({'name': 'Total Liabilities & Equities', 'amount': totals['total_liabilities_equity'], '_kind': 'grand'})
    return {'groups': groups, 'totals': totals, 'rows': rows, 'balanced': abs(A['total'] - totals['total_liabilities_equity']) < 0.01}


def rpt_balance_sheet(req):
    p = params(req)
    bs = balance_sheet(p['org'], p['to'])
    return {**head('Balance Sheet', p, {'basis': 'accrual', 'as_of': p['to']}),
            'columns': [col('name', 'Account', 'account'), col('amount', f"As of {p['to']}", 'money')], **bs}


# ---------------- Cash Flow (indirect) ----------------
CF = [
    {'key': 'operating', 'label': 'Cash Flow from Operating Activities', 'types': ['accounts_receivable', 'other_current_asset', 'stock', 'payment_clearing', 'accounts_payable', 'other_current_liability', 'credit_card']},
    {'key': 'investing', 'label': 'Cash Flow from Investing Activities', 'types': ['fixed_asset', 'other_asset']},
    {'key': 'financing', 'label': 'Cash Flow from Financing Activities', 'types': ['equity', 'long_term_liability', 'other_liability']},
]


def rpt_cash_flow(req):
    p = params(req)
    org_id = p['org']['id']
    mov = movements(org_id, p['from'], p['to'])
    net = r2(sum_js(r['net'] for r in pl_by_account(org_id, p['from'], p['to'])))

    def cash_sum(frm, to):
        return r2(get(f'''SELECT COALESCE(SUM(l.debit - l.credit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.date >= ? AND l.date <= ? AND a.type IN ({q(CASH_TYPES)})''', org_id, frm, to)['s'])

    begin = cash_sum('0000-01-01', add_days(p['from'], -1))
    end = cash_sum('0000-01-01', p['to'])
    rows = []
    sections = {}
    for s in CF:
        rows.append({'name': s['label'], '_kind': 'section'})
        total = 0
        if s['key'] == 'operating':
            rows.append({'name': 'Net Income', 'amount': net, '_indent': 1})
            total += net
        for a in mov:
            if a['type'] not in s['types']:
                continue
            amt = r2(_n(a['c']) - _n(a['d']))
            if not amt:
                continue
            rows.append({'account_id': a['account_id'], 'name': a['name'], **_type_label(a['type']), 'amount': amt, '_indent': 1})
            total += amt
        sections[s['key']] = r2(total)
        rows.append({'name': f"Net cash provided by {s['label'].replace('Cash Flow from ', '', 1)}", 'amount': r2(total), '_kind': 'total'})
    change = r2(sections['operating'] + sections['investing'] + sections['financing'])
    rows.append({'name': 'Net Change in Cash', 'amount': change, '_kind': 'grand'})
    rows.append({'name': 'Beginning Cash Balance', 'amount': begin, '_kind': 'total'})
    rows.append({'name': 'Ending Cash Balance', 'amount': r2(begin + change), '_kind': 'grand'})
    return {**head('Cash Flow Statement', p, {'basis': 'accrual'}), 'columns': [col('name', 'Account', 'account'), col('amount', 'Amount', 'money')], 'rows': rows,
            'totals': {'net_income': net, **sections, 'net_change': change, 'beginning_cash': begin, 'ending_cash': r2(begin + change), 'ledger_ending_cash': end}}


# ---------------- Trial balance & accountant reports ----------------
CLASS_ORDER = [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equities'], ['income', 'Income'], ['expense', 'Expense']]


def rpt_trial_balance(req):
    p = params(req)
    bal = movements(p['org']['id'], '0000-01-01', p['to'])
    rows = []
    td = 0
    tc = 0
    for cls, label in CLASS_ORDER:
        accs = []
        for a in bal:
            if (ACCOUNT_CLASS.get(a['type']) or 'expense') != cls:
                continue
            n = r2(_n(a['d']) - _n(a['c']))
            x = {'account_id': a['account_id'], 'code': a['code'], 'name': a['name'], **_type_label(a['type']),
                 'debit': n if n > 0 else 0, 'credit': -n if n < 0 else 0}
            if x['debit'] or x['credit']:
                accs.append(x)
        if not accs:
            continue
        rows.append({'name': label, '_kind': 'section'})
        for a in accs:
            rows.append({**a, '_indent': 1})
            td += a['debit']
            tc += a['credit']
    totals = {'name': 'Total', 'debit': r2(td), 'credit': r2(tc)}
    return {**head('Trial Balance', p, {'basis': 'accrual', 'as_of': p['to']}),
            'columns': [col('name', 'Account', 'account'), col('code', 'Account Code'), col('debit', 'Net Debit', 'money'), col('credit', 'Net Credit', 'money')],
            'rows': rows, 'totals': totals}


SRC_LABELS = {
    'invoice': 'Invoice', 'creditnote': 'Credit Note', 'salesreceipt': 'Sales Receipt', 'bill': 'Bill', 'vendorcredit': 'Vendor Credit', 'writeoff': 'Write Off',
    'payment_received': 'Customer Payment', 'payment_made': 'Vendor Payment', 'refund': 'Refund', 'expense': 'Expense', 'journal': 'Journal',
    'contact_opening': 'Opening Balance', 'item_opening': 'Opening Stock', 'bank_txn': 'Bank Transaction', 'inventory_adjustment': 'Inventory Adjustment',
    'depreciation': 'Depreciation', 'opening_balance': 'Opening Balance', 'fx_revaluation': 'Exchange Revaluation', 'transfer': 'Transfer Fund',
}


def src_label(t):
    if isinstance(t, str) and SRC_LABELS.get(t):
        return SRC_LABELS[t]
    return re.sub(r'\b\w', lambda m: m.group(0).upper(), _s(t).replace('_', ' '), flags=re.ASCII)


LEDGER_COLS = [col('date', 'Date', 'date'), col('src_label', 'Transaction Type'), col('number', 'Transaction#', 'source'), col('contact_name', 'Contact', 'contact'),
               col('description', 'Description'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')]


def ledger_lines(org_id, frm, to, where='', *args):
    return [{**r, 'src_label': src_label(r['src_type'])} for r in all(
        f'''SELECT l.id, l.date, l.src_type, l.src_id, l.number, l.account_id, a.name AS account_name, a.code AS account_code, a.type AS account_type,
      l.contact_id, c.display_name AS contact_name, l.description, l.debit, l.credit
    FROM ledger l JOIN accounts a ON a.id = l.account_id LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.org_id = ? AND l.date >= ? AND l.date <= ? {where}
    ORDER BY l.date COLLATE "C", l.src_type COLLATE "C" NULLS FIRST, l.src_id NULLS FIRST, l.id''', org_id, frm, to, *args)]


def account_block(org_id, a, frm, to):
    op = get('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ledger WHERE account_id = ? AND org_id = ? AND date < ?', a['id'], org_id, frm)
    opening = r2(op['d'] - op['c'])
    lines = ledger_lines(org_id, frm, to, 'AND l.account_id = ?', a['id'])
    run = opening
    txns = []
    for l in lines:
        run = r2(run + _n(l['debit']) - _n(l['credit']))
        txns.append({**l, 'balance': run})
    return {'opening': opening, 'txns': txns, 'closing': run,
            'debit': r2(sum_js(_n(l['debit']) for l in lines)), 'credit': r2(sum_js(_n(l['credit']) for l in lines))}


def rpt_general_ledger(req):
    p = params(req)
    org_id = p['org']['id']
    accounts = all('''SELECT a.id, a.code, a.name, a.type FROM accounts a WHERE a.org_id = ? AND EXISTS (SELECT 1 FROM ledger l WHERE l.account_id = a.id AND l.date <= ?)
    ORDER BY a.code COLLATE "C" NULLS FIRST, a.name COLLATE "C", a.id''', org_id, p['to'])
    if truthy(p['q'].get('account_id')):
        want = num_or_none(p['q'].get('account_id'))
        accounts = [a for a in accounts if want is not None and a['id'] == want]
    rows = []
    for a in accounts:
        b = account_block(org_id, a, p['from'], p['to'])
        if not b['txns'] and not b['opening']:
            continue
        code = f" ({_s(a['code'])})" if truthy(a['code']) else ''
        rows.append({'name': f"{_s(a['name'])}{code}", 'account_id': a['id'], '_kind': 'section', '_link': 'account'})
        rows.append({'description': 'Opening Balance', 'balance': b['opening'], '_indent': 1})
        for t in b['txns']:
            rows.append({**t, '_indent': 1})
        rows.append({'description': 'Closing Balance', 'debit': b['debit'], 'credit': b['credit'], 'balance': b['closing'], '_kind': 'total'})
    return {**head('General Ledger', p, {'basis': 'accrual'}), 'columns': [col('name', 'Account', 'account'), *LEDGER_COLS, col('balance', 'Balance', 'money')], 'rows': rows}


def rpt_account_transactions(req):
    p = params(req)
    org_id = p['org']['id']
    a = get('SELECT id, code, name, type FROM accounts WHERE id = ? AND org_id = ?', num_or_none(p['q'].get('account_id')), org_id)
    if not a:
        return {**head('Account Transactions', p), 'columns': LEDGER_COLS, 'rows': [], 'needs': 'account_id', 'message': 'Choose an account to see its transactions.'}
    b = account_block(org_id, a, p['from'], p['to'])
    rows = [{'description': 'Opening Balance', 'balance': b['opening'], '_kind': 'total'}, *b['txns'],
            {'description': 'Closing Balance', 'debit': b['debit'], 'credit': b['credit'], 'balance': b['closing'], '_kind': 'grand'}]
    return {**head(f"Account Transactions: {_s(a['name'])}", p, {'basis': 'accrual'}), 'account': {**a, **_type_label(a['type'])},
            'columns': [*LEDGER_COLS, col('balance', 'Balance', 'money')], 'rows': rows,
            'totals': {'opening': b['opening'], 'debit': b['debit'], 'credit': b['credit'], 'closing': b['closing']}}


def rpt_journal(req):
    p = params(req)
    lines = ledger_lines(p['org']['id'], p['from'], p['to'])
    rows = []
    key = None
    td = 0
    tc = 0
    for l in lines:
        k = f"{_s(l['src_type'])}:{_s(l['src_id'])}"
        if k != key:
            key = k
            num = f" {_s(l['number'])}" if truthy(l['number']) else ''
            rows.append({'date': l['date'], 'name': f"{l['src_label']}{num}", 'src_type': l['src_type'], 'src_id': l['src_id'], 'number': l['number'],
                         'contact_name': l['contact_name'], '_kind': 'section', '_link': 'source'})
        rows.append({'name': l['account_name'], 'account_id': l['account_id'], 'description': l['description'], 'debit': l['debit'], 'credit': l['credit'], '_indent': 1})
        td += _n(l['debit'])
        tc += _n(l['credit'])
    return {**head('Journal Report', p, {'basis': 'accrual'}),
            'columns': [col('date', 'Date', 'date'), col('name', 'Account', 'account'), col('description', 'Description'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')],
            'rows': rows, 'totals': {'name': 'Total', 'debit': r2(td), 'credit': r2(tc)}}


def rpt_day_book(req):
    p = params(req)
    date = p['q'].get('date') if is_iso(p['q'].get('date')) else None
    frm = date or p['from']
    to = date or p['to']
    lines = ledger_lines(p['org']['id'], frm, to)
    return {**head('Day Book', {**p, 'from': frm, 'to': to}, {'basis': 'accrual', 'date': date}),
            'columns': [col('date', 'Date', 'date'), col('src_label', 'Transaction Type'), col('number', 'Transaction#', 'source'), col('contact_name', 'Contact', 'contact'),
                        col('account_name', 'Account', 'account'), col('description', 'Description'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')],
            'rows': [{**l, 'name': l['account_name']} for l in lines],
            'totals': {'debit': r2(sum_js(_n(l['debit']) for l in lines)), 'credit': r2(sum_js(_n(l['credit']) for l in lines))}}


def rpt_account_type_summary(req):
    p = params(req)
    mov = movements(p['org']['id'], p['from'], p['to'])
    closing = movements(p['org']['id'], '0000-01-01', p['to'])
    rows = []
    for cls, label in CLASS_ORDER:
        types = [t for t in types_of(cls) if any(m['type'] == t for m in mov) or any(m['type'] == t for m in closing)]
        if not types:
            continue
        rows.append({'name': label, '_kind': 'section'})
        for t in types:
            m = [x for x in mov if x['type'] == t]
            cl = [x for x in closing if x['type'] == t]
            rows.append({'name': ACCOUNT_TYPE_LABELS[t], 'account_type': t, 'debit': r2(sum_js(_n(x['d']) for x in m)), 'credit': r2(sum_js(_n(x['c']) for x in m)),
                         'balance': r2(sum_js(natural(t, x['d'], x['c']) for x in cl)), '_indent': 1})
    return {**head('Account Type Summary', p, {'basis': 'accrual'}),
            'columns': [col('name', 'Account Type'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('balance', 'Closing Balance', 'money')], 'rows': rows}


# ---------------- documents helpers ----------------
DOC_FX = 'COALESCE(d.exchange_rate, 1)'


def open_docs_as_of(org_id, doc_type, as_of):
    """Open documents as of a date with their balance (document currency) at that date."""
    docs = []
    for d in all(f'''SELECT d.id AS doc_id, d.doc_type, d.number, d.date, d.due_date, d.total, d.exchange_rate, d.contact_id, c.display_name AS contact_name, d.status,
      d.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.document_id = d.id AND p.date <= ?), 0)
        - COALESCE((SELECT SUM(ca.amount) FROM credit_applications ca WHERE ca.document_id = d.id AND ca.date <= ?), 0) - COALESCE(d.write_off, 0) AS bal
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type = ? AND d.status IN {LIVE} AND d.date <= ?
    ORDER BY d.date COLLATE "C", d.number COLLATE "C" NULLS FIRST, d.id''', as_of, as_of, org_id, doc_type, as_of):
        x = {**d, 'bal': r2(d['bal']), 'bal_base': r2(_n(d['bal']) * (d['exchange_rate'] or 1))}
        if x['bal'] > 0.004:
            docs.append(x)
    # contact opening balances live only in the ledger; payments against them show up as unused credits
    side = 'ar' if doc_type == 'invoice' else 'ap'
    expr = 'l.debit - l.credit' if side == 'ar' else 'l.credit - l.debit'
    opening = []
    for o in all(f'''SELECT l.contact_id, c.display_name AS contact_name, MIN(l.date COLLATE "C") AS date, SUM({expr}) AS bal
    FROM ledger l JOIN accounts a ON a.id = l.account_id LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.org_id = ? AND l.src_type = 'contact_opening' AND a.system_code = ? AND l.date <= ? GROUP BY l.contact_id, c.id
    ORDER BY l.contact_id NULLS FIRST''', org_id, side, as_of):
        if not (_n(o['bal']) > 0.004):
            continue
        opening.append({'doc_id': None, 'doc_type': None, 'number': 'Opening Balance', 'date': o['date'], 'due_date': o['date'], 'total': r2(o['bal']),
                        'exchange_rate': 1, 'contact_id': o['contact_id'], 'contact_name': o['contact_name'], 'status': 'open', 'bal': r2(o['bal']),
                        'bal_base': r2(o['bal']), 'opening': True})
    return [*opening, *docs]


def unused_credits_as_of(org_id, side, as_of):
    """Unused credits per contact as of a date (credit notes / vendor credits, unused payments, retainer balances), in base currency."""
    cred_type = 'creditnote' if side == 'sales' else 'vendorcredit'
    pay_type = 'received' if side == 'sales' else 'made'
    out = {}

    def add(cid, v):
        if abs(v) > 0.004:
            out[cid] = r2((out.get(cid) or 0) + v)

    for n in all(f'''SELECT d.contact_id, {DOC_FX} AS fx, d.total
      - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE source_type = d.doc_type AND source_id = d.id AND date <= ?), 0)
      - COALESCE((SELECT SUM(amount) FROM refunds WHERE source_type = d.doc_type AND source_id = d.id AND date <= ?), 0) AS bal
    FROM documents d WHERE d.org_id = ? AND d.doc_type = ? AND d.status IN {LIVE} AND d.date <= ? ORDER BY d.date COLLATE "C", d.id''',
                 as_of, as_of, org_id, cred_type, as_of):
        add(n['contact_id'], _n(n['bal']) * _n(n['fx']))
    for p in all('''SELECT p.contact_id, COALESCE(p.exchange_rate,1) AS fx, p.amount + COALESCE(p.tds_amount,0)
      - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id), 0)
      - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE source_type = 'payment' AND source_id = p.id AND date <= ?), 0)
      - COALESCE((SELECT SUM(amount) FROM refunds WHERE source_type = 'payment' AND source_id = p.id AND date <= ?), 0) AS bal
    FROM payments p WHERE p.org_id = ? AND p.type = ? AND p.date <= ? ORDER BY p.id''', as_of, as_of, org_id, pay_type, as_of):
        add(p['contact_id'], _n(p['bal']) * _n(p['fx']))
    if side == 'sales':
        for rt in all(f'''SELECT d.contact_id, {DOC_FX} AS fx,
        COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.document_id = d.id AND p.date <= ?), 0)
        - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE source_type = 'retainer' AND source_id = d.id AND date <= ?), 0) AS bal
      FROM documents d WHERE d.org_id = ? AND d.doc_type = 'retainer' AND d.date <= ? ORDER BY d.date COLLATE "C", d.id''', as_of, as_of, org_id, as_of):
            add(rt['contact_id'], _n(rt['bal']) * _n(rt['fx']))
    return out


BUCKETS = [['current', 'Current'], ['d1_15', '1-15 Days'], ['d16_30', '16-30 Days'], ['d31_45', '31-45 Days'], ['gt45', '> 45 Days']]


def bucket_of(as_of, due):
    days = days_between(due, as_of) if truthy(due) else 0
    if days <= 0:
        return ['current', days]
    if days <= 15:
        return ['d1_15', days]
    if days <= 30:
        return ['d16_30', days]
    if days <= 45:
        return ['d31_45', days]
    return ['gt45', days]


def aging_summary(req, side):
    p = params(req)
    as_of = p['q'].get('as_of') if is_iso(p['q'].get('as_of')) else p['to']
    doc_type = 'invoice' if side == 'sales' else 'bill'
    docs = open_docs_as_of(p['org']['id'], doc_type, as_of)
    by = {}
    for d in docs:
        row = by.get(d['contact_id']) or {'contact_id': d['contact_id'], 'name': d['contact_name'], **{k: 0 for k, _ in BUCKETS}, 'total': 0, 'count': 0}
        b = bucket_of(as_of, d['due_date'])[0]
        row[b] = r2(row[b] + d['bal_base'])
        row['total'] = r2(row['total'] + d['bal_base'])
        row['count'] += 1
        by[d['contact_id']] = row
    rows = sorted(by.values(), key=lambda r: _lc(r['name']))
    totals = {'name': 'Total', **{k: r2(sum_js(r[k] for r in rows)) for k, _ in BUCKETS}, 'total': r2(sum_js(r['total'] for r in rows))}
    credits = unused_credits_as_of(p['org']['id'], side, as_of)
    unused = r2(sum_js(credits.values()))
    control = 'ar' if side == 'sales' else 'ap'
    ledger_bal = get('''SELECT COALESCE(SUM(l.debit - l.credit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.system_code = ? AND l.date <= ?''', p['org']['id'], control, as_of)['s']
    label = 'Customer Name' if side == 'sales' else 'Vendor Name'
    return {**head('AR Aging Summary' if side == 'sales' else 'AP Aging Summary', {**p, 'to': as_of}, {'as_of': as_of}),
            'columns': [col('name', label, 'contact'), *[col(k, l, 'money') for k, l in BUCKETS], col('total', 'Total', 'money')], 'rows': rows, 'totals': totals,
            'unused_credits': unused, 'net_balance': r2(totals['total'] - unused), 'ledger_balance': r2(ledger_bal if side == 'sales' else 0 - ledger_bal),
            'extra': [{'title': 'Reconciliation', 'columns': [col('name', ''), col('amount', 'Amount', 'money')], 'rows': [
                {'name': 'Total outstanding', 'amount': totals['total']}, {'name': 'Less: unused credits & advances', 'amount': 0 - unused},
                {'name': f"Net {'receivable' if side == 'sales' else 'payable'}", 'amount': r2(totals['total'] - unused), '_kind': 'total'}]}]}


def aging_details(req, side):
    p = params(req)
    as_of = p['q'].get('as_of') if is_iso(p['q'].get('as_of')) else p['to']
    docs = open_docs_as_of(p['org']['id'], 'invoice' if side == 'sales' else 'bill', as_of)
    rows = []
    for k, l in BUCKETS:
        ds = [d for d in docs if bucket_of(as_of, d['due_date'])[0] == k]
        if not ds:
            continue
        rows.append({'date': l, '_kind': 'section'})
        for d in ds:
            rows.append({**d, 'age': _js_max(0, bucket_of(as_of, d['due_date'])[1]), 'status': display_status({**d, 'balance': d['bal']}),
                         'amount': r2(_n(d['total']) * (d['exchange_rate'] or 1)), 'balance': d['bal_base'], '_indent': 1})
        rows.append({'date': f'Total for {l}', 'amount': r2(sum_js(_n(d['total']) * (d['exchange_rate'] or 1) for d in ds)),
                     'balance': r2(sum_js(d['bal_base'] for d in ds)), '_kind': 'total'})
    return {**head('AR Aging Details' if side == 'sales' else 'AP Aging Details', {**p, 'to': as_of}, {'as_of': as_of}),
            'columns': [col('date', 'Date', 'date'), col('number', 'Invoice#' if side == 'sales' else 'Bill#', 'doc'), col('contact_name', 'Customer' if side == 'sales' else 'Vendor', 'contact'),
                        col('due_date', 'Due Date', 'date'), col('age', 'Age (days)', 'num'), col('status', 'Status', 'status'), col('amount', 'Amount', 'money'), col('balance', 'Balance Due', 'money')],
            'rows': rows, 'totals': {'amount': r2(sum_js(_n(d['total']) * (d['exchange_rate'] or 1) for d in docs)), 'balance': r2(sum_js(d['bal_base'] for d in docs))}}


# ---------------- sales / purchase summaries ----------------
def by_contact(req, side):
    p = params(req)
    main, credit = (['invoice', 'salesreceipt'], 'creditnote') if side == 'sales' else (['bill'], 'vendorcredit')
    rows = [{**r, 'amount': r2(r['amount']), 'amount_with_tax': r2(r['amount_with_tax'])} for r in all(
        f'''SELECT c.id AS contact_id, COALESCE(c.display_name, '(No contact)') AS name,
      SUM(CASE WHEN d.doc_type = ? THEN 0 ELSE 1 END) AS count,
      SUM(CASE WHEN d.doc_type = ? THEN -1 ELSE 1 END * (d.total - d.tax_total) * {DOC_FX}) AS amount,
      SUM(CASE WHEN d.doc_type = ? THEN -1 ELSE 1 END * d.total * {DOC_FX}) AS amount_with_tax
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type IN ({q([*main, credit])}) AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    GROUP BY d.contact_id, c.id ORDER BY amount DESC NULLS LAST, d.contact_id NULLS FIRST''', credit, credit, credit, p['org']['id'], p['from'], p['to'])]
    s = side == 'sales'
    return {**head('Sales by Customer' if s else 'Purchases by Vendor', p),
            'columns': [col('name', 'Customer Name' if s else 'Vendor Name', 'contact'), col('count', 'Invoice Count' if s else 'Bill Count', 'num'),
                        col('amount', 'Sales' if s else 'Purchases', 'money'), col('amount_with_tax', 'Sales With Tax' if s else 'Purchases With Tax', 'money')],
            'rows': rows, 'totals': {'name': 'Total', 'count': sum_js(r['count'] for r in rows), 'amount': r2(sum_js(r['amount'] for r in rows)),
                                     'amount_with_tax': r2(sum_js(r['amount_with_tax'] for r in rows))}}


def by_item(req, side):
    p = params(req)
    main, credit = (['invoice', 'salesreceipt'], 'creditnote') if side == 'sales' else (['bill'], 'vendorcredit')
    # SQLite returned the bare (non-aggregated) columns from the group's last row; we take them from its last line (highest id).
    raw = all(f'''SELECT (array_agg(l.item_id ORDER BY l.id DESC))[1] AS item_id,
      (array_agg(COALESCE(i.name, l.name, l.description, 'Other') ORDER BY l.id DESC))[1] AS name,
      (array_agg(i.sku ORDER BY l.id DESC))[1] AS sku, (array_agg(COALESCE(l.unit, i.unit) ORDER BY l.id DESC))[1] AS unit,
      SUM(CASE WHEN d.doc_type = ? THEN -1 ELSE 1 END * l.quantity) AS qty,
      SUM(CASE WHEN d.doc_type = ? THEN -1 ELSE 1 END * l.taxable * {DOC_FX}) AS amount
    FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN items i ON i.id = l.item_id
    WHERE d.org_id = ? AND d.doc_type IN ({q([*main, credit])}) AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    GROUP BY COALESCE(CAST(l.item_id AS TEXT), 'n:' || COALESCE(l.name, l.description, ''))
    ORDER BY amount DESC NULLS LAST, COALESCE(CAST(l.item_id AS TEXT), 'n:' || COALESCE(l.name, l.description, '')) COLLATE "C"''',
              credit, credit, p['org']['id'], p['from'], p['to'])
    rows = [{**r, 'qty': r2(r['qty']), 'amount': r2(r['amount']), 'avg_price': r2(_n(r['amount']) / r['qty']) if truthy(r['qty']) else 0} for r in raw]
    return {**head('Sales by Item' if side == 'sales' else 'Purchases by Item', p),
            'columns': [col('name', 'Item Name', 'item'), col('sku', 'SKU'), col('qty', 'Quantity Sold' if side == 'sales' else 'Quantity Purchased', 'num'),
                        col('amount', 'Amount', 'money'), col('avg_price', 'Average Price', 'money')],
            'rows': rows, 'totals': {'name': 'Total', 'qty': r2(sum_js(r['qty'] for r in rows)), 'amount': r2(sum_js(r['amount'] for r in rows))}}


def rpt_sales_by_salesperson(req):
    p = params(req)
    rows = [{**r, 'amount': r2(r['amount']), 'amount_with_tax': r2(r['amount_with_tax'])} for r in all(
        f'''SELECT COALESCE(NULLIF(d.salesperson, ''), 'Others') AS name,
      SUM(CASE WHEN d.doc_type = 'creditnote' THEN 0 ELSE 1 END) AS count,
      SUM(CASE WHEN d.doc_type = 'creditnote' THEN -1 ELSE 1 END * (d.total - d.tax_total) * {DOC_FX}) AS amount,
      SUM(CASE WHEN d.doc_type = 'creditnote' THEN -1 ELSE 1 END * d.total * {DOC_FX}) AS amount_with_tax
    FROM documents d WHERE d.org_id = ? AND d.doc_type IN ('invoice','salesreceipt','creditnote') AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    GROUP BY 1 ORDER BY amount DESC NULLS LAST, COALESCE(NULLIF(d.salesperson, ''), 'Others') COLLATE "C"''', p['org']['id'], p['from'], p['to'])]
    return {**head('Sales by Sales Person', p),
            'columns': [col('name', 'Sales Person'), col('count', 'Invoice Count', 'num'), col('amount', 'Sales', 'money'), col('amount_with_tax', 'Sales With Tax', 'money')],
            'rows': rows, 'totals': {'name': 'Total', 'count': sum_js(r['count'] for r in rows), 'amount': r2(sum_js(r['amount'] for r in rows)),
                                     'amount_with_tax': r2(sum_js(r['amount_with_tax'] for r in rows))}}


def contact_balances(req, side):
    p = params(req)
    s = side == 'sales'
    doc_type = 'invoice' if s else 'bill'
    as_of = p['to']
    org_id = p['org']['id']
    billed = all(f'''SELECT d.contact_id, c.display_name AS name, SUM(d.total * {DOC_FX}) AS amt FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type = ? AND d.status IN {LIVE} AND d.date <= ? GROUP BY d.contact_id, c.id ORDER BY d.contact_id NULLS FIRST''', org_id, doc_type, as_of)
    paid = all('''SELECT p.contact_id, c.display_name AS name, SUM(p.amount * COALESCE(p.exchange_rate,1)) AS amt FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.org_id = ? AND p.type = ? AND p.date <= ? GROUP BY p.contact_id, c.id ORDER BY p.contact_id NULLS FIRST''', org_id, 'received' if s else 'made', as_of)
    opn = open_docs_as_of(org_id, doc_type, as_of)
    credits = unused_credits_as_of(org_id, side, as_of)
    mp = {}

    def row(cid, name):
        if cid not in mp:
            mp[cid] = {'contact_id': cid, 'name': name, 'invoiced': 0, 'received': 0, 'balance': 0, 'credits': 0}
        r = mp[cid]
        if not truthy(r['name']) and truthy(name):
            r['name'] = name
        return r

    for b in billed:
        row(b['contact_id'], b['name'])['invoiced'] = r2(b['amt'])
    for x in paid:
        row(x['contact_id'], x['name'])['received'] = r2(x['amt'])
    for d in opn:
        r = row(d['contact_id'], d['contact_name'])
        r['balance'] = r2(r['balance'] + d['bal_base'])
    for cid, v in credits.items():
        row(cid, None)['credits'] = v
    names = {c['id']: c['display_name'] for c in all('SELECT id, display_name FROM contacts WHERE org_id = ? ORDER BY id', org_id)}
    rows = []
    for r in mp.values():
        nm = r['name'] if truthy(r['name']) else (names.get(r['contact_id']) if truthy(names.get(r['contact_id'])) else '(No contact)')
        rows.append({**r, 'name': nm, 'net': r2(r['balance'] - r['credits'])})
    rows.sort(key=lambda r: _lc(r['name']))

    def sm(k):
        return r2(sum_js(r[k] for r in rows))

    return {**head('Customer Balances' if s else 'Vendor Balances', p, {'as_of': as_of}),
            'columns': [col('name', 'Customer Name' if s else 'Vendor Name', 'contact'), col('invoiced', 'Invoiced Amount' if s else 'Billed Amount', 'money'),
                        col('received', 'Amount Received' if s else 'Amount Paid', 'money'), col('balance', 'Closing Balance', 'money'), col('credits', 'Unused Credits', 'money'),
                        col('net', 'Net Balance', 'money')],
            'rows': rows, 'totals': {'name': 'Total', 'invoiced': sm('invoiced'), 'received': sm('received'), 'balance': sm('balance'), 'credits': sm('credits'), 'net': sm('net')}}


def doc_details(req, doc_type, title):
    p = params(req)
    rows = [{**d, 'status': display_status(d), 'total_base': r2(_n(d['total']) * _n(d['fx'])), 'balance_base': r2(_n(d['balance']) * _n(d['fx']))} for d in all(
        f'''SELECT d.id AS doc_id, d.doc_type, d.number, d.reference, d.date, d.due_date, d.status, d.total, d.balance, d.sent_at, d.currency,
      {DOC_FX} AS fx, d.contact_id, c.display_name AS contact_name, d.salesperson
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date COLLATE "C" DESC, d.number COLLATE "C" DESC NULLS LAST, d.id''',
        p['org']['id'], doc_type, p['from'], p['to'])]
    if truthy(p['q'].get('status')):
        st = _s(p['q'].get('status')).split(',')
        rows = [r for r in rows if r['status'] in st]
    payable = doc_type in ('invoice', 'bill', 'creditnote', 'vendorcredit')
    cols = [col('status', 'Status', 'status'), col('date', 'Date', 'date'), col('number', 'Number', 'doc'), col('reference', 'Reference#'),
            col('contact_name', 'Vendor Name' if doc_type in ('bill', 'vendorcredit', 'purchaseorder') else 'Customer Name', 'contact')]
    if doc_type in ('invoice', 'bill', 'quote', 'salesorder', 'purchaseorder'):
        cols.append(col('due_date', {'invoice': 'Due Date', 'bill': 'Due Date', 'quote': 'Expiry Date', 'salesorder': 'Shipment Date', 'purchaseorder': 'Delivery Date'}[doc_type], 'date'))
    cols.append(col('total_base', 'Amount', 'money'))
    if payable:
        cols.append(col('balance_base', 'Balance' if 'credit' in doc_type else 'Balance Due', 'money'))
    live = [r for r in rows if r['status'] != 'void']
    totals = {'total_base': r2(sum_js(r['total_base'] for r in live)), 'balance_base': r2(sum_js(r['balance_base'] for r in live))}
    return {**head(title, p), 'columns': cols, 'rows': rows, 'totals': totals}


def payments_report(req, kind):
    p = params(req)
    rows = [{**r, 'amount': r2(r['amount']), 'unused': r2(r['unused'])} for r in all(
        '''SELECT p.id AS payment_id, p.type AS payment_type, p.number, p.date, p.reference, p.mode, p.contact_id, c.display_name AS contact_name,
      a.name AS account_name, p.account_id, p.amount * COALESCE(p.exchange_rate,1) AS amount, p.currency,
      (p.amount + COALESCE(p.tds_amount,0) - COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id = p.id),0)
        - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE source_type = 'payment' AND source_id = p.id),0)
        - COALESCE((SELECT SUM(amount) FROM refunds WHERE source_type = 'payment' AND source_id = p.id),0)) * COALESCE(p.exchange_rate,1) AS unused,
      (SELECT string_agg(d.number, ', ' ORDER BY pa.id) FROM payment_allocations pa JOIN documents d ON d.id = pa.document_id WHERE pa.payment_id = p.id) AS applied_to
    FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id LEFT JOIN accounts a ON a.id = p.account_id
    WHERE p.org_id = ? AND p.type = ? AND p.date >= ? AND p.date <= ? ORDER BY p.date COLLATE "C" DESC, p.id DESC''', p['org']['id'], kind, p['from'], p['to'])]
    modes = {}
    for r in rows:
        m = r['mode'] if truthy(r['mode']) else 'Other'
        x = modes.get(m) or {'name': m, 'count': 0, 'amount': 0}
        x['count'] += 1
        x['amount'] = r2(x['amount'] + r['amount'])
        modes[m] = x
    s = kind == 'received'
    return {**head('Payments Received' if s else 'Payments Made', p),
            'columns': [col('date', 'Date', 'date'), col('number', 'Payment#', 'payment'), col('reference', 'Reference#'), col('contact_name', 'Customer Name' if s else 'Vendor Name', 'contact'),
                        col('mode', 'Payment Mode'), col('applied_to', 'Invoices' if s else 'Bills'), col('account_name', 'Deposit To' if s else 'Paid Through', 'account'),
                        col('amount', 'Amount', 'money'), col('unused', 'Unused Amount', 'money')],
            'rows': rows, 'totals': {'amount': r2(sum_js(r['amount'] for r in rows)), 'unused': r2(sum_js(r['unused'] for r in rows))},
            'by_mode': list(modes.values()),
            'extra': [{'title': 'By Payment Mode', 'columns': [col('name', 'Payment Mode'), col('count', 'Count', 'num'), col('amount', 'Amount', 'money')], 'rows': list(modes.values())}]}


_REFUND_LABELS = {'creditnote': 'Credit Note', 'vendorcredit': 'Vendor Credit', 'payment': 'Payment'}


def rpt_refund_history(req):
    p = params(req)
    rows = []
    for r in all('''SELECT r.id, r.date, r.source_type, r.source_id, r.amount, r.mode, r.reference, a.name AS account_name, r.account_id,
      COALESCE(d.number, pm.number) AS source_number, COALESCE(d.contact_id, pm.contact_id) AS contact_id, c.display_name AS contact_name,
      COALESCE(d.doc_type, 'payment') AS kind, pm.type AS payment_type
    FROM refunds r LEFT JOIN documents d ON r.source_type != 'payment' AND d.id = r.source_id
    LEFT JOIN payments pm ON r.source_type = 'payment' AND pm.id = r.source_id
    LEFT JOIN contacts c ON c.id = COALESCE(d.contact_id, pm.contact_id) LEFT JOIN accounts a ON a.id = r.account_id
    WHERE r.org_id = ? AND r.date >= ? AND r.date <= ? ORDER BY r.date COLLATE "C" DESC, r.id''', p['org']['id'], p['from'], p['to']):
        st = r['source_type']
        lbl = _REFUND_LABELS.get(st) if isinstance(st, str) else None
        rows.append({**r, 'src_type': f"payment_{_s(r['payment_type'])}" if st == 'payment' else st, 'src_id': r['source_id'],
                     'source_label': lbl if lbl else st})
    return {**head('Refund History', p),
            'columns': [col('date', 'Date', 'date'), col('source_label', 'Refund From'), col('source_number', 'Source#', 'source'), col('contact_name', 'Contact', 'contact'),
                        col('mode', 'Mode'), col('reference', 'Reference#'), col('account_name', 'Account', 'account'), col('amount', 'Amount', 'money')],
            'rows': rows, 'totals': {'amount': r2(sum_js(_n(r['amount']) for r in rows))}}


def rpt_time_to_get_paid(req):
    p = params(req)
    docs = all(f'''SELECT d.id, d.date, d.contact_id, c.display_name AS name,
      (SELECT MAX(dt COLLATE "C") FROM (SELECT p.date AS dt FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.document_id = d.id
                            UNION ALL SELECT ca.date FROM credit_applications ca WHERE ca.document_id = d.id) x) AS paid_on
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type = 'invoice' AND d.status IN {LIVE} AND d.balance <= 0.004 AND d.date >= ? AND d.date <= ?
    ORDER BY d.date COLLATE "C", d.id''', p['org']['id'], p['from'], p['to'])
    keys = [['d0_15', '0-15 Days'], ['d16_30', '16-30 Days'], ['d31_45', '31-45 Days'], ['gt45', 'Above 45 Days']]
    by = {}
    for d in docs:
        if not truthy(d['paid_on']):
            continue
        days = _js_max(0, days_between(d['date'], d['paid_on']))
        k = 'd0_15' if days <= 15 else 'd16_30' if days <= 30 else 'd31_45' if days <= 45 else 'gt45'
        r = by.get(d['contact_id']) or {'contact_id': d['contact_id'], 'name': d['name'], 'd0_15': 0, 'd16_30': 0, 'd31_45': 0, 'gt45': 0, 'count': 0, 'days': 0}
        r[k] += 1
        r['count'] += 1
        r['days'] += days
        by[d['contact_id']] = r
    rows = [{**r, 'avg_days': r2(r['days'] / r['count']), **{f'{k}_pct': r2((r[k] / r['count']) * 100) for k, _ in keys}} for r in by.values()]
    return {**head('Time to Get Paid', p),
            'columns': [col('name', 'Customer Name', 'contact'), *[col(f'{k}_pct', l, 'pct') for k, l in keys], col('count', 'Paid Invoices', 'num'), col('avg_days', 'Average Days', 'num')],
            'rows': rows}


# ---------------- expenses ----------------
def rpt_expense_details(req):
    p = params(req)
    rows = []
    for e in all('''SELECT e.id AS expense_id, e.date, e.reference, e.notes, e.status, e.splits, e.account_id, a.name AS account_name, e.vendor_id, v.display_name AS vendor_name,
      e.customer_id, cu.display_name AS customer_name, pt.name AS paid_through, (e.total - e.tax_amount) * COALESCE(e.exchange_rate,1) AS amount,
      e.tax_amount * COALESCE(e.exchange_rate,1) AS tax, e.total * COALESCE(e.exchange_rate,1) AS total
    FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN contacts v ON v.id = e.vendor_id LEFT JOIN contacts cu ON cu.id = e.customer_id
    LEFT JOIN accounts pt ON pt.id = e.paid_through_id
    WHERE e.org_id = ? AND e.is_profile = 0 AND e.date >= ? AND e.date <= ? ORDER BY e.date COLLATE "C" DESC, e.id DESC''', p['org']['id'], p['from'], p['to']):
        sp = e['splits']
        x = {**e, 'account_name': 'Itemized' if truthy(sp) and sp != 'null' and sp != '[]' else e['account_name'],
             'amount': r2(e['amount']), 'tax': r2(e['tax']), 'total': r2(e['total'])}
        del x['splits']
        rows.append(x)
    return {**head('Expense Details', p),
            'columns': [col('date', 'Date', 'date'), col('account_name', 'Expense Account', 'expense'), col('reference', 'Reference#'), col('vendor_name', 'Vendor', 'contact', {'idKey': 'vendor_id'}),
                        col('paid_through', 'Paid Through'), col('customer_name', 'Customer', 'contact', {'idKey': 'customer_id'}), col('status', 'Status', 'status'),
                        col('amount', 'Amount', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money')],
            'rows': rows, 'totals': {'amount': r2(sum_js(r['amount'] for r in rows)), 'tax': r2(sum_js(r['tax'] for r in rows)), 'total': r2(sum_js(r['total'] for r in rows))}}


def rpt_expenses_by_category(req):
    p = params(req)
    rows = [{**r, 'amount': r2(r['amount'])} for r in all(
        f'''SELECT a.id AS account_id, a.name, a.code, COUNT(DISTINCT l.src_id) AS count, SUM(l.debit - l.credit) AS amount
    FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.src_type = 'expense' AND a.type IN ({q(EXPENSE_TYPES)}) AND l.date >= ? AND l.date <= ?
    GROUP BY a.id ORDER BY amount DESC NULLS LAST, a.id''', p['org']['id'], p['from'], p['to'])]
    return {**head('Expenses by Category', p), 'columns': [col('name', 'Category Name', 'account'), col('count', 'Expense Count', 'num'), col('amount', 'Amount', 'money')], 'rows': rows,
            'totals': {'name': 'Total', 'count': sum_js(r['count'] for r in rows), 'amount': r2(sum_js(r['amount'] for r in rows))}}


def rpt_billable_expenses(req):
    p = params(req)
    rows = [{**r, 'amount': r2(r['amount']), 'bill_amount': r2(_n(r['amount']) * (1 + (r['markup_percent'] or 0) / 100))} for r in all(
        '''SELECT e.id AS expense_id, e.date, e.reference, e.status, a.name AS account_name, e.customer_id, cu.display_name AS customer_name,
      e.total * COALESCE(e.exchange_rate,1) AS amount, e.markup_percent, e.invoice_id AS doc_id,
      CASE WHEN e.invoice_id IS NOT NULL AND e.invoice_id <> 0 THEN 'invoice' END AS doc_type, d.number
    FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN contacts cu ON cu.id = e.customer_id LEFT JOIN documents d ON d.id = e.invoice_id
    WHERE e.org_id = ? AND e.is_profile = 0 AND e.is_billable = 1 AND e.date >= ? AND e.date <= ? ORDER BY e.date COLLATE "C" DESC, e.id''', p['org']['id'], p['from'], p['to'])]
    return {**head('Billable Expense Details', p),
            'columns': [col('date', 'Date', 'date'), col('account_name', 'Expense Account', 'expense'), col('customer_name', 'Customer', 'contact'),
                        col('status', 'Status', 'status'), col('number', 'Invoice#', 'doc'), col('amount', 'Expense Amount', 'money'), col('bill_amount', 'Billable Amount', 'money')],
            'rows': rows, 'totals': {'amount': r2(sum_js(r['amount'] for r in rows)), 'bill_amount': r2(sum_js(r['bill_amount'] for r in rows))}}


# ---------------- inventory ----------------
# SQLite `COLLATE NOCASE` folds ASCII letters only
NOCASE_NAME = "translate(i.name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\""


def rpt_inventory_summary(req):
    p = params(req)
    rows = [{**r, 'available': r2(_n(r['closing']) - _n(r['committed'])), 'low': _n(r['closing']) <= (r['reorder_level'] or 0)} for r in all(
        f'''SELECT i.id AS item_id, i.name, i.sku, i.unit, i.reorder_level,
      COALESCE(SUM(CASE WHEN s.date < ? THEN s.qty END), 0) AS opening,
      COALESCE(SUM(CASE WHEN s.date >= ? AND s.date <= ? AND s.qty > 0 THEN s.qty END), 0) AS qty_in,
      COALESCE(SUM(CASE WHEN s.date >= ? AND s.date <= ? AND s.qty < 0 THEN -s.qty END), 0) AS qty_out,
      COALESCE(SUM(CASE WHEN s.date <= ? THEN s.qty END), 0) AS closing,
      (SELECT COALESCE(SUM(l.quantity),0) FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.item_id = i.id AND d.doc_type = 'salesorder' AND d.status = 'open') AS committed
    FROM items i LEFT JOIN stock_moves s ON s.item_id = i.id
    WHERE i.org_id = ? AND i.track_inventory = 1 GROUP BY i.id ORDER BY {NOCASE_NAME}, i.id''', p['from'], p['from'], p['to'], p['from'], p['to'], p['to'], p['org']['id'])]
    return {**head('Inventory Summary', p),
            'columns': [col('name', 'Item Name', 'item'), col('sku', 'SKU'), col('opening', 'Opening Stock', 'num'), col('qty_in', 'Quantity In', 'num'),
                        col('qty_out', 'Quantity Out', 'num'), col('closing', 'Stock on Hand', 'num'), col('committed', 'Committed Stock', 'num'),
                        col('available', 'Available for Sale', 'num'), col('reorder_level', 'Reorder Level', 'num')], 'rows': rows}


def inventory_valuation(org_id, to):
    rows = []
    for r in all(f'''SELECT i.id AS item_id, i.name, i.sku, i.unit, COALESCE(SUM(s.qty),0) AS qty, COALESCE(SUM(s.value),0) AS value
    FROM items i LEFT JOIN stock_moves s ON s.item_id = i.id AND s.date <= ?
    WHERE i.org_id = ? AND i.track_inventory = 1 GROUP BY i.id ORDER BY {NOCASE_NAME}, i.id''', to, org_id):
        avg = r['value'] / r['qty'] if r['qty'] > 0 else 0
        rows.append({**r, 'qty': r2(r['qty']), 'avg_cost': r2(avg), 'value': r2(r['qty'] * avg) if r['qty'] > 0 else 0})
    account_balance = r2(get('''SELECT COALESCE(SUM(l.debit - l.credit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.type = 'stock' AND l.date <= ?''', org_id, to)['s'])
    return {'rows': rows, 'total': r2(sum_js(r['value'] for r in rows)), 'account_balance': account_balance}


def rpt_inventory_valuation(req):
    p = params(req)
    v = inventory_valuation(p['org']['id'], p['to'])
    return {**head('Inventory Valuation Summary', p, {'as_of': p['to']}),
            'columns': [col('name', 'Item Name', 'item'), col('sku', 'SKU'), col('qty', 'Stock on Hand', 'num'), col('avg_cost', 'Average Cost', 'money'), col('value', 'Asset Value', 'money')],
            'rows': v['rows'], 'totals': {'name': 'Total', 'qty': r2(sum_js(r['qty'] for r in v['rows'])), 'value': v['total']}, 'inventory_account_balance': v['account_balance']}


def rpt_stock_aging(req):
    # FIFO ageing of the quantity on hand: the most recent receipts are assumed to still be in stock.
    p = params(req)
    items = all(f'SELECT i.id AS item_id, i.name, i.sku FROM items i WHERE i.org_id = ? AND i.track_inventory = 1 ORDER BY {NOCASE_NAME}, i.id', p['org']['id'])
    keys = [['a0_30', '0-30 Days'], ['a31_60', '31-60 Days'], ['a61_90', '61-90 Days'], ['gt90', '> 90 Days']]
    rows = []
    for i in items:
        on_hand = get('SELECT COALESCE(SUM(qty),0) q FROM stock_moves WHERE item_id = ? AND date <= ?', i['item_id'], p['to'])['q']
        r = {**i, 'qty': r2(on_hand), 'a0_30': 0, 'a31_60': 0, 'a61_90': 0, 'gt90': 0}
        left = on_hand
        for m in all('SELECT date, qty FROM stock_moves WHERE item_id = ? AND qty > 0 AND date <= ? ORDER BY date COLLATE "C" DESC, id DESC', i['item_id'], p['to']):
            if left <= 0:
                break
            take = min(left, m['qty'])
            age = days_between(m['date'], p['to'])
            r['a0_30' if age <= 30 else 'a31_60' if age <= 60 else 'a61_90' if age <= 90 else 'gt90'] += take
            left -= take
        if truthy(r['qty']):
            rows.append(r)
    return {**head('Stock Aging Summary', p, {'as_of': p['to']}),
            'columns': [col('name', 'Item Name', 'item'), col('sku', 'SKU'), *[col(k, l, 'num') for k, l in keys], col('qty', 'Total', 'num')], 'rows': rows}


def rpt_committed_stock(req):
    p = params(req)
    rows = [{**r, 'available': r2(_n(r['on_hand']) - _n(r['committed']))} for r in all(
        f'''SELECT i.id AS item_id, i.name, i.sku, SUM(l.quantity) AS committed, COUNT(DISTINCT d.id) AS orders,
      (SELECT COALESCE(SUM(qty),0) FROM stock_moves s WHERE s.item_id = i.id) AS on_hand
    FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN items i ON i.id = l.item_id
    WHERE d.org_id = ? AND d.doc_type = 'salesorder' AND d.status = 'open' GROUP BY i.id ORDER BY {NOCASE_NAME}, i.id''', p['org']['id'])]
    details = all('''SELECT d.id AS doc_id, d.doc_type, d.number, d.date, c.display_name AS contact_name, d.contact_id, i.name AS item, l.quantity
    FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN items i ON i.id = l.item_id LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type = 'salesorder' AND d.status = 'open' ORDER BY d.date COLLATE "C", d.id, l.id''', p['org']['id'])
    return {**head('Committed Stock Details', p),
            'columns': [col('name', 'Item Name', 'item'), col('sku', 'SKU'), col('orders', 'Sales Orders', 'num'), col('committed', 'Committed Quantity', 'num'),
                        col('on_hand', 'Stock on Hand', 'num'), col('available', 'Available for Sale', 'num')],
            'rows': rows, 'extra': [{'title': 'Open Sales Orders', 'columns': [col('date', 'Date', 'date'), col('number', 'Sales Order#', 'doc'), col('contact_name', 'Customer', 'contact'),
                                                                               col('item', 'Item'), col('quantity', 'Quantity', 'num')], 'rows': details}]}


# ---------------- taxes / GST ----------------
def _no_const(_c):
    raise ValueError('invalid JSON')


def _json_each(text):
    """SQLite json_each(CASE WHEN json_valid(x) THEN x ELSE '[]' END): array elements, object values, or the scalar itself."""
    if not isinstance(text, str):
        return []
    try:
        v = json.loads(text, parse_constant=_no_const)
    except ValueError:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    return [v]


def _json_extract(v, key):
    """json_extract(value, '$.key')"""
    if not isinstance(v, dict):
        return None
    x = v.get(key)
    if isinstance(x, bool):
        return 1 if x else 0
    if isinstance(x, (dict, list)):
        return json.dumps(x, separators=(',', ':'), ensure_ascii=False)
    return x


def tax_lines(org_id, frm, to, types):
    """Tax components of document lines in a period: one row per (line, component)."""
    out = []
    for r in all(f'''SELECT d.id AS doc_id, d.doc_type, {DOC_FX} AS fx, l.id AS line_id, l.taxable, l.tax_breakdown
    FROM document_lines l JOIN documents d ON d.id = l.document_id
    WHERE d.org_id = ? AND d.doc_type IN ({q(types)}) AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    ORDER BY d.date COLLATE "C", d.id, l.id''', org_id, frm, to):
        for j in _json_each(r['tax_breakdown']):
            out.append({'doc_id': r['doc_id'], 'doc_type': r['doc_type'], 'fx': r['fx'], 'line_id': r['line_id'], 'taxable': r['taxable'],
                        'name': _json_extract(j, 'name'), 'code': _json_extract(j, 'code'), 'rate': _json_extract(j, 'rate'), 'amount': _json_extract(j, 'amount')})
    return out


def rpt_tax_summary(req):
    p = params(req)

    def group(lines, neg_type):
        m = {}
        for l in lines:
            s = -1 if l['doc_type'] == neg_type else 1
            x = m.get(l['name']) or {'name': l['name'], 'code': l['code'], 'rate': l['rate'], 'taxable': 0, 'tax': 0}
            x['taxable'] = r2(x['taxable'] + s * _n(l['taxable']) * _n(l['fx']))
            x['tax'] = r2(x['tax'] + s * _n(l['amount']) * _n(l['fx']))
            m[l['name']] = x
        return sorted(m.values(), key=lambda a: _lc(a['name']))

    out = group(tax_lines(p['org']['id'], p['from'], p['to'], ['invoice', 'salesreceipt', 'creditnote']), 'creditnote')
    inp = group(tax_lines(p['org']['id'], p['from'], p['to'], ['bill', 'vendorcredit']), 'vendorcredit')
    exp = all('''SELECT COALESCE(l.description, a.name) AS name, SUM(l.debit - l.credit) AS tax FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND l.src_type = 'expense' AND a.system_code IN ('input_cgst','input_sgst','input_igst','input_tax') AND l.date >= ? AND l.date <= ?
    GROUP BY 1 ORDER BY COALESCE(l.description, a.name) COLLATE "C" NULLS FIRST''', p['org']['id'], p['from'], p['to'])
    for e in exp:
        x = next((i for i in inp if i['name'] == e['name']), None)
        if x:
            x['tax'] = r2(x['tax'] + e['tax'])
            x['expense_tax'] = r2(e['tax'])
        else:
            inp.append({'name': e['name'], 'taxable': None, 'tax': r2(e['tax']), 'expense_tax': r2(e['tax'])})
    to = r2(sum_js(r['tax'] for r in out))
    ti = r2(sum_js(r['tax'] for r in inp))
    rows = [{'name': 'Output Tax (Sales)', '_kind': 'section'}, *[{**r, '_indent': 1} for r in out],
            {'name': 'Total Output Tax', 'tax': to, 'taxable': r2(sum_js(r['taxable'] for r in out)), '_kind': 'total'},
            {'name': 'Input Tax (Purchases & Expenses)', '_kind': 'section'}, *[{**r, '_indent': 1} for r in inp], {'name': 'Total Input Tax', 'tax': ti, '_kind': 'total'},
            {'name': 'Net Tax Payable' if to - ti >= 0 else 'Net Tax Refundable', 'tax': r2(to - ti), '_kind': 'grand'}]
    return {**head('Tax Summary', p), 'columns': [col('name', 'Tax Name'), col('taxable', 'Taxable Amount', 'money'), col('tax', 'Tax Amount', 'money')], 'rows': rows,
            'output_tax': to, 'input_tax': ti, 'net_payable': r2(to - ti)}


GST_CODES = ['igst', 'cgst', 'sgst']


def ddmmyyyy(d):
    return f'{d[8:10]}-{d[5:7]}-{d[0:4]}'


def is_registered(c):
    return bool(truthy(c.get('gstin')) and _s(c.get('gstin')).strip()) and c.get('gst_treatment') not in ('unregistered', 'consumer', 'overseas')


def gst_docs(org, frm, to, types):
    """Per-document GST detail: items grouped by rate (base currency)."""
    docs = all(f'''SELECT d.id AS doc_id, d.doc_type, d.number, d.date, d.total, {DOC_FX} AS fx, COALESCE(d.place_of_supply, c.place_of_supply, ?) AS pos,
      d.contact_id, c.display_name AS contact_name, c.gstin, c.gst_treatment
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.doc_type IN ({q(types)}) AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    ORDER BY d.date COLLATE "C", d.number COLLATE "C" NULLS FIRST, d.id''', org.get('state'), org['id'], frm, to)
    lines = all(f'''SELECT l.document_id, l.taxable, l.tax_breakdown, l.hsn_sac, l.quantity, COALESCE(l.unit, i.unit) AS unit, COALESCE(i.name, l.name, l.description) AS name
    FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN items i ON i.id = l.item_id
    WHERE d.org_id = ? AND d.doc_type IN ({q(types)}) AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ?
    ORDER BY d.id, l.id''', org['id'], frm, to)
    by_doc = {d['doc_id']: {**d, 'value': r2(_n(d['total']) * _n(d['fx'])), 'lines': []} for d in docs}
    for l in lines:
        d = by_doc.get(l['document_id'])
        if not d:
            continue
        try:
            comps = json.loads(l['tax_breakdown'] or '[]') or []
        except (ValueError, TypeError):
            comps = []
        if isinstance(comps, dict):
            raise TypeError('comps is not iterable')
        t = {'taxable': r2(_n(l['taxable']) * _n(d['fx'])), 'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0, 'rate': 0, 'hsn': l['hsn_sac'] or '',
             'unit': l['unit'] or 'OTH', 'qty': jsnum(l['quantity']), 'name': l['name']}
        for c in (comps if isinstance(comps, (list, str)) else []):
            cd = c if isinstance(c, dict) else {}
            amt = r2(jsnum(cd.get('amount')) * _n(d['fx']))
            code = cd.get('code')
            if isinstance(code, str) and code in GST_CODES:
                t[code] = r2(t[code] + amt)
                t['rate'] += jsnum(cd.get('rate'))
            else:
                t['cess'] = r2(t['cess'] + amt)
        t['rate'] = r2(t['rate'])
        d['lines'].append(t)
    for d in by_doc.values():
        items = {}
        for l in d['lines']:
            x = items.get(l['rate']) or {'rt': l['rate'], 'txval': 0, 'iamt': 0, 'camt': 0, 'samt': 0, 'csamt': 0}
            x['txval'] = r2(x['txval'] + l['taxable'])
            x['iamt'] = r2(x['iamt'] + l['igst'])
            x['camt'] = r2(x['camt'] + l['cgst'])
            x['samt'] = r2(x['samt'] + l['sgst'])
            x['csamt'] = r2(x['csamt'] + l['cess'])
            items[l['rate']] = x
        d['items'] = list(items.values())
        for k in ('txval', 'iamt', 'camt', 'samt', 'csamt'):
            d[k] = r2(sum_js(i[k] for i in d['items']))
        d['registered'] = is_registered(d)
        d['inter'] = (d['pos'] != org.get('state')) if (truthy(d['pos']) and truthy(org.get('state'))) else False
    return list(by_doc.values())


def hsn_summary(org, frm, to):
    docs = gst_docs(org, frm, to, ['invoice', 'salesreceipt', 'creditnote'])
    m = {}
    for d in docs:
        s = -1 if d['doc_type'] == 'creditnote' else 1
        for l in d['lines']:
            k = f"{_s(l['hsn'])}|{_s(l['unit'])}|{_s(l['rate'])}"
            x = m.get(k) or {'hsn': l['hsn'] or '—', 'description': l['name'], 'uqc': _s(l['unit'] or 'OTH').upper(), 'rate': l['rate'],
                             'qty': 0, 'taxable': 0, 'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0}
            x['qty'] = r2(x['qty'] + s * l['qty'])
            x['taxable'] = r2(x['taxable'] + s * l['taxable'])
            for c in ('igst', 'cgst', 'sgst', 'cess'):
                x[c] = r2(x[c] + s * l[c])
            m[k] = x
    out = [{**x, 'total': r2(x['taxable'] + x['igst'] + x['cgst'] + x['sgst'] + x['cess'])} for x in m.values()]
    out.sort(key=lambda a: _lc(a['hsn']))
    return out


HSN_COLS = [col('hsn', 'HSN/SAC'), col('description', 'Description'), col('uqc', 'UQC'), col('rate', 'Rate %', 'num'), col('qty', 'Total Quantity', 'num'),
            col('taxable', 'Taxable Value', 'money'), col('igst', 'IGST', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('cess', 'Cess', 'money'),
            col('total', 'Total Value', 'money')]

B2CL_LIMIT = 250000


def gstr1(org, frm, to):
    docs = gst_docs(org, frm, to, ['invoice', 'salesreceipt', 'creditnote'])
    inv = [d for d in docs if d['doc_type'] != 'creditnote']
    notes = [d for d in docs if d['doc_type'] == 'creditnote']
    b2b = [d for d in inv if d['registered']]
    b2cl = [d for d in inv if not d['registered'] and d['inter'] and d['value'] > B2CL_LIMIT]
    b2cs = [d for d in inv if not d['registered'] and not (d['inter'] and d['value'] > B2CL_LIMIT)]
    cdnr = [d for d in notes if d['registered']]
    cdnur = [d for d in notes if not d['registered']]
    b2cs_grouped = {}
    for d in b2cs:
        for it in d['items']:
            k = f"{_s(d['pos'])}|{_s(it['rt'])}"
            x = b2cs_grouped.get(k) or {'type': 'B2CS', 'pos': d['pos'], 'sply_ty': 'INTER' if d['inter'] else 'INTRA', 'rate': it['rt'],
                                        'taxable': 0, 'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0}
            x['taxable'] = r2(x['taxable'] + it['txval'])
            x['igst'] = r2(x['igst'] + it['iamt'])
            x['cgst'] = r2(x['cgst'] + it['camt'])
            x['sgst'] = r2(x['sgst'] + it['samt'])
            x['cess'] = r2(x['cess'] + it['csamt'])
            b2cs_grouped[k] = x

    def doc_row(d):
        return {'doc_id': d['doc_id'], 'doc_type': d['doc_type'], 'number': d['number'], 'date': d['date'], 'contact_id': d['contact_id'],
                'contact_name': d['contact_name'], 'gstin': d['gstin'] or '', 'pos': d['pos'], 'value': d['value'], 'rate': ', '.join(_s(i['rt']) for i in d['items']),
                'taxable': d['txval'], 'igst': d['iamt'], 'cgst': d['camt'], 'sgst': d['samt'], 'cess': d['csamt']}

    def sm(arr, k):
        return r2(sum_js((x.get(k) or 0) for x in arr))

    def summarize(label, lst, key='doc'):
        rows = [doc_row(d) for d in lst] if key == 'doc' else lst
        return {'section': label, 'count': len(rows), 'taxable': sm(rows, 'taxable'), 'igst': sm(rows, 'igst'), 'cgst': sm(rows, 'cgst'), 'sgst': sm(rows, 'sgst'), 'cess': sm(rows, 'cess')}

    hsn = hsn_summary(org, frm, to)

    def doc_cols(who):
        return [col('date', 'Date', 'date'), col('number', 'Number', 'doc'), col('contact_name', who, 'contact'), col('gstin', 'GSTIN'), col('pos', 'Place of Supply'),
                col('rate', 'Rate %'), col('value', 'Value', 'money'), col('taxable', 'Taxable Value', 'money'), col('igst', 'IGST', 'money'), col('cgst', 'CGST', 'money'),
                col('sgst', 'SGST', 'money'), col('cess', 'Cess', 'money')]

    def totals_of(rows):
        return {'value': sm(rows, 'value'), 'taxable': sm(rows, 'taxable'), 'igst': sm(rows, 'igst'), 'cgst': sm(rows, 'cgst'), 'sgst': sm(rows, 'sgst'), 'cess': sm(rows, 'cess')}

    b2b_rows = [doc_row(d) for d in b2b]
    b2c_rows = [*[{**doc_row(d), 'type': 'B2CL'} for d in b2cl],
                *[{**x, 'number': f"{x['sply_ty']} · POS {_s(x['pos'])}"} for x in b2cs_grouped.values()]]
    cdn_rows = [*[{**doc_row(d), 'type': 'CDNR'} for d in cdnr], *[{**doc_row(d), 'type': 'CDNUR'} for d in cdnur]]
    return {
        'docs': {'b2b': b2b, 'b2cl': b2cl, 'b2cs': list(b2cs_grouped.values()), 'cdnr': cdnr, 'cdnur': cdnur, 'hsn': hsn},
        'summary': [summarize('B2B Invoices - 4A, 4B, 4C, 6B, 6C', b2b), summarize('B2C (Large) Invoices - 5A, 5B', b2cl),
                    summarize('B2C (Small) Details - 7', list(b2cs_grouped.values()), 'rows'),
                    summarize('Credit/Debit Notes (Registered) - 9B', cdnr), summarize('Credit/Debit Notes (Unregistered) - 9B', cdnur),
                    {'section': 'HSN-wise Summary - 12', 'count': len(hsn), 'taxable': sm(hsn, 'taxable'), 'igst': sm(hsn, 'igst'), 'cgst': sm(hsn, 'cgst'),
                     'sgst': sm(hsn, 'sgst'), 'cess': sm(hsn, 'cess')}],
        'tabs': {
            'b2b': {'title': 'B2B', 'columns': doc_cols('Customer'), 'rows': b2b_rows, 'totals': totals_of(b2b_rows)},
            'b2c': {'title': 'B2C', 'columns': [col('type', 'Type'), *doc_cols('Customer')], 'rows': b2c_rows, 'totals': totals_of(b2c_rows)},
            'cdnr': {'title': 'CDNR', 'columns': [col('type', 'Type'), *doc_cols('Customer')], 'rows': cdn_rows, 'totals': totals_of(cdn_rows)},
            'hsn': {'title': 'HSN', 'columns': HSN_COLS, 'rows': hsn, 'totals': {'taxable': sm(hsn, 'taxable'), 'igst': sm(hsn, 'igst'), 'cgst': sm(hsn, 'cgst'),
                                                                                  'sgst': sm(hsn, 'sgst'), 'cess': sm(hsn, 'cess'), 'total': sm(hsn, 'total')}},
        },
        'b2b_taxable': sm(b2b_rows, 'taxable'),
    }


def gstr1_json(org, frm, to):
    g = gstr1(org, frm, to)

    def itms(d):
        return [{'num': n + 1, 'txval': i['txval'], 'rt': i['rt'], 'iamt': i['iamt'], 'camt': i['camt'], 'samt': i['samt'], 'csamt': i['csamt']} for n, i in enumerate(d['items'])]

    def group_by(lst, key):
        m = {}
        for d in lst:
            m.setdefault(key(d), []).append(d)
        return m.items()

    return {
        'gstin': org.get('gstin') or '', 'fp': f'{to[5:7]}{to[0:4]}', 'gt': 0, 'cur_gt': 0,
        'b2b': [{'ctin': ctin, 'inv': [{'inum': d['number'], 'idt': ddmmyyyy(d['date']), 'val': d['value'], 'pos': d['pos'], 'rchrg': 'N', 'inv_typ': 'R', 'itms': itms(d)} for d in lst]}
                for ctin, lst in group_by(g['docs']['b2b'], lambda d: _s(d['gstin']).upper())],
        'b2cl': [{'pos': pos, 'inv': [{'inum': d['number'], 'idt': ddmmyyyy(d['date']), 'val': d['value'], 'itms': itms(d)} for d in lst]}
                 for pos, lst in group_by(g['docs']['b2cl'], lambda d: d['pos'])],
        'b2cs': [{'sply_ty': x['sply_ty'], 'pos': x['pos'], 'typ': 'OE', 'rt': x['rate'], 'txval': x['taxable'], 'iamt': x['igst'], 'camt': x['cgst'], 'samt': x['sgst'], 'csamt': x['cess']}
                 for x in g['docs']['b2cs']],
        'cdnr': [{'ctin': ctin, 'nt': [{'ntty': 'C', 'nt_num': d['number'], 'nt_dt': ddmmyyyy(d['date']), 'val': d['value'], 'pos': d['pos'], 'rchrg': 'N', 'inv_typ': 'R', 'itms': itms(d)}
                                       for d in lst]}
                 for ctin, lst in group_by(g['docs']['cdnr'], lambda d: _s(d['gstin']).upper())],
        'cdnur': [{'ntty': 'C', 'nt_num': d['number'], 'nt_dt': ddmmyyyy(d['date']), 'val': d['value'], 'typ': 'B2CL' if d['inter'] else 'B2CS', 'pos': d['pos'], 'itms': itms(d)}
                  for d in g['docs']['cdnur']],
        'hsn': {'data': [{'num': n + 1, 'hsn_sc': '' if x['hsn'] == '—' else x['hsn'], 'desc': x['description'] or '', 'uqc': x['uqc'], 'qty': x['qty'], 'rt': x['rate'],
                          'txval': x['taxable'], 'iamt': x['igst'], 'camt': x['cgst'], 'samt': x['sgst'], 'csamt': x['cess'], 'val': x['total']}
                         for n, x in enumerate(g['docs']['hsn'])]},
    }


def rpt_gstr1(req):
    p = params(req)
    if p['q'].get('format') == 'json':
        return gstr1_json(p['org'], p['from'], p['to'])
    g = gstr1(p['org'], p['from'], p['to'])
    return {**head('GSTR-1 Summary', p, {'gstin': p['org'].get('gstin') or ''}),
            'columns': [col('section', 'Section'), col('count', 'Count', 'num'), col('taxable', 'Taxable Value', 'money'), col('igst', 'IGST', 'money'),
                        col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('cess', 'Cess', 'money')],
            'rows': g['summary'], 'tabs': g['tabs'], 'b2b_taxable': g['b2b_taxable']}


def rpt_gstr3b(req):
    p = params(req)
    docs = gst_docs(p['org'], p['from'], p['to'], ['invoice', 'salesreceipt', 'creditnote'])

    def blank():
        return {'taxable': 0, 'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0}

    taxable, zero, nil = blank(), blank(), blank()
    for d in docs:
        s = -1 if d['doc_type'] == 'creditnote' else 1
        exportish = d['gst_treatment'] in ('overseas', 'sez')
        for l in d['lines']:
            t = zero if exportish else taxable if l['rate'] > 0 else nil
            t['taxable'] = r2(t['taxable'] + s * l['taxable'])
            for c in ('igst', 'cgst', 'sgst', 'cess'):
                t[c] = r2(t[c] + s * l[c])
    itc = {'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0}
    for r in all('''SELECT a.system_code, SUM(l.debit - l.credit) AS amt FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.system_code IN ('input_igst','input_cgst','input_sgst','input_tax') AND l.date >= ? AND l.date <= ? GROUP BY a.system_code
    ORDER BY a.system_code COLLATE "C"''', p['org']['id'], p['from'], p['to']):
        itc[{'input_igst': 'igst', 'input_cgst': 'cgst', 'input_sgst': 'sgst', 'input_tax': 'cess'}[r['system_code']]] = r2(r['amt'])
    out_tax = {'igst': r2(taxable['igst'] + zero['igst']), 'cgst': r2(taxable['cgst'] + zero['cgst']), 'sgst': r2(taxable['sgst'] + zero['sgst']), 'cess': r2(taxable['cess'] + zero['cess'])}
    net = {k: r2(out_tax[k] - itc[k]) for k in itc}
    rows = [
        {'name': '3.1 Details of Outward Supplies and inward supplies liable to reverse charge', '_kind': 'section'},
        {'name': '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', **taxable, '_indent': 1},
        {'name': '(b) Outward taxable supplies (zero rated)', **zero, '_indent': 1},
        {'name': '(c) Other outward supplies (nil rated, exempted)', **nil, '_indent': 1},
        {'name': '(d) Inward supplies (liable to reverse charge)', **blank(), '_indent': 1},
        {'name': '(e) Non-GST outward supplies', **blank(), '_indent': 1},
        {'name': '4. Eligible ITC', '_kind': 'section'},
        {'name': '(A) ITC Available - (5) All other ITC', 'taxable': None, **itc, '_indent': 1},
        {'name': '(B) ITC Reversed', 'taxable': None, 'igst': 0, 'cgst': 0, 'sgst': 0, 'cess': 0, '_indent': 1},
        {'name': '(C) Net ITC Available (A) - (B)', 'taxable': None, **itc, '_kind': 'total'},
        {'name': 'Net Tax Payable (Output tax - Net ITC)', 'taxable': None, **net, '_kind': 'grand'},
    ]
    return {**head('GSTR-3B Summary', p, {'gstin': p['org'].get('gstin') or ''}),
            'columns': [col('name', 'Nature of Supplies'), col('taxable', 'Total Taxable Value', 'money'), col('igst', 'Integrated Tax', 'money'),
                        col('cgst', 'Central Tax', 'money'), col('sgst', 'State/UT Tax', 'money'), col('cess', 'Cess', 'money')],
            'rows': rows, 'outward': taxable, 'zero_rated': zero, 'nil_rated': nil, 'itc': itc, 'net_payable': net}


def rpt_hsn_summary(req):
    p = params(req)
    rows = hsn_summary(p['org'], p['from'], p['to'])

    def sm(k):
        return r2(sum_js(x[k] for x in rows))

    return {**head('HSN Summary', p), 'columns': HSN_COLS, 'rows': rows,
            'totals': {'taxable': sm('taxable'), 'igst': sm('igst'), 'cgst': sm('cgst'), 'sgst': sm('sgst'), 'cess': sm('cess'), 'total': sm('total')}}


# ---------------- activity / projects / budgets ----------------
def rpt_audit_trail(req):
    p = params(req)
    where = ['a.org_id = ?', 'substr(a.created_at, 1, 10) >= ?', 'substr(a.created_at, 1, 10) <= ?']
    args = [p['org']['id'], p['from'], p['to']]
    if truthy(p['q'].get('entity_type')):
        where.append('a.entity_type = ?')
        args.append(p['q'].get('entity_type'))
    if truthy(p['q'].get('user_id')):
        where.append('a.user_id = ?')
        args.append(num_or_none(p['q'].get('user_id')))
    rows = []
    for r in all(f'''SELECT a.id, a.created_at, a.user_id, u.name AS user_name, a.entity_type, a.entity_id, a.action, a.detail,
      d.doc_type, d.id AS doc_id, d.number
    FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN documents d ON a.entity_type = 'document' AND d.id = a.entity_id AND d.org_id = a.org_id
    WHERE {' AND '.join(where)} ORDER BY a.id DESC LIMIT 2000''', *args):
        x = {**r, 'entity': r['number'] if truthy(r['number']) else
             f"{_s(r['entity_type']) if truthy(r['entity_type']) else ''} #{_s(r['entity_id']) if r['entity_id'] is not None else ''}"}
        if r['entity_type'] == 'expense':
            x['expense_id'] = r['entity_id']
        if r['entity_type'] == 'journal':
            x['journal_id'] = r['entity_id']
        rows.append(x)
    return {**head('Activity Logs & Audit Trail', p),
            'columns': [col('created_at', 'Date & Time', 'datetime'), col('user_name', 'User'), col('entity_type', 'Module'), col('entity', 'Transaction', 'doc'),
                        col('action', 'Action'), col('detail', 'Details')], 'rows': rows}


def project_basics():
    if not table_exists('projects') or not table_exists('time_entries'):
        return None
    pc = column_names('projects')
    tc = column_names('time_entries')
    hours = ('t.minutes / 60.0::double precision' if 'minutes' in tc else 't.hours' if 'hours' in tc
             else 't.duration_minutes / 60.0::double precision' if 'duration_minutes' in tc else '0')
    # SQLite treated integers as booleans; PostgreSQL needs explicit predicates
    billable = '(t.billable <> 0)' if 'billable' in tc else '(t.is_billable <> 0)' if 'is_billable' in tc else 'TRUE'
    invoiced = 't.invoice_id IS NOT NULL' if 'invoice_id' in tc else 'FALSE'
    customer = 'pr.customer_id' if 'customer_id' in pc else 'pr.contact_id' if 'contact_id' in pc else 'NULL'
    return {'pc': pc, 'tc': tc, 'hours': hours, 'billable': billable, 'invoiced': invoiced, 'customer': customer}


def _attempt(fn):
    """try { fn() } catch (e): run inside a savepoint so a failed statement doesn't poison the transaction."""
    try:
        with transaction.atomic():
            return fn(), None
    except Exception as e:  # noqa: BLE001
        return None, e


def rpt_time_by_project(req):
    p = params(req)
    columns = [col('name', 'Project Name'), col('customer_name', 'Customer', 'contact'), col('hours', 'Logged Hours', 'num'), col('billable_hours', 'Billable Hours', 'num'),
               col('billed_hours', 'Billed Hours', 'num'), col('unbilled_hours', 'Unbilled Hours', 'num'), col('non_billable_hours', 'Non-billable Hours', 'num')]
    b = project_basics()
    if not b:
        return {**head('Time by Project', p), 'columns': columns, 'rows': [], 'message': 'Projects and timesheets are not set up.'}

    def run():
        rows = [{**r, 'hours': r2(r['hours']), 'billable_hours': r2(r['billable_hours']), 'billed_hours': r2(r['billed_hours']),
                 'unbilled_hours': r2(_n(r['billable_hours']) - _n(r['billed_hours'])), 'non_billable_hours': r2(_n(r['hours']) - _n(r['billable_hours']))}
                for r in all(f'''SELECT pr.id AS project_id, pr.name, {b['customer']} AS contact_id, c.display_name AS customer_name,
        SUM({b['hours']}) AS hours, SUM(CASE WHEN {b['billable']} THEN {b['hours']} ELSE 0 END) AS billable_hours,
        SUM(CASE WHEN {b['billable']} AND {b['invoiced']} THEN {b['hours']} ELSE 0 END) AS billed_hours
      FROM time_entries t JOIN projects pr ON pr.id = t.project_id LEFT JOIN contacts c ON c.id = {b['customer']}
      WHERE t.org_id = ? AND t.date >= ? AND t.date <= ? GROUP BY pr.id, c.id ORDER BY pr.name COLLATE "C", pr.id''', p['org']['id'], p['from'], p['to'])]

        def sm(k):
            return r2(sum_js(r[k] for r in rows))

        return {**head('Time by Project', p), 'columns': columns, 'rows': rows,
                'totals': {'name': 'Total', 'hours': sm('hours'), 'billable_hours': sm('billable_hours'), 'billed_hours': sm('billed_hours'),
                           'unbilled_hours': sm('unbilled_hours'), 'non_billable_hours': sm('non_billable_hours')}}

    res, err = _attempt(run)
    if err is not None:
        return {**head('Time by Project', p), 'columns': columns, 'rows': [], 'message': f'Could not read timesheets: {err}'}
    return res


def rpt_project_profitability(req):
    p = params(req)
    columns = [col('name', 'Project Name'), col('customer_name', 'Customer', 'contact'), col('revenue', 'Revenue', 'money'), col('expense_cost', 'Expenses & Bills', 'money'),
               col('time_cost', 'Labour Cost', 'money'), col('cost', 'Total Cost', 'money'), col('profit', 'Profit', 'money'), col('margin', 'Margin', 'pct')]
    b = project_basics()
    if not b:
        return {**head('Project Profitability', p), 'columns': columns, 'rows': [], 'message': 'Projects are not set up.'}
    org_id = p['org']['id']

    def run():
        projects = all(f'''SELECT pr.*, {b['customer']} AS contact_id, c.display_name AS customer_name FROM projects pr LEFT JOIN contacts c ON c.id = {b['customer']}
      WHERE pr.org_id = ? ORDER BY pr.name COLLATE "C", pr.id''', org_id)
        rev = {r['pid']: r['amt'] for r in all(f'''SELECT COALESCE(l.project_id, d.project_id) AS pid, SUM(CASE WHEN d.doc_type = 'creditnote' THEN -1 ELSE 1 END * l.taxable * {DOC_FX}) AS amt
      FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE d.org_id = ? AND d.doc_type IN ('invoice','salesreceipt','creditnote') AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ? AND COALESCE(l.project_id, d.project_id) IS NOT NULL
      GROUP BY 1''', org_id, p['from'], p['to'])}
        bills = {r['pid']: r['amt'] for r in all(f'''SELECT COALESCE(l.project_id, d.project_id) AS pid, SUM(CASE WHEN d.doc_type = 'vendorcredit' THEN -1 ELSE 1 END * l.taxable * {DOC_FX}) AS amt
      FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE d.org_id = ? AND d.doc_type IN ('bill','vendorcredit') AND d.status IN {LIVE} AND d.date >= ? AND d.date <= ? AND COALESCE(l.project_id, d.project_id) IS NOT NULL
      GROUP BY 1''', org_id, p['from'], p['to'])}
        exps = {r['pid']: r['amt'] for r in all('''SELECT project_id AS pid, SUM((total - tax_amount) * COALESCE(exchange_rate,1)) AS amt FROM expenses
      WHERE org_id = ? AND is_profile = 0 AND project_id IS NOT NULL AND date >= ? AND date <= ? GROUP BY project_id''', org_id, p['from'], p['to'])}
        has_user = 'user_id' in b['tc']
        time = all(f'''SELECT t.project_id AS pid, {'t.user_id' if has_user else 'NULL'} AS user_id, SUM({b['hours']}) AS hours FROM time_entries t
      WHERE t.org_id = ? AND t.date >= ? AND t.date <= ? GROUP BY 1, 2 ORDER BY 1, 2 NULLS FIRST''', org_id, p['from'], p['to'])
        rows = []
        for pr in projects:
            try:
                users = json.loads(pr.get('users') or '[]') or []
            except (ValueError, TypeError):
                users = []
            if not isinstance(users, list):
                raise TypeError('users.find is not a function')
            time_cost = 0
            for t in time:
                if t['pid'] != pr['id']:
                    continue
                u = next((u for u in users if isinstance(u, dict) and u.get('user_id') == t['user_id'] and type(u.get('user_id')) is not bool), None)
                time_cost = time_cost + _n(t['hours']) * jsnum((u or {}).get('cost_rate'))
            revenue = r2(rev.get(pr['id']))
            expense_cost = r2((bills.get(pr['id']) or 0) + (exps.get(pr['id']) or 0))
            tcost = r2(time_cost)
            cost = r2(expense_cost + tcost)
            profit = r2(revenue - cost)
            rows.append({'project_id': pr['id'], 'name': pr['name'], 'contact_id': pr['contact_id'], 'customer_name': pr['customer_name'], 'revenue': revenue,
                         'expense_cost': expense_cost, 'time_cost': tcost, 'cost': cost, 'profit': profit, 'margin': r2((profit / revenue) * 100) if revenue else 0})

        def sm(k):
            return r2(sum_js(r[k] for r in rows))

        return {**head('Project Profitability', p), 'columns': columns, 'rows': rows,
                'totals': {'name': 'Total', 'revenue': sm('revenue'), 'expense_cost': sm('expense_cost'), 'time_cost': sm('time_cost'), 'cost': sm('cost'), 'profit': sm('profit')}}

    res, err = _attempt(run)
    if err is not None:
        return {**head('Project Profitability', p), 'columns': columns, 'rows': [], 'message': f'Could not read projects: {err}'}
    return res


_ARRAY_INDEX = re.compile(r'0|[1-9][0-9]*')


def _js_keys(obj):
    """Object.keys order: array-index keys ascending, then the other keys in insertion order."""
    keys = list(obj.keys())
    idx = sorted((k for k in keys if _ARRAY_INDEX.fullmatch(k) and int(k) < 4294967295), key=int)
    rest = [k for k in keys if not (_ARRAY_INDEX.fullmatch(k) and int(k) < 4294967295)]
    return idx + rest


def rpt_budget_vs_actual(req):
    p = params(req)
    base = {**head('Budget vs Actuals', p), 'columns': [col('name', 'Account', 'account')], 'rows': [], 'budgets': []}
    if not table_exists('budgets'):
        return {**base, 'message': 'Budgets are not set up.'}
    bc = column_names('budgets')
    if not all_(c in bc for c in ['lines', 'name']):
        return {**base, 'message': 'Budgets are not set up.'}
    org_id = p['org']['id']
    budgets = all(f'''SELECT id, name, {'fiscal_year' if 'fiscal_year' in bc else 'NULL AS fiscal_year'}, {'period' if 'period' in bc else "'yearly' AS period"}
      FROM budgets WHERE org_id = ? ORDER BY id DESC''', org_id)
    bid = jsnum(p['q'].get('budget_id')) or (budgets[0]['id'] if budgets else None)
    bgt = get('SELECT * FROM budgets WHERE id = ? AND org_id = ?', bid, org_id) if truthy(bid) else None
    if not bgt:
        return {**base, 'budgets': budgets, 'message': 'Choose a budget.' if budgets else 'No budgets have been created yet.'}
    try:
        lines = json.loads(bgt.get('lines') or '{}') or {}
    except (ValueError, TypeError):
        lines = {}
    if isinstance(lines, list):
        lines = {str(i): v for i, v in enumerate(lines)}
    elif not isinstance(lines, dict):
        lines = {}
    fs = jsnum(p['org'].get('fiscal_year_start'), 1)
    fy_year = jsnum(bgt.get('fiscal_year')) or jsnum(fy_start_of(p['org'], today())[0:4])
    per = {'monthly': [12, 1], 'quarterly': [4, 3], 'yearly': [1, 12]}.get(bgt.get('period')) or [12, 1]
    start = f'{jsstr(fy_year)}-{pad(fs)}-01'
    periods = []
    for i in range(per[0]):
        s = first_of_month(start, i * per[1])
        e = end_of_month(first_of_month(start, (i + 1) * per[1] - 1))
        if per[1] == 1:
            label = month_label(s)
        elif per[1] == 3:
            label = f'Q{i + 1} ({_mon(s[5:7])}-{_mon(e[5:7])})'
        else:
            label = f'FY {jsstr(fy_year)}-{jsstr(fy_year + 1)[2:]}'
        periods.append({'from': s, 'to': e, 'label': label})
    fy_end = periods[-1]['to']
    ids = []
    for k in _js_keys(lines):
        n = num_or_none(k) if k.strip() != '' else 0
        if n is not None and n != 0:
            ids.append((n, k))
    accounts = {a['id']: a for a in all('SELECT id, name, code, type FROM accounts WHERE org_id = ? ORDER BY id', org_id)}
    actual_rows = all('''SELECT l.account_id, substr(l.date, 1, 7) AS ym, SUM(l.debit) AS d, SUM(l.credit) AS c FROM ledger l
    WHERE l.org_id = ? AND l.date >= ? AND l.date <= ? GROUP BY l.account_id, ym ORDER BY l.account_id, ym''', org_id, start, fy_end)

    def actual_of(aid, period):
        a = accounts[aid]
        return r2(sum_js(natural(a['type'], x['d'], x['c']) for x in actual_rows
                         if x['account_id'] == aid and x['ym'] >= period['from'][0:7] and x['ym'] <= period['to'][0:7]))

    rows_by = {'income': [], 'expense': [], 'other': []}
    for aid, _key in ids:
        a = accounts.get(aid)
        if not a:
            continue
        val = lines.get(jsstr(aid))
        amounts = val if isinstance(val, list) else [val]
        r = {'account_id': aid, 'name': a['name'], 'code': a['code'], '_indent': 1}
        tb = 0
        ta = 0
        for i, pd in enumerate(periods):
            bv = r2(jsnum(amounts[i] if i < len(amounts) else None))
            av = actual_of(aid, pd)
            r[f'b{i}'] = bv
            r[f'a{i}'] = av
            tb += bv
            ta += av
        r['budget'] = r2(tb)
        r['actual'] = r2(ta)
        r['variance'] = r2(ta - tb)
        r['variance_pct'] = r2(((ta - tb) / tb) * 100) if tb else 0
        cls = ACCOUNT_CLASS.get(a['type'])
        rows_by['income' if cls == 'income' else 'expense' if cls == 'expense' else 'other'].append(r)
    columns = [col('name', 'Account', 'account')]
    for i, pd in enumerate(periods):
        columns.append(col(f'b{i}', f"{pd['label']} Budget", 'money'))
        columns.append(col(f'a{i}', f"{pd['label']} Actual", 'money'))
    columns.extend([col('budget', 'Total Budget', 'money'), col('actual', 'Total Actual', 'money'), col('variance', 'Variance', 'money'), col('variance_pct', 'Variance %', 'pct')])
    keys = [c['key'] for c in columns[1:] if c['key'] != 'variance_pct']

    def total_of(lst, name):
        return {'name': name, '_kind': 'total', **{k: r2(sum_js((r.get(k) or 0) for r in lst)) for k in keys}}

    rows = []
    for k, label in [['income', 'Income'], ['expense', 'Expense'], ['other', 'Other Accounts']]:
        if not rows_by[k]:
            continue
        rows.extend([{'name': label, '_kind': 'section'}, *rows_by[k], total_of(rows_by[k], f'Total {label}')])
    if rows_by['income'] or rows_by['expense']:
        ti = total_of(rows_by['income'], '')
        te = total_of(rows_by['expense'], '')
        rows.append({'name': 'Net Profit/Loss', '_kind': 'grand', **{k: r2((ti.get(k) or 0) - (te.get(k) or 0)) for k in keys}})
    return {**head(f"Budget vs Actuals: {_s(bgt.get('name'))}", {**p, 'from': start, 'to': fy_end}),
            'budget': {'id': bgt['id'], 'name': bgt.get('name'), 'fiscal_year': fy_year, 'period': bgt.get('period')}, 'budgets': budgets, 'periods': periods,
            'columns': columns, 'rows': rows}


def all_(it):
    for x in it:
        if not x:
            return False
    return True


# ---------------- dashboard ----------------
_CARD_BUCKET = {'d1_15': '1-15', 'd16_30': '16-30', 'd31_45': '31-45', 'gt45': '>45'}


def aging_card(org_id, doc_type, as_of):
    docs = open_docs_as_of(org_id, doc_type, as_of)
    buckets = {'1-15': 0, '16-30': 0, '31-45': 0, '>45': 0}
    current = 0
    overdue = 0
    for d in docs:
        b = bucket_of(as_of, d['due_date'])[0]
        if b == 'current':
            current += d['bal_base']
        else:
            overdue += d['bal_base']
            buckets[_CARD_BUCKET[b]] += d['bal_base']
    for k in list(buckets.keys()):
        buckets[k] = r2(buckets[k])
    return {'total': r2(current + overdue), 'current': r2(current), 'overdue': r2(overdue), 'buckets': buckets, 'count': len(docs)}


def dashboard(req):
    org = req.org
    org_id = org['id']
    now = today()
    qy = req.query
    basis = 'cash' if qy.get('basis') == 'cash' else 'accrual'
    fy = fy_start_of(org, now)
    frm = qy.get('from') if is_iso(qy.get('from')) else fy
    to = qy.get('to') if is_iso(qy.get('to')) else end_of_month(first_of_month(fy, 11))
    if frm > to:
        frm, to = to, frm
    months = months_in(frm, to)[:24]
    last_end = end_of_month(months[-1])

    # cash flow (cash + bank accounts)
    opening = r2(get(f'''SELECT COALESCE(SUM(l.debit - l.credit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.type IN ({q(CASH_TYPES)}) AND l.date < ?''', org_id, months[0])['s'])
    flows = {r['ym']: r for r in all(f'''SELECT substr(l.date, 1, 7) AS ym, SUM(l.debit) AS inc, SUM(l.credit) AS outg FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.type IN ({q(CASH_TYPES)}) AND l.date >= ? AND l.date <= ? GROUP BY ym ORDER BY ym''', org_id, months[0], last_end)}
    run = opening
    cash_flow = []
    for m in months:
        f = flows.get(m[0:7]) or {'inc': 0, 'outg': 0}
        run = r2(run + _n(f['inc']) - _n(f['outg']))
        cash_flow.append({'month': m[0:7], 'label': month_label(m), 'incoming': r2(f['inc']), 'outgoing': r2(f['outg']), 'closing': run})

    # income & expense per month
    if basis == 'accrual':
        rows = all(f'''SELECT substr(l.date, 1, 7) AS ym, a.type, SUM(l.credit - l.debit) AS net FROM ledger l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = ? AND a.type IN ({q(PL_TYPES)}) AND l.date >= ? AND l.date <= ? GROUP BY ym, a.type ORDER BY ym, a.type COLLATE "C"''',
                   org_id, months[0], last_end)
        income_expense = []
        for m in months:
            ym = m[0:7]
            rs = [r for r in rows if r['ym'] == ym]
            income_expense.append({'month': ym, 'label': month_label(m),
                                   'income': r2(sum_js(r['net'] for r in rs if r['type'] in INCOME_TYPES)),
                                   'expense': r2(0 - sum_js(r['net'] for r in rs if r['type'] in EXPENSE_TYPES))})
    else:
        income_expense = [{'month': m[0:7], 'label': month_label(m), **income_expense_totals(org_id, m, end_of_month(m), 'cash')} for m in months]

    top_expenses = [{**r, 'amount': r2(r['amount'])} for r in all(
        f'''SELECT a.id AS account_id, a.name AS account, SUM(l.debit - l.credit) AS amount FROM ledger l JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ? AND a.type IN ({q(EXPENSE_TYPES)}) AND l.date >= ? AND l.date <= ? GROUP BY a.id HAVING SUM(l.debit - l.credit) > 0.004
    ORDER BY amount DESC, a.id LIMIT 10''', org_id, fy, now)]

    def with_bal(where, *args):
        out = []
        for r in all(f'''SELECT a.id, a.name, a.code, a.type, a.bank_name, a.account_number, COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c
      FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id AND l.org_id = a.org_id WHERE a.org_id = ? AND {where} GROUP BY a.id
      ORDER BY a.type COLLATE "C", a.name COLLATE "C", a.id''', org_id, *args):
            d, c = r.pop('d'), r.pop('c')
            out.append({**r, **_type_label(r['type']), 'balance': natural(r['type'], d, c)})
        return out

    bank_accounts = with_bal("a.type IN ('bank','credit_card') AND a.is_active = 1")
    watchlist = with_bal('a.watchlist = 1')

    def n(sql, *args):
        return get(sql, *args)['n']

    overdue_inv = len([d for d in all(f"SELECT due_date, balance FROM documents WHERE org_id = ? AND doc_type = 'invoice' AND status IN {LIVE} AND balance > 0.004", org_id)
                       if truthy(d['due_date']) and d['due_date'] < now])
    counts = {
        'draft_invoices': n("SELECT COUNT(*) n FROM documents WHERE org_id = ? AND doc_type = 'invoice' AND status = 'draft'", org_id),
        'pending_approvals': n("SELECT COUNT(*) n FROM documents WHERE org_id = ? AND status = 'pending_approval'", org_id),
        'overdue_invoices': overdue_inv,
        'unpaid_bills': n(f"SELECT COUNT(*) n FROM documents WHERE org_id = ? AND doc_type = 'bill' AND status IN {LIVE} AND balance > 0.004", org_id),
        'open_sales_orders': n("SELECT COUNT(*) n FROM documents WHERE org_id = ? AND doc_type = 'salesorder' AND status = 'open'", org_id),
        'unbilled_expenses': n('SELECT COUNT(*) n FROM expenses WHERE org_id = ? AND is_profile = 0 AND is_billable = 1 AND invoice_id IS NULL', org_id),
    }
    ms = first_of_month(now)
    sales_this_month = r2(get(f'''SELECT COALESCE(SUM(CASE WHEN doc_type = 'creditnote' THEN -1 ELSE 1 END * total * COALESCE(exchange_rate,1)),0) s FROM documents
    WHERE org_id = ? AND doc_type IN ('invoice','salesreceipt','creditnote') AND status IN {LIVE} AND date >= ? AND date <= ?''', org_id, ms, end_of_month(ms))['s'])

    def proj():
        b = project_basics()
        if not b:
            return None
        has_status = 'status' in b['pc']
        return {
            'active': n('SELECT COUNT(*) n FROM projects WHERE org_id = ? ' + ("AND status = 'active'" if has_status else ''), org_id),
            'unbilled_hours': r2(get(f"SELECT COALESCE(SUM({b['hours']}),0) n FROM time_entries t WHERE t.org_id = ? AND {b['billable']} AND NOT ({b['invoiced']})", org_id)['n']),
            'hours_this_month': r2(get(f"SELECT COALESCE(SUM({b['hours']}),0) n FROM time_entries t WHERE t.org_id = ? AND t.date >= ? AND t.date <= ?", org_id, ms, end_of_month(ms))['n']),
        }

    projects, err = _attempt(proj)
    if err is not None or not can(req, 'projects', 'view'):
        projects = None

    if not can(req, 'reports', 'view'):
        # The dashboard is everyone's home page, but its figures are report data: members without reports:view
        # get the same shape with the financial sections left empty.
        empty_card = {'total': 0, 'current': 0, 'overdue': 0, 'buckets': {'1-15': 0, '16-30': 0, '31-45': 0, '>45': 0}, 'count': 0}
        return {
            'title': 'Dashboard', 'from': frm, 'to': to, 'basis': basis, 'fiscal_year_start': fy, 'as_of': now, 'restricted': True,
            'receivables': empty_card, 'payables': empty_card, 'cash_flow': [], 'cash_opening': 0, 'income_expense': [],
            'income_expense_totals': {'income': 0, 'expense': 0}, 'top_expenses': [], 'bank_accounts': [], 'watchlist': [],
            'counts': {k: 0 for k in counts}, 'sales_this_month': 0, 'projects': projects,
        }

    return {
        'title': 'Dashboard', 'from': frm, 'to': to, 'basis': basis, 'fiscal_year_start': fy, 'as_of': now,
        'receivables': aging_card(org_id, 'invoice', now), 'payables': aging_card(org_id, 'bill', now),
        'cash_flow': cash_flow, 'cash_opening': opening, 'income_expense': income_expense,
        'income_expense_totals': {'income': r2(sum_js(r['income'] for r in income_expense)), 'expense': r2(sum_js(r['expense'] for r in income_expense))},
        'top_expenses': top_expenses, 'bank_accounts': bank_accounts, 'watchlist': watchlist, 'counts': counts, 'sales_this_month': sales_this_month, 'projects': projects,
    }


# ---------------- registry & routes ----------------
REPORTS = {
    'profit-loss': rpt_profit_loss,
    'balance-sheet': rpt_balance_sheet,
    'cash-flow': rpt_cash_flow,
    'trial-balance': rpt_trial_balance,
    'general-ledger': rpt_general_ledger,
    'account-transactions': rpt_account_transactions,
    'journal': rpt_journal,
    'day-book': rpt_day_book,
    'account-type-summary': rpt_account_type_summary,
    'sales-by-customer': lambda req: by_contact(req, 'sales'),
    'sales-by-item': lambda req: by_item(req, 'sales'),
    'sales-by-salesperson': rpt_sales_by_salesperson,
    'ar-aging-summary': lambda req: aging_summary(req, 'sales'),
    'ar-aging-details': lambda req: aging_details(req, 'sales'),
    'customer-balances': lambda req: contact_balances(req, 'sales'),
    'invoice-details': lambda req: doc_details(req, 'invoice', 'Invoice Details'),
    'quote-details': lambda req: doc_details(req, 'quote', 'Quote Details'),
    'salesorder-details': lambda req: doc_details(req, 'salesorder', 'Sales Order Details'),
    'creditnote-details': lambda req: doc_details(req, 'creditnote', 'Credit Note Details'),
    'salesreceipt-details': lambda req: doc_details(req, 'salesreceipt', 'Sales Receipt Details'),
    'refund-history': rpt_refund_history,
    'time-to-get-paid': rpt_time_to_get_paid,
    'payments-received': lambda req: payments_report(req, 'received'),
    'purchases-by-vendor': lambda req: by_contact(req, 'purchase'),
    'purchases-by-item': lambda req: by_item(req, 'purchase'),
    'ap-aging-summary': lambda req: aging_summary(req, 'purchase'),
    'ap-aging-details': lambda req: aging_details(req, 'purchase'),
    'vendor-balances': lambda req: contact_balances(req, 'purchase'),
    'bill-details': lambda req: doc_details(req, 'bill', 'Bill Details'),
    'purchaseorder-details': lambda req: doc_details(req, 'purchaseorder', 'Purchase Order Details'),
    'payments-made': lambda req: payments_report(req, 'made'),
    'vendor-credit-details': lambda req: doc_details(req, 'vendorcredit', 'Vendor Credit Details'),
    'expense-details': rpt_expense_details,
    'expenses-by-category': rpt_expenses_by_category,
    'billable-expenses': rpt_billable_expenses,
    'inventory-summary': rpt_inventory_summary,
    'inventory-valuation': rpt_inventory_valuation,
    'stock-aging': rpt_stock_aging,
    'committed-stock': rpt_committed_stock,
    'tax-summary': rpt_tax_summary,
    'gstr1': rpt_gstr1,
    'gstr3b': rpt_gstr3b,
    'hsn-summary': rpt_hsn_summary,
    'audit-trail': rpt_audit_trail,
    'time-by-project': rpt_time_by_project,
    'project-profitability': rpt_project_profitability,
    'budget-vs-actual': rpt_budget_vs_actual,
}


def _gstr1_json_route(req):
    p = params(req)
    return gstr1_json(p['org'], p['from'], p['to'])


def _report(req):
    fn = REPORTS.get(req.params.get('name'))
    if not fn:
        # Express next(): no other module defines /reports/*, so this falls through to the API 404
        raise HttpError(404, 'Not found')
    return fn(req)


def routes(r):
    r.get('/dashboard', dashboard)
    r.get('/reports', perm('reports', 'view'), lambda req: {'reports': list(REPORTS.keys())})
    r.get('/reports/gstr1/json', perm('reports', 'view'), _gstr1_json_route)
    r.get('/reports/:name', perm('reports', 'view'), _report)
