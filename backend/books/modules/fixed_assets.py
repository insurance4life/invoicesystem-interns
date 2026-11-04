"""Fixed assets: register, activate (acquisition entry), monthly depreciation, disposal (port of modules/fixed_assets.js)."""
import datetime
import logging

from books.core.db import all, get, insert, update, run, tx
from books.core.router import bad, not_found
from books.core.util import audit, assert_unlocked, clean_body, today
from books.core.auth import perm
from books.core.ledger import post, unpost, sys_account, account_class
from books.core.calc import round2
from books.core.jsutil import truthy
from books.modules.inventory import js_number, nz, jstr, sql_num, body_of, db_row, date_utc

log = logging.getLogger('openbooks')

METHODS = ['straight_line', 'declining_balance']
FIELDS = ['name', 'asset_number', 'asset_account_id', 'expense_account_id', 'accumulated_account_id', 'purchase_date', 'purchase_value',
          'salvage_value', 'useful_life_months', 'method', 'dep_rate', 'depreciation_start', 'notes']
# once an asset is activated these define postings that already exist
FIN_FIELDS = ['purchase_date', 'purchase_value', 'salvage_value', 'useful_life_months', 'method', 'dep_rate', 'depreciation_start',
              'asset_account_id', 'expense_account_id', 'accumulated_account_id']

ACC_JOIN = """LEFT JOIN accounts aa ON aa.id = f.asset_account_id LEFT JOIN accounts ea ON ea.id = f.expense_account_id
  LEFT JOIN accounts ca ON ca.id = f.accumulated_account_id"""
ACC_COLS = """aa.name AS asset_account_name, ea.name AS expense_account_name, ca.name AS accumulated_account_name,
  COALESCE((SELECT SUM(d.amount) FROM fixed_asset_depreciation d WHERE d.asset_id = f.id), 0) AS accumulated,
  (SELECT MAX(d.period_end) FROM fixed_asset_depreciation d WHERE d.asset_id = f.id) AS last_depreciation"""


def _nullish_str(v):
    """String(v ?? '')."""
    return '' if v is None else jstr(v)


def _check_account(org_id, acc_id, ok, msg):
    a = get('SELECT id, type FROM accounts WHERE id = ? AND org_id = ?', sql_num(acc_id), org_id)
    if not a or not ok(a):
        raise bad(msg)
    return a


MAX_LIFE_MONTHS = 1200  # 100 years; the schedule is rebuilt on every view and job run


def _asset_fields(org, body, existing):
    f = {**(existing or {}), **clean_body(body or {}, FIELDS)}
    if not truthy(f.get('name')):
        raise bad('Asset name is required')
    if not truthy(f.get('purchase_date')):
        raise bad('Purchase date is required')
    value = round2(js_number(f.get('purchase_value')))
    if not (value > 0):
        raise bad('Purchase value must be greater than zero')
    salvage = round2(nz(f.get('salvage_value')))
    if salvage < 0 or salvage >= value:
        raise bad('Salvage value must be less than the purchase value')
    method = f.get('method') if truthy(f.get('method')) else 'straight_line'
    if method not in METHODS:
        raise bad('Invalid depreciation method')
    life = js_number(f.get('useful_life_months')) if truthy(f.get('useful_life_months')) else None
    if method == 'straight_line' and not (life is not None and life >= 1):
        raise bad('Useful life (months) is required for straight-line depreciation')
    if life is not None and not (1 <= life <= MAX_LIFE_MONTHS):
        raise bad(f'Useful life must be between 1 and {MAX_LIFE_MONTHS} months')
    rate = nz(f.get('dep_rate'))
    if method == 'declining_balance' and not (rate > 0 and rate < 100):
        raise bad('Enter the yearly depreciation rate (%) for declining balance')
    if not truthy(f.get('asset_account_id')):
        raise bad('Choose the fixed asset account')
    _check_account(org['id'], f.get('asset_account_id'), lambda a: a['type'] == 'fixed_asset',
                   'The asset account must be of type Fixed Asset')
    expense_account_id = f['expense_account_id'] if truthy(f.get('expense_account_id')) else sys_account(org['id'], 'depreciation')
    _check_account(org['id'], expense_account_id, lambda a: account_class(a['type']) == 'expense',
                   'The depreciation account must be an expense account')
    accumulated_account_id = (f['accumulated_account_id'] if truthy(f.get('accumulated_account_id'))
                              else sys_account(org['id'], 'accumulated_depreciation'))
    _check_account(org['id'], accumulated_account_id, lambda a: account_class(a['type']) == 'asset',
                   'The accumulated depreciation account must be an asset account')
    return {
        'name': f['name'],
        'asset_number': f['asset_number'] if truthy(f.get('asset_number')) else None,
        'asset_account_id': js_number(f['asset_account_id']),
        'expense_account_id': js_number(expense_account_id),
        'accumulated_account_id': js_number(accumulated_account_id),
        'purchase_date': f['purchase_date'],
        'purchase_value': value,
        'salvage_value': salvage,
        'useful_life_months': life,
        'method': method,
        'dep_rate': rate,
        'depreciation_start': f['depreciation_start'] if truthy(f.get('depreciation_start')) else f['purchase_date'],
        'notes': f['notes'] if truthy(f.get('notes')) else None,
    }


