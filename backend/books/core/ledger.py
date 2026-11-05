"""Double-entry posting, system accounts, balances and stock (port of ledger.js)."""
import math

from books.core.db import all, get, run, insert, tx
from books.core.router import bad
from books.core.util import assert_owned, assert_unlocked, canon_date
from books.core.calc import round2, ACCOUNT_CLASS, sum_js

DEFAULT_ACCOUNTS = [
    # assets
    ['1000', 'Petty Cash', 'cash', 'petty_cash'],
    ['1010', 'Undeposited Funds', 'cash', 'undeposited_funds'],
    ['1100', 'Accounts Receivable', 'accounts_receivable', 'ar'],
    ['1200', 'Inventory Asset', 'stock', 'inventory'],
    ['1300', 'Prepaid Expenses', 'other_current_asset', 'prepaid'],
    ['1310', 'TDS Receivable', 'other_current_asset', 'tds_receivable'],
    ['1320', 'Advance Tax', 'other_current_asset', 'advance_tax'],
    ['1330', 'Input CGST', 'other_current_asset', 'input_cgst'],
    ['1331', 'Input SGST', 'other_current_asset', 'input_sgst'],
    ['1332', 'Input IGST', 'other_current_asset', 'input_igst'],
    ['1340', 'Input Tax Credits', 'other_current_asset', 'input_tax'],
    ['1350', 'Employee Advance', 'other_current_asset', 'employee_advance'],
    ['1500', 'Furniture and Equipment', 'fixed_asset', 'furniture'],
    ['1510', 'Computers', 'fixed_asset', 'computers'],
    ['1590', 'Accumulated Depreciation', 'fixed_asset', 'accumulated_depreciation'],
    # liabilities
    ['2000', 'Accounts Payable', 'accounts_payable', 'ap'],
    ['2100', 'Output CGST', 'other_current_liability', 'output_cgst'],
    ['2101', 'Output SGST', 'other_current_liability', 'output_sgst'],
    ['2102', 'Output IGST', 'other_current_liability', 'output_igst'],
    ['2110', 'Tax Payable', 'other_current_liability', 'tax_payable'],
    ['2120', 'TDS Payable', 'other_current_liability', 'tds_payable'],
    ['2130', 'Employee Reimbursements', 'other_current_liability', 'employee_reimbursements'],
    ['2140', 'Unearned Revenue', 'other_current_liability', 'unearned_revenue'],
    ['2500', 'Long Term Loans', 'long_term_liability', None],
    # equity
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['3100', 'Drawings', 'equity', 'drawings'],
    ['3200', 'Retained Earnings', 'equity', 'retained_earnings'],
    ['3300', 'Opening Balance Offset', 'equity', 'opening_balance_offset'],
    # income
    ['4000', 'Sales', 'income', 'sales'],
    ['4010', 'General Income', 'income', 'general_income'],
    ['4020', 'Interest Income', 'income', 'interest_income'],
    ['4030', 'Late Fee Income', 'income', 'late_fee_income'],
    ['4040', 'Shipping Charge', 'income', 'shipping_charge'],
    ['4050', 'Discount', 'income', 'discount'],
    ['4060', 'Other Charges', 'income', 'other_charges'],
    ['4900', 'Exchange Gain or Loss', 'other_income', 'fx_gain_loss'],
    # expenses
    ['5000', 'Cost of Goods Sold', 'cost_of_goods_sold', 'cogs'],
    ['6000', 'Advertising And Marketing', 'expense', 'advertising'],
    ['6010', 'Bank Fees and Charges', 'expense', 'bank_charges'],
    ['6020', 'Office Supplies', 'expense', 'office_supplies'],
    ['6030', 'Rent Expense', 'expense', 'rent'],
    ['6040', 'Salaries and Employee Wages', 'expense', 'salaries'],
    ['6050', 'Travel Expense', 'expense', 'travel'],
    ['6060', 'Electricity / Utilities', 'expense', 'utilities'],
    ['6070', 'Telephone Expense', 'expense', 'telephone'],
    ['6080', 'Meals and Entertainment', 'expense', 'meals'],
    ['6090', 'Fuel / Mileage Expenses', 'expense', 'mileage'],
    ['6100', 'Repairs and Maintenance', 'expense', 'repairs'],
    ['6110', 'IT and Internet Expenses', 'expense', 'it_internet'],
    ['6120', 'Consultant Expense', 'expense', 'consultant'],
    ['6130', 'Depreciation Expense', 'expense', 'depreciation'],
    ['6140', 'Bad Debt', 'expense', 'bad_debt'],
    ['6150', 'Inventory Adjustments', 'expense', 'inventory_adjustment'],
    ['6160', 'Purchase Discounts', 'expense', 'purchase_discount'],
    ['6900', 'Uncategorized', 'expense', 'uncategorized'],
    ['6910', 'Other Expenses', 'other_expense', 'other_expenses'],
]


