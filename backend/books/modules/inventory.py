"""Inventory: stock adjustments (quantity or value), price lists and the stock card (port of modules/inventory.js).

The JavaScript-semantics helpers at the top of this file (js_number, nz, jstr, js_str, js_round, key_order, date_utc,
sql_num, db_row, body_of, like_pat) are shared by the other modules ported from the same Node sources.
"""
import datetime
import math
import re

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found, HttpError
from books.core.util import audit, assert_unlocked, next_number, org_settings, save_org_settings, today, cap_list
from books.core.auth import perm
from books.core.ledger import post, unpost, sys_account, avg_cost, stock_on_hand, clear_stock, add_stock_move
from books.core.calc import round2, sum_js
from books.core.documents import DOC_TYPES
from books.core.jsutil import truthy, jsstr


# ---------------------------------------------------------------- JS semantics helpers (shared)
_NUM_DEC = re.compile(r'[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)')
_NUM_RADIX = re.compile(r'0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+')
_INDEX_KEY = re.compile(r'0|[1-9][0-9]*')


def js_number(v):
    """JavaScript Number(v). null/undefined -> 0; '' or blank -> 0; unparsable -> NaN."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s == '':
            return 0
        if _NUM_DEC.fullmatch(s):
            f = float(s)
            return int(f) if f.is_integer() else f
        if _NUM_RADIX.fullmatch(s):
            return int(s, 0)
        return math.nan
    if isinstance(v, (list, dict)):
        return js_number(jstr(v))
    return math.nan


def nz(v):
    """`Number(v) || 0`."""
    n = js_number(v)
    return 0 if (n != n or n == 0) else n


def num_or(v, d=0):
    """util.num(v, d): '' / null / NaN -> d."""
    if v is None or (isinstance(v, str) and v == ''):
        return d
    n = js_number(v)
    return d if n != n else n


def jstr(v):
    """JavaScript String(v) for the value kinds that come from JSON bodies and the database."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return jsstr(v)
    if isinstance(v, list):
        return ','.join('' if x is None else jstr(x) for x in v)
    if isinstance(v, dict):
        return '[object Object]'
    return str(v)


def js_str(v):
    """util.js `str(v)`: null -> '', otherwise String(v).trim()."""
    return '' if v is None else jstr(v).strip()


def js_round(x):
    """JavaScript Math.round (ties toward +infinity)."""
    if x != x or x in (math.inf, -math.inf):
        return x
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def round4(x):
    """Math.round((Number(x) || 0) * 1e4) / 1e4."""
    return js_round(nz(x) * 1e4) / 1e4


def key_order(d):
    """Keys of a JS object in iteration order: array-index keys ascending, then the others in insertion order."""
    def is_index(k):
        s = str(k)
        return bool(_INDEX_KEY.fullmatch(s)) and int(s) < 4294967295
    idx = sorted((k for k in d if is_index(k)), key=lambda k: int(str(k)))
    return idx + [k for k in d if not is_index(k)]


def date_utc(y, mon, day):
    """Date.UTC(y, mon, day) as a datetime.date. Month and day overflow like JS (day 0 = last day of the previous
    month); years 0-99 mean 1900+year. Non-finite input raises the same error JS raises from toISOString()."""
    for v in (y, mon, day):
        if v != v or v in (math.inf, -math.inf):
            raise HttpError(500, 'Invalid time value')
    y, mon, day = int(y), int(mon), int(day)
    if 0 <= y <= 99:
        y += 1900
    yy, mm = divmod(y * 12 + mon, 12)
    return datetime.date(yy, mm + 1, 1) + datetime.timedelta(days=day - 1)


def sql_num(v):
    """Number(v) as a SQL parameter: NaN becomes None (matches nothing)."""
    n = js_number(v)
    return None if n != n else n


def db_row(d):
    """Row values for insert/update: NaN is stored as NULL (as SQLite did)."""
    return {k: (None if isinstance(v, float) and v != v else v) for k, v in d.items()}


def body_of(req):
    """req.body as an object (`req.body || {}`; a JSON array has no named fields)."""
    b = req.body
    return b if isinstance(b, dict) else {}


