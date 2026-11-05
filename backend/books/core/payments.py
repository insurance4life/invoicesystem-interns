"""Payments received / made, credit applications and refunds (port of payments.js)."""
from books.core.db import all, get, run, insert, update, tx
from books.core.router import bad, not_found, forbidden
from books.core.auth import can
from books.core.util import round2, next_number, assert_unlocked, canon_date, cap_list, BANK_TYPES
from books.core.jsutil import jsnum, jsstr, today, truthy
from books.core.calc import sum_js
from books.core.ledger import post, unpost, sys_account
from books.core.documents import refresh_balance, retainer_available, DOC_TYPES

KIND = {
    'received': {'contact': 'customer', 'docs': ['invoice', 'retainer'], 'series': 'payment_received', 'control': 'ar', 'lock': 'payment_received'},
    'made': {'contact': 'vendor', 'docs': ['bill'], 'series': 'payment_made', 'control': 'ap', 'lock': 'payment_made'},
}


def _is_deposited(payment_id):
    return bool(get('SELECT 1 AS x FROM bank_deposit_payments WHERE payment_id = ?', payment_id))


def kind_cfg(kind):
    k = KIND.get(kind)
    if not k:
        raise not_found('Payment type')
    return k


def payment_unused(p):
    alloc = get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE payment_id = ?', p['id'])['s']
    applied = get("SELECT COALESCE(SUM(amount),0) s FROM credit_applications WHERE source_type = 'payment' AND source_id = ?", p['id'])['s']
    refunded = get("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE source_type = 'payment' AND source_id = ?", p['id'])['s']
    return round2(p['amount'] + (p.get('tds_amount') or 0) - alloc - applied - refunded)


def load_payment(org_id, id):  # noqa: A002
    p = get('''SELECT p.*, c.display_name AS contact_name, c.email AS contact_email, a.name AS account_name FROM payments p
               LEFT JOIN contacts c ON c.id = p.contact_id LEFT JOIN accounts a ON a.id = p.account_id WHERE p.id = ? AND p.org_id = ?''', id, org_id)
    if not p:
        raise not_found('Payment')
    p['allocations'] = all('''SELECT pa.*, d.number, d.doc_type, d.date AS document_date, d.total, d.balance FROM payment_allocations pa
                       JOIN documents d ON d.id = pa.document_id WHERE pa.payment_id = ? ORDER BY pa.id''', id)
    p['credits_applied'] = all('''SELECT ca.*, d.number, d.doc_type FROM credit_applications ca JOIN documents d ON d.id = ca.document_id
                           WHERE ca.source_type = 'payment' AND ca.source_id = ? ORDER BY ca.id''', id)
    p['refunds'] = all("SELECT * FROM refunds WHERE source_type = 'payment' AND source_id = ? ORDER BY id", id)
    p['unused'] = payment_unused(p)
    return p


