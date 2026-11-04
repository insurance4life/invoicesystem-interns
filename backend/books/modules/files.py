"""Documents library and attachments, stored on disk under DATA_DIR/uploads/<org_id>/ and indexed in the core `files` table
(port of modules/files.js)."""
import base64
import os
import re
import urllib.parse

from django.conf import settings
from django.http import HttpResponse

from books.core.db import all, get, run, insert, update
from books.core.router import bad, not_found, forbidden
from books.core.util import audit
from books.core.auth import can
from books.core.entities import assert_entity_access
from books.core.jsutil import jsstr, num_or_none, to_int, truthy

MAX_BYTES = 10 * 1024 * 1024
FOLDERS = ['inbox', 'receipts', 'bills', 'contracts', 'others']
ENTITY_RE = re.compile(r'[a-z_]{2,40}')
# entity types that live in the documents table, expenses and contacts (used to make sure an attachment target exists)
DOC_ENTITIES = ['invoice', 'quote', 'salesorder', 'retainer', 'creditnote', 'deliverychallan', 'salesreceipt', 'recurring_invoice',
                'bill', 'purchaseorder', 'vendorcredit', 'recurring_bill']
CONTACT_ENTITIES = ['contact', 'customer', 'vendor']
PREVIEWABLE = re.compile(r'image/(png|jpe?g|gif|webp)|application/pdf')
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;[^,]*)?;base64,')
DATA_PREFIX_RE = re.compile(r'^data:[^,]*,')
LIST_COLS = 'id, name, mime, size, folder, entity_type, entity_id, uploaded_by, created_at'
# characters Node's base64 decoder accepts (both alphabets)
_B64_JUNK = re.compile(r'[^A-Za-z0-9+/\-_]')
# base64 text longer than this cannot decode to MAX_BYTES, so it is refused before any decoding work
MAX_B64_CHARS = MAX_BYTES * 4 // 3 + 64 * 1024
# JavaScript String.prototype.trim() whitespace and line terminators
JS_WS = '\t\n\x0b\x0c\r \xa0                　﻿'


def _jstr(v):
    """String(v) for JSON values (callers only pass values that are truthy or present)."""
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


def _body(req):
    b = req.body
    return b if isinstance(b, dict) else {}


def _b64decode_js(s):
    """Buffer.from(s, 'base64'): skips characters outside the alphabet, stops at '=', ignores a dangling single character."""
    text = _B64_JUNK.sub('', s.split('=', 1)[0]).replace('-', '+').replace('_', '/')
    if len(text) % 4 == 1:
        text = text[:-1]
    text += '=' * (-len(text) % 4)
    return base64.b64decode(text)


def _safe_name(n):
    s = _jstr(n) if truthy(n) else 'file'
    s = re.sub(r'[^A-Za-z0-9_.\- ]+', '_', s)
    s = re.sub(r'\s+', ' ', s)
    s = _js_trim(s)[:120]
    return s or 'file'


def _abs(rel):
    return settings.DATA_DIR.joinpath(*rel.split('/'))


