"""Customers & vendors CRUD with balances (port of modules/contacts.js)."""
import json
import re

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found, forbidden
from books.core.util import token, audit, round2, today, like_pattern, clean_custom_fields, assert_owned
from books.core.auth import perm, can
from books.core.documents import DOC_TYPES
from books.core.jsutil import to_int, truthy, jsnum
from books.core.ledger import sys_account, repost_opening, unpost_opening
from books.core.payments import available_credits

FIELDS = ['type', 'customer_type', 'display_name', 'company_name', 'salutation', 'first_name', 'last_name', 'email', 'phone', 'mobile',
          'website', 'currency', 'payment_term_id', 'gst_treatment', 'gstin', 'pan', 'place_of_supply', 'tax_id', 'billing_address',
          'shipping_address', 'contact_persons', 'notes', 'credit_limit', 'price_list_id', 'portal_enabled', 'reminders_enabled',
          'linked_contact_id', 'custom_fields', 'is_active', 'tds_section_id']
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
        if j == 'custom_fields' and j in o:
            o[j] = clean_custom_fields(o[j])
        elif isinstance(o.get(j), (dict, list)):
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


def contact_out(req, c):
    """The portal token opens the customer's invoices, payments and a public pay page: hide it from roles without
    sales:view."""
    if not can(req, 'sales', 'view'):
        c = {k: v for k, v in c.items() if k != 'portal_token'}
    if not can(req, 'sales' if c.get('type') == 'customer' else 'purchases', 'view'):
        # AR/AP figures are sales/purchases data
        c = {k: v for k, v in c.items() if k not in ('outstanding', 'unused_credits', 'opening_balance', 'opening_balance_date')}
    return c


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
        pat = like_pattern(search)
        if pat:
            where.append('(c.display_name ILIKE ? OR c.company_name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ? OR c.gstin ILIKE ?)')
            p += [pat] * 5
        order = {'display_name': 'lower(c.display_name), c.id', 'created': 'c.id DESC', 'company': 'c.company_name, c.id'}.get(sort) or 'c.display_name, c.id'
        rows = all(f'''SELECT c.id, c.type, c.display_name, c.company_name, c.email, c.phone, c.gstin, c.currency, c.is_active, c.place_of_supply,
            c.gst_treatment, c.payment_term_id, c.tds_section_id,
            (SELECT COALESCE(SUM(CASE WHEN c.type='vendor' THEN l.credit - l.debit ELSE l.debit - l.credit END),0) FROM ledger l
              JOIN accounts a ON a.id = l.account_id WHERE l.contact_id = c.id AND l.org_id = c.org_id AND a.org_id = c.org_id AND a.system_code IN ('ar','ap')) AS outstanding
          FROM contacts c WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?''', *p, per_page, (page - 1) * per_page)
        side = {'customer': can(req, 'sales', 'view'), 'vendor': can(req, 'purchases', 'view')}
        return [{**x, 'outstanding': round2(x['outstanding']) if side.get(x.get('type')) else None} for x in rows]
    r.get('/contacts', perm('contacts', 'view'), list_contacts)

    r.get('/contacts/:id', perm('contacts', 'view'), lambda req: contact_out(req, load_contact(req.org['id'], to_int(req.params['id']))))

    def create(req):
        def _do():
            o = _clean_contact(req.body)
            assert_owned(req.org['id'], 'tds_sections', [o.get('tds_section_id')], 'TDS section')
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
                if not can(req, 'accountant', 'edit'):
                    raise forbidden('Opening balances post to the ledger and need accountant access')
                _post_opening(req.org, cid, o['type'], req.body['opening_balance'], req.body.get('opening_balance_date'))
            audit(req, 'contact', cid, 'created', o['display_name'])
            return contact_out(req, load_contact(req.org['id'], cid))
        return tx(_do)
    r.post('/contacts', perm('contacts', 'create'), create)

    def edit(req):
        def _do():
            c = load_contact(req.org['id'], to_int(req.params['id']))
            o = _clean_contact(req.body)
            assert_owned(req.org['id'], 'tds_sections', [o.get('tds_section_id')], 'TDS section')
            o.pop('type', None)
            if 'display_name' in o and o['display_name'] is None:
                raise bad('Display name is required')
            # The address and reminder flag decide where invoices, reminders and share links are mailed.
            side = 'sales' if c['type'] == 'customer' else 'purchases'
            if (('email' in o and (o['email'] or '') != (c.get('email') or ''))
                    or ('reminders_enabled' in o and truthy(o['reminders_enabled']) != truthy(c.get('reminders_enabled')))) and not can(req, side, 'view'):
                raise forbidden(f'Changing where documents are emailed needs {side} access')
            update('contacts', c['id'], o)
            if 'opening_balance' in req.body:
                amt = round2(jsnum(req.body.get('opening_balance')))
                changed = amt != round2(jsnum(c.get('opening_balance'))) or (
                    amt and (req.body.get('opening_balance_date') or c['opening_balance_date']) != c['opening_balance_date'])
                if changed and not can(req, 'accountant', 'edit'):
                    raise forbidden('Opening balances post to the ledger and need accountant access')
                _post_opening(req.org, c['id'], c['type'], req.body['opening_balance'], req.body.get('opening_balance_date') or c['opening_balance_date'])
            audit(req, 'contact', c['id'], 'updated')
            return contact_out(req, load_contact(req.org['id'], c['id']))
        return tx(_do)
    r.put('/contacts/:id', perm('contacts', 'edit'), edit)

    def set_status(req):
        cid = load_contact(req.org['id'], to_int(req.params['id']))['id']
        active = truthy(req.body.get('active'))
        update('contacts', cid, {'is_active': 1 if active else 0})
        audit(req, 'contact', cid, 'marked active' if active else 'marked inactive')
        return contact_out(req, load_contact(req.org['id'], cid))
    r.post('/contacts/:id/status', perm('contacts', 'edit'), set_status)

    def delete(req):
        c = load_contact(req.org['id'], to_int(req.params['id']))
        from books.modules.contacts_extra import _used_count  # noqa: PLC0415 (contacts_extra imports this module)
        if _used_count(c['id'], req.org['id']):
            raise bad('This contact has transactions. Mark it as inactive instead.')
        unpost_opening(req.org, 'contact_opening', c['id'])
        run('DELETE FROM contacts WHERE id = ?', c['id'])
        audit(req, 'contact', c['id'], 'deleted', c['display_name'])
        return {'ok': True}
    r.delete('/contacts/:id', perm('contacts', 'delete'), delete)

    def _money_view(req):
        # Credits and open documents feed the payment and credit forms, so the view right of the contact's own side
        # (customer -> sales, vendor -> purchases) also qualifies; the other side's right does not.
        c = get('SELECT type FROM contacts WHERE id = ? AND org_id = ?', to_int(req.params['id']), req.org['id'])
        if not c or not can(req, 'sales' if c['type'] == 'customer' else 'purchases', 'view'):
            raise forbidden()

    r.get('/contacts/:id/credits', _money_view, lambda req: available_credits(req.org['id'], to_int(req.params['id'])))

    r.get('/contacts/:id/open-documents', _money_view, lambda req: all('''SELECT id, doc_type, number, date, due_date, total, tax_total, balance, currency, exchange_rate FROM documents
        WHERE org_id = ? AND contact_id = ? AND doc_type IN ('invoice','bill','retainer') AND status = 'open' AND balance > 0.004 ORDER BY date, id''',
        req.org['id'], to_int(req.params['id'])))

    def transactions(req):
        # contacts:view opens the contact, not its money: each list needs the view right of the module that owns it.
        cid = to_int(req.params['id'])
        oid = req.org['id']
        sales, purchases = can(req, 'sales', 'view'), can(req, 'purchases', 'view')
        types = [t for t, d in DOC_TYPES.items() if (sales if d.get('side') == 'sales' else purchases)]
        pay = [t for t, ok in (('received', sales), ('made', purchases)) if ok]
        marks = lambda xs: ','.join('?' * len(xs))  # noqa: E731
        return {
            'documents': all(f'SELECT id, doc_type, number, date, due_date, total, balance, status FROM documents WHERE org_id = ? AND contact_id = ? AND doc_type IN ({marks(types)}) ORDER BY date DESC, id DESC', oid, cid, *types) if types else [],
            'payments': all(f'SELECT id, type, number, date, amount, mode, reference FROM payments WHERE org_id = ? AND contact_id = ? AND type IN ({marks(pay)}) ORDER BY date DESC, id DESC', oid, cid, *pay) if pay else [],
            'expenses': all('SELECT id, date, total, reference, status FROM expenses WHERE org_id = ? AND (vendor_id = ? OR customer_id = ?) AND is_profile = 0 ORDER BY date DESC, id DESC', oid, cid, cid) if purchases else [],
        }
    r.get('/contacts/:id/transactions', perm('contacts', 'view'), transactions)