def _post_payment(org, p):
    k = KIND[p['type']]
    fx = jsnum(p.get('exchange_rate')) or 1
    control = sys_account(org['id'], k['control'])
    allocs = all('SELECT pa.amount, d.exchange_rate, d.doc_type FROM payment_allocations pa JOIN documents d ON d.id = pa.document_id WHERE pa.payment_id = ? ORDER BY pa.id', p['id'])
    gross = round2(p['amount'] + (p.get('tds_amount') or 0))
    allocated = round2(sum_js(a['amount'] for a in allocs))
    control_base = round2(sum_js(a['amount'] * (a['exchange_rate'] or 1) for a in allocs) + (gross - allocated) * fx)
    cash = round2(p['amount'] * fx)
    charges = round2((p.get('bank_charges') or 0) * fx)
    tds = round2((p.get('tds_amount') or 0) * fx)
    lines = []
    if p['type'] == 'received':
        lines.append({'account_id': p['account_id'], 'debit': round2(cash - charges)})
        if charges:
            lines.append({'account_id': sys_account(org['id'], 'bank_charges'), 'debit': charges})
        if tds:
            lines.append({'account_id': sys_account(org['id'], 'tds_receivable'), 'debit': tds})
        lines.append({'account_id': control, 'credit': control_base, 'contact_id': p['contact_id']})
        diff = round2(control_base - cash - tds)
        if diff > 0:
            lines.append({'account_id': sys_account(org['id'], 'fx_gain_loss'), 'debit': diff})
        if diff < 0:
            lines.append({'account_id': sys_account(org['id'], 'fx_gain_loss'), 'credit': -diff})
    else:
        lines.append({'account_id': control, 'debit': control_base, 'contact_id': p['contact_id']})
        lines.append({'account_id': p['account_id'], 'credit': round2(cash + charges)})
        if charges:
            lines.append({'account_id': sys_account(org['id'], 'bank_charges'), 'debit': charges})
        if tds:
            lines.append({'account_id': sys_account(org['id'], 'tds_payable'), 'credit': tds})
        diff = round2(control_base - cash - tds)
        if diff > 0:
            lines.append({'account_id': sys_account(org['id'], 'fx_gain_loss'), 'credit': diff})
        if diff < 0:
            lines.append({'account_id': sys_account(org['id'], 'fx_gain_loss'), 'debit': -diff})
    post(org['id'], f"payment_{p['type']}", p['id'], date=p['date'], number=p['number'], contact_id=p['contact_id'], lines=lines)


def save_payment(req, kind, body, id=None):  # noqa: A002
    k = kind_cfg(kind)
    org = req.org
    body = body or {}

    def _do():
        existing = load_payment(org['id'], id) if id else None
        if existing and existing['type'] != kind:
            raise bad('Type mismatch')
        date = body.get('date') or today()
        assert_unlocked(org, date, k['lock'])
        if existing:
            assert_unlocked(org, existing['date'], k['lock'])
        contact = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', body.get('contact_id'), org['id']) if truthy(body.get('contact_id')) else None
        if not contact or contact['type'] != k['contact']:
            raise bad(f"Please select a {k['contact']}")
        amount = round2(body.get('amount'))
        if not amount > 0:
            raise bad('Enter an amount greater than zero')
        tds = round2(body.get('tds_amount') or 0)
        fx = jsnum(body.get('exchange_rate')) or 1
        charges = round2(body.get('bank_charges') or 0)
        # every amount below scales or offsets a posted line, so a negative one would invert it
        if not fx > 0 or charges < 0 or tds < 0 or tds > amount:
            raise bad('Exchange rate must be positive, and bank charges and TDS cannot be negative or exceed the amount')
        allocations = [a for a in (cap_list(body.get('allocations'), 'allocations') or []) if jsnum(a.get('amount')) > 0]
        total_alloc = round2(sum_js(jsnum(a.get('amount')) for a in allocations))
        if total_alloc > round2(amount + tds) + 0.001:
            raise bad('Amount applied to documents exceeds the payment amount')
        account_id = body.get('account_id') or sys_account(org['id'], 'undeposited_funds' if kind == 'received' else 'petty_cash')
        acct = get('SELECT id, type FROM accounts WHERE id = ? AND org_id = ?', account_id, org['id'])
        if not acct:
            raise bad('Invalid deposit / paid-through account')
        if acct['type'] not in BANK_TYPES:
            raise bad('Payments go to a bank, cash, card or clearing account')  # anything else is journal work

        fields = {
            'contact_id': contact['id'], 'date': date, 'amount': amount, 'currency': body.get('currency') or contact.get('currency') or org.get('currency'),
            'exchange_rate': fx, 'mode': body.get('mode') or 'Cash', 'account_id': account_id,
            'reference': body.get('reference') or None, 'bank_charges': charges, 'tds_amount': tds,
            'notes': body.get('notes') or None, 'is_online': 1 if truthy(body.get('is_online')) else 0,
        }
        pid = id
        if existing and _is_deposited(id) and (round2(existing['amount']) != amount or existing['account_id'] != int(account_id) or existing['date'] != date
                                               or round2(existing.get('bank_charges') or 0) != charges or round2(existing.get('tds_amount') or 0) != tds
                                               or abs(jsnum(existing.get('exchange_rate') or 1) - fx) > 1e-9
                                               or existing.get('currency') != fields['currency'] or existing.get('contact_id') != contact['id']):
            # the deposit moved this payment's Undeposited Funds line at its old value
            raise bad('This payment is included in a bank deposit. Remove it from the deposit before changing it.')
        if existing:
            touched = []
            for a in existing['allocations']:
                if a['document_id'] not in touched:
                    touched.append(a['document_id'])
            run('DELETE FROM payment_allocations WHERE payment_id = ?', id)
            for d in touched:
                refresh_balance(d)
            update('payments', id, fields)
        else:
            pid = insert('payments', {**fields, 'org_id': org['id'], 'type': kind, 'number': body.get('number') or next_number(org['id'], k['series']),
                                      'created_by': (req.user or {}).get('id')})
        for a in allocations:
            d = get('SELECT * FROM documents WHERE id = ? AND org_id = ?', a.get('document_id'), org['id'])
            if not d or d['doc_type'] not in k['docs']:
                raise bad('Invalid document in allocation')
            if d['contact_id'] != contact['id']:
                raise bad(f"{d['number']} belongs to another contact")
            if d['status'] not in ('open',):
                raise bad(f"{d['number']} is not open for payment (status: {d['status']})")
            if jsnum(a.get('amount')) > d['balance'] + 0.001:
                raise bad(f"Amount applied to {d['number']} exceeds its balance {jsstr(d['balance'])}")
            insert('payment_allocations', {'payment_id': pid, 'document_id': d['id'], 'amount': round2(a.get('amount'))})
            refresh_balance(d['id'])
        p = load_payment(org['id'], pid)
        if p['unused'] < -0.001:
            raise bad('This payment has credits applied or refunded beyond the new amount')
        _post_payment(org, p)
        return p
    return tx(_do)


