// Helpers shared by the accountant pages.
import { ACCOUNT_CLASS, ACCOUNT_TYPE_LABELS, round2 } from '@shared/calc.js';

export const CLASS_LABELS = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export const classOf = (type) => ACCOUNT_CLASS[type] || 'expense';

/** Balance movement: assets and expenses grow with debits, everything else with credits. */
export const movement = (cls, debit, credit) => (['asset', 'expense'].includes(cls) ? Number(debit) - Number(credit) : Number(credit) - Number(debit));

export const typeLabel = (t) => ACCOUNT_TYPE_LABELS[t] || t;

/** Account type options grouped by class, for <Select options>. */
export function typeOptions() {
  return Object.keys(CLASS_LABELS).map((cls) => ({
    group: CLASS_LABELS[cls],
    options: Object.keys(ACCOUNT_CLASS).filter((t) => ACCOUNT_CLASS[t] === cls).map((t) => ({ value: t, label: typeLabel(t) })),
  }));
}

export const num = (v) => round2(Number(v) || 0);

export const errText = (e) => e?.message || 'Something went wrong';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
