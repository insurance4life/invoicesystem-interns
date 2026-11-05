"""Generic sales & purchase document engine (port of documents.js)."""
import datetime
import json
import logging

from books.core.db import all, get, run, insert, update, tx, parse_json
from books.core.router import bad, not_found, HttpError, forbidden
from books.core.util import (round2, token, next_number, org_settings, assert_unlocked, assert_owned, cap_list, assert_account_types,
                             SALES_LINE_TYPES, PURCHASE_LINE_TYPES, clean_custom_fields, BANK_TYPES)
from books.core.jsutil import jsnum, jsstr, today, now_iso, truthy, to_int
from books.core.calc import compute_document, due_date_for, add_days
from books.core.auth import can
from books.core.ledger import post, unpost, sys_account, tax_account, avg_cost, clear_stock, add_stock_move

DOC_TYPES = {
    'quote': {'label': 'Quote', 'side': 'sales', 'contact': 'customer', 'posts': False, 'convert': ['invoice', 'salesorder']},
    'salesorder': {'label': 'Sales Order', 'side': 'sales', 'contact': 'customer', 'posts': False, 'convert': ['invoice', 'purchaseorder']},
    'invoice': {'label': 'Invoice', 'side': 'sales', 'contact': 'customer', 'posts': True, 'payable': True, 'convert': ['creditnote']},
    'retainer': {'label': 'Retainer Invoice', 'side': 'sales', 'contact': 'customer', 'posts': False, 'payable': True, 'convert': []},
    'creditnote': {'label': 'Credit Note', 'side': 'sales', 'contact': 'customer', 'posts': True, 'credit': True, 'convert': []},
    'deliverychallan': {'label': 'Delivery Challan', 'side': 'sales', 'contact': 'customer', 'posts': False, 'convert': ['invoice']},
    'salesreceipt': {'label': 'Sales Receipt', 'side': 'sales', 'contact': 'customer', 'posts': True, 'convert': []},
    'recurring_invoice': {'label': 'Recurring Invoice', 'side': 'sales', 'contact': 'customer', 'posts': False, 'profile': 'invoice', 'convert': []},
    'purchaseorder': {'label': 'Purchase Order', 'side': 'purchase', 'contact': 'vendor', 'posts': False, 'convert': ['bill']},
    'bill': {'label': 'Bill', 'side': 'purchase', 'contact': 'vendor', 'posts': True, 'payable': True, 'convert': ['vendorcredit']},
    'vendorcredit': {'label': 'Vendor Credit', 'side': 'purchase', 'contact': 'vendor', 'posts': True, 'credit': True, 'convert': []},
    'recurring_bill': {'label': 'Recurring Bill', 'side': 'purchase', 'contact': 'vendor', 'posts': False, 'profile': 'bill', 'convert': []},
}

JSON_COLS = ['taxes', 'billing_address', 'shipping_address', 'recurrence', 'custom_fields']
LIVE = {'open', 'closed', 'paid'}
log = logging.getLogger('openbooks')


def _has_applications(org_id, d):
    """True when payments, credits or refunds are still applied to or drawn from the document, whatever its status."""
    return bool(get('''SELECT (SELECT COUNT(*) FROM payment_allocations WHERE document_id = ?)
                         + (SELECT COUNT(*) FROM credit_applications WHERE org_id = ? AND (document_id = ? OR (source_type = ? AND source_id = ?)))
                         + (SELECT COUNT(*) FROM refunds WHERE org_id = ? AND source_type = ? AND source_id = ?) AS n''',
                    d['id'], org_id, d['id'], d['doc_type'], d['id'], org_id, d['doc_type'], d['id'])['n'])


def _j(v):
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


def type_cfg(t):
    c = DOC_TYPES.get(t)
    if not c:
        raise not_found('Document type')
    return c


def tax_ctx(org):
    taxes = {t['id']: t for t in all('SELECT * FROM taxes WHERE org_id = ?', org['id'])}
    return {'taxes': taxes, 'orgState': org.get('state'), 'gst': bool(org.get('gst_enabled')) and org.get('country') == 'India'}


def display_status(d):
    t = d.get('doc_type')
    now = today()
    if (DOC_TYPES.get(t) or {}).get('profile'):
        return d.get('status')
    st = d.get('status')
    if st in ('draft', 'pending_approval', 'void', 'declined', 'invoiced', 'billed', 'cancelled', 'returned', 'delivered', 'accepted'):
        return st
    if t in ('invoice', 'bill', 'retainer'):
        if (d.get('balance') or 0) <= 0.004:
            return 'paid'
        if d.get('due_date') and d['due_date'] < now:
            return 'overdue'
        if (d.get('balance') or 0) < (d.get('total') or 0):
            return 'partially_paid'
        return 'sent' if t == 'invoice' and d.get('sent_at') else 'open'
    if t in ('creditnote', 'vendorcredit'):
        return 'closed' if (d.get('balance') or 0) <= 0.004 else 'open'
    if t == 'quote':
        return 'expired' if d.get('due_date') and d['due_date'] < now and st == 'sent' else st
    if t == 'salesreceipt':
        return 'paid'
    return st