def delete_payment(req, kind, id):  # noqa: A002
    org = req.org

    def _do():
        p = load_payment(org['id'], id)
        if p['type'] != kind:
            raise bad('Type mismatch')
        assert_unlocked(org, p['date'], KIND[kind]['lock'])
        if p['credits_applied'] or p['refunds']:
            raise bad('Remove the credits applied / refunds from this payment first')
        if _is_deposited(id):
            raise bad('This payment is included in a bank deposit. Remove it from the deposit first (Banking → account → All Transactions).')
        docs = [a['document_id'] for a in p['allocations']]
        run('DELETE FROM payments WHERE id = ?', id)
        for d in docs:
            refresh_balance(d)
        unpost(org['id'], f'payment_{kind}', id)
        run("UPDATE bank_statement_lines SET status = 'uncategorized', matched_type = NULL, matched_id = NULL WHERE matched_type = ? AND matched_id = ?",
            f'payment_{kind}', id)
        return {'ok': True}
    return tx(_do)


# ---------------- credits ----------------
def available_credits(org_id, contact_id):
    c = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', contact_id, org_id)
    if not c:
        raise not_found('Contact')
    cred_type = 'creditnote' if c['type'] == 'customer' else 'vendorcredit'
    notes = all('''SELECT id, number, date, total, balance, 'document' AS kind, doc_type AS source_type FROM documents
                   WHERE contact_id = ? AND doc_type = ? AND status = 'open' AND balance > 0.004 ORDER BY date, id''', contact_id, cred_type)
    pays = []
    for p in all('SELECT * FROM payments WHERE contact_id = ? AND type = ? ORDER BY date, id', contact_id, 'received' if c['type'] == 'customer' else 'made'):
        x = {'id': p['id'], 'number': p['number'], 'date': p['date'], 'total': p['amount'], 'balance': payment_unused(p), 'kind': 'payment', 'source_type': 'payment'}
        if x['balance'] > 0.004:
            pays.append(x)
    rets = []
    if c['type'] == 'customer':
        for d in all("SELECT * FROM documents WHERE contact_id = ? AND doc_type = 'retainer' AND status = 'open' ORDER BY id", contact_id):
            x = {'id': d['id'], 'number': d['number'], 'date': d['date'], 'total': d['total'], 'balance': retainer_available(d), 'kind': 'retainer', 'source_type': 'retainer'}
            if x['balance'] > 0.004:
                rets.append(x)
    return [*notes, *pays, *rets]


