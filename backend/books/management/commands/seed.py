"""Demo data: `python manage.py seed` (add --reset to wipe all OpenBooks data first).

Creates demo@openbooks.local / demo1234 with an Indian GST-registered organization and ~6 months of activity.
All data goes through the real API (in-process), exactly like the original seed.js.
"""
import datetime
import json
import math
import re

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.test import Client


def day(offset):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=offset)).date().isoformat()


class Api:
    def __init__(self):
        self.c = Client()
        self.token = None
        self.org = None

    def call(self, method, url, body=None):
        headers = {}
        if self.token:
            headers['HTTP_AUTHORIZATION'] = f'Bearer {self.token}'
        if self.org:
            headers['HTTP_X_ORG_ID'] = str(self.org)
        fn = getattr(self.c, method.lower())
        res = fn(f'/api{url}', data=json.dumps(body) if body is not None else None, content_type='application/json', **headers)
        data = json.loads(res.content or b'{}')
        if res.status_code >= 400:
            raise CommandError(f"{method} {url}: {data.get('error')}")
        return data

    def get(self, u):
        return self.call('GET', u)

    def post(self, u, b=None):
        return self.call('POST', u, b or {})

    def put(self, u, b=None):
        return self.call('PUT', u, b or {})


def js_round(x):
    return math.floor(x + 0.5)


