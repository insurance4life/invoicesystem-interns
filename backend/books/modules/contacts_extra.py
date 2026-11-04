"""Contacts extras: account statements (+ email), contact import, merge, bulk actions, and items import
(port of modules/contacts_extra.js)."""
import re

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found, forbidden, HttpError  # noqa: F401 (HttpError re-exported for callers)
from books.core.util import audit, org_settings, token, today, assert_unlocked
from books.core.auth import perm, can
from books.core.calc import round2, INDIAN_STATES
from books.core.ledger import post, sys_account, add_stock_move, repost_opening, unpost_opening
from books.core.mailer import send_email, fill_template, DEFAULT_TEMPLATES
from books.core.jsutil import truthy, to_fixed2
from books.modules.inventory import js_number, num_or, jstr, js_str, sql_num, body_of, db_row

GSTIN_RE = re.compile(r'[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]')
EMAIL_RE = re.compile(r'[^\s@]+@[^\s@]+\.[^\s@]+')
FAR_PAST = '0000-01-01'
FAR_FUTURE = '9999-12-31'
MAX_BULK = 1000  # ids per bulk update or merge

# Ledger src_type -> readable statement label
LABELS = {
    'invoice': 'Invoice', 'retainer': 'Retainer Invoice', 'salesreceipt': 'Sales Receipt', 'creditnote': 'Credit Note',
    'payment_received': 'Payment Received', 'bill': 'Bill', 'vendorcredit': 'Vendor Credit', 'payment_made': 'Payment Made',
    'refund': 'Refund', 'writeoff': 'Write Off', 'contact_opening': 'Opening Balance', 'contact_opening_merged': 'Opening Balance',
    'journal': 'Journal', 'expense': 'Expense', 'inventory_adjustment': 'Inventory Adjustment',
}

UPDATABLE = ['customer_type', 'salutation', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'mobile', 'website', 'currency',
             'payment_term_id', 'gst_treatment', 'gstin', 'pan', 'place_of_supply', 'tax_id', 'credit_limit', 'price_list_id',
             'portal_enabled', 'reminders_enabled', 'notes']


def _or(v, default):
    """JS `v || default` for request values."""
    return v if truthy(v) else default


def _err_message(e):
    """e.message for HttpError, else the exception text."""
    return e.message if isinstance(e, HttpError) else str(e)


def _truthy_flag(v):
    """Local `truthy` of contacts_extra.js: true / 1 / '1' / 'true' / 'yes' / 'y' (case-insensitive, trimmed)."""
    if v is True:
        return True
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v == 1:
        return True
    return jstr(v).strip().lower() in ('1', 'true', 'yes', 'y')


# ---------------------------------------------------------------- statements
def _statement_number(l):
    if l['src_type'] == 'refund':
        ref = (get('SELECT reference FROM refunds WHERE id = ?', l['src_id']) or {}).get('reference')
        return ref or 'REF-' + jstr(l['src_id'])
    if l['src_type'] in ('contact_opening', 'contact_opening_merged'):
        return 'Opening Balance'
    return l.get('number') or ''