def create_default_accounts(org_id):
    for code, name, typ, sys in DEFAULT_ACCOUNTS:
        insert('accounts', {'org_id': org_id, 'code': code, 'name': name, 'type': typ, 'system_code': sys, 'is_system': 1 if sys else 0})
    insert('accounts', {'org_id': org_id, 'code': '1020', 'name': 'Current Account', 'type': 'bank', 'bank_name': 'HDFC Bank', 'account_number': 'XXXX1234'})


def sys_account(org_id, code):
    """Id of a system account by code, creating it if a module needs one that is missing.
    (Not cached: account ids are per database, and tests/seed recreate databases.)"""
    a = get('SELECT id FROM accounts WHERE org_id = ? AND system_code = ?', org_id, code)
    if not a:
        d = next((d for d in DEFAULT_ACCOUNTS if d[3] == code), None)
        if not d:
            raise bad(f'Unknown system account {code}')
        return insert('accounts', {'org_id': org_id, 'code': d[0], 'name': d[1], 'type': d[2], 'system_code': code, 'is_system': 1})
    return a['id']


def tax_account(org_id, code, side):
    m = ({'cgst': 'output_cgst', 'sgst': 'output_sgst', 'igst': 'output_igst', 'tax': 'tax_payable'} if side == 'sales'
         else {'cgst': 'input_cgst', 'sgst': 'input_sgst', 'igst': 'input_igst', 'tax': 'input_tax'})
    return sys_account(org_id, m.get(code) or m['tax'])


def account_class(typ):
    return ACCOUNT_CLASS.get(typ) or 'expense'


def post(org_id, src_type, src_id, date=None, number=None, contact_id=None, lines=()):
    """Replace all ledger lines of a source. lines: [{account_id, debit, credit, contact_id?, description?}].
    Zero lines are dropped; the posting must balance. Reconciliation marks survive unchanged lines."""
    def _do():
        recon = all('SELECT account_id, debit, credit, date, reconciliation_id FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ? AND reconciliation_id IS NOT NULL',
                    src_type, src_id, org_id)
        before = all('SELECT account_id, debit, credit, date FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ? AND reconciliation_id IS NULL',
                     src_type, src_id, org_id)
        moved = []  # cleared lines that keep their amounts but would change date
        run('DELETE FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ?', src_type, src_id, org_id)
        merged = []
        for l in lines:
            d = round2(l.get('debit') or 0)
            c = round2(l.get('credit') or 0)
            if not d and not c:
                continue
            if not l.get('account_id'):
                raise bad('Posting is missing an account')
            merged.append({**l, 'debit': d, 'credit': c})
        if merged:
            canon_date(date, 'posting date')  # every writer funnels through here, so no odd date string reaches the ledger
        # Every referenced account and contact must belong to the posting org (ids are plain integers in the schema).
        assert_owned(org_id, 'accounts', [l['account_id'] for l in merged], 'account')
        assert_owned(org_id, 'contacts', [l.get('contact_id') for l in merged] + [contact_id], 'contact')
        td = round2(sum_js(l['debit'] for l in merged))
        tc = round2(sum_js(l['credit'] for l in merged))
        if not (math.isfinite(td) and math.isfinite(tc)):
            raise bad('Amounts must be finite numbers')
        if not abs(td - tc) <= 0.01:
            from books.core.jsutil import jsstr  # noqa: PLC0415
            raise bad(f'Unbalanced posting for {src_type} #{src_id}: debit {jsstr(td)} ≠ credit {jsstr(tc)}')
        for l in merged:
            ri = next((i for i, x in enumerate(recon) if x['account_id'] == int(l['account_id'])
                       and abs(x['debit'] - l['debit']) < 0.005 and abs(x['credit'] - l['credit']) < 0.005), -1)
            kept = recon.pop(ri) if ri >= 0 else None
            reconciliation_id = kept['reconciliation_id'] if kept else None
            if kept and kept['date'] != date:
                moved.append(reconciliation_id)
            if not kept:
                same = next((i for i, x in enumerate(before) if x['account_id'] == int(l['account_id']) and x['date'] == date
                             and abs(x['debit'] - l['debit']) < 0.005 and abs(x['credit'] - l['credit']) < 0.005), -1)
                if same >= 0:
                    before.pop(same)  # an unchanged uncleared line is not new
                elif get("SELECT 1 AS ok FROM reconciliations WHERE org_id = ? AND account_id = ? AND status = 'completed' AND end_date >= ? LIMIT 1",
                         org_id, l['account_id'], date):
                    # a completed reconciliation signed off this account's balance up to its end date
                    raise bad(f'{date} falls inside a completed bank reconciliation for this account. Undo the reconciliation or use a later date.')
            cid = l.get('contact_id') if l.get('contact_id') is not None else contact_id
            insert('ledger', {
                'org_id': org_id, 'date': date, 'src_type': src_type, 'src_id': src_id, 'number': number or None,
                'account_id': l['account_id'], 'contact_id': cid, 'debit': l['debit'], 'credit': l['credit'],
                'description': l.get('description') or None, 'reconciliation_id': reconciliation_id,
            })
        # cleared lines this posting would drop, or move out of the reconciled period
        _refuse_completed_reconciliation(org_id, [x['reconciliation_id'] for x in recon] + moved)
        return len(merged)
    return tx(_do)


