import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced, bal } from './helpers.js';

let srv, c;
before(async () => { srv = await startServer(); c = await signup(srv.base); });
after(() => srv.close());

test('auth & meta', async () => {
  assert.ok(c.meta.org.id);
  assert.equal(c.meta.role, 'Admin');
  assert.ok(c.meta.accounts.length > 40);
  assert.ok(c.tax('GST18'));
});

test('order to cash with GST, inventory and payment', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Acme Pvt Ltd', email: 'a@acme.test', place_of_supply: '27' });
  const outCust = await c.post('/contacts', { type: 'customer', display_name: 'Delhi Traders', place_of_supply: '07' });
  const vend = await c.post('/contacts', { type: 'vendor', display_name: 'Supplier Co' });
  const item = await c.post('/items', { name: 'Charger', type: 'goods', selling_price: 1000, purchase_price: 600, track_inventory: 1, tax_id: c.tax('GST18'), hsn_sac: '8504' });

  // buy 10 @ 600 + 18% GST
  const bill = await c.post('/documents/bill', { contact_id: vend.id, lines: [{ item_id: item.id, quantity: 10, rate: 600, tax_id: c.tax('GST18') }], save_as: 'open' });
  assert.equal(bill.total, 7080);
  assert.equal(bill.status, 'open');
  assert.equal(await bal(c, 'inventory'), 6000);
  assert.equal(await bal(c, 'ap'), 7080);

  // intra-state invoice: CGST+SGST
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ item_id: item.id, quantity: 2, rate: 1000, tax_id: c.tax('GST18') }] });
  assert.equal(inv.status, 'draft');
  assert.equal(inv.total, 2360);
  assert.deepEqual(inv.taxes.map((t) => t.name).sort(), ['CGST9', 'SGST9']);
  assert.equal(await bal(c, 'ar'), 0, 'drafts do not post');
  await c.post(`/documents/invoice/${inv.id}/action/mark_sent`);
  assert.equal(await bal(c, 'ar'), 2360);
  assert.equal(await bal(c, 'output_cgst'), 180);
  assert.equal(await bal(c, 'cogs'), 1200);
  assert.equal(await bal(c, 'inventory'), 4800);

  // inter-state invoice: IGST
  const inv2 = await c.post('/documents/invoice', { contact_id: outCust.id, lines: [{ item_id: item.id, quantity: 1, rate: 1000, tax_id: c.tax('GST18') }], save_as: 'send' });
  assert.deepEqual(inv2.taxes.map((t) => t.name), ['IGST18']);

  // partial then full payment
  const p1 = await c.post('/payments/received', { contact_id: cust.id, amount: 1000, account_id: c.acc('undeposited_funds'), allocations: [{ document_id: inv.id, amount: 1000 }] });
  let d = await c.get(`/documents/invoice/${inv.id}`);
  assert.equal(d.balance, 1360);
  assert.equal(d.display_status, 'partially_paid');
  await c.post('/payments/received', { contact_id: cust.id, amount: 1500, allocations: [{ document_id: inv.id, amount: 1360 }] });
  d = await c.get(`/documents/invoice/${inv.id}`);
  assert.equal(d.display_status, 'paid');
  const credits = await c.get(`/contacts/${cust.id}/credits`);
  assert.equal(credits[0].balance, 140, 'excess payment becomes unused credit');

  // cannot delete a paid invoice
  const err = await c.call('DELETE', `/documents/invoice/${inv.id}`, null, { expectError: true });
  assert.equal(err.status, 400);
  await c.del(`/payments/received/${p1.id}`);
  d = await c.get(`/documents/invoice/${inv.id}`);
  assert.equal(d.balance, 1000);

  // pay the bill
  await c.post('/payments/made', { contact_id: vend.id, amount: 7080, account_id: c.acc('petty_cash'), allocations: [{ document_id: bill.id, amount: 7080 }] });
  assert.equal(await bal(c, 'ap'), 0);
  assert.ok(await trialBalanced(c));
});

