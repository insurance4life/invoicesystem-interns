"""'Ask' assistant: a small rule-based natural-language helper over the org's books (port of modules/assistant.js)."""
import datetime
import re

from books.core.db import all, get, insert
from books.core.router import bad, rate_limit
from books.core.util import round2, today, token, audit
from books.core.auth import can
from books.core.ledger import sys_account, account_balance
from books.core.documents import display_status
from books.core.calc import sum_js


def _month_range(offset=0):
    d = datetime.datetime.now()
    y, m = d.year, d.month - 1 + offset
    y += m // 12
    m %= 12
    s = datetime.date(y, m + 1, 1)
    e = datetime.date(y + (m + 1) // 12, (m + 1) % 12 + 1, 1) - datetime.timedelta(days=1)
    return [s.isoformat(), e.isoformat()]


def _fy_range(org):
    d = datetime.datetime.now()
    fs = org.get('fiscal_year_start') or 4
    y = d.year if d.month >= fs else d.year - 1
    start = datetime.date(y, fs, 1)
    end = datetime.date(y + 1, fs, 1) - datetime.timedelta(days=1)
    return [start.isoformat(), end.isoformat()]


def _period(q, org):
    if re.search(r'last month', q):
        return [*_month_range(-1), 'last month']
    if re.search(r'this year|fiscal|fy|year to date|ytd', q):
        return [*_fy_range(org), 'this fiscal year']
    if re.search(r'today', q):
        return [today(), today(), 'today']
    return [*_month_range(0), 'this month']


def _fmt(org, v):
    n = float(v or 0)
    neg = n < 0
    n = abs(n)
    whole, frac = f'{n:.2f}'.split('.')
    # en-IN grouping: last 3 digits, then groups of 2
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ','.join(groups + [tail])
    return f"{org['currency']} {'-' if neg else ''}{whole}.{frac}"


SUGGESTIONS = ['How many invoices are overdue?', 'What are my total receivables?', 'Cash and bank balance', 'Sales this month', 'Expenses last month',
               'Top customers this year', 'Unpaid bills', 'Customers who pay late', 'Create customer Nova Labs', 'Low stock items']


def routes(r):
    r.get('/assistant/suggestions', lambda req: SUGGESTIONS)

    def ask(req):  # noqa: C901
        org = req.org
        raw = str(req.body.get('q') or '').strip()
        if not raw:
            raise bad('Ask me something')
        q = raw.lower()

        def reply(text, **extra):
            return {'q': raw, 'text': text, **extra}

        m = re.match(r'^(?:create|add|new)\s+(customer|vendor)\s+(?:named\s+|called\s+)?["\']?(.+?)["\']?$', raw, re.IGNORECASE)
        if m:
            typ = m.group(1).lower()
            if not can(req, 'contacts', 'create'):
                return reply("You don't have permission to create contacts.")
            name = m.group(2).strip()
            if get('SELECT id FROM contacts WHERE org_id = ? AND type = ? AND lower(display_name) = lower(?)', org['id'], typ, name):
                return reply(f'A {typ} named "{name}" already exists.')
            cid = insert('contacts', {'org_id': org['id'], 'type': typ, 'display_name': name, 'company_name': name, 'currency': org['currency'], 'portal_token': token(18)})
            audit(req, 'contact', cid, 'created', f'{name} (via assistant)')
            return reply(f'Created {typ} "{name}".', link={'label': f'Open {name}', 'url': f"/{'customers' if typ == 'customer' else 'vendors'}/{cid}"})

        # every other answer summarizes report data (balances, income, receivables, overdue invoices, stock)
        if not can(req, 'reports', 'view'):
            return reply("You don't have access to reports, so I can't answer questions about the books.")
        rate_limit(('assistant', req.user['id']), 30, 60, 'Too many questions in a minute. Try again shortly.')

        def denied(module):
            return None if can(req, module, 'view') else reply(f"You don't have access to {module}, so I can't answer that.")

        if re.search(r'overdue|late', q) and re.search(r'invoice|customer|pay', q):
            if denied('sales'):
                return denied('sales')
            rows = all('''SELECT d.id, d.number, d.due_date, d.balance, d.total, d.status, d.doc_type, c.display_name FROM documents d JOIN contacts c ON c.id = d.contact_id
                          WHERE d.org_id = ? AND d.doc_type = 'invoice' AND d.status = 'open' AND d.balance > 0 AND d.due_date < ? ORDER BY d.due_date, d.id''', org['id'], today())
            if re.search(r'customer', q):
                by = {}
                for x in rows:
                    e = by.setdefault(x['display_name'], {'name': x['display_name'], 'count': 0, 'amount': 0})
                    e['count'] += 1
                    e['amount'] = round2(e['amount'] + x['balance'])
                lst = sorted(by.values(), key=lambda e: -e['amount'])
                return reply(f'{len(lst)} customer(s) have overdue invoices:' if lst else 'No customers have overdue invoices. 🎉',
                             table=[[x['name'], f"{x['count']} invoice(s)", _fmt(org, x['amount'])] for x in lst])
            total = round2(sum_js(x['balance'] for x in rows))
            return reply(f'{len(rows)} invoice(s) are overdue, totalling {_fmt(org, total)}.' if rows else 'No invoices are overdue. 🎉',
                         table=[[x['number'], x['display_name'], f"due {x['due_date']}", _fmt(org, x['balance'])] for x in rows[:10]],
                         link={'label': 'View overdue invoices', 'url': '/invoices?status=overdue'})
        if re.search(r'receivable|owed to me|customers owe', q):
            if denied('sales'):
                return denied('sales')
            ar = account_balance(sys_account(org['id'], 'ar'))
            od = get("SELECT COALESCE(SUM(balance),0) s FROM documents WHERE org_id = ? AND doc_type = 'invoice' AND status = 'open' AND due_date < ?", org['id'], today())['s']
            return reply(f'Total receivables are {_fmt(org, ar)} ({_fmt(org, od)} overdue).', link={'label': 'AR aging report', 'url': '/reports/ar-aging-summary'})
        if re.search(r'payable|i owe|unpaid bill|bills due', q):
            if denied('purchases'):
                return denied('purchases')
            ap = -account_balance(sys_account(org['id'], 'ap'))
            rows = all('''SELECT d.number, d.due_date, d.balance, c.display_name FROM documents d JOIN contacts c ON c.id = d.contact_id
                          WHERE d.org_id = ? AND d.doc_type = 'bill' AND d.status = 'open' AND d.balance > 0 ORDER BY d.due_date, d.id LIMIT 10''', org['id'])
            return reply(f'You owe vendors {_fmt(org, ap)} across {len(rows)} unpaid bill(s).',
                         table=[[x['number'], x['display_name'], f"due {x['due_date']}", _fmt(org, x['balance'])] for x in rows],
                         link={'label': 'View bills', 'url': '/bills?status=unpaid'})
        if re.search(r'cash|bank|balance', q):
            if denied('banking'):
                return denied('banking')
            rows = all('''SELECT a.name, COALESCE(SUM(l.debit - l.credit),0) b FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id AND l.org_id = a.org_id
                          WHERE a.org_id = ? AND a.type IN ('cash','bank','credit_card') AND a.is_active = 1 GROUP BY a.id ORDER BY a.id''', org['id'])
            total = round2(sum_js(x['b'] for x in rows))
            return reply(f'Your cash and bank balance is {_fmt(org, total)}.', table=[[x['name'], _fmt(org, x['b'])] for x in rows],
                         link={'label': 'Open Banking', 'url': '/banking'})
        if re.search(r'sale|revenue|income', q) and not re.search(r'top', q):
            frm, to, label = _period(q, org)
            v = get('''SELECT COALESCE(SUM(l.credit - l.debit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
                       WHERE l.org_id = ? AND a.type IN ('income','other_income') AND l.date BETWEEN ? AND ?''', org['id'], frm, to)['s']
            n = get("SELECT COUNT(*) n FROM documents WHERE org_id = ? AND doc_type = 'invoice' AND status = 'open' AND date BETWEEN ? AND ?", org['id'], frm, to)['n']
            return reply(f'Income {label} is {_fmt(org, v)} from {n} invoice(s).', link={'label': 'Profit and Loss', 'url': f'/reports/profit-loss?from={frm}&to={to}'})
        if re.search(r'expense|spend|spent', q):
            frm, to, label = _period(q, org)
            rows = all('''SELECT a.name, COALESCE(SUM(l.debit - l.credit),0) s FROM ledger l JOIN accounts a ON a.id = l.account_id
                          WHERE l.org_id = ? AND a.type IN ('expense','cost_of_goods_sold','other_expense') AND l.date BETWEEN ? AND ? GROUP BY a.id ORDER BY s DESC, a.id''',
                       org['id'], frm, to)
            total = round2(sum_js(x['s'] for x in rows))
            return reply(f'Expenses {label} total {_fmt(org, total)}.', table=[[x['name'], _fmt(org, x['s'])] for x in rows[:8]])
        if re.search(r'top (customer|client)', q):
            if denied('sales'):
                return denied('sales')
            frm, to, label = _period(q if 'month' in q else f'{q} this year', org)
            rows = all('''SELECT c.display_name, SUM(d.total * d.exchange_rate) s FROM documents d JOIN contacts c ON c.id = d.contact_id
                          WHERE d.org_id = ? AND d.doc_type = 'invoice' AND d.status = 'open' AND d.date BETWEEN ? AND ? GROUP BY c.id ORDER BY s DESC, c.id LIMIT 5''',
                       org['id'], frm, to)
            return reply(f'Top customers {label}:', table=[[x['display_name'], _fmt(org, x['s'])] for x in rows])
        if re.search(r'low stock|reorder|out of stock', q):
            if denied('items'):
                return denied('items')
            rows = [x for x in all('SELECT i.id, i.name, i.reorder_level, (SELECT COALESCE(SUM(qty),0) FROM stock_moves s WHERE s.item_id = i.id) q FROM items i WHERE i.org_id = ? AND i.track_inventory = 1 ORDER BY i.id', org['id'])
                    if x['q'] <= (x['reorder_level'] or 0)]
            from books.core.jsutil import jsstr  # noqa: PLC0415
            return reply(f'{len(rows)} item(s) are at or below their reorder level.' if rows else 'All tracked items are above their reorder levels.',
                         table=[[x['name'], f"on hand {jsstr(x['q'])}", f"reorder at {jsstr(x['reorder_level'])}"] for x in rows[:10]])
        if re.search(r'draft', q):
            rows = all("SELECT doc_type, COUNT(*) n FROM documents WHERE org_id = ? AND status = 'draft' GROUP BY doc_type ORDER BY MIN(id)", org['id'])
            return reply('Draft documents:' if rows else 'You have no drafts.', table=[[x['doc_type'], x['n']] for x in rows])
        if re.search(r'unpaid|outstanding', q) and re.search(r'invoice', q):
            if denied('sales'):
                return denied('sales')
            rows = all('''SELECT number, doc_type, status, balance, total, due_date, exchange_rate FROM documents
                          WHERE org_id = ? AND doc_type = 'invoice' AND status = 'open' AND balance > 0 ORDER BY date, id''', org['id'])
            return reply(f"{len(rows)} unpaid invoice(s), {_fmt(org, sum_js(x['balance'] * x['exchange_rate'] for x in rows))} outstanding.",
                         table=[[x['number'], display_status(x), _fmt(org, x['balance'])] for x in rows[:10]],
                         link={'label': 'Unpaid invoices', 'url': '/invoices?status=unpaid'})
        return reply("I can answer questions about receivables, payables, overdue invoices, sales, expenses, cash, top customers and stock, or create a customer/vendor. Try one of these:",
                     suggestions=SUGGESTIONS)
    r.post('/assistant', ask)