def like_pat(q):
    """'%q%' for LIKE/ILIKE. Backslash is escaped because PostgreSQL's LIKE treats it as an escape character."""
    return '%' + str(q).replace('\\', '\\\\') + '%'


# ---------------------------------------------------------------- schema-level constants
PL_TYPES = ['markup', 'markdown', 'per_item']
PL_ROUNDING = ['none', 'nearest_whole', '.99']


# ---------------------------------------------------------------- stock adjustments
def load_adjustment(org_id, adj_id):
    a = parse_json(get('SELECT * FROM inventory_adjustments WHERE id = ? AND org_id = ?', sql_num(adj_id), org_id), ['lines'])
    if not a:
        raise not_found('Inventory adjustment')
    lines = []
    for l in (a.get('lines') or []):
        it = get('SELECT id, name, sku, unit, track_inventory FROM items WHERE id = ?', l.get('item_id'))
        on_hand = stock_on_hand(it['id']) if it else 0
        unit = round2(avg_cost(it['id'])) if it else 0
        out = dict(l)
        out.update({
            'item_name': it['name'] if it else None,
            'sku': it['sku'] if it else None,
            'unit': it['unit'] if it else None,
            'current_qty': round4(on_hand),
            'current_value': round2(on_hand * unit),
            'unit_cost': l['unit_cost'] if l.get('unit_cost') is not None else unit,
        })
        lines.append(out)
    a['lines'] = lines
    a['account_name'] = (get('SELECT name FROM accounts WHERE id = ?', a['account_id']) or {}).get('name') if a.get('account_id') else None
    return a


def _clean_adjustment(org, body):
    mode = 'value' if body.get('mode') == 'value' else 'quantity'
    date = body.get('date') if truthy(body.get('date')) else today()
    if truthy(body.get('account_id')):
        account_id = sql_num(body.get('account_id'))
    else:
        account_id = sys_account(org['id'], 'inventory_adjustment')
    if not get('SELECT id FROM accounts WHERE id = ? AND org_id = ?', account_id, org['id']):
        raise bad('Invalid adjustment account')
    lines = []
    raw_lines = cap_list(body['lines'], 'lines') if isinstance(body.get('lines'), list) else []
    for l in raw_lines:
        l = l if isinstance(l, dict) else {}
        item_id = nz(l.get('item_id'))
        if not item_id:
            continue
        item = get('SELECT id, name, track_inventory FROM items WHERE id = ? AND org_id = ?', item_id, org['id'])
        if not item:
            raise bad('An item in this adjustment does not exist')
        if not item['track_inventory']:
            raise bad(f"{jstr(item['name'])} does not track inventory. Turn on Track Inventory for it first.")
        name = jstr(item['name'])
        if mode == 'quantity':
            q = js_number(l.get('qty_change'))
            if not q or q != q:
                raise bad(f'Enter a quantity change for {name}')
            lines.append({'item_id': item_id, 'qty_change': round4(q)})
        else:
            raw_nv, raw_vc = l.get('new_value'), l.get('value_change')
            nv = None if (raw_nv is None or raw_nv == '') else js_number(raw_nv)
            vc = None if (raw_vc is None or raw_vc == '') else js_number(raw_vc)
            if nv is None and vc is None:
                raise bad(f'Enter the new value for {name}')
            if (nv is not None and nv != nv) or (vc is not None and vc != vc):
                raise bad(f'Value for {name} must be a number')
            lines.append({'item_id': item_id, 'new_value': nv, 'value_change': vc})
    if not lines:
        raise bad('Add at least one item to adjust')
    return {'mode': mode, 'date': date, 'account_id': account_id, 'lines': lines}


