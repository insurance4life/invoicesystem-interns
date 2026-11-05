"""Chart of accounts + manual journals (draft/published, recurring, auto-reversing) (port of modules/accounts.js)."""
import json

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found, forbidden, HttpError
from books.core.util import audit, round2, today, next_number, assert_unlocked, assert_owned, clean_body, cap_list, like_pattern
from books.core.auth import perm, can
from books.core.jsutil import jsnum, jsstr, to_int, truthy
from books.core.ledger import post, unpost, account_class, account_in_use
from books.core.documents import advance_date, validate_recurrence, RECURRING_RUN_LIMIT
from books.core.calc import ACCOUNT_CLASS, sum_js

BANK_TYPES = ('bank', 'credit_card', 'cash', 'payment_clearing')  # same list as modules/banking.py
ACC_FIELDS = ['code', 'name', 'type', 'parent_id', 'description', 'is_active', 'currency', 'watchlist', 'bank_name', 'account_number', 'ifsc']


def _j(v):
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


def _with_balance(a):
    cls = account_class(a['type'])
    return {**a, 'class': cls, 'balance': round2(a['debit'] - a['credit']) if cls in ('asset', 'expense') else round2(a['credit'] - a['debit'])}


def account_with_balance(org_id, id):  # noqa: A002
    a = get('''SELECT a.*, p.name AS parent_name, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
               FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id AND p.org_id = a.org_id LEFT JOIN ledger l ON l.account_id = a.id AND l.org_id = a.org_id
               WHERE a.id = ? AND a.org_id = ? GROUP BY a.id, p.name''', id, org_id)
    if not a:
        raise not_found('Account')
    return _with_balance(a)


# ---------------- journals ----------------
def load_journal(org_id, id):  # noqa: A002
    j = parse_json(get('SELECT * FROM journals WHERE id = ? AND org_id = ?', id, org_id), ['recurrence'])
    if not j:
        raise not_found('Journal')
    j['lines'] = all('''SELECT jl.*, a.name AS account_name, a.code AS account_code, c.display_name AS contact_name FROM journal_lines jl
                        JOIN accounts a ON a.id = jl.account_id AND a.org_id = ? LEFT JOIN contacts c ON c.id = jl.contact_id AND c.org_id = ?
                        WHERE jl.journal_id = ? ORDER BY jl.id''', org_id, org_id, id)
    return j


def _post_journal(org, j):
    if j['status'] != 'published' or j.get('is_profile') or j.get('journal_type') == 'template':
        return unpost(org['id'], 'journal', j['id'])
    fx = jsnum(j.get('exchange_rate')) or 1
    post(org['id'], 'journal', j['id'], date=j['date'], number=j['number'], lines=[{
        'account_id': l['account_id'], 'contact_id': l['contact_id'], 'description': l['description'] or j.get('notes'),
        'debit': round2(l['debit'] * fx), 'credit': round2(l['credit'] * fx),
    } for l in j['lines']])


