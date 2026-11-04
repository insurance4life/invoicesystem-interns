import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced, bal } from './helpers.js';

let srv, c;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const FROM = day(-400), TO = day(0);
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.011, `${msg}: ${a} != ${b}`);
const range = `from=${FROM}&to=${TO}`;
const seeded = {};

before(async () => {
  srv = await startServer();
  c = await signup(srv.base, undefined, { name: 'Report Co', state: '27', gstin: '27AAPFU0939F1ZV' });
  const gst18 = c.tax('GST18');

  // customers in different states, one unregistered
  const acme = await c.post('/contacts', { type: 'customer', display_name: 'Acme Mumbai', gstin: '27AAACA1234B1Z5', gst_treatment: 'registered', place_of_supply: '27' });
  const delhi = await c.post('/contacts', { type: 'customer', display_name: 'Delhi Traders', gstin: '07AAACD5678E1Z2', gst_treatment: 'registered', place_of_supply: '07' });
  const walkin = await c.post('/contacts', { type: 'customer', display_name: 'Walk-in Karnataka', gst_treatment: 'consumer', place_of_supply: '29' });
  const vend = await c.post('/contacts', { type: 'vendor', display_name: 'Parts Supplier', gstin: '27AAACP4321Q1Z9', place_of_supply: '27' });
  const item = await c.post('/items', { name: 'Charger', type: 'goods', selling_price: 1000, purchase_price: 600, track_inventory: 1, tax_id: gst18, hsn_sac: '8504', unit: 'pcs' });
  seeded.item = item;

  // owner capital into the bank
  const bank = c.meta.accounts.find((a) => a.type === 'bank').id;
  seeded.bank = bank;
  await c.post('/journals', { date: day(-100), notes: 'Capital', lines: [{ account_id: bank, debit: 100000 }, { account_id: c.acc('owners_equity'), credit: 100000 }] });

  // stock: 10 @ 600 and 10 @ 700 → average 650
  const b1 = await c.post('/documents/bill', { contact_id: vend.id, date: day(-90), due_date: day(-60), lines: [{ item_id: item.id, quantity: 10, rate: 600, tax_id: gst18 }], save_as: 'open' });
  const b2 = await c.post('/documents/bill', { contact_id: vend.id, date: day(-80), due_date: day(10), lines: [{ item_id: item.id, quantity: 10, rate: 700, tax_id: gst18 }], save_as: 'open' });
  await c.post('/payments/made', { contact_id: vend.id, date: day(-50), amount: b1.total, account_id: bank, mode: 'Bank Transfer', allocations: [{ document_id: b1.id, amount: b1.total }] });
  await c.post('/payments/made', { contact_id: vend.id, date: day(-20), amount: 3000, account_id: bank, mode: 'Cheque', allocations: [{ document_id: b2.id, amount: 3000 }] });

  // invoices: intra-state B2B, inter-state B2B, unregistered B2C
  const i1 = await c.post('/documents/invoice', { contact_id: acme.id, date: day(-60), due_date: day(-45), lines: [{ item_id: item.id, quantity: 2, rate: 1000, tax_id: gst18 }], save_as: 'open' });
  const i2 = await c.post('/documents/invoice', { contact_id: delhi.id, date: day(-50), due_date: day(-20), salesperson: 'Ravi',
    lines: [{ item_id: item.id, quantity: 1, rate: 1000, tax_id: gst18 }, { name: 'Consulting', quantity: 1, rate: 5000, tax_id: gst18, hsn_sac: '998311' }], save_as: 'open' });
  const i3 = await c.post('/documents/invoice', { contact_id: walkin.id, date: day(-10), due_date: day(5), lines: [{ name: 'Consulting', quantity: 1, rate: 2000, tax_id: gst18, hsn_sac: '998311' }], save_as: 'open' });
  const draft = await c.post('/documents/invoice', { contact_id: acme.id, date: day(-5), lines: [{ name: 'Draft work', quantity: 1, rate: 999 }] });
  seeded.invoices = [i1, i2, i3];
  seeded.draft = draft;
  assert.equal(i1.status, 'open');

  // payments: partial, and an overpayment that leaves an unused credit
  await c.post('/payments/received', { contact_id: acme.id, date: day(-30), amount: 1000, account_id: bank, mode: 'UPI', allocations: [{ document_id: i1.id, amount: 1000 }] });
  await c.post('/payments/received', { contact_id: walkin.id, date: day(-5), amount: 3000, account_id: c.acc('petty_cash'), mode: 'Cash', allocations: [{ document_id: i3.id, amount: i3.total }] });

  // credit note partly applied, the rest stays open
  const cn = await c.post('/documents/creditnote', { contact_id: delhi.id, date: day(-15), lines: [{ name: 'Consulting', quantity: 1, rate: 500, tax_id: gst18, hsn_sac: '998311' }], save_as: 'open' });
  await c.post('/credits/apply', { source_type: 'creditnote', source_id: cn.id, date: day(-14), applications: [{ document_id: i2.id, amount: 200 }] });
  seeded.cn = cn;

  // an expense with input GST and a journal
  await c.post('/expenses', { date: day(-40), account_id: c.acc('rent'), paid_through_id: bank, amount: 11800, tax_id: gst18, tax_inclusive: 1, vendor_id: vend.id });
  await c.post('/journals', { date: day(-35), notes: 'Interest earned', lines: [{ account_id: bank, debit: 250 }, { account_id: c.acc('interest_income'), credit: 250 }] });
  await c.put(`/accounts/${bank}`, { watchlist: 1 });
  assert.ok(await trialBalanced(c));
});
after(() => srv.close());