def _apply_adjustment(org, adj):
    """Re-derive the stock moves and ledger postings of an adjustment from scratch; returns the resolved lines."""
    clear_stock('inventory_adjustment', adj['id'])
    unpost(org['id'], 'inventory_adjustment', adj['id'])
    if adj.get('status') != 'adjusted':
        keep = ('item_id', 'qty_change', 'new_value', 'value_change')
        return [{k: l[k] for k in keep if k in l} for l in adj['lines']]
    offset = adj.get('account_id') or sys_account(org['id'], 'inventory_adjustment')
    ledger_lines = []
    resolved = []
    for l in adj['lines']:
        item = get('SELECT * FROM items WHERE id = ? AND org_id = ?', l.get('item_id'), org['id'])
        if not item:
            raise bad('An item in this adjustment no longer exists')
        inv = item['inventory_account_id'] or sys_account(org['id'], 'inventory')
        unit = round2(avg_cost(item['id'], adj['date'], ('inventory_adjustment', adj['id'])))
        qty = 0
        value = 0
        if adj['mode'] == 'quantity':
            qty = round4(l.get('qty_change'))
            on_hand = round4(stock_on_hand(item['id'], adj['date']))
            if on_hand + qty < -0.0001:
                raise bad(f"Not enough stock of {jstr(item['name'])} ({jstr(on_hand)} on hand). "
                          'The adjustment would make it negative.')
            add_stock_move(org['id'], item['id'], adj['date'], qty, unit, 'inventory_adjustment', adj['id'])
            value = round2(qty * unit)
        else:
            if l.get('value_change') is not None:
                value = round2(l['value_change'])
            else:
                value = round2(nz(l.get('new_value')) - round2(stock_on_hand(item['id'], adj['date']) * unit))
            if value:
                insert('stock_moves', {'org_id': org['id'], 'item_id': item['id'], 'date': adj['date'], 'qty': 0, 'rate': 0,
                                       'value': value, 'src_type': 'inventory_adjustment', 'src_id': adj['id']})
        if value > 0:
            ledger_lines.append({'account_id': inv, 'debit': value, 'description': item['name']})
            ledger_lines.append({'account_id': offset, 'credit': value, 'description': item['name']})
        elif value < 0:
            ledger_lines.append({'account_id': offset, 'debit': -value, 'description': item['name']})
            ledger_lines.append({'account_id': inv, 'credit': -value, 'description': item['name']})
        resolved.append({
            'item_id': item['id'], 'item_name': item['name'], 'qty_change': qty, 'unit_cost': unit, 'value_change': value,
            'new_value': l.get('new_value') if adj['mode'] == 'value' else None,
        })
    post(org['id'], 'inventory_adjustment', adj['id'], date=adj['date'], number=adj.get('number'), lines=ledger_lines)
    return resolved


def _next_series(org, key, prefix):
    """Next number from a series that is created on first use (so it never shares the invoice prefix)."""
    s = org_settings(org)
    if not truthy(s['series'].get(key)):
        save_org_settings(org['id'], {'series': {key: {'prefix': prefix, 'next': 1}}})
    return next_number(org['id'], key)


def _save_adjustment(req, body, adj_id=None):
    org = req.org

    def _do():
        existing = load_adjustment(org['id'], adj_id) if adj_id else None
        c = _clean_adjustment(org, body)
        ex_status = (existing or {}).get('status')
        status = 'adjusted' if (body.get('status') == 'adjusted'
                                or (ex_status == 'adjusted' and body.get('status') != 'draft')) else 'draft'
        if status == 'adjusted' or ex_status == 'adjusted':
            assert_unlocked(org, c['date'], 'journal')
            if existing:
                assert_unlocked(org, existing['date'], 'journal')
        number = body.get('number')
        if not truthy(number):
            number = (existing or {}).get('number')
        if not truthy(number):
            number = _next_series(org, 'inventory_adjustment', 'ADJ-')
        fields = {
            'number': number, 'date': c['date'], 'mode': c['mode'], 'reason': js_str(body.get('reason')) or None,
            'account_id': c['account_id'], 'reference': js_str(body.get('reference')) or None,
            'description': js_str(body.get('description')) or None, 'status': status, 'lines': c['lines'],
        }
        aid = adj_id
        if existing:
            update('inventory_adjustments', adj_id, fields)
        else:
            aid = insert('inventory_adjustments', {**fields, 'org_id': org['id']})
        adj = load_adjustment(org['id'], aid)
        update('inventory_adjustments', aid, {'lines': _apply_adjustment(org, adj)})
        audit(req, 'inventory_adjustment', aid, 'updated' if adj_id else 'created', number)
        return load_adjustment(org['id'], aid)
    return tx(_do)


