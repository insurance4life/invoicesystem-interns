"""Organization bootstrap: roles, currencies, payment terms, taxes and the chart of accounts (port of orgs.js)."""
import json

from books.core.db import insert, tx
from books.core.router import bad
from books.core.ledger import create_default_accounts
from books.core.auth import ADMIN_PERMS, STAFF_PERMS, STAFF_LIMITED_PERMS, TIMESHEET_PERMS, ACCOUNTANT_PERMS
from books.core.util import DEFAULT_SETTINGS

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
        else:
            insert('taxes', {'org_id': org_id, 'name': 'Sales Tax', 'rate': 8, 'kind': 'simple'})
            insert('taxes', {'org_id': org_id, 'name': 'VAT', 'rate': 10, 'kind': 'simple'})
        create_default_accounts(org_id)
        return org_id
    return tx(_do)
