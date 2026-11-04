"""Public, unauthenticated customer-facing routes: share links, customer portal, test-mode online payments and payment links
(port of modules/portal.js). Authenticated payment-link management is in routes()."""
import json
import re
import secrets

from books.core.db import all, get, insert, update, tx, parse_json
from books.core.router import bad, not_found
from books.core.util import audit, org_settings, token
from books.core.calc import round2
from books.core.auth import perm
from books.core.documents import load_doc, display_status, doc_action
from books.core.payments import save_payment, payment_unused
from books.core.ledger import sys_account
from books.core.jobs import SysReq
from books.core.jsutil import jsstr, num_or_none, to_int, today, truthy
from books.modules.contacts import contact_balances

METHODS = {'card': 'Card', 'upi': 'UPI', 'netbanking': 'Net banking'}
CARD_KEYS = re.compile(r'card|card_?number|cc|cc_?num|cvv|cvc|cvn|expiry|exp_?month|exp_?year|pan', re.IGNORECASE | re.ASCII)
CARD_RUN = re.compile(r'[0-9](?:[ -]?[0-9]){12,18}')
DATE_RE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
SHARE_HIDDEN = ['org_id', 'created_by', 'approved_by', 'account_id', 'profile_id', 'source_doc_id', 'recurrence', 'updated_at', 'payment_mode']
LINE_HIDDEN = ['account_id', 'account_name', 'customer_id', 'src_type', 'src_id']
# JavaScript String.prototype.trim() whitespace and line terminators
JS_WS = '\t\n\x0b\x0c\r \xa0                　﻿'


# ---------- JavaScript semantics ----------
def _jstr(v):
    """String(v) for JSON values."""
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return jsstr(v)
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ','.join('' if x is None else _jstr(x) for x in v)
    if isinstance(v, dict):
        return '[object Object]'
    return str(v)


def _js_trim(s):
    return s.strip(JS_WS)


def _str_or_empty(v):
    """String(v || '')"""
    return _jstr(v) if truthy(v) else ''


def _body(req):
    b = req.body
    return b if isinstance(b, dict) else {}


def _entries(v):
    """Object.entries(v): integer-like keys first (ascending), then the rest in insertion order."""
    if isinstance(v, list):
        return [(str(i), x) for i, x in enumerate(v)]
    if isinstance(v, dict):
        ints = sorted((k for k in v if re.fullmatch(r'0|[1-9][0-9]*', k) and int(k) < 4294967295), key=int)
        rest = [k for k in v if not (re.fullmatch(r'0|[1-9][0-9]*', k) and int(k) < 4294967295)]
        return [(k, v[k]) for k in ints + rest]
    return []


def _prop(table, key):
    """table[key] for a JSON value used as a property name."""
    return table.get(_jstr(key))


def _json_or_default(text, default):
    try:
        return json.loads(text)
    except ValueError:
        return default


# ---------- shared helpers ----------
def _system_req(org):
    """A system-level request for savePayment / docAction: no user, full permissions (the Node systemReq)."""
    return SysReq(org, {'id': None, 'name': 'Customer Portal'})


def _public_org(org):
    address = _json_or_default(org.get('address') or '{}', {})
    return {
        'name': org.get('name'), 'address': address, 'gstin': org.get('gstin'), 'logo': org.get('logo'), 'email': org.get('email'),
        'phone': org.get('phone'), 'website': org.get('website'), 'currency': org.get('currency'),
        'settings': {'pdf': org_settings(org)['pdf']},
    }


def _public_doc(d):
    out = dict(d)
    # only custom fields marked "Show on PDF" are customer-facing; the rest stay internal
    if isinstance(out.get('custom_fields'), dict):
        module = str(out.get('doc_type') or '').replace('recurring_', '')
        shown = {r['field_key'] for r in all('SELECT field_key FROM custom_fields WHERE org_id = ? AND module = ? AND show_in_pdf = 1',
                                                 out.get('org_id'), module)}
        out['custom_fields'] = {k: v for k, v in out['custom_fields'].items() if k in shown}
    for k in SHARE_HIDDEN:
        out.pop(k, None)
    if out.get('lines'):
        out['lines'] = [{k: v for k, v in line.items() if k not in LINE_HIDDEN} for line in out['lines']]
    return out


def _luhn(digits):
    total = 0
    alt = False
    for ch in reversed(digits):
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def _contains_card_number(s):
    for m in CARD_RUN.finditer(s):
        digits = re.sub(r'[ -]', '', m.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits):
            return True
    return False


def _assert_no_card_data(body):
    """This is a test-mode gateway: it never accepts card data."""
    for k, v in _entries(body):
        if CARD_KEYS.fullmatch(k):
            raise bad('Card details are not accepted. This is a test-mode gateway: pick UPI or net banking, or use a payment provider.')
        if isinstance(v, str) and _contains_card_number(v):
            raise bad('That looks like a card number. Card details are not accepted in test mode.')