def _list_adjustments(req):
    q = req.query.get('q')
    status = req.query.get('status')
    mode = req.query.get('mode')
    frm = req.query.get('from')
    to = req.query.get('to')
    where = ['a.org_id = ?']
    p = [req.org['id']]
    if status and status != 'all':
        where.append('a.status = ?')
        p.append(status)
    if mode:
        where.append('a.mode = ?')
        p.append(mode)
    if frm:
        where.append('a.date >= ?')
        p.append(frm)
    if to:
        where.append('a.date <= ?')
        p.append(to)
    if q:
        where.append('(a.number ILIKE ? OR a.reference ILIKE ? OR a.reason ILIKE ? OR a.description ILIKE ?)')
        p.extend([like_pat(q)] * 4)
    names = {r['id']: r['name'] for r in all('SELECT id, name FROM items WHERE org_id = ?', req.org['id'])}
    out = []
    for a in all(f"SELECT a.* FROM inventory_adjustments a WHERE {' AND '.join(where)} ORDER BY a.date DESC, a.id DESC", *p):
        parse_json(a, ['lines'])
        lines = a.get('lines') or []
        row = {k: v for k, v in a.items() if k != 'lines'}
        row['item_count'] = len(lines)
        row['item_names'] = ', '.join(n for n in (names.get(l.get('item_id')) for l in lines) if n)
        row['total_value'] = (round2(sum_js(nz(l.get('value_change')) for l in lines))
                              if a.get('status') == 'adjusted' else None)
        out.append(row)
    return out


def _convert_adjustment(req):
    def _do():
        a = load_adjustment(req.org['id'], sql_num(req.params['id']))
        if a['status'] == 'adjusted':
            raise bad('This adjustment is already adjusted')
        assert_unlocked(req.org, a['date'], 'journal')
        update('inventory_adjustments', a['id'], {'status': 'adjusted'})
        adj = load_adjustment(req.org['id'], a['id'])
        update('inventory_adjustments', a['id'], {'lines': _apply_adjustment(req.org, adj)})
        audit(req, 'inventory_adjustment', a['id'], 'adjusted', a.get('number') or '')
        return load_adjustment(req.org['id'], a['id'])
    return tx(_do)


def _delete_adjustment(req):
    def _do():
        a = load_adjustment(req.org['id'], sql_num(req.params['id']))
        if a['status'] == 'adjusted':
            assert_unlocked(req.org, a['date'], 'journal')
        clear_stock('inventory_adjustment', a['id'])
        unpost(req.org['id'], 'inventory_adjustment', a['id'])
        run('DELETE FROM inventory_adjustments WHERE id = ?', a['id'])
        audit(req, 'inventory_adjustment', a['id'], 'deleted', a.get('number') or '')
        return {'ok': True}
    return tx(_do)


def _get_adjustment(req):
    return load_adjustment(req.org['id'], sql_num(req.params['id']))


def _put_adjustment(req):
    pid = nz(req.params['id']) or None
    return _save_adjustment(req, body_of(req), pid)


def _post_adjustment(req):
    return _save_adjustment(req, body_of(req))


# ---------------------------------------------------------------- price lists
def load_price_list(org_id, pid):
    p = parse_json(get('SELECT * FROM price_lists WHERE id = ? AND org_id = ?', sql_num(pid), org_id), ['items'])
    if not p:
        raise not_found('Price list')
    items = p.get('items') or []
    p['items'] = [{'item_id': js_number(x.get('item_id') if isinstance(x, dict) else None),
                   'rate': js_number(x.get('rate') if isinstance(x, dict) else None)} for x in items]
    return p


