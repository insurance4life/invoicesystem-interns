"""Totals & tax engine — a faithful Python port of shared/calc.js (the client keeps using the JS copy)."""
import datetime
import json
import math

from books.core.jsutil import jsnum, jsstr

EPS = 2.220446049250313e-16


def round2(x):
    """JS Math.round((x + Number.EPSILON) * 100) / 100 (round half up)."""
    v = jsnum(x)
    if isinstance(v, float) and not math.isfinite(v):
        return v
    return math.floor((v + EPS) * 100 + 0.5) / 100


def tax_components(tax_id, taxes, gst=False, intra=True):
    t = taxes.get(tax_id) if tax_id is not None else None
    if t is None and tax_id is not None:
        try:
            t = taxes.get(int(tax_id))
        except (TypeError, ValueError):
            t = None
    if not t:
        return []
    if t.get('kind') == 'group':
        ids = t.get('group_ids')
        if isinstance(ids, str):
            ids = json.loads(ids or '[]')
        out = []
        for i in ids or []:
            out += tax_components(i, taxes, gst, intra)
        return out
    rate = jsnum(t.get('rate'))
    if t.get('kind') == 'gst' and gst:
        if intra:
            return [
                {'code': 'cgst', 'name': f'CGST{jsstr(rate / 2)}', 'rate': rate / 2, 'tax_id': t['id']},
                {'code': 'sgst', 'name': f'SGST{jsstr(rate / 2)}', 'rate': rate / 2, 'tax_id': t['id']},
            ]
        return [{'code': 'igst', 'name': f'IGST{jsstr(rate)}', 'rate': rate, 'tax_id': t['id']}]
    return [{'code': 'tax', 'name': t.get('name'), 'rate': rate, 'tax_id': t['id']}]


def compute_document(doc, ctx):
    """doc: {lines, discount_type, discount_value, shipping, adjustment, tax_inclusive, place_of_supply}
    ctx: {taxes: {id: tax}, orgState, gst}"""
    taxes = ctx.get('taxes') or {}
    pos = doc.get('place_of_supply')
    org_state = ctx.get('orgState')
    intra = (not pos) or (not org_state) or pos == org_state
    inclusive = bool(jsnum(doc.get('tax_inclusive')))
    lines = []
    for l in doc.get('lines') or []:
        q = jsnum(l.get('quantity'))
        r = jsnum(l.get('rate'))
        d = jsnum(l.get('discount'))
        lines.append({**l, 'gross': round2(q * r * (1 - d / 100))})
    subtotal = round2(sum_js(l['gross'] for l in lines))
    discount_total = 0
    dv = jsnum(doc.get('discount_value'))
    if dv:
        discount_total = min(dv, subtotal) if doc.get('discount_type') == 'amount' else round2((subtotal * dv) / 100)
    discount_total = round2(discount_total)

    tax_summary = {}
    tax_total = 0
    taxable_total = 0
    allocated = 0
    out = []
    n = len(lines)
    for i, l in enumerate(lines):
        share = round2((l['gross'] / subtotal) * discount_total) if subtotal else 0
        if i == n - 1:
            share = round2(discount_total - allocated)
        allocated = round2(allocated + share)
        net = round2(l['gross'] - share)
        comps = tax_components(l.get('tax_id'), taxes, ctx.get('gst'), intra) if l.get('tax_id') else []
        total_rate = sum_js(c['rate'] for c in comps)
        taxable = round2(net / (1 + total_rate / 100)) if inclusive else net
        breakdown = [{**c, 'amount': round2((taxable * c['rate']) / 100)} for c in comps]
        line_tax = round2(sum_js(c['amount'] for c in breakdown))
        if inclusive and breakdown:
            diff = round2(net - taxable - line_tax)
            if diff:
                breakdown[-1]['amount'] = round2(breakdown[-1]['amount'] + diff)
                line_tax = round2(line_tax + diff)
        for c in breakdown:
            k = c['name']
            if k not in tax_summary:
                tax_summary[k] = {'name': c['name'], 'code': c['code'], 'rate': c['rate'], 'amount': 0}
            tax_summary[k]['amount'] = round2(tax_summary[k]['amount'] + c['amount'])
        tax_total = round2(tax_total + line_tax)
        taxable_total = round2(taxable_total + taxable)
        out.append({**l, 'amount': l['gross'], 'net': net, 'taxable': taxable, 'tax_amount': line_tax, 'tax_breakdown': breakdown})
    shipping = round2(doc.get('shipping'))
    adjustment = round2(doc.get('adjustment'))
    total = round2(taxable_total + tax_total + shipping + adjustment)
    return {
        'lines': out, 'subtotal': subtotal, 'discount_total': discount_total, 'taxable_total': taxable_total,
        'tax_total': tax_total, 'taxes': list(tax_summary.values()), 'shipping': shipping, 'adjustment': adjustment, 'total': total,
    }


def sum_js(it):
    """Left-to-right float sum, like Array.reduce((s, x) => s + x, 0)."""
    s = 0
    for x in it:
        s = s + x
    return s


def add_days(date_str, days):
    d = datetime.date.fromisoformat(str(date_str)[:10])
    return (d + datetime.timedelta(days=int(jsnum(days)))).isoformat()


def due_date_for(date_str, term):
    if not date_str:
        return date_str
    if not term or term.get('type') == 'receipt':
        return date_str
    if term.get('type') == 'eom':
        d = datetime.date.fromisoformat(str(date_str)[:10])
        nxt = datetime.date(d.year + (d.month // 12), d.month % 12 + 1, 1)
        eom = nxt - datetime.timedelta(days=1)
        return add_days(eom.isoformat(), term.get('days') or 0)
    return add_days(date_str, term.get('days') or 0)


INDIAN_STATES = [
    ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
    ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
    ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
    ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
    ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
    ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
    ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Foreign Country'],
]

ACCOUNT_CLASS = {
    'cash': 'asset', 'bank': 'asset', 'accounts_receivable': 'asset', 'other_current_asset': 'asset', 'stock': 'asset',
    'fixed_asset': 'asset', 'other_asset': 'asset', 'payment_clearing': 'asset',
    'accounts_payable': 'liability', 'other_current_liability': 'liability', 'credit_card': 'liability',
    'long_term_liability': 'liability', 'other_liability': 'liability',
    'equity': 'equity',
    'income': 'income', 'other_income': 'income',
    'expense': 'expense', 'cost_of_goods_sold': 'expense', 'other_expense': 'expense',
}

ACCOUNT_TYPE_LABELS = {
    'cash': 'Cash', 'bank': 'Bank', 'accounts_receivable': 'Accounts Receivable', 'other_current_asset': 'Other Current Asset',
    'stock': 'Stock', 'fixed_asset': 'Fixed Asset', 'other_asset': 'Other Asset', 'payment_clearing': 'Payment Clearing',
    'accounts_payable': 'Accounts Payable', 'other_current_liability': 'Other Current Liability', 'credit_card': 'Credit Card',
    'long_term_liability': 'Long Term Liability', 'other_liability': 'Other Liability', 'equity': 'Equity',
    'income': 'Income', 'other_income': 'Other Income', 'expense': 'Expense', 'cost_of_goods_sold': 'Cost Of Goods Sold',
    'other_expense': 'Other Expense',
}
