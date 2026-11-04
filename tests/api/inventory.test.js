import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced, bal } from './helpers.js';

let srv, c;
before(async () => { srv = await startServer(); c = await signup(srv.base); });
after(() => srv.close());

const todayIso = () => new Date().toISOString().slice(0, 10);

test('contact import reports duplicates and bad GSTINs and posts opening balances', async () => {
  await c.post('/contacts', { type: 'customer', display_name: 'Existing Ltd' });
  const res = await c.post('/contacts/import', { type: 'customer', skip_duplicates: true, rows: [
    { display_name: 'Alpha Traders', email: 'alpha@x.test', gstin: '27AAPFU0939F1ZV', place_of_supply: 'Maharashtra', opening_balance: 1500, opening_balance_date: '2026-04-01', billing_city: 'Pune', billing_state: 'Maharashtra' },
    { display_name: 'existing ltd' },
    { display_name: 'Bad GST Co', gstin: '27AAPFU0939' },
    { display_name: 'Beta Foods', place_of_supply: '29' },
  ] });
  assert.equal(res.created, 2);
  assert.equal(res.skipped, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].row, 3);
  assert.match(res.errors[0].error, /GSTIN/);

  const list = await c.get('/contacts?type=customer&q=Alpha');
  assert.equal(list.length, 1);
  const alpha = await c.get(`/contacts/${list[0].id}`);
  assert.equal(alpha.outstanding, 1500);
  assert.equal(alpha.place_of_supply, '27');
  assert.equal(alpha.billing_address.city, 'Pune');
  assert.ok(await trialBalanced(c));
});

test('statement opening and closing balances match the AR balance', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Statement Cust', email: 's@x.test', opening_balance: 500, opening_balance_date: '2026-04-01' });
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, date: '2026-05-10', lines: [{ name: 'Service', quantity: 1, rate: 1000 }], save_as: 'send' });
  assert.equal(inv.status, 'open');
  await c.post('/payments/received', { contact_id: cust.id, date: '2026-05-20', amount: 400, account_id: c.acc('undeposited_funds'), allocations: [{ document_id: inv.id, amount: 400 }] });

  const st = await c.get(`/contacts/${cust.id}/statement?from=2026-05-01&to=2026-05-31`);
  assert.equal(st.opening_balance, 500);
  assert.deepEqual(st.rows.map((r) => r.type), ['Invoice', 'Payment Received']);
  assert.equal(st.rows[0].amount, 1000);
  assert.equal(st.rows[1].payments, 400);
  assert.equal(st.rows[1].balance, 1100);
  assert.equal(st.closing_balance, 1100);

  const full = await c.get(`/contacts/${cust.id}/statement`);
  const detail = await c.get(`/contacts/${cust.id}`);
  assert.equal(full.closing_balance, detail.outstanding);
  assert.equal(full.closing_balance, 1100);

  const mail = await c.post(`/contacts/${cust.id}/statement/email`, { to: 's@x.test', subject: 'Statement', body: 'Hello' });
  assert.equal(mail.ok, true);
  assert.ok(await trialBalanced(c));
});

test('merge moves documents and balances to the target and deletes the sources', async () => {
  const a = await c.post('/contacts', { type: 'customer', display_name: 'Merge A' });
  const b = await c.post('/contacts', { type: 'customer', display_name: 'Merge B', opening_balance: 300, opening_balance_date: '2026-03-01' });
  await c.post('/documents/invoice', { contact_id: b.id, date: '2026-06-01', lines: [{ name: 'Work', quantity: 1, rate: 700 }], save_as: 'send' });
  const arBefore = await bal(c, 'ar');
  await c.post('/contacts/merge', { target_id: a.id, source_ids: [b.id] });
  const gone = await c.call('GET', `/contacts/${b.id}`, null, { expectError: true });
  assert.equal(gone.status, 404);
  const merged = await c.get(`/contacts/${a.id}`);
  assert.equal(merged.outstanding, 1000);
  const docs = await c.get(`/documents/invoice?contact_id=${a.id}`);
  assert.equal(docs.total, 1);
  assert.equal(await bal(c, 'ar'), arBefore);
  assert.ok(await trialBalanced(c));
});

test('bulk deactivate and delete of unused contacts', async () => {
  const x = await c.post('/contacts', { type: 'vendor', display_name: 'Bulk X' });
  const y = await c.post('/contacts', { type: 'vendor', display_name: 'Bulk Y' });
  const r1 = await c.post('/contacts/bulk', { ids: [x.id, y.id], action: 'deactivate' });
  assert.equal(r1.done, 2);
  assert.equal((await c.get(`/contacts/${x.id}`)).is_active, 0);
  const r2 = await c.post('/contacts/bulk', { ids: [x.id], action: 'delete' });
  assert.equal(r2.done, 1);
  const bill = await c.post('/documents/bill', { contact_id: y.id, date: todayIso(), lines: [{ name: 'Rent', quantity: 1, rate: 100 }], save_as: 'open' });
  const r3 = await c.post('/contacts/bulk', { ids: [y.id], action: 'delete' });
  assert.equal(r3.done, 0);
  assert.equal(r3.failed.length, 1);
  assert.ok(bill.id);
});