def _clean_price_list(org, body):
    name = js_str(body.get('name'))
    if not name:
        raise bad('Price list name is required')
    typ = body.get('type') if body.get('type') in PL_TYPES else 'per_item'
    rounding = body.get('rounding') if body.get('rounding') in PL_ROUNDING else 'none'
    items = []
    raw_items = cap_list(body['items'], 'price list items', 5000) if isinstance(body.get('items'), list) else []
    for x in raw_items:
        x = x if isinstance(x, dict) else {}
        item_id = nz(x.get('item_id'))
        raw_rate = x.get('rate')
        if not item_id or raw_rate == '' or raw_rate is None:
            continue
        rate = js_number(raw_rate)
        if rate != rate or rate < 0:
            raise bad('Rates must be zero or more')
        items.append({'item_id': item_id, 'rate': round2(rate)})
    raw_pct = body.get('percentage')
    if typ != 'per_item' and (raw_pct == '' or raw_pct is None or js_number(raw_pct) != js_number(raw_pct)):
        raise bad('Enter a percentage for this price list')
    is_false = body.get('is_active') is False or (
        not isinstance(body.get('is_active'), bool) and isinstance(body.get('is_active'), (int, float))
        and body.get('is_active') == 0)
    return {
        'name': name,
        'description': js_str(body.get('description')) or None,
        'applies_to': 'purchase' if body.get('applies_to') == 'purchase' else 'sales',
        'type': typ,
        'percentage': 0 if typ == 'per_item' else num_or(raw_pct, 0),
        'rounding': rounding,
        'items': items,
        'currency': js_str(body.get('currency')) or org.get('currency'),
        'is_active': 0 if is_false else 1,
    }


def apply_rounding(x, mode):
    """Rounding applies to percentage-based rates only; per-item rates are stored exactly."""
    if mode == 'nearest_whole':
        return js_round(x)
    if mode == '.99':
        return max(0.99, js_round(x - 0.99) + 0.99)
    return x


def price_for(org, pl, item_id):
    """Rate of an item under a price list."""
    item = get('SELECT * FROM items WHERE id = ? AND org_id = ?', sql_num(item_id), org['id'])
    if not item:
        raise not_found('Item')
    base = nz(item['purchase_price'] if pl.get('applies_to') == 'purchase' else item['selling_price'])
    if pl.get('type') == 'per_item':
        want = js_number(item_id)
        found = next((x for x in (pl.get('items') or []) if x['item_id'] == want), None)
        return {'item_id': item['id'], 'rate': round2(found['rate']) if found else round2(base),
                'base': round2(base), 'in_list': bool(found)}
    pct = nz(pl.get('percentage'))
    raw = base * (1 - pct / 100) if pl.get('type') == 'markdown' else base * (1 + pct / 100)
    return {'item_id': item['id'], 'rate': round2(apply_rounding(raw, pl.get('rounding'))), 'base': round2(base), 'in_list': True}


def _list_price_lists(req):
    q = req.query.get('q')
    applies_to = req.query.get('applies_to')
    where = ['p.org_id = ?']
    pr = [req.org['id']]
    if applies_to:
        where.append('p.applies_to = ?')
        pr.append(applies_to)
    if q:
        where.append('p.name ILIKE ?')
        pr.append(like_pat(q))
    out = []
    for p in all(f"SELECT p.* FROM price_lists p WHERE {' AND '.join(where)} ORDER BY lower(p.name), p.id", *pr):
        parse_json(p, ['items'])
        row = {k: v for k, v in p.items() if k != 'items'}
        row['item_count'] = len(p.get('items') or [])
        out.append(row)
    return out


def _get_price_list(req):
    return load_price_list(req.org['id'], sql_num(req.params['id']))


def _price_rate(req):
    pl = load_price_list(req.org['id'], sql_num(req.params['id']))
    if not req.query.get('item_id'):
        raise bad('item_id is required')
    return price_for(req.org, pl, js_number(req.query.get('item_id')))


def _create_price_list(req):
    def _do():
        o = _clean_price_list(req.org, body_of(req))
        pid = insert('price_lists', {**o, 'org_id': req.org['id']})
        audit(req, 'price_list', pid, 'created', o['name'])
        return load_price_list(req.org['id'], pid)
    return tx(_do)


