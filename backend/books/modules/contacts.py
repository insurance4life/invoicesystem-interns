"""Customers & vendors CRUD with balances (port of modules/contacts.js)."""
import json
import re

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found, forbidden
from books.core.util import token, audit, round2, today
from books.core.auth import perm, can
from books.core.jsutil import to_int, truthy
from books.core.ledger import sys_account, repost_opening, unpost_opening
from books.core.payments import available_credits

FIELDS = ['type', 'customer_type', 'display_name', 'company_name', 'salutation', 'first_name', 'last_name', 'email', 'phone', 'mobile',
          'website', 'currency', 'payment_term_id', 'gst_treatment', 'gstin', 'pan', 'place_of_supply', 'tax_id', 'billing_address',
          'shipping_address', 'contact_persons', 'notes', 'credit_limit', 'price_list_id', 'portal_enabled', 'reminders_enabled',
          'linked_contact_id', 'custom_fields', 'is_active']
JSON_COLS = ['billing_address', 'shipping_address', 'contact_persons', 'custom_fields']
GSTIN_RE = re.compile(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')


def contact_balances(org_id, contact_id):
    c = get('SELECT type FROM contacts WHERE id = ?', contact_id)
    acc = sys_account(org_id, 'ap' if (c or {}).get('type') == 'vendor' else 'ar')
    r = get('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ledger WHERE account_id = ? AND contact_id = ? AND org_id = ?', acc, contact_id, org_id)
    bal = round2(r['c'] - r['d']) if (c or {}).get('type') == 'vendor' else round2(r['d'] - r['c'])
    credits = 0
    for x in available_credits(org_id, contact_id):
        credits = credits + x['balance']
    return {'outstanding': bal, 'unused_credits': round2(credits)}


def _clean_contact(body):
    o = {}
    for f in FIELDS:
        if f in body:
            o[f] = None if body[f] == '' else body[f]
    for j in JSON_COLS:
        if isinstance(o.get(j), (dict, list)):
            o[j] = json.dumps(o[j], separators=(',', ':'), ensure_ascii=False)
    if o.get('gstin'):
        o['gstin'] = str(o['gstin']).upper().strip()
        if not GSTIN_RE.match(o['gstin']):
            raise bad('GSTIN format is invalid (e.g. 27AAPFU0939F1ZV)')
        if not o.get('place_of_supply'):
            o['place_of_supply'] = o['gstin'][:2]
    return o


def _post_opening(org, id, type_, amount, date):  # noqa: A002
    """Contact opening balance -> ledger (AR/AP vs Opening Balance Offset)."""
    amount = round2(amount or 0)
    if not amount:
        return unpost_opening(org, 'contact_opening', id)
    ctrl = sys_account(org['id'], 'ap' if type_ == 'vendor' else 'ar')
    off = sys_account(org['id'], 'opening_balance_offset')
    if type_ == 'vendor':
        lines = [{'account_id': off, 'debit': amount}, {'account_id': ctrl, 'credit': amount, 'contact_id': id}]
    else:
        lines = [{'account_id': ctrl, 'debit': amount, 'contact_id': id}, {'account_id': off, 'credit': amount}]
    repost_opening(org, 'contact_opening', id, date or today(), lines, number='Opening Balance', contact_id=id)


def load_contact(org_id, id):  # noqa: A002
    c = parse_json(get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', id, org_id), JSON_COLS)
    if not c:
        raise not_found('Contact')
    c.update(contact_balances(org_id, c['id']))
    ob = get("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, MIN(date) dt FROM ledger WHERE src_type = 'contact_opening' AND src_id = ? AND contact_id = ?",
             c['id'], c['id'])
    c['opening_balance'] = round2(ob['c']) if c['type'] == 'vendor' else round2(ob['d'])
    c['opening_balance_date'] = ob['dt']
    return c


def routes(r):
    def list_contacts(req):
        q = req.query
        typ, search, status = q.get('type'), q.get('q'), q.get('status') or 'active'
        page, per_page, sort = to_int(q.get('page'), 1) or 1, to_int(q.get('per_page'), 200) or 200, q.get('sort') or 'display_name'
        where = ['c.org_id = ?']
        p = [req.org['id']]
        if typ:
            where.append('c.type = ?')
            p.append(typ)
        if status == 'active':
            where.append('c.is_active = 1')
        if status == 'inactive':
            where.append('c.is_active = 0')
        if search:
            where.append('(c.display_name ILIKE ? OR c.company_name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ? OR c.gstin ILIKE ?)')
            p += [f'%{search}%'] * 5
        order = {'display_name': 'lower(c.display_name), c.id', 'created': 'c.id DESC', 'company': 'c.company_name, c.id'}.get(sort) or 'c.display_name, c.id'
        rows = all(f'''SELECT c.id, c.type, c.display_name, c.company_name, c.email, c.phone, c.gstin, c.currency, c.is_active, c.place_of_supply,
            c.gst_treatment, c.payment_term_id,
            (SELECT COALESCE(SUM(CASE WHEN c.type='vendor' THEN l.credit - l.debit ELSE l.debit - l.credit END),0) FROM ledger l
              JOIN accounts a ON a.id = l.account_id WHERE l.contact_id = c.id AND l.org_id = c.org_id AND a.org_id = c.org_id AND a.system_code IN ('ar','ap')) AS outstanding
          FROM contacts c WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?''', *p, per_page, (page - 1) * per_page)
        return [{**x, 'outstanding': round2(x['outstanding'])} for x in rows]
    r.get('/contacts', perm('contacts', 'view'), list_contacts)

    r.get('/contacts/:id', perm('contacts', 'view'), lambda req: load_contact(req.org['id'], to_int(req.params['id'])))

    def create(req):
        def _do():
            o = _clean_contact(req.body)
            if not o.get('display_name'):
                raise bad('Display name is required')
            if o.get('type') not in ('customer', 'vendor'):
                raise bad('Type must be customer or vendor')
            dup = get('SELECT id FROM contacts WHERE org_id = ? AND type = ? AND lower(display_name) = lower(?)', req.org['id'], o['type'], o['display_name'])
            if dup and not truthy(req.body.get('allow_duplicate')):
                raise bad(f"A {o['type']} named \"{o['display_name']}\" already exists")
            if not o.get('currency'):
                o['currency'] = req.org['currency']
            cid = insert('contacts', {**o, 'org_id': req.org['id'], 'portal_token': token(18)})
            if truthy(req.body.get('opening_balance')):
                _post_opening(req.org, cid, o['type'], req.body['opening_balance'], req.body.get('opening_balance_date'))
            audit(req, 'contact', cid, 'created', o['display_name'])
            return load_contact(req.org['id'], cid)
        return tx(_do)
    r.post('/contacts', perm('contacts', 'create'), create)

    def edit(req):
        def _do():
            c = load_contact(req.org['id'], to_int(req.params['id']))
            o = _clean_contact(req.body)
            o.pop('type', None)
            if 'display_name' in o and o['display_name'] is None:
                raise bad('Display name is required')
            update('contacts', c['id'], o)
            if 'opening_balance' in req.body:
                _post_opening(req.org, c['id'], c['type'], req.body['opening_balance'], req.body.get('opening_balance_date') or c['opening_balance_date'])
            audit(req, 'contact', c['id'], 'updated')
            return load_contact(req.org['id'], c['id'])
        return tx(_do)
    r.put('/contacts/:id', perm('contacts', 'edit'), edit)

    def set_status(req):
        cid = load_contact(req.org['id'], to_int(req.params['id']))['id']
        active = truthy(req.body.get('active'))
        update('contacts', cid, {'is_active': 1 if active else 0})
        audit(req, 'contact', cid, 'marked active' if active else 'marked inactive')
        return load_contact(req.org['id'], cid)
    r.post('/contacts/:id/status', perm('contacts', 'edit'), set_status)

    def delete(req):
        c = load_contact(req.org['id'], to_int(req.params['id']))
        used = get('''SELECT (SELECT COUNT(*) FROM documents WHERE contact_id = ?) + (SELECT COUNT(*) FROM payments WHERE contact_id = ?)
                      + (SELECT COUNT(*) FROM expenses WHERE vendor_id = ? OR customer_id = ?) n''', c['id'], c['id'], c['id'], c['id'])['n']
        if used:
            raise bad('This contact has transactions. Mark it as inactive instead.')
        unpost_opening(req.org, 'contact_opening', c['id'])
        run('DELETE FROM contacts WHERE id = ?', c['id'])
        audit(req, 'contact', c['id'], 'deleted', c['display_name'])
        return {'ok': True}
    r.delete('/contacts/:id', perm('contacts', 'delete'), delete)

    def _money_view(req):
        # credits and open documents feed the payment and credit forms, so sales or purchases view also qualifies
        if not (can(req, 'contacts', 'view') or can(req, 'sales', 'view') or can(req, 'purchases', 'view')):
            raise forbidden()

    r.get('/contacts/:id/credits', _money_view, lambda req: available_credits(req.org['id'], to_int(req.params['id'])))

    r.get('/contacts/:id/open-documents', _money_view, lambda req: all('''SELECT id, doc_type, number, date, due_date, total, balance, currency, exchange_rate FROM documents
        WHERE org_id = ? AND contact_id = ? AND doc_type IN ('invoice','bill','retainer') AND status = 'open' AND balance > 0.004 ORDER BY date, id''',
        req.org['id'], to_int(req.params['id'])))

    def transactions(req):
        cid = to_int(req.params['id'])
        oid = req.org['id']
        return {
            'documents': all('SELECT id, doc_type, number, date, due_date, total, balance, status FROM documents WHERE org_id = ? AND contact_id = ? ORDER BY date DESC, id DESC', oid, cid),
            'payments': all('SELECT id, type, number, date, amount, mode, reference FROM payments WHERE org_id = ? AND contact_id = ? ORDER BY date DESC, id DESC', oid, cid),
            'expenses': all('SELECT id, date, total, reference, status FROM expenses WHERE org_id = ? AND (vendor_id = ? OR customer_id = ?) AND is_profile = 0 ORDER BY date DESC, id DESC', oid, cid, cid),
        }
    r.get('/contacts/:id/transactions', perm('contacts', 'view'), transactions)
