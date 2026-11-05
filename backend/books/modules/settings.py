"""Settings area: users & roles, currencies, payment terms, taxes & GST, custom fields,
opening balances, data backup/export and payment reminders (port of modules/settings.js).

Text ORDER BY keys use COLLATE "C" (and NULLS FIRST where the key may be NULL) to keep SQLite's BINARY ordering.
"""
import json
import math
import os
import re

from django.http import HttpResponse

from books.core.db import all, get, run, insert, update, tx, parse_json
from books.core.router import bad, not_found, forbidden, json_response, API_LOCK
from books.core.util import audit, today, token, org_settings, round2, assert_unlocked
from books.core.auth import perm, can, MODULES, ACTIONS, hash_password
from books.core.jsutil import jsstr, now_iso, truthy
from books.core.ledger import post, sys_account, account_class, balances_by_account, assert_source_unlocked
from books.core.documents import load_doc, display_status
from books.core.mailer import send_email, fill_template, DEFAULT_TEMPLATES, check_send_quota
from books.core.calc import INDIAN_STATES, add_days, sum_js

# ---------------------------------------------------------------- JS semantics helpers
UNDEF = object()  # `undefined` (a missing key), as opposed to null (None)
JS_WS = '\t\n\v\f\r                  　﻿'
_NUM_RE = re.compile(r'[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)')


def bget(o, k):
    """o[k] in JS: UNDEF when o is not an object or k is missing."""
    return o.get(k, UNDEF) if isinstance(o, dict) else UNDEF


def jt(v):
    """JS truthiness where UNDEF (undefined) is falsy."""
    return v is not UNDEF and truthy(v)


def js_string(v):
    """String(v)."""
    if v is UNDEF:
        return 'undefined'
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ','.join('' if x is None or x is UNDEF else js_string(x) for x in v)
    if isinstance(v, dict):
        return '[object Object]'
    return jsstr(v)


def sstr(v):
    """str(v) helper of the JS module: null/undefined -> '', else String(v).trim()."""
    return '' if v is None or v is UNDEF else js_string(v).strip(JS_WS)


def js_number(v):
    """Number(v) (returns int/float; NaN as float('nan'))."""
    if v is UNDEF:
        return math.nan
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, (list, tuple)):
        return js_number(js_string(v))
    if isinstance(v, str):
        s = v.strip(JS_WS)
        if s == '':
            return 0
        if _NUM_RE.fullmatch(s):
            f = float(s.replace('Infinity', 'inf'))
            return int(f) if f.is_integer() else f
        for pre, base in (('0x', 16), ('0o', 8), ('0b', 2)):
            if s[:2].lower() == pre:
                try:
                    return int(s[2:], base)
                except ValueError:
                    return math.nan
        return math.nan
    return math.nan


def js_or0(v):
    """Number(v) || 0"""
    n = js_number(v)
    return 0 if (isinstance(n, float) and math.isnan(n)) or n == 0 else n


def is_finite(n):
    return isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)


def is_integer(n):
    return is_finite(n) and float(n).is_integer()


def n2i(n):
    return int(n) if isinstance(n, float) and n.is_integer() else n


def to_flag(v):
    return 1 if (v is True or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 1) or v == '1' or v == 'true') else 0


def _jsonable(v):
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        return int(v) if v.is_integer() and abs(v) < 1e21 else v
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def js_json(v):
    """JSON.stringify(v)"""
    return json.dumps(_jsonable(v), separators=(',', ':'), ensure_ascii=False)


# ---------------------------------------------------------------- constants
GSTIN_RE = re.compile(r'[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]')
EMAIL_RE = re.compile(r'[^\s@]+@[^\s@]+\.[^\s@]+')
CURRENCY_RE = re.compile(r'[A-Z]{3}')
DATE_RE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
TAX_KINDS = ['gst', 'simple', 'group']
TERM_TYPES = ['net', 'eom', 'receipt']
CF_MODULES = ['contact', 'item', 'invoice', 'quote', 'bill', 'expense', 'salesorder', 'purchaseorder']
CF_TYPES = ['text', 'number', 'date', 'dropdown', 'checkbox', 'email', 'url']
OB_BLOCKED_CODES = ['ar', 'ap', 'inventory']
OB_BLOCKED_TYPES = ['accounts_receivable', 'accounts_payable', 'stock']
CHILD_TABLES = {
    'document_lines': 'SELECT * FROM document_lines WHERE document_id IN (SELECT id FROM documents WHERE org_id = ?) ORDER BY id',
    'journal_lines': 'SELECT * FROM journal_lines WHERE journal_id IN (SELECT id FROM journals WHERE org_id = ?) ORDER BY id',
    'payment_allocations': 'SELECT * FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE org_id = ?) ORDER BY id',
}


def _body(req):
    return req.body if isinstance(req.body, dict) else {}


def slug(s):
    x = re.sub(r'[^a-z0-9]+', '_', sstr(s).lower())
    return re.sub(r'^_+|_+$', '', x)


def id_list(v):
    out = []
    for x in (v if isinstance(v, list) else []):
        n = js_number(x)
        if is_integer(n) and n > 0:
            n = int(n)
            if n not in out:
                out.append(n)
    return out


def marks(lst):
    return ','.join('?' for _ in lst)


def parse_ids(v):
    try:
        a = json.loads(v or '[]') if isinstance(v, str) else (v if truthy(v) else [])
    except ValueError:
        return []
    return [js_number(x) for x in a] if isinstance(a, list) else []


def _id(v):
    """Number(v) || 0 for ids."""
    return n2i(js_or0(v))


# ---------------------------------------------------------------- users
def member_rows(org_id):
    return all('''SELECT u.id, u.name, u.email, ou.role_id, ou.status, r.name AS role
      FROM org_users ou JOIN users u ON u.id = ou.user_id LEFT JOIN roles r ON r.id = ou.role_id
      WHERE ou.org_id = ? ORDER BY u.name COLLATE "C", u.id''', org_id)