CREDIT_SOURCES = ('payment', 'creditnote', 'vendorcredit', 'retainer')


def _require_side(req, side, action='edit'):
    """Credits and refunds act on one side of the books; the caller needs that side's module right."""
    if not can(req, 'sales' if side == 'sales' else 'purchases', action):
        raise forbidden()


def _lock_kind(side):
    return 'payment_received' if side == 'sales' else 'payment_made'


def _doc_side(org_id, doc_id):
    d = get('SELECT doc_type FROM documents WHERE id = ? AND org_id = ?', doc_id, org_id)
    return DOC_TYPES[d['doc_type']]['side'] if d else 'sales'


def _source_balance(org_id, source_type, source_id):
    # Only these sources consume their balance when applied or refunded; any other document type
    # (invoice, bill, order) would act as an unlimited credit.
    if source_type not in CREDIT_SOURCES:
        raise bad('Credits can only come from a credit note, vendor credit, payment or retainer')
    if source_type == 'payment':
        p = get('SELECT * FROM payments WHERE id = ? AND org_id = ?', source_id, org_id)
        if not p:
            raise not_found('Payment')
        return {'contact_id': p['contact_id'], 'balance': payment_unused(p), 'side': 'sales' if p['type'] == 'received' else 'purchase'}
    d = get('SELECT * FROM documents WHERE id = ? AND org_id = ?', source_id, org_id)
    if not d or d['doc_type'] != source_type:
        raise not_found('Credit')
    if d['status'] != 'open':
        raise bad(f"{d['number']} is not open")
    balance = retainer_available(d) if source_type == 'retainer' else d['balance']
    return {'contact_id': d['contact_id'], 'balance': balance, 'side': DOC_TYPES[d['doc_type']]['side']}


def apply_credits(req, body):
    org = req.org
    source_type = body.get('source_type')
    source_id = body.get('source_id')
    applications = cap_list(body.get('applications'), 'applications') or []
    date = body.get('date')

    def _do():
        src = _source_balance(org['id'], source_type, source_id)
        _require_side(req, src['side'])
        app_date = canon_date(date) if date else today()
        assert_unlocked(org, app_date, _lock_kind(src['side']))  # same rule as deleting an application
        apps = [a for a in applications if jsnum(a.get('amount')) > 0]
        total = round2(sum_js(jsnum(a.get('amount')) for a in apps))
        if total > src['balance'] + 0.001:
            raise bad(f"Only {jsstr(src['balance'])} credit is available")
        for a in apps:
            d = get('SELECT * FROM documents WHERE id = ? AND org_id = ?', a.get('document_id'), org['id'])
            if not d or d['doc_type'] not in ('invoice', 'bill') or DOC_TYPES[d['doc_type']]['side'] != src['side']:
                raise bad('Credits can only be applied to invoices or bills of the same side')
            if d['contact_id'] != src['contact_id']:
                raise bad(f"{d['number']} belongs to another contact")
            if d['status'] != 'open':
                raise bad(f"{d['number']} is not open")
            if jsnum(a.get('amount')) > d['balance'] + 0.001:
                raise bad(f"Amount exceeds the balance of {d['number']}")
            insert('credit_applications', {'org_id': org['id'], 'source_type': source_type, 'source_id': source_id, 'document_id': d['id'],
                                           'amount': round2(a.get('amount')), 'date': app_date})
            refresh_balance(d['id'])
        if source_type not in ('payment', 'retainer'):
            refresh_balance(source_id)
        return {'ok': True, 'applied': total}
    return tx(_do)


