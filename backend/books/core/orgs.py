"""Organization bootstrap: roles, currencies, payment terms, taxes and the chart of accounts (port of orgs.js)."""
import json
import shutil

from books.core.db import insert, run, tx
from books.core.router import bad
from books.core.ledger import create_default_accounts
from books.core.auth import ADMIN_PERMS, STAFF_PERMS, STAFF_LIMITED_PERMS, TIMESHEET_PERMS, ACCOUNTANT_PERMS
from books.core.util import DEFAULT_SETTINGS
from books.core.tds import seed_tds_sections

CURRENCIES = {
    'INR': ['₹', 'Indian Rupee'], 'USD': ['$', 'US Dollar'], 'EUR': ['€', 'Euro'], 'GBP': ['£', 'Pound Sterling'],
    'AED': ['AED', 'UAE Dirham'], 'SGD': ['S$', 'Singapore Dollar'], 'AUD': ['A$', 'Australian Dollar'], 'CAD': ['C$', 'Canadian Dollar'],
}
DEFAULT_RATES_INR = {'USD': 83.2, 'EUR': 90.5, 'GBP': 105.4, 'AED': 22.65, 'SGD': 61.9, 'AUD': 54.8, 'CAD': 61.2}


def _j(v):
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


_TEXT_LIMITS = {'name': 200, 'industry': 100, 'country': 100, 'state': 100, 'currency': 10, 'timezone': 64,
                'gstin': 32, 'email': 254, 'phone': 40}


def check_sizes(data):
    """The org row is re-read on every request, so its free-text fields are bounded."""
    for k, n in _TEXT_LIMITS.items():
        v = data.get(k)
        if v is not None and not isinstance(v, (str, int, float)):
            raise bad(f'Invalid {k}')
        if v is not None and len(str(v)) > n:
            raise bad(f'{k.replace("_", " ").capitalize()} must be at most {n} characters')
    if len(_j(data.get('address') or {})) > 2000:
        raise bad('Address is too long')


def delete_org(org_id):
    """Delete the org row (child rows cascade) and its uploaded files. Without the second step the files stayed on
    disk while their rows, and so the org's storage quota, disappeared."""
    from django.conf import settings  # noqa: PLC0415
    run('DELETE FROM orgs WHERE id = ?', org_id)
    shutil.rmtree(settings.DATA_DIR / 'uploads' / str(int(org_id)), ignore_errors=True)


def create_org(user_id, data):
    check_sizes(data)

    def _do():
        country = data.get('country') or 'India'
        currency = data.get('currency') or ('INR' if country == 'India' else 'USD')
        org_id = insert('orgs', {
            'name': data.get('name') or 'My Organization', 'industry': data.get('industry') or None, 'country': country,
            'state': data.get('state') or ('27' if country == 'India' else None),
            'currency': currency, 'fiscal_year_start': data.get('fiscal_year_start') or (4 if country == 'India' else 1),
            'timezone': data.get('timezone') or 'Asia/Kolkata',
            'gstin': data.get('gstin') or None, 'gst_enabled': 1 if country == 'India' else 0, 'address': _j(data.get('address') or {}),
            'email': data.get('email') or None, 'phone': data.get('phone') or None, 'settings': _j({'series': DEFAULT_SETTINGS['series']}),
        })
        admin_role = insert('roles', {'org_id': org_id, 'name': 'Admin', 'description': 'Unrestricted access to all modules', 'permissions': _j(ADMIN_PERMS), 'is_system': 1})
        insert('roles', {'org_id': org_id, 'name': 'Staff', 'description': 'Access to all modules except reports, settings and accountant', 'permissions': _j(STAFF_PERMS), 'is_system': 1})
        insert('roles', {'org_id': org_id, 'name': 'Staff (Assigned Customers Only)', 'description': 'Create and edit sales and purchases', 'permissions': _j(STAFF_LIMITED_PERMS), 'is_system': 1})
        insert('roles', {'org_id': org_id, 'name': 'Timesheet Staff', 'description': 'Log time against projects', 'permissions': _j(TIMESHEET_PERMS), 'is_system': 1})
        insert('roles', {'org_id': org_id, 'name': 'Accountant', 'description': 'Accounting, banking and reports', 'permissions': _j(ACCOUNTANT_PERMS), 'is_system': 1})
        insert('org_users', {'org_id': org_id, 'user_id': user_id, 'role_id': admin_role, 'status': 'active'})

        for code, (symbol, name) in CURRENCIES.items():
            if code != currency and code not in ['INR', 'USD', 'EUR', 'GBP', 'AED']:
                continue
            rate = 1 if code == currency else (DEFAULT_RATES_INR.get(code) or 1 if currency == 'INR' else 1)
            insert('currencies', {'org_id': org_id, 'code': code, 'symbol': symbol, 'name': name, 'exchange_rate': rate, 'is_base': 1 if code == currency else 0})
        for name, days, typ, default in [['Due on Receipt', 0, 'receipt', 0], ['Net 15', 15, 'net', 1], ['Net 30', 30, 'net', 0], ['Net 45', 45, 'net', 0],
                                         ['Net 60', 60, 'net', 0], ['Due end of the month', 0, 'eom', 0], ['Due end of next month', 30, 'eom', 0]]:
            insert('payment_terms', {'org_id': org_id, 'name': name, 'days': days, 'type': typ, 'is_default': default})
        if country == 'India':
            for r in [0, 5, 12, 18, 28]:
                insert('taxes', {'org_id': org_id, 'name': f'GST{r}', 'rate': r, 'kind': 'gst'})
            insert('taxes', {'org_id': org_id, 'name': 'Cess 1%', 'rate': 1, 'kind': 'simple'})
            seed_tds_sections(insert, org_id)
        else:
            insert('taxes', {'org_id': org_id, 'name': 'Sales Tax', 'rate': 8, 'kind': 'simple'})
            insert('taxes', {'org_id': org_id, 'name': 'VAT', 'rate': 10, 'kind': 'simple'})
        create_default_accounts(org_id)
        return org_id
    return tx(_do)