def membership(org_id, user_id):
    return get('''SELECT ou.*, r.name AS role_name FROM org_users ou
      LEFT JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? AND ou.user_id = ?''', org_id, user_id)


def active_admins(org_id):
    return get('''SELECT COUNT(*) AS n FROM org_users ou JOIN roles r ON r.id = ou.role_id
      WHERE ou.org_id = ? AND r.name = 'Admin' AND ou.status = 'active' ''', org_id)['n']


def role_in(org_id, id):  # noqa: A002
    return get('SELECT * FROM roles WHERE id = ? AND org_id = ?', _id(id), org_id)


def _within_caller(req, perms):
    """True when every module/action in perms is already held by the caller."""
    for mod, acts in perms.items():
        for a in acts:
            if not can(req, mod, a):
                return False
    return True


def assert_can_grant(req, perms):
    """Settings rights let a member manage users and roles, but never hand out more access than they hold.
    Only Admins can grant the Admin role or '*' permissions."""
    if req.role == 'Admin':
        return
    if not isinstance(perms, dict) or '*' in perms or not _within_caller(req, perms):
        raise forbidden('You cannot grant more access than you have')


def role_perms(role):
    p = role.get('permissions')
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError:
            p = {}
    return p if isinstance(p, dict) else {}


# ---------------------------------------------------------------- roles
def norm_perms(p):
    out = {}
    if not isinstance(p, dict):
        return out
    for mod, acts in p.items():
        if mod not in MODULES or not isinstance(acts, list):
            continue
        ok = []
        for a in acts:
            if isinstance(a, str) and a in ACTIONS and a not in ok:
                ok.append(a)
        if ok:
            out[mod] = ok
    return out


def role_row(org_id, id):  # noqa: A002
    row = get('''SELECT r.*, (SELECT COUNT(*) FROM org_users ou WHERE ou.role_id = r.id) AS user_count
                 FROM roles r WHERE r.id = ? AND r.org_id = ?''', _id(id), org_id)
    if not row:
        raise not_found('Role')
    return parse_json(row, ['permissions'])


def role_name_taken(org_id, name, except_id=0):
    return get('SELECT id FROM roles WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?', org_id, name, except_id)


