"""Time tracking: projects, tasks, timesheets, timers and billing of time and expenses into invoices (port of modules/projects.js)."""
import datetime
import json
import math
import re

from books.core.db import all, get, run, insert, update, tx
from books.core.router import bad, not_found, forbidden
from books.core.util import audit, num, org_settings, cap_list, like_pattern
from books.core.calc import round2
from books.core.auth import perm, can
from books.core.documents import save_document
from books.core.jsutil import jsnum, jsstr, num_or_none, to_int, today, now_iso, truthy

BILLING = ['fixed', 'project_hours', 'task_hours', 'staff_hours']
BILLING_FIELDS = ('billing_method', 'rate', 'customer_id', 'users')
BUDGETS = ['none', 'hours', 'amount']
PROJECT_STATUS = ['active', 'inactive', 'completed']
DATE_RE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
# JavaScript String.prototype.trim() whitespace and line terminators
JS_WS = '\t\n\x0b\x0c\r \xa0                　﻿'
MIDDOT = ' · '
_EPOCH_MS_UNIT = datetime.timedelta(milliseconds=1)


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


def _flag(v):
    """projects.js `truthy`: only true, 1, '1', 'true' and 'on' count as set."""
    if v is True:
        return True
    if v is False or v is None:
        return False
    if isinstance(v, (int, float)):
        return v == 1
    if isinstance(v, str):
        return v in ('1', 'true', 'on')
    return False


def _js_round(x):
    """Math.round: round half up towards +Infinity."""
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return x
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def _hrs(minutes):
    return _js_round((jsnum(minutes) / 60) * 100) / 100


def _body(req):
    b = req.body
    return b if isinstance(b, dict) else {}


def _elapsed_ms_since(iso):
    """Date.now() - Date.parse(iso) in whole milliseconds."""
    start = datetime.datetime.fromisoformat(iso)
    if start.tzinfo is None:
        start = start.replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    return (now - start) // _EPOCH_MS_UNIT


def _escape_like(s):
    # SQLite LIKE has no escape character; PostgreSQL's default escape is backslash.
    return s.replace('\\', '\\\\')


