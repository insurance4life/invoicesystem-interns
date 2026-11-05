"""Shared helpers (port of util.js)."""
import copy
import datetime
import json
import logging
import re
import secrets
import base64

from books.core.db import get, insert, update, run  # noqa: F401 (re-exported like util.js)
from books.core.router import HttpError, bad, not_found, forbidden  # noqa: F401
from books.core.calc import round2  # noqa: F401
from books.core.jsutil import jsnum, today, now_iso, truthy  # noqa: F401

log = logging.getLogger('openbooks')


def token(n=24):
    """crypto.randomBytes(n).toString('base64url')"""
    return base64.urlsafe_b64encode(secrets.token_bytes(n)).decode().rstrip('=')


def num(v, d=0):
    """util.num: '' / None / NaN -> d."""
    from books.core.jsutil import num_or_none  # noqa: PLC0415
    n = num_or_none(v)
    return d if n is None else n


DEFAULT_SETTINGS = {
    'series': {
        'quote': {'prefix': 'QT-', 'next': 1}, 'salesorder': {'prefix': 'SO-', 'next': 1}, 'invoice': {'prefix': 'INV-', 'next': 1},
        'retainer': {'prefix': 'RET-', 'next': 1}, 'creditnote': {'prefix': 'CN-', 'next': 1}, 'deliverychallan': {'prefix': 'DC-', 'next': 1},
        'salesreceipt': {'prefix': 'SR-', 'next': 1}, 'purchaseorder': {'prefix': 'PO-', 'next': 1}, 'bill': {'prefix': 'BILL-', 'next': 1},
        'vendorcredit': {'prefix': 'VC-', 'next': 1}, 'payment_received': {'prefix': 'PR-', 'next': 1}, 'payment_made': {'prefix': 'PM-', 'next': 1},
        'journal': {'prefix': 'MJ-', 'next': 1}, 'recurring_invoice': {'prefix': 'RI-', 'next': 1}, 'recurring_bill': {'prefix': 'RB-', 'next': 1},
    },
    'number_padding': 5,
    'preferences': {
        'discount_level': 'transaction',
        'allow_shipping': True,
        'allow_adjustment': True,
        'tax_inclusive_default': False,
        'invoice_terms': 'Thank you for your business.',
        'invoice_notes': 'Looking forward for your business.',
        'quote_terms': '',
        'quote_validity_days': 15,
        'so_terms': '', 'po_terms': '', 'bill_notes': '',
        'allow_editing_sent_invoice': True,
        'late_fee': {'enabled': False, 'type': 'percent', 'value': 2, 'after_days': 0},
        'inventory_start_date': None,
        'decimal_places': 2,
        'weight_unit': 'kg',
        'duplicate_sku_check': True,
        'duplicate_contact_check': True,
    },
    'approvals': {},
    'reminders': {'enabled': False, 'rules': [{'days': 3, 'when': 'after'}]},
    'pdf': {'template': 'standard', 'color': '#408dfb', 'font': 'Inter', 'show_logo': True, 'show_signature': False, 'footer': ''},
    'email_templates': {},
    'locks': {},
}


def _loads(s):
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s or '{}') or {}
    except ValueError:
        return {}


def org_settings(org):
    """Org settings merged over DEFAULT_SETTINGS (org is a row or {'settings': ...})."""
    s = _loads(org.get('settings') if isinstance(org, dict) else None)
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    for k, v in s.items():
        if isinstance(merged.get(k), dict):
            if k == 'series':
                for t, cfg in (v or {}).items():
                    merged['series'][t] = {**merged['series'].get(t, {}), **(cfg or {})}
            elif isinstance(v, dict):
                merged[k] = {**merged[k], **v}
            elif v is not None:
                merged[k] = v
        else:
            merged[k] = v
    return merged


SETTINGS_MAX_BYTES = 64 * 1024


def save_org_settings(org_id, patch):
    org = get('SELECT settings FROM orgs WHERE id = ?', org_id)
    cur = _loads(org['settings'])
    nxt = dict(cur)
    for k, v in (patch or {}).items():
        nxt[k] = {**(cur.get(k) if isinstance(cur.get(k), dict) else {}), **v} if isinstance(v, dict) else v
    blob = json.dumps(nxt, separators=(',', ':'), ensure_ascii=False)
    if len(blob) > SETTINGS_MAX_BYTES:  # parsed on every request in the org, so it must stay small
        raise bad('Organization settings are too large')
    update('orgs', org_id, {'settings': blob})
    return org_settings({'settings': nxt})


def next_number(org_id, series):
    """Reserve and return the next number in a series, e.g. INV-00012."""
    org = get('SELECT settings FROM orgs WHERE id = ?', org_id)
    s = org_settings(org)
    cfg = s['series'].get(series) or {'prefix': series.upper()[:3] + '-', 'next': 1}
    n = int(jsnum(cfg.get('next')) or 1)
    num_str = f"{cfg.get('prefix', '')}{str(n).rjust(int(s.get('number_padding') or 5), '0')}"
    cur_series = _loads(org['settings']).get('series') or {}
    save_org_settings(org_id, {'series': {**cur_series, series: {**cfg, 'next': n + 1}}})
    return num_str


def peek_number(org, series):
    s = org_settings(org)
    cfg = s['series'].get(series) or {'prefix': '', 'next': 1}
    return f"{cfg.get('prefix', '')}{str(cfg.get('next') or 1).rjust(int(s.get('number_padding') or 5), '0')}"


LOCK_AREA = {
    'quote': 'sales', 'salesorder': 'sales', 'invoice': 'sales', 'retainer': 'sales', 'creditnote': 'sales', 'deliverychallan': 'sales',
    'salesreceipt': 'sales', 'payment_received': 'sales', 'purchaseorder': 'purchases', 'bill': 'purchases', 'vendorcredit': 'purchases',
    'expense': 'purchases', 'payment_made': 'purchases', 'bank': 'banking', 'journal': 'accountant',
}


