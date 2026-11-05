"""Express-style routing on top of Django, so every module keeps its original route table.

Routes are matched in registration order (method + path, `:param` segments, case-insensitive,
optional trailing slash) exactly like Express 4. A handler may be preceded by middleware callables;
each receives the Req and either returns None (continue) or raises an HttpError.

Pipeline (same as the Node app):
  /api/auth/*   -> auth routes (no login)
  /api/public/* -> public routes (no login)
  /api/*        -> require_user -> require_org -> module routes -> 404
All API requests are processed one at a time (API_LOCK), mirroring Node's single-threaded handling,
so number series, balances and stock never race.
"""
import contextvars
import json
import logging
import math
import os
import re
import secrets
import threading
import time
import traceback
from urllib.parse import unquote

from django.http import HttpResponse
from django.http.response import HttpResponseBase

log = logging.getLogger('openbooks')
API_LOCK = threading.RLock()
# The signed-in user of the request being handled on this thread (None for jobs and public routes). Lets shared
# helpers such as the mailer apply per-user limits without threading req through every caller.
CURRENT_USER_ID = contextvars.ContextVar('openbooks_current_user_id', default=None)
# Password hashing is deliberately slow, so these routes take API_LOCK themselves only around their database writes
# instead of holding it for the whole request (login only reads). They are also rate limited per client address.
SELF_LOCKING = {('POST', '/auth/login'), ('POST', '/auth/signup'), ('PUT', '/auth/me'), ('POST', '/users/invite')}
_AUTH_HITS = {}
_AUTH_MUTEX = threading.Lock()


def _evict(table, now, window):
    """Drop keys whose hits are all older than the window, then the oldest keys, so one flood of addresses cannot
    reset everybody else's limit."""
    for k in [k for k, v in table.items() if not v or now - v[-1] >= window]:
        table.pop(k, None)
    if len(table) > 5000:
        for k in sorted(table, key=lambda k: table[k][-1])[:len(table) - 5000]:
            table.pop(k, None)


def client_ip(req):
    return req.django.META.get('REMOTE_ADDR') or '?'


def _throttle(req):
    """At most OPENBOOKS_AUTH_RATE_LIMIT (default 30) sign-in/sign-up attempts per client address per minute."""
    limit = int(os.environ.get('OPENBOOKS_AUTH_RATE_LIMIT') or 30)
    ip = req.django.META.get('REMOTE_ADDR') or '?'
    now = time.monotonic()
    with _AUTH_MUTEX:
        if len(_AUTH_HITS) > 10000:
            _evict(_AUTH_HITS, now, 60)
        hits = [t for t in _AUTH_HITS.get(ip, ()) if now - t < 60]
        if len(hits) >= limit:
            raise HttpError(429, 'Too many attempts. Wait a minute and try again.')
        hits.append(now)
        _AUTH_HITS[ip] = hits


_LIMIT_HITS = {}


def rate_limit(key, limit, window_sec, message):
    """At most `limit` events per `window_sec` for `key` (an address, org or user), in this process."""
    now = time.monotonic()
    with _AUTH_MUTEX:
        if len(_LIMIT_HITS) > 20000:
            _evict(_LIMIT_HITS, now, window_sec)
        hits = [t for t in _LIMIT_HITS.get(key, ()) if now - t < window_sec]
        if len(hits) >= limit:
            raise HttpError(429, message)
        hits.append(now)
        _LIMIT_HITS[key] = hits


class HttpError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


def bad(msg, details=None):
    return HttpError(400, msg, details)


def not_found(what='Record'):
    return HttpError(404, f'{what} not found')


def forbidden(msg='You do not have permission to do this'):
    return HttpError(403, msg)


class Query(dict):
    """req.query: missing keys read as None (like `req.query.x` being undefined)."""

    def __getattr__(self, k):
        return self.get(k)


def _finite_float(s):
    f = float(s)
    if not math.isfinite(f):  # e.g. 1e999: amounts must stay finite all the way to the ledger
        raise ValueError(f'number {s} is out of range')
    return f


def _no_constant(name):
    raise ValueError(f'{name} is not a valid number')


