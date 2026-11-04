// Price list labels and the same rate rules the server applies (backend/books/modules/inventory.py), for live previews.

export const PL_TYPE_LABELS = { markup: 'Markup (% increase)', markdown: 'Markdown (% decrease)', per_item: 'Individual item rates' };

export const PL_ROUNDING = [['none', 'None'], ['nearest_whole', 'Nearest whole number'], ['.99', 'Nearest .99']];

export function roundRate(x, mode) {
  if (mode === 'nearest_whole') return Math.round(x);
  if (mode === '.99') return Math.max(0.99, Math.round(x - 0.99) + 0.99);
  return x;
}

/** Rate an item gets under a percentage price list. Per-item lists are read from the list's own rates. */
export function previewRate(pl, base) {
  const pct = Number(pl.percentage) || 0;
  const raw = pl.type === 'markdown' ? base * (1 - pct / 100) : base * (1 + pct / 100);
  return Math.round(roundRate(raw, pl.rounding) * 100) / 100;
}
