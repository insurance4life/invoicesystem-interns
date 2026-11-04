"""Thin SQL helpers over Django's PostgreSQL connection (same API as the old db.js).

SQL uses `?` placeholders (converted to %s). Literal `%` in SQL text is escaped automatically.
Rows come back as plain dicts; Decimal -> float, datetime -> 'YYYY-MM-DD HH:MM:SS' (UTC), date -> 'YYYY-MM-DD'.
"""
import datetime
import decimal
import json
import re

from django.db import connection, transaction

_cache = {}
_PLACEHOLDER = re.compile(r"\?|'(?:[^']|'')*'")


def _sql(sql):
    s = _cache.get(sql)
    if s is None:
        # escape % for psycopg, then turn ? (outside string literals) into %s
        esc = sql.replace('%', '%%')
        s = _PLACEHOLDER.sub(lambda m: '%s' if m.group(0) == '?' else m.group(0), esc)
        _cache[sql] = s
    return s


def norm(v):
    """Normalise a parameter: dict/list -> JSON text, bool -> 0/1."""
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(',', ':'), ensure_ascii=False)
    return v


def _val(v):
    if isinstance(v, decimal.Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, datetime.datetime):
        if v.tzinfo:
            v = v.astimezone(datetime.timezone.utc)
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, memoryview):
        return bytes(v)
    return v


def _rows(cur):
    if cur.description is None:
        return []
    cols = [c[0] for c in cur.description]
    return [{c: _val(v) for c, v in zip(cols, r)} for r in cur.fetchall()]


def all(sql, *params):  # noqa: A001 - mirrors the original helper name
    with connection.cursor() as cur:
        cur.execute(_sql(sql), [norm(p) for p in params])
        return _rows(cur)


def get(sql, *params):
    r = all(sql, *params)
    return r[0] if r else None


def run(sql, *params):
    with connection.cursor() as cur:
        cur.execute(_sql(sql), [norm(p) for p in params])
        return cur.rowcount


def insert(table, obj):
    """INSERT the non-None keys of obj and return the new id (None values fall back to column defaults)."""
    keys = [k for k, v in obj.items() if v is not None]
    if keys:
        sql = f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)}) RETURNING id"
    else:
        sql = f'INSERT INTO {table} DEFAULT VALUES RETURNING id'
    return get(sql, *[obj[k] for k in keys])['id']


def update(table, id, obj, id_col='id'):  # noqa: A002
    """UPDATE the given keys (None -> NULL). Pass only the keys you want to change."""
    keys = list(obj.keys())
    if not keys:
        return
    run(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in keys)} WHERE {id_col} = ?", *[obj[k] for k in keys], id)


def tx(fn):
    """Run fn() atomically (nested calls use savepoints) and return its result."""
    with transaction.atomic():
        return fn()


def safe(fn, default=None):
    """Run fn() inside a savepoint; on any database error return default (keeps the outer transaction usable)."""
    try:
        with transaction.atomic():
            return fn()
    except Exception:  # noqa: BLE001
        return default


def parse_json(row, cols):
    """Parse JSON text columns in place (invalid JSON is left as text)."""
    if not row:
        return row
    for c in cols:
        v = row.get(c)
        if isinstance(v, str):
            try:
                row[c] = json.loads(v)
            except ValueError:
                pass
        elif v is None:
            row[c] = None
    return row


def table_exists(name):
    return bool(get("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?", name))


def column_names(table):
    return [r['column_name'] for r in all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table)]