def statement_for(org, c, frm=FAR_PAST, to=FAR_FUTURE):
    """Account statement for a customer (AR) or vendor (AP).
    Positive balance = the contact owes the org (customer) / the org owes the contact (vendor)."""
    acc = sys_account(org['id'], 'ap' if c['type'] == 'vendor' else 'ar')
    sign = -1 if c['type'] == 'vendor' else 1  # net effect on the balance for each debit/credit
    ob = get('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ledger WHERE org_id = ? AND account_id = ? AND contact_id = ? AND date < ?',
             org['id'], acc, c['id'], frm)
    opening = round2(sign * (ob['d'] - ob['c']))
    grouped = all('''SELECT src_type, src_id, date, MAX(number) AS number, MAX(description) AS description,
        SUM(debit) AS debit, SUM(credit) AS credit
      FROM ledger WHERE org_id = ? AND account_id = ? AND contact_id = ? AND date >= ? AND date <= ?
      GROUP BY src_type, src_id, date ORDER BY date, MIN(id)''', org['id'], acc, c['id'], frm, to)
    bal = opening
    total_amount = 0
    total_payments = 0
    rows = []
    for l in grouped:
        net = round2(sign * (l['debit'] - l['credit']))
        bal = round2(bal + net)
        amount = net if net > 0 else 0
        payments = -net if net < 0 else 0
        total_amount = round2(total_amount + amount)
        total_payments = round2(total_payments + payments)
        rows.append({
            'date': l['date'], 'type': LABELS.get(l['src_type']) or l['src_type'].replace('_', ' '), 'src_type': l['src_type'],
            'number': _statement_number(l), 'ref_id': l['src_id'], 'details': l.get('description') or '',
            'amount': round2(amount), 'payments': round2(payments), 'balance': bal,
        })
    o = parse_json(get('SELECT name, address, gstin, email, phone, currency, date_format FROM orgs WHERE id = ?', org['id']), ['address'])
    cur = c.get('currency') or org.get('currency')
    return {
        'contact': {'id': c['id'], 'type': c['type'], 'display_name': c.get('display_name'), 'company_name': c.get('company_name'),
                    'email': c.get('email'), 'phone': c.get('phone'), 'gstin': c.get('gstin'),
                    'billing_address': c.get('billing_address'), 'currency': cur},
        'org': o, 'currency': cur, 'from': frm, 'to': to,
        'opening_balance': opening, 'rows': rows, 'closing_balance': bal, 'total_amount': total_amount,
        'total_payments': total_payments,
    }


def _statement(req):
    from books.modules.contacts import load_contact  # noqa: PLC0415 (loaded lazily: contacts is ported separately)
    c = load_contact(req.org['id'], sql_num(req.params['id']))
    return statement_for(req.org, c, _or(req.query.get('from'), FAR_PAST), _or(req.query.get('to'), FAR_FUTURE))


def _statement_email(req):
    from books.modules.contacts import load_contact  # noqa: PLC0415
    org = req.org
    body = body_of(req)
    c = load_contact(org['id'], sql_num(req.params['id']))
    to = js_str(body.get('to')) or (c.get('email') or '')
    if not to:
        raise bad('Enter the recipient email address')
    st = statement_for(org, c, _or(body.get('period_from'), FAR_PAST), _or(body.get('period_to'), FAR_FUTURE))
    tpl = _or((org_settings(org).get('email_templates') or {}).get('statement'), DEFAULT_TEMPLATES['statement'])
    fill_vars = {
        'contact_name': c.get('display_name'), 'org_name': org.get('name'), 'currency': st['currency'],
        'balance': to_fixed2(round2(st['closing_balance'])), 'number': '', 'date': today(), 'due_date': '', 'total': '', 'link': '',
    }
    subject = js_str(body.get('subject')) or fill_template(tpl.get('subject'), fill_vars)
    text = js_str(body.get('body')) or fill_template(tpl.get('body'), fill_vars)
    email_id = send_email(org, to, subject, text, entity_type='contact', entity_id=c['id'], cc=body.get('cc'))
    audit(req, 'contact', c['id'], 'statement emailed', to)
    return {'ok': True, 'email_id': email_id}


# ---------------------------------------------------------------- contact import helpers
def _used_count(cid, org_id):
    """Every record that refers to the contact. Contact ids are plain integers, so whatever is not counted here would be
    left pointing at a deleted contact (journal and bank postings, payment links, projects, line-level customers)."""
    return get('''SELECT (SELECT COUNT(*) FROM documents WHERE contact_id = ? AND org_id = ?)
                    + (SELECT COUNT(*) FROM payments WHERE contact_id = ? AND org_id = ?)
                    + (SELECT COUNT(*) FROM expenses WHERE (vendor_id = ? OR customer_id = ?) AND org_id = ?)
                    + (SELECT COUNT(*) FROM ledger WHERE contact_id = ? AND org_id = ? AND src_type != 'contact_opening')
                    + (SELECT COUNT(*) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.contact_id = ? AND j.org_id = ?)
                    + (SELECT COUNT(*) FROM bank_txns WHERE contact_id = ? AND org_id = ?)
                    + (SELECT COUNT(*) FROM payment_links WHERE contact_id = ? AND org_id = ?)
                    + (SELECT COUNT(*) FROM projects WHERE customer_id = ? AND org_id = ?)
                    + (SELECT COUNT(*) FROM document_lines dl JOIN documents d ON d.id = dl.document_id WHERE dl.customer_id = ? AND d.org_id = ?) AS n''',
               cid, org_id, cid, org_id, cid, cid, org_id, cid, org_id, cid, org_id, cid, org_id, cid, org_id, cid, org_id, cid, org_id)['n']


