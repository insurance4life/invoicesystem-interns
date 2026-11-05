"""TDS (tax deducted at source) sections seeded for Indian organizations. Rates follow the Income-tax Act as of
FY 2025-26; each org can edit them in Settings > TDS sections when the law or a lower-deduction certificate changes them."""

DEFAULT_TDS_SECTIONS = [
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


def seed_tds_sections(insert, org_id):
    for section, name, rate in DEFAULT_TDS_SECTIONS:
        insert('tds_sections', {'org_id': org_id, 'section': section, 'name': name, 'rate': rate})
