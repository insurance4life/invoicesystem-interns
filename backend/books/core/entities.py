"""Which module's permissions govern a record referenced by (entity_type, entity_id), as used by comments,
activity history and attachments. Unknown types fall back to settings, the most restrictive module."""
from books.core.db import get
from books.core.auth import can
from books.core.router import forbidden
from books.core.documents import DOC_TYPES

_FIXED = {
    'expense': 'purchases', 'payment_made': 'purchases',
    'payment_received': 'sales',
    'contact': 'contacts', 'customer': 'contacts', 'vendor': 'contacts',
    'item': 'items', 'inventory_adjustment': 'items', 'price_list': 'items',
    'project': 'projects', 'time_entry': 'projects',
    'journal': 'accountant', 'account': 'accountant', 'fixed_asset': 'accountant', 'budget': 'accountant',
    'currency_adjustment': 'accountant', 'opening_balance': 'accountant',
    'bank_txn': 'banking', 'bank_statement_line': 'banking', 'bank_rule': 'banking', 'reconciliation': 'banking',
}


def _side_module(doc_type):
    return 'sales' if (DOC_TYPES.get(doc_type) or {}).get('side') == 'sales' else 'purchases'


def entity_module(org_id, entity_type, entity_id):
    if entity_type in DOC_TYPES:
        return _side_module(entity_type)
    if entity_type == 'document':
        d = get('SELECT doc_type FROM documents WHERE id = ? AND org_id = ?', entity_id, org_id)
        return _side_module(d['doc_type']) if d else 'settings'
    if entity_type == 'payment':
        p = get('SELECT type FROM payments WHERE id = ? AND org_id = ?', entity_id, org_id)
        return 'sales' if p and p['type'] == 'received' else 'purchases'
    return _FIXED.get(entity_type, 'settings')


def assert_entity_access(req, entity_type, entity_id, action):
    """403 unless the caller holds `action` on the module that owns the referenced record."""
    if not can(req, entity_module(req.org['id'], entity_type, entity_id), action):
        raise forbidden()