def _find_shared(tk):
    d = get('SELECT id, org_id, doc_type, status FROM documents WHERE share_token = ?', tk)
    if not d or d['status'] in ('draft', 'pending_approval'):
        raise not_found('Document')
    return d


def _org_of(id_):
    org = get('SELECT * FROM orgs WHERE id = ?', id_)
    if not org:
        raise not_found('Organization')
    return org


def _respond_to_quote(tk, action, body):
    d0 = _find_shared(tk)
    if d0['doc_type'] != 'quote':
        raise bad('Only quotes can be accepted or declined online')
    org = _org_of(d0['org_id'])
    d = load_doc(org['id'], d0['id'], with_lines=False)
    if d['status'] != 'sent':
        raise bad(f"This quote is {jsstr(d.get('display_status'))} and can no longer be {'accepted' if action == 'accept' else 'declined'}")
    if d.get('display_status') == 'expired':
        raise bad('This quote has expired')
    reason = _js_trim(_str_or_empty(body.get('reason')))[:500]
    sys_req = _system_req(org)

    def _do():
        doc_action(sys_req, 'quote', d['id'], action)
        verb = 'Accepted' if action == 'accept' else 'Declined'
        insert('comments', {
            'org_id': org['id'], 'entity_type': 'document', 'entity_id': d['id'], 'user_id': None, 'author': 'Customer',
            'text': f'{verb}: {reason}' if reason else f'{verb} by the customer',
        })
        audit(sys_req, 'document', d['id'], f"{'accepted' if action == 'accept' else 'declined'} by customer", reason)
        return {'ok': True, 'status': 'accepted' if action == 'accept' else 'declined'}
    return tx(_do)


def _find_portal_contact(tk):
    c = get('SELECT * FROM contacts WHERE portal_token = ? AND portal_enabled = 1', tk)
    if not c:
        raise not_found('Portal')
    return c


def _find_link(tk):
    pl = get('SELECT * FROM payment_links WHERE token = ?', tk)
    if not pl:
        raise not_found('Payment link')
    return pl


def _link_status(pl):
    """Active links past their expiry date count as expired."""
    if pl.get('status') == 'active' and truthy(pl.get('expires_on')) and pl['expires_on'] < today():
        return 'expired'
    return pl.get('status')


# ---------- public routes ----------
def _share_get(req):
    d0 = _find_shared(req.params['token'])
    org = _org_of(d0['org_id'])
    doc = load_doc(org['id'], d0['id'])
    contact = None
    if truthy(doc.get('contact_id')):
        contact = parse_json(get('SELECT display_name, company_name, billing_address, gstin, email FROM contacts WHERE id = ? AND org_id = ?',
                                 doc['contact_id'], org['id']), ['billing_address'])
    payments = all('''SELECT pa.amount, p.date, p.mode, p.number FROM payment_allocations pa
                      JOIN payments p ON p.id = pa.payment_id WHERE pa.document_id = ? ORDER BY p.date, pa.id''', doc['id'])
    return {
        'org': _public_org(org),
        'doc': _public_doc(doc),
        'contact': contact,
        'payments': payments,
        'payments_enabled': doc['doc_type'] == 'invoice' and doc['status'] == 'open' and (doc.get('balance') or 0) > 0.004,
    }


def _share_pay(req):
    body = _body(req)
    _assert_no_card_data(req.body)
    d0 = _find_shared(req.params['token'])
    if d0['doc_type'] != 'invoice':
        raise bad('Only invoices can be paid online')
    org = _org_of(d0['org_id'])
    d = load_doc(org['id'], d0['id'], with_lines=False)
    if d['status'] != 'open' or (d.get('balance') or 0) <= 0.004:
        raise bad('This invoice has nothing outstanding')
    raw = d['balance'] if ('amount' not in body or body['amount'] == '') else body['amount']
    amount = round2(raw)
    if not amount > 0:
        raise bad('Enter an amount greater than zero')
    if amount > (d.get('balance') or 0) + 0.001:
        raise bad(f"The amount is more than the balance due ({jsstr(d.get('balance'))})")
    method = body.get('method') if truthy(body.get('method')) else 'upi'
    if not _prop(METHODS, method):
        raise bad('Choose a payment method')
    payer = _js_trim(_str_or_empty(body.get('payer_name')))[:100]
    if not payer:
        raise bad('Enter the name of the payer')

    sys_req = _system_req(org)

    def _do():
        reference = 'TEST-' + secrets.token_hex(5).upper()
        p = save_payment(sys_req, 'received', {
            'contact_id': d.get('contact_id'), 'amount': amount, 'date': today(), 'mode': 'Online Payment', 'is_online': 1,
            'reference': reference,
            'account_id': sys_account(org['id'], 'undeposited_funds'),
            'notes': f'Paid online by {payer} via {_prop(METHODS, method)} (test mode)',
            'allocations': [{'document_id': d['id'], 'amount': amount}],
        })
        audit(sys_req, 'document', d['id'], 'paid online (test mode)', f'{jsstr(amount)} by {payer}')
        fresh = load_doc(org['id'], d['id'], with_lines=False)
        return {
            'ok': True, 'test_mode': True, 'reference': reference,
            'payment': {'number': p['number'], 'amount': p['amount'], 'date': p['date']},
            'balance': fresh['balance'], 'display_status': fresh.get('display_status'),
        }
    return tx(_do)