def _post_opening(org, cid, typ, amount, date):
    """Contact opening balance -> ledger (AR Dr / Opening Balance Offset Cr for customers, reversed for vendors)."""
    amount = round2(amount)
    if not amount:
        return unpost_opening(org, 'contact_opening', cid)
    ctrl = sys_account(org['id'], 'ap' if typ == 'vendor' else 'ar')
    off = sys_account(org['id'], 'opening_balance_offset')
    if typ == 'vendor':
        lines = [{'account_id': off, 'debit': amount}, {'account_id': ctrl, 'credit': amount, 'contact_id': cid}]
    else:
        lines = [{'account_id': ctrl, 'debit': amount, 'contact_id': cid}, {'account_id': off, 'credit': amount}]
    repost_opening(org, 'contact_opening', cid, date if truthy(date) else today(), lines, number='Opening Balance', contact_id=cid)


def _state_code(v):
    s = js_str(v)
    if not s:
        return None
    if re.fullmatch(r'[0-9]{2}', s):
        if not any(code == s for code, _name in INDIAN_STATES):
            raise bad(f'Unknown place of supply code "{s}"')
        return s
    hit = next((code for code, name in INDIAN_STATES if name.lower() == s.lower()), None)
    if hit is None:
        raise bad(f'Unknown place of supply "{s}"')
    return hit


def _import_contact(org, typ, raw):
    display_name = (js_str(raw.get('display_name')) or js_str(raw.get('company_name'))
                    or ' '.join(x for x in [js_str(raw.get('first_name')), js_str(raw.get('last_name'))] if x))
    if not display_name:
        raise bad('Display name is required')
    gstin = js_str(raw.get('gstin')).upper()
    if gstin and not GSTIN_RE.fullmatch(gstin):
        raise bad(f'GSTIN "{gstin}" is not valid')
    email = js_str(raw.get('email'))
    if email and not EMAIL_RE.fullmatch(email):
        raise bad(f'Email "{email}" is not valid')
    place_of_supply = _state_code(raw.get('place_of_supply')) or (gstin[:2] if gstin else None)
    opening = 0
    if js_str(raw.get('opening_balance')) != '':
        opening = js_number(raw.get('opening_balance'))
        if opening != opening:
            raise bad('Opening balance must be a number')

    def addr(p):
        a = {'street': js_str(raw.get(p + '_street')), 'city': js_str(raw.get(p + '_city')),
             'state': js_str(raw.get(p + '_state')), 'zip': js_str(raw.get(p + '_zip'))}
        return a if any(a.values()) else None

    dup = get('SELECT id FROM contacts WHERE org_id = ? AND type = ? AND lower(display_name) = lower(?)', org['id'], typ, display_name)
    fields = {
        'org_id': org['id'], 'type': typ, 'display_name': display_name,
        'customer_type': 'individual' if js_str(raw.get('customer_type')).lower() == 'individual' else 'business',
        'company_name': js_str(raw.get('company_name')) or None, 'first_name': js_str(raw.get('first_name')) or None,
        'last_name': js_str(raw.get('last_name')) or None,
        'salutation': js_str(raw.get('salutation')) or None, 'email': email or None, 'phone': js_str(raw.get('phone')) or None,
        'mobile': js_str(raw.get('mobile')) or None,
        'website': js_str(raw.get('website')) or None, 'currency': js_str(raw.get('currency')) or org.get('currency'),
        'gstin': gstin or None, 'pan': js_str(raw.get('pan')).upper() or None,
        'gst_treatment': js_str(raw.get('gst_treatment')) or ('registered' if gstin else None),
        'place_of_supply': place_of_supply, 'notes': js_str(raw.get('notes')) or None,
        'billing_address': addr('billing'), 'shipping_address': addr('shipping'), 'portal_token': token(18),
    }
    return {'dup': dup, 'display_name': display_name, 'opening': opening, 'fields': fields}