def save_journal(req, body, id=None):  # noqa: A002
    org = req.org
    body = body or {}

    def _do():
        existing = load_journal(org['id'], id) if id else None
        date = body.get('date') or (existing or {}).get('date') or today()
        is_profile = body['is_profile'] if body.get('is_profile') is not None else ((existing or {}).get('is_profile') or 0)
        jtype = body.get('journal_type') or (existing or {}).get('journal_type') or 'manual'
        # The lock exemption for profiles and templates follows what is stored, not what the request claims: turning a
        # posted journal into a template unposts it, so its stored date must be unlocked too.
        if existing and not existing.get('is_profile') and existing.get('journal_type') != 'template':
            assert_unlocked(org, existing['date'], 'journal')
        if not truthy(is_profile) and jtype != 'template':
            assert_unlocked(org, date, 'journal')
        lines = [l for l in (cap_list(body.get('lines'), 'journal lines') or []) if truthy(l.get('account_id')) and (jsnum(l.get('debit')) or jsnum(l.get('credit')))]
        if len(lines) < 2:
            raise bad('A journal needs at least two lines')
        for l in lines:
            if jsnum(l.get('debit')) and jsnum(l.get('credit')):
                raise bad('A line cannot have both a debit and a credit')
            if not get('SELECT id FROM accounts WHERE id = ? AND org_id = ?', l['account_id'], org['id']):
                raise bad('Invalid account')
        assert_owned(org['id'], 'contacts', [l.get('contact_id') for l in lines], 'contact')
        td = round2(sum_js(jsnum(l.get('debit')) for l in lines))
        tc = round2(sum_js(jsnum(l.get('credit')) for l in lines))
        if abs(td - tc) > 0.001:
            raise bad(f'Debits ({jsstr(td)}) and credits ({jsstr(tc)}) must be equal')
        f = {
            'date': date, 'reference': body.get('reference'), 'notes': body.get('notes'),
            'status': body.get('status') or (existing or {}).get('status') or 'published',
            'journal_type': jtype, 'currency': body.get('currency') or org.get('currency'), 'exchange_rate': jsnum(body.get('exchange_rate')) or 1,
            'reverse_date': body.get('reverse_date') or None, 'total': td, 'is_profile': 1 if truthy(is_profile) else 0,
            'recurrence': _j(validate_recurrence({'frequency': 'monthly', 'every': 1, 'start_date': date, 'next_date': date, 'status': 'active',
                              **((existing or {}).get('recurrence') or {}), **(body.get('recurrence') or {})})) if truthy(is_profile) else None,
        }
        jid = id
        if existing:
            update('journals', id, f)
            run('DELETE FROM journal_lines WHERE journal_id = ?', id)
        else:
            jid = insert('journals', {**f, 'org_id': org['id'], 'number': body.get('number') or next_number(org['id'], 'journal'),
                                      'created_by': (req.user or {}).get('id')})
        for l in lines:
            insert('journal_lines', {'journal_id': jid, 'account_id': l['account_id'], 'contact_id': l.get('contact_id') or None,
                                     'description': l.get('description') or None, 'debit': round2(l.get('debit') or 0), 'credit': round2(l.get('credit') or 0)})
        j = load_journal(org['id'], jid)
        _post_journal(org, j)
        return j
    return tx(_do)


def _create_reversal(req, j):
    if not j.get('reverse_date') or j['status'] != 'published' or j.get('is_profile'):
        return None
    exists = get('SELECT id FROM journals WHERE reversed_journal_id = ? AND org_id = ?', j['id'], req.org['id'])
    if exists:
        return exists['id']
    rev = save_journal(req, {
        'date': j['reverse_date'], 'reference': f"Reversal of {j['number']}", 'notes': f"Auto-reversal of {j['number']}", 'journal_type': 'reversal',
        'lines': [{'account_id': l['account_id'], 'contact_id': l['contact_id'], 'description': l['description'], 'debit': l['credit'], 'credit': l['debit']} for l in j['lines']],
    })
    update('journals', rev['id'], {'reversed_journal_id': j['id']})
    return rev['id']


def run_recurring_journals(org, req):
    now = today()
    n = 0
    for p in all('SELECT id FROM journals WHERE org_id = ? AND is_profile = 1 ORDER BY id', org['id']):
        prof = load_journal(org['id'], p['id'])
        r = prof.get('recurrence') or {}
        guard = 0
        try:
            while (r.get('status') == 'active' and r.get('next_date') and r['next_date'] <= now and guard < 120
                   and n < RECURRING_RUN_LIMIT):
                guard += 1
                if r.get('end_date') and r['next_date'] > r['end_date']:
                    r['status'] = 'expired'
                    break
                j = save_journal(req, {'date': r['next_date'], 'reference': prof['reference'], 'notes': prof['notes'], 'is_profile': 0, 'status': 'published', 'lines': prof['lines']})
                update('journals', j['id'], {'profile_id': prof['id']})
                n += 1
                r = {**r, 'next_date': advance_date(r['next_date'], r.get('frequency'), r.get('every')), 'last_run': now}
        except HttpError as e:  # e.g. a locked period: record it on this profile and carry on with the others
            r = {**r, 'last_error': e.message, 'last_error_at': now}
        update('journals', p['id'], {'recurrence': _j(r)})
        if n >= RECURRING_RUN_LIMIT:
            break
    return n


