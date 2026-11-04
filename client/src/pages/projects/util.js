// Shared constants and date helpers for the time-tracking pages.
import { addDays } from '../../lib/format.js';

export const BILLING = [
  ['project_hours', 'Project hours'],
  ['task_hours', 'Task hours'],
  ['staff_hours', 'Staff hours'],
  ['fixed', 'Fixed fee'],
];
export const BILLING_LABEL = Object.fromEntries(BILLING);

export const BILLING_HELP = {
  project_hours: 'Every hour is billed at the project rate.',
  task_hours: 'Every hour is billed at the rate of its task. Tasks without a rate use the project rate.',
  staff_hours: 'Every hour is billed at the rate of the person who logged it. Staff without a rate use the project rate.',
  fixed: 'One fixed-fee line is invoiced for the whole project; logged time is marked as billed.',
};

export const PROJECT_STATUS = [['active', 'Active'], ['inactive', 'Inactive'], ['completed', 'Completed']];
export const BUDGET = [['none', 'No budget'], ['hours', 'Budget in hours'], ['amount', 'Budget amount']];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Hours with two decimals, e.g. 1.5 -> "1.50". */
export const hrs = (h) => (Number(h) || 0).toFixed(2);

/** Minutes as h:mm, e.g. 90 -> "1:30". */
export const hm = (minutes) => {
  const m = Math.round(Number(minutes) || 0);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/** Monday of the week containing an ISO date. */
export function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export const weekDays = (start) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));

/** HH:MM:SS elapsed since an ISO timestamp. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export const isoDay = (d) => d.slice(0, 10);
