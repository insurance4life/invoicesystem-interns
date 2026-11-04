"""Workflow automation: rules that react to audited events (email, webhook, field update),
the run log, and incoming webhooks that add activity or a comment to a record (port of modules/automation.js)."""
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request

from django.db import transaction

from books.core.db import all, get, run, insert, update, parse_json
from books.core.router import bad, not_found, forbidden
from books.core.util import audit, on_event, token
from books.core.auth import perm, can
from books.core.jsutil import now_iso, truthy
from books.core.documents import DOC_TYPES, load_doc
from books.core.mailer import send_email, fill_template
from books.modules.settings import JS_WS, UNDEF, bget, jt, js_string, sstr, js_number, n2i, is_finite, to_flag, js_json, _jsonable

RULE_MODULES = ['document', 'contact', 'item', 'expense', 'payment_received', 'payment_made']
TRIGGERS = ['created', 'updated', 'deleted', 'any']
OPS = ['equals', 'not_equals', 'gt', 'lt', 'contains']
METHODS = ['POST', 'PUT', 'PATCH', 'GET']
# fields a workflow may write, and how to coerce them
FIELD_RULES = {
    'contact': {'notes': 'text', 'website': 'text', 'is_active': 'bool', 'reminders_enabled': 'bool', 'credit_limit': 'number', 'payment_term_id': 'number'},
    'item': {'description': 'text', 'unit': 'text', 'is_active': 'bool', 'selling_price': 'number', 'purchase_price': 'number', 'reorder_level': 'number'},
}
TABLES = {'contact': 'contacts', 'item': 'items', 'expense': 'expenses'}
# audit entity_type -> rule module
EVENT_MODULES = {'document': 'document', 'contact': 'contact', 'item': 'item', 'expense': 'expense',
                 'payment_received': 'payment_received', 'payment_made': 'payment_made'}

# Set while a workflow runs so its own writes cannot re-trigger rules.
_busy = False


def _tpl(v):
    """`${v}` in a JS template literal."""
    return 'null' if v is None else js_string(v)


def _key(v):
    return v if isinstance(v, str) else None


def _or(*vals):
    """a || b || ... (JS): first truthy value, else the last one."""
    for v in vals[:-1]:
        if jt(v):
            return v
    return vals[-1]


def _nc(*vals):
    """a ?? b ?? ... (JS)"""
    for v in vals[:-1]:
        if v is not None and v is not UNDEF:
            return v
    return vals[-1]


def _msg(e):
    return getattr(e, 'message', None) or str(e)


# ---------- validation ----------
def validate_action(a, module):
    typ = bget(a, 'type')
    if typ == 'email':
        to = sstr(bget(a, 'to'))
        subject = sstr(bget(a, 'subject'))
        if not to:
            raise bad('Email action needs a recipient')
        if not subject:
            raise bad('Email action needs a subject')
        body = bget(a, 'body')
        return {'type': 'email', 'to': to, 'subject': subject, 'body': js_string('' if body is None or body is UNDEF else body)}
    if typ == 'webhook':
        url = sstr(bget(a, 'url'))
        if not re.match(r'https?://', url, re.IGNORECASE):
            raise bad('Webhook URL must start with http:// or https://')
        host = (urllib.parse.urlsplit(url).hostname or '').strip('[]')
        if not host:
            raise bad('Webhook URL needs a host name')
        if not _allow_private():
            try:
                literal = ipaddress.ip_address(host)
            except ValueError:
                literal = None
            if host.lower() == 'localhost' or host.lower().endswith('.localhost') or (literal and not _public_ip(host)):
                raise bad('Webhook URL must point to a public internet address')
        method = (sstr(bget(a, 'method')) or 'POST').upper()
        if method not in METHODS:
            raise bad('Webhook method must be POST, PUT, PATCH or GET')
        headers = {}
        h = bget(a, 'headers')
        if isinstance(h, dict):
            for k, v in h.items():
                if sstr(k):
                    headers[sstr(k)] = js_string('' if v is None else v)
        return {'type': 'webhook', 'url': url, 'method': method, 'headers': headers}
    if typ == 'field_update':
        if module not in FIELD_RULES:
            raise bad('Field updates are only available for contact and item rules')
        field = bget(a, 'field')
        if not FIELD_RULES[module].get(_key(field)):
            raise bad(f'Field "{_tpl(field)}" cannot be changed by a workflow')
        value = bget(a, 'value')
        return {'type': 'field_update', 'field': field, 'value': '' if value is None or value is UNDEF else value}
    raise bad(f'Unknown action type "{_tpl(typ)}"')


