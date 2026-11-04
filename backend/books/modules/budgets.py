"""Budgets: per-account amounts by month, quarter or year, with a budget-vs-actual view computed from the ledger
(port of modules/budgets.js)."""
from books.core.db import all, get, insert, update, run, parse_json
from books.core.router import bad, not_found
from books.core.util import audit
from books.core.auth import perm
from books.core.ledger import account_class
from books.core.calc import round2, sum_js
from books.core.jsutil import truthy
from books.modules.inventory import js_number, nz, jstr, sql_num, key_order, date_utc, body_of

PERIODS = {'monthly': {'count': 12, 'months': 1}, 'quarterly': {'count': 4, 'months': 3}, 'yearly': {'count': 1, 'months': 12}}
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def budget_periods(fiscal_year, period, start_month=4):
    """Date ranges of each budget period. start_month is the org's fiscal_year_start (1-12)."""
    spec = PERIODS.get(period) or PERIODS['monthly']
    m0 = (nz(start_month) or 4) - 1
    out = []
    for i in range(spec['count']):
        s = date_utc(fiscal_year, m0 + i * spec['months'], 1)
        e = date_utc(fiscal_year, m0 + (i + 1) * spec['months'], 0)
        if period == 'monthly':
            label = f'{MON[s.month - 1]} {s.year}'
        elif period == 'quarterly':
            label = f'Q{i + 1} ({MON[s.month - 1]}–{MON[e.month - 1]} {e.year})'
        else:
            label = f'FY {fiscal_year}–{str(fiscal_year + 1)[-2:]}'
        out.append({'index': i, 'label': label, 'start': s.isoformat(), 'end': e.isoformat()})
    return out


def _clean_lines(org_id, raw, count):
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise bad('Budget lines must be keyed by account')
    out = {}
    for k in key_order(raw):
        arr = raw[k]
        aid = js_number(k)
        if not get('SELECT id FROM accounts WHERE id = ? AND org_id = ?', sql_num(aid), org_id):
            raise bad(f'Invalid account {k} in budget')
        amounts = arr if isinstance(arr, list) else []
        out[aid] = [round2(nz(amounts[i]) if i < len(amounts) else 0) for i in range(count)]
    # JS objects iterate integer keys in ascending order
    return {k: out[k] for k in sorted(out)}


