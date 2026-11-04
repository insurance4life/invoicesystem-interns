"""Expenses: simple, itemized, mileage, billable, recurring profiles (port of modules/expenses.js)."""
import json

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found
from books.core.util import audit, round2, today, assert_unlocked, assert_owned
from books.core.auth import perm
from books.core.jsutil import jsnum, jsstr, to_int, truthy
from books.core.ledger import post, unpost, sys_account, tax_account
from books.core.calc import compute_document, sum_js
from books.core.documents import tax_ctx, advance_date, validate_recurrence

FIELDS = ['date', 'account_id', 'paid_through_id', 'amount', 'tax_id', 'tax_inclusive', 'currency', 'exchange_rate', 'vendor_id',
          'customer_id', 'project_id', 'is_billable', 'markup_percent', 'reference', 'notes', 'place_of_supply', 'hsn_sac', 'is_mileage',
          'distance', 'mileage_rate', 'splits', 'recurrence']


def _j(v):
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


def load_expense(org_id, id):  # noqa: A002
    e = get('''SELECT e.*, a.name AS account_name, pt.name AS paid_through_name, v.display_name AS vendor_name, c.display_name AS customer_name,
                 d.number AS invoice_number
               FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id AND a.org_id = e.org_id
               LEFT JOIN accounts pt ON pt.id = e.paid_through_id AND pt.org_id = e.org_id
               LEFT JOIN contacts v ON v.id = e.vendor_id AND v.org_id = e.org_id LEFT JOIN contacts c ON c.id = e.customer_id AND c.org_id = e.org_id
               LEFT JOIN documents d ON d.id = e.invoice_id AND d.org_id = e.org_id
               WHERE e.id = ? AND e.org_id = ?''', id, org_id)
    if not e:
        raise not_found('Expense')
    return parse_json(e, ['splits', 'recurrence'])


def _compute(org, e):
    ctx = tax_ctx(org)
    if e.get('splits'):
        lines = [{'quantity': 1, 'rate': jsnum(s.get('amount')), 'tax_id': s.get('tax_id') or None, 'account_id': s.get('account_id'),
                  'description': s.get('description')} for s in e['splits']]
    else:
        rate = round2((e.get('distance') or 0) * (e.get('mileage_rate') or 0)) if truthy(e.get('is_mileage')) else jsnum(e.get('amount'))
        lines = [{'quantity': 1, 'rate': rate, 'tax_id': e.get('tax_id') or None, 'account_id': e.get('account_id')}]
    return compute_document({'lines': lines, 'tax_inclusive': e.get('tax_inclusive'), 'place_of_supply': e.get('place_of_supply') or org.get('state')}, ctx)


def _post_expense(org, e):
    if e.get('is_profile'):
        return unpost(org['id'], 'expense', e['id'])
    c = _compute(org, e)
    fx = jsnum(e.get('exchange_rate')) or 1
    lines = []
    for l in c['lines']:
        lines.append({'account_id': l.get('account_id') or sys_account(org['id'], 'uncategorized'), 'debit': round2(l['taxable'] * fx), 'description': l.get('description')})
        for t in l['tax_breakdown']:
            lines.append({'account_id': tax_account(org['id'], t['code'], 'purchase'), 'debit': round2(t['amount'] * fx), 'description': t['name']})
    total = round2(sum_js(x['debit'] for x in lines))
    lines.append({'account_id': e.get('paid_through_id') or sys_account(org['id'], 'petty_cash'), 'credit': total})
    post(org['id'], 'expense', e['id'], date=e['date'], number=e.get('reference'), contact_id=e.get('vendor_id'), lines=lines)


def save_expense(req, body, id=None):  # noqa: A002
    org = req.org
    body = body or {}

    def _do():
        existing = load_expense(org['id'], id) if id else None
        o = {}
        for f in FIELDS:
            if f in body:
                o[f] = None if body[f] == '' else body[f]
        o['date'] = o.get('date') or (existing or {}).get('date') or today()
        # is_profile can only be set on create, so on edit the stored flag decides whether the lock applies.
        if not (existing.get('is_profile') if existing else truthy(body.get('is_profile'))):
            assert_unlocked(org, o['date'], 'expense')
        if existing and not existing.get('is_profile'):
            assert_unlocked(org, existing['date'], 'expense')
        if isinstance(o.get('splits'), list) and not o['splits']:
            o['splits'] = None
        merged = {**(existing or {}), **o, 'splits': o['splits'] if 'splits' in o else (existing or {}).get('splits')}
        assert_owned(org['id'], 'accounts', [o.get('account_id'), o.get('paid_through_id')]
                     + [s.get('account_id') for s in (o.get('splits') or []) if isinstance(s, dict)], 'account')
        assert_owned(org['id'], 'contacts', [o.get('vendor_id'), o.get('customer_id')], 'contact')
        assert_owned(org['id'], 'projects', [o.get('project_id')], 'project')
        if not merged.get('splits') and not merged.get('account_id'):
            raise bad('Choose an expense account')
        if not merged.get('paid_through_id'):
            raise bad('Choose the account this was paid through')
        c = _compute(org, merged)
        if not c['total'] > 0:
            raise bad('Enter an amount greater than zero')
        if truthy(merged.get('is_billable')) and not merged.get('customer_id'):
            raise bad('Choose a customer for a billable expense')
        if truthy(merged.get('is_mileage')):
            o['amount'] = round2((merged.get('distance') or 0) * (merged.get('mileage_rate') or 0))
        o['total'] = c['total']
        o['tax_amount'] = c['tax_total']
        if o.get('splits'):
            o['splits'] = _j(o['splits'])
        if isinstance(o.get('recurrence'), dict):
            rec = o['recurrence']
            o['recurrence'] = _j(validate_recurrence({'frequency': 'monthly', 'every': 1, 'start_date': o['date'], 'next_date': rec.get('start_date') or o['date'], 'status': 'active', **rec}))
        if truthy(merged.get('is_billable')):
            o['status'] = 'invoiced' if merged.get('invoice_id') else 'unbilled'
        else:
            o['status'] = 'non-billable'
        eid = id
        if existing:
            update('expenses', id, o)
        else:
            eid = insert('expenses', {**o, 'org_id': org['id'], 'is_profile': 1 if truthy(body.get('is_profile')) else 0,
                                      'currency': o.get('currency') or org.get('currency'), 'created_by': (req.user or {}).get('id')})
        e = load_expense(org['id'], eid)
        _post_expense(org, e)
        return e
    return tx(_do)


