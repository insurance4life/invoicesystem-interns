"""Base currency adjustment: unrealised FX revaluation of open foreign-currency invoices and bills (port of modules/fx.js)."""
from books.core.db import all, get, insert, run, tx
from books.core.router import bad, not_found
from books.core.util import audit, assert_unlocked, today
from books.core.auth import perm
from books.core.ledger import post, unpost, sys_account
from books.core.calc import round2, sum_js
from books.core.jsutil import truthy
from books.modules.inventory import js_number, nz, jstr, body_of, sql_num


def _check_input(org, date, currency, rate):
    if not truthy(date):
        raise bad('Date is required')
    if not truthy(currency) or currency == org.get('currency'):
        raise bad('Choose a foreign currency')
    if not (rate > 0):
        raise bad('Enter the new exchange rate')
    return {'date': date, 'currency': currency, 'rate': rate}


def preview_adjustment(org, f):
    """Open invoices/bills in the currency, dated on or before `date`.
    adjustment = balance x (new rate - basis rate), in base currency. The basis is the rate used by the latest earlier
    revaluation of that currency (if it came after the document), otherwise the document's rate, so repeated
    revaluations only book the movement since the previous one. gain_loss is the effect on profit: receivables gain
    when the rate rises, payables lose."""
    date, currency, rate = f['date'], f['currency'], f['rate']
    docs = all("""SELECT d.id, d.doc_type, d.number, d.date, d.currency, d.exchange_rate, d.balance, d.contact_id, c.display_name AS contact_name
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.status = 'open' AND d.currency = ? AND d.currency != ? AND d.doc_type IN ('invoice', 'bill')
      AND d.date <= ? AND ABS(d.balance) > 0.004
    ORDER BY d.date, d.id""", org['id'], currency, org.get('currency'), date)
    rows = []
    for d in docs:
        prior = get('SELECT rate FROM currency_adjustments WHERE org_id = ? AND currency = ? AND date >= ? AND date <= ? '
                    'ORDER BY date DESC, id DESC LIMIT 1', org['id'], currency, d['date'], date)
        basis = js_number(prior['rate']) if prior else (nz(d.get('exchange_rate')) or 1)
        adjustment = round2(d['balance'] * (rate - basis))
        side = 1 if d['doc_type'] == 'invoice' else -1
        rows.append({**d, 'basis_rate': basis, 'new_rate': rate, 'adjustment': adjustment,
                     'gain_loss': round2(adjustment * side)})
    return {'rows': rows, 'total_gain_loss': round2(sum_js(r['gain_loss'] for r in rows))}


def _post_adjustment(org, adj_id, adj_date, rows):
    lines = []
    for r in rows:
        if not r['adjustment']:
            continue
        is_ar = r['doc_type'] == 'invoice'
        # a rising rate increases a receivable (debit) and a payable (credit)
        up = r['adjustment'] if is_ar else -r['adjustment']
        ref = r['number'] if truthy(r.get('number')) else r['id']
        lines.append({
            'account_id': sys_account(org['id'], 'ar' if is_ar else 'ap'),
            'debit': max(up, 0), 'credit': max(-up, 0), 'contact_id': r.get('contact_id'),
            'description': f"Revaluation {jstr(ref)} @ {jstr(r['new_rate'])}",
        })
    net = 0
    for l in lines:
        net = net + l['debit'] - l['credit']
    net = round2(net)
    lines.append({'account_id': sys_account(org['id'], 'fx_gain_loss'), 'debit': max(-net, 0), 'credit': max(net, 0),
                  'description': 'Unrealised exchange gain/loss'})
    post(org['id'], 'fx_revaluation', adj_id, date=adj_date, lines=lines)


def _list(req):
    return all('SELECT * FROM currency_adjustments WHERE org_id = ? ORDER BY date DESC, id DESC', req.org['id'])


def _preview(req):
    f = _check_input(req.org, req.query.get('date') or today(), req.query.get('currency'), js_number(req.query.get('rate')))
    return preview_adjustment(req.org, f)


def _create(req):
    def _do():
        org = req.org
        body = body_of(req)
        f = _check_input(org, body.get('date') if truthy(body.get('date')) else today(), body.get('currency'),
                         js_number(body.get('rate')))
        assert_unlocked(org, f['date'], 'journal')
        prev = preview_adjustment(org, f)
        if not prev['rows']:
            raise bad(f"No open {jstr(f['currency'])} invoices or bills to revalue")
        notes = body.get('notes') if truthy(body.get('notes')) else None
        adj_id = insert('currency_adjustments', {
            'org_id': org['id'], 'date': f['date'], 'currency': f['currency'], 'rate': f['rate'],
            'amount': prev['total_gain_loss'], 'notes': notes,
        })
        _post_adjustment(org, adj_id, f['date'], prev['rows'])
        audit(req, 'currency_adjustment', adj_id, 'created', f"{jstr(f['currency'])} @ {jstr(f['rate'])}")
        return get('SELECT * FROM currency_adjustments WHERE id = ?', adj_id)
    return tx(_do)


def _delete(req):
    def _do():
        row = get('SELECT * FROM currency_adjustments WHERE id = ? AND org_id = ?', sql_num(req.params['id']), req.org['id'])
        if not row:
            raise not_found('Currency adjustment')
        assert_unlocked(req.org, row['date'], 'journal')
        unpost(req.org['id'], 'fx_revaluation', row['id'])
        run('DELETE FROM currency_adjustments WHERE id = ?', row['id'])
        audit(req, 'currency_adjustment', row['id'], 'deleted', f"{jstr(row['currency'])} @ {jstr(row['rate'])}")
        return {'ok': True}
    return tx(_do)


def routes(r):
    r.get('/currency-adjustments', perm('accountant', 'view'), _list)
    r.get('/currency-adjustments/preview', perm('accountant', 'view'), _preview)
    r.post('/currency-adjustments', perm('accountant', 'create'), _create)
    r.delete('/currency-adjustments/:id', perm('accountant', 'delete'), _delete)
