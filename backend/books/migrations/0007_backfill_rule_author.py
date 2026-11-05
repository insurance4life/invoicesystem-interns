"""Rules created before 0006 have no author, so the run-time author check would skip them. Take the author from the
rule's 'created' audit row, or else the organization's first active Admin."""
from django.db import migrations

SQL = [
    """UPDATE workflow_rules w SET created_by = a.user_id
       FROM (SELECT DISTINCT ON (org_id, entity_id) org_id, entity_id, user_id FROM activity
             WHERE entity_type = 'workflow_rule' AND action = 'created' AND user_id IS NOT NULL ORDER BY org_id, entity_id, id) a
       WHERE w.created_by IS NULL AND a.org_id = w.org_id AND a.entity_id = w.id""",
    """UPDATE workflow_rules w SET created_by = (
         SELECT ou.user_id FROM org_users ou JOIN roles r ON r.id = ou.role_id
         WHERE ou.org_id = w.org_id AND r.name = 'Admin' AND ou.status = 'active' ORDER BY ou.id LIMIT 1)
       WHERE w.created_by IS NULL""",
]


class Migration(migrations.Migration):
    dependencies = [('books', '0006_activity_created_rule_author')]
    operations = [migrations.RunSQL(s, migrations.RunSQL.noop) for s in SQL]