def load_doc(org_id, id, with_lines=True):  # noqa: A002
    d = get('''SELECT d.*, c.display_name AS contact_name, c.email AS contact_email, c.gstin AS contact_gstin
               FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id AND c.org_id = d.org_id WHERE d.id = ? AND d.org_id = ?''', id, org_id)
    if not d:
        raise not_found('Document')
    parse_json(d, JSON_COLS)
    d['display_status'] = display_status(d)
    if with_lines:
        d['lines'] = [parse_json(l, ['tax_breakdown']) for l in all('''SELECT l.*, i.name AS item_name, i.sku, a.name AS account_name FROM document_lines l
                   LEFT JOIN items i ON i.id = l.item_id AND i.org_id = ? LEFT JOIN accounts a ON a.id = l.account_id AND a.org_id = ?
                   WHERE l.document_id = ? ORDER BY l.sort, l.id''', org_id, org_id, id)]
    return d


def retainer_available(d):
    paid = get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE document_id = ?', d['id'])['s']
    used = get("SELECT COALESCE(SUM(amount),0) s FROM credit_applications WHERE source_type = 'retainer' AND source_id = ?", d['id'])['s']
    return round2(paid - used)


def doc_relations(org_id, d):
    """Everything the detail page needs: payments, credits, refunds, related docs."""
    d['payments'] = all('''SELECT pa.id AS allocation_id, pa.amount, p.id, p.number, p.date, p.mode, p.reference, p.type
                    FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.document_id = ? ORDER BY p.date, pa.id''', d['id'])
    d['credits_applied'] = all('''SELECT ca.*, COALESCE(sd.number, sp.number) AS source_number FROM credit_applications ca
                    LEFT JOIN documents sd ON ca.source_type != 'payment' AND sd.id = ca.source_id
                    LEFT JOIN payments sp ON ca.source_type = 'payment' AND sp.id = ca.source_id
                    WHERE ca.document_id = ?''', d['id'])
    if DOC_TYPES.get(d['doc_type'], {}).get('credit') or d['doc_type'] == 'retainer':
        d['applied_to'] = all('''SELECT ca.*, td.number AS document_number, td.doc_type AS document_type FROM credit_applications ca
                        JOIN documents td ON td.id = ca.document_id WHERE ca.source_type = ? AND ca.source_id = ?''', d['doc_type'], d['id'])
        d['refunds'] = all('SELECT * FROM refunds WHERE source_type = ? AND source_id = ?', d['doc_type'], d['id'])
    d['source_doc'] = get('SELECT id, doc_type, number FROM documents WHERE id = ? AND org_id = ?', d['source_doc_id'], org_id) if d.get('source_doc_id') else None
    d['children'] = all('SELECT id, doc_type, number, date, total, status FROM documents WHERE (source_doc_id = ? OR profile_id = ?) AND org_id = ? ORDER BY date DESC, id',
                        d['id'], d['id'], org_id)
    if d['doc_type'] == 'retainer':
        d['retainer_available'] = retainer_available(d)
    return d


def refresh_balance(doc_id):
    """Recompute balance of a payable or credit document from allocations."""
    d = get('SELECT id, doc_type, total, write_off, status FROM documents WHERE id = ?', doc_id)
    if not d:
        return None
    cfg = DOC_TYPES[d['doc_type']]
    balance = d['total']
    if cfg.get('payable'):
        paid = get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE document_id = ?', doc_id)['s']
        credited = get('SELECT COALESCE(SUM(amount),0) s FROM credit_applications WHERE document_id = ?', doc_id)['s']
        balance = round2(d['total'] - paid - credited - (d['write_off'] or 0))
    elif cfg.get('credit'):
        applied = get('SELECT COALESCE(SUM(amount),0) s FROM credit_applications WHERE source_type = ? AND source_id = ?', d['doc_type'], doc_id)['s']
        refunded = get('SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE source_type = ? AND source_id = ?', d['doc_type'], doc_id)['s']
        balance = round2(d['total'] - applied - refunded)
    elif d['doc_type'] == 'salesreceipt':
        balance = 0
    update('documents', doc_id, {'balance': balance})
    return balance


def _resolve_line_account(org_id, cfg, line, item):
    if cfg['side'] == 'sales':
        return line.get('account_id') or (item or {}).get('sales_account_id') or sys_account(org_id, 'sales')
    if item and item.get('track_inventory'):
        return item.get('inventory_account_id') or sys_account(org_id, 'inventory')
    return line.get('account_id') or (item or {}).get('purchase_account_id') or sys_account(org_id, 'cogs')


def _item_of(items, item_id):
    if not truthy(item_id):
        return None
    try:
        return items.get(int(item_id))
    except (TypeError, ValueError):
        return None


def _parse_text_json(s):
    try:
        return json.loads(s) if s else None
    except ValueError:
        return None