def _parse_users_loose(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return []
    return v


# ---------- projects ----------
def load_project(org_id, id_):
    p = get('''SELECT p.*, c.display_name AS customer_name FROM projects p LEFT JOIN contacts c ON c.id = p.customer_id
               WHERE p.id = ? AND p.org_id = ?''', id_, org_id)
    if not p:
        raise not_found('Project')
    users = _parse_users_loose(p.get('users'))
    p['users'] = users if isinstance(users, list) else []
    return p


def _norm_users(org_id, lst):
    if not isinstance(lst, list):
        return []
    cap_list(lst, 'project users', 200)
    seen = set()
    out = []
    for u in lst:
        uid = num_or_none(u.get('user_id')) if isinstance(u, dict) else None
        if not truthy(uid) or uid in seen:
            continue
        if not get("SELECT 1 AS ok FROM org_users WHERE org_id = ? AND user_id = ? AND status = 'active'", org_id, uid):
            raise bad(f'User {jsstr(uid)} is not a member of this organization')
        seen.add(uid)
        out.append({'user_id': uid, 'rate': round2(num(u.get('rate'))), 'cost_rate': round2(num(u.get('cost_rate')))})
    return out


def _clean_project(org_id, body):
    o = {}
    if 'name' in body:
        o['name'] = _js_trim(_str_or_empty(body['name']))
        if not o['name']:
            raise bad('Project name is required')
    if 'code' in body:
        o['code'] = _js_trim(_str_or_empty(body['code'])) or None
    if 'customer_id' in body:
        cid = num_or_none(body['customer_id']) if truthy(body['customer_id']) else None
        o['customer_id'] = cid
        if truthy(cid) and not get("SELECT id FROM contacts WHERE id = ? AND org_id = ? AND type = 'customer'", cid, org_id):
            raise bad('Choose a valid customer')
    if 'billing_method' in body:
        if body['billing_method'] not in BILLING:
            raise bad('Invalid billing method')
        o['billing_method'] = body['billing_method']
    if 'rate' in body:
        o['rate'] = round2(num(body['rate']))
    if 'budget_type' in body:
        if body['budget_type'] not in BUDGETS:
            raise bad('Invalid budget type')
        o['budget_type'] = body['budget_type']
    if 'budget_hours' in body:
        o['budget_hours'] = round2(num(body['budget_hours']))
    if 'budget_amount' in body:
        o['budget_amount'] = round2(num(body['budget_amount']))
    if 'description' in body:
        o['description'] = body['description'] if truthy(body['description']) else None
    if 'status' in body:
        if body['status'] not in PROJECT_STATUS:
            raise bad('Invalid project status')
        o['status'] = body['status']
    if 'users' in body:
        o['users'] = _norm_users(org_id, body['users'])
    return o


def _clean_task(t):
    if t is None:
        raise TypeError("Cannot read properties of null (reading 'name')")
    if not isinstance(t, dict):
        t = {}
    b = t.get('billable')
    return {
        'name': _js_trim(_str_or_empty(t.get('name'))),
        'description': t['description'] if truthy(t.get('description')) else None,
        'rate': round2(num(t.get('rate'))),
        'billable': 1 if b is None else (1 if _flag(b) else 0),
    }


def _assert_may_price(req):
    if req is not None and not can(req, 'sales', 'create'):
        raise forbidden('You do not have permission to change project billing')


def _sync_tasks(org_id, project_id, lst, may_delete=True, req=None):
    """Replace the task list: matching ids update, new rows insert, missing rows are removed. Removing a task is the
    same effect as DELETE /projects/:id/tasks/:tid, so it needs projects:delete (may_delete)."""
    keep = set()
    cap_list(lst, 'tasks', 200)
    for t in lst:
        fields = _clean_task(t)
        if not fields['name']:
            continue
        rate_sent = isinstance(t, dict) and 'rate' in t
        existing = get('SELECT id, rate FROM project_tasks WHERE id = ? AND project_id = ? AND org_id = ?',
                       num_or_none(t.get('id')), project_id, org_id) if truthy(t.get('id')) else None
        if existing and not rate_sent:
            fields['rate'] = round2(num(existing['rate']))  # a hidden rate the client could not send back stays as stored
        if fields['rate'] != (round2(num(existing['rate'])) if existing else 0):
            _assert_may_price(req)  # task rates price task-hours invoices
        if existing:
            update('project_tasks', existing['id'], fields)
            keep.add(existing['id'])
        else:
            keep.add(insert('project_tasks', {**fields, 'org_id': org_id, 'project_id': project_id}))
    for t in all('SELECT id FROM project_tasks WHERE project_id = ? AND org_id = ? ORDER BY id', project_id, org_id):
        if t['id'] in keep:
            continue
        if not may_delete:
            raise forbidden('You do not have permission to delete project tasks')
        run('UPDATE time_entries SET task_id = NULL WHERE task_id = ?', t['id'])
        run('DELETE FROM project_tasks WHERE id = ?', t['id'])


def _project_totals(org_id, p):
    entries = all('SELECT user_id, minutes, billable, invoice_id, approval_status FROM time_entries WHERE org_id = ? AND project_id = ? ORDER BY id',
                  org_id, p['id'])

    def total(fn):
        s = 0
        for e in entries:
            if fn(e):
                s = s + jsnum(e.get('minutes'))
        return s

    logged = total(lambda e: True)
    billable = total(lambda e: truthy(e.get('billable')) and e.get('approval_status') == 'approved')
    unbilled = total(lambda e: truthy(e.get('billable')) and not truthy(e.get('invoice_id')) and e.get('approval_status') == 'approved')
    # invoiced revenue excludes tax; drafts, pending approvals and void documents are not revenue yet
    billed = get("""SELECT COALESCE(SUM(total - tax_total), 0) s FROM documents
                    WHERE org_id = ? AND project_id = ? AND doc_type = 'invoice' AND status NOT IN ('draft', 'pending_approval', 'void')""",
                 org_id, p['id'])['s']
    expenses = get('SELECT COALESCE(SUM(total), 0) s FROM expenses WHERE org_id = ? AND project_id = ? AND is_profile = 0', org_id, p['id'])['s']
    labor = 0
    for e in entries:
        u = next((x for x in p['users'] if x.get('user_id') == e.get('user_id')), None)
        labor = labor + ((jsnum(e.get('minutes')) / 60) * jsnum(u.get('cost_rate') if u is not None else 0))
    revenue = round2(billed)
    cost = round2(expenses + labor)
    bt = p.get('budget_type')
    budget_used = logged / 60 if bt == 'hours' else (billed if bt == 'amount' else 0)
    budget = jsnum(p.get('budget_hours')) if bt == 'hours' else (jsnum(p.get('budget_amount')) if bt == 'amount' else 0)
    return {
        'logged_hours': _hrs(logged),
        'billable_hours': _hrs(billable),
        'unbilled_hours': _hrs(unbilled),
        'billed_amount': revenue,
        'expenses_amount': round2(expenses),
        'labor_cost': round2(labor),
        'revenue': revenue,
        'cost': cost,
        'profit': round2(revenue - cost),
        'budget_type': bt,
        'budget': round2(budget),
        'budget_used': round2(budget_used),
        'budget_percent': _js_round((budget_used / budget) * 1000) / 10 if budget else None,
    }


FINANCIAL_TOTALS = ('billed_amount', 'expenses_amount', 'labor_cost', 'revenue', 'cost', 'profit')


def may_see_financials(req):
    # projects:view is held by timesheet staff to log time; cost rates and profit are management data.
    return req is None or can(req, 'reports', 'view')


HIDDEN_PROJECT_FIELDS = ('rate', 'budget_amount')  # billing terms and the money budget are management data


def _redact_users(users):
    return [{k: v for k, v in u.items() if k not in ('cost_rate', 'rate')} if isinstance(u, dict) else u for u in users]


def project_view(org_id, id_, req=None):
    p = _project_view(org_id, id_)
    if not may_see_financials(req):
        for k in HIDDEN_PROJECT_FIELDS:
            p.pop(k, None)
        p['tasks'] = [{k: v for k, v in t.items() if k != 'rate'} for t in p.get('tasks') or []]
        p['users'] = _redact_users(p['users'])
        p['totals'] = {k: v for k, v in p['totals'].items() if k not in FINANCIAL_TOTALS
                       and not (k in ('budget', 'budget_used', 'budget_percent') and p['totals'].get('budget_type') == 'amount')}
    return p


def _project_view(org_id, id_):
    p = load_project(org_id, id_)
    p['tasks'] = all('SELECT * FROM project_tasks WHERE project_id = ? AND org_id = ? ORDER BY id', id_, org_id)
    names = {u['id']: u['name'] for u in all(
        'SELECT u.id, u.name FROM users u JOIN org_users ou ON ou.user_id = u.id WHERE ou.org_id = ?', org_id)}
    p['users'] = [{**u, 'name': names.get(u.get('user_id')) or 'Unknown user'} for u in p['users']]
    p['totals'] = _project_totals(org_id, p)
    return p


def _list_projects(req):
    q = req.query
    status, customer_id, search = q.get('status'), q.get('customer_id'), q.get('q')
    where = ['p.org_id = ?']
    params = [req.org['id']]
    if truthy(status) and status != 'all':
        where.append('p.status = ?')
        params.append(status)
    if truthy(customer_id):
        where.append('p.customer_id = ?')
        params.append(num_or_none(customer_id))
    if truthy(search):
        where.append('(p.name ILIKE ? OR p.code ILIKE ? OR c.display_name ILIKE ?)')
        pat = like_pattern(_jstr(search)) or '%'
        params += [pat, pat, pat]
    rows = all(f"""SELECT p.*, c.display_name AS customer_name,
        (SELECT COALESCE(SUM(minutes), 0) FROM time_entries t WHERE t.project_id = p.id) AS logged_minutes,
        (SELECT COALESCE(SUM(minutes), 0) FROM time_entries t WHERE t.project_id = p.id AND t.billable = 1 AND t.invoice_id IS NULL AND t.approval_status = 'approved') AS unbilled_minutes,
        (SELECT COUNT(*) FROM project_tasks pt WHERE pt.project_id = p.id) AS task_count
      FROM projects p LEFT JOIN contacts c ON c.id = p.customer_id
      WHERE {' AND '.join(where)} ORDER BY lower(p.name), p.id""", *params)
    out = []
    for x in rows:
        x['users'] = _parse_users_loose(x.get('users'))
        out.append({**x, 'logged_hours': _hrs(x['logged_minutes']), 'unbilled_hours': _hrs(x['unbilled_minutes'])})
    if not may_see_financials(req):
        for x in out:
            x['users'] = _redact_users(x['users'])
            for k in HIDDEN_PROJECT_FIELDS:
                x.pop(k, None)
    return out


def _create_project(req):
    def _do():
        org = req.org['id']
        body = _body(req)
        o = _clean_project(org, body)
        if not o.get('name'):
            raise bad('Project name is required')
        # Same rule as _update_project: setting billing terms is the right to bill (sales:create).
        priced = (o.get('billing_method') not in (None, 'project_hours') or jsnum(o.get('rate')) or o.get('customer_id')
                  or any(jsnum(u.get('rate')) or jsnum(u.get('cost_rate')) for u in o.get('users') or []))
        if priced:
            _assert_may_price(req)
        if jsnum(o.get('budget_amount')) and not may_see_financials(req):
            raise forbidden('You do not have permission to set the project budget')
        id_ = insert('projects', {
            'billing_method': 'project_hours', 'rate': 0, 'budget_type': 'none', 'budget_hours': 0, 'budget_amount': 0,
            'status': 'active', 'users': [], **o, 'org_id': org,
        })
        if isinstance(body.get('tasks'), list):
            _sync_tasks(org, id_, body['tasks'], req=req)
        audit(req, 'project', id_, 'created', o['name'])
        return project_view(org, id_, req)
    return tx(_do)


def _update_project(req):
    def _do():
        org = req.org['id']
        id_ = to_int(req.params['id'])
        cur = load_project(org, id_)
        body = _body(req)
        o = _clean_project(org, body)
        if not may_see_financials(req):
            # Rates and the money budget are hidden from this caller, so its form cannot echo them back: keep the stored ones.
            # A sent value that differs is a real change: rate falls to the billing check below, the budget is refused.
            if 'budget_amount' in o and o['budget_amount'] != round2(num(cur.get('budget_amount'))):
                raise forbidden('You do not have permission to change the project budget')
            if 'users' in o:
                kept = {u.get('user_id'): u for u in cur.get('users') or [] if isinstance(u, dict)}
                o['users'] = [{**u, 'rate': round2(num((kept.get(u['user_id']) or {}).get('rate'))),
                               'cost_rate': round2(num((kept.get(u['user_id']) or {}).get('cost_rate')))} for u in o['users']]
        # Billing settings price the invoices raised from this project, so changing them needs the right to bill
        # (sales:create), not just projects:edit, which timesheet-only roles hold to log time.
        changed = [f for f in BILLING_FIELDS if f in o and o[f] != cur.get(f)]
        if changed and not can(req, 'sales', 'create'):
            raise forbidden('You do not have permission to change project billing')
        if o:
            update('projects', id_, o)
        if isinstance(body.get('tasks'), list):
            _sync_tasks(org, id_, body['tasks'], may_delete=can(req, 'projects', 'delete'), req=req)
        audit(req, 'project', id_, 'updated')
        return project_view(org, id_, req)
    return tx(_do)


def _delete_project(req):
    def _do():
        org = req.org['id']
        p = load_project(org, to_int(req.params['id']))
        # Document lines and expenses carry the project too: unlinking them would rewrite posted (possibly
        # locked) records and drop them from project reports, so any reference blocks the delete.
        used = get("""SELECT (SELECT COUNT(*) FROM documents WHERE project_id = ? AND org_id = ?)
                 + (SELECT COUNT(*) FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.project_id = ? AND d.org_id = ?)
                 + (SELECT COUNT(*) FROM expenses WHERE project_id = ? AND org_id = ?)
                 + (SELECT COUNT(*) FROM time_entries WHERE project_id = ?) n""",
                   p['id'], org, p['id'], org, p['id'], org, p['id'])['n']
        if used:
            raise bad('This project has transactions, expenses or time entries. Mark it as inactive instead.')
        run('DELETE FROM project_tasks WHERE project_id = ?', p['id'])
        run('DELETE FROM projects WHERE id = ?', p['id'])
        audit(req, 'project', p['id'], 'deleted', p['name'])
        return {'ok': True}
    return tx(_do)


# ---------- tasks ----------
def _task_out(req, t):
    return t if may_see_financials(req) else {k: v for k, v in t.items() if k != 'rate'}  # billing rates are management data


def _list_tasks(req):
    pid = to_int(req.params['id'])
    load_project(req.org['id'], pid)
    return [_task_out(req, t) for t in all('SELECT * FROM project_tasks WHERE project_id = ? AND org_id = ? ORDER BY id', pid, req.org['id'])]


def _create_task(req):
    def _do():
        org = req.org['id']
        pid = to_int(req.params['id'])
        load_project(org, pid)
        f = _clean_task(_body(req))
        if not f['name']:
            raise bad('Task name is required')
        if f['rate']:
            _assert_may_price(req)
        id_ = insert('project_tasks', {**f, 'org_id': org, 'project_id': pid})
        audit(req, 'project', pid, 'task added', f['name'])
        return _task_out(req, get('SELECT * FROM project_tasks WHERE id = ?', id_))
    return tx(_do)


def _load_task(org, pid, tid):
    t = get('SELECT * FROM project_tasks WHERE id = ? AND project_id = ? AND org_id = ?', tid, pid, org)
    if not t:
        raise not_found('Task')
    return t


def _update_task(req):
    def _do():
        org = req.org['id']
        pid = to_int(req.params['id'])
        load_project(org, pid)
        t = _load_task(org, pid, to_int(req.params['tid']))
        f = _clean_task({**t, **_body(req)})
        if not f['name']:
            raise bad('Task name is required')
        if f['rate'] != round2(num(t.get('rate'))):
            _assert_may_price(req)
        update('project_tasks', t['id'], f)
        return _task_out(req, get('SELECT * FROM project_tasks WHERE id = ?', t['id']))
    return tx(_do)


def _delete_task(req):
    def _do():
        org = req.org['id']
        pid = to_int(req.params['id'])
        load_project(org, pid)
        t = _load_task(org, pid, to_int(req.params['tid']))
        run('UPDATE time_entries SET task_id = NULL WHERE task_id = ?', t['id'])
        run('DELETE FROM project_tasks WHERE id = ?', t['id'])
        return {'ok': True}
    return tx(_do)


# ---------- time entries ----------
def _entry_row(org_id, id_):
    e = get('''SELECT t.*, p.name AS project_name, p.billing_method, tk.name AS task_name, u.name AS user_name, i.number AS invoice_number
               FROM time_entries t JOIN projects p ON p.id = t.project_id
               LEFT JOIN project_tasks tk ON tk.id = t.task_id LEFT JOIN users u ON u.id = t.user_id
               LEFT JOIN documents i ON i.id = t.invoice_id
               WHERE t.id = ? AND t.org_id = ?''', id_, org_id)
    return {**e, 'hours': _hrs(e['minutes'])} if e else e


def _load_entry(org_id, id_):
    e = get('SELECT * FROM time_entries WHERE id = ? AND org_id = ?', id_, org_id)
    if not e:
        raise not_found('Time entry')
    return e


def _entry_fields(req, body, existing=None, timer=False):
    """Validate and normalise a time entry body. Timer entries start at zero minutes."""
    org = req.org['id']
    if 'project_id' in body:
        pid = num_or_none(body['project_id'])
    else:
        pid = existing.get('project_id') if existing is not None else None
    project = get('SELECT * FROM projects WHERE id = ? AND org_id = ?', pid, org) if truthy(pid) else None
    if not project:
        raise bad('Choose a project')
    if existing is None and project['status'] != 'active':
        raise bad('This project is not active')

    if 'task_id' in body:
        tid = num_or_none(body['task_id']) if truthy(body['task_id']) else None
    else:
        tid = existing.get('task_id') if existing is not None else None
    task = None
    if truthy(tid):
        task = get('SELECT * FROM project_tasks WHERE id = ? AND project_id = ? AND org_id = ?', tid, pid, org)
        if not task:
            raise bad('The task does not belong to this project')

    date = body.get('date')
    if not truthy(date) and existing is not None and truthy(existing.get('date')):
        date = existing['date']
    if not truthy(date):
        date = today()
    if not DATE_RE.fullmatch(_jstr(date)):
        raise bad('Invalid date')

    minutes = existing.get('minutes') if existing is not None else 0
    if minutes is None:
        minutes = 0
    if timer:
        minutes = 0
    elif 'hours' in body and body['hours'] != '':
        minutes = _js_round(num(body['hours']) * 60)
    elif 'minutes' in body and body['minutes'] != '':
        minutes = _js_round(num(body['minutes']))
    if not timer and not (minutes > 0 and minutes <= 1440):
        raise bad('Enter a duration between 1 minute and 24 hours')

    if existing is not None and existing.get('user_id') is not None:
        user_id = existing['user_id']
    else:
        user_id = req.user['id']
    if truthy(body.get('user_id')) and num_or_none(body['user_id']) != user_id:
        if not can(req, 'projects', 'approve'):
            raise forbidden('Only approvers can log time for other people')
        target = num_or_none(body['user_id'])
        if not get("SELECT 1 AS ok FROM org_users WHERE org_id = ? AND user_id = ? AND status = 'active'", org, target):
            raise bad('Unknown user')
        user_id = target

    if 'billable' in body:
        billable = 1 if _flag(body['billable']) else 0
    elif existing is not None:
        billable = existing.get('billable')
    elif task is not None:
        billable = 1 if task.get('billable') else 0
    else:
        billable = 1

    if 'notes' in body:
        notes = body['notes'] if truthy(body['notes']) else None
    else:
        notes = existing.get('notes') if existing is not None else None

    return {
        'project_id': pid, 'task_id': tid, 'user_id': user_id, 'date': date, 'minutes': minutes, 'billable': billable,
        'notes': notes,
    }


def _can_edit_entry(req, e):
    return e.get('user_id') == req.user['id'] or can(req, 'projects', 'approve')


def _get_timer(req):
    t = get('SELECT id FROM time_entries WHERE org_id = ? AND user_id = ? AND timer_started_at IS NOT NULL ORDER BY id DESC LIMIT 1',
            req.org['id'], req.user['id'])
    return _entry_row(req.org['id'], t['id']) if t else None


def _start_timer(req):
    def _do():
        org = req.org['id']
        running = get('SELECT id FROM time_entries WHERE org_id = ? AND user_id = ? AND timer_started_at IS NOT NULL', org, req.user['id'])
        if running:
            raise bad('A timer is already running. Stop it before starting another.')
        f = _entry_fields(req, {**_body(req), 'date': today()}, None, timer=True)
        id_ = insert('time_entries', {**f, 'org_id': org, 'approval_status': 'approved', 'timer_started_at': now_iso()})
        audit(req, 'time_entry', id_, 'timer started')
        return _entry_row(org, id_)
    return tx(_do)


def _stop_timer(req):
    def _do():
        org = req.org['id']
        t = get('SELECT * FROM time_entries WHERE org_id = ? AND user_id = ? AND timer_started_at IS NOT NULL ORDER BY id DESC LIMIT 1',
                org, req.user['id'])
        if not t:
            raise not_found('Running timer')
        minutes = max(1, _js_round(_elapsed_ms_since(t['timer_started_at']) / 60000))
        upd = {'minutes': minutes, 'timer_started_at': None}
        body = _body(req)
        if 'notes' in body:
            upd['notes'] = body['notes'] if truthy(body['notes']) else None
        update('time_entries', t['id'], upd)
        audit(req, 'time_entry', t['id'], 'timer stopped', f'{minutes} min')
        return _entry_row(org, t['id'])
    return tx(_do)


def _list_entries(req):
    q = req.query
    where = ['t.org_id = ?']
    params = [req.org['id']]
    if not (can(req, 'projects', 'approve') or can(req, 'reports', 'view')):
        # timesheet staff see their own entries; approvers and report readers see everyone's
        where.append('t.user_id = ?')
        params.append(req.user['id'])
    if truthy(q.get('project_id')):
        where.append('t.project_id = ?')
        params.append(num_or_none(q.get('project_id')))
    if truthy(q.get('user_id')):
        where.append('t.user_id = ?')
        params.append(num_or_none(q.get('user_id')))
    if truthy(q.get('task_id')):
        where.append('t.task_id = ?')
        params.append(num_or_none(q.get('task_id')))
    if truthy(q.get('from')):
        where.append('t.date >= ?')
        params.append(q.get('from'))
    if truthy(q.get('to')):
        where.append('t.date <= ?')
        params.append(q.get('to'))
    if truthy(q.get('status')):
        where.append('t.approval_status = ?')
        params.append(q.get('status'))
    if _flag(q.get('unbilled')):
        where.append("t.billable = 1 AND t.invoice_id IS NULL AND t.approval_status = 'approved'")
    where_sql = ' AND '.join(where)
    rows = all(f"""SELECT t.*, p.name AS project_name, p.billing_method, tk.name AS task_name, u.name AS user_name, i.number AS invoice_number
        FROM time_entries t JOIN projects p ON p.id = t.project_id
        LEFT JOIN project_tasks tk ON tk.id = t.task_id LEFT JOIN users u ON u.id = t.user_id LEFT JOIN documents i ON i.id = t.invoice_id
        WHERE {where_sql} ORDER BY t.date DESC, t.id DESC LIMIT 2000""", *params)
    return [{**e, 'hours': _hrs(e['minutes'])} for e in rows]


def _create_entry(req):
    def _do():
        org = req.org['id']
        f = _entry_fields(req, _body(req))
        id_ = insert('time_entries', {**f, 'org_id': org, 'approval_status': 'approved'})
        audit(req, 'time_entry', id_, 'logged', f"{jsstr(f['minutes'])} min")
        return _entry_row(org, id_)
    return tx(_do)


def _update_entry(req):
    def _do():
        org = req.org['id']
        e = _load_entry(org, to_int(req.params['id']))
        if not _can_edit_entry(req, e):
            raise forbidden('You can only edit your own time')
        if e.get('invoice_id'):
            raise bad('This time entry has been invoiced. Remove it from the invoice to edit it.')
        if e.get('timer_started_at'):
            raise bad('Stop the running timer before editing this entry.')
        f = _entry_fields(req, _body(req), e)
        if not can(req, 'projects', 'approve') and any(k in f and f[k] != e.get(k) for k in ('minutes', 'project_id', 'task_id', 'billable', 'date')):
            f['approval_status'] = 'pending'  # the approver reviews the changed time before it can be invoiced
        update('time_entries', e['id'], f)
        audit(req, 'time_entry', e['id'], 'updated')
        return _entry_row(org, e['id'])
    return tx(_do)


def _delete_entry(req):
    def _do():
        org = req.org['id']
        e = _load_entry(org, to_int(req.params['id']))
        if not _can_edit_entry(req, e):
            raise forbidden('You can only delete your own time')
        if e.get('invoice_id'):
            raise bad('This time entry has been invoiced. Remove it from the invoice first.')
        run('DELETE FROM time_entries WHERE id = ?', e['id'])
        audit(req, 'time_entry', e['id'], 'deleted')
        return {'ok': True}
    return tx(_do)


def _set_approval(status):
    def handler(req):
        def _do():
            org = req.org['id']
            e = _load_entry(org, to_int(req.params['id']))
            if e.get('invoice_id'):
                raise bad('Invoiced time entries cannot change approval status')
            update('time_entries', e['id'], {'approval_status': status})
            audit(req, 'time_entry', e['id'], status)
            return _entry_row(org, e['id'])
        return tx(_do)
    return handler


# ---------- billing: unbilled time and expenses -> draft invoice ----------
def _invoice_project(req):
    def _do():
        # the invoice copies time notes and expense details into a customer document
        if not (can(req, 'sales', 'create') and can(req, 'projects', 'view')):
            raise forbidden()
        org = req.org['id']
        p = load_project(org, to_int(req.params['id']))
        body = _body(req)
        frm, to = body.get('from'), body.get('to')
        include_expenses = (True if 'include_expenses' not in body else _flag(body['include_expenses'])) and can(req, 'purchases', 'view')
        inv_date = body.get('date') if truthy(body.get('date')) else today()
        if not p.get('customer_id'):
            raise bad('Set a customer on the project before invoicing it')

        rng_sql, rng = '', []
        if truthy(frm):
            rng_sql += ' AND t.date >= ?'
            rng.append(frm)
        if truthy(to):
            rng_sql += ' AND t.date <= ?'
            rng.append(to)
        entries = all(f"""SELECT t.*, tk.name AS task_name, tk.rate AS task_rate, u.name AS user_name
            FROM time_entries t LEFT JOIN project_tasks tk ON tk.id = t.task_id LEFT JOIN users u ON u.id = t.user_id
            WHERE t.org_id = ? AND t.project_id = ? AND t.billable = 1 AND t.invoice_id IS NULL
              AND t.approval_status = 'approved' AND t.timer_started_at IS NULL{rng_sql}
            ORDER BY t.date, t.id""", org, p['id'], *rng)

        lines = []
        if p['billing_method'] == 'fixed':
            lines.append({'name': p['name'], 'description': 'Fixed fee', 'quantity': 1, 'unit': None, 'rate': round2(p.get('rate')),
                          'src_type': 'project', 'src_id': p['id'], 'project_id': p['id']})
        else:
            def rate_for(e):
                if p['billing_method'] == 'task_hours' and e.get('task_id') and jsnum(e.get('task_rate')) > 0:
                    return round2(e['task_rate'])
                if p['billing_method'] == 'staff_hours':
                    u = next((x for x in p['users'] if x.get('user_id') == e.get('user_id')), None)
                    if u is not None and jsnum(u.get('rate')) > 0:
                        return round2(u['rate'])
                return round2(p.get('rate'))

            for e in entries:
                desc = MIDDOT.join(_jstr(x) for x in (e.get('date'), e.get('user_name'), e.get('notes')) if truthy(x))
                lines.append({
                    'name': e.get('task_name') if truthy(e.get('task_name')) else 'Professional services',
                    'description': desc,
                    'quantity': _js_round(((e.get('minutes') or 0) / 60) * 10000) / 10000,
                    'unit': 'hrs',
                    'rate': rate_for(e),
                    'src_type': 'time', 'src_id': e['id'], 'project_id': p['id'],
                })

        if include_expenses:
            exp_sql, exp_rng = '', []
            if truthy(frm):
                exp_sql += ' AND e.date >= ?'
                exp_rng.append(frm)
            if truthy(to):
                exp_sql += ' AND e.date <= ?'
                exp_rng.append(to)
            expenses = all(f"""SELECT e.*, a.name AS account_name FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id
                WHERE e.org_id = ? AND e.project_id = ? AND e.is_billable = 1 AND e.invoice_id IS NULL AND e.is_profile = 0{exp_sql}
                ORDER BY e.date, e.id""", org, p['id'], *exp_rng)
            for e in expenses:
                label = e.get('reference') or e.get('account_name') or 'Expense'
                desc = MIDDOT.join(_jstr(x) for x in (e.get('date'), e.get('notes')) if truthy(x)) or None
                lines.append({
                    'name': f'Expense: {_jstr(label)}',
                    'description': desc,
                    'quantity': 1, 'unit': None,
                    'rate': round2(jsnum(e.get('total')) * (1 + jsnum(e.get('markup_percent')) / 100)),
                    'src_type': 'expense', 'src_id': e['id'], 'customer_id': p['customer_id'], 'project_id': p['id'],
                })
        if not lines:
            raise bad('There is nothing unbilled to invoice for this project in the selected period')

        settings = org_settings(req.org)
        res = save_document(req, 'invoice', {
            'contact_id': p['customer_id'], 'project_id': p['id'], 'lines': lines, 'date': inv_date,
            'notes': settings['preferences']['invoice_notes'], 'terms': settings['preferences']['invoice_terms'],
        })
        doc, warnings = res['doc'], res['warnings']

        # fixed-fee invoices bill the whole period in one line, so link the time entries directly
        if p['billing_method'] == 'fixed' and entries:
            ids = [e['id'] for e in entries]
            run(f"UPDATE time_entries SET invoice_id = ? WHERE id IN ({','.join('?' for _ in ids)})", doc['id'], *ids)
        audit(req, 'document', doc['id'], 'created', f"Invoice from project {_jstr(p['name'])}")
        audit(req, 'project', p['id'], 'invoiced', doc.get('number'))
        return {**doc, 'warnings': warnings}
    return tx(_do)


# ---------- routes ----------
def routes(r):
    # ----- projects -----
    r.get('/projects', perm('projects', 'view'), _list_projects)
    r.get('/projects/:id', perm('projects', 'view'), lambda req: project_view(req.org['id'], to_int(req.params['id']), req))
    r.post('/projects', perm('projects', 'create'), _create_project)
    r.put('/projects/:id', perm('projects', 'edit'), _update_project)
    r.delete('/projects/:id', perm('projects', 'delete'), _delete_project)

    # ----- tasks -----
    r.get('/projects/:id/tasks', perm('projects', 'view'), _list_tasks)
    r.post('/projects/:id/tasks', perm('projects', 'edit'), _create_task)
    r.put('/projects/:id/tasks/:tid', perm('projects', 'edit'), _update_task)
    r.delete('/projects/:id/tasks/:tid', perm('projects', 'delete'), _delete_task)

    # ----- timers (one running timer per user) -----
    r.get('/time-entries/timer', perm('projects', 'view'), _get_timer)
    r.post('/time-entries/timer/start', perm('projects', 'create'), _start_timer)
    r.post('/time-entries/timer/stop', perm('projects', 'create'), _stop_timer)

    # ----- time entries -----
    r.get('/time-entries', perm('projects', 'view'), _list_entries)
    r.post('/time-entries', perm('projects', 'create'), _create_entry)
    r.put('/time-entries/:id', perm('projects', 'edit'), _update_entry)
    r.delete('/time-entries/:id', perm('projects', 'delete'), _delete_entry)
    r.post('/time-entries/:id/approve', perm('projects', 'approve'), _set_approval('approved'))
    r.post('/time-entries/:id/reject', perm('projects', 'approve'), _set_approval('rejected'))

    # ----- billing -----
    r.post('/projects/:id/invoice', perm('projects', 'edit'), _invoice_project)