def _with_book(a):
    return {**a, 'accumulated': round2(a['accumulated']), 'book_value': round2(a['purchase_value'] - a['accumulated'])}


def load_asset(org_id, aid):
    a = get(f'SELECT f.*, {ACC_COLS} FROM fixed_assets f {ACC_JOIN} WHERE f.id = ? AND f.org_id = ?', sql_num(aid), org_id)
    if not a:
        raise not_found('Fixed asset')
    return _with_book(a)


def build_schedule(a):
    """Full monthly schedule for the asset's life: [{period_no, period_end, amount, accumulated, book_value}]."""
    base = round2(a['purchase_value'] - (a.get('salvage_value') or 0))
    months = min(a.get('useful_life_months') or (120 if a.get('method') == 'declining_balance' else 0), MAX_LIFE_MONTHS)
    start = jstr(a.get('depreciation_start') or a.get('purchase_date'))[:10]
    y = js_number(start[0:4])
    m0 = js_number(start[5:7]) - 1
    rows = []
    acc = 0
    i = 0
    while i < months and round2(base - acc) > 0:
        end = date_utc(y, m0 + i + 1, 0).isoformat()
        remaining = round2(base - acc)
        if a.get('method') == 'declining_balance':
            amt = round2(((a['purchase_value'] - acc) * nz(a.get('dep_rate'))) / 1200)
        else:
            amt = remaining if i == months - 1 else round2(base / months)
        amt = min(max(amt, 0), remaining)
        if amt <= 0:
            break
        acc = round2(acc + amt)
        rows.append({'period_no': i + 1, 'period_end': end, 'amount': amt, 'accumulated': acc,
                     'book_value': round2(a['purchase_value'] - acc)})
        i += 1
    return rows


def _post_due(org, a, upto):
    """Post every schedule row (not yet posted) whose period ends on or before `upto`."""
    sched = build_schedule(a)
    have = get('SELECT COUNT(*) n FROM fixed_asset_depreciation WHERE asset_id = ?', a['id'])['n']
    n = 0
    for row in sched[have:]:
        if row['period_end'] > upto:
            break
        assert_unlocked(org, row['period_end'], 'journal')
        dep_id = insert('fixed_asset_depreciation', {'asset_id': a['id'], 'org_id': org['id'], 'period_end': row['period_end'],
                                                     'amount': row['amount']})
        label = f"Depreciation: {jstr(a['name'])}"
        post(org['id'], 'depreciation', dep_id, date=row['period_end'], number=a.get('asset_number') or None, lines=[
            {'account_id': a['expense_account_id'], 'debit': row['amount'], 'description': label},
            {'account_id': a['accumulated_account_id'], 'credit': row['amount'], 'description': label},
        ])
        n += 1
    return n


def run_depreciation(org, upto, strict=False):
    """Post due depreciation for all active assets. strict: raise on the first failure (manual run)."""
    n = 0
    for a in all("SELECT * FROM fixed_assets WHERE org_id = ? AND status = 'active' ORDER BY id", org['id']):
        if strict:
            n += tx(lambda a=a: _post_due(org, a, upto))
        else:
            try:
                n += tx(lambda a=a: _post_due(org, a, upto))
            except Exception as e:  # noqa: BLE001
                msg = e.message if hasattr(e, 'message') else str(e)
                log.error('depreciation skipped for asset %s: %s', a['id'], msg)
    return n


