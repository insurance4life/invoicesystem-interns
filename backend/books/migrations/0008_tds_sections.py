"""TDS sections per org, a default section on contacts and the section a payment deducted under. Existing Indian
orgs get the standard sections seeded (the same list books.core.tds seeds for new orgs)."""

import django.db.models.deletion
from django.db import migrations, models


SEED = [
    ('194C', 'Contractors (individual or HUF)', 1),
    ('194C', 'Contractors (others)', 2),
    ('194J', 'Professional fees', 10),
    ('194J', 'Technical services', 2),
    ('194H', 'Commission or brokerage', 2),
    ('194I', 'Rent on land, building or furniture', 10),
    ('194I', 'Rent on plant and machinery', 2),
    ('194A', 'Interest other than on securities', 10),
    ('194Q', 'Purchase of goods', 0.1),
]
SEED_SQL = ("INSERT INTO tds_sections (org_id, section, name, rate, is_active) SELECT o.id, v.section, v.name, v.rate, 1 FROM orgs o "
            "CROSS JOIN (VALUES " + ', '.join(f"('{s}', '{n}', {r}::double precision, {i})" for i, (s, n, r) in enumerate(SEED)) +
            ") AS v(section, name, rate, ord) WHERE o.country = 'India' ORDER BY o.id, v.ord")


class Migration(migrations.Migration):

    dependencies = [
        ('books', '0007_backfill_rule_author'),
    ]

    operations = [
        migrations.AddField(
            model_name='contact',
            name='tds_section_id',
            field=models.IntegerField(null=True),
        ),
        migrations.AddField(
            model_name='payment',
            name='tds_section_id',
            field=models.IntegerField(null=True),
        ),
        migrations.AlterField(
            model_name='user',
            name='session_epoch',
            field=models.IntegerField(db_default=0, null=True),
        ),
        migrations.CreateModel(
            name='TdsSection',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.TextField()),
                ('section', models.TextField(null=True)),
                ('rate', models.FloatField(db_default=0, null=True)),
                ('is_active', models.IntegerField(db_default=1, null=True)),
                ('org', models.ForeignKey(on_delete=django.db.models.deletion.DB_CASCADE, related_name='+', to='books.org')),
            ],
            options={
                'db_table': 'tds_sections',
            },
        ),
        migrations.RunSQL(SEED_SQL, migrations.RunSQL.noop),
    ]
