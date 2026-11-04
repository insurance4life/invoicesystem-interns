"""REST routes for every sales/purchase document type: /api/documents/:type (port of modules/documents.js)."""
import datetime
import os

from books.core.db import all, get, update, parse_json
from books.core.router import bad, forbidden
from books.core.util import audit, today, org_settings, peek_number
from books.core.auth import can
from books.core.jsutil import to_int, to_fixed2, jsnum
from books.core.documents import (DOC_TYPES, type_cfg, load_doc, doc_relations, save_document, doc_action, delete_document,
                                  convert_document, display_status, run_recurring)
from books.core.mailer import send_email, fill_template, DEFAULT_TEMPLATES


def _module_of(t):
    return 'sales' if type_cfg(t)['side'] == 'sales' else 'purchases'


def _guard(req, t, action):
    if not can(req, _module_of(t), action):
        raise forbidden()


def email_vars(org, d):
    base = os.environ.get('PUBLIC_URL') or 'http://localhost:5173'
    days_overdue = 0
    if d.get('due_date'):
        diff = (datetime.date.fromisoformat(today()) - datetime.date.fromisoformat(d['due_date'][:10])).days
        days_overdue = max(0, diff)
    return {
        'number': d.get('number'), 'contact_name': d.get('contact_name'), 'org_name': org.get('name'),
        'total': to_fixed2(d['total']) if d.get('total') is not None else None,
        'balance': to_fixed2(d['balance']) if d.get('balance') is not None else None,
        'currency': d.get('currency'), 'due_date': d.get('due_date'), 'date': d.get('date'), 'link': f"{base}/share/{d.get('share_token')}",
        'days_overdue': days_overdue,
    }


