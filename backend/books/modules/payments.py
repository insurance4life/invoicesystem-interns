"""/api/payments/:kind (received | made), /api/credits, /api/refunds (port of modules/payments.js)."""
from books.core.db import all
from books.core.router import forbidden, not_found
from books.core.util import audit, org_settings, like_pattern
from books.core.auth import can
from books.core.jsutil import to_int, to_fixed2, jsstr, truthy
from books.core.payments import (save_payment, delete_payment, load_payment, payment_unused, apply_credits, delete_credit_application,
                                 save_refund, delete_refund, kind_cfg)
from books.core.mailer import send_email, fill_template, DEFAULT_TEMPLATES


def _mod(kind):
    return 'sales' if kind == 'received' else 'purchases'


def _guard(req, kind, action):
    kind_cfg(kind)
    if not can(req, _mod(kind), action):
        raise forbidden()


def routes(r):
    def list_payments(req):
        kind = req.params['kind']
        _guard(req, kind, 'view')
        q = req.query
        where = ['p.org_id = ?', 'p.type = ?']
        p = [req.org['id'], kind]
        if q.get('contact_id'):
            where.append('p.contact_id = ?')
            p.append(to_int(q['contact_id']))
        if q.get('from'):
            where.append('p.date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('p.date <= ?')
            p.append(q['to'])
        if q.get('mode'):
            where.append('p.mode = ?')
            p.append(q['mode'])
        pat = like_pattern(q.get('q'))
        if pat:
            where.append('(p.number ILIKE ? OR p.reference ILIKE ? OR c.display_name ILIKE ?)')
            p += [pat] * 3
        rows = all(f'''SELECT p.*, c.display_name AS contact_name, a.name AS account_name,
            (SELECT string_agg(d.number, ', ' ORDER BY pa.id) FROM payment_allocations pa JOIN documents d ON d.id = pa.document_id WHERE pa.payment_id = p.id) AS documents
          FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id LEFT JOIN accounts a ON a.id = p.account_id
          WHERE {' AND '.join(where)} ORDER BY p.date DESC, p.id DESC''', *p)
        return [{**x, 'unused': payment_unused(x)} for x in rows]
    r.get('/payments/:kind', list_payments)

    def get_payment(req):
        _guard(req, req.params['kind'], 'view')
        p = load_payment(req.org['id'], to_int(req.params['id']))
        if p['type'] != req.params['kind']:
            raise not_found('Payment')
        return p
    r.get('/payments/:kind/:id', get_payment)

    def create(req):
        kind = req.params['kind']
        _guard(req, kind, 'create')
        p = save_payment(req, kind, req.body)
        audit(req, f'payment_{kind}', p['id'], 'created', f"{p['number']} {jsstr(p['amount'])}")
        for a in p['allocations']:
            audit(req, 'document', a['document_id'], f"payment of {jsstr(a['amount'])} recorded", p['number'])
        if truthy(req.body.get('send_receipt')) and p.get('contact_email'):
            tpl = (org_settings(req.org).get('email_templates') or {}).get(f'payment_{kind}') or DEFAULT_TEMPLATES[f'payment_{kind}']
            v = {'number': p['number'], 'contact_name': p['contact_name'], 'amount': to_fixed2(p['amount']), 'currency': p['currency'], 'org_name': req.org['name']}
            send_email(req.org, to=p['contact_email'], subject=fill_template(tpl.get('subject'), v), body=fill_template(tpl.get('body'), v),
                       entity_type=f'payment_{kind}', entity_id=p['id'])
        return p
    r.post('/payments/:kind', create)

    def edit(req):
        kind = req.params['kind']
        _guard(req, kind, 'edit')
        p = save_payment(req, kind, req.body, to_int(req.params['id']))
        audit(req, f'payment_{kind}', p['id'], 'updated')
        return p
    r.put('/payments/:kind/:id', edit)

    def delete(req):
        kind = req.params['kind']
        _guard(req, kind, 'delete')
        pid = to_int(req.params['id'])
        p = load_payment(req.org['id'], pid)
        res = delete_payment(req, kind, pid)
        audit(req, f'payment_{kind}', pid, 'deleted', p['number'])
        for a in p['allocations']:
            audit(req, 'document', a['document_id'], f"payment {p['number']} deleted")
        return res
    r.delete('/payments/:kind/:id', delete)

    def credits_apply(req):
        if not can(req, 'sales', 'edit') and not can(req, 'purchases', 'edit'):
            raise forbidden()
        res = apply_credits(req, req.body)
        for a in req.body.get('applications') or []:
            from books.core.jsutil import jsnum  # noqa: PLC0415
            if jsnum(a.get('amount')) > 0:
                audit(req, 'document', a.get('document_id'), f"credits of {jsstr(a.get('amount'))} applied")
        return res
    r.post('/credits/apply', credits_apply)
    r.delete('/credits/:id', lambda req: delete_credit_application(req, to_int(req.params['id'])))

    def refund(req):
        if not can(req, 'sales', 'edit') and not can(req, 'purchases', 'edit'):
            raise forbidden()
        rf = save_refund(req, req.body)
        audit(req, 'payment' if req.body.get('source_type') == 'payment' else 'document', req.body.get('source_id'), f"refund of {jsstr(rf['amount'])}")
        return rf
    r.post('/refunds', refund)
    r.delete('/refunds/:id', lambda req: delete_refund(req, to_int(req.params['id'])))