class Req:
    def __init__(self, request, path):
        self.django = request
        self.method = request.method.upper()
        self.path = path
        self.headers = request.headers
        self.query = Query({k: request.GET.getlist(k)[-1] for k in request.GET.keys()})
        self.params = {}
        self.user = None
        self.org = None
        self.perms = {}
        self.role = None
        self._body = None
        self._parsed = False

    @property
    def body(self):
        if not self._parsed:
            self._parsed = True
            ctype = (self.headers.get('content-type') or '').lower()
            raw = self.django.body
            if 'json' in ctype and raw:
                try:
                    v = json.loads(raw.decode('utf-8'), parse_float=_finite_float, parse_constant=_no_constant)
                except (ValueError, UnicodeDecodeError) as e:
                    raise HttpError(400, f'Invalid JSON body: {e}') from e
                if not isinstance(v, (dict, list)):
                    raise HttpError(400, 'JSON body must be an object or array')
                self._body = v
            else:
                self._body = {}
        return self._body

    @body.setter
    def body(self, v):
        self._parsed = True
        self._body = v


def _compile(path):
    parts = []
    names = []
    for seg in re.split(r'(:\w+)', path):
        if seg.startswith(':'):
            names.append(seg[1:])
            parts.append(r'([^/]+?)')
        else:
            parts.append(re.escape(seg))
    # ASCII-only case folding and \Z: the lock/throttle exemption (SELF_LOCKING) compares the lower-cased path exactly,
    # so the route matcher must not accept extra spellings such as a dotless i, a long s or a trailing newline.
    return re.compile('^' + ''.join(parts) + r'/?\Z', re.IGNORECASE | re.ASCII), names


class Router:
    def __init__(self):
        self.routes = []

    def add(self, method, path, *fns):
        rx, names = _compile(path)
        self.routes.append((method, rx, names, fns[:-1], fns[-1]))

    def get(self, path, *fns): self.add('GET', path, *fns)  # noqa: E704
    def post(self, path, *fns): self.add('POST', path, *fns)  # noqa: E704
    def put(self, path, *fns): self.add('PUT', path, *fns)  # noqa: E704
    def delete(self, path, *fns): self.add('DELETE', path, *fns)  # noqa: E704
    def patch(self, path, *fns): self.add('PATCH', path, *fns)  # noqa: E704

    def handle(self, req, path):
        """Return (True, result) for the first matching route, else (False, None)."""
        method = 'GET' if req.method == 'HEAD' else req.method
        for m, rx, names, mws, fn in self.routes:
            if m != method:
                continue
            mt = rx.match(path)
            if not mt:
                continue
            req.params = {n: unquote(v) for n, v in zip(names, mt.groups())}
            for mw in mws:
                mw(req)
            return True, fn(req)
        return False, None


auth_router = Router()
public_router = Router()
api_router = Router()
internal_router = Router()


def _clean(v):
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def json_response(data, status=200):
    body = json.dumps(_clean(data), ensure_ascii=False, separators=(',', ':'))
    return HttpResponse(body.encode('utf-8'), status=status, content_type='application/json; charset=utf-8')


def _route(req):
    from books.core.auth import require_user, require_org  # noqa: PLC0415
    path = req.path
    if path.startswith('/_internal/') and os.environ.get('OPENBOOKS_TESTING') == '1':
        ok, res = internal_router.handle(req, path[len('/_internal'):])
        if ok:
            return res
    if path.lower().startswith('/auth/') or path.lower() == '/auth':
        ok, res = auth_router.handle(req, path[5:] or '/')
        if ok:
            return res
    if path.lower().startswith('/public/') or path.lower() == '/public':
        ok, res = public_router.handle(req, path[7:] or '/')
        if ok:
            return res
    require_user(req)
    require_org(req)
    ok, res = api_router.handle(req, path)
    if ok:
        return res
    raise HttpError(404, 'Not found')


def dispatch(request, path):
    from books.core.loader import ensure_loaded  # noqa: PLC0415
    ensure_loaded()
    req = Req(request, path)
    CURRENT_USER_ID.set(None)  # waitress reuses threads; require_user sets it for this request
    try:
        if (req.method, path.lower().rstrip('/')) in SELF_LOCKING:
            _throttle(req)
            res = _route(req)
        else:
            with API_LOCK:
                res = _route(req)
        if isinstance(res, HttpResponseBase):
            return res
        return json_response(res)
    except HttpError as e:
        payload = {'error': e.message or 'Server error'}
        if e.details is not None:
            payload['details'] = e.details
        return json_response(payload, e.status)
    except Exception:  # noqa: BLE001
        ref = secrets.token_hex(4)
        log.error('Unhandled error %s on %s %r\n%s', ref, req.method, path, traceback.format_exc())
        # the exception text can carry SQL, table or file details, so the client only gets a reference to the log
        return json_response({'error': f'Something went wrong (reference {ref})'}, 500)