def save_document(req, type_, body, id=None):  # noqa: A002
    """Create or update a document from a request body. Returns {'doc', 'warnings'}."""
    cfg = type_cfg(type_)
    org = req.org
    settings = org_settings(org)
    body = dict(body or {})

    def _do():
        nonlocal body
        existing = load_doc(org['id'], id) if id else None
        if existing and existing['doc_type'] != type_:
            raise bad('Type mismatch')
        if existing and existing['status'] == 'void':
            raise bad('Void documents cannot be edited')
        date = body.get('date') or (existing or {}).get('date') or today()
        if cfg.get('posts') or cfg.get('payable'):
            assert_unlocked(org, date, type_)
        if existing and (cfg.get('posts') or cfg.get('payable')):
            assert_unlocked(org, existing['date'], type_)

        contact = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', body.get('contact_id'), org['id']) if truthy(body.get('contact_id')) else None
        if not contact and type_ != 'deliverychallan':
            raise bad(f"Please select a {cfg['contact']}")
        if contact and contact['type'] != cfg['contact']:
            raise bad(f"Selected contact is not a {cfg['contact']}")

        raw_lines = [l for l in (cap_list(body.get('lines'), 'lines') or []) if truthy(l.get('item_id')) or truthy(l.get('name')) or truthy(l.get('description'))
                     or truthy(l.get('account_id')) or jsnum(l.get('rate'))]
        if not raw_lines:
            raise bad('Add at least one line item')
        assert_owned(org['id'], 'items', [l.get('item_id') for l in raw_lines], 'item')
        assert_owned(org['id'], 'accounts', [l.get('account_id') for l in raw_lines] + [body.get('account_id')], 'account')
        assert_owned(org['id'], 'projects', [body.get('project_id')] + [l.get('project_id') for l in raw_lines], 'project')
        assert_owned(org['id'], 'taxes', [l.get('tax_id') for l in raw_lines], 'tax')
        assert_owned(org['id'], 'contacts', [l.get('customer_id') for l in raw_lines], 'customer')
        assert_owned(org['id'], 'payment_terms', [body.get('payment_term_id')], 'payment term')
        # a chosen line account must suit the side; other accounts are journal work (accountant:edit)
        assert_account_types(req, org['id'], [l.get('account_id') for l in raw_lines],
                             SALES_LINE_TYPES if cfg['side'] == 'sales' else PURCHASE_LINE_TYPES, 'a line account')
        rec = body.get('recurrence') if cfg.get('profile') else None
        if isinstance(rec, dict) and rec.get('auto_send') and not can(req, cfg['side'] if cfg['side'] == 'sales' else 'purchases', 'edit'):
            raise forbidden('Sending generated documents automatically needs edit access')
        if not existing:
            assert_owned(org['id'], 'documents', [body.get('source_doc_id')], 'source document')
        items = {i['id']: i for i in all('SELECT * FROM items WHERE org_id = ?', org['id'])}
        ctx = tax_ctx(org)
        pos = body.get('place_of_supply') or (contact or {}).get('place_of_supply') or org.get('state')
        calc = compute_document({**body, 'place_of_supply': pos, 'lines': raw_lines}, ctx)

        if 'payment_term_id' not in body and not existing and cfg.get('payable') and contact and contact.get('payment_term_id'):
            body = {**body, 'payment_term_id': contact['payment_term_id']}
        term = get('SELECT * FROM payment_terms WHERE id = ? AND org_id = ?', body.get('payment_term_id'), org['id']) if truthy(body.get('payment_term_id')) else None
        due = body.get('due_date') or None
        if not due and term:
            due = due_date_for(date, term)
        if not due and type_ == 'quote':
            due = add_days(date, settings['preferences'].get('quote_validity_days') or 15)
        if not due and cfg.get('payable'):
            due = date

        currency = body.get('currency') or (contact or {}).get('currency') or org.get('currency')
        rate = jsnum(body.get('exchange_rate')) or None
        if rate is not None and not rate > 0:
            raise bad('Exchange rate must be greater than zero')
        if not rate and existing and currency == existing.get('currency') and jsnum(existing.get('exchange_rate')) > 0:
            rate = jsnum(existing.get('exchange_rate'))  # an edit that does not send a rate keeps the posted one
        if not rate:
            rate = 1 if currency == org.get('currency') else ((get('SELECT exchange_rate FROM currencies WHERE org_id = ? AND code = ?', org['id'], currency) or {}).get('exchange_rate') or 1)

        def addr(key):
            if truthy(body.get(key)):
                return _j(body[key])
            if existing:
                return _j(existing.get(key))
            return _j(_parse_text_json((contact or {}).get(key)) or None)

        fields = {
            'reference': body.get('reference'), 'contact_id': (contact or {}).get('id'), 'date': date, 'due_date': due,
            'payment_term_id': body.get('payment_term_id') or None, 'currency': currency, 'exchange_rate': rate, 'place_of_supply': pos,
            'tax_inclusive': 1 if truthy(body.get('tax_inclusive')) else 0, 'discount_type': body.get('discount_type') or 'percent',
            'discount_value': jsnum(body.get('discount_value')), 'discount_total': calc['discount_total'],
            'shipping': calc['shipping'], 'adjustment': calc['adjustment'], 'adjustment_label': body.get('adjustment_label') or None,
            'subtotal': calc['subtotal'], 'tax_total': calc['tax_total'], 'taxes': _j(calc['taxes']), 'total': calc['total'],
            'notes': body.get('notes'), 'terms': body.get('terms'),
            'billing_address': addr('billing_address'), 'shipping_address': addr('shipping_address'),
            'salesperson': body.get('salesperson'), 'project_id': body.get('project_id') or None,
            'custom_fields': clean_custom_fields(body.get('custom_fields')),
            'delivery_date': body.get('delivery_date') or None,
            'account_id': body.get('account_id') or None, 'payment_mode': body.get('payment_mode') or None,
            'recurrence': _j(_norm_recurrence(body.get('recurrence', {}), date, (existing or {}).get('recurrence'))) if cfg.get('profile') else None,
            'updated_at': now_iso(),
        }
        if type_ == 'salesreceipt' and not fields['account_id']:
            fields['account_id'] = sys_account(org['id'], 'undeposited_funds')
        if type_ == 'salesreceipt':
            # the receipt debits this account, so it must be where money is received
            assert_account_types(req, org['id'], [fields['account_id']], BANK_TYPES, 'the deposit account')

        doc_id = id
        if existing and (fields['currency'] != existing.get('currency') or round(jsnum(fields['exchange_rate']), 6) != round(jsnum(existing.get('exchange_rate') or 1), 6)) \
                and _has_applications(org['id'], existing):
            # Payments and credits were posted at the old rate; changing it would leave the control account unbalanced.
            raise bad('Remove the payments and credits applied to this document before changing its currency or exchange rate')
        if existing:
            if body.get('number') and body['number'] != existing['number']:
                fields['number'] = body['number']
            if existing.get('contact_id') != fields['contact_id']:
                fields['share_token'] = token(18)  # the previous customer's link must not open the reassigned document
            update('documents', id, fields)
            run('DELETE FROM document_lines WHERE document_id = ?', id)
        else:
            number = body.get('number') or next_number(org['id'], type_)
            status = 'draft'
            if cfg.get('profile'):
                status = 'active'
            if type_ == 'salesreceipt':
                status = 'open'
            doc_id = insert('documents', {**fields, 'org_id': org['id'], 'doc_type': type_, 'number': number, 'status': status,
                                          'balance': calc['total'], 'source_doc_id': body.get('source_doc_id') or None,
                                          'share_token': token(18), 'created_by': (req.user or {}).get('id')})

        for i, l in enumerate(calc['lines']):
            item = _item_of(items, l.get('item_id'))
            desc = l.get('description')
            if desc is None:
                desc = (item.get('description') if cfg['side'] == 'sales' else item.get('purchase_description')) if item else None
            insert('document_lines', {
                'document_id': doc_id, 'sort': i, 'item_id': l.get('item_id') or None,
                'account_id': _resolve_line_account(org['id'], cfg, l, item),
                'name': l.get('name') or (item or {}).get('name') or None, 'description': desc,
                'quantity': jsnum(l.get('quantity')), 'unit': l.get('unit') or (item or {}).get('unit') or None, 'rate': jsnum(l.get('rate')),
                'discount': jsnum(l.get('discount')), 'tax_id': l.get('tax_id') or None, 'hsn_sac': l.get('hsn_sac') or (item or {}).get('hsn_sac') or None,
                'amount': l['amount'], 'taxable': l['taxable'], 'tax_amount': l['tax_amount'], 'tax_breakdown': _j(l['tax_breakdown']),
                'src_type': l.get('src_type') or None, 'src_id': l.get('src_id') or None, 'customer_id': l.get('customer_id') or None,
                'project_id': l.get('project_id') or None,
            })

        if type_ == 'invoice':
            _link_billables(org['id'], doc_id, calc['lines'])

        doc = load_doc(org['id'], doc_id)
        if existing and existing['status'] in LIVE:
            paid = round2(existing['total'] - existing['balance'])
            if cfg.get('payable') and doc['total'] + 0.001 < paid:
                raise bad(f'Total cannot be less than the amount already paid/credited ({jsstr(paid)})')
            if cfg.get('credit') and doc['total'] + 0.001 < paid:
                raise bad(f'Total cannot be less than the amount already applied/refunded ({jsstr(paid)})')
        refresh_balance(doc_id)
        fresh = load_doc(org['id'], doc_id)
        if fresh['status'] in LIVE:
            post_document(org, fresh)
        return {'doc': fresh, 'warnings': _credit_limit_warning(org, fresh, contact)}
    return tx(_do)