def account_in_use(org_id, aid):
    """Count every row that refers to the account. Account ids are plain integers, so both account delete routes must
    use this one list; a reference left out here would be orphaned (draft journals, profiles, bank lines...)."""
    return get('''SELECT (SELECT COUNT(*) FROM ledger WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM document_lines dl JOIN documents d ON d.id = dl.document_id WHERE dl.account_id = ? AND d.org_id = ?)
        + (SELECT COUNT(*) FROM documents WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM items WHERE (sales_account_id = ? OR purchase_account_id = ? OR inventory_account_id = ?) AND org_id = ?)
        + (SELECT COUNT(*) FROM accounts WHERE parent_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM fixed_assets WHERE ? IN (asset_account_id, expense_account_id, accumulated_account_id, disposal_account_id) AND org_id = ?)
        + (SELECT COUNT(*) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE jl.account_id = ? AND j.org_id = ?)
        + (SELECT COUNT(*) FROM payments WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM expenses WHERE (account_id = ? OR paid_through_id = ?) AND org_id = ?)
        + (SELECT COUNT(*) FROM refunds WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM bank_statement_lines WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM bank_txns WHERE (account_id = ? OR offset_account_id = ? OR to_account_id = ?) AND org_id = ?)
        + (SELECT COUNT(*) FROM reconciliations WHERE account_id = ? AND org_id = ?)
        + (SELECT COUNT(*) FROM inventory_adjustments WHERE account_id = ? AND org_id = ?) AS n''',
               aid, org_id, aid, org_id, aid, org_id, aid, aid, aid, org_id, aid, org_id, aid, org_id, aid, org_id, aid, org_id,
               aid, aid, org_id, aid, org_id, aid, org_id, aid, aid, aid, org_id, aid, org_id, aid, org_id)['n']


def _refuse_completed_reconciliation(org_id, reconciliation_ids):
    """A line cleared in a completed reconciliation may not change or disappear, whichever module posted it."""
    ids = sorted({i for i in reconciliation_ids if i})
    if not ids:
        return
    r = get(f"SELECT end_date FROM reconciliations WHERE org_id = ? AND status = 'completed' AND id IN ({','.join('?' for _ in ids)}) ORDER BY end_date DESC LIMIT 1",
            org_id, *ids)
    if r:
        raise bad(f"This transaction is part of a completed reconciliation (up to {r['end_date']}). Undo the reconciliation first.")