def delete_credit_application(req, id):  # noqa: A002
    ca = get('SELECT * FROM credit_applications WHERE id = ? AND org_id = ?', id, req.org['id'])
    if not ca:
        raise not_found('Credit application')
    side = _doc_side(req.org['id'], ca['document_id'])
    _require_side(req, side, 'delete')

    def _do():
        assert_unlocked(req.org, ca['date'], _lock_kind(side))
        run('DELETE FROM credit_applications WHERE id = ?', id)
        refresh_balance(ca['document_id'])
        if ca['source_type'] not in ('payment', 'retainer'):
            refresh_balance(ca['source_id'])
        return {'ok': True}
    return tx(_do)


# ---------------- refunds ----------------
def save_refund(req, body):
    org = req.org

    def _do():
        source_type = body.get('source_type')
        source_id = body.get('source_id')
        src = _source_balance(org['id'], source_type, source_id)
        _require_side(req, src['side'])
        if source_type == 'retainer':
            raise bad('Refund the retainer payment instead')
        amount = round2(body.get('amount'))
        if not amount > 0 or amount > src['balance'] + 0.001:
            raise bad(f"Refund must be between 0 and {jsstr(src['balance'])}")
        date = body.get('date') or today()
        assert_unlocked(org, date, 'payment_received' if src['side'] == 'sales' else 'payment_made')
        account_id = body.get('account_id') or sys_account(org['id'], 'petty_cash')
        acct = get('SELECT type FROM accounts WHERE id = ? AND org_id = ?', account_id, org['id'])
        if not acct or acct['type'] not in BANK_TYPES:
            raise bad('Refunds are paid from a bank, cash, card or clearing account')
        rid = insert('refunds', {'org_id': org['id'], 'source_type': source_type, 'source_id': source_id, 'date': date, 'amount': amount,
                                 'account_id': account_id, 'mode': body.get('mode') or 'Cash', 'reference': body.get('reference') or None,
                                 'notes': body.get('notes') or None})
        control = sys_account(org['id'], 'ar' if src['side'] == 'sales' else 'ap')
        if src['side'] == 'sales':
            lines = [{'account_id': control, 'debit': amount, 'contact_id': src['contact_id']}, {'account_id': account_id, 'credit': amount}]
        else:
            lines = [{'account_id': account_id, 'debit': amount}, {'account_id': control, 'credit': amount, 'contact_id': src['contact_id']}]
        post(org['id'], 'refund', rid, date=date, number=None, contact_id=src['contact_id'], lines=lines)
        if source_type != 'payment':
            refresh_balance(source_id)
        return get('SELECT * FROM refunds WHERE id = ?', rid)
    return tx(_do)


def delete_refund(req, id):  # noqa: A002
    r = get('SELECT * FROM refunds WHERE id = ? AND org_id = ?', id, req.org['id'])
    if not r:
        raise not_found('Refund')
    if r['source_type'] == 'payment':
        p = get('SELECT type FROM payments WHERE id = ? AND org_id = ?', r['source_id'], req.org['id'])
        side = 'sales' if p and p['type'] == 'received' else 'purchase'
    else:
        side = _doc_side(req.org['id'], r['source_id'])
    _require_side(req, side, 'delete')

    def _do():
        assert_unlocked(req.org, r['date'], _lock_kind(side))
        run('DELETE FROM refunds WHERE id = ?', id)
        unpost(req.org['id'], 'refund', id)
        if r['source_type'] != 'payment':
            refresh_balance(r['source_id'])
        return {'ok': True}
    return tx(_do)