def _credit_limit_warning(org, doc, contact):
    if doc['doc_type'] != 'invoice' or not contact or not contact.get('credit_limit'):
        return []
    ar = get("SELECT COALESCE(SUM(balance),0) s FROM documents WHERE contact_id = ? AND doc_type = 'invoice' AND status IN ('open','pending_approval') AND id != ?",
             contact['id'], doc['id'])['s']
    if ar + doc['balance'] > contact['credit_limit']:
        return [f"This invoice takes {contact['display_name']} over their credit limit of {jsstr(contact['credit_limit'])}."]
    return []


# An entry is linked only while unbilled and only to an invoice of its own customer (or one with no customer).
_UNBILLED_EXPENSE = ("invoice_id IS NULL AND (customer_id IS NULL OR customer_id = (SELECT contact_id FROM documents WHERE id = ?))")
_UNBILLED_TIME = ("invoice_id IS NULL AND billable = 1 AND approval_status = 'approved' AND timer_started_at IS NULL AND "
                  "project_id IN (SELECT p.id FROM projects p WHERE p.org_id = ? AND "
                  "(p.customer_id IS NULL OR p.customer_id = (SELECT contact_id FROM documents WHERE id = ?)))")


def _link_time(org_id, doc_id, tid):
    run(f'UPDATE time_entries SET invoice_id = ? WHERE id = ? AND org_id = ? AND {_UNBILLED_TIME}', doc_id, tid, org_id, org_id, doc_id)


