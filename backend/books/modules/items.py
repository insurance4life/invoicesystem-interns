"""Items (goods & services) with opening stock and stock on hand (port of modules/items.js)."""
import json

from books.core.db import all, get, insert, update, run, tx, parse_json
from books.core.router import bad, not_found
from books.core.util import audit, round2, today, org_settings, assert_owned, assert_unlocked, like_pattern, clean_custom_fields
from books.core.auth import perm, can
from books.core.calc import ACCOUNT_CLASS
from books.core.documents import DOC_TYPES
from books.core.jsutil import to_int, truthy
from books.core.ledger import (post, unpost, sys_account, clear_stock, add_stock_move, stock_on_hand, avg_cost, assert_source_unlocked,
                               posting_unchanged)

FIELDS = ['type', 'name', 'sku', 'unit', 'hsn_sac', 'description', 'selling_price', 'sales_account_id', 'tax_id', 'purchase_price',
          'purchase_account_id', 'purchase_description', 'purchase_tax_id', 'track_inventory', 'inventory_account_id', 'opening_stock',
          'opening_stock_rate', 'reorder_level', 'is_sellable', 'is_purchasable', 'image', 'custom_fields', 'is_active']


def post_opening_stock(org, item):
    """(Re)write the item's opening stock move and posting. Unchanged openings are left alone, so editing an item
    whose opening date is locked still works; a real change needs both the old and the new date unlocked."""
    active = bool(item.get('track_inventory')) and (item.get('opening_stock') or 0) > 0
    settings = org_settings(org)
    date = settings['preferences'].get('inventory_start_date') or (item.get('created_at') or '')[:10] or today()
    rate = (item.get('opening_stock_rate') or item.get('purchase_price') or 0) if active else 0
    value = round2(item['opening_stock'] * rate) if active else 0
    lines = [
        {'account_id': item.get('inventory_account_id') or sys_account(org['id'], 'inventory'), 'debit': value, 'description': f"Opening stock {item['name']}"},
        {'account_id': sys_account(org['id'], 'opening_balance_offset'), 'credit': value},
    ] if value else []
    moves = all("SELECT date, qty, rate FROM stock_moves WHERE src_type = 'item_opening' AND src_id = ?", item['id'])
    want_moves = [(date, item['opening_stock'], round2(rate))] if active else []
    if [(m['date'], m['qty'], m['rate']) for m in moves] == want_moves and posting_unchanged(org['id'], 'item_opening', item['id'], date, lines):
        return
    old_move = moves[0]['date'] if moves else None
    for d in (old_move, date if active else None):
        if d:
            assert_unlocked(org, d, 'journal')
    assert_source_unlocked(org, 'item_opening', item['id'])
    clear_stock('item_opening', item['id'])
    unpost(org['id'], 'item_opening', item['id'])
    if not active:
        return
    add_stock_move(org['id'], item['id'], date, item['opening_stock'], rate, 'item_opening', item['id'])
    if value:
        post(org['id'], 'item_opening', item['id'], date=date, number='Opening Stock', lines=lines)


def load_item(org_id, id):  # noqa: A002
    i = parse_json(get('SELECT * FROM items WHERE id = ? AND org_id = ?', id, org_id), ['custom_fields'])
    if not i:
        raise not_found('Item')
    if i.get('track_inventory'):
        i['stock_on_hand'] = stock_on_hand(i['id'])
        i['avg_cost'] = round2(avg_cost(i['id']))
        i['stock_value'] = round2(i['stock_on_hand'] * i['avg_cost'])
        i['committed'] = get('''SELECT COALESCE(SUM(l.quantity),0) q FROM document_lines l JOIN documents d ON d.id = l.document_id
                               WHERE l.item_id = ? AND d.doc_type = 'salesorder' AND d.status = 'open' ''', i['id'])['q']
    return i


