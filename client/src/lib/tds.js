// TDS (tax deducted at source) on payments. TDS is charged on the value before GST, so each invoice or bill
// contributes only its pre-tax share of whatever is applied to it.
import { round2 } from '@shared/calc.js';

export const tdsLabel = (s) => (s ? `${s.section ? `${s.section} ` : ''}${s.name} · ${Number(s.rate)}%` : '');

/** Sections to offer: active ones, plus the one already chosen even if it has since been deactivated. */
export const tdsOptions = (sections, currentId) => (sections || [])
  .filter((s) => s.is_active || s.id === Number(currentId))
  .map((s) => [s.id, tdsLabel(s)]);

/** Fraction of a document's total that is before GST (1 when there is no tax). */
export function taxableShare(d) {
  const total = Number(d?.total) || 0;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (total - (Number(d.tax_total) || 0)) / total));
}

/** TDS on amounts already applied to documents ({ [docId]: amount }). */
export function tdsOnApplied(docs, alloc, rate) {
  const r = (Number(rate) || 0) / 100;
  return round2(docs.reduce((s, d) => s + (Number(alloc[d.id]) || 0) * taxableShare(d) * r, 0));
}

/** Spread the cash actually paid over open documents, oldest first. Each rupee applied to a document is settled
 * partly in cash and partly by TDS, so a document needs less cash than its balance. Cash left over stays an advance. */
export function applyNet(docs, net, rate) {
  const r = (Number(rate) || 0) / 100;
  let left = round2(Number(net) || 0);
  const alloc = {};
  for (const d of [...docs].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id))) {
    if (left <= 0) break;
    const perCash = 1 - r * taxableShare(d);
    const take = round2(Math.min(d.balance, perCash > 0 ? left / perCash : d.balance));
    if (take > 0) {
      alloc[d.id] = take;
      left = round2(left - take * perCash);
    }
  }
  const applied = round2(Object.values(alloc).reduce((s, v) => s + v, 0));
  const tds = tdsOnApplied(docs, alloc, rate);
  // paisa rounding must never make the documents need more cash than was paid
  return { alloc, tds: round2(applied - tds) > round2(Number(net) || 0) ? round2(applied - (Number(net) || 0)) : tds };
}
