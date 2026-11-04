"""Django entry points: the JSON API dispatcher and the single-page app."""
import mimetypes

from django.http import FileResponse, HttpResponse, HttpResponseNotFound
from django.conf import settings

from books.core.router import dispatch


def api_view(request, path=None):
    return dispatch(request, path or '/')


def _dist_file(dist, rel):
    """The built asset for a request path, or None. The path is validated before any filesystem call, so a
    backslash, drive or UNC prefix (meaningful on Windows) or '..' can never make the server touch another path."""
    if not rel or '\\' in rel or ':' in rel or '\x00' in rel:
        return None
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        return None
    f = dist.joinpath(*parts)
    try:
        real = f.resolve()
        return real if real.is_file() and dist.resolve() in real.parents else None
    except (OSError, ValueError):
        return None


def spa_view(request):
    dist = settings.CLIENT_DIST
    if not dist.exists():
        return HttpResponseNotFound('Client not built. Run `npm run build`, or use the Vite dev server on :5173.')
    f = _dist_file(dist, request.path.lstrip('/'))
    if f:
        ctype = mimetypes.guess_type(str(f))[0] or 'application/octet-stream'
        return FileResponse(open(f, 'rb'), content_type=ctype)
    return HttpResponse((dist / 'index.html').read_bytes(), content_type='text/html; charset=utf-8')
