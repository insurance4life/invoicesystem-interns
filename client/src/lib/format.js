const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', SGD: 'S$', AUD: 'A$', CAD: 'C$' };

export function fmtNum(v, dp = 2) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtMoney(v, currency = 'INR') {
  const n = Number(v) || 0;
  const sym = SYMBOLS[currency] ?? `${currency} `;
  const s = Math.abs(n).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${sym}${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format yyyy-mm-dd according to an org date format (dd/MM/yyyy, MM/dd/yyyy, yyyy-MM-dd, dd MMM yyyy). */
export function fmtDate(d, format = 'dd/MM/yyyy') {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  if (!m) return d;
  switch (format) {
    case 'MM/dd/yyyy': return `${m}/${day}/${y}`;
    case 'yyyy-MM-dd': return `${y}-${m}-${day}`;
    case 'dd MMM yyyy': return `${day} ${MONTHS[Number(m) - 1]} ${y}`;
    case 'dd-MM-yyyy': return `${day}-${m}-${y}`;
    default: return `${day}/${m}/${y}`;
  }
}

export const today = () => new Date().toISOString().slice(0, 10);

export function addDays(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Common report date ranges, fiscal-year aware. */
export function dateRange(key, fyStart = 4) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = (dt) => new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate())).toISOString().slice(0, 10);
  const fyY = m + 1 >= fyStart ? y : y - 1;
  const ranges = {
    today: [iso(now), iso(now)],
    this_week: [iso(new Date(y, m, now.getDate() - now.getDay())), iso(new Date(y, m, now.getDate() - now.getDay() + 6))],
    this_month: [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))],
    last_month: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
    this_quarter: [iso(new Date(y, Math.floor(m / 3) * 3, 1)), iso(new Date(y, Math.floor(m / 3) * 3 + 3, 0))],
    last_quarter: [iso(new Date(y, Math.floor(m / 3) * 3 - 3, 1)), iso(new Date(y, Math.floor(m / 3) * 3, 0))],
    this_year: [iso(new Date(fyY, fyStart - 1, 1)), iso(new Date(fyY + 1, fyStart - 1, 0))],
    last_year: [iso(new Date(fyY - 1, fyStart - 1, 1)), iso(new Date(fyY, fyStart - 1, 0))],
    calendar_year: [iso(new Date(y, 0, 1)), iso(new Date(y, 11, 31))],
  };
  return ranges[key] || ranges.this_month;
}

export const RANGE_OPTIONS = [
  ['today', 'Today'], ['this_week', 'This Week'], ['this_month', 'This Month'], ['last_month', 'Last Month'],
  ['this_quarter', 'This Quarter'], ['last_quarter', 'Last Quarter'], ['this_year', 'This Fiscal Year'],
  ['last_year', 'Previous Fiscal Year'], ['calendar_year', 'This Calendar Year'], ['custom', 'Custom'],
];

export const STATUS_LABELS = {
  draft: 'Draft', pending_approval: 'Pending Approval', open: 'Open', sent: 'Sent', paid: 'Paid', partially_paid: 'Partially Paid',
  overdue: 'Overdue', void: 'Void', closed: 'Closed', accepted: 'Accepted', declined: 'Declined', invoiced: 'Invoiced', expired: 'Expired',
  billed: 'Billed', cancelled: 'Cancelled', delivered: 'Delivered', returned: 'Returned', active: 'Active', paused: 'Paused', stopped: 'Stopped',
  unbilled: 'Unbilled', 'non-billable': 'Non-billable', uncategorized: 'Uncategorized', categorized: 'Categorized', matched: 'Matched',
  excluded: 'Excluded', reconciled: 'Reconciled', approved: 'Approved', rejected: 'Rejected', submitted: 'Submitted', inactive: 'Inactive',
  in_progress: 'In Progress', completed: 'Completed',
};

export const statusLabel = (s) => STATUS_LABELS[s] || (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');

export const PAYMENT_MODES = ['Cash', 'Bank Transfer', 'Cheque', 'Credit Card', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'Online Payment', 'Other'];