def run_recurring_expenses(org, req):
    now = today()
    n = 0
    for p in all('SELECT * FROM expenses WHERE org_id = ? AND is_profile = 1 ORDER BY id', org['id']):
        try:
            r = json.loads(p.get('recurrence') or '{}') or {}
        except ValueError:
            r = {}
        guard = 0
        while r.get('status') == 'active' and r.get('next_date') and r['next_date'] <= now and guard < 120:
            guard += 1
            if r.get('end_date') and r['next_date'] > r['end_date']:
                r['status'] = 'expired'
                break
            rest = parse_json(dict(p), ['splits'])
            for k in ('id', 'created_at', 'is_profile', 'recurrence'):
                rest.pop(k, None)
            child = save_expense(req, {**rest, 'date': r['next_date'], 'is_profile': 0, 'splits': rest.get('splits') or None, 'invoice_id': None})
            update('expenses', child['id'], {'profile_id': p['id']})
            n += 1
            r = {**r, 'next_date': advance_date(r['next_date'], r.get('frequency'), r.get('every')), 'last_run': now}
        update('expenses', p['id'], {'recurrence': _j(r)})
    return n


def routes(r):
    def list_expenses(req):
        q = req.query
        where = ['e.org_id = ?', f"e.is_profile = {1 if q.get('profiles') else 0}"]
        p = [req.org['id']]
        for key, col in (('customer_id', 'e.customer_id'), ('vendor_id', 'e.vendor_id'), ('account_id', 'e.account_id'), ('project_id', 'e.project_id')):
            if q.get(key):
                where.append(f'{col} = ?')
                p.append(to_int(q[key]))
        if q.get('from'):
            where.append('e.date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('e.date <= ?')
            p.append(q['to'])
        if q.get('billable'):
            where.append('e.is_billable = 1')
        if q.get('unbilled'):
            where.append('e.is_billable = 1 AND e.invoice_id IS NULL')
        if q.get('q'):
            where.append('(e.reference ILIKE ? OR e.notes ILIKE ? OR v.display_name ILIKE ? OR a.name ILIKE ?)')
            p += [f"%{q['q']}%"] * 4
        return [parse_json(e, ['splits', 'recurrence']) for e in all(f'''SELECT e.*, a.name AS account_name, pt.name AS paid_through_name, v.display_name AS vendor_name, c.display_name AS customer_name
                FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN accounts pt ON pt.id = e.paid_through_id
                LEFT JOIN contacts v ON v.id = e.vendor_id LEFT JOIN contacts c ON c.id = e.customer_id
                WHERE {' AND '.join(where)} ORDER BY e.date DESC, e.id DESC''', *p)]
    r.get('/expenses', perm('purchases', 'view'), list_expenses)
    r.get('/expenses/:id', perm('purchases', 'view'), lambda req: load_expense(req.org['id'], to_int(req.params['id'])))

    def create(req):
        e = save_expense(req, req.body)
        audit(req, 'expense', e['id'], 'recurring expense created' if e.get('is_profile') else 'created', jsstr(e['total']))
        return e
    r.post('/expenses', perm('purchases', 'create'), create)

    def edit(req):
        e = save_expense(req, req.body, to_int(req.params['id']))
        audit(req, 'expense', e['id'], 'updated')
        return e
    r.put('/expenses/:id', perm('purchases', 'edit'), edit)

    def delete(req):
        def _do():
            e = load_expense(req.org['id'], to_int(req.params['id']))
            if e.get('invoice_id'):
                raise bad(f"This expense has been invoiced on {e['invoice_number']}. Remove it from the invoice first.")
            if not e.get('is_profile'):
                assert_unlocked(req.org, e['date'], 'expense')
            unpost(req.org['id'], 'expense', e['id'])
            run('DELETE FROM expenses WHERE id = ?', e['id'])
            run("UPDATE bank_statement_lines SET status = 'uncategorized', matched_type = NULL, matched_id = NULL WHERE matched_type = 'expense' AND matched_id = ?", e['id'])
            audit(req, 'expense', e['id'], 'deleted')
            return {'ok': True}
        return tx(_do)
    r.delete('/expenses/:id', perm('purchases', 'delete'), delete)

    def recurrence_action(req):
        e = load_expense(req.org['id'], to_int(req.params['id']))
        if not e.get('is_profile'):
            raise bad('Not a recurring expense')
        status = {'pause': 'paused', 'resume': 'active', 'stop': 'stopped'}.get(req.params['action'])
        if not status:
            raise bad('Unknown action')
        update('expenses', e['id'], {'recurrence': _j({**(e.get('recurrence') or {}), 'status': status})})
        return load_expense(req.org['id'], e['id'])
    r.post('/expenses/:id/recurrence/:action', perm('purchases', 'edit'), recurrence_action)


def job(org, sys_req):
    run_recurring_expenses(org, sys_req)