MAX_ACTIONS = 10
MAX_RULES = 100
# rule module -> modules whose view right the author needs for an email or webhook action to send that record's data out
_READ_RIGHTS = {'contact': ['contacts'], 'item': ['items'], 'expense': ['purchases'],
                'payment_received': ['sales'], 'payment_made': ['purchases']}


def assert_rule_reader(req, data):
    """Email and webhook actions copy the triggering record (including document share links) to an address the
    author chooses, so the author must be able to read that record's module, not just hold settings rights."""
    if any(a.get('type') == 'field_update' for a in data['actions']):
        target = {'contact': 'contacts', 'item': 'items'}.get(data['module'], 'settings')
        if not can(req, target, 'edit'):
            raise forbidden('You need edit access to these records to change them with a workflow')
        for a in data['actions']:
            if a.get('type') == 'field_update' and a.get('field') == 'payment_term_id' and a.get('value') not in ('', None):
                n = js_number(a.get('value'))
                ok = not (isinstance(n, float) and math.isnan(n)) and get('SELECT id FROM payment_terms WHERE id = ? AND org_id = ?', n2i(n), req.org['id'])
                if not ok:
                    raise bad('Choose a payment term from this organization')
    if not any(a.get('type') in ('email', 'webhook') for a in data['actions']):
        return
    if data['module'] == 'document':
        need = [_side(data['doc_type'])] if data.get('doc_type') else ['sales', 'purchases']
    else:
        need = _READ_RIGHTS.get(data['module'], ['settings'])
    if any(not can(req, m, 'view') for m in need):  # (all is db.all in this module)
        raise forbidden('You need view access to these records to send them by email or webhook')


def _side(doc_type):
    return 'sales' if (DOC_TYPES.get(doc_type) or {}).get('side') == 'sales' else 'purchases'


def validate_rule(body):
    name = sstr(bget(body, 'name'))
    if not name:
        raise bad('Rule name is required')
    module = bget(body, 'module')
    if not isinstance(module, str) or module not in RULE_MODULES:
        raise bad('Choose what the rule applies to')
    trigger = _or(bget(body, 'trigger'), 'created')
    if not isinstance(trigger, str) or trigger not in TRIGGERS:
        raise bad('Invalid trigger')
    doc_type = None
    bdt = bget(body, 'doc_type')
    if module == 'document' and jt(bdt):
        if not DOC_TYPES.get(_key(bdt)):
            raise bad('Unknown document type')
        doc_type = bdt
    conds = bget(body, 'conditions')
    conditions = []
    for c in (conds if isinstance(conds, list) else []):
        if not sstr(bget(c, 'field')):
            raise bad('Each condition needs a field')
        op = bget(c, 'op')
        if not isinstance(op, str) or op not in OPS:
            raise bad(f'Unknown condition operator "{_tpl(op)}"')
        v = bget(c, 'value')
        conditions.append({'field': sstr(bget(c, 'field')), 'op': op, 'value': '' if v is None or v is UNDEF else v})
    acts = bget(body, 'actions')
    if isinstance(acts, list) and len(acts) > MAX_ACTIONS:
        raise bad(f'A rule can have at most {MAX_ACTIONS} actions')
    actions = [validate_action(a, module) for a in (acts if isinstance(acts, list) else [])]
    if not actions:
        raise bad('Add at least one action')
    ia = bget(body, 'is_active')
    return {'name': name, 'module': module, 'doc_type': doc_type, 'trigger': trigger, 'conditions': conditions, 'actions': actions,
            'is_active': to_flag(1 if ia is None or ia is UNDEF else ia)}