def job(org, sys_req=None):
    """Hourly job: depreciate active assets up to the end of the previous month."""
    t = datetime.datetime.now(datetime.timezone.utc)
    run_depreciation(org, date_utc(t.year, t.month - 1, 0).isoformat())


# ---------------------------------------------------------------- routes
def _list(req):
    rows = all(f"SELECT f.*, {ACC_COLS} FROM fixed_assets f {ACC_JOIN} WHERE f.org_id = ? ORDER BY f.purchase_date DESC, f.id DESC",
               req.org['id'])
    return [_with_book(r) for r in rows]


def _get(req):
    a = load_asset(req.org['id'], sql_num(req.params['id']))
    a['depreciation'] = all('SELECT * FROM fixed_asset_depreciation WHERE asset_id = ? ORDER BY period_end, id', a['id'])
    return a


def _schedule(req):
    a = load_asset(req.org['id'], sql_num(req.params['id']))
    posted = all('SELECT id, period_end FROM fixed_asset_depreciation WHERE asset_id = ? ORDER BY period_end, id', a['id'])
    schedule = [{**row, 'posted': i < len(posted), 'depreciation_id': posted[i]['id'] if i < len(posted) else None}
                for i, row in enumerate(build_schedule(a))]
    return {'asset': a, 'schedule': schedule}


def _create(req):
    f = _asset_fields(req.org, body_of(req), None)
    aid = insert('fixed_assets', db_row({**f, 'org_id': req.org['id'], 'status': 'draft'}))
    audit(req, 'fixed_asset', aid, 'created', f['name'])
    return load_asset(req.org['id'], aid)


def _update(req):
    def _do():
        a = load_asset(req.org['id'], sql_num(req.params['id']))
        if a['status'] == 'disposed':
            raise bad('Disposed assets cannot be edited')
        f = _asset_fields(req.org, body_of(req), a)
        if a['status'] != 'draft':
            for k in FIN_FIELDS:
                if _nullish_str(f.get(k)) != _nullish_str(a.get(k)):
                    raise bad(f"Cannot change {k.replace('_', ' ')} after the asset is activated. Delete and recreate it instead.")
        update('fixed_assets', a['id'], db_row(f))
        audit(req, 'fixed_asset', a['id'], 'updated', f['name'])
        return load_asset(req.org['id'], a['id'])
    return tx(_do)


def _delete(req):
    def _do():
        org = req.org
        a = load_asset(org['id'], sql_num(req.params['id']))
        deps = all('SELECT id, period_end FROM fixed_asset_depreciation WHERE asset_id = ?', a['id'])
        for d in deps:
            assert_unlocked(org, d['period_end'], 'journal')
        if a['status'] != 'draft':
            assert_unlocked(org, a['purchase_date'], 'journal')
        if truthy(a.get('disposed_date')):
            assert_unlocked(org, a['disposed_date'], 'journal')
        for d in deps:
            unpost(org['id'], 'depreciation', d['id'])
        unpost(org['id'], 'fixed_asset', a['id'])
        unpost(org['id'], 'asset_disposal', a['id'])
        run('DELETE FROM fixed_asset_depreciation WHERE asset_id = ?', a['id'])
        run('DELETE FROM fixed_assets WHERE id = ?', a['id'])
        audit(req, 'fixed_asset', a['id'], 'deleted', a['name'])
        return {'ok': True}
    return tx(_do)


def _activate(req):
    """Acquisition: Dr fixed asset, Cr paid-through account (or opening balance offset)."""
    def _do():
        org = req.org
        body = body_of(req)
        a = load_asset(org['id'], sql_num(req.params['id']))
        if a['status'] != 'draft':
            raise bad('Only draft assets can be activated')
        assert_unlocked(org, a['purchase_date'], 'journal')
        paid = nz(body.get('paid_through_id')) if truthy(body.get('paid_through_id')) else 0
        if paid:
            _check_account(org['id'], paid, lambda _a: True, 'Invalid paid-through account')
        post(org['id'], 'fixed_asset', a['id'], date=a['purchase_date'], number=a.get('asset_number') or None, lines=[
            {'account_id': a['asset_account_id'], 'debit': a['purchase_value'], 'description': a['name']},
            {'account_id': paid or sys_account(org['id'], 'opening_balance_offset'), 'credit': a['purchase_value'],
             'description': a['name']},
        ])
        update('fixed_assets', a['id'], {'status': 'active'})
        audit(req, 'fixed_asset', a['id'], 'activated', a['name'])
        return load_asset(org['id'], a['id'])
    return tx(_do)