def _portal_get(req):
    c = _find_portal_contact(req.params['token'])
    org = _org_of(c['org_id'])

    def docs(typ):
        rows = all('''SELECT id, doc_type, number, date, due_date, total, balance, status, sent_at, currency, share_token
                      FROM documents WHERE org_id = ? AND contact_id = ? AND doc_type = ? AND status NOT IN ('draft', 'pending_approval', 'void')
                      ORDER BY date DESC, id DESC''', org['id'], c['id'], typ)
        out = []
        for d in rows:
            rest = {k: v for k, v in d.items() if k != 'sent_at'}
            rest['display_status'] = display_status(d)
            out.append(rest)
        return out

    payments = []
    for p in all("SELECT * FROM payments WHERE org_id = ? AND contact_id = ? AND type = 'received' ORDER BY date DESC, id DESC",
                 org['id'], c['id']):
        payments.append({'id': p['id'], 'number': p['number'], 'date': p['date'], 'amount': p['amount'], 'mode': p['mode'],
                         'reference': p['reference'], 'unused': payment_unused(p)})
    contact = parse_json({
        'display_name': c.get('display_name'), 'company_name': c.get('company_name'), 'email': c.get('email'),
        'gstin': c.get('gstin'), 'billing_address': c.get('billing_address'),
    }, ['billing_address'])
    return {
        'org': _public_org(org),
        'contact': contact,
        'currency': c.get('currency') or org.get('currency'),
        'invoices': docs('invoice'),
        'quotes': docs('quote'),
        'salesorders': docs('salesorder'),
        'creditnotes': docs('creditnote'),
        'retainers': docs('retainer'),
        'payments': payments,
        'summary': contact_balances(org['id'], c['id']),
    }


def _portal_comment(req):
    c = _find_portal_contact(req.params['token'])
    body = _body(req)
    text = _js_trim(_str_or_empty(body.get('text')))[:2000]
    if not text:
        raise bad('Comment cannot be empty')
    d = get('SELECT id FROM documents WHERE id = ? AND contact_id = ? AND org_id = ?', num_or_none(body.get('document_id')), c['id'], c['org_id'])
    if not d:
        raise not_found('Document')
    insert('comments', {'org_id': c['org_id'], 'entity_type': 'document', 'entity_id': d['id'], 'user_id': None,
                        'author': 'Customer', 'text': text})
    return {'ok': True}


def _pay_get(req):
    pl = _find_link(req.params['token'])
    org = _org_of(pl['org_id'])
    contact = get('SELECT display_name FROM contacts WHERE id = ?', pl['contact_id']) if truthy(pl.get('contact_id')) else None
    return {
        'org': {'name': org.get('name'), 'logo': org.get('logo'), 'currency': org.get('currency'), 'email': org.get('email'),
                'phone': org.get('phone')},
        'contact_name': (contact or {}).get('display_name') or None,
        'amount': pl.get('amount'), 'description': pl.get('description'), 'expires_on': pl.get('expires_on'),
        'status': _link_status(pl),
        'currency': org.get('currency'),
    }


def _pay_pay(req):
    body = _body(req)
    _assert_no_card_data(req.body)
    pl = _find_link(req.params['token'])
    org = _org_of(pl['org_id'])
    if _link_status(pl) != 'active':
        raise bad(f'This payment link is {jsstr(_link_status(pl))}')
    payer = _js_trim(_str_or_empty(body.get('payer_name')))[:100]
    if not payer:
        raise bad('Enter the name of the payer')
    method = body.get('method') if _prop(METHODS, body.get('method')) else 'upi'
    sys_req = _system_req(org)
    desc = _str_or_empty(pl.get('description'))

    def _do():
        reference = 'TEST-' + secrets.token_hex(5).upper()
        p = save_payment(sys_req, 'received', {
            'contact_id': pl.get('contact_id'), 'amount': pl['amount'], 'date': today(), 'mode': 'Online Payment', 'is_online': 1,
            'reference': reference,
            'account_id': sys_account(org['id'], 'undeposited_funds'),
            'notes': _js_trim(f'Payment link {desc} paid by {payer} via {_prop(METHODS, method)} (test mode)'),
        })
        update('payment_links', pl['id'], {'status': 'paid', 'payment_id': p['id']})
        audit(sys_req, 'payment_received', p['id'], 'payment link paid (test mode)', f"{jsstr(pl['amount'])} by {payer}")
        return {'ok': True, 'test_mode': True, 'reference': reference,
                'payment': {'number': p['number'], 'amount': p['amount'], 'date': p['date']}}
    return tx(_do)