test('credit note applied and refunded', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Credit Cust' });
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Consulting', quantity: 1, rate: 5000 }], save_as: 'send' });
  const cn = await c.post('/documents/creditnote', { contact_id: cust.id, lines: [{ name: 'Discount', quantity: 1, rate: 1500 }], save_as: 'open' });
  assert.equal(cn.status, 'open');
  await c.post('/credits/apply', { source_type: 'creditnote', source_id: cn.id, applications: [{ document_id: inv.id, amount: 1000 }] });
  const d = await c.get(`/documents/invoice/${inv.id}`);
  assert.equal(d.balance, 4000);
  await c.post('/refunds', { source_type: 'creditnote', source_id: cn.id, amount: 500, account_id: c.acc('petty_cash') });
  const cn2 = await c.get(`/documents/creditnote/${cn.id}`);
  assert.equal(cn2.display_status, 'closed');
  assert.ok(await trialBalanced(c));
});

test('quote → sales order → invoice conversion and approvals', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Quote Cust' });
  const q = await c.post('/documents/quote', { contact_id: cust.id, lines: [{ name: 'Widget', quantity: 3, rate: 100 }], discount_type: 'percent', discount_value: 10 });
  assert.equal(q.total, 270);
  await c.post(`/documents/quote/${q.id}/action/send`);
  await c.post(`/documents/quote/${q.id}/action/accept`);
  const so = await c.post(`/documents/quote/${q.id}/convert`, { to: 'salesorder' });
  assert.equal(so.doc_type, 'salesorder');
  await c.put('/org/settings', { approvals: { invoice: true } });
  const inv = await c.post(`/documents/salesorder/${so.id}/convert`, { to: 'invoice' });
  const pending = await c.post(`/documents/invoice/${inv.id}/action/mark_sent`);
  assert.equal(pending.status, 'pending_approval');
  const approved = await c.post(`/documents/invoice/${inv.id}/action/approve`);
  assert.equal(approved.status, 'open');
  await c.put('/org/settings', { approvals: { invoice: false } });
  assert.equal((await c.get(`/documents/salesorder/${so.id}`)).status, 'invoiced');
});

test('expenses, journals, transaction lock', async () => {
  const e = await c.post('/expenses', { date: '2026-05-01', account_id: c.acc('rent'), paid_through_id: c.acc('petty_cash'), amount: 11800, tax_id: c.tax('GST18'), tax_inclusive: 1 });
  assert.equal(e.total, 11800);
  assert.equal(e.tax_amount, 1800);
  const j = await c.post('/journals', { date: '2026-05-02', notes: 'Owner capital', lines: [
    { account_id: c.acc('petty_cash'), debit: 50000 }, { account_id: c.acc('owners_equity'), credit: 50000 }] });
  assert.equal(j.total, 50000);
  const bad = await c.call('POST', '/journals', { lines: [{ account_id: c.acc('petty_cash'), debit: 10 }, { account_id: c.acc('sales'), credit: 5 }] }, { expectError: true });
  assert.match(bad.error, /must be equal/);
  await c.put('/org', { lock_date: '2026-05-31' });
  const locked = await c.call('PUT', `/expenses/${e.id}`, { amount: 100 }, { expectError: true });
  assert.match(locked.error, /locked/);
  await c.put('/org', { lock_date: '' });
  assert.ok(await trialBalanced(c));
});

test('assistant answers and creates contacts', async () => {
  const r = await c.post('/assistant', { q: 'What are my total receivables?' });
  assert.match(r.text, /receivables are/);
  const cr = await c.post('/assistant', { q: 'Create customer Nova Labs' });
  assert.match(cr.text, /Created customer "Nova Labs"/);
  const list = await c.get('/contacts?type=customer&q=Nova');
  assert.equal(list.length, 1);
  const s = await c.get('/search?q=Nova');
  assert.ok(s.results.some((x) => x.title === 'Nova Labs'));
});

test('recurring invoice profile generates invoices', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Subscriber' });
  const start = new Date(Date.now() - 65 * 86400000).toISOString().slice(0, 10);
  const prof = await c.post('/documents/recurring_invoice', { contact_id: cust.id, date: start, lines: [{ name: 'Hosting', quantity: 1, rate: 999 }], recurrence: { frequency: 'monthly', every: 1, start_date: start, auto_send: true } });
  assert.equal(prof.status, 'active');
  const r = await c.post('/recurring/run');
  assert.ok(r.created >= 2);
  const list = await c.get(`/documents/invoice?contact_id=${cust.id}`);
  assert.equal(list.total, r.created);
  assert.ok(list.rows.every((x) => x.status === 'open'));
});