def routes(r):
    def list_accounts(req):
        rows = all('''SELECT a.*, p.name AS parent_name, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
                      FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id AND p.org_id = a.org_id LEFT JOIN ledger l ON l.account_id = a.id AND l.org_id = a.org_id
                      WHERE a.org_id = ? GROUP BY a.id, p.name ORDER BY a.type, a.code, a.name, a.id''', req.org['id'])
        return [_with_balance(a) for a in rows]
    r.get('/accounts', perm('accountant', 'view'), list_accounts)

    def get_account(req):
        a = account_with_balance(req.org['id'], to_int(req.params['id']))
        a['transactions'] = all('''SELECT l.*, c.display_name AS contact_name FROM ledger l LEFT JOIN contacts c ON c.id = l.contact_id AND c.org_id = l.org_id
                                   WHERE l.account_id = ? AND l.org_id = ? ORDER BY l.date DESC, l.id DESC LIMIT 500''', a['id'], req.org['id'])
        return a
    r.get('/accounts/:id', perm('accountant', 'view'), get_account)

    def create_account(req):
        o = clean_body(req.body, ACC_FIELDS)
        if not o.get('name'):
            raise bad('Account name is required')
        if not ACCOUNT_CLASS.get(o.get('type')):
            raise bad('Invalid account type')
        if o['type'] in BANK_TYPES and not can(req, 'banking', 'create'):
            raise forbidden('Bank and card accounts are managed from Banking')
        if get('SELECT id FROM accounts WHERE org_id = ? AND lower(name) = lower(?)', req.org['id'], o['name']):
            raise bad('An account with this name already exists')
        if o.get('code') and get('SELECT id FROM accounts WHERE org_id = ? AND code = ?', req.org['id'], o['code']):
            raise bad('Account code already used')
        assert_owned(req.org['id'], 'accounts', [o.get('parent_id')], 'parent account')
        aid = insert('accounts', {**o, 'org_id': req.org['id']})
        audit(req, 'account', aid, 'created', o['name'])
        return account_with_balance(req.org['id'], aid)
    r.post('/accounts', perm('accountant', 'create'), create_account)

    def edit_account(req):
        a = account_with_balance(req.org['id'], to_int(req.params['id']))
        o = clean_body(req.body, ACC_FIELDS)
        if a.get('is_system'):
            o.pop('type', None)
            if a.get('system_code') in ('ar', 'ap', 'undeposited_funds', 'retained_earnings', 'opening_balance_offset'):
                o.pop('is_active', None)
        if o.get('type') and o['type'] != a['type'] and account_class(o['type']) != account_class(a['type']) and (a['debit'] or a['credit']):
            raise bad('Account class cannot change once transactions exist')
        if o.get('type') and not ACCOUNT_CLASS.get(o['type']):
            raise bad('Invalid account type')
        if o.get('type') and (o['type'] in BANK_TYPES) != (a['type'] in BANK_TYPES) and not (
                can(req, 'banking', 'edit') and (o['type'] in BANK_TYPES or can(req, 'banking', 'delete'))):
            raise forbidden('Bank and card accounts are managed from Banking')
        if o.get('parent_id') and to_int(o['parent_id']) == a['id']:
            raise bad('An account cannot be its own parent')
        assert_owned(req.org['id'], 'accounts', [o.get('parent_id')], 'parent account')
        update('accounts', a['id'], o)
        audit(req, 'account', a['id'], 'updated')
        return account_with_balance(req.org['id'], a['id'])
    r.put('/accounts/:id', perm('accountant', 'edit'), edit_account)

    def delete_account(req):
        a = account_with_balance(req.org['id'], to_int(req.params['id']))
        if a.get('is_system'):
            raise bad('System accounts cannot be deleted')
        if a['type'] in BANK_TYPES and not can(req, 'banking', 'delete'):
            raise forbidden('Bank and card accounts are deleted from Banking')
        used = account_in_use(req.org['id'], a['id'])
        asset_use = 0
        for b in all('SELECT lines FROM budgets WHERE org_id = ?', req.org['id']):
            try:
                if str(a['id']) in (json.loads(b['lines'] or '{}') or {}):
                    asset_use += 1
            except ValueError:
                pass
        if used or asset_use:
            raise bad('This account is in use. Mark it inactive instead.')
        run('DELETE FROM accounts WHERE id = ?', a['id'])
        audit(req, 'account', a['id'], 'deleted', a['name'])
        return {'ok': True}
    r.delete('/accounts/:id', perm('accountant', 'delete'), delete_account)

    # journals
    def list_journals(req):
        q = req.query
        where = ['j.org_id = ?', f"j.is_profile = {1 if q.get('profiles') else 0}"]
        p = [req.org['id']]
        if q.get('from'):
            where.append('j.date >= ?')
            p.append(q['from'])
        if q.get('to'):
            where.append('j.date <= ?')
            p.append(q['to'])
        if q.get('status'):
            where.append('j.status = ?')
            p.append(q['status'])
        if q.get('type'):
            where.append('j.journal_type = ?')
            p.append(q['type'])
        elif not q.get('profiles'):
            where.append("j.journal_type != 'template'")
        pat = like_pattern(q.get('q'))
        if pat:
            where.append('(j.number ILIKE ? OR j.reference ILIKE ? OR j.notes ILIKE ?)')
            p += [pat] * 3
        return [parse_json(j, ['recurrence']) for j in all(f"SELECT j.* FROM journals j WHERE {' AND '.join(where)} ORDER BY j.date DESC, j.id DESC", *p)]
    r.get('/journals', perm('accountant', 'view'), list_journals)

    def get_journal(req):
        j = load_journal(req.org['id'], to_int(req.params['id']))
        j['reversal'] = get('SELECT id, number, date FROM journals WHERE reversed_journal_id = ? ORDER BY id LIMIT 1', j['id'])
        j['children'] = all('SELECT id, number, date, total FROM journals WHERE profile_id = ? ORDER BY date DESC, id DESC', j['id'])
        return j
    r.get('/journals/:id', perm('accountant', 'view'), get_journal)

    def create_journal(req):
        j = save_journal(req, req.body)
        _create_reversal(req, j)
        audit(req, 'journal', j['id'], 'created', j['number'])
        return load_journal(req.org['id'], j['id'])
    r.post('/journals', perm('accountant', 'create'), create_journal)

    def edit_journal(req):
        j = save_journal(req, req.body, to_int(req.params['id']))
        _create_reversal(req, j)
        audit(req, 'journal', j['id'], 'updated', j['number'])
        return load_journal(req.org['id'], j['id'])
    r.put('/journals/:id', perm('accountant', 'edit'), edit_journal)

    def publish(req):
        j = load_journal(req.org['id'], to_int(req.params['id']))
        res = save_journal(req, {**j, 'status': 'published'}, j['id'])
        _create_reversal(req, res)
        audit(req, 'journal', j['id'], 'published')
        return res
    r.post('/journals/:id/publish', perm('accountant', 'edit'), publish)

    def recurrence_action(req):
        j = load_journal(req.org['id'], to_int(req.params['id']))
        status = {'pause': 'paused', 'resume': 'active', 'stop': 'stopped'}.get(req.params['action'])
        if not j.get('is_profile') or not status:
            raise bad('Invalid action')
        update('journals', j['id'], {'recurrence': _j({**(j.get('recurrence') or {}), 'status': status})})
        return load_journal(req.org['id'], j['id'])
    r.post('/journals/:id/recurrence/:action', perm('accountant', 'edit'), recurrence_action)

    def delete_journal(req):
        def _do():
            j = load_journal(req.org['id'], to_int(req.params['id']))
            if not j.get('is_profile') and j.get('journal_type') != 'template':
                assert_unlocked(req.org, j['date'], 'journal')
            unpost(req.org['id'], 'journal', j['id'])
            run('UPDATE journals SET reversed_journal_id = NULL WHERE reversed_journal_id = ?', j['id'])
            run('DELETE FROM journals WHERE id = ?', j['id'])
            audit(req, 'journal', j['id'], 'deleted', j['number'])
            return {'ok': True}
        return tx(_do)
    r.delete('/journals/:id', perm('accountant', 'delete'), delete_journal)


def job(org, sys_req):
    run_recurring_journals(org, sys_req)