# ---------------------------------------------------------------- reset transactions
OPENING_SOURCES = ('opening_balance', 'contact_opening', 'item_opening')
# Activity, comments and attachments on these keep their meaning after a reset; everything else was about a transaction.
SETUP_ENTITIES = ('org', 'user', 'role', 'contact', 'item', 'account', 'tax', 'tds_section', 'payment_term', 'currency', 'custom_field',
                  'project', 'budget', 'price_list', 'bank_rule', 'workflow_rule', 'incoming_webhook', 'file', 'opening_balance')
# Every table that holds transactions or their by-products. Child rows (document lines, allocations, journal lines,
# deposit lines, depreciation) go with their parents through ON DELETE CASCADE.
TRANSACTION_TABLES = ('documents', 'payments', 'payment_links', 'credit_applications', 'refunds', 'journals', 'expenses', 'bank_txns',
                      'bank_deposit_payments', 'bank_statement_lines', 'reconciliations', 'inventory_adjustments', 'fixed_assets',
                      'fixed_asset_depreciation', 'currency_adjustments', 'time_entries', 'reminder_log', 'emails', 'workflow_logs')


def reset_transactions(org_id, keep_opening_balances=True):
    """Delete every transaction of one org and keep its setup: settings, users and roles, chart of accounts, contacts,
    items, taxes, projects, budgets and rules. Number series restart at 1 and the lock date is cleared, since nothing is
    left to protect. Opening balances (accounts, contacts, item stock) stay unless asked otherwise. Returns the number
    of rows removed per table and the attachment paths to delete from disk once the transaction commits."""
    from books.core.db import all as db_all, get  # noqa: PLC0415
    marks = ','.join('?' * len(SETUP_ENTITIES))
    removed = {}
    for t in TRANSACTION_TABLES:
        removed[t] = run(f'DELETE FROM {t} WHERE org_id = ?', org_id)
    keep = ','.join('?' * len(OPENING_SOURCES))
    if keep_opening_balances:
        removed['ledger'] = run(f'DELETE FROM ledger WHERE org_id = ? AND src_type NOT IN ({keep})', org_id, *OPENING_SOURCES)
        run('UPDATE ledger SET reconciliation_id = NULL WHERE org_id = ?', org_id)
        removed['stock_moves'] = run("DELETE FROM stock_moves WHERE org_id = ? AND src_type != 'item_opening'", org_id)
    else:
        removed['ledger'] = run('DELETE FROM ledger WHERE org_id = ?', org_id)
        removed['stock_moves'] = run('DELETE FROM stock_moves WHERE org_id = ?', org_id)
        run('UPDATE items SET opening_stock = 0 WHERE org_id = ?', org_id)
    paths = [f['path'] for f in db_all(f'''SELECT path FROM files WHERE org_id = ? AND entity_type IS NOT NULL AND entity_type != ''
                                           AND entity_type NOT IN ({marks})''', org_id, *SETUP_ENTITIES)]
    removed['files'] = run(f"DELETE FROM files WHERE org_id = ? AND entity_type IS NOT NULL AND entity_type != '' AND entity_type NOT IN ({marks})",
                           org_id, *SETUP_ENTITIES)
    removed['comments'] = run(f'DELETE FROM comments WHERE org_id = ? AND entity_type NOT IN ({marks})', org_id, *SETUP_ENTITIES)
    removed['activity'] = run(f'DELETE FROM activity WHERE org_id = ? AND entity_type NOT IN ({marks})', org_id, *SETUP_ENTITIES)
    # written whole: save_org_settings merges nested keys, which would keep the old period locks
    cur = json.loads((get('SELECT settings FROM orgs WHERE id = ?', org_id) or {}).get('settings') or '{}')
    series = {**DEFAULT_SETTINGS['series'], **(cur.get('series') if isinstance(cur.get('series'), dict) else {})}
    cur['series'] = {k: {**(v if isinstance(v, dict) else {}), 'next': 1} for k, v in series.items()}
    cur['locks'] = {}
    run('UPDATE orgs SET settings = ?, lock_date = NULL WHERE id = ?', _j(cur), org_id)
    return {k: v for k, v in removed.items() if v}, paths
