"""Org profile, lookups ("meta"), global search, activity, comments, outbox (port of modules/core.js)."""
import json

from books.core.db import all, get, insert, update, run, parse_json
from books.core.router import bad, forbidden
from books.core.util import org_settings, save_org_settings, clean_body, audit, like_pattern, canon_date
from books.core.orgs import check_sizes as check_org_sizes, delete_org as remove_org
from books.core.auth import perm, can, MODULES
from books.core.entities import assert_entity_access, entity_module, visible_rows
from books.core.documents import DOC_TYPES

COMMENT_MAX = 5000
SLUGS = {
    'quote': 'quotes', 'salesorder': 'salesorders', 'invoice': 'invoices', 'retainer': 'retainerinvoices', 'creditnote': 'creditnotes',
    'deliverychallan': 'deliverychallans', 'salesreceipt': 'salesreceipts', 'recurring_invoice': 'recurringinvoices',
    'purchaseorder': 'purchaseorders', 'bill': 'bills', 'vendorcredit': 'vendorcredits', 'recurring_bill': 'recurringbills',
}


def load_meta(req):
    org = get('SELECT * FROM orgs WHERE id = ?', req.org['id'])
    parse_json(org, ['address'])
    settings = org_settings(org)
    del org['settings']
    oid = org['id']
    return {
        'org': org, 'settings': settings, 'role': req.role, 'permissions': req.perms,
        'taxes': [parse_json(t, ['group_ids']) for t in all('SELECT * FROM taxes WHERE org_id = ? ORDER BY kind, rate, id', oid)],
        'payment_terms': all('SELECT * FROM payment_terms WHERE org_id = ? ORDER BY days, id', oid),
        'tds_sections': all('SELECT * FROM tds_sections WHERE org_id = ? ORDER BY section, rate, id', oid),
        'currencies': all('SELECT * FROM currencies WHERE org_id = ? ORDER BY is_base DESC, code', oid),
        'accounts': all('SELECT id, code, name, type, parent_id, system_code, is_active, is_system FROM accounts WHERE org_id = ? ORDER BY type, code, name', oid),
        'users': all('''SELECT u.id, u.name, u.email, r.name AS role, ou.status FROM org_users ou JOIN users u ON u.id = ou.user_id
                        LEFT JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? ORDER BY ou.id''', oid),
        'custom_fields': [parse_json(c, ['options']) for c in all('SELECT * FROM custom_fields WHERE org_id = ? ORDER BY id', oid)],
        'doc_types': DOC_TYPES,
        'modules': MODULES,
    }


def _org_perm(lock_key):
    """Transaction locking is an Accountant feature: lock-only changes need accountant:edit instead of settings:edit."""
    def mw(req):
        body = req.body if isinstance(req.body, dict) else {}
        keys = list(body.keys())
        if keys and all_(k == lock_key for k in keys) and can(req, 'accountant', 'edit'):
            return
        perm('settings', 'edit')(req)
    return mw


def all_(it):
    for x in it:
        if not x:
            return False
    return True


def _org_row(org_id):
    org = parse_json(get('SELECT * FROM orgs WHERE id = ?', org_id), ['address'])
    org['settings'] = org_settings(org)
    return org