def hook_input(body):
    name = sstr(bget(body, 'name'))
    if not name:
        raise bad('Name is required')
    module = bget(body, 'module')
    if not isinstance(module, str) or module not in RULE_MODULES:
        raise bad('Choose which module the webhook writes to')
    return {'name': name, 'module': module}


def _id(v):
    n = js_number(v)
    return 0 if (isinstance(n, float) and math.isnan(n)) or not n else n2i(n)


def rule_row(org_id, id):  # noqa: A002
    r = get('SELECT * FROM workflow_rules WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not r:
        raise not_found('Rule')
    return parse_json(r, ['conditions', 'actions'])


def hook_view(hook, req=None):
    if req is not None and not can(req, 'settings', 'edit'):
        return {k: v for k, v in hook.items() if k != 'token'}  # the token alone lets anyone post into the org
    return {**hook, 'url': f"/api/public/hooks/{hook['token']}"}


def rule_out(req, rule):
    """Webhook header values are usually third-party credentials: hidden from read-only settings roles."""
    if can(req, 'settings', 'edit'):
        return rule
    acts = [{**a, 'headers': {k: '********' for k in (a.get('headers') or {})}} if isinstance(a, dict) and a.get('type') == 'webhook' else a
            for a in (rule.get('actions') or [])]
    return {**rule, 'actions': acts}


def hook_row(org_id, id):  # noqa: A002
    hook = get('SELECT * FROM incoming_webhooks WHERE id = ? AND org_id = ?', _id(id), org_id)
    if not hook:
        raise not_found('Webhook')
    return hook


# ---------- records & conditions ----------
def load_record(org_id, module, id):  # noqa: A002
    def _load():
        if module == 'document':
            return load_doc(org_id, id, with_lines=False)
        if module in ('payment_received', 'payment_made'):
            return get('SELECT * FROM payments WHERE id = ? AND org_id = ? AND type = ?', id, org_id,
                       'received' if module == 'payment_received' else 'made') or None
        return get(f'SELECT * FROM {TABLES[module]} WHERE id = ? AND org_id = ?', id, org_id) or None
    try:
        with transaction.atomic():
            return _load()
    except Exception:  # noqa: BLE001
        return None


def compare(actual, op, expected):
    a = '' if actual is None or actual is UNDEF else actual
    b = '' if expected is None or expected is UNDEF else expected
    na = js_number(a)
    nb = js_number(b)
    numeric = a != '' and b != '' and is_finite(na) and is_finite(nb)
    if op == 'equals':
        return na == nb if numeric else js_string(a).strip(JS_WS).lower() == js_string(b).strip(JS_WS).lower()
    if op == 'not_equals':
        return not compare(a, 'equals', b)
    if op == 'gt':
        return numeric and na > nb
    if op == 'lt':
        return numeric and na < nb
    if op == 'contains':
        return js_string(b).lower() in js_string(a).lower()
    return False


# ---------- actions ----------
def template_vars(org, module, record):
    rec = record or {}
    if module == 'document' and jt(rec.get('doc_type')):
        from books.modules.documents import email_vars  # noqa: PLC0415
        return {**email_vars(org, rec), 'contact_email': _or(rec.get('contact_email'), ''), 'amount': _nc(rec.get('total'), '')}
    return {
        'org_name': org.get('name'), 'id': _nc(rec.get('id'), ''),
        'number': _or(rec.get('number'), rec.get('display_name'), rec.get('reference'), rec.get('id'), ''),
        'contact_name': _or(rec.get('contact_name'), rec.get('display_name'), ''),
        'contact_email': _or(rec.get('contact_email'), rec.get('email'), ''),
        'total': _nc(rec.get('total'), rec.get('amount'), ''), 'amount': _nc(rec.get('amount'), rec.get('total'), ''),
        'balance': _nc(rec.get('balance'), ''),
        'currency': _or(rec.get('currency'), org.get('currency')), 'date': _or(rec.get('date'), ''), 'due_date': _or(rec.get('due_date'), ''), 'link': '',
    }


def _allow_private():
    return os.environ.get('OPENBOOKS_WEBHOOK_ALLOW_PRIVATE') == '1'


def _public_ip(addr):
    ip = ipaddress.ip_address(addr.split('%')[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def all_public(addrs):
    for a in addrs:
        if not _public_ip(a):
            return False
    return True


def _connect_public(host, port, timeout):
    """Resolve host, refuse any non-public address (loopback, private, link-local, metadata...), then connect to
    exactly the address that was checked, so DNS cannot change the answer between check and use."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos:
        raise OSError(f'cannot resolve {host}')
    if not _allow_private() and not all_public(i[4][0] for i in infos):
        raise PermissionError(f'webhook destination {host} is not a public address')
    err = None
    for family, socktype, proto, _, addr in infos:
        s = socket.socket(family, socktype, proto)
        s.settimeout(timeout)
        try:
            s.connect(addr)
            return s
        except OSError as e:
            s.close()
            err = e
    raise err


class _GuardedHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = _connect_public(self.host, self.port, self.timeout)


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(_connect_public(self.host, self.port, self.timeout), server_hostname=self.host)


class _GuardedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_GuardedHTTPConnection, req)


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_GuardedHTTPSConnection, req, context=self._context)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # a 3xx is reported as the webhook's status
        return None


# fetch() ignores proxy settings; every connection goes through the public-address guard and redirects are not followed.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _GuardedHTTPHandler, _GuardedHTTPSHandler, _NoRedirect)


def _fetch(act, payload):
    """The HTTP call itself (urllib); returns the status or raises with the JS error text."""
    headers = {'content-type': 'application/json', **act['headers']}
    data = None if act['method'] == 'GET' else json.dumps(_jsonable(payload), separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(act['url'], data=data, method=act['method'])
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        resp = _OPENER.open(req, timeout=5)
        status = resp.status
        # only the status matters: the body is never read, so an endless or slow response cannot pin memory or the thread
        resp.close()
    except urllib.error.HTTPError as e:
        status = e.code
        e.close()
    except (TimeoutError, socket.timeout) as e:
        raise RuntimeError(f"Timed out after 5s: {act['url']}") from e
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            raise RuntimeError(f"Timed out after 5s: {act['url']}") from e
        raise RuntimeError(f"fetch failed: {act['url']}") from e
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"fetch failed: {act['url']}") from e
    return status


# Process-wide cap on webhook calls in flight; a call that cannot get a slot is logged as skipped, not queued.
_WEBHOOK_SLOTS = threading.BoundedSemaphore(int(os.environ.get('OPENBOOKS_WEBHOOK_CONCURRENCY') or 16))
_TOKEN_KEYS = ('share_token', 'portal_token')


def _send_webhook(act, payload):
    """fetch() with AbortSignal.timeout(5000): the whole call must finish within 5s."""
    box = {}

    def work():
        try:
            box['status'] = _fetch(act, payload)
        except Exception as e:  # noqa: BLE001
            box['error'] = e
        finally:
            _WEBHOOK_SLOTS.release()  # only when the socket work really ends, even after the 5s join gave up
    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(5)
    if t.is_alive():
        raise RuntimeError(f"Timed out after 5s: {act['url']}")
    if 'error' in box:
        raise box['error']
    status = box['status']
    if not (200 <= status <= 299):
        raise RuntimeError(f"HTTP {status} from {act['url']}")
    return f"HTTP {status} from {act['url']}"


def _webhook_thread(act, payload, log_id):
    from django.db import connection  # noqa: PLC0415
    from books.core.router import API_LOCK  # noqa: PLC0415
    try:
        try:
            patch = {'status': 'success', 'message': _send_webhook(act, payload)}
        except Exception as e:  # noqa: BLE001
            patch = {'status': 'failed', 'message': _msg(e)}
        try:
            with API_LOCK:
                update('workflow_logs', log_id, patch)
        except Exception:  # noqa: BLE001
            pass
    finally:
        connection.close()


def log_row(org_id, rule_id, ctx, action_type, status, message):
    return insert('workflow_logs', {
        'org_id': org_id, 'rule_id': rule_id, 'entity_type': ctx['module'], 'entity_id': ctx['entity_id'],
        'action_type': action_type, 'status': status, 'message': js_string(message)[:500],
    })


def run_action(org, rule, act, ctx):
    """Runs one action and writes its log row. Webhooks are fire-and-forget: the log is updated when the call ends."""
    act_type = act.get('type') if isinstance(act, dict) else None

    def record(status, message):
        return log_row(org['id'], rule['id'], ctx, act_type, status, message)
    try:
        with transaction.atomic():
            if act_type == 'webhook':
                rec = ctx['record']
                payload = {
                    'event': {'trigger': ctx['trigger'], 'action': ctx['action'], 'module': ctx['module'],
                              'doc_type': _or((rec or {}).get('doc_type'), None), 'at': now_iso()},
                    'org': {'id': org['id'], 'name': org.get('name')},
                    # capability tokens stay inside OpenBooks; the receiver gets the record data only
                    'entity': {'id': ctx['entity_id'], **{k: v for k, v in (rec or {}).items() if k not in _TOKEN_KEYS}},
                }
                if not _WEBHOOK_SLOTS.acquire(blocking=False):
                    record('failed', 'Skipped: too many webhook calls in progress')
                    return
                log_id = record('pending', f"{act['method']} {act['url']}")
                threading.Thread(target=_webhook_thread, args=(act, payload, log_id), daemon=True).start()
                return
            if act_type == 'email':
                vars_ = template_vars(org, ctx['module'], ctx['record'])
                to = fill_template(act.get('to'), vars_).strip(JS_WS)
                if '@' not in to:
                    raise RuntimeError(f'No valid recipient "{to}"')
                subject = fill_template(act.get('subject'), vars_)
                eid = send_email(org, to, subject, fill_template(act.get('body'), vars_), entity_type=ctx['module'], entity_id=ctx['entity_id'])
                record('success', f'Email #{eid} to {to}: {subject}')
                return
            if act_type == 'field_update':
                if not ctx['record']:
                    raise RuntimeError('The record no longer exists')
                field = act.get('field')
                kind = FIELD_RULES[ctx['module']][field]
                value = act.get('value')
                value = None if value == '' or value is None else value
                if value is not None and kind == 'number':
                    value = js_number(value)
                    if not is_finite(value):
                        raise RuntimeError(f'{field} needs a number')
                    value = n2i(value)
                if value is not None and kind == 'bool':
                    value = to_flag(value)  # ['1', 'true', 1, true].includes(value) ? 1 : 0
                run(f"UPDATE {TABLES[ctx['module']]} SET {field} = ? WHERE id = ? AND org_id = ?", value, ctx['entity_id'], org['id'])
                record('success', f"{field} set to {'empty' if value is None else js_string(value)}")
                return
            raise RuntimeError(f'Unknown action {_tpl(act_type)}')
    except Exception as e:  # noqa: BLE001
        record('failed', _msg(e))


# ---------- event listener: runs rules for every audited event ----------
def _on_event(req=None, entity_type=None, entity_id=None, action=None, detail=None):  # noqa: ARG001
    global _busy  # noqa: PLW0603
    module = EVENT_MODULES.get(entity_type) if isinstance(entity_type, str) else None
    org = getattr(req, 'org', None) if req is not None else None
    if _busy or not module or not truthy(entity_id) or not org or not truthy(org.get('id')):
        return
    # 'created' and 'deleted' are exact; every other audit action (marked as sent, emailed, payment recorded...) is an update
    trigger = action if action in ('created', 'deleted') else 'updated'
    rules = [parse_json(x, ['conditions', 'actions']) for x in all('''SELECT * FROM workflow_rules WHERE org_id = ? AND module = ? AND is_active = 1
        AND (trigger = ? OR trigger = 'any') ORDER BY id''', org['id'], module, trigger)]
    if not rules:
        return
    eid = n2i(js_number(entity_id))
    record = load_record(org['id'], module, eid)
    _busy = True
    try:
        for rule in rules:
            if jt(rule.get('doc_type')) and (record or {}).get('doc_type') != rule['doc_type']:
                continue
            conds = rule['conditions'] if isinstance(rule['conditions'], list) else []
            # deleted records cannot be checked against conditions, so such rules are skipped
            if conds and not record:
                continue
            if not all_(compare((record or {}).get(_key(bget(c, 'field'))), bget(c, 'op'), bget(c, 'value')) for c in conds):
                continue
            ctx = {'module': module, 'record': record, 'entity_id': eid, 'action': action, 'trigger': trigger}
            for act in (rule['actions'] if isinstance(rule['actions'], list) else []):
                run_action(org, rule, act, ctx)
    finally:
        _busy = False


def all_(it):
    for x in it:
        if not x:
            return False
    return True


on_event(_on_event)


# ---------- routes ----------
def routes(r):
    r.get('/automation/rules', perm('settings', 'view'), lambda req: [rule_out(req, parse_json(x, ['conditions', 'actions'])) for x in all(
        'SELECT * FROM workflow_rules WHERE org_id = ? ORDER BY name COLLATE "C", id', req.org['id'])])

    r.get('/automation/rules/:id', perm('settings', 'view'), lambda req: rule_out(req, rule_row(req.org['id'], req.params['id'])))

    def post_rule(req):
        data = validate_rule(req.body if isinstance(req.body, dict) else {})
        assert_rule_reader(req, data)
        if get('SELECT COUNT(*) AS n FROM workflow_rules WHERE org_id = ?', req.org['id'])['n'] >= MAX_RULES:
            raise bad(f'An organization can have at most {MAX_RULES} workflow rules')
        rid = insert('workflow_rules', {'org_id': req.org['id'], **data, 'conditions': js_json(data['conditions']), 'actions': js_json(data['actions'])})
        audit(req, 'workflow_rule', rid, 'created', data['name'])
        return rule_row(req.org['id'], rid)
    r.post('/automation/rules', perm('settings', 'create'), post_rule)

    def put_rule(req):
        existing = rule_row(req.org['id'], req.params['id'])
        data = validate_rule({**existing, **(req.body if isinstance(req.body, dict) else {})})
        assert_rule_reader(req, data)
        update('workflow_rules', existing['id'], {**data, 'conditions': js_json(data['conditions']), 'actions': js_json(data['actions'])})
        audit(req, 'workflow_rule', existing['id'], 'updated', data['name'])
        return rule_row(req.org['id'], existing['id'])
    r.put('/automation/rules/:id', perm('settings', 'edit'), put_rule)

    def delete_rule(req):
        existing = rule_row(req.org['id'], req.params['id'])
        run('DELETE FROM workflow_logs WHERE org_id = ? AND rule_id = ?', req.org['id'], existing['id'])
        run('DELETE FROM workflow_rules WHERE id = ? AND org_id = ?', existing['id'], req.org['id'])
        audit(req, 'workflow_rule', existing['id'], 'deleted', existing['name'])
        return {'ok': True}
    r.delete('/automation/rules/:id', perm('settings', 'delete'), delete_rule)

    def logs(req):
        q = req.query
        where = ['l.org_id = ?']
        p = [req.org['id']]
        if q.get('rule_id'):
            n = js_number(q['rule_id'])
            where.append('l.rule_id = ?')
            p.append(None if isinstance(n, float) and math.isnan(n) else n2i(n))
        if q.get('status'):
            where.append('l.status = ?')
            p.append(str(q['status']))
        n = js_number(q.get('limit', UNDEF))
        lim = 200 if (isinstance(n, float) and math.isnan(n)) or not n else n
        lim = min(lim, 1000)
        lim = None if lim < 0 else int(lim)  # SQLite treats a negative LIMIT as "no limit"
        return all(f'''SELECT l.*, r.name AS rule_name FROM workflow_logs l LEFT JOIN workflow_rules r ON r.id = l.rule_id
          WHERE {' AND '.join(where)} ORDER BY l.id DESC LIMIT ?''', *p, lim)
    r.get('/automation/logs', perm('settings', 'view'), logs)

    r.get('/automation/incoming-webhooks', perm('settings', 'view'), lambda req: [hook_view(h, req) for h in all(
        'SELECT * FROM incoming_webhooks WHERE org_id = ? ORDER BY name COLLATE "C", id', req.org['id'])])

    def post_hook(req):
        data = hook_input(req.body if isinstance(req.body, dict) else {})
        hid = insert('incoming_webhooks', {'org_id': req.org['id'], **data, 'token': token(24)})
        audit(req, 'incoming_webhook', hid, 'created', data['name'])
        return hook_view(hook_row(req.org['id'], hid))
    r.post('/automation/incoming-webhooks', perm('settings', 'create'), post_hook)

    def put_hook(req):
        b = req.body if isinstance(req.body, dict) else {}
        hook = hook_row(req.org['id'], req.params['id'])
        data = hook_input({**hook, **b})
        if jt(bget(b, 'regenerate')):
            data['token'] = token(24)
        update('incoming_webhooks', hook['id'], data)
        audit(req, 'incoming_webhook', hook['id'], 'updated', data['name'])
        return hook_view(hook_row(req.org['id'], hook['id']))
    r.put('/automation/incoming-webhooks/:id', perm('settings', 'edit'), put_hook)

    def delete_hook(req):
        hook = hook_row(req.org['id'], req.params['id'])
        run('DELETE FROM incoming_webhooks WHERE id = ? AND org_id = ?', hook['id'], req.org['id'])
        audit(req, 'incoming_webhook', hook['id'], 'deleted', hook['name'])
        return {'ok': True}
    r.delete('/automation/incoming-webhooks/:id', perm('settings', 'delete'), delete_hook)


def public_routes(pub):
    """POST /api/public/hooks/:token adds an activity entry (and a comment when entity_id matches)."""
    def incoming(req):
        hook = get('SELECT * FROM incoming_webhooks WHERE token = ?', str(req.params['token']))
        if not hook:
            raise not_found('Webhook')
        body = req.body if isinstance(req.body, (dict, list)) else {}
        text = (sstr(_or(bget(body, 'text'), bget(body, 'message'), bget(body, 'comment'))) or js_json(body)[:2000])[:5000]
        n = js_number(bget(body, 'entity_id'))
        target = load_record(hook['org_id'], hook['module'], n2i(n)) if (not (isinstance(n, float) and math.isnan(n)) and n) else None
        insert('activity', {
            'org_id': hook['org_id'], 'user_id': None, 'entity_type': hook['module'], 'entity_id': target['id'] if target else None,
            'action': 'incoming webhook', 'detail': js_json({'hook': hook['name'], 'text': text}),
        })
        if target:
            insert('comments', {
                'org_id': hook['org_id'], 'entity_type': hook['module'], 'entity_id': target['id'], 'user_id': None,
                'author': f"Webhook: {hook['name']}", 'text': text,
            })
        return {'ok': True, 'comment': bool(target)}
    pub.post('/hooks/:token', incoming)