test('trial balance totals are equal', async () => {
  const tb = await c.get(`/reports/trial-balance?to=${TO}`);
  assert.equal(tb.title, 'Trial Balance');
  assert.ok(tb.totals.debit > 0);
  near(tb.totals.debit, tb.totals.credit, 'TB debit vs credit');
});

test('balance sheet balances and includes current year earnings', async () => {
  const bs = await c.get(`/reports/balance-sheet?to=${TO}`);
  near(bs.totals.total_assets, bs.totals.total_liabilities_equity, 'Assets vs Liabilities + Equity');
  assert.ok(bs.balanced);
  assert.ok(bs.rows.some((r) => r.name === 'Current Year Earnings'));
  const all = await c.get(`/reports/profit-loss?from=1900-01-01&to=${TO}`);
  near(bs.totals.current_year_earnings + bs.totals.prior_years_earnings, all.totals.net_profit, 'earnings = lifetime profit');
  // a balance sheet in the past balances as well
  const past = await c.get(`/reports/balance-sheet?to=${day(-45)}`);
  near(past.totals.total_assets, past.totals.total_liabilities_equity, 'past balance sheet');
});

test('profit and loss: net profit = income - expenses, compare column', async () => {
  const pl = await c.get(`/reports/profit-loss?${range}&compare=previous_year`);
  const sec = Object.fromEntries(pl.sections.map((s) => [s.key, s]));
  const income = sec.operating_income.total + sec.non_operating_income.total;
  const expense = sec.cogs.total + sec.operating_expense.total + sec.non_operating_expense.total;
  near(pl.totals.net_profit, income - expense, 'net profit');
  // invoices 2000 + 6000 + 2000 - 500 credit note + interest 250 (an income-type account)
  near(sec.operating_income.total, 9750, 'operating income incl. interest');
  near(sec.non_operating_income.total, 0, 'non-operating income');
  near(sec.cogs.total, 1950, 'COGS = 3 x 650');
  near(sec.operating_expense.total, 10000, 'rent excluding GST');
  assert.ok(pl.rows.some((r) => r.account_id === c.acc('interest_income')), 'interest is an income row');
  assert.ok(pl.columns.some((x) => x.key === 'compare'));
  // ledger cross-check: P&L equals the income/expense accounts in the trial balance
  const accts = await c.get('/accounts');
  const ledgerNet = accts.filter((a) => a.class === 'income').reduce((s, a) => s + a.balance, 0) - accts.filter((a) => a.class === 'expense').reduce((s, a) => s + a.balance, 0);
  near(pl.totals.net_profit, ledgerNet, 'P&L vs ledger');
});

test('cash basis income does not exceed accrual income', async () => {
  const acc = await c.get(`/reports/profit-loss?${range}&basis=accrual`);
  const cash = await c.get(`/reports/profit-loss?${range}&basis=cash`);
  assert.equal(cash.basis, 'cash');
  assert.ok(cash.totals.total_income <= acc.totals.total_income + 0.01, `${cash.totals.total_income} > ${acc.totals.total_income}`);
  assert.ok(cash.totals.total_income < acc.totals.total_income, 'unpaid invoices are excluded on cash basis');
  // i3 fully paid (2000), i1 1000 of 2360 paid, i2 200 credited of 7080, CN 200 of 590 applied → income
  const expected = 2000 + 2000 * (1000 / 2360) + 6000 * (200 / 7080) - 500 * (200 / 590) + 250;
  near(Math.round(cash.totals.total_income * 100) / 100, Math.round(expected * 100) / 100, 'cash income');
  const dash = await c.get(`/dashboard?basis=cash&from=${FROM}&to=${TO}`);
  const dashAcc = await c.get(`/dashboard?basis=accrual&from=${FROM}&to=${TO}`);
  assert.ok(dash.income_expense_totals.income <= dashAcc.income_expense_totals.income + 0.01);
  near(dashAcc.income_expense_totals.income, acc.totals.total_income, 'dashboard accrual income');
});

