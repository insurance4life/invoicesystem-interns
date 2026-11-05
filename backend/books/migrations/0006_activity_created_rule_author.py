from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('books', '0005_user_session_epoch')]
    operations = [
        migrations.RunSQL('CREATE INDEX IF NOT EXISTS ix_activity_org_created ON activity (org_id, created_at)',
                          'DROP INDEX IF EXISTS ix_activity_org_created'),
        migrations.AddField(model_name='workflowrule', name='created_by', field=models.IntegerField(null=True)),
    ]