def _update_price_list(req):
    def _do():
        cur = load_price_list(req.org['id'], sql_num(req.params['id']))
        o = _clean_price_list(req.org, body_of(req))
        update('price_lists', cur['id'], o)
        audit(req, 'price_list', cur['id'], 'updated', o['name'])
        return load_price_list(req.org['id'], cur['id'])
    return tx(_do)


def _delete_price_list(req):
    def _do():
        cur = load_price_list(req.org['id'], sql_num(req.params['id']))
        run('UPDATE contacts SET price_list_id = NULL WHERE price_list_id = ? AND org_id = ?', cur['id'], req.org['id'])
        run('DELETE FROM price_lists WHERE id = ?', cur['id'])
        audit(req, 'price_list', cur['id'], 'deleted', cur['name'])
        return {'ok': True}
    return tx(_do)


# ---------------------------------------------------------------- stock card
def _source_label(l):
    if l['src_type'] in DOC_TYPES:
        return DOC_TYPES[l['src_type']]['label']
    return {'item_opening': 'Opening Stock', 'inventory_adjustment': 'Inventory Adjustment'}.get(l['src_type']) or l['src_type']


def _source_number(l):
    if l['src_type'] in DOC_TYPES:
        return (get('SELECT number FROM documents WHERE id = ?', l['src_id']) or {}).get('number') or ''
    if l['src_type'] == 'inventory_adjustment':
        return (get('SELECT number FROM inventory_adjustments WHERE id = ?', l['src_id']) or {}).get('number') or ''
    if l['src_type'] == 'item_opening':
        return 'Opening Stock'
    return ''


def _stock_card(req):
    item_id = nz(req.query.get('item_id'))
    if not item_id:
        raise bad('item_id is required')
    item = get('SELECT * FROM items WHERE id = ? AND org_id = ?', item_id, req.org['id'])
    if not item:
        raise not_found('Item')
    q = 0
    v = 0
    rows = []
    for m in all('SELECT * FROM stock_moves WHERE item_id = ? ORDER BY date, id', item['id']):
        q = round4(q + m['qty'])
        v = round2(v + m['value'])
        rows.append({
            'date': m['date'], 'src_type': m['src_type'], 'src_id': m['src_id'], 'type': _source_label(m),
            'number': _source_number(m), 'qty': round4(m['qty']), 'rate': round2(m['rate']), 'value': round2(m['value']),
            'running_qty': q, 'running_value': v, 'running_avg': round2(v / q) if q > 0 else 0,
        })
    return {
        'item': {'id': item['id'], 'name': item['name'], 'sku': item['sku'], 'unit': item['unit'],
                 'track_inventory': bool(item['track_inventory']), 'reorder_level': item['reorder_level']},
        'rows': rows, 'stock_on_hand': q, 'stock_value': v,
        'avg_cost': round2(v / q) if q > 0 else round2(avg_cost(item['id'])),
    }


def routes(r):
    # ---------- stock adjustments ----------
    r.get('/inventory/adjustments', perm('items', 'view'), _list_adjustments)
    r.get('/inventory/adjustments/:id', perm('items', 'view'), _get_adjustment)
    r.post('/inventory/adjustments', perm('items', 'create'), _post_adjustment)
    r.put('/inventory/adjustments/:id', perm('items', 'edit'), _put_adjustment)
    # draft -> adjusted: posts the stock moves and the ledger entry
    r.post('/inventory/adjustments/:id/convert', perm('items', 'edit'), _convert_adjustment)
    r.delete('/inventory/adjustments/:id', perm('items', 'delete'), _delete_adjustment)
    # ---------- price lists ----------
    r.get('/price-lists', perm('items', 'view'), _list_price_lists)
    r.get('/price-lists/:id', perm('items', 'view'), _get_price_list)
    r.get('/price-lists/:id/rate', perm('items', 'view'), _price_rate)
    r.post('/price-lists', perm('items', 'create'), _create_price_list)
    r.put('/price-lists/:id', perm('items', 'edit'), _update_price_list)
    r.delete('/price-lists/:id', perm('items', 'delete'), _delete_price_list)
    # ---------- stock card ----------
    r.get('/inventory/stock', perm('items', 'view'), _stock_card)