test('AR aging total reconciles to the AR account', async () => {
  const ag = await c.get(`/reports/ar-aging-summary?to=${TO}`);
  const ar = await bal(c, 'ar');
  near(ag.net_balance, ar, 'aging (net of unused credits) vs AR');
  near(ag.ledger_balance, ar, 'ledger balance in report');
  const buckets = ['current', 'd1_15', 'd16_30', 'd31_45', 'gt45'].reduce((s, k) => s + ag.totals[k], 0);
  near(buckets, ag.totals.total, 'buckets add up');
  // i1 balance 1360 (45 days overdue → 31-45), i2 balance 6880 (20 days → 16-30)
  near(ag.totals.d31_45, 1360, 'i1 bucket');
  near(ag.totals.d16_30, 6880, 'i2 bucket');
  near(ag.unused_credits, 390 + 640, 'open credit note + overpayment');
  const det = await c.get(`/reports/ar-aging-details?to=${TO}`);
  near(det.totals.balance, ag.totals.total, 'details = summary');
  const ap = await c.get(`/reports/ap-aging-summary?to=${TO}`);
  near(ap.net_balance, await bal(c, 'ap'), 'AP aging vs AP');
  const cb = await c.get(`/reports/customer-balances?to=${TO}`);
  near(cb.totals.net, ar, 'customer balances net vs AR');
  const dash = await c.get('/dashboard');
  near(dash.receivables.total, ag.totals.total, 'dashboard receivables');
  near(dash.receivables.current + dash.receivables.overdue, dash.receivables.total, 'dashboard split');
});

test('inventory valuation equals the inventory account', async () => {
  const v = await c.get(`/reports/inventory-valuation?to=${TO}`);
  const inv = await bal(c, 'inventory');
  near(v.totals.value, inv, 'valuation vs inventory account');
  near(v.totals.value, 17 * 650, '17 units at 650');
  near(v.inventory_account_balance, inv, 'account balance in report');
  const s = await c.get(`/reports/inventory-summary?${range}`);
  const row = s.rows.find((r) => r.item_id === seeded.item.id);
  assert.equal(row.qty_in, 20);
  assert.equal(row.qty_out, 3);
  assert.equal(row.closing, 17);
});

test('GSTR-1 B2B taxable value matches the invoices', async () => {
  const g = await c.get(`/reports/gstr1?${range}`);
  const [i1, i2, i3] = seeded.invoices;
  near(g.b2b_taxable, (i1.total - i1.tax_total) + (i2.total - i2.tax_total), 'B2B taxable');
  const rows = g.tabs.b2b.rows;
  assert.equal(rows.length, 2);
  const r1 = rows.find((r) => r.number === i1.number), r2 = rows.find((r) => r.number === i2.number);
  near(r1.cgst, 180, 'intra-state CGST'); near(r1.sgst, 180, 'intra-state SGST'); near(r1.igst, 0, 'no IGST intra');
  near(r2.igst, 1080, 'inter-state IGST');
  assert.equal(g.tabs.b2c.rows.length, 1, 'one B2C small group');
  near(g.tabs.b2c.rows[0].taxable, i3.total - i3.tax_total, 'B2C taxable');
  assert.equal(g.tabs.cdnr.rows.length, 1);
  const hsn = g.tabs.hsn.rows;
  near(hsn.find((h) => h.hsn === '8504').taxable, 3000, 'HSN 8504');
  near(hsn.find((h) => h.hsn === '998311').taxable, 7000 - 500, 'HSN 998311 net of credit note');
  const json = await c.get(`/reports/gstr1?${range}&format=json`);
  assert.equal(json.gstin, '27AAPFU0939F1ZV');
  assert.equal(json.b2b.length, 2);
  const inv = json.b2b.find((x) => x.ctin === '07AAACD5678E1Z2').inv[0];
  assert.equal(inv.inum, i2.number);
  assert.match(inv.idt, /^\d{2}-\d{2}-\d{4}$/);
  near(inv.itms.reduce((s, x) => s + x.txval, 0), 6000, 'JSON txval');
  assert.equal(inv.itms[0].rt, 18);
  assert.ok(Array.isArray(json.hsn.data) && json.hsn.data.length === 2);
  const g3 = await c.get(`/reports/gstr3b?${range}`);
  near(g3.outward.taxable, 9500, '3B outward taxable');
  near(g3.itc.cgst, 540 + 630 + 900, 'ITC CGST: bills 540+630 and rent 900');
  const ts = await c.get(`/reports/tax-summary?${range}`);
  near(ts.net_payable, ts.output_tax - ts.input_tax, 'tax summary net');
  near(ts.input_tax, 2340 + 1800, 'input tax: bills + expense');
});