def routes(r):
    def list_docs(req):
        t = req.params['type']
        _guard(req, t, 'view')
        q = req.query
        status, search = q.get('status'), q.get('q')
        page, per_page = to_int(q.get('page'), 1) or 1, to_int(q.get('per_page'), 100) or 100
        sort, direction = q.get('sort') or 'date', q.get('dir') or 'desc'
        where = ['d.org_id = ?', 'd.doc_type = ?']
        p = [req.org['id'], t]
        if q.get('contact_id'):
            where.append('d.contact_id = ?')
            p.append(to_int(q['contact_id']))
        if q.get('project_id'):
            where.append('d.project_id = ?')
            p.append(to_int(q['project_id']))
        if q.get('from'):
            where.append('d.date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('d.date <= ?')
            p.append(q['to'])
        if search:
            where.append('(d.number ILIKE ? OR d.reference ILIKE ? OR c.display_name ILIKE ?)')
            p += [f'%{search}%'] * 3
        order_col = {'date': 'd.date', 'number': 'd.number', 'total': 'd.total', 'balance': 'd.balance', 'due_date': 'd.due_date',
                     'contact': 'c.display_name'}.get(sort) or 'd.date'
        dir_sql = 'ASC' if direction == 'asc' else 'DESC'
        rows = all(f'''SELECT d.id, d.doc_type, d.number, d.reference, d.date, d.due_date, d.status, d.total, d.balance, d.currency, d.exchange_rate,
            d.sent_at, d.contact_id, d.recurrence, d.write_off, d.project_id, c.display_name AS contact_name
          FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE {' AND '.join(where)}
          ORDER BY {order_col} {dir_sql} NULLS {'FIRST' if dir_sql == 'ASC' else 'LAST'}, d.id DESC''', *p)
        for x in rows:
            parse_json(x, ['recurrence'])
            x['display_status'] = display_status(x)
        if status and status != 'all':
            st = str(status).split(',')
            rows = [x for x in rows if x['display_status'] in st
                    or ('unpaid' in st and x['display_status'] in ('open', 'sent', 'overdue', 'partially_paid'))]
        total = len(rows)
        start = (page - 1) * per_page
        return {'rows': rows[start:start + per_page], 'total': total, 'page': page, 'per_page': per_page}
    r.get('/documents/:type', list_docs)

    r.get('/documents/:type/next-number', lambda req: {'number': peek_number(get('SELECT * FROM orgs WHERE id = ?', req.org['id']), req.params['type'])})

    def get_doc(req):
        t = req.params['type']
        _guard(req, t, 'view')
        d = load_doc(req.org['id'], to_int(req.params['id']))
        if d['doc_type'] != t:
            raise bad('Type mismatch')
        return doc_relations(req.org['id'], d)
    r.get('/documents/:type/:id', get_doc)

    def create(req):
        t = req.params['type']
        _guard(req, t, 'create')
        res = save_document(req, t, req.body)
        doc, warnings = res['doc'], res['warnings']
        audit(req, 'document', doc['id'], 'created', f"{DOC_TYPES[t]['label']} {doc['number']}")
        save_as = req.body.get('save_as')
        if save_as in ('send', 'open'):
            d2 = doc_action(req, t, doc['id'], 'mark_sent' if save_as == 'send' else 'open')
            audit(req, 'document', doc['id'], 'submitted for approval' if d2['status'] == 'pending_approval' else 'marked as sent')
            return {**d2, 'warnings': warnings}
        return {**doc, 'warnings': warnings}
    r.post('/documents/:type', create)

    def edit(req):
        t = req.params['type']
        _guard(req, t, 'edit')
        res = save_document(req, t, req.body, to_int(req.params['id']))
        doc, warnings = res['doc'], res['warnings']
        audit(req, 'document', doc['id'], 'updated', f"{DOC_TYPES[t]['label']} {doc['number']}")
        save_as = req.body.get('save_as')
        if save_as in ('send', 'open') and doc['status'] == 'draft':
            return {**doc_action(req, t, doc['id'], 'mark_sent' if save_as == 'send' else 'open'), 'warnings': warnings}
        return {**doc, 'warnings': warnings}
    r.put('/documents/:type/:id', edit)

    def delete(req):
        t = req.params['type']
        _guard(req, t, 'delete')
        did = to_int(req.params['id'])
        d = load_doc(req.org['id'], did, with_lines=False)
        res = delete_document(req, t, did)
        audit(req, 'document', did, 'deleted', f"{DOC_TYPES[t]['label']} {d['number']}")
        return res
    r.delete('/documents/:type/:id', delete)

    def action(req):
        t, act = req.params['type'], req.params['action']
        _guard(req, t, 'approve' if act in ('approve', 'reject') else 'edit')
        body = req.body if isinstance(req.body, dict) else {}
        d = doc_action(req, t, to_int(req.params['id']), act, body)
        audit(req, 'document', d['id'], act.replace('_', ' '), body.get('reason') or '')
        return doc_relations(req.org['id'], d)
    r.post('/documents/:type/:id/action/:action', action)

    def convert(req):
        t = req.params['type']
        to = req.body.get('to')
        _guard(req, to, 'create')
        did = to_int(req.params['id'])
        doc = convert_document(req, t, did, to, req.body)
        audit(req, 'document', did, f"converted to {DOC_TYPES[to]['label']}", doc['number'])
        audit(req, 'document', doc['id'], 'created', f"from {DOC_TYPES[t]['label']}")
        return doc
    r.post('/documents/:type/:id/convert', convert)

    def clone(req):
        t = req.params['type']
        _guard(req, t, 'create')
        s = load_doc(req.org['id'], to_int(req.params['id']))
        if s['doc_type'] != t:
            raise bad('Type mismatch')
        body = {k: v for k, v in s.items() if k not in ('id', 'number', 'due_date')}
        body.update({'date': today(), 'source_doc_id': None,
                     'lines': [{k: v for k, v in l.items() if k not in ('id', 'document_id')} for l in s['lines']]})
        doc = save_document(req, t, body)['doc']
        audit(req, 'document', doc['id'], 'created', f"cloned from {s['number']}")
        return doc
    r.post('/documents/:type/:id/clone', clone)

    def email_get(req):
        t = req.params['type']
        _guard(req, t, 'view')
        d = load_doc(req.org['id'], to_int(req.params['id']), with_lines=False)
        if d['doc_type'] != t:
            raise bad('Type mismatch')
        s = org_settings(req.org)
        tpl = (s.get('email_templates') or {}).get(t) or DEFAULT_TEMPLATES.get(t) or DEFAULT_TEMPLATES['invoice']
        v = email_vars(req.org, d)
        return {'to': d.get('contact_email') or '', 'subject': fill_template(tpl.get('subject'), v), 'body': fill_template(tpl.get('body'), v)}
    r.get('/documents/:type/:id/email', email_get)

    def email_post(req):
        t = req.params['type']
        _guard(req, t, 'edit')
        b = req.body
        if not b.get('to'):
            raise bad('Recipient email is required')
        d = load_doc(req.org['id'], to_int(req.params['id']), with_lines=False)
        if d['doc_type'] != t:
            raise bad('Type mismatch')
        send_email(req.org, to=b['to'], cc=b.get('cc'), subject=b.get('subject'), body=b.get('body') or '', entity_type='document', entity_id=d['id'])
        if d['status'] in ('draft', 'open') and t not in ('recurring_invoice', 'recurring_bill'):
            d = doc_action(req, t, d['id'], 'send')
        else:
            from books.core.jsutil import now_iso  # noqa: PLC0415
            update('documents', d['id'], {'sent_at': now_iso()})
        audit(req, 'document', d['id'], 'emailed', b['to'])
        return doc_relations(req.org['id'], load_doc(req.org['id'], d['id']))
    r.post('/documents/:type/:id/email', email_post)

    def remind(req):
        _guard(req, 'invoice', 'edit')
        d = load_doc(req.org['id'], to_int(req.params['id']), with_lines=False)
        if d['doc_type'] != 'invoice' or d['balance'] <= 0:
            raise bad('Only unpaid invoices can be reminded')
        s = org_settings(req.org)
        tpl = (s.get('email_templates') or {}).get('reminder') or DEFAULT_TEMPLATES['reminder']
        v = email_vars(req.org, d)
        b = req.body if isinstance(req.body, dict) else {}
        to = b.get('to') or d.get('contact_email')
        if not to:
            raise bad('The customer has no email address')
        send_email(req.org, to=to, subject=fill_template(b.get('subject') or tpl.get('subject'), v), body=fill_template(b.get('body') or tpl.get('body'), v),
                   entity_type='document', entity_id=d['id'])
        audit(req, 'document', d['id'], 'payment reminder sent', to)
        return {'ok': True}
    r.post('/documents/:type/:id/remind', remind)

    def run_due(req):
        # creates invoices and bills, so the caller needs create on both sides
        if not (can(req, 'sales', 'create') and can(req, 'purchases', 'create')):
            raise forbidden()
        return {'created': run_recurring(req.org['id'], req)}
    r.post('/recurring/run', run_due)


def job(org, sys_req):
    run_recurring(org['id'], sys_req)