def _import_contacts(req):
    body = body_of(req)
    org = req.org
    typ = body.get('type')
    if typ not in ('customer', 'vendor'):
        raise bad('Type must be customer or vendor')
    rows = body['rows'] if isinstance(body.get('rows'), list) else []
    if not rows:
        raise bad('There are no rows to import')
    if len(rows) > 5000:
        raise bad('Import at most 5000 rows at a time')
    out = {'created': 0, 'skipped': 0, 'errors': []}
    for i, raw in enumerate(rows):
        raw = raw if isinstance(raw, dict) else {}
        try:
            p = _import_contact(org, typ, raw)
            if p['dup']:
                if truthy(body.get('skip_duplicates')):
                    out['skipped'] += 1
                    continue
                raise bad(f'A {typ} named "{p["display_name"]}" already exists')

            def _do(p=p, raw=raw):
                cid = insert('contacts', db_row(p['fields']))
                if p['opening']:
                    _post_opening(org, cid, typ, p['opening'], raw.get('opening_balance_date'))
                audit(req, 'contact', cid, 'imported', p['display_name'])
            tx(_do)
            out['created'] += 1
        except Exception as e:  # noqa: BLE001 - every row error is reported, like the Node catch
            out['errors'].append({'row': i + 1, 'error': _err_message(e) or 'Could not import this row'})
    return out


# ---------------------------------------------------------------- merge / bulk
def _assert_merge_unlocked(org, cid):
    oid = org['id']
    for r in all('SELECT doc_type, MIN(date) AS d FROM documents WHERE contact_id = ? AND org_id = ? GROUP BY doc_type', cid, oid):
        assert_unlocked(org, r['d'], r['doc_type'])
    for r in all('SELECT type, MIN(date) AS d FROM payments WHERE contact_id = ? AND org_id = ? GROUP BY type', cid, oid):
        assert_unlocked(org, r['d'], 'payment_received' if r['type'] == 'received' else 'payment_made')
    for sql, args, kind in [('SELECT MIN(date) AS d FROM expenses WHERE (vendor_id = ? OR customer_id = ?) AND org_id = ?', (cid, cid, oid), 'expense'),
                            ('SELECT MIN(date) AS d FROM bank_txns WHERE contact_id = ? AND org_id = ?', (cid, oid), 'bank'),
                            ('SELECT MIN(date) AS d FROM ledger WHERE contact_id = ? AND org_id = ?', (cid, oid), 'journal')]:
        d = get(sql, *args)['d']
        if d:
            assert_unlocked(org, d, kind)


