"""/api/auth/* — signup, login, profile, org creation, account deletion (port of app.js auth router)."""
import os

from books.core.db import get, all, insert, update, run
from books.core.router import HttpError, bad, API_LOCK, _throttle
from books.core.auth import hash_password, verify_password, user_token, require_user
from books.core.orgs import create_org, check_sizes as check_org_sizes


def _signup(req):
    b = req.body
    name, email, password, organization = b.get('name'), b.get('email'), b.get('password'), b.get('organization') or {}
    if not name or not email or not password:
        raise bad('Name, email and password are required')
    if len(str(password)) < 6:
        raise bad('Password must be at least 6 characters')
    if not isinstance(organization, dict) or not isinstance(name, str) or not isinstance(email, str):
        raise bad('Invalid sign-up details')
    check_org_sizes(organization)  # before the user row is written
    password_hash = hash_password(password)  # outside API_LOCK (see router.SELF_LOCKING)
    with API_LOCK:
        if get('SELECT id FROM users WHERE lower(email) = lower(?)', email):
            raise bad('An account with this email already exists')
        uid = insert('users', {'name': name, 'email': email, 'password_hash': password_hash})
        org_id = create_org(uid, {'name': organization.get('name') or f"{name}'s Organization", **organization})
        update('users', uid, {'default_org_id': org_id})
    return {'token': user_token(uid, password_hash), 'user': get('SELECT id, name, email, default_org_id FROM users WHERE id = ?', uid), 'org_id': org_id}


def _login(req):
    email, password = req.body.get('email'), req.body.get('password')
    u = get('SELECT * FROM users WHERE lower(email) = lower(?)', email or '')
    if not u or not verify_password(password or '', u['password_hash']):
        raise HttpError(401, 'Invalid email or password')
    return {'token': user_token(u['id'], u['password_hash']), 'user': {'id': u['id'], 'name': u['name'], 'email': u['email'], 'default_org_id': u['default_org_id']}}


def _me(req):
    rows = all('''SELECT o.id, o.name, o.currency, o.country, r.name AS role, ou.status FROM org_users ou JOIN orgs o ON o.id = ou.org_id
                  LEFT JOIN roles r ON r.id = ou.role_id WHERE ou.user_id = ? AND ou.status IN ('active', 'invited') ORDER BY o.name''', req.user['id'])
    return {
        'user': req.user,
        'orgs': [o for o in rows if o['status'] == 'active'],
        'invites': [o for o in rows if o['status'] == 'invited'],
    }


def _invite_answer(req, accept):
    """An invitation to an existing account only takes effect when that account accepts it: the address was never
    verified, so whoever registered it first must not receive the org's data just because an Admin typed it."""
    try:
        org_id = int(req.params['org_id'])
    except ValueError:
        raise bad('Invalid organization') from None
    m = get("SELECT id FROM org_users WHERE org_id = ? AND user_id = ? AND status = 'invited'", org_id, req.user['id'])
    if not m:
        raise HttpError(404, 'Invitation not found')
    if accept:
        update('org_users', m['id'], {'status': 'active'})
    else:
        run('DELETE FROM org_users WHERE id = ?', m['id'])
    return _me(req)


def _update_me(req):
    """Self-locking (router.SELF_LOCKING): password checks and hashing run outside API_LOCK; only the writes take it."""
    b = req.body
    patch = {}
    if b.get('name'):
        patch['name'] = b['name']
    if b.get('theme'):
        patch['theme'] = b['theme']
    if b.get('default_org_id'):
        patch['default_org_id'] = b['default_org_id']
    changing_email = b.get('email') and b['email'] != req.user['email']
    if changing_email or b.get('new_password'):
        u = get('SELECT password_hash FROM users WHERE id = ?', req.user['id'])
        if not verify_password(b.get('current_password') or '', u['password_hash']):
            # Invites bind membership to an email address, so moving an account to a new address needs the password.
            raise bad('Enter your current password to change your email' if changing_email else 'Current password is incorrect')
    if b.get('new_password'):
        if len(str(b['new_password'])) < 6:
            raise bad('Password must be at least 6 characters')
        patch['password_hash'] = hash_password(b['new_password'])
    with API_LOCK:
        if changing_email:
            if get('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?', b['email'], req.user['id']):
                raise bad('Email already in use')
            patch['email'] = b['email']
        update('users', req.user['id'], patch)
        out = {'user': get('SELECT id, name, email, default_org_id, theme FROM users WHERE id = ?', req.user['id'])}
    if 'password_hash' in patch:
        out['token'] = user_token(req.user['id'], patch['password_hash'])  # older tokens stop working; this one replaces them
    return out


def _create_org(req):
    if not isinstance(req.body, dict) or not req.body.get('name'):
        raise bad('Organization name is required')
    _throttle(req)
    # Every per-organization quota (email, storage, imports) starts fresh in a new org, so the number of orgs one
    # account can own is capped.
    cap = int(os.environ.get('OPENBOOKS_MAX_ORGS_PER_USER') or 10)
    owned = get("""SELECT COUNT(*) AS n FROM org_users ou JOIN roles r ON r.id = ou.role_id
                   WHERE ou.user_id = ? AND r.name = 'Admin' AND ou.status = 'active'""", req.user['id'])['n']
    if owned >= cap:
        raise bad(f'You can own at most {cap} organizations')
    oid = create_org(req.user['id'], req.body)
    return get('SELECT * FROM orgs WHERE id = ?', oid)


def _delete_me(req):
    # Only an org where the caller is an active Admin counts as owned; a deactivated Admin just loses the membership.
    owned = all("""SELECT ou.org_id FROM org_users ou JOIN roles r ON r.id = ou.role_id
                   WHERE ou.user_id = ? AND r.name = 'Admin' AND ou.status = 'active'""", req.user['id'])
    for o in owned:
        admins = get("SELECT COUNT(*) n FROM org_users ou JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? AND r.name = 'Admin' AND ou.status = 'active'", o['org_id'])['n']
        if admins <= 1:
            run('DELETE FROM orgs WHERE id = ?', o['org_id'])
    run('DELETE FROM users WHERE id = ?', req.user['id'])
    return {'ok': True}


def routes(r):
    r.post('/signup', _signup)
    r.post('/login', _login)
    r.get('/me', require_user, _me)
    r.put('/me', require_user, _update_me)
    r.post('/orgs', require_user, _create_org)
    r.post('/invites/:org_id/accept', require_user, lambda req: _invite_answer(req, True))
    r.delete('/invites/:org_id', require_user, lambda req: _invite_answer(req, False))
    r.delete('/me', require_user, _delete_me)


def internal_routes(r):
    """Only mounted when OPENBOOKS_TESTING=1 (used by the API test-suite)."""
    def run_jobs(req):
        from books.core.jobs import run_jobs as _run  # noqa: PLC0415
        _run()  # API_LOCK is re-entrant
        return {'ok': True}
    r.post('/run-jobs', run_jobs)