def _entity_exists(org_id, typ, id_):
    if typ in DOC_ENTITIES:
        return bool(get('SELECT id FROM documents WHERE id = ? AND org_id = ?', id_, org_id))
    if typ == 'expense':
        return bool(get('SELECT id FROM expenses WHERE id = ? AND org_id = ?', id_, org_id))
    if typ in CONTACT_ENTITIES:
        return bool(get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', id_, org_id))
    if typ == 'project':
        return bool(get('SELECT id FROM projects WHERE id = ? AND org_id = ?', id_, org_id))
    return True


def _authorize(req, f, action):
    """Library files (no entity) need documents permissions; an attachment needs the right on the record it belongs to
    (view to read it, edit to rename, detach or delete it)."""
    if truthy(f.get('entity_type')):
        assert_entity_access(req, f['entity_type'], f.get('entity_id'), 'view' if action == 'view' else 'edit')
        return
    if not can(req, 'documents', action):
        raise forbidden()


def _load_file(org_id, id_):
    f = get('SELECT * FROM files WHERE id = ? AND org_id = ?', id_, org_id)
    if not f:
        raise not_found('File')
    return f


def _file_row(id_):
    return get(f'SELECT {LIST_COLS} FROM files WHERE id = ?', id_)


def _list_files(req):
    q = req.query
    if truthy(q.get('entity_type')):
        assert_entity_access(req, _jstr(q.get('entity_type')), num_or_none(q.get('entity_id')), 'view')
        return all(f'SELECT {LIST_COLS} FROM files WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id DESC',
                   req.org['id'], _jstr(q.get('entity_type')), num_or_none(q.get('entity_id')))
    if not can(req, 'documents', 'view'):
        raise forbidden()
    where = ['org_id = ?']
    params = [req.org['id']]
    folder = q.get('folder')
    if truthy(folder) and folder != 'all':
        where.append('folder = ?')
        params.append(_jstr(folder))
    search = q.get('q')
    if truthy(search):
        where.append('name ILIKE ?')
        params.append('%' + _jstr(search).replace('\\', '\\\\') + '%')
    return all(f"SELECT {LIST_COLS} FROM files WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT 1000", *params)


def _create_file(req):
    org = req.org['id']
    body = _body(req)
    name, data = body.get('name'), body.get('data')
    if not truthy(name):
        raise bad('File name is required')
    if not truthy(data):
        raise bad('No file data received')
    text = _jstr(data)
    m = DATA_URL_RE.match(text)
    mime = body.get('mime')
    if not truthy(mime):
        mime = m.group(1) if m is not None and m.group(1) else None
    if not truthy(mime):
        mime = 'application/octet-stream'
    if len(text) > MAX_B64_CHARS:
        raise bad('Files can be at most 10 MB')
    buf = _b64decode_js(DATA_PREFIX_RE.sub('', text, count=1))
    if not buf:
        raise bad('The file is empty')
    if len(buf) > MAX_BYTES:
        raise bad('Files can be at most 10 MB')
    quota = int(os.environ.get('OPENBOOKS_ORG_STORAGE_MB') or 1024) * 1024 * 1024
    used = get('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE org_id = ?', org)['n']
    if used + len(buf) > quota:
        raise bad(f'This organization has used its {quota // (1024 * 1024)} MB of file storage. Delete some files first.')

    et = _jstr(body.get('entity_type')) if truthy(body.get('entity_type')) else None
    eid = num_or_none(body.get('entity_id')) if et is not None else None
    if et is not None:
        if not ENTITY_RE.fullmatch(et):
            raise bad('Invalid entity type')
        if not eid or not _entity_exists(org, et, eid):
            raise bad('The record to attach the file to was not found')
        assert_entity_access(req, et, eid, 'edit')
    elif not can(req, 'documents', 'create'):
        raise forbidden()
    fld = body.get('folder') if truthy(body.get('folder')) else 'inbox'
    if fld not in FOLDERS:
        raise bad('Invalid folder')

    fid = insert('files', {
        'org_id': org, 'name': _jstr(name)[:200], 'mime': _jstr(mime)[:100], 'size': len(buf), 'path': 'pending',
        'entity_type': et, 'entity_id': eid, 'folder': fld, 'uploaded_by': req.user['id'],
    })
    rel = f'uploads/{org}/{fid}-{_safe_name(name)}'
    target = _abs(rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(buf)
    update('files', fid, {'path': rel})
    audit(req, 'file', fid, 'uploaded', f'{_jstr(name)} ({len(buf)} bytes)')
    return _file_row(fid)


def _download_file(req):
    f = _load_file(req.org['id'], to_int(req.params['id']))
    _authorize(req, f, 'view')
    target = _abs(f['path'])
    if not target.exists():
        raise not_found('File contents')
    mime = f.get('mime') or 'application/octet-stream'
    inline = req.query.get('download') != '1' and bool(PREVIEWABLE.fullmatch(f.get('mime') or ''))
    # the whole file is read into memory (at most 10 MB): the router only passes HttpResponse objects through
    data = target.read_bytes()
    res = HttpResponse(data, content_type=mime)
    res['Content-Length'] = str(len(data))
    quoted = urllib.parse.quote(_jstr(f['name']), safe="-_.!~*'()")
    res['Content-Disposition'] = f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quoted}"
    res['X-Content-Type-Options'] = 'nosniff'
    res['Content-Security-Policy'] = 'sandbox'
    res['Cache-Control'] = 'private, no-store'
    return res


def _update_file(req):
    f = _load_file(req.org['id'], to_int(req.params['id']))
    _authorize(req, f, 'edit')
    b = _body(req)
    upd = {}
    if 'name' in b:
        if not _js_trim(_jstr(b['name'])):
            raise bad('File name is required')
        upd['name'] = _js_trim(_jstr(b['name']))[:200]
    if 'folder' in b:
        if b['folder'] not in FOLDERS:
            raise bad('Invalid folder')
        upd['folder'] = b['folder']
    if 'entity_type' in b:
        if not truthy(b['entity_type']):
            if not can(req, 'documents', 'edit'):  # a detached file becomes a library file
                raise forbidden()
            upd['entity_type'] = None
            upd['entity_id'] = None
        else:
            et = _jstr(b['entity_type'])
            eid = num_or_none(b.get('entity_id'))
            if not ENTITY_RE.fullmatch(et):
                raise bad('Invalid entity type')
            if not eid or not _entity_exists(req.org['id'], et, eid):
                raise bad('The record to attach the file to was not found')
            assert_entity_access(req, et, eid, 'edit')
            upd['entity_type'] = et
            upd['entity_id'] = eid
    if upd:
        update('files', f['id'], upd)
    audit(req, 'file', f['id'], 'updated', ', '.join(upd.keys()))
    return _file_row(f['id'])


def _delete_file(req):
    f = _load_file(req.org['id'], to_int(req.params['id']))
    _authorize(req, f, 'delete')
    try:
        _abs(f['path']).unlink()
    except FileNotFoundError:
        pass
    run('DELETE FROM files WHERE id = ?', f['id'])
    audit(req, 'file', f['id'], 'deleted', f['name'])
    return {'ok': True}


def routes(r):
    r.get('/files', _list_files)
    r.post('/files', _create_file)
    # streams the file; ?token= and ?org_id= let plain <a href> links work
    r.get('/files/:id/download', _download_file)
    r.put('/files/:id', _update_file)
    r.delete('/files/:id', _delete_file)
