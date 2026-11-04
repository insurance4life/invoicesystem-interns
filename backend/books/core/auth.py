"""Passwords, signed tokens, membership and permissions (port of auth.js; tokens/hashes are compatible)."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from django.conf import settings

from books.core.db import get
from books.core.router import HttpError, forbidden, CURRENT_USER_ID


def _secret():
    if os.environ.get('JWT_SECRET'):
        return os.environ['JWT_SECRET']
    f = settings.DATA_DIR / '.secret'
    if f.exists():
        return f.read_text()
    s = secrets.token_hex(32)
    f.write_text(s)
    return s


SECRET = _secret()


def _b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def _unb64(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def _scrypt(pw, salt):
    return hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)


def hash_password(pw):
    salt = secrets.token_hex(16)
    return f'{salt}:{_scrypt(pw, salt).hex()}'


def verify_password(pw, stored):
    salt, _, h = str(stored or '').partition(':')
    if not salt or not h:
        return False
    return hmac.compare_digest(_scrypt(pw, salt).hex(), h)


def credential_version(password_hash):
    """Short fingerprint of the stored password hash. Tokens carry it, so changing the password ends older sessions."""
    return hashlib.sha256(str(password_hash or '').encode()).hexdigest()[:16]


def user_token(user_id, password_hash):
    return sign_token({'uid': user_id, 'pv': credential_version(password_hash)})


def _sig(body):
    return _b64(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest())


def sign_token(payload, ttl_sec=60 * 60 * 24 * 14):
    body = _b64(json.dumps({**payload, 'exp': int(time.time()) + ttl_sec}, separators=(',', ':')).encode())
    return f'{body}.{_sig(body)}'


def verify_token(tok):
    body, _, sig = str(tok or '').partition('.')
    if not body or not sig:
        return None
    if not hmac.compare_digest(sig, _sig(body)):
        return None
    try:
        p = json.loads(_unb64(body))
    except ValueError:
        return None
    if p.get('exp') and p['exp'] < time.time():
        return None
    return p


MODULES = ['contacts', 'items', 'sales', 'purchases', 'banking', 'accountant', 'reports', 'projects', 'documents', 'settings']
ACTIONS = ['view', 'create', 'edit', 'delete', 'approve']


def require_user(req):
    auth = req.headers.get('authorization') or ''
    p = verify_token(auth[7:] if auth.startswith('Bearer ') else req.query.get('token'))
    if not p:
        raise HttpError(401, 'Please sign in')
    user = get('SELECT id, name, email, default_org_id, theme, password_hash FROM users WHERE id = ?', p.get('uid'))
    if not user or not hmac.compare_digest(str(p.get('pv') or ''), credential_version(user.pop('password_hash'))):
        raise HttpError(401, 'Please sign in')
    req.user = user
    CURRENT_USER_ID.set(user['id'])


def require_org(req):
    raw = req.headers.get('x-org-id') or req.query.get('org_id')
    try:
        org_id = int(raw) if raw not in (None, '') else 0
    except ValueError:
        org_id = 0
    if not org_id:
        raise HttpError(400, 'Missing organization (X-Org-Id header)')
    m = get('''SELECT ou.status, r.name AS role_name, r.permissions FROM org_users ou
               LEFT JOIN roles r ON r.id = ou.role_id WHERE ou.org_id = ? AND ou.user_id = ?''', org_id, req.user['id'])
    if not m or m['status'] != 'active':  # 'inactive', or 'invited' until the invitee accepts
        raise forbidden('You are not a member of this organization')
    req.org = get('SELECT * FROM orgs WHERE id = ?', org_id)
    req.role = m['role_name']
    try:
        req.perms = json.loads(m['permissions'] or '{}')
    except ValueError:
        req.perms = {}


def can(req, module, action):
    p = req.perms or {}
    lst = p.get('*') or p.get(module) or []
    return action in lst or '*' in lst


def perm(module, action):
    """Middleware factory: perm('sales', 'create')."""
    def mw(req):
        if not can(req, module, action):
            raise forbidden()
    return mw


ADMIN_PERMS = {'*': ['view', 'create', 'edit', 'delete', 'approve']}
STAFF_PERMS = {m: ['view', 'create', 'edit', 'delete'] for m in MODULES if m not in ('settings', 'accountant', 'reports')}
STAFF_LIMITED_PERMS = {m: ['view', 'create', 'edit'] for m in ['contacts', 'items', 'sales', 'purchases', 'projects', 'documents']}
TIMESHEET_PERMS = {'projects': ['view', 'create', 'edit']}
ACCOUNTANT_PERMS = {m: ['view', 'create', 'edit', 'delete', 'approve'] for m in ['contacts', 'items', 'sales', 'purchases', 'banking', 'accountant', 'reports', 'documents']}