class Command(BaseCommand):
    help = 'Create the demo organization and data'

    def add_arguments(self, parser):
        parser.add_argument('--reset', action='store_true', help='delete all BeyondBooks data first')

    def handle(self, *args, **opts):  # noqa: C901
        from books.core.db import get  # noqa: PLC0415
        if opts['reset']:
            with connection.cursor() as cur:
                cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename != 'django_migrations'")
                tables = [r[0] for r in cur.fetchall()]
                if tables:
                    cur.execute('TRUNCATE ' + ', '.join(f'"{t}"' for t in tables) + ' RESTART IDENTITY CASCADE')
            self.stdout.write('Database reset.')
        if get('SELECT id FROM users WHERE lower(email) = lower(?)', 'demo@openbooks.local'):
            self.stdout.write('Demo user already exists. Run `python manage.py seed --reset` to recreate.')
            return

        api = Api()
        post, put = api.post, api.put
        s = post('/auth/signup', {'name': 'Demo Admin', 'email': 'demo@openbooks.local', 'password': 'demo1234', 'organization': {
            'name': 'Zylker Traders Pvt Ltd', 'country': 'India', 'state': '27', 'currency': 'INR', 'industry': 'Wholesale', 'gstin': '27AAPFZ1234K1Z5',
            'email': 'accounts@zylker.example', 'phone': '+91 22 4000 1234',
            'address': {'street': '12, Nariman Point', 'city': 'Mumbai', 'state': 'Maharashtra', 'zip': '400021', 'country': 'India'}}})
        api.token, api.org = s['token'], s['org_id']
        meta = api.get('/meta')

        def acc(code):
            return next((a['id'] for a in meta['accounts'] if a['system_code'] == code), None)
        bank_id = next((a['id'] for a in meta['accounts'] if a['type'] == 'bank'), None)

        def tax(n):
            return next((t['id'] for t in meta['taxes'] if t['name'] == n), None)

        def term(n):
            return next(t['id'] for t in meta['payment_terms'] if t['name'] == n)
        put('/org', {'address': {'street': '12, Nariman Point', 'city': 'Mumbai', 'state': 'Maharashtra', 'zip': '400021', 'country': 'India'}})
        self.stdout.write('Organization created.')

        customers = []
        for c in [
            ['Acme Industries', 'billing@acme.example', '27AABCA1234B1Z2', '27', 'registered'],
            ['Bharat Retail LLP', 'ap@bharat.example', '29AAGFB5678C1Z9', '29', 'registered'],
            ['Chennai Foods', 'accounts@chennaifoods.example', '33AACCC4321D1Z4', '33', 'registered'],
            ['Delhi Design Studio', 'hello@dds.example', None, '07', 'unregistered'],
            ['Riya Sharma', 'riya@example.com', None, '27', 'consumer'],
            ['Globex Corp (USA)', 'finance@globex.example', None, '96', 'overseas'],
        ]:
            customers.append(post('/contacts', {'type': 'customer', 'display_name': c[0], 'company_name': c[0], 'email': c[1], 'gstin': c[2], 'place_of_supply': c[3],
                                                'gst_treatment': c[4], 'currency': 'USD' if c[4] == 'overseas' else 'INR', 'payment_term_id': term('Net 30'),
                                                'phone': '+91 98200 00000',
                                                'billing_address': {'street': '1 Main Road', 'city': 'Chennai' if 'Chennai' in c[0] else 'Mumbai', 'country': 'India'},
                                                'portal_enabled': 1}))
        vendors = []
        for v in [['Sunrise Electronics', '27AAKCS9876E1Z1', '27'], ['Patel Packaging', '24AAJFP2345F1Z6', '24'], ['CloudHost India', '29AAFCC1111G1Z3', '29'], ['Office Mart', None, '27']]:
            vendors.append(post('/contacts', {'type': 'vendor', 'display_name': v[0], 'company_name': v[0], 'gstin': v[1], 'place_of_supply': v[2],
                                              'gst_treatment': 'registered' if v[1] else 'unregistered', 'email': f"{v[0].split(' ')[0].lower()}@vendor.example"}))
        self.stdout.write('Contacts created.')

        items = {}
        for name, typ, sell, buy, hsn, track, opening in [
            ['USB-C Charger 65W', 'goods', 1499, 900, '8504', 1, 40], ['Wireless Mouse', 'goods', 799, 420, '8471', 1, 60], ['Mechanical Keyboard', 'goods', 3499, 2100, '8471', 1, 25],
            ['27" Monitor', 'goods', 16999, 12500, '8528', 1, 10], ['Installation Service', 'service', 2500, 0, '998734', 0, 0], ['Annual Maintenance Contract', 'service', 12000, 0, '998713', 0, 0],
            ['Packaging Box (Large)', 'goods', 45, 22, '4819', 1, 300],
        ]:
            items[name] = post('/items', {'name': name, 'type': typ, 'selling_price': sell, 'purchase_price': buy, 'hsn_sac': hsn, 'track_inventory': track,
                                          'opening_stock': opening, 'opening_stock_rate': buy, 'tax_id': tax('GST18'), 'purchase_tax_id': tax('GST18'),
                                          'unit': 'hrs' if typ == 'service' else 'pcs', 'sku': re.sub(r'[^A-Z0-9]', '', name, flags=re.I)[:8].upper(),
                                          'reorder_level': 10 if track else 0,
                                          'description': 'Professional services' if typ == 'service' else f'{name} – 1 year warranty'})
        self.stdout.write('Items created.')

        post('/journals', {'date': day(-180), 'notes': 'Owner capital introduced', 'reference': 'CAP-001',
                           'lines': [{'account_id': bank_id, 'debit': 1500000}, {'account_id': acc('owners_equity'), 'credit': 1500000}]})

        for m in range(5, -1, -1):
            bill = post('/documents/bill', {'contact_id': vendors[0]['id'], 'date': day(-m * 30 - 12), 'reference': f'SE/{1000 + m}', 'payment_term_id': term('Net 15'),
                                            'lines': [{'item_id': items['USB-C Charger 65W']['id'], 'quantity': 20, 'rate': 900, 'tax_id': tax('GST18')},
                                                      {'item_id': items['Wireless Mouse']['id'], 'quantity': 30, 'rate': 420, 'tax_id': tax('GST18')}], 'save_as': 'open'})
            if m > 0:
                post('/payments/made', {'contact_id': vendors[0]['id'], 'date': day(-m * 30 + 2), 'amount': bill['total'], 'mode': 'Bank Transfer', 'account_id': bank_id,
                                        'allocations': [{'document_id': bill['id'], 'amount': bill['total']}]})
            post('/expenses', {'date': day(-m * 30 - 5), 'account_id': acc('rent'), 'paid_through_id': bank_id, 'amount': 45000, 'tax_id': tax('GST18'), 'tax_inclusive': 0,
                               'vendor_id': vendors[3]['id'], 'reference': f'RENT-{m}', 'notes': 'Office rent'})
            post('/expenses', {'date': day(-m * 30 - 3), 'account_id': acc('it_internet'), 'paid_through_id': bank_id, 'amount': 5900, 'tax_id': tax('GST18'), 'tax_inclusive': 1,
                               'vendor_id': vendors[2]['id'], 'reference': f'CH-{m}', 'notes': 'Cloud hosting'})
            post('/expenses', {'date': day(-m * 30 - 8), 'account_id': acc('salaries'), 'paid_through_id': bank_id, 'amount': 180000, 'reference': f'SAL-{m}', 'notes': 'Monthly salaries'})
        bill2 = post('/documents/bill', {'contact_id': vendors[1]['id'], 'date': day(-20), 'lines': [{'item_id': items['Packaging Box (Large)']['id'], 'quantity': 500, 'rate': 22, 'tax_id': tax('GST12')}], 'save_as': 'open'})
        post('/payments/made', {'contact_id': vendors[1]['id'], 'date': day(-10), 'amount': 5000, 'mode': 'UPI', 'account_id': bank_id, 'allocations': [{'document_id': bill2['id'], 'amount': 5000}]})
        post('/documents/bill', {'contact_id': vendors[0]['id'], 'date': day(-45), 'due_date': day(-15), 'lines': [{'item_id': items['27" Monitor']['id'], 'quantity': 5, 'rate': 12500, 'tax_id': tax('GST18')}], 'save_as': 'open'})
        post('/expenses', {'date': day(-15), 'account_id': acc('travel'), 'paid_through_id': acc('petty_cash'), 'amount': 8400, 'customer_id': customers[0]['id'], 'is_billable': 1,
                           'markup_percent': 10, 'reference': 'TRV-77', 'notes': 'Site visit travel'})
        post('/documents/purchaseorder', {'contact_id': vendors[0]['id'], 'date': day(-3), 'lines': [{'item_id': items['Mechanical Keyboard']['id'], 'quantity': 15, 'rate': 2100, 'tax_id': tax('GST18')}], 'save_as': 'open'})
        self.stdout.write('Purchases created.')

        item_list = list(items.values())
        n = 0
        for m in range(5, -1, -1):
            for k in range(4):
                c = customers[:5][n % 5]
                n += 1
                it = item_list[n % len(item_list)]
                lines = [{'item_id': it['id'], 'quantity': 1 + (n % 4), 'rate': it['selling_price'], 'tax_id': tax('GST18')}]
                if n % 3 == 0:
                    lines.append({'item_id': items['Installation Service']['id'], 'quantity': 2, 'rate': 2500, 'tax_id': tax('GST18')})
                inv = post('/documents/invoice', {'contact_id': c['id'], 'date': day(-m * 30 - k * 6), 'lines': lines, 'save_as': 'send', 'discount_type': 'percent',
                                                  'discount_value': 5 if n % 5 == 0 else 0})
                paid_full = m >= 2 or k < 2
                if paid_full or n % 2:
                    amount = inv['total'] if paid_full else js_round(inv['total'] / 2)
                    off = -m * 30 - k * 6 + 12
                    post('/payments/received', {'contact_id': c['id'], 'date': day(0 if off > 0 else off), 'amount': amount,
                                                'mode': ['Bank Transfer', 'UPI', 'Cheque', 'Cash'][n % 4], 'account_id': bank_id if n % 3 else acc('undeposited_funds'),
                                                'reference': f'UTR{100000 + n}', 'allocations': [{'document_id': inv['id'], 'amount': amount}]})
        us_inv = post('/documents/invoice', {'contact_id': customers[5]['id'], 'date': day(-25), 'currency': 'USD', 'exchange_rate': 83.2,
                                             'lines': [{'item_id': items['Annual Maintenance Contract']['id'], 'quantity': 1, 'rate': 1500}], 'save_as': 'send'})
        post('/payments/received', {'contact_id': customers[5]['id'], 'date': day(-5), 'amount': 1000, 'currency': 'USD', 'exchange_rate': 84.1, 'mode': 'Bank Transfer',
                                    'account_id': bank_id, 'allocations': [{'document_id': us_inv['id'], 'amount': 1000}]})
        post('/documents/invoice', {'contact_id': customers[1]['id'], 'date': day(0), 'lines': [{'item_id': items['Mechanical Keyboard']['id'], 'quantity': 5, 'rate': 3499, 'tax_id': tax('GST18')}]})
        q1 = post('/documents/quote', {'contact_id': customers[2]['id'], 'date': day(-7), 'lines': [
            {'item_id': items['27" Monitor']['id'], 'quantity': 4, 'rate': 16999, 'tax_id': tax('GST18')},
            {'item_id': items['Installation Service']['id'], 'quantity': 4, 'rate': 2500, 'tax_id': tax('GST18')}], 'save_as': 'send'})
        post('/documents/quote', {'contact_id': customers[3]['id'], 'date': day(-2), 'lines': [{'item_id': items['Annual Maintenance Contract']['id'], 'quantity': 1, 'rate': 12000, 'tax_id': tax('GST18')}]})
        q3 = post('/documents/quote', {'contact_id': customers[0]['id'], 'date': day(-30), 'lines': [{'item_id': items['USB-C Charger 65W']['id'], 'quantity': 10, 'rate': 1450, 'tax_id': tax('GST18')}], 'save_as': 'send'})
        post(f"/documents/quote/{q3['id']}/action/accept")
        so = post(f"/documents/quote/{q3['id']}/convert", {'to': 'salesorder'})
        post(f"/documents/salesorder/{so['id']}/action/open")
        rows = api.get(f"/documents/invoice?contact_id={customers[0]['id']}")['rows']
        inv0 = rows[0] if rows else None
        cn = post('/documents/creditnote', {'contact_id': customers[0]['id'], 'date': day(-4), 'reference': inv0['number'] if inv0 else None,
                                            'lines': [{'item_id': items['Wireless Mouse']['id'], 'quantity': 1, 'rate': 799, 'tax_id': tax('GST18')}], 'save_as': 'open'})
        post('/documents/retainer', {'contact_id': customers[2]['id'], 'date': day(-6), 'lines': [{'name': 'Advance for monitor order', 'quantity': 1, 'rate': 25000}], 'save_as': 'send'})
        post('/documents/salesreceipt', {'contact_id': customers[4]['id'], 'date': day(-1), 'payment_mode': 'UPI', 'account_id': bank_id,
                                         'lines': [{'item_id': items['Wireless Mouse']['id'], 'quantity': 2, 'rate': 799, 'tax_id': tax('GST18')}]})
        post('/documents/deliverychallan', {'contact_id': customers[1]['id'], 'date': day(-9), 'lines': [{'item_id': items['Packaging Box (Large)']['id'], 'quantity': 100, 'rate': 45}], 'save_as': 'open'})
        post('/documents/recurring_invoice', {'contact_id': customers[0]['id'], 'number': 'Acme – Monthly AMC', 'date': day(-1), 'payment_term_id': term('Net 15'),
                                              'lines': [{'item_id': items['Annual Maintenance Contract']['id'], 'quantity': 1, 'rate': 1000, 'tax_id': tax('GST18'), 'description': 'Monthly maintenance'}],
                                              'recurrence': {'frequency': 'monthly', 'every': 1, 'start_date': day(-1), 'auto_send': False}})
        post('/expenses', {'is_profile': 1, 'date': day(5), 'account_id': acc('telephone'), 'paid_through_id': bank_id, 'amount': 1180, 'tax_id': tax('GST18'), 'tax_inclusive': 1,
                           'notes': 'Broadband', 'recurrence': {'frequency': 'monthly', 'every': 1, 'start_date': day(5)}})
        self.stdout.write('Sales created.')

        def opt(fn):
            try:
                return fn()
            except CommandError as e:
                self.stdout.write(f'  (skipped) {e}')
                return None
        p = opt(lambda: post('/projects', {'name': 'Acme ERP Rollout', 'customer_id': customers[0]['id'], 'billing_method': 'project_hours', 'rate': 2000,
                                           'budget_type': 'hours', 'budget_hours': 120, 'description': 'Hardware rollout and training'}))
        if p:
            for i in range(1, 7):
                opt(lambda i=i: post('/time-entries', {'project_id': p['id'], 'date': day(-i * 3), 'minutes': 120 + i * 15, 'notes': f'Onsite work day {i}', 'billable': 1}))
        now = datetime.datetime.now()
        opt(lambda: post('/budgets', {'name': 'FY Operating Budget', 'fiscal_year': now.year if now.month >= 4 else now.year - 1, 'period': 'monthly',
                                      'lines': {str(acc('rent')): [50000] * 12, str(acc('salaries')): [175000] * 12, str(acc('sales')): [150000] * 12}}))
        fa = opt(lambda: post('/fixed-assets', {'name': 'Office Laptop Fleet', 'asset_account_id': acc('computers'), 'purchase_date': day(-150), 'purchase_value': 240000,
                                                'salvage_value': 0, 'useful_life_months': 36, 'method': 'straight_line', 'depreciation_start': day(-150)}))
        if fa:
            opt(lambda: post(f"/fixed-assets/{fa['id']}/activate"))
        opt(lambda: post(f'/banking/accounts/{bank_id}/import', {'rows': [
            {'date': day(-2), 'description': 'NEFT CR ACME INDUSTRIES', 'amount': 1770, 'reference': 'NEFT123'},
            {'date': day(-1), 'description': 'POS AMAZON OFFICE SUPPLIES', 'amount': -2360, 'reference': 'POS998'},
            {'date': day(0), 'description': 'BANK CHARGES QTR', 'amount': -295, 'reference': 'CHG01'},
        ]}))
        put('/org/settings', {'approvals': {'bill': False}, 'preferences': {'invoice_terms': 'Payment within the due date. Interest @18% p.a. on late payments.'}})
        self.stdout.write('\nDone. Sign in with demo@openbooks.local / demo1234')
        self.stdout.write(f"(quote {q1['number']}, credit note {cn['number']} and more were created)")