def routes(r):
    r.get('/meta', load_meta)
    r.get('/org', lambda req: _org_row(req.org['id']))

    def put_org(req):
        fields = clean_body(req.body, ['name', 'industry', 'country', 'state', 'currency', 'fiscal_year_start', 'timezone', 'date_format',
                                       'gstin', 'gst_enabled', 'address', 'phone', 'email', 'website', 'logo', 'lock_date'])
        if 'name' in fields and fields['name'] is None:
            raise bad('Organization name is required')
        if isinstance(fields.get('address'), dict):
            fields['address'] = json.dumps(fields['address'], separators=(',', ':'), ensure_ascii=False)
        # the org row is read on every request in this org, so its free-text and image fields are bounded
        for k, n in (('logo', 400_000), ('address', 2000), ('website', 500), ('name', 200), ('industry', 100), ('country', 100), ('state', 100),
                     ('currency', 10), ('timezone', 64), ('date_format', 20), ('gstin', 20), ('phone', 40), ('email', 254)):
            if fields.get(k) is not None and len(str(fields[k])) > n:
                raise bad(f'{k.capitalize()} is too large')
        if fields.get('lock_date'):
            fields['lock_date'] = canon_date(fields['lock_date'], 'lock date')
        check_org_sizes(fields)
        if fields.get('currency') and fields['currency'] != req.org['currency']:
            if get('SELECT COUNT(*) n FROM ledger WHERE org_id = ?', req.org['id'])['n']:
                raise bad('Base currency cannot be changed after transactions exist')
        update('orgs', req.org['id'], fields)
        if fields.get('currency') and fields['currency'] != req.org['currency']:
            run('UPDATE currencies SET is_base = 0 WHERE org_id = ?', req.org['id'])
            if get('SELECT id FROM currencies WHERE org_id = ? AND code = ?', req.org['id'], fields['currency']):
                run('UPDATE currencies SET is_base = 1, exchange_rate = 1 WHERE org_id = ? AND code = ?', req.org['id'], fields['currency'])
            else:
                insert('currencies', {'org_id': req.org['id'], 'code': fields['currency'], 'symbol': fields['currency'], 'name': fields['currency'], 'exchange_rate': 1, 'is_base': 1})
        if req.body.get('settings'):
            save_org_settings(req.org['id'], req.body['settings'])
        audit(req, 'org', req.org['id'], 'updated', ', '.join(fields.keys()))
        return _org_row(req.org['id'])
    r.put('/org', _org_perm('lock_date'), put_org)

    def put_settings(req):
        body = req.body if isinstance(req.body, dict) else {}
        s = save_org_settings(req.org['id'], body)
        audit(req, 'org', req.org['id'], 'settings updated', ', '.join(body.keys()))
        return s
    r.put('/org/settings', _org_perm('locks'), put_settings)

    def delete_org(req):
        if req.role != 'Admin':
            raise bad('Only an admin can delete the organization')
        remove_org(req.org['id'])
        return {'ok': True}
    r.delete('/org', perm('settings', 'delete'), delete_org)

    def leave_org(req):
        admins = get("SELECT COUNT(*) n FROM org_users ou JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? AND r.name = 'Admin' AND ou.status='active'", req.org['id'])['n']
        if req.role == 'Admin' and admins <= 1:
            raise bad('You are the only admin. Delete the organization or make someone else an admin first.')
        run('DELETE FROM org_users WHERE org_id = ? AND user_id = ?', req.org['id'], req.user['id'])
        return {'ok': True}
    r.post('/org/leave', leave_org)

    # ---------- global search ----------
    def search(req):
        q = like_pattern(req.query.get('q'))
        if not q:
            return {'results': []}
        oid = req.org['id']
        out = []
        if can(req, 'contacts', 'view'):
            for c in all('SELECT id, type, display_name, email FROM contacts WHERE org_id = ? AND (display_name ILIKE ? OR email ILIKE ? OR company_name ILIKE ? OR gstin ILIKE ?) ORDER BY id LIMIT 8', oid, q, q, q, q):
                out.append({'kind': c['type'], 'id': c['id'], 'title': c['display_name'], 'subtitle': c['email'],
                            'url': f"/{'customers' if c['type'] == 'customer' else 'vendors'}/{c['id']}"})
        if can(req, 'items', 'view'):
            for i in all('SELECT id, name, sku FROM items WHERE org_id = ? AND (name ILIKE ? OR sku ILIKE ?) ORDER BY id LIMIT 8', oid, q, q):
                out.append({'kind': 'item', 'id': i['id'], 'title': i['name'], 'subtitle': i['sku'], 'url': f"/items/{i['id']}"})
        from books.core.jsutil import jsstr  # noqa: PLC0415
        # only search the sides the member can view, instead of scanning everything and discarding rows afterwards
        types = [t for t, cfg in DOC_TYPES.items() if can(req, 'sales' if cfg.get('side') == 'sales' else 'purchases', 'view')]
        docs = all(f'''SELECT d.id, d.doc_type, d.number, d.total, c.display_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
                       WHERE d.org_id = ? AND d.doc_type IN ({','.join('?' for _ in types)})
                       AND (d.number ILIKE ? OR d.reference ILIKE ? OR c.display_name ILIKE ?) ORDER BY d.date DESC, d.id LIMIT 12''',
                   oid, *types, q, q, q) if types else []
        for d in docs:
            out.append({'kind': d['doc_type'], 'id': d['id'], 'title': d['number'],
                        'subtitle': f"{(DOC_TYPES.get(d['doc_type']) or {}).get('label')} · {d['display_name'] or ''} · {jsstr(d['total'])}",
                        'url': f"/{SLUGS.get(d['doc_type'])}/{d['id']}"})
        kinds = [k for k, m in (('received', 'sales'), ('made', 'purchases')) if can(req, m, 'view')]
        pays = all(f'''SELECT p.id, p.type, p.number, p.amount, c.display_name FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
                       WHERE p.org_id = ? AND p.type IN ({','.join('?' for _ in kinds)}) AND (p.number ILIKE ? OR p.reference ILIKE ?)
                       ORDER BY p.id LIMIT 6''', oid, *kinds, q, q) if kinds else []
        for p in pays:
            out.append({'kind': f"payment_{p['type']}", 'id': p['id'], 'title': p['number'], 'subtitle': f"{p['display_name']} · {jsstr(p['amount'])}",
                        'url': f"/payments-{p['type']}/{p['id']}"})
        return {'results': out}
    r.get('/search', search)

    # ---------- activity / audit trail ----------
    def activity(req):
        qy = req.query
        eid = None
        if qy.get('entity_id'):
            eid = _eid(qy['entity_id'])
            if eid is None:
                raise bad('A valid record id is required')  # one id, used for both the check and the filter
        if qy.get('entity_type') and eid is not None:
            assert_entity_access(req, qy['entity_type'], eid, 'view')
        elif not can(req, 'reports', 'view'):
            raise forbidden()
        where = ['a.org_id = ?']
        p = [req.org['id']]
        if qy.get('entity_type'):
            where.append('a.entity_type = ?')
            p.append(qy['entity_type'])
        if qy.get('entity_id'):
            where.append('a.entity_id = ?')
            p.append(eid)
        if qy.get('user_id'):
            where.append('a.user_id = ?')
            p.append(int(float(qy['user_id'])))
        if qy.get('from'):
            where.append('a.created_at >= ?')
            p.append(qy['from'])
        if qy.get('to'):
            where.append('a.created_at <= ?')
            p.append(f"{qy['to']} 23:59:59")
        try:
            limit = min(int(float(qy.get('limit') or 100)) or 100, 1000)
        except ValueError:
            limit = 100
        return visible_rows(req, all(f'''SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE {' AND '.join(where)}
                       ORDER BY a.id DESC LIMIT ?''', *p, limit))
    r.get('/activity', activity)

    # ---------- comments ----------
    def _eid(v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        # A fractional id would be authorized as one record and stored (rounded by the integer column) as another.
        return int(f) if f.is_integer() else None
    def comments(req):
        et, eid = req.query.get('entity_type'), _eid(req.query.get('entity_id'))
        assert_entity_access(req, et, eid, 'view')
        return all('SELECT * FROM comments WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 500', req.org['id'], et, eid)
    r.get('/comments', comments)

    def add_comment(req):
        b = req.body
        text = (b.get('text') or '').strip() if isinstance(b.get('text'), str) else ''
        if not text:
            raise bad('Comment cannot be empty')
        if len(text) > COMMENT_MAX:
            raise bad(f'Comments can be at most {COMMENT_MAX} characters')
        eid = _eid(b.get('entity_id'))
        if eid is None:
            raise bad('A valid record id is required')
        assert_entity_access(req, b.get('entity_type'), eid, 'view')
        cid = insert('comments', {'org_id': req.org['id'], 'entity_type': b.get('entity_type'), 'entity_id': eid,
                                  'user_id': req.user['id'], 'author': req.user['name'], 'text': text})
        return get('SELECT * FROM comments WHERE id = ?', cid)
    r.post('/comments', add_comment)

    def del_comment(req):
        c = get('SELECT * FROM comments WHERE id = ? AND org_id = ?', _eid(req.params['id']), req.org['id'])
        if c and c['user_id'] is None:
            # customer and system comments have no author account: anyone who can edit the record may remove them
            assert_entity_access(req, c['entity_type'], c['entity_id'], 'edit')
            run('DELETE FROM comments WHERE id = ? AND org_id = ?', c['id'], req.org['id'])
        elif c:
            run('DELETE FROM comments WHERE id = ? AND org_id = ? AND user_id = ?', c['id'], req.org['id'], req.user['id'])
        return {'ok': True}
    r.delete('/comments/:id', del_comment)

    # ---------- outbox ----------
    def emails(req):
        # Each stored email is readable only with the view right of the module that owns the record it was sent for
        # (document emails carry live share links); org/user mail such as invitations falls back to settings:view.
        et = req.query.get('entity_type')
        if et:
            eid = _eid(req.query.get('entity_id'))
            assert_entity_access(req, et, eid, 'view')
            return all('SELECT * FROM emails WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id DESC', req.org['id'], et, eid)
        if not can(req, 'settings', 'view'):
            raise forbidden()
        allowed = {}

        def readable(e):
            key = (e['entity_type'], e['entity_id'])
            if not e['entity_type']:
                return True
            if key not in allowed:
                allowed[key] = can(req, entity_module(req.org['id'], *key), 'view')
            return allowed[key]
        return [e for e in all('SELECT * FROM emails WHERE org_id = ? ORDER BY id DESC LIMIT 200', req.org['id']) if readable(e)]
    r.get('/emails', emails)