def _link_billables(org_id, doc_id, lines):
    run("UPDATE expenses SET invoice_id = NULL, status = 'unbilled' WHERE invoice_id = ? AND org_id = ?", doc_id, org_id)
    for l in lines:
        if l.get('src_type') == 'expense' and l.get('src_id'):
            run(f"UPDATE expenses SET invoice_id = ?, status = 'invoiced' WHERE id = ? AND org_id = ? AND {_UNBILLED_EXPENSE}",
                doc_id, l['src_id'], org_id, doc_id)
    # fixed-fee project lines (src_type 'project') keep the time entries they already billed
    project_ids = [int(l['src_id']) for l in lines if l.get('src_type') == 'project' and l.get('src_id')]
    keep = [r['id'] for r in all(f"SELECT id FROM time_entries WHERE invoice_id = ? AND org_id = ? AND project_id IN ({','.join('?' for _ in project_ids)})",
                                 doc_id, org_id, *project_ids)] if project_ids else []
    run('UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ? AND org_id = ?', doc_id, org_id)
    for tid in keep:
        run('UPDATE time_entries SET invoice_id = ? WHERE id = ? AND org_id = ?', doc_id, tid, org_id)
    for l in lines:
        if l.get('src_type') == 'time' and l.get('src_id'):
            _link_time(org_id, doc_id, l['src_id'])
    tids = []
    for l in lines:
        if l.get('src_type') == 'time_entries' and isinstance(l.get('src_ids'), list):
            tids.extend(l['src_ids'])
    for tid in cap_list(list(dict.fromkeys(tids)), 'time entries'):  # one budget for the whole document, not per line
        _link_time(org_id, doc_id, tid)


FREQUENCIES = ('daily', 'weekly', 'monthly', 'yearly')
RECURRING_RUN_LIMIT = 200  # documents one org can generate per run; the rest catch up on later runs


def validate_recurrence(rr):
    """Reject schedules that never advance (every < 1, fractions) or are not a known frequency."""
    if rr.get('frequency') not in FREQUENCIES:
        raise bad('Repeat frequency must be daily, weekly, monthly or yearly')
    every = rr.get('every')
    if isinstance(every, bool) or not isinstance(every, (int, float, str)):
        raise bad('Repeat every must be a whole number from 1 to 365')
    try:
        n = float(every)
    except ValueError:
        raise bad('Repeat every must be a whole number from 1 to 365') from None
    if not (n == int(n) and 1 <= n <= 365):
        raise bad('Repeat every must be a whole number from 1 to 365')
    rr['every'] = int(n)
    for k in ('start_date', 'end_date', 'next_date'):
        if rr.get(k):
            try:
                datetime.date.fromisoformat(str(rr[k])[:10])
            except ValueError:
                raise bad(f'Invalid {k.replace("_", " ")}') from None
    return rr


def _norm_recurrence(r, date, prev=None):
    if r is None:
        r = None
    rr = {'frequency': 'monthly', 'every': 1, 'start_date': date, 'end_date': None, 'auto_send': False, **(prev or {}), **(r or {})}
    if not rr.get('next_date') or (r and r.get('start_date') and (not prev or r.get('start_date') != prev.get('start_date'))):
        rr['next_date'] = rr.get('start_date') or date
    return validate_recurrence(rr)


def post_document(org, d):
    """Ledger + stock postings for a live document."""
    cfg = DOC_TYPES[d['doc_type']]
    if not cfg.get('posts'):
        return
    org_id = org['id']
    fx = jsnum(d.get('exchange_rate')) or 1

    def b(v):
        return round2(v * fx)
    lines = []
    sales_side = cfg['side'] == 'sales'
    sign = -1 if cfg.get('credit') else 1

    def dr(account_id, amt, description=None):
        lines.append({'account_id': account_id, 'debit': amt, 'description': description} if sign > 0
                     else {'account_id': account_id, 'credit': amt, 'description': description})

    def cr(account_id, amt, description=None):
        lines.append({'account_id': account_id, 'credit': amt, 'description': description} if sign > 0
                     else {'account_id': account_id, 'debit': amt, 'description': description})

    def signed(fn, acc, amt, desc=None):
        if amt >= 0:
            fn(acc, amt, desc)
        else:
            (cr if fn is dr else dr)(acc, -amt, desc)

    clear_stock(d['doc_type'], d['id'])
    items = {i['id']: i for i in all('SELECT * FROM items WHERE org_id = ?', org_id)}

    for l in d['lines']:
        amt = b(l['taxable'])
        item = items.get(l['item_id']) if l.get('item_id') else None
        label = l.get('name') or l.get('description')
        if sales_side:
            signed(cr, l['account_id'], amt, label)
        else:
            signed(dr, l['account_id'], amt, label)
        for t in l.get('tax_breakdown') or []:
            acc = tax_account(org_id, t['code'], 'sales' if sales_side else 'purchase')
            if sales_side:
                signed(cr, acc, b(t['amount']), t['name'])
            else:
                signed(dr, acc, b(t['amount']), t['name'])
        if item and item.get('track_inventory') and item.get('type') == 'goods' and l.get('quantity'):
            inv = item.get('inventory_account_id') or sys_account(org_id, 'inventory')
            if sales_side:
                unit = avg_cost(item['id'], d['date'], (d['doc_type'], d['id']))
                cost = round2(unit * l['quantity'])
                qty = l['quantity'] if cfg.get('credit') else -l['quantity']
                add_stock_move(org_id, item['id'], d['date'], qty, unit, d['doc_type'], d['id'])
                if cost:
                    signed(dr, sys_account(org_id, 'cogs'), cost, f"COGS {item['name']}")
                    signed(cr, inv, cost, f"COGS {item['name']}")
            else:
                qty = -l['quantity'] if cfg.get('credit') else l['quantity']
                add_stock_move(org_id, item['id'], d['date'], qty, amt / l['quantity'], d['doc_type'], d['id'])
    if d.get('shipping'):
        acc = sys_account(org_id, 'shipping_charge') if sales_side else sys_account(org_id, 'other_expenses')
        (signed(cr, acc, b(d['shipping']), 'Shipping') if sales_side else signed(dr, acc, b(d['shipping']), 'Shipping'))
    if d.get('adjustment'):
        acc = sys_account(org_id, 'other_charges') if sales_side else sys_account(org_id, 'other_expenses')
        lbl = d.get('adjustment_label') or 'Adjustment'
        (signed(cr, acc, b(d['adjustment']), lbl) if sales_side else signed(dr, acc, b(d['adjustment']), lbl))
    net = 0
    for x in lines:
        net = net + (x.get('debit') or 0) - (x.get('credit') or 0)
    net = round2(net)
    if d['doc_type'] == 'salesreceipt':
        control = d.get('account_id') or sys_account(org_id, 'undeposited_funds')
    else:
        control = sys_account(org_id, 'ar') if sales_side else sys_account(org_id, 'ap')
    if net < 0:
        lines.append({'account_id': control, 'debit': -net, 'contact_id': d.get('contact_id')})
    elif net > 0:
        lines.append({'account_id': control, 'credit': net, 'contact_id': d.get('contact_id')})
    post(org_id, d['doc_type'], d['id'], date=d['date'], number=d['number'], contact_id=d.get('contact_id'), lines=lines)

    if (d.get('write_off') or 0) > 0:
        post(org_id, 'writeoff', d['id'], date=d['date'], number=d['number'], contact_id=d.get('contact_id'), lines=[
            {'account_id': sys_account(org_id, 'bad_debt'), 'debit': b(d['write_off'])},
            {'account_id': sys_account(org_id, 'ar'), 'credit': b(d['write_off']), 'contact_id': d.get('contact_id')},
        ])
    else:
        unpost(org_id, 'writeoff', d['id'])