def _clean(body, org, is_new):
    o = {}
    for f in FIELDS:
        if f in body:
            o[f] = None if body[f] == '' else body[f]
    if 'custom_fields' in o:
        o['custom_fields'] = clean_custom_fields(o['custom_fields'])
    if is_new:
        if o.get('sales_account_id') is None:
            o['sales_account_id'] = sys_account(org['id'], 'sales')
        if o.get('purchase_account_id') is None:
            o['purchase_account_id'] = sys_account(org['id'], 'cogs')
        if truthy(o.get('track_inventory')) and o.get('inventory_account_id') is None:
            o['inventory_account_id'] = sys_account(org['id'], 'inventory')
    if o.get('type') == 'service':
        o['track_inventory'] = 0
    assert_owned(org['id'], 'accounts', [o.get('sales_account_id'), o.get('purchase_account_id'), o.get('inventory_account_id')], 'account')
    # Opening stock and adjustments debit this account, so an items-only role must not be able to point it at a
    # bank, income or liability account (posting there is accountant work).
    if o.get('inventory_account_id') is not None and not get("SELECT id FROM accounts WHERE id = ? AND org_id = ? AND type = 'stock'",
                                                             o['inventory_account_id'], org['id']):
        raise bad('The inventory account must be a Stock account')
    # Invoice and bill lines post to these accounts, so an items role must not aim them at bank, equity or liabilities.
    for key, ok, label in (('sales_account_id', ('income',), 'an income'), ('purchase_account_id', ('expense', 'asset_stock'), 'an expense, cost or stock')):
        if o.get(key) is None:
            continue
        a = get('SELECT type FROM accounts WHERE id = ? AND org_id = ?', o[key], org['id'])
        cls = 'asset_stock' if a and a['type'] == 'stock' else ACCOUNT_CLASS.get((a or {}).get('type'))
        if cls not in ok:
            raise bad(f"The {'sales' if key == 'sales_account_id' else 'purchase'} account must be {label} account")
    return o