def _merge(req):
    from books.modules.contacts import load_contact  # noqa: PLC0415

    def _do():
        org = req.org
        body = body_of(req)
        target = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', sql_num(body.get('target_id')), org['id'])
        if not target:
            raise not_found('Contact')
        raw_sources = body['source_ids'] if truthy(body.get('source_ids')) else []
        if not isinstance(raw_sources, list):
            raw_sources = []
        if len(raw_sources) > MAX_BULK:
            raise bad(f'Merge at most {MAX_BULK} contacts at a time')
        source_ids, seen = [], set()
        for raw in raw_sources:
            n = js_number(raw)
            if n == n and n != 0 and n != target['id'] and n not in seen:
                seen.add(n)
                source_ids.append(n)
        if not source_ids:
            raise bad('Choose at least one other contact to merge into this one')
        for sid in source_ids:
            s = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', sql_num(sid), org['id'])
            if not s:
                raise not_found('Contact')
            if s['type'] != target['type']:
                raise bad('Only contacts of the same type can be merged')
            # Merging re-attributes every record of the source, so none may sit in a locked period, checked against the
            # lock area of each record kind (sales, purchases, banking), not just the accountant lock.
            _assert_merge_unlocked(org, s['id'])
            moved_docs = all('SELECT id FROM documents WHERE contact_id = ? AND org_id = ?', s['id'], org['id'])
            run('UPDATE documents SET contact_id = ? WHERE contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            for d in moved_docs:  # share links were issued to the source contact, as on a normal contact change
                update('documents', d['id'], {'share_token': token(18)})
            run('UPDATE payments SET contact_id = ? WHERE contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE expenses SET vendor_id = ? WHERE vendor_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE expenses SET customer_id = ? WHERE customer_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            # the source's opening balance keeps its amount but no longer belongs to the (deleted) source's posting key
            run("UPDATE ledger SET src_type = 'contact_opening_merged' WHERE src_type = 'contact_opening' AND src_id = ? AND org_id = ?",
                s['id'], org['id'])
            run('UPDATE ledger SET contact_id = ? WHERE contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE journal_lines SET contact_id = ? WHERE contact_id = ? AND journal_id IN (SELECT id FROM journals WHERE org_id = ?)',
                target['id'], s['id'], org['id'])
            run('UPDATE bank_txns SET contact_id = ? WHERE contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE payment_links SET contact_id = ? WHERE contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE projects SET customer_id = ? WHERE customer_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('UPDATE document_lines SET customer_id = ? WHERE customer_id = ? AND document_id IN (SELECT id FROM documents WHERE org_id = ?)',
                target['id'], s['id'], org['id'])
            run("UPDATE comments SET entity_id = ? WHERE entity_type = 'contact' AND entity_id = ? AND org_id = ?",
                target['id'], s['id'], org['id'])
            run("UPDATE activity SET entity_id = ? WHERE entity_type = 'contact' AND entity_id = ? AND org_id = ?",
                target['id'], s['id'], org['id'])
            run('UPDATE contacts SET linked_contact_id = ? WHERE linked_contact_id = ? AND org_id = ?', target['id'], s['id'], org['id'])
            run('DELETE FROM contacts WHERE id = ?', s['id'])
            audit(req, 'contact', target['id'], 'merged', s['display_name'])
        return load_contact(org['id'], target['id'])
    return tx(_do)


def _clean_patch(fields):
    fields = fields if isinstance(fields, dict) else {}
    o = {}
    for f in UPDATABLE:
        if f in fields:
            o[f] = None if fields[f] == '' else fields[f]
    if truthy(o.get('gstin')):
        o['gstin'] = js_str(o['gstin']).upper()
        if not GSTIN_RE.fullmatch(o['gstin']):
            raise bad(f'GSTIN "{o["gstin"]}" is not valid')
    return o


def _bulk(req):
    def _do():
        body = body_of(req)
        ids = body['ids'] if 'ids' in body else []
        action = body.get('action')
        fields = body['fields'] if 'fields' in body else {}
        if action not in ('activate', 'deactivate', 'delete', 'update'):
            raise bad('Unknown bulk action')
        if not can(req, 'contacts', 'delete' if action == 'delete' else 'edit'):
            raise forbidden()
        if isinstance(ids, list) and len(ids) > MAX_BULK:
            raise bad(f'Update at most {MAX_BULK} contacts at a time')
        out = {'done': 0, 'failed': []}
        for raw in (ids if isinstance(ids, list) else []):
            cid = js_number(raw)

            def _one(cid=cid):
                c = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', sql_num(cid), req.org['id'])
                if not c:
                    raise not_found('Contact')
                if action in ('activate', 'deactivate'):
                    update('contacts', cid, {'is_active': 1 if action == 'activate' else 0})
                elif action == 'update':
                    o = _clean_patch(fields)
                    if not o:
                        raise bad('Nothing to update')
                    update('contacts', cid, o)
                else:
                    if _used_count(sql_num(cid), req.org['id']):
                        raise bad('This contact has transactions. Mark it as inactive instead.')
                    unpost_opening(req.org, 'contact_opening', cid)
                    run('DELETE FROM contacts WHERE id = ?', cid)
                audit(req, 'contact', cid, f'bulk {action}', c['display_name'])

            try:
                tx(_one)  # a failing row leaves no partial writes; the other rows carry on
                out['done'] += 1
            except Exception as e:  # noqa: BLE001
                out['failed'].append({'id': cid, 'error': _err_message(e)})
        return out
    return tx(_do)


# ---------------------------------------------------------------- items import
def _post_item_opening(org, item):
    s = org_settings(org)
    if not item['track_inventory'] or not (item['opening_stock'] > 0):
        return
    date = _or(s['preferences'].get('inventory_start_date'), today())
    rate = round2(item['opening_stock_rate'] or item['purchase_price'] or 0)
    assert_unlocked(org, date, 'journal')
    add_stock_move(org['id'], item['id'], date, item['opening_stock'], rate, 'item_opening', item['id'])
    value = round2(item['opening_stock'] * rate)
    if value:
        post(org['id'], 'item_opening', item['id'], date=date, number='Opening Stock', lines=[
            {'account_id': item['inventory_account_id'] or sys_account(org['id'], 'inventory'), 'debit': value,
             'description': f"Opening stock {jstr(item['name'])}"},
            {'account_id': sys_account(org['id'], 'opening_balance_offset'), 'credit': value},
        ])


def _items_import(req):
    def _do():
        org = req.org
        body = body_of(req)
        rows = body['rows'] if isinstance(body.get('rows'), list) else []
        if not rows:
            raise bad('There are no rows to import')
        if len(rows) > 5000:
            raise bad('Import at most 5000 rows at a time')
        s = org_settings(org)
        taxes = all('SELECT id, name FROM taxes WHERE org_id = ? ORDER BY id', org['id'])
        out = {'created': 0, 'skipped': 0, 'errors': []}
        for i, raw in enumerate(rows):
            raw = raw if isinstance(raw, dict) else {}
            try:
                name = js_str(raw.get('name'))
                if not name:
                    raise bad('Item name is required')
                typ = 'service' if js_str(raw.get('type')).lower() == 'service' else 'goods'
                sku = js_str(raw.get('sku')) or None
                if sku and truthy(s['preferences'].get('duplicate_sku_check')) and get('SELECT id FROM items WHERE org_id = ? AND sku = ?', org['id'], sku):
                    if truthy(body.get('skip_duplicates')):
                        out['skipped'] += 1
                        continue
                    raise bad(f'SKU {sku} is already used')
                tax_id = None
                tax_name = js_str(raw.get('tax_name'))
                if tax_name:
                    t = next((x for x in taxes if x['name'].lower() == tax_name.lower()), None)
                    if not t:
                        raise bad(f'Tax "{jstr(raw.get("tax_name"))}" does not exist')
                    tax_id = t['id']
                track = typ == 'goods' and _truthy_flag(raw.get('track_inventory'))
                opening = num_or(raw.get('opening_stock'), 0) if track else 0
                if opening < 0:
                    raise bad('Opening stock cannot be negative')
                selling_price = num_or(raw.get('selling_price'), 0)
                purchase_price = num_or(raw.get('purchase_price'), 0)
                rate = round2(num_or(raw.get('opening_stock_rate'), 0) or purchase_price)

                def _do(raw=raw):
                    cid = insert('items', db_row({
                        'org_id': org['id'], 'type': typ, 'name': name, 'sku': sku,
                        'unit': js_str(raw.get('unit')) or None, 'hsn_sac': js_str(raw.get('hsn_sac')) or None,
                        'selling_price': selling_price, 'purchase_price': purchase_price, 'tax_id': tax_id,
                        'purchase_tax_id': tax_id, 'description': js_str(raw.get('description')) or None,
                        'sales_account_id': sys_account(org['id'], 'sales'), 'purchase_account_id': sys_account(org['id'], 'cogs'),
                        'track_inventory': 1 if track else 0,
                        'inventory_account_id': sys_account(org['id'], 'inventory') if track else None,
                        'opening_stock': opening, 'opening_stock_rate': rate, 'reorder_level': num_or(raw.get('reorder_level'), 0),
                        'is_sellable': 1, 'is_purchasable': 1, 'is_active': 1,
                    }))
                    _post_item_opening(org, {
                        'id': cid, 'name': name, 'track_inventory': 1 if track else 0, 'opening_stock': opening,
                        'opening_stock_rate': rate, 'purchase_price': purchase_price,
                        'inventory_account_id': sys_account(org['id'], 'inventory') if track else None,
                    })
                    audit(req, 'item', cid, 'imported', name)
                tx(_do)
                out['created'] += 1
            except Exception as e:  # noqa: BLE001
                out['errors'].append({'row': i + 1, 'error': _err_message(e) or 'Could not import this row'})
        return out
    return tx(_do)


# ---------------------------------------------------------------- routes
def routes(r):
    # ---------- statements ----------
    r.get('/contacts/:id/statement', perm('contacts', 'view'), _statement)
    r.post('/contacts/:id/statement/email', perm('contacts', 'edit'), _statement_email)  # sends mail: not a read
    # ---------- import ----------
    r.post('/contacts/import', perm('contacts', 'create'), _import_contacts)
    # ---------- merge ----------
    r.post('/contacts/merge', perm('contacts', 'delete'), _merge)
    # ---------- bulk ----------
    r.post('/contacts/bulk', _bulk)
    # ---------- items import ----------
    r.post('/items/import', perm('items', 'create'), _items_import)