def unpost_document(org_id, d):
    unpost(org_id, d['doc_type'], d['id'])
    unpost(org_id, 'writeoff', d['id'])
    clear_stock(d['doc_type'], d['id'])


def doc_action(req, type_, id, action, body=None):  # noqa: A002, C901
    """Status transitions. Returns the reloaded document."""
    cfg = type_cfg(type_)
    org = req.org
    settings = org_settings(org)
    body = body or {}

    def _do():
        d = load_doc(org['id'], id)
        if d['doc_type'] != type_:
            raise bad('Type mismatch')

        def set_(status, extra=None):
            update('documents', id, {'status': status, 'updated_at': now_iso(), **(extra or {})})
        needs_approval = bool((settings.get('approvals') or {}).get(type_))

        def go_live(extra=None):
            if cfg.get('posts') or cfg.get('payable'):
                assert_unlocked(org, d['date'], type_)
            set_('open', extra)
            refresh_balance(id)
            fresh = load_doc(org['id'], id)
            if cfg.get('posts'):
                post_document(org, fresh)

        label = cfg['label'].lower()
        if action in ('mark_sent', 'send', 'confirm', 'issue', 'open'):
            if d['status'] not in ('draft', 'pending_approval', 'open', 'sent') and not (type_ == 'quote' and d['status'] == 'declined'):
                raise bad(f"Cannot {action} a {d['status']} {label}")
            if d['status'] == 'pending_approval':
                raise bad('This document is waiting for approval')
            sent_at = now_iso() if action in ('send', 'mark_sent') else d.get('sent_at')
            if type_ == 'quote':
                set_('sent', {'sent_at': sent_at})
            elif d['status'] == 'draft' and needs_approval and (cfg.get('posts') or cfg.get('payable') or type_ in ('purchaseorder', 'salesorder')):
                set_('pending_approval')
            elif d['status'] == 'draft':
                go_live({'sent_at': sent_at})
            else:
                update('documents', id, {'sent_at': sent_at})
        elif action == 'submit':
            if d['status'] != 'draft':
                raise bad('Only drafts can be submitted for approval')
            set_('pending_approval' if needs_approval else 'draft')
            if not needs_approval:
                go_live()
        elif action == 'approve':
            if d['status'] != 'pending_approval':
                raise bad('Document is not pending approval')
            go_live({'approved_by': req.user['id']})
        elif action == 'reject':
            if d['status'] != 'pending_approval':
                raise bad('Document is not pending approval')
            set_('draft')
            if body.get('reason'):
                insert('comments', {'org_id': org['id'], 'entity_type': 'document', 'entity_id': id, 'user_id': req.user['id'],
                                    'author': req.user['name'], 'text': f"Rejected: {body['reason']}"})
        elif action == 'void':
            if (cfg.get('payable') or cfg.get('credit')) and _has_applications(org['id'], d):
                raise bad('Delete the payments/credits applied to this document before voiding it')
            if cfg.get('posts') or cfg.get('payable'):
                assert_unlocked(org, d['date'], type_)
            unpost_document(org['id'], d)
            set_('void', {'balance': 0})
        elif action in ('mark_draft', 'reopen'):
            if d['status'] in LIVE and (cfg.get('posts') or cfg.get('payable')):
                assert_unlocked(org, d['date'], type_)
            if d['status'] in ('void', 'pending_approval') or (d['status'] in ('accepted', 'declined', 'sent', 'invoiced') and type_ == 'quote'):
                unpost_document(org['id'], d)
                set_('draft')
                refresh_balance(id)
            else:
                paid = round2(d['total'] - d['balance'])
                if paid > 0:
                    raise bad('Remove payments first')
                unpost_document(org['id'], d)
                set_('draft')
                refresh_balance(id)
        elif action == 'accept':
            if type_ != 'quote':
                raise bad('Only quotes can be accepted')
            set_('accepted')
        elif action == 'decline':
            if type_ != 'quote':
                raise bad('Only quotes can be declined')
            set_('declined')
        elif action == 'close':
            # closing a draft would let a later edit post it without approval
            if d['status'] in ('draft', 'pending_approval', 'void', 'cancelled'):
                raise bad(f"Cannot close a {d['status']} {label}")
            set_('closed')
        elif action == 'cancel':
            if cfg.get('posts') or cfg.get('payable'):
                assert_unlocked(org, d['date'], type_)
                if _has_applications(org['id'], d):
                    raise bad('Delete the payments/credits applied to this document before cancelling it')
            unpost_document(org['id'], d)
            set_('cancelled')
        # Fulfilment marks apply only to non-posting order-type documents. Letting them run on an invoice or bill would
        # move a paid document out of LIVE and past the applied-payments guard on void/cancel.
        elif action == 'deliver':
            if type_ != 'deliverychallan' or d['status'] != 'open':
                raise bad('Only an open delivery challan can be marked as delivered')
            set_('delivered')
        elif action == 'return':
            if type_ != 'deliverychallan' or d['status'] not in ('open', 'delivered'):
                raise bad('Only an open or delivered delivery challan can be marked as returned')
            set_('returned')
        elif action == 'mark_invoiced':
            if type_ not in ('quote', 'salesorder', 'deliverychallan', 'purchaseorder') or d['status'] in ('draft', 'pending_approval', 'void', 'cancelled'):
                raise bad(f"A {d['status']} {label} cannot be marked as {'billed' if type_ == 'purchaseorder' else 'invoiced'}")
            set_('billed' if type_ == 'purchaseorder' else 'invoiced')
        elif action in ('pause', 'resume', 'stop'):
            if not cfg.get('profile'):
                raise bad('Not a recurring profile')
            set_({'pause': 'paused', 'resume': 'active', 'stop': 'stopped'}[action])
        elif action == 'writeoff':
            if type_ != 'invoice':
                raise bad('Only invoices can be written off')
            if d['status'] not in LIVE:
                raise bad('Only open invoices can be written off')
            assert_unlocked(org, d['date'], type_)
            amt = round2(body['amount'] if body.get('amount') is not None else d['balance'])
            if not (0 < amt <= d['balance'] + 0.001):
                raise bad('Invalid write-off amount')
            update('documents', id, {'write_off': round2((d.get('write_off') or 0) + amt)})
            refresh_balance(id)
            post_document(org, load_doc(org['id'], id))
        elif action == 'cancel_writeoff':
            if type_ != 'invoice' or d['status'] not in LIVE or not (d.get('write_off') or 0):
                raise bad('This invoice has no write-off to cancel')
            assert_unlocked(org, d['date'], type_)
            update('documents', id, {'write_off': 0})
            refresh_balance(id)
            post_document(org, load_doc(org['id'], id))
        else:
            raise bad(f'Unknown action {action}')
        return load_doc(org['id'], id)
    return tx(_do)