test('cash flow reconciles to cash and bank balances', async () => {
  const cf = await c.get(`/reports/cash-flow?${range}`);
  const accts = await c.get('/accounts');
  const cash = accts.filter((a) => ['cash', 'bank'].includes(a.type)).reduce((s, a) => s + a.balance, 0);
  near(cf.totals.ending_cash, cash, 'ending cash vs cash+bank accounts');
  near(cf.totals.ledger_ending_cash, cf.totals.ending_cash, 'indirect method reconciles');
  near(cf.totals.beginning_cash, 0, 'nothing before the period');
});

test('dashboard summary', async () => {
  const d = await c.get('/dashboard');
  assert.equal(d.cash_flow.length, 12);
  assert.equal(d.income_expense.length, 12);
  assert.ok(d.bank_accounts.some((b) => b.id === seeded.bank));
  assert.ok(d.watchlist.some((w) => w.id === seeded.bank));
  assert.equal(d.counts.draft_invoices, 1);
  assert.equal(d.counts.overdue_invoices, 2);
  assert.equal(d.counts.unpaid_bills, 1);
  near(d.payables.total, 8260 - 3000, 'payables');
  assert.ok(d.top_expenses.length >= 1);
});

test('drill-down, ledger and listing reports respond', async () => {
  const at = await c.get(`/reports/account-transactions?account_id=${seeded.bank}&${range}`);
  const bankBal = (await c.get('/accounts')).find((a) => a.id === seeded.bank).balance;
  near(at.totals.closing, bankBal, 'account transactions closing');
  const names = ['general-ledger', 'journal', 'day-book', 'account-type-summary', 'sales-by-customer', 'sales-by-item', 'sales-by-salesperson', 'invoice-details',
    'quote-details', 'salesorder-details', 'creditnote-details', 'refund-history', 'time-to-get-paid', 'payments-received', 'purchases-by-vendor', 'purchases-by-item',
    'ap-aging-details', 'vendor-balances', 'bill-details', 'payments-made', 'vendor-credit-details', 'expense-details', 'expenses-by-category', 'billable-expenses',
    'stock-aging', 'committed-stock', 'hsn-summary', 'audit-trail', 'time-by-project', 'project-profitability', 'budget-vs-actual', 'cash-flow'];
  for (const n of names) {
    const r = await c.get(`/reports/${n}?${range}`);
    assert.ok(r.title, `${n} has a title`);
    assert.equal(r.from, FROM, `${n} from`);
    assert.ok(Array.isArray(r.rows), `${n} rows`);
    assert.ok(Array.isArray(r.columns), `${n} columns`);
  }
  const sbc = await c.get(`/reports/sales-by-customer?${range}`);
  near(sbc.totals.amount, 9500, 'sales by customer');
  const sbi = await c.get(`/reports/sales-by-item?${range}`);
  const ch = sbi.rows.find((r) => r.item_id === seeded.item.id);
  assert.equal(ch.qty, 3); near(ch.avg_price, 1000, 'avg price');
  const pr = await c.get(`/reports/payments-received?${range}`);
  assert.equal(pr.rows.length, 2);
  assert.equal(pr.by_mode.length, 2);
  const gl = await c.get(`/reports/general-ledger?${range}`);
  assert.ok(gl.rows.some((r) => r._kind === 'section' && r.account_id === seeded.bank));
  const jr = await c.get(`/reports/journal?${range}`);
  near(jr.totals.debit, jr.totals.credit, 'journal report balances');
  const db = await c.get(`/reports/day-book?date=${day(-40)}`);
  assert.ok(db.rows.length >= 2);
  const missing = await c.call('GET', '/reports/no-such-report', null, { expectError: true });
  assert.equal(missing.status, 404);
  const inv = await c.get(`/reports/invoice-details?${range}`);
  assert.equal(inv.rows.length, 4);
  assert.ok(inv.rows.some((r) => r.status === 'overdue'));
});