def routes(r):
    def list_items(req):
        q = req.query
        status = q.get('status') or 'active'
        where = ['i.org_id = ?']
        p = [req.org['id']]
        if status == 'active':
            where.append('i.is_active = 1')
        if status == 'inactive':
            where.append('i.is_active = 0')
        if status == 'low_stock':
            where.append('i.track_inventory = 1')
        if q.get('type'):
            where.append('i.type = ?')
            p.append(q['type'])
        if q.get('sellable'):
            where.append('i.is_sellable = 1')
        if q.get('purchasable'):
            where.append('i.is_purchasable = 1')
        pat = like_pattern(q.get('q'))
        if pat:
            where.append('(i.name ILIKE ? OR i.sku ILIKE ? OR i.description ILIKE ? OR i.hsn_sac ILIKE ?)')
            p += [pat] * 4
        rows = all(f'''SELECT i.*, (SELECT COALESCE(SUM(qty),0) FROM stock_moves s WHERE s.item_id = i.id) AS stock_on_hand
                       FROM items i WHERE {' AND '.join(where)} ORDER BY lower(i.name), i.id''', *p)
        if status == 'low_stock':
            rows = [x for x in rows if x['stock_on_hand'] <= (x['reorder_level'] or 0)]
        return rows
    r.get('/items', perm('items', 'view'), list_items)

    def get_item(req):
        i = load_item(req.org['id'], to_int(req.params['id']))
        # items:view opens the item; each document line also needs the view right of its sales or purchases side.
        sales, purchases = can(req, 'sales', 'view'), can(req, 'purchases', 'view')
        types = [t for t, d in DOC_TYPES.items() if (sales if d.get('side') == 'sales' else purchases)]
        i['transactions'] = all(f'''SELECT d.id, d.doc_type, d.number, d.date, c.display_name AS contact_name, l.quantity, l.rate, l.amount, d.status
                                  FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN contacts c ON c.id = d.contact_id
                                  WHERE l.item_id = ? AND d.org_id = ? AND d.doc_type IN ({','.join('?' * len(types))})
                                  ORDER BY d.date DESC, d.id, l.id LIMIT 100''', i['id'], req.org['id'], *types) if types else []
        i['stock_moves'] = all('SELECT * FROM stock_moves WHERE item_id = ? ORDER BY date DESC, id DESC LIMIT 100', i['id']) if i.get('track_inventory') else []
        return i
    r.get('/items/:id', perm('items', 'view'), get_item)

    def create(req):
        def _do():
            o = _clean(req.body, req.org, True)
            if not o.get('name'):
                raise bad('Item name is required')
            s = org_settings(req.org)
            if o.get('sku') and s['preferences'].get('duplicate_sku_check') and get('SELECT id FROM items WHERE org_id = ? AND sku = ?', req.org['id'], o['sku']):
                raise bad(f"SKU {o['sku']} is already used")
            iid = insert('items', {**o, 'org_id': req.org['id']})
            post_opening_stock(req.org, get('SELECT * FROM items WHERE id = ?', iid))
            audit(req, 'item', iid, 'created', o['name'])
            return load_item(req.org['id'], iid)
        return tx(_do)
    r.post('/items', perm('items', 'create'), create)

    def edit(req):
        def _do():
            it = load_item(req.org['id'], to_int(req.params['id']))
            o = _clean(req.body, req.org, False)
            if 'name' in o and o['name'] is None:
                raise bad('Item name is required')
            s = org_settings(req.org)
            if o.get('sku') and s['preferences'].get('duplicate_sku_check') and get('SELECT id FROM items WHERE org_id = ? AND sku = ? AND id != ?', req.org['id'], o['sku'], it['id']):
                raise bad(f"SKU {o['sku']} is already used")
            if truthy(o.get('track_inventory')) and not it.get('inventory_account_id') and not o.get('inventory_account_id'):
                o['inventory_account_id'] = sys_account(req.org['id'], 'inventory')
            update('items', it['id'], o)
            post_opening_stock(req.org, get('SELECT * FROM items WHERE id = ?', it['id']))
            audit(req, 'item', it['id'], 'updated')
            return load_item(req.org['id'], it['id'])
        return tx(_do)
    r.put('/items/:id', perm('items', 'edit'), edit)

    def set_status(req):
        it = load_item(req.org['id'], to_int(req.params['id']))
        update('items', it['id'], {'is_active': 1 if truthy(req.body.get('active')) else 0})
        return load_item(req.org['id'], it['id'])
    r.post('/items/:id/status', perm('items', 'edit'), set_status)

    def delete(req):
        def _do():
            it = load_item(req.org['id'], to_int(req.params['id']))
            if get('SELECT COUNT(*) n FROM document_lines WHERE item_id = ?', it['id'])['n']:
                raise bad('This item is used in transactions. Mark it as inactive instead.')
            # inventory adjustments only reference the item in JSON, but their stock moves (and postings) would
            # otherwise be cascade-deleted out from under the ledger
            if get("SELECT COUNT(*) n FROM stock_moves WHERE item_id = ? AND src_type != 'item_opening'", it['id'])['n']:
                raise bad('This item has stock movements. Mark it as inactive instead.')
            first = get("SELECT MIN(date) AS d FROM stock_moves WHERE src_type = 'item_opening' AND src_id = ?", it['id'])['d']
            if first:
                assert_unlocked(req.org, first, 'journal')
            assert_source_unlocked(req.org, 'item_opening', it['id'])
            clear_stock('item_opening', it['id'])
            unpost(req.org['id'], 'item_opening', it['id'])
            run('DELETE FROM items WHERE id = ?', it['id'])
            audit(req, 'item', it['id'], 'deleted', it['name'])
            return {'ok': True}
        return tx(_do)
    r.delete('/items/:id', perm('items', 'delete'), delete)
