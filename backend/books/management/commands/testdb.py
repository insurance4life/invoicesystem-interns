"""Throw-away databases for the API test-suite.

    python manage.py testdb create <name>   # clone of a migrated template database (fast)
    python manage.py testdb drop <name>
    python manage.py testdb cleanup         # drop every leftover obtest_* database

The template (openbooks_test_template) is rebuilt automatically whenever the migrations change.
"""
import hashlib
from pathlib import Path

import psycopg
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

TEMPLATE = 'openbooks_test_template'


def _admin_conn():
    db = settings.DATABASES['default']
    return psycopg.connect(host=db['HOST'], port=db['PORT'], user=db['USER'], password=db['PASSWORD'], dbname='postgres', autocommit=True)


CREATE_OPTS = "TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"


def _migrations_hash():
    mig = Path(__file__).resolve().parents[2] / 'migrations'
    h = hashlib.sha1(CREATE_OPTS.encode())
    for f in sorted(mig.glob('*.py')):
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:16]


def _exists(cur, name):
    cur.execute('SELECT 1 FROM pg_database WHERE datname = %s', [name])
    return cur.fetchone() is not None


def _drop(cur, name):
    cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _ensure_template(cur):
    want = _migrations_hash()
    if _exists(cur, TEMPLATE):
        cur.execute("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = %s", [TEMPLATE])
        if (cur.fetchone() or [None])[0] == want:
            return
        _drop(cur, TEMPLATE)
    cur.execute(f'CREATE DATABASE "{TEMPLATE}" {CREATE_OPTS}')
    from django.db import connections  # noqa: PLC0415
    db = settings.DATABASES['default']
    original = db['NAME']
    db['NAME'] = TEMPLATE
    connections['default'].close()
    connections['default'].settings_dict['NAME'] = TEMPLATE
    try:
        call_command('migrate', verbosity=0, interactive=False)
    finally:
        connections['default'].close()
        connections['default'].settings_dict['NAME'] = original
        db['NAME'] = original
    cur.execute(f"COMMENT ON DATABASE \"{TEMPLATE}\" IS '{want}'")


class Command(BaseCommand):
    help = 'Create/drop throw-away test databases'

    def add_arguments(self, parser):
        parser.add_argument('action', choices=['create', 'drop', 'cleanup'])
        parser.add_argument('name', nargs='?')

    def handle(self, *args, action=None, name=None, **opts):
        if action in ('create', 'drop') and (not name or not name.startswith('obtest_')):
            raise CommandError('test database names must start with obtest_')
        with _admin_conn() as conn, conn.cursor() as cur:
            if action == 'create':
                _ensure_template(cur)
                _drop(cur, name)
                cur.execute(f'CREATE DATABASE "{name}" TEMPLATE "{TEMPLATE}"')
            elif action == 'drop':
                _drop(cur, name)
            else:
                cur.execute("SELECT datname FROM pg_database WHERE datname LIKE 'obtest\\_%%'")
                for (n,) in cur.fetchall():
                    _drop(cur, n)
        self.stdout.write('ok')