# ---------------------------------------------------------------- currencies
def currency_row(org_id, id):  # noqa: A002
    c = get('SELECT * FROM currencies WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not c:
        raise not_found('Currency')
    return c


def rate_of(v):
    n = js_number(v)
    if not (n > 0) or not math.isfinite(n):  # NaN is not > 0; Infinity is not a rate
        raise bad('Exchange rate must be greater than zero')
    return n2i(n) if isinstance(n, float) and n.is_integer() else n


def currency_use(org_id, code):
    p = [org_id, code]
    return get('''SELECT (SELECT COUNT(*) FROM documents WHERE org_id = ? AND currency = ?)
      + (SELECT COUNT(*) FROM payments WHERE org_id = ? AND currency = ?)
      + (SELECT COUNT(*) FROM expenses WHERE org_id = ? AND currency = ?)
      + (SELECT COUNT(*) FROM journals WHERE org_id = ? AND currency = ?)
      + (SELECT COUNT(*) FROM contacts WHERE org_id = ? AND currency = ?) AS n''', *p, *p, *p, *p, *p)['n']


# ---------------------------------------------------------------- payment terms
def term_row(org_id, id):  # noqa: A002
    t = get('SELECT * FROM payment_terms WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not t:
        raise not_found('Payment term')
    return t


def term_input(body):
    name = sstr(bget(body, 'name'))
    if not name:
        raise bad('Name is required')
    d = bget(body, 'days')
    days = js_number(0 if d is None or d is UNDEF else d)
    if not is_integer(days) or days < 0:
        raise bad('Days must be a whole number, 0 or more')
    typ = bget(body, 'type')
    typ = typ if jt(typ) else 'net'
    if typ not in TERM_TYPES:
        raise bad('Invalid term type')
    return {'name': name, 'days': int(days), 'type': typ, 'is_default': to_flag(bget(body, 'is_default'))}


# ---------------------------------------------------------------- taxes
def tax_row(org_id, id):  # noqa: A002
    t = get('SELECT * FROM taxes WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not t:
        raise not_found('Tax')
    return parse_json(t, ['group_ids'])


def groups_containing(org_id, id):  # noqa: A002
    return [g for g in all("SELECT id, name, group_ids FROM taxes WHERE org_id = ? AND kind = 'group' ORDER BY id", org_id)
            if id in parse_ids(g['group_ids'])]


def _sum_rates(members):
    return round2(sum_js(js_or0(m['rate'] or 0) for m in members))


def tax_input(org_id, body, self_id=0):
    name = sstr(bget(body, 'name'))
    if not name:
        raise bad('Tax name is required')
    kind = bget(body, 'kind')
    kind = kind if jt(kind) else 'simple'
    if kind not in TAX_KINDS:
        raise bad('Invalid tax type')
    if get('SELECT id FROM taxes WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?', org_id, name, self_id):
        raise bad(f'A tax named "{name}" already exists')
    if kind == 'group':
        lst = id_list(bget(body, 'group_ids'))
        if not lst:
            raise bad('Pick at least one tax for the group')
        if self_id in lst:
            raise bad('A tax group cannot contain itself')
        members = all(f'SELECT id, kind, rate FROM taxes WHERE org_id = ? AND id IN ({marks(lst)}) ORDER BY id', org_id, *lst)
        if len(members) != len(lst):
            raise bad('Some taxes in the group no longer exist')
        if any(m['kind'] == 'group' for m in members):
            raise bad('A tax group can only contain individual taxes, not other groups')
        return {'name': name, 'kind': kind, 'rate': _sum_rates(members), 'group_ids': js_json(lst)}
    rate = js_number(bget(body, 'rate'))
    if not is_finite(rate) or rate < 0 or rate > 100:
        raise bad('Rate must be between 0 and 100')
    return {'name': name, 'kind': kind, 'rate': round2(rate), 'group_ids': None}


def recalc_groups(org_id):
    """A group's rate is the sum of its members, so refresh every group after a member changes."""
    for g in all("SELECT id, group_ids FROM taxes WHERE org_id = ? AND kind = 'group' ORDER BY id", org_id):
        lst = parse_ids(g['group_ids'])
        if not lst:
            continue
        lst = [n2i(x) for x in lst]
        members = all(f'SELECT rate FROM taxes WHERE org_id = ? AND id IN ({marks(lst)}) ORDER BY id', org_id, *lst)
        update('taxes', g['id'], {'rate': _sum_rates(members)})


def gst_view(org_id):
    o = get('SELECT gstin, gst_enabled, state, country FROM orgs WHERE id = ?', org_id)
    return {'gstin': o['gstin'], 'gst_enabled': truthy(o['gst_enabled']), 'state': o['state'], 'country': o['country']}


# ---------------------------------------------------------------- custom fields
def cf_row(org_id, id):  # noqa: A002
    c = get('SELECT * FROM custom_fields WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not c:
        raise not_found('Custom field')
    return parse_json(c, ['options'])


def cf_options(v):
    src = v if isinstance(v, list) else re.split(r'\r?\n|,', sstr(v))
    out = []
    for x in src:
        s = sstr(x)
        if s and s not in out:
            out.append(s)
    return out


def cf_input(body):
    label = sstr(bget(body, 'label'))
    if not label:
        raise bad('Label is required')
    dt = bget(body, 'data_type')
    data_type = dt if jt(dt) else 'text'
    if data_type not in CF_TYPES:
        raise bad('Invalid field type')
    options = cf_options(bget(body, 'options')) if data_type == 'dropdown' else []
    if data_type == 'dropdown' and not options:
        raise bad('A dropdown needs at least one option')
    return {
        'label': label, 'data_type': data_type, 'options': js_json(options) if data_type == 'dropdown' else None,
        'is_required': to_flag(bget(body, 'is_required')), 'show_in_pdf': to_flag(bget(body, 'show_in_pdf')),
    }


# ---------------------------------------------------------------- opening balances
def opening_balances(org):
    rows = all('''SELECT MAX(l.date) AS date, l.account_id, a.code, a.name AS account_name, a.system_code,
        ROUND(SUM(l.debit)::numeric, 2) AS debit, ROUND(SUM(l.credit)::numeric, 2) AS credit
      FROM ledger l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = ? AND l.src_type = 'opening_balance' AND l.src_id = ?
      GROUP BY l.account_id, a.id ORDER BY a.code COLLATE "C" NULLS FIRST, a.name COLLATE "C", a.id''', org['id'], org['id'])
    return {
        'date': rows[0]['date'] if rows else None,
        'lines': [{'account_id': x['account_id'], 'code': x['code'], 'account_name': x['account_name'], 'debit': x['debit'], 'credit': x['credit']}
                  for x in rows if x['system_code'] != 'opening_balance_offset'],
    }


# ---------------------------------------------------------------- data export
def doc_export(org_id, typ, party_label):
    return [{
        'number': d['number'], 'date': d['date'], 'due_date': d['due_date'], party_label: d['party'], 'currency': d['currency'],
        'subtotal': d['subtotal'], 'tax_total': d['tax_total'], 'total': d['total'], 'balance': d['balance'], 'status': display_status(d),
    } for d in all('''SELECT d.*, c.display_name AS party FROM documents d
        LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.org_id = ? AND d.doc_type = ? ORDER BY d.date COLLATE "C" NULLS FIRST, d.id''', org_id, typ)]


def _export_accounts(org):
    out = []
    for a in balances_by_account(org['id']):
        cls = account_class(a['type'])
        balance = round2(a['debit'] - a['credit']) if cls in ('asset', 'expense') else round2(a['credit'] - a['debit'])
        out.append({'code': a['code'], 'name': a['name'], 'type': a['type'], 'class': cls,
                    'debit': round2(a['debit']), 'credit': round2(a['credit']), 'balance': balance})
    return out


EXPORTS = {
    'contacts': lambda org: all('''SELECT type, display_name, company_name, first_name, last_name, email, phone, mobile, gst_treatment,
      gstin, pan, place_of_supply, currency, notes, is_active FROM contacts WHERE org_id = ? ORDER BY display_name COLLATE "C" NULLS FIRST, id''', org['id']),
    'items': lambda org: all('''SELECT type, name, sku, unit, hsn_sac, selling_price, purchase_price, track_inventory, opening_stock, is_active
      FROM items WHERE org_id = ? ORDER BY name COLLATE "C" NULLS FIRST, id''', org['id']),
    'invoices': lambda org: doc_export(org['id'], 'invoice', 'customer'),
    'bills': lambda org: doc_export(org['id'], 'bill', 'vendor'),
    'expenses': lambda org: all('''SELECT e.date, a.name AS category, p.name AS paid_through, v.display_name AS vendor, e.amount,
      e.tax_amount, e.total, e.currency, e.reference, e.notes, e.status FROM expenses e
      LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN accounts p ON p.id = e.paid_through_id
      LEFT JOIN contacts v ON v.id = e.vendor_id WHERE e.org_id = ? AND e.is_profile = 0 ORDER BY e.date COLLATE "C" NULLS FIRST, e.id''', org['id']),
    'payments': lambda org: all('''SELECT p.type, p.number, p.date, c.display_name AS contact, p.amount, p.currency, p.mode, p.reference,
      p.bank_charges, p.tds_amount, p.notes FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE p.org_id = ? ORDER BY p.date COLLATE "C" NULLS FIRST, p.id''', org['id']),
    'accounts': _export_accounts,
    'journals': lambda org: all('''SELECT j.number, j.date, j.journal_type, j.status, j.reference, a.code AS account_code, a.name AS account,
      c.display_name AS contact, jl.description, jl.debit, jl.credit FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN contacts c ON c.id = jl.contact_id WHERE j.org_id = ? ORDER BY j.date COLLATE "C" NULLS FIRST, j.id, jl.id''', org['id']),
}

_CSV_SPECIAL = re.compile(r'[",\r\n]')
_CSV_FORMULA = ('=', '+', '-', '@', '\t', '\r')

# module view rights an export needs (settings:view alone is not enough to read the books)
EXPORT_MODULES = {
    'contacts': ['contacts'], 'items': ['items'], 'invoices': ['sales'], 'bills': ['purchases'], 'expenses': ['purchases'],
    'payments': ['sales', 'purchases'], 'accounts': ['accountant'], 'journals': ['accountant'],
}


def all_can(req, modules):
    for m in modules:
        if not can(req, m, 'view'):
            return False
    return True


def to_csv(rows):
    if not rows:
        return ''
    cols = list(rows[0].keys())

    def esc(v):
        if v is None:
            return ''
        s = js_json(v) if isinstance(v, (dict, list)) else js_string(v)
        if isinstance(v, str) and s[:1] in _CSV_FORMULA:
            s = "'" + s  # spreadsheets would run text starting with = + - @ as a formula
        return '"' + s.replace('"', '""') + '"' if _CSV_SPECIAL.search(s) else s
    return '\n'.join([','.join(cols)] + [','.join(esc(r.get(c)) for c in cols) for r in rows])


# ---------------------------------------------------------------- payment reminders
def run_reminders(org, sys_req):
    """Email customers about open invoices whose due date is exactly `days` away (before) or `days` ago (after).
    reminder_log stops a second send for the same rule on the same day (the job runs hourly)."""
    from books.modules.documents import email_vars  # noqa: PLC0415
    s = org_settings(org)
    cfg = s.get('reminders')
    cfg = cfg if truthy(cfg) else {}
    if not jt(bget(cfg, 'enabled')) or not isinstance(bget(cfg, 'rules'), list):
        return 0
    now = today()
    sent = 0
    for rule in cfg['rules']:
        days = js_number(bget(rule, 'days'))
        when = bget(rule, 'when')
        if not is_integer(days) or days < 0 or when not in ('before', 'after'):
            continue
        days = int(days)
        due_on = add_days(now, days) if when == 'before' else add_days(now, -days)
        key = f'{when}:{days}'
        docs = all('''SELECT d.id FROM documents d JOIN contacts c ON c.id = d.contact_id
          WHERE d.org_id = ? AND d.doc_type = 'invoice' AND d.status NOT IN ('draft', 'pending_approval', 'void')
            AND d.balance > 0.004 AND d.due_date = ? AND c.reminders_enabled = 1
            AND NOT EXISTS (SELECT 1 FROM reminder_log rl WHERE rl.document_id = d.id AND rl.rule_key = ? AND rl.sent_on = ?)
          ORDER BY d.id''', org['id'], due_on, key, now)
        for row in docs:
            d = load_doc(org['id'], row['id'], with_lines=False)
            if not truthy(d.get('contact_email')):
                continue
            tpls = s.get('email_templates')
            tpl = bget(tpls, 'reminder') if truthy(tpls) else UNDEF
            if tpl is UNDEF or not truthy(tpl):
                tpl = DEFAULT_TEMPLATES['reminder']
            vars_ = email_vars(org, d)
            subject = fill_template(tpl.get('subject') if isinstance(tpl, dict) else None, vars_)
            body = fill_template(tpl.get('body') if isinstance(tpl, dict) else None, vars_)
            send_email(org, d['contact_email'], subject, body, entity_type='document', entity_id=d['id'])
            insert('reminder_log', {'org_id': org['id'], 'document_id': d['id'], 'rule_key': key, 'sent_on': now})
            if sys_req:
                audit(sys_req, 'document', d['id'], 'payment reminder sent', d['contact_email'])
            sent += 1
    return sent


def job(org, sys_req):
    run_reminders(org, sys_req)


# ---------------------------------------------------------------- routes
def routes(r):  # noqa: C901
    # ---------- users ----------
    r.get('/users', perm('settings', 'view'), lambda req: member_rows(req.org['id']))

    def invite(req):
        b = _body(req)
        email = sstr(bget(b, 'email')).lower()
        if not EMAIL_RE.fullmatch(email):
            raise bad('A valid email address is required')
        role = role_in(req.org['id'], bget(b, 'role_id'))
        if not role:
            raise bad('Choose a role for this user')
        assert_can_grant(req, role_perms(role))
        name = sstr(bget(b, 'name')) or email.split('@')[0]
        # Self-locking route (router.SELF_LOCKING): the slow password hash runs before API_LOCK is taken.
        temp = token(9)
        temp_hash = hash_password(temp)
        with API_LOCK:
            return _invite_locked(req, email, role, name, temp, temp_hash)

    def _invite_locked(req, email, role, name, temp, temp_hash):
        check_send_quota(req.org, email)  # before any account is created, not after
        cap = int(os.environ.get('OPENBOOKS_MAX_PENDING_INVITES') or 100)
        if get("SELECT COUNT(*) AS n FROM org_users WHERE org_id = ? AND status = 'invited'", req.org['id'])['n'] >= cap:
            raise bad(f'This organization already has {cap} pending invitations. Remove some first.')

        def _do():
            existing = get('SELECT id, name FROM users WHERE lower(email) = lower(?)', email)
            if existing:
                m = membership(req.org['id'], existing['id'])
                if m and m['status'] == 'invited':
                    raise bad('This person has already been invited')
                if m and m['status'] != 'inactive':
                    raise bad('This person is already a member of the organization')
                if m and m['role_name'] == 'Admin' and req.role != 'Admin':
                    raise forbidden('Only an Admin can change another Admin')
                # An existing account joins only after it accepts (POST /auth/invites/:org_id/accept): nobody has
                # proven that the person who registered this address is the person the Admin meant to invite.
                if m:
                    update('org_users', m['id'], {'role_id': role['id'], 'status': 'invited'})
                else:
                    insert('org_users', {'org_id': req.org['id'], 'user_id': existing['id'], 'role_id': role['id'], 'status': 'invited'})
                return {'user': existing, 'temp_password': None}
            uid = insert('users', {'name': name, 'email': email, 'password_hash': temp_hash})
            insert('org_users', {'org_id': req.org['id'], 'user_id': uid, 'role_id': role['id'], 'status': 'active'})
            return {'user': {'id': uid, 'name': name}, 'temp_password': temp}
        result = tx(_do)
        # Stand-in for the invitation email: it is logged in the outbox (and sent when SMTP is configured).
        who = result['user']['name']
        org_name = req.org['name']
        stored = None
        if result['temp_password']:
            intro = f"Hello {who},\n\n{req.user['name']} invited you to {org_name} on BeyondBooks as {role['name']}.\n\n"
            outro = '\nChange it from your profile after you sign in.\n\nThanks'
            body = f"{intro}Sign in with {email} and this temporary password: {result['temp_password']}{outro}"
            # The outbox is readable by other members, so its copy never carries the password.
            stored = f"{intro}Sign in with {email} and the temporary password shown to the person who invited you.{outro}"
        else:
            body = (f"Hello {who},\n\n{req.user['name']} invited you to {org_name} on BeyondBooks as {role['name']}. "
                    'Sign in with your existing password and accept the invitation from the organization menu.\n\nThanks')
        send_email(req.org, email, f'You have been invited to {org_name} on BeyondBooks', body,
                   entity_type='user', entity_id=result['user']['id'], stored_body=stored)
        audit(req, 'user', result['user']['id'], 'invited', f"{email} as {role['name']}")
        member = next((m for m in member_rows(req.org['id']) if m['id'] == result['user']['id']), None) or {}
        out = dict(member)
        # The password belongs to a global account, so it is shown only when no mail server can deliver it, and
        # then only to an Admin; with SMTP configured it travels by email alone.
        if result['temp_password'] and not os.environ.get('SMTP_HOST') and req.role == 'Admin':
            out['temp_password'] = result['temp_password']
        return out
    r.post('/users/invite', perm('settings', 'create'), invite)

    def put_user(req):
        b = _body(req)
        uid = js_number(req.params['id'])
        uid = None if isinstance(uid, float) and math.isnan(uid) else n2i(uid)
        m = membership(req.org['id'], uid)
        if not m:
            raise not_found('User')
        if m['role_name'] == 'Admin' and req.role != 'Admin':
            raise forbidden('Only an Admin can change another Admin')
        patch = {}
        if 'role_id' in b:
            role = role_in(req.org['id'], b['role_id'])
            if not role:
                raise bad('Choose a valid role')
            if role['id'] != m['role_id']:
                assert_can_grant(req, role_perms(role))
            patch['role_id'] = role['id']
        if 'status' in b:
            if b['status'] not in ('active', 'inactive'):
                raise bad('Status must be active or inactive')
            if m['status'] == 'invited' and b['status'] == 'active':
                raise bad('This person has not accepted the invitation yet')
            if b['status'] == 'active' and m['status'] != 'active':
                # Reactivation restores a role: the caller must be able to grant it, whether or not role_id was resent.
                cur_role = role_in(req.org['id'], patch.get('role_id', m['role_id']))
                if cur_role:
                    assert_can_grant(req, role_perms(cur_role))
            patch['status'] = b['status']
        next_role = get('SELECT name FROM roles WHERE id = ?', patch['role_id'])['name'] if patch.get('role_id') else m['role_name']
        next_status = patch.get('status') or m['status']
        if uid == req.user['id'] and next_status != 'active':
            raise bad('You cannot deactivate your own account')
        if (m['role_name'] == 'Admin' and m['status'] == 'active' and (next_role != 'Admin' or next_status != 'active')
                and active_admins(req.org['id']) <= 1):
            raise bad('The last active Admin cannot be demoted or deactivated')
        update('org_users', m['id'], patch)
        audit(req, 'user', uid, 'updated', ', '.join(patch.keys()))
        return next((x for x in member_rows(req.org['id']) if x['id'] == uid), None)
    r.put('/users/:id', perm('settings', 'edit'), put_user)

    def delete_user(req):
        uid = js_number(req.params['id'])
        uid = None if isinstance(uid, float) and math.isnan(uid) else n2i(uid)
        if uid == req.user['id']:
            raise bad('You cannot remove yourself. Use "Leave organization" instead.')
        m = membership(req.org['id'], uid)
        if not m:
            raise not_found('User')
        if m['role_name'] == 'Admin' and req.role != 'Admin':
            raise forbidden('Only an Admin can remove another Admin')
        if m['role_name'] == 'Admin' and m['status'] == 'active' and active_admins(req.org['id']) <= 1:
            raise bad('The last active Admin cannot be removed')
        run('DELETE FROM org_users WHERE org_id = ? AND user_id = ?', req.org['id'], uid)
        audit(req, 'user', uid, 'removed')
        return {'ok': True}
    r.delete('/users/:id', perm('settings', 'delete'), delete_user)

    # ---------- roles ----------
    r.get('/roles', perm('settings', 'view'), lambda req: [parse_json(x, ['permissions']) for x in all(
        '''SELECT r.*, (SELECT COUNT(*) FROM org_users ou WHERE ou.role_id = r.id) AS user_count
           FROM roles r WHERE r.org_id = ? ORDER BY r.is_system DESC NULLS LAST, r.name COLLATE "C", r.id''', req.org['id'])])

    r.get('/roles/:id', perm('settings', 'view'), lambda req: role_row(req.org['id'], req.params['id']))

    def post_role(req):
        b = _body(req)
        name = sstr(bget(b, 'name'))
        if not name:
            raise bad('Role name is required')
        if role_name_taken(req.org['id'], name):
            raise bad('A role with this name already exists')
        assert_can_grant(req, norm_perms(bget(b, 'permissions')))
        rid = insert('roles', {
            'org_id': req.org['id'], 'name': name, 'description': sstr(bget(b, 'description')) or None,
            'permissions': js_json(norm_perms(bget(b, 'permissions'))), 'is_system': 0,
        })
        audit(req, 'role', rid, 'created', name)
        return role_row(req.org['id'], rid)
    r.post('/roles', perm('settings', 'create'), post_role)

    def put_role(req):
        b = _body(req)
        role = role_row(req.org['id'], req.params['id'])
        if truthy(role['is_system']) and role['name'] == 'Admin':
            raise bad('The Admin role cannot be edited')
        name = sstr(bget(b, 'name')) or role['name']
        if role_name_taken(req.org['id'], name, role['id']):
            raise bad('A role with this name already exists')
        if 'permissions' in b:
            assert_can_grant(req, norm_perms(b['permissions']))
        update('roles', role['id'], {
            'name': name,
            'description': (sstr(b['description']) or None) if 'description' in b else role['description'],
            'permissions': js_json(norm_perms(b['permissions']) if 'permissions' in b else role['permissions']),
        })
        audit(req, 'role', role['id'], 'updated', name)
        return role_row(req.org['id'], role['id'])
    r.put('/roles/:id', perm('settings', 'edit'), put_role)

    def delete_role(req):
        role = role_row(req.org['id'], req.params['id'])
        if truthy(role['is_system']):
            raise bad('System roles cannot be deleted')
        if role['user_count']:
            raise bad(f"{role['user_count']} user(s) still have this role. Give them another role first.")
        run('DELETE FROM roles WHERE id = ? AND org_id = ?', role['id'], req.org['id'])
        audit(req, 'role', role['id'], 'deleted', role['name'])
        return {'ok': True}
    r.delete('/roles/:id', perm('settings', 'delete'), delete_role)

    # ---------- currencies ----------
    r.get('/currencies', perm('settings', 'view'), lambda req: all(
        'SELECT * FROM currencies WHERE org_id = ? ORDER BY is_base DESC NULLS LAST, code COLLATE "C", id', req.org['id']))

    def post_currency(req):
        b = _body(req)
        code = sstr(bget(b, 'code')).upper()
        if not CURRENCY_RE.fullmatch(code):
            raise bad('Currency code must be 3 letters, e.g. USD')
        if get('SELECT id FROM currencies WHERE org_id = ? AND code = ?', req.org['id'], code):
            raise bad(f'{code} is already added')
        is_base = code == req.org['currency']
        cid = insert('currencies', {
            'org_id': req.org['id'], 'code': code, 'symbol': sstr(bget(b, 'symbol')) or code, 'name': sstr(bget(b, 'name')) or code,
            'exchange_rate': 1 if is_base else rate_of(bget(b, 'exchange_rate')), 'is_base': 1 if is_base else 0,
        })
        audit(req, 'currency', cid, 'created', code)
        return currency_row(req.org['id'], cid)
    r.post('/currencies', perm('settings', 'create'), post_currency)

    def put_currency(req):
        b = _body(req)
        c = currency_row(req.org['id'], req.params['id'])
        update('currencies', c['id'], {
            'symbol': sstr(bget(b, 'symbol')) or c['symbol'],
            'name': sstr(bget(b, 'name')) or c['name'],
            'exchange_rate': 1 if truthy(c['is_base']) else (rate_of(b['exchange_rate']) if 'exchange_rate' in b else c['exchange_rate']),
        })
        audit(req, 'currency', c['id'], 'updated', c['code'])
        return currency_row(req.org['id'], c['id'])
    r.put('/currencies/:id', perm('settings', 'edit'), put_currency)

    def currency_rate(req):
        b = _body(req)
        c = currency_row(req.org['id'], req.params['id'])
        if truthy(c['is_base']):
            raise bad('The base currency always has a rate of 1')
        rate = rate_of(bget(b, 'rate'))
        update('currencies', c['id'], {'exchange_rate': rate})
        audit(req, 'currency', c['id'], 'rate updated', f"{c['code']} = {jsstr(rate)}")
        return currency_row(req.org['id'], c['id'])
    r.post('/currencies/:id/rate', perm('settings', 'edit'), currency_rate)

    def delete_currency(req):
        c = currency_row(req.org['id'], req.params['id'])
        if truthy(c['is_base']):
            raise bad('The base currency cannot be deleted')
        n = currency_use(req.org['id'], c['code'])
        if n:
            raise bad(f"{c['code']} is used by {n} transaction(s) and cannot be deleted")
        run('DELETE FROM currencies WHERE id = ? AND org_id = ?', c['id'], req.org['id'])
        audit(req, 'currency', c['id'], 'deleted', c['code'])
        return {'ok': True}
    r.delete('/currencies/:id', perm('settings', 'delete'), delete_currency)

    # ---------- payment terms ----------
    r.get('/payment-terms', perm('settings', 'view'), lambda req: all(
        'SELECT * FROM payment_terms WHERE org_id = ? ORDER BY days NULLS FIRST, name COLLATE "C", id', req.org['id']))

    def post_term(req):
        data = term_input(_body(req))

        def _do():
            if data['is_default']:
                run('UPDATE payment_terms SET is_default = 0 WHERE org_id = ?', req.org['id'])
            return insert('payment_terms', {'org_id': req.org['id'], **data})
        tid = tx(_do)
        audit(req, 'payment_term', tid, 'created', data['name'])
        return term_row(req.org['id'], tid)
    r.post('/payment-terms', perm('settings', 'create'), post_term)

    def put_term(req):
        t = term_row(req.org['id'], req.params['id'])
        data = term_input({**t, **_body(req)})

        def _do():
            if data['is_default']:
                run('UPDATE payment_terms SET is_default = 0 WHERE org_id = ? AND id != ?', req.org['id'], t['id'])
            update('payment_terms', t['id'], data)
        tx(_do)
        audit(req, 'payment_term', t['id'], 'updated', data['name'])
        return term_row(req.org['id'], t['id'])
    r.put('/payment-terms/:id', perm('settings', 'edit'), put_term)

    def delete_term(req):
        t = term_row(req.org['id'], req.params['id'])
        o = req.org['id']
        used = get('''SELECT (SELECT COUNT(*) FROM documents WHERE org_id = ? AND payment_term_id = ?)
          + (SELECT COUNT(*) FROM contacts WHERE org_id = ? AND payment_term_id = ?) AS n''', o, t['id'], o, t['id'])['n']
        if used:
            raise bad(f'This term is used by {used} record(s) and cannot be deleted')
        run('DELETE FROM payment_terms WHERE id = ? AND org_id = ?', t['id'], o)
        audit(req, 'payment_term', t['id'], 'deleted', t['name'])
        return {'ok': True}
    r.delete('/payment-terms/:id', perm('settings', 'delete'), delete_term)

    # ---------- taxes & GST (gst-settings routes are declared before /taxes/:id) ----------
    r.get('/taxes', perm('settings', 'view'), lambda req: [parse_json(t, ['group_ids']) for t in all(
        'SELECT * FROM taxes WHERE org_id = ? ORDER BY kind COLLATE "C" NULLS FIRST, rate NULLS FIRST, name COLLATE "C", id', req.org['id'])])

    r.get('/taxes/gst-settings', perm('settings', 'view'), lambda req: gst_view(req.org['id']))

    def put_gst(req):
        b = _body(req)
        gstin = sstr(bget(b, 'gstin')).upper() or None
        if gstin and not GSTIN_RE.fullmatch(gstin):
            raise bad('GSTIN must be 15 characters in the standard format, e.g. 27AAACR5055K1Z5')
        state = sstr(bget(b, 'state')) or None
        if state and not any(code == state for code, _ in INDIAN_STATES):
            raise bad('Choose a valid state')
        patch = {'gstin': gstin, 'state': state}
        if 'gst_enabled' in b:
            patch['gst_enabled'] = to_flag(b['gst_enabled'])
        update('orgs', req.org['id'], patch)
        audit(req, 'org', req.org['id'], 'gst settings updated')
        return gst_view(req.org['id'])
    r.put('/taxes/gst-settings', perm('settings', 'edit'), put_gst)

    def post_tax(req):
        b = _body(req)
        data = tax_input(req.org['id'], b)
        tid = insert('taxes', {'org_id': req.org['id'], **data, 'is_active': to_flag(b['is_active']) if 'is_active' in b else 1})
        audit(req, 'tax', tid, 'created', data['name'])
        return tax_row(req.org['id'], tid)
    r.post('/taxes', perm('settings', 'create'), post_tax)

    def put_tax(req):
        b = _body(req)
        t = tax_row(req.org['id'], req.params['id'])
        data = tax_input(req.org['id'], b, t['id'])
        if data['kind'] == 'group' and groups_containing(req.org['id'], t['id']):
            raise bad('This tax is part of a group, so it cannot become a group itself')
        if 'is_active' in b:
            data['is_active'] = to_flag(b['is_active'])
        update('taxes', t['id'], data)
        recalc_groups(req.org['id'])
        audit(req, 'tax', t['id'], 'updated', data['name'])
        return tax_row(req.org['id'], t['id'])
    r.put('/taxes/:id', perm('settings', 'edit'), put_tax)

    def delete_tax(req):
        t = tax_row(req.org['id'], req.params['id'])
        o = req.org['id']
        tid = t['id']
        line_use = get('''SELECT (SELECT COUNT(*) FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.tax_id = ? AND d.org_id = ?)
          + (SELECT COUNT(*) FROM expenses WHERE org_id = ? AND tax_id = ?)
          + (SELECT COUNT(*) FROM items WHERE org_id = ? AND (tax_id = ? OR purchase_tax_id = ?))
          + (SELECT COUNT(*) FROM contacts WHERE org_id = ? AND tax_id = ?) AS n''', tid, o, o, tid, o, tid, tid, o, tid)['n']
        n = line_use + len(groups_containing(o, tid))
        if n:
            raise bad(f'This tax is used in {n} place(s) (transactions, items, expenses or groups). Deactivate it instead.')
        run('DELETE FROM taxes WHERE id = ? AND org_id = ?', tid, o)
        audit(req, 'tax', tid, 'deleted', t['name'])
        return {'ok': True}
    r.delete('/taxes/:id', perm('settings', 'delete'), delete_tax)

    # ---------- custom fields ----------
    def list_cf(req):
        mod = req.query.get('module')
        if mod:
            rows = all('SELECT * FROM custom_fields WHERE org_id = ? AND module = ? ORDER BY id', req.org['id'], str(mod))
        else:
            rows = all('SELECT * FROM custom_fields WHERE org_id = ? ORDER BY module COLLATE "C", id', req.org['id'])
        return [parse_json(c, ['options']) for c in rows]
    r.get('/custom-fields', perm('settings', 'view'), list_cf)

    def post_cf(req):
        b = _body(req)
        module = bget(b, 'module')
        if not isinstance(module, str) or module not in CF_MODULES:
            raise bad('Choose the module this field belongs to')
        data = cf_input(b)
        base = slug(data['label']) or 'field'
        field_key = base
        n = 2
        while get('SELECT id FROM custom_fields WHERE org_id = ? AND module = ? AND field_key = ?', req.org['id'], module, field_key):
            field_key = f'{base}_{n}'
            n += 1
        cid = insert('custom_fields', {'org_id': req.org['id'], 'module': module, 'field_key': field_key, **data})
        audit(req, 'custom_field', cid, 'created', f"{module}: {data['label']}")
        return cf_row(req.org['id'], cid)
    r.post('/custom-fields', perm('settings', 'create'), post_cf)

    def put_cf(req):
        c = cf_row(req.org['id'], req.params['id'])
        # module and field_key never change: records store their values under this key
        data = cf_input({'label': c['label'], 'data_type': c['data_type'], 'options': c['options'], 'is_required': c['is_required'],
                         'show_in_pdf': c['show_in_pdf'], **_body(req)})
        update('custom_fields', c['id'], data)
        audit(req, 'custom_field', c['id'], 'updated', data['label'])
        return cf_row(req.org['id'], c['id'])
    r.put('/custom-fields/:id', perm('settings', 'edit'), put_cf)

    def delete_cf(req):
        c = cf_row(req.org['id'], req.params['id'])
        run('DELETE FROM custom_fields WHERE id = ? AND org_id = ?', c['id'], req.org['id'])
        audit(req, 'custom_field', c['id'], 'deleted', c['label'])
        return {'ok': True}
    r.delete('/custom-fields/:id', perm('settings', 'delete'), delete_cf)

    # ---------- opening balances ----------
    r.get('/opening-balances', perm('accountant', 'view'), lambda req: opening_balances(req.org))

    def put_ob(req):
        b = _body(req)
        org_id = req.org['id']
        date = sstr(bget(b, 'date'))
        if not DATE_RE.fullmatch(date):
            raise bad('Choose the opening balance date')
        assert_source_unlocked(req.org, 'opening_balance', org_id, date)  # the rows being replaced and the new date
        by_account = {}
        lines_in = b.get('lines') if isinstance(b.get('lines'), list) else []
        for l in lines_in:
            debit = round2(js_or0(bget(l, 'debit')))
            credit = round2(js_or0(bget(l, 'credit')))
            if not debit and not credit:
                continue
            if debit < 0 or credit < 0:
                raise bad('Amounts cannot be negative')
            acc = get('SELECT id, name, type, system_code FROM accounts WHERE id = ? AND org_id = ?', _id(bget(l, 'account_id')), org_id)
            if not acc:
                raise bad('Choose a valid account for every line')
            if acc['system_code'] == 'opening_balance_offset':
                raise bad('The Opening Balance Offset account is balanced automatically')
            if acc['system_code'] in OB_BLOCKED_CODES or acc['type'] in OB_BLOCKED_TYPES:
                raise bad(f"{acc['name']} cannot be used here. Enter receivables and payables per contact, and inventory per item.")
            cur = by_account.get(acc['id']) or {'debit': 0, 'credit': 0}
            cur['debit'] = round2(cur['debit'] + debit)
            cur['credit'] = round2(cur['credit'] + credit)
            by_account[acc['id']] = cur
        lines = []
        for account_id, x in by_account.items():
            net = round2(x['debit'] - x['credit'])
            if net:
                lines.append({'account_id': account_id, 'debit': net, 'credit': 0} if net > 0 else {'account_id': account_id, 'debit': 0, 'credit': -net})
        diff = round2(sum_js(l['debit'] for l in lines) - sum_js(l['credit'] for l in lines))
        if diff:
            lines.append({'account_id': sys_account(org_id, 'opening_balance_offset'), 'debit': -diff if diff < 0 else 0, 'credit': diff if diff > 0 else 0})
        post(org_id, 'opening_balance', org_id, date=date, lines=lines)
        audit(req, 'opening_balance', org_id, 'updated', f'{date}, {len(lines)} line(s)')
        return opening_balances(req.org)
    r.put('/opening-balances', perm('accountant', 'edit'), put_ob)  # posts arbitrary ledger lines, like a journal

    # ---------- data backup & export ----------
    def backup(req):
        org_id = req.org['id']
        tables = {'orgs': all('SELECT * FROM orgs WHERE id = ?', org_id)}
        cols = {}
        for c in all('''SELECT c.table_name, c.column_name FROM information_schema.columns c
                        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                        WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' '''):
            cols.setdefault(c['table_name'], set()).add(c['column_name'])
        names = sorted(n for n in cols if n not in ('orgs', 'django_migrations') and not n.lower().startswith('sqlite'))
        for name in names:
            if name in CHILD_TABLES:
                tables[name] = all(CHILD_TABLES[name], org_id)
                continue
            if 'org_id' in cols[name]:
                order = ' ORDER BY id' if 'id' in cols[name] else ''
                tables[name] = all(f'SELECT * FROM "{name}" WHERE org_id = ?{order}', org_id)
        audit(req, 'org', org_id, 'data backup exported')
        res = json_response({'format': 'openbooks-backup', 'version': 1, 'exported_at': now_iso(), 'org_id': org_id, 'tables': tables})
        res['Content-Disposition'] = f'attachment; filename="openbooks-backup-{today()}.json"'
        return res
    def admin_only(req):
        # the backup holds every table of the org, including capability tokens and the outbox
        if req.role != 'Admin':
            raise forbidden('Only an Admin can download a full backup')
    r.get('/data/backup', perm('settings', 'view'), admin_only, backup)

    def export(req):
        entity = req.params['entity']
        build = EXPORTS.get(entity)
        if not build:
            raise not_found('Export')
        if not all_can(req, EXPORT_MODULES[entity]):
            raise forbidden()
        rows = build(req.org)
        if req.query.get('format') == 'csv':
            res = HttpResponse(to_csv(rows).encode('utf-8'), content_type='text/csv; charset=utf-8')
            res['Content-Disposition'] = f'attachment; filename="{entity}-{today()}.csv"'
            return res
        return rows
    r.get('/data/export/:entity', perm('settings', 'view'), export)

    # ---------- reminders ----------
    r.post('/reminders/run', perm('settings', 'edit'), lambda req: {'sent': run_reminders(req.org, req)})
