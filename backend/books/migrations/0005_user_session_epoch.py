from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('books', '0004_staff_role_scope')]
    operations = [migrations.AddField(model_name='user', name='session_epoch', field=models.IntegerField(default=0, null=True))]