def _depreciate(req):
    def _do():
        body = body_of(req)
        upto = body.get('upto') if truthy(body.get('upto')) else today()
        posted = run_depreciation(req.org, upto, strict=True)
        audit(req, 'fixed_asset', None, 'depreciated', f'{posted} entries up to {jstr(upto)}')
        return {'posted': posted, 'upto': upto}
    return tx(_do)


def _dispose(req):
    """Disposal: Dr deposit account (amount), Dr accumulated depreciation, Cr asset at cost, gain/loss to income or expense."""
    def _do():
        org = req.org
        body = body_of(req)
        a = load_asset(org['id'], sql_num(req.params['id']))
        if a['status'] != 'active':
            raise bad('Only active assets can be disposed')
        date = body.get('date')
        if not truthy(date):
            raise bad('Disposal date is required')
        if jstr(date) < a['purchase_date']:
            raise bad('Disposal date cannot be before the purchase date')
        assert_unlocked(org, date, 'journal')
        amount = round2(nz(body.get('amount')))
        if amount < 0:
            raise bad('Disposal amount cannot be negative')
        if amount > 0:
            if not truthy(body.get('account_id')):
                raise bad('Choose the account the proceeds were received into')
            _check_account(org['id'], body.get('account_id'), lambda _a: True, 'Invalid deposit account')
        _post_due(org, a, date)
        acc_dep = round2(get('SELECT COALESCE(SUM(amount),0) s FROM fixed_asset_depreciation WHERE asset_id = ?', a['id'])['s'])
        diff = round2(amount + acc_dep - a['purchase_value'])  # > 0 gain, < 0 loss
        lines = []
        name = jstr(a['name'])
        if amount:
            lines.append({'account_id': js_number(body.get('account_id')), 'debit': amount, 'description': f'Disposal: {name}'})
        if acc_dep:
            lines.append({'account_id': a['accumulated_account_id'], 'debit': acc_dep,
                          'description': f'Accumulated depreciation: {name}'})
        lines.append({'account_id': a['asset_account_id'], 'credit': a['purchase_value'], 'description': f'Disposal: {name}'})
        if diff > 0:
            lines.append({'account_id': sys_account(org['id'], 'general_income'), 'credit': diff, 'description': f'Gain on disposal: {name}'})
        if diff < 0:
            lines.append({'account_id': sys_account(org['id'], 'other_expenses'), 'debit': -diff, 'description': f'Loss on disposal: {name}'})
        post(org['id'], 'asset_disposal', a['id'], date=date, number=a.get('asset_number') or None, lines=lines)
        update('fixed_assets', a['id'], {
            'status': 'disposed', 'disposed_date': date, 'disposal_amount': amount,
            'disposal_account_id': js_number(body.get('account_id')) if amount else None,
        })
        audit(req, 'fixed_asset', a['id'], 'disposed', f'{jstr(amount)} on {jstr(date)}')
        return load_asset(org['id'], a['id'])
    return tx(_do)


def routes(r):
    r.get('/fixed-assets', perm('accountant', 'view'), _list)
    r.get('/fixed-assets/:id', perm('accountant', 'view'), _get)
    r.get('/fixed-assets/:id/schedule', perm('accountant', 'view'), _schedule)
    r.post('/fixed-assets', perm('accountant', 'create'), _create)
    r.put('/fixed-assets/:id', perm('accountant', 'edit'), _update)
    r.delete('/fixed-assets/:id', perm('accountant', 'delete'), _delete)
    r.post('/fixed-assets/:id/activate', perm('accountant', 'edit'), _activate)
    r.post('/fixed-assets/depreciate', perm('accountant', 'edit'), _depreciate)
    r.post('/fixed-assets/:id/dispose', perm('accountant', 'edit'), _dispose)
