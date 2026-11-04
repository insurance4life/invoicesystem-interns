// Shared totals & tax engine. Used by the server (authoritative) and the client (live preview).

export const round2 = (x) => Math.round((Number(x || 0) + Number.EPSILON) * 100) / 100;

/**
 * Expand a tax (or tax group) into components.
 * GST taxes split into CGST+SGST (intra-state) or IGST (inter-state).
 * @returns [{code:'cgst'|'sgst'|'igst'|'tax', name, rate, tax_id}]
 */
export function taxComponents(taxId, taxes, { gst = false, intra = true } = {}) {
  const t = taxes[taxId];
  if (!t) return [];
  if (t.kind === 'group') {
    const ids = Array.isArray(t.group_ids) ? t.group_ids : JSON.parse(t.group_ids || '[]');
    return ids.flatMap((id) => taxComponents(id, taxes, { gst, intra }));
  }
  const rate = Number(t.rate) || 0;
  if (t.kind === 'gst' && gst) {
    if (intra) {
      return [
        { code: 'cgst', name: `CGST${rate / 2}`, rate: rate / 2, tax_id: t.id },
        { code: 'sgst', name: `SGST${rate / 2}`, rate: rate / 2, tax_id: t.id },
      ];
    }
    return [{ code: 'igst', name: `IGST${rate}`, rate, tax_id: t.id }];
  }
  return [{ code: 'tax', name: t.name, rate, tax_id: t.id }];
}

/**
 * Compute line amounts, taxes and document totals.
 * doc: { lines, discount_type, discount_value, shipping, adjustment, tax_inclusive, place_of_supply }
 * ctx: { taxes: {id: tax}, orgState, gst }
 */
export function computeDocument(doc, ctx) {
  const taxes = ctx.taxes || {};
  const intra = !doc.place_of_supply || !ctx.orgState || doc.place_of_supply === ctx.orgState;
  const inclusive = !!Number(doc.tax_inclusive);
  const lines = (doc.lines || []).map((l) => {
    const q = Number(l.quantity) || 0;
    const r = Number(l.rate) || 0;
    const d = Number(l.discount) || 0;
    return { ...l, gross: round2(q * r * (1 - d / 100)) };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.gross, 0));
  let discountTotal = 0;
  const dv = Number(doc.discount_value) || 0;
  if (dv) discountTotal = doc.discount_type === 'amount' ? Math.min(dv, subtotal) : round2((subtotal * dv) / 100);
  discountTotal = round2(discountTotal);

  const taxSummary = {};
  let taxTotal = 0;
  let taxableTotal = 0;
  let allocated = 0;
  const out = lines.map((l, i) => {
    let share = subtotal ? round2((l.gross / subtotal) * discountTotal) : 0;
    if (i === lines.length - 1) share = round2(discountTotal - allocated);
    allocated = round2(allocated + share);
    const net = round2(l.gross - share);
    const comps = l.tax_id ? taxComponents(l.tax_id, taxes, { gst: ctx.gst, intra }) : [];
    const totalRate = comps.reduce((s, c) => s + c.rate, 0);
    const taxable = inclusive ? round2(net / (1 + totalRate / 100)) : net;
    const breakdown = comps.map((c) => ({ ...c, amount: round2((taxable * c.rate) / 100) }));
    let lineTax = round2(breakdown.reduce((s, c) => s + c.amount, 0));
    if (inclusive && breakdown.length) {
      // keep net exact: push rounding diff into last component
      const diff = round2(net - taxable - lineTax);
      if (diff) { breakdown[breakdown.length - 1].amount = round2(breakdown[breakdown.length - 1].amount + diff); lineTax = round2(lineTax + diff); }
    }
    for (const c of breakdown) {
      const k = c.name;
      taxSummary[k] = taxSummary[k] || { name: c.name, code: c.code, rate: c.rate, amount: 0 };
      taxSummary[k].amount = round2(taxSummary[k].amount + c.amount);
    }
    taxTotal = round2(taxTotal + lineTax);
    taxableTotal = round2(taxableTotal + taxable);
    return { ...l, amount: l.gross, net, taxable, tax_amount: lineTax, tax_breakdown: breakdown };
  });
  const shipping = round2(doc.shipping);
  const adjustment = round2(doc.adjustment);
  const total = round2(taxableTotal + taxTotal + shipping + adjustment);
  return {
    lines: out,
    subtotal,
    discount_total: discountTotal,
    taxable_total: taxableTotal,
    tax_total: taxTotal,
    taxes: Object.values(taxSummary),
    shipping,
    adjustment,
    total,
  };
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** Due date from a payment term {type:'net'|'eom'|'receipt', days} */
export function dueDateFor(dateStr, term) {
  if (!dateStr) return dateStr;
  if (!term || term.type === 'receipt') return dateStr;
  if (term.type === 'eom') {
    const d = new Date(dateStr + 'T00:00:00Z');
    const eom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return addDays(eom.toISOString().slice(0, 10), term.days || 0);
  }
  return addDays(dateStr, term.days || 0);
}

export const INDIAN_STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Foreign Country'],
];

export const ACCOUNT_CLASS = {
  cash: 'asset', bank: 'asset', accounts_receivable: 'asset', other_current_asset: 'asset', stock: 'asset',
  fixed_asset: 'asset', other_asset: 'asset', payment_clearing: 'asset',
  accounts_payable: 'liability', other_current_liability: 'liability', credit_card: 'liability',
  long_term_liability: 'liability', other_liability: 'liability',
  equity: 'equity',
  income: 'income', other_income: 'income',
  expense: 'expense', cost_of_goods_sold: 'expense', other_expense: 'expense',
};

export const ACCOUNT_TYPE_LABELS = {
  cash: 'Cash', bank: 'Bank', accounts_receivable: 'Accounts Receivable', other_current_asset: 'Other Current Asset',
  stock: 'Stock', fixed_asset: 'Fixed Asset', other_asset: 'Other Asset', payment_clearing: 'Payment Clearing',
  accounts_payable: 'Accounts Payable', other_current_liability: 'Other Current Liability', credit_card: 'Credit Card',
  long_term_liability: 'Long Term Liability', other_liability: 'Other Liability', equity: 'Equity',
  income: 'Income', other_income: 'Other Income', expense: 'Expense', cost_of_goods_sold: 'Cost Of Goods Sold',
  other_expense: 'Other Expense',
};