def public_routes(pub):
    # ----- share links -----
    pub.get('/share/:token', _share_get)
    pub.post('/share/:token/accept', lambda req: _respond_to_quote(req.params['token'], 'accept', _body(req)))
    pub.post('/share/:token/decline', lambda req: _respond_to_quote(req.params['token'], 'decline', _body(req)))
    # ----- test-mode online payment against an invoice -----
    pub.post('/share/:token/pay', _share_pay)
    # ----- customer portal -----
    pub.get('/portal/:token', _portal_get)
    pub.post('/portal/:token/comments', _portal_comment)
    # ----- payment links (pay a fixed amount, unallocated) -----
    pub.get('/pay/:token', _pay_get)
    pub.post('/pay/:token/pay', _pay_pay)


# ---------- authenticated management of payment links ----------
def _load_link(req):
    pl = get('SELECT * FROM payment_links WHERE id = ? AND org_id = ?', to_int(req.params['id']), req.org['id'])
    if not pl:
        raise not_found('Payment link')
    return pl


def _check_customer(org_id, contact_id):
    if not truthy(contact_id):
        return None
    cid = num_or_none(contact_id)
    if not get("SELECT id FROM contacts WHERE id = ? AND org_id = ? AND type = 'customer'", cid, org_id):
        raise bad('Choose a customer')
    return cid


def _clean_link(org_id, body, existing):
    o = {}
    if 'contact_id' in body:
        o['contact_id'] = _check_customer(org_id, body['contact_id'])
    if 'amount' in body or existing is None:
        o['amount'] = round2(body.get('amount'))
        if not o['amount'] > 0:
            raise bad('Enter an amount greater than zero')
    if 'description' in body:
        o['description'] = _js_trim(_str_or_empty(body['description']))[:300] or None
    if 'expires_on' in body:
        ev = body['expires_on']
        if truthy(ev) and not DATE_RE.fullmatch(_jstr(ev)):
            raise bad('Invalid expiry date')
        o['expires_on'] = ev if truthy(ev) else None
    return o


def _list_links(req):
    rows = all('''SELECT pl.*, c.display_name AS contact_name FROM payment_links pl LEFT JOIN contacts c ON c.id = pl.contact_id
                  WHERE pl.org_id = ? ORDER BY pl.id DESC LIMIT 500''', req.org['id'])
    return [{**x, 'effective_status': _link_status(x)} for x in rows]


def _get_link(req):
    pl = _load_link(req)
    return {**pl, 'effective_status': _link_status(pl)}


def _create_link(req):
    org = req.org['id']
    o = _clean_link(org, _body(req), None)
    id_ = insert('payment_links', {
        'org_id': org, 'token': token(18), 'contact_id': o.get('contact_id'), 'amount': o['amount'],
        'description': o.get('description'), 'expires_on': o.get('expires_on'), 'status': 'active', 'created_by': req.user['id'],
    })
    audit(req, 'payment_link', id_, 'created', jsstr(o['amount']))
    pl = get('SELECT * FROM payment_links WHERE id = ?', id_)
    return {**pl, 'effective_status': _link_status(pl)}


def _update_link(req):
    pl = _load_link(req)
    if pl['status'] != 'active':
        raise bad('Only active payment links can be changed')
    o = _clean_link(req.org['id'], _body(req), pl)
    update('payment_links', pl['id'], o)
    audit(req, 'payment_link', pl['id'], 'updated')
    fresh = get('SELECT * FROM payment_links WHERE id = ?', pl['id'])
    return {**fresh, 'effective_status': _link_status(fresh)}


def _delete_link(req):
    # a link is never deleted once created: removing it expires it so the URL stops working
    pl = _load_link(req)
    if pl['status'] == 'paid':
        raise bad('A paid payment link cannot be removed')
    update('payment_links', pl['id'], {'status': 'expired'})
    audit(req, 'payment_link', pl['id'], 'expired')
    return {'ok': True}


def routes(r):
    r.get('/payment-links', perm('sales', 'view'), _list_links)
    r.get('/payment-links/:id', perm('sales', 'view'), _get_link)
    r.post('/payment-links', perm('sales', 'create'), _create_link)
    r.put('/payment-links/:id', perm('sales', 'edit'), _update_link)
    r.delete('/payment-links/:id', perm('sales', 'delete'), _delete_link)