_ISO_DATE = re.compile(r'\d{4}-\d{2}-\d{2}')


def canon_date(value, label='date'):
    """Return value if it is a real calendar date written as YYYY-MM-DD, else raise 400. Dates are stored and compared
    as text, so any other spelling (20200615, 2020-6-15, a time suffix) would sort past a lock or drop out of reports."""
    s = value if isinstance(value, str) else ''
    if not _ISO_DATE.fullmatch(s):
        raise bad(f'Invalid {label}: use YYYY-MM-DD')
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        raise bad(f'Invalid {label}: use YYYY-MM-DD') from None
    return s


def assert_unlocked(org, date, kind):
    if not date:
        return
    date = canon_date(date)
    s = org_settings(org)
    area_lock = (s.get('locks') or {}).get(LOCK_AREA.get(kind)) if isinstance(s.get('locks'), dict) else None
    locks = sorted([str(x) for x in [org.get('lock_date'), area_lock] if x])
    lock = locks[-1] if locks else None
    if lock and date <= lock:
        raise bad(f'Transactions dated on or before {lock} are locked. Change the lock date in Accountant → Transaction Locking.')


# ---- audit trail + event bus ----
_listeners = []


def on_event(fn):
    """Subscribe to every audited event: fn(req=, entity_type=, entity_id=, action=, detail=)."""
    _listeners.append(fn)


def audit(req, entity_type, entity_id, action, detail=''):
    insert('activity', {
        'org_id': req.org['id'], 'user_id': (req.user or {}).get('id'), 'entity_type': entity_type, 'entity_id': entity_id,
        'action': action, 'detail': detail if isinstance(detail, str) else json.dumps(detail, separators=(',', ':')),
    })
    for fn in _listeners:
        try:
            fn(req=req, entity_type=entity_type, entity_id=entity_id, action=action, detail=detail)
        except Exception as e:  # noqa: BLE001
            log.error('event listener failed: %s', e)


_OWNED_TABLES = {'accounts', 'contacts', 'items', 'documents', 'projects', 'taxes', 'payment_terms', 'tds_sections'}


def assert_owned(org_id, table, ids, label):
    """Raise 400 unless every non-empty id in ids is a row of `table` that belongs to org_id.
    Referenced ids are plain integers in the schema, so ownership must be checked before they are stored."""
    if table not in _OWNED_TABLES:
        raise ValueError(f'assert_owned: unsupported table {table}')
    want = set()
    for v in ids:
        if v is None or v == '' or v is False:
            continue
        try:
            n = int(str(v).strip())
        except (TypeError, ValueError):
            raise bad(f'Invalid {label}') from None
        want.add(n)
    if not want:
        return
    from books.core.db import all as db_all  # noqa: PLC0415
    found = db_all(f"SELECT id FROM {table} WHERE org_id = ? AND id IN ({','.join('?' for _ in want)})", org_id, *want)
    if len(found) != len(want):
        raise bad(f'Invalid {label}')


MAX_COLLECTION = 500  # lines, tasks or users one request may carry; each costs queries while API_LOCK is held


def cap_list(value, label, limit=MAX_COLLECTION):
    """Raise 400 when a request list is longer than limit (the 26 MB body cap alone allows millions of rows)."""
    if isinstance(value, (list, dict)) and len(value) > limit:
        raise bad(f'At most {limit} {label} are allowed')
    return value


BANK_TYPES = ('bank', 'credit_card', 'cash', 'payment_clearing')
# Accounts a purchase-side line (bill, vendor credit, expense) may debit: costs, stock and other assets bought.
PURCHASE_LINE_TYPES = ('expense', 'cost_of_goods_sold', 'other_expense', 'stock', 'fixed_asset', 'other_asset', 'other_current_asset')
SALES_LINE_TYPES = ('income', 'other_income')


def assert_account_types(req, org_id, ids, allowed, label):
    """400 unless every chosen account is of an allowed type. Choosing any other account (bank, equity, control
    accounts) is a journal entry, so it is left to accountant:edit holders."""
    from books.core.auth import can  # noqa: PLC0415 (auth imports util)
    ids = [i for i in ids if i not in (None, '')]
    if not ids or (req is not None and can(req, 'accountant', 'edit')):
        return
    for i in ids:
        a = get('SELECT type, name FROM accounts WHERE id = ? AND org_id = ?', i, org_id)
        if a and a['type'] not in allowed:
            raise bad(f"{a['name']} cannot be used as {label} here; ask an accountant to post to it")


CUSTOM_FIELDS_MAX = 16_000


def clean_custom_fields(v):
    """Custom field values are a JSON object (field key -> value) of bounded size; they are read on every view,
    including public share links."""
    if v in (None, '', {}):
        return None
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            raise bad('Custom fields must be an object') from None
    if not isinstance(v, dict):
        raise bad('Custom fields must be an object')
    s = json.dumps(v, separators=(',', ':'), ensure_ascii=False)
    if len(s) > CUSTOM_FIELDS_MAX:
        raise bad('Custom fields are too large')
    return s


def like_pattern(text, max_len=100):
    """A '%text%' ILIKE pattern with the user's % and _ taken literally (PostgreSQL's default escape is backslash)
    and a bounded length, since every searched row is compared against the whole pattern while API_LOCK is held."""
    s = str(text or '').strip()[:max_len]
    s = s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{s}%' if s else None


def clean_body(body, fields):
    """Pick the given keys that are present in body; '' becomes None."""
    o = {}
    for f in fields:
        if f in body:
            o[f] = None if body[f] == '' else body[f]
    return o