def delete_document(req, type_, id):  # noqa: A002
    org = req.org

    def _do():
        d = load_doc(org['id'], id, with_lines=False)
        if d['doc_type'] != type_:
            raise bad('Type mismatch')
        cfg = DOC_TYPES[type_]
        if cfg.get('posts') or cfg.get('payable'):
            assert_unlocked(org, d['date'], type_)
        has_pay = get('SELECT COUNT(*) n FROM payment_allocations WHERE document_id = ?', id)['n']
        has_cred = get('SELECT COUNT(*) n FROM credit_applications WHERE document_id = ? OR (source_type = ? AND source_id = ?)', id, type_, id)['n']
        has_refund = get('SELECT COUNT(*) n FROM refunds WHERE source_type = ? AND source_id = ?', type_, id)['n']
        if has_pay or has_cred or has_refund:
            raise bad('This document has payments, credits or refunds recorded against it. Delete those first.')
        unpost_document(org['id'], d)
        run("UPDATE expenses SET invoice_id = NULL, status = 'unbilled' WHERE invoice_id = ?", id)
        run('UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ?', id)
        run('UPDATE documents SET source_doc_id = NULL WHERE source_doc_id = ?', id)
        run('DELETE FROM documents WHERE id = ?', id)
        return {'ok': True}
    return tx(_do)


