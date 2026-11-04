"""The system Staff role is described as having no reports, settings or accountant access, but was seeded with
accountant and reports rights. Rewrite only system Staff roles that still hold exactly the old seed."""
import json

from django.db import migrations

MODULES = ['contacts', 'items', 'sales', 'purchases', 'banking', 'accountant', 'reports', 'projects', 'documents', 'settings']
ACTIONS = ['view', 'create', 'edit', 'delete']
OLD = {m: ACTIONS for m in MODULES if m != 'settings'}
NEW = {m: ACTIONS for m in MODULES if m not in ('settings', 'accountant', 'reports')}


def forwards(apps, schema_editor):
    with schema_editor.connection.cursor() as c:
        c.execute("SELECT id, permissions FROM roles WHERE is_system = 1 AND name = 'Staff'")
        for rid, perms in c.fetchall():
            try:
                cur = json.loads(perms or '{}')
            except ValueError:
                continue
            if cur == OLD:
                c.execute('UPDATE roles SET permissions = %s WHERE id = %s', [json.dumps(NEW, separators=(',', ':')), rid])


class Migration(migrations.Migration):
    dependencies = [('books', '0003_report_and_import_indexes')]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