test('items import with opening stock: inventory = sum(qty x rate)', async () => {
  const before = await bal(c, 'inventory');
  const res = await c.post('/items/import', { rows: [
    { name: 'Import A', sku: 'IMP-A', type: 'goods', unit: 'pcs', selling_price: 200, purchase_price: 120, track_inventory: true, opening_stock: 5, opening_stock_rate: 120 },
    { name: 'Import B', sku: 'IMP-B', type: 'goods', track_inventory: 'yes', opening_stock: 3.5, opening_stock_rate: 40 },
    { name: 'Import Svc', type: 'service', selling_price: 500, track_inventory: 1, opening_stock: 9 },
    { name: '' },
  ] });
  assert.equal(res.created, 3);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].row, 4);
  assert.equal(await bal(c, 'inventory') - before, 740, '5 x 120 + 3.5 x 40');
  const a = (await c.get('/items')).find((i) => i.sku === 'IMP-A');
  assert.equal(a.stock_on_hand, 5);
  assert.ok(await trialBalanced(c));
});

test('quantity adjustment -2 posts a loss and reduces stock; value adjustment revalues; delete reverses', async () => {
  const item = await c.post('/items', { name: 'Adj Widget', type: 'goods', selling_price: 100, purchase_price: 50, track_inventory: 1, opening_stock: 10, opening_stock_rate: 50 });
  const invBefore = await bal(c, 'inventory');
  const adj = await c.post('/inventory/adjustments', { mode: 'quantity', reason: 'Damaged goods', lines: [{ item_id: item.id, qty_change: -2 }] });
  assert.equal(adj.status, 'draft');
  assert.equal(await bal(c, 'inventory'), invBefore, 'drafts do not post');

  const done = await c.post(`/inventory/adjustments/${adj.id}/convert`);
  assert.equal(done.status, 'adjusted');
  assert.equal((await c.get(`/items/${item.id}`)).stock_on_hand, 8);
  assert.equal(await bal(c, 'inventory') - invBefore, -100, 'loss of 2 x 50');
  assert.equal(await bal(c, 'inventory_adjustment'), 100);
  assert.ok(await trialBalanced(c));

  const va = await c.post('/inventory/adjustments', { mode: 'value', reason: 'Inventory revaluation', lines: [{ item_id: item.id, new_value: 600 }] });
  await c.post(`/inventory/adjustments/${va.id}/convert`);
  const card = await c.get(`/inventory/stock?item_id=${item.id}`);
  assert.equal(card.stock_on_hand, 8);
  assert.equal(card.stock_value, 600);
  assert.equal(card.rows.length, 3);
  assert.equal(card.rows[2].src_type, 'inventory_adjustment');
  assert.equal(await bal(c, 'inventory') - invBefore, 200 - 100 + 0, 'value change of +200 from new value 600 on 400');
  assert.ok(await trialBalanced(c));

  await c.del(`/inventory/adjustments/${adj.id}`);
  assert.equal((await c.get(`/items/${item.id}`)).stock_on_hand, 10);
  assert.equal(await bal(c, 'inventory_adjustment'), -200, 'loss posting removed; only the later value gain remains');
  assert.ok(await trialBalanced(c));
});

test('adjustment cannot take stock negative', async () => {
  const item = await c.post('/items', { name: 'Short Item', type: 'goods', track_inventory: 1, opening_stock: 1, opening_stock_rate: 10 });
  const adj = await c.post('/inventory/adjustments', { mode: 'quantity', lines: [{ item_id: item.id, qty_change: -5 }] });
  const err = await c.call('POST', `/inventory/adjustments/${adj.id}/convert`, null, { expectError: true });
  assert.equal(err.status, 400);
  assert.match(err.error, /negative/);
});

test('price list GET shape and per-item / markup / markdown rates', async () => {
  const item = await c.post('/items', { name: 'Priced Item', type: 'goods', selling_price: 100, purchase_price: 60 });
  const pl = await c.post('/price-lists', { name: 'Wholesale', applies_to: 'sales', type: 'per_item', rounding: 'none', items: [{ item_id: item.id, rate: 80 }] });
  const got = await c.get(`/price-lists/${pl.id}`);
  assert.equal(got.id, pl.id);
  assert.equal(got.name, 'Wholesale');
  assert.equal(got.type, 'per_item');
  assert.equal(got.rounding, 'none');
  assert.equal(got.applies_to, 'sales');
  assert.deepEqual(got.items, [{ item_id: item.id, rate: 80 }]);
  assert.equal((await c.get(`/price-lists/${pl.id}/rate?item_id=${item.id}`)).rate, 80);

  const mk = await c.post('/price-lists', { name: 'Markup 10', applies_to: 'sales', type: 'markup', percentage: 10, rounding: 'nearest_whole', items: [] });
  assert.equal((await c.get(`/price-lists/${mk.id}/rate?item_id=${item.id}`)).rate, 110);

  const md = await c.post('/price-lists', { name: 'Markdown 15', applies_to: 'sales', type: 'markdown', percentage: 15, rounding: '.99', items: [] });
  assert.equal((await c.get(`/price-lists/${md.id}/rate?item_id=${item.id}`)).rate, 84.99);

  const list = await c.get('/price-lists');
  assert.ok(list.length >= 3);
});