def convert_document(req, type_, id, to, body=None):  # noqa: A002
    """Convert e.g. quote -> invoice. Returns the new draft."""
    body = body or {}
    cfg = type_cfg(type_)
    if to not in cfg['convert']:
        raise bad(f"Cannot convert {cfg['label']} to {(DOC_TYPES.get(to) or {}).get('label') or to}")
    src = load_doc(req.org['id'], id)
    if src['doc_type'] != type_:
        raise bad('Type mismatch')
    target = DOC_TYPES[to]
    contact_id = src['contact_id']
    if target['contact'] != cfg['contact']:
        contact_id = body.get('contact_id')
        if not contact_id:
            raise bad(f"Choose a {target['contact']} for the new {target['label']}")
    lines = []
    for l in src['lines']:
        rate = l['rate']
        if target['side'] != cfg['side'] and l.get('item_id'):
            r = get('SELECT purchase_price FROM items WHERE id = ? AND org_id = ?', l['item_id'], req.org['id'])
            rate = r['purchase_price'] if r and r.get('purchase_price') is not None else l['rate']
        lines.append({
            'item_id': l['item_id'], 'name': l['name'], 'description': l['description'], 'quantity': l['quantity'], 'unit': l['unit'],
            'rate': rate, 'discount': l['discount'], 'tax_id': l['tax_id'], 'hsn_sac': l['hsn_sac'],
            'account_id': l['account_id'] if target['side'] == cfg['side'] else None,
        })
    same = target['contact'] == cfg['contact']
    payload = {
        'contact_id': contact_id, 'date': today(), 'reference': src['number'], 'lines': lines, 'discount_type': src['discount_type'],
        'discount_value': src['discount_value'], 'shipping': src['shipping'], 'adjustment': src['adjustment'],
        'adjustment_label': src['adjustment_label'], 'tax_inclusive': src['tax_inclusive'], 'notes': src['notes'], 'terms': src['terms'],
        'source_doc_id': src['id'], 'project_id': src['project_id'], 'salesperson': src['salesperson'],
    }
    if same:
        payload.update({'place_of_supply': src['place_of_supply'], 'currency': src['currency'], 'exchange_rate': src['exchange_rate'],
                        'payment_term_id': src['payment_term_id']})
    doc = save_document(req, to, payload)['doc']
    mark = {'quote': 'invoiced' if to == 'invoice' else None, 'salesorder': 'invoiced' if to == 'invoice' else None,
            'purchaseorder': 'billed', 'deliverychallan': 'invoiced'}.get(type_)
    # Marking the source invoiced/billed/accepted is an edit of it; without that right the copy is still made.
    may_edit_src = can(req, 'sales' if DOC_TYPES[type_]['side'] == 'sales' else 'purchases', 'edit')
    if mark and may_edit_src:
        update('documents', src['id'], {'status': mark})
    if type_ == 'quote' and to == 'salesorder' and may_edit_src:
        update('documents', src['id'], {'status': 'accepted'})
    return doc


def _js_date(y, m0, d):
    """new Date(Date.UTC(y, m0, d)) with JavaScript's overflow rules."""
    y += m0 // 12
    m0 %= 12
    return datetime.date(y, m0 + 1, 1) + datetime.timedelta(days=d - 1)


def advance_date(date, frequency, every=1):
    d = datetime.date.fromisoformat(str(date)[:10])
    n = max(1, int(jsnum(every) or 1))  # a stored 0, fraction or negative interval must still move forward
    if frequency == 'daily':
        out = d + datetime.timedelta(days=n)
    elif frequency == 'weekly':
        out = d + datetime.timedelta(days=7 * n)
    elif frequency == 'yearly':
        out = _js_date(d.year + n, d.month - 1, d.day)
    else:
        out = _js_date(d.year, d.month - 1 + n, d.day)
    return out.isoformat()


def run_recurring(org_id, req_like):
    """Generate due documents from recurring profiles. Returns number created."""
    now = today()
    created = 0
    profiles = all("SELECT id, doc_type FROM documents WHERE org_id = ? AND doc_type IN ('recurring_invoice','recurring_bill') AND status = 'active' ORDER BY id", org_id)
    for p in profiles:
        try:
            created = _run_profile(org_id, req_like, p, now, created)
        except HttpError as e:
            # One profile that cannot generate (for example a locked period) must not stop the others.
            _profile_failed('documents', p['id'], load_doc(org_id, p['id']).get('recurrence') or {}, e)
        if created >= RECURRING_RUN_LIMIT:
            return created
    return created


def _profile_failed(table, pid, r, err):
    log.warning('recurring %s profile %s skipped: %s', table, pid, err.message)
    update(table, pid, {'recurrence': _j({**r, 'last_error': err.message, 'last_error_at': now_iso()})})


def _run_profile(org_id, req_like, p, now, created):
    """Generate the due documents of one profile; returns the running total created this run."""
    guard = 0
    while True:
        if created >= RECURRING_RUN_LIMIT:
            return created
        prof = load_doc(org_id, p['id'])
        r = prof.get('recurrence') or {}
        if not r.get('next_date') or r['next_date'] > now or guard > 120:
            break
        guard += 1
        if r.get('end_date') and r['next_date'] > r['end_date']:
            update('documents', p['id'], {'status': 'expired'})
            break
        child_type = DOC_TYPES[p['doc_type']]['profile']
        doc = save_document(req_like, child_type, {
            'contact_id': prof['contact_id'], 'date': r['next_date'], 'payment_term_id': prof['payment_term_id'], 'lines': prof['lines'],
            'discount_type': prof['discount_type'], 'discount_value': prof['discount_value'], 'shipping': prof['shipping'],
            'adjustment': prof['adjustment'], 'tax_inclusive': prof['tax_inclusive'], 'notes': prof['notes'], 'terms': prof['terms'],
            'place_of_supply': prof['place_of_supply'], 'currency': prof['currency'], 'exchange_rate': prof['exchange_rate'],
            'reference': prof['reference'],
        })['doc']
        update('documents', doc['id'], {'profile_id': p['id']})
        if r.get('auto_send'):
            doc_action(req_like, child_type, doc['id'], 'mark_sent')
        created += 1
        next_date = advance_date(r['next_date'], r.get('frequency'), r.get('every'))
        update('documents', p['id'], {'recurrence': _j({**r, 'next_date': next_date, 'last_run': now})})
    return created


def doc_id_param(v):
    return to_int(v)