def _is_int(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and float(v).is_integer()


def _budget_fields(org_id, body, existing):
    if 'name' in body:
        v = body['name']
        name = (jstr(v) if truthy(v) else '').strip()
    else:
        name = existing.get('name') if existing else None
    if not truthy(name):
        raise bad('Budget name is required')
    fy_raw = body.get('fiscal_year')
    if fy_raw is None:
        fy_raw = existing.get('fiscal_year') if existing else None
    fy = js_number(fy_raw)
    if not _is_int(fy) or fy < 1900 or fy > 2200:
        raise bad('Enter a valid fiscal year (its start year)')
    period = body.get('period')
    if period is None:
        period = existing.get('period') if existing else None
    if period is None:
        period = 'monthly'
    if not (isinstance(period, str) and period in PERIODS):
        raise bad('Period must be monthly, quarterly or yearly')
    raw_lines = body['lines'] if 'lines' in body else (existing.get('lines') if existing else None)
    lines = _clean_lines(org_id, raw_lines, PERIODS[period]['count'])
    return {'name': name, 'fiscal_year': int(fy), 'period': period, 'lines': lines}


def load_budget(org_id, bid):
    b = parse_json(get('SELECT * FROM budgets WHERE id = ? AND org_id = ?', sql_num(bid), org_id), ['lines'])
    if not b:
        raise not_found('Budget')
    if not truthy(b.get('lines')):
        b['lines'] = {}
    return b


def _cell(index, budget, actual):
    return {
        'index': index, 'budget': budget, 'actual': actual, 'variance': round2(actual - budget),
        'variance_pct': round2(((actual - budget) / abs(budget)) * 100) if budget else None,
    }


def _sum_cells(cells):
    budget = round2(sum_js(c['budget'] for c in cells))
    actual = round2(sum_js(c['actual'] for c in cells))
    return _cell(None, budget, actual)


def _at(arr, i):
    return arr[i] if isinstance(arr, list) and i < len(arr) else None


def budget_vs_actual(org, b):
    """Budget vs actual per budgeted account and period. Income = credit - debit, expense = debit - credit."""
    start_month = org.get('fiscal_year_start') or 4
    periods = budget_periods(b['fiscal_year'], b['period'], start_month)
    rows = []
    lines = b.get('lines') or {}
    for key in key_order(lines):
        amounts = lines[key]
        acc = get('SELECT id, code, name, type FROM accounts WHERE id = ? AND org_id = ?', sql_num(js_number(key)), org['id'])
        if not acc:
            continue
        cls = account_class(acc['type'])
        cells = []
        for p in periods:
            r = get('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ledger WHERE org_id = ? AND account_id = ? AND date >= ? AND date <= ?',
                    org['id'], acc['id'], p['start'], p['end'])
            actual = round2((r['d'] - r['c']) if cls in ('asset', 'expense') else (r['c'] - r['d']))
            cells.append(_cell(p['index'], round2(nz(_at(amounts, p['index']))), actual))
        rows.append({'account_id': acc['id'], 'code': acc['code'], 'name': acc['name'], 'type': acc['type'], 'class': cls,
                     'periods': cells, 'total': _sum_cells(cells)})
    totals = {}
    for cls in dict.fromkeys(r['class'] for r in rows):
        in_class = [r for r in rows if r['class'] == cls]
        totals[cls] = {
            'periods': [{**_sum_cells([r['periods'][i] for r in in_class]), 'index': p['index']} for i, p in enumerate(periods)],
            'total': _sum_cells([r['total'] for r in in_class]),
        }
    return {'periods': periods, 'rows': rows, 'totals': totals}


def _list(req):
    out = []
    for b in all('SELECT * FROM budgets WHERE org_id = ? ORDER BY fiscal_year DESC, id DESC', req.org['id']):
        parse_json(b, ['lines'])
        lines = b.get('lines') or {}
        b['account_count'] = len(lines)
        flat = []
        for k in key_order(lines):
            v = lines[k]
            if isinstance(v, list):
                flat.extend(v)
            else:
                flat.append(v)
        b['total_budget'] = round2(sum_js(nz(v) for v in flat))
        out.append(b)
    return out


def _get(req):
    return load_budget(req.org['id'], sql_num(req.params['id']))


def _vs_actual(req):
    b = load_budget(req.org['id'], sql_num(req.params['id']))
    return {'budget': b, **budget_vs_actual(req.org, b)}


def _create(req):
    f = _budget_fields(req.org['id'], body_of(req), None)
    bid = insert('budgets', {**f, 'org_id': req.org['id']})
    audit(req, 'budget', bid, 'created', f['name'])
    return load_budget(req.org['id'], bid)


def _update(req):
    b = load_budget(req.org['id'], sql_num(req.params['id']))
    f = _budget_fields(req.org['id'], body_of(req), b)
    update('budgets', b['id'], f)
    audit(req, 'budget', b['id'], 'updated', f['name'])
    return load_budget(req.org['id'], b['id'])


def _delete(req):
    b = load_budget(req.org['id'], sql_num(req.params['id']))
    run('DELETE FROM budgets WHERE id = ?', b['id'])
    audit(req, 'budget', b['id'], 'deleted', b['name'])
    return {'ok': True}


def routes(r):
    r.get('/budgets', perm('accountant', 'view'), _list)
    r.get('/budgets/:id', perm('accountant', 'view'), _get)
    r.get('/budgets/:id/vs-actual', perm('accountant', 'view'), _vs_actual)
    r.post('/budgets', perm('accountant', 'create'), _create)
    r.put('/budgets/:id', perm('accountant', 'edit'), _update)
    r.delete('/budgets/:id', perm('accountant', 'delete'), _delete)
