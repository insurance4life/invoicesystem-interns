import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced, bal } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('budgets: CRUD and budget vs actual from an expense', async () => {
  const c = await signup(srv.base);
  const rent = c.acc('rent');
  const b = await c.post('/budgets', { name: 'FY26 Operating', fiscal_year: 2026, period: 'monthly', lines: { [rent]: Array(12).fill(10000) } });
  assert.equal(b.period, 'monthly');
  assert.equal(b.lines[rent].length, 12);

  await c.post('/expenses', { date: '2026-04-15', account_id: rent, paid_through_id: c.acc('petty_cash'), amount: 5000 });
  const va = await c.get(`/budgets/${b.id}/vs-actual`);
  assert.equal(va.periods[0].start, '2026-04-01');
  assert.equal(va.periods[0].end, '2026-04-30');
  const row = va.rows.find((r) => r.account_id === rent);
  assert.equal(row.periods[0].budget, 10000);
  assert.equal(row.periods[0].actual, 5000);
  assert.equal(row.periods[0].variance, -5000);
  assert.equal(row.periods[0].variance_pct, -50);
  assert.equal(row.periods[1].actual, 0);
  assert.equal(row.total.budget, 120000);
  assert.equal(row.total.actual, 5000);

  const q = await c.post('/budgets', { name: 'Quarterly', fiscal_year: 2026, period: 'quarterly', lines: { [rent]: [1, 2, 3, 4] } });
  assert.equal(q.lines[rent].length, 4);
  const put = await c.put(`/budgets/${q.id}`, { name: 'Quarterly v2' });
  assert.equal(put.name, 'Quarterly v2');
  assert.equal((await c.get('/budgets')).length, 2);
  await c.del(`/budgets/${q.id}`);
  assert.equal((await c.get('/budgets')).length, 1);
  assert.ok(await trialBalanced(c));
});

test('fixed assets: activate, depreciate 3 months, dispose', async () => {
  const c = await signup(srv.base);
  const a = await c.post('/fixed-assets', {
    name: 'Office furniture', asset_number: 'FA-001', asset_account_id: c.acc('furniture'), purchase_date: '2026-01-01',
    purchase_value: 120000, salvage_value: 0, useful_life_months: 12, method: 'straight_line',
  });
  assert.equal(a.status, 'draft');
  assert.equal(a.expense_account_id, c.acc('depreciation'));
  assert.equal(a.accumulated_account_id, c.acc('accumulated_depreciation'));

  const sched = await c.get(`/fixed-assets/${a.id}/schedule`);
  assert.equal(sched.schedule.length, 12);
  assert.equal(sched.schedule[0].amount, 10000);
  assert.equal(sched.schedule[11].book_value, 0);

  const act = await c.post(`/fixed-assets/${a.id}/activate`, { paid_through_id: c.acc('petty_cash') });
  assert.equal(act.status, 'active');
  assert.equal(await bal(c, 'furniture'), 120000);

  const dep = await c.post('/fixed-assets/depreciate', { upto: '2026-03-31' });
  assert.equal(dep.posted, 3);
  assert.equal(-(await bal(c, 'accumulated_depreciation')), 30000);
  assert.equal(await bal(c, 'depreciation'), 30000);
  const again = await c.post('/fixed-assets/depreciate', { upto: '2026-03-31' });
  assert.equal(again.posted, 0, 're-running does not double post');

  const shown = await c.get(`/fixed-assets/${a.id}`);
  assert.equal(shown.accumulated, 30000);
  assert.equal(shown.book_value, 90000);

  const locked = await c.call('PUT', `/fixed-assets/${a.id}`, { purchase_value: 1000 }, { expectError: true });
  assert.match(locked.error, /activated/);

  // sell for 80000 on 31 Mar: NBV is 90000, so a loss of 10000
  const disp = await c.post(`/fixed-assets/${a.id}/dispose`, { date: '2026-03-31', amount: 80000, account_id: c.acc('petty_cash') });
  assert.equal(disp.status, 'disposed');
  assert.equal(await bal(c, 'furniture'), 0);
  assert.equal(await bal(c, 'accumulated_depreciation'), 0);
  assert.equal(await bal(c, 'other_expenses'), 10000);
  assert.ok(await trialBalanced(c));

  // deleting removes every posting
  await c.del(`/fixed-assets/${a.id}`);
  assert.equal(await bal(c, 'other_expenses'), 0);
  assert.equal(await bal(c, 'depreciation'), 0);
  assert.ok(await trialBalanced(c));
});

test('fixed assets: declining balance and the hourly job', async () => {
  const c = await signup(srv.base);
  const a = await c.post('/fixed-assets', {
    name: 'Laptop', asset_account_id: c.acc('computers'), purchase_date: '2026-01-01', purchase_value: 100000,
    salvage_value: 10000, method: 'declining_balance', dep_rate: 36, useful_life_months: 24,
  });
  const sched = await c.get(`/fixed-assets/${a.id}/schedule`);
  assert.equal(sched.schedule[0].amount, 3000, '36% a year, 3% a month of 100000');
  const last = sched.schedule[sched.schedule.length - 1];
  assert.ok(last.book_value >= 10000 - 0.01, 'never below salvage');

  await c.post(`/fixed-assets/${a.id}/activate`, {});
  assert.equal(await bal(c, 'computers'), 100000);
  await srv.runJobs();
  const now = new Date();
  const expected = Math.min(24, Math.max(0, (now.getUTCFullYear() - 2026) * 12 + now.getUTCMonth()));
  const shown = await c.get(`/fixed-assets/${a.id}`);
  const expectedAcc = sched.schedule.slice(0, expected).reduce((s, r) => s + r.amount, 0);
  assert.equal(shown.accumulated, Math.round(expectedAcc * 100) / 100, 'job depreciates up to the end of last month');
  assert.ok(await trialBalanced(c));
});

test('currency adjustment revalues an open USD invoice', async () => {
  const c = await signup(srv.base);
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'US Client' });
  const inv = await c.post('/documents/invoice', {
    contact_id: cust.id, currency: 'USD', exchange_rate: 80, date: '2026-05-01', lines: [{ name: 'Consulting', quantity: 1, rate: 100 }],
  });
  await c.post(`/documents/invoice/${inv.id}/action/mark_sent`);
  assert.equal(await bal(c, 'ar'), 8000);

  const pv = await c.get('/currency-adjustments/preview?date=2026-06-30&currency=USD&rate=85');
  assert.equal(pv.rows.length, 1);
  assert.equal(pv.rows[0].adjustment, 500);
  assert.equal(pv.total_gain_loss, 500);

  const adj = await c.post('/currency-adjustments', { date: '2026-06-30', currency: 'USD', rate: 85 });
  assert.equal(adj.amount, 500);
  assert.equal(await bal(c, 'ar'), 8500);
  assert.equal(await bal(c, 'fx_gain_loss'), 500);
  assert.ok(await trialBalanced(c));

  // a second revaluation only books the movement since the first one
  const pv2 = await c.get('/currency-adjustments/preview?date=2026-07-31&currency=USD&rate=86');
  assert.equal(pv2.total_gain_loss, 100);

  await c.del(`/currency-adjustments/${adj.id}`);
  assert.equal(await bal(c, 'ar'), 8000);
  assert.equal(await bal(c, 'fx_gain_loss'), 0);
  assert.equal((await c.get('/currency-adjustments')).length, 0);
  assert.ok(await trialBalanced(c));
});