def unpost(org_id, src_type, src_id):
    cleared = all('SELECT reconciliation_id FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ? AND reconciliation_id IS NOT NULL',
                  src_type, src_id, org_id)
    _refuse_completed_reconciliation(org_id, [x['reconciliation_id'] for x in cleared])
    run('DELETE FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ?', src_type, src_id, org_id)


def assert_source_unlocked(org, src_type, src_id, new_date=None, kind='journal'):
    """Rewriting or removing a posting must respect the transaction lock for its current date and its new date."""
    old = get('SELECT MIN(date) AS d FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ?', src_type, src_id, org['id'])['d']
    for d in (old, new_date):
        if d:
            assert_unlocked(org, d, kind)


def posting_unchanged(org_id, src_type, src_id, date, lines):
    have = all('SELECT date, account_id, debit, credit FROM ledger WHERE src_type = ? AND src_id = ? AND org_id = ?', src_type, src_id, org_id)
    want = sorted((int(l['account_id']), round2(l.get('debit') or 0), round2(l.get('credit') or 0))
                  for l in lines if round2(l.get('debit') or 0) or round2(l.get('credit') or 0))
    return (sorted((r['account_id'], round2(r['debit']), round2(r['credit'])) for r in have) == want
            and {r['date'] for r in have} <= {date})


def repost_opening(org, src_type, src_id, date, lines, **kw):
    """post() for opening entries saved from master-data forms: a no-op when nothing changed (so editing a contact
    or item inside a locked period still works), otherwise the old and new dates must both be unlocked."""
    if posting_unchanged(org['id'], src_type, src_id, date, lines):
        return 0
    assert_source_unlocked(org, src_type, src_id, date)
    return post(org['id'], src_type, src_id, date=date, lines=lines, **kw)


def unpost_opening(org, src_type, src_id):
    assert_source_unlocked(org, src_type, src_id)
    unpost(org['id'], src_type, src_id)


def account_balance(account_id, to_date='9999-12-31', from_date='0000-01-01'):
    r = get('''SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM ledger l JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
               WHERE l.account_id = ? AND l.date >= ? AND l.date <= ?''', account_id, from_date, to_date)
    return round2(r['d'] - r['c'])


def balances_by_account(org_id, to_date='9999-12-31', from_date='0000-01-01'):
    return all('''SELECT a.id, a.code, a.name, a.type, a.parent_id, a.system_code,
        COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
      FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id AND l.org_id = a.org_id AND l.date >= ? AND l.date <= ?
      WHERE a.org_id = ? GROUP BY a.id ORDER BY a.code, a.name''', from_date, to_date, org_id)


# ---------------- inventory ----------------
def avg_cost(item_id, date='9999-12-31', exclude=None):
    """Weighted-average unit cost of an item as of a date, excluding a given (src_type, src_id)."""
    if exclude:
        r = get('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(value),0) v FROM stock_moves WHERE item_id = ? AND date <= ? AND NOT (src_type = ? AND src_id = ?)',
                item_id, date, exclude[0], exclude[1])
    else:
        r = get('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(value),0) v FROM stock_moves WHERE item_id = ? AND date <= ?', item_id, date)
    if r['q'] > 0 and r['v'] > 0:
        return r['v'] / r['q']
    item = get('SELECT purchase_price, opening_stock_rate FROM items WHERE id = ?', item_id)
    return float((item or {}).get('opening_stock_rate') or (item or {}).get('purchase_price') or 0)


def stock_on_hand(item_id, date='9999-12-31'):
    return get('SELECT COALESCE(SUM(qty),0) q FROM stock_moves WHERE item_id = ? AND date <= ?', item_id, date)['q']


def clear_stock(src_type, src_id):
    run('DELETE FROM stock_moves WHERE src_type = ? AND src_id = ?', src_type, src_id)


def add_stock_move(org_id, item_id, date, qty, rate, src_type, src_id):
    insert('stock_moves', {'org_id': org_id, 'item_id': item_id, 'date': date, 'qty': qty, 'rate': round2(rate),
                           'value': round2(qty * rate), 'src_type': src_type, 'src_id': src_id})
