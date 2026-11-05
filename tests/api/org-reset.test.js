// Clearing an organization's transactions: the books start again while settings, contacts, items and the chart of
// accounts stay. Opening balances stay unless asked, and no other organization is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client, trialBalanced } from './helpers.js';

let srv, a, other;
before(async () => { srv = await startServer({ OPENBOOKS_AUTH_RATE_LIMIT: '500' }); a = await signup(srv.base); other = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
const today = new Date().toISOString().slice(0, 10);
const orgName = async (cl) => (await cl.get('/meta')).org.name;

async function books(cl) {
  const cust = await cl.post('/contacts', { type: 'customer', display_name: `Reset cust ${Date.now()}`, opening_balance: 500 });
  const vend = await cl.post('/contacts', { type: 'vendor', display_name: `Reset vend ${Date.now()}` });
  const item = await cl.post('/items', { name: `Reset item ${Date.now()}`, type: 'goods', selling_price: 100, purchase_price: 60, track_inventory: 1, opening_stock: 10, opening_stock_rate: 60 });
  const inv = await cl.post('/documents/invoice', { contact_id: cust.id, lines: [{ item_id: item.id, quantity: 2, rate: 100 }], save_as: 'open' });
  await cl.post('/payments/received', { contact_id: cust.id, amount: 200, allocations: [{ document_id: inv.id, amount: 200 }] });
  const bill = await cl.post('/documents/bill', { contact_id: vend.id, lines: [{ name: 'Rent', quantity: 1, rate: 1000 }], save_as: 'open' });
  await cl.post('/payments/made', { contact_id: vend.id, amount: 1000, account_id: cl.acc('petty_cash'), allocations: [{ document_id: bill.id, amount: 1000 }] });
  await cl.post('/journals', { date: today, notes: 'Capital', lines: [{ account_id: cl.acc('petty_cash'), debit: 50 }, { account_id: cl.acc('owners_equity'), credit: 50 }] });
  await cl.post('/files', { name: 'receipt.txt', data: 'aGVsbG8=', entity_type: 'invoice', entity_id: inv.id });
  return { cust, vend, item, inv };
}

test('only an Admin who types the organization name can clear the transactions', async () => {
  assert.equal(await status(a, 'POST', '/org/reset-transactions', { confirm: 'wrong name' }), 400);
  assert.equal(await status(a, 'POST', '/org/reset-transactions', {}), 400);
  const role = await a.post('/roles', { name: `Settings all ${Date.now()}`, permissions: { settings: ['view', 'create', 'edit', 'delete'] } });
  const email = `reset_${Date.now()}@reset.test`;
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  assert.equal(await status(s, 'POST', '/org/reset-transactions', { confirm: await orgName(a) }), 400, 'not an Admin');
});

test('clearing keeps setup and opening balances, restarts numbering and lifts the lock', async () => {
  const { cust, vend, item } = await books(a);
  const otherInv = await books(other);
  await a.put('/org', { lock_date: today });
  const taxesBefore = (await a.get('/taxes')).length;

  const out = await a.post('/org/reset-transactions', { confirm: await orgName(a) });
  assert.ok(out.removed.documents >= 2 && out.removed.payments >= 2 && out.removed.journals >= 1, JSON.stringify(out.removed));

  assert.equal((await a.get('/documents/invoice')).total, 0);
  assert.equal((await a.get('/documents/bill')).total, 0);
  assert.equal((await a.get('/payments/received')).length, 0);
  assert.equal((await a.get('/payments/made')).length, 0);
  assert.equal((await a.get('/files')).filter((f) => f.entity_type === 'invoice').length, 0, 'invoice attachments are gone');
  // setup stays
  assert.ok(await a.get(`/contacts/${cust.id}`));
  assert.ok(await a.get(`/contacts/${vend.id}`));
  assert.equal((await a.get(`/items/${item.id}`)).opening_stock, 10);
  assert.equal((await a.get('/taxes')).length, taxesBefore);
  // opening balances stay in the ledger, and it still balances
  assert.equal((await a.get(`/contacts/${cust.id}`)).outstanding, 500);
  assert.ok(await trialBalanced(a));
  // numbering restarts and the lock date is gone, so a new invoice for today is INV-00001
  assert.equal((await a.get('/meta')).org.lock_date, null);
  const fresh = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'New start', quantity: 1, rate: 10 }], save_as: 'open' });
  assert.equal(fresh.number, 'INV-00001');

  // the other organization still has its books
  assert.equal((await other.get('/payments/received')).length, 1);
  assert.equal((await other.get(`/files?entity_type=invoice&entity_id=${otherInv.inv.id}`)).length, 1);
});

test('opening balances can be cleared as well', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: `Opening ${Date.now()}`, opening_balance: 300 });
  const item = await a.post('/items', { name: `Opening item ${Date.now()}`, type: 'goods', track_inventory: 1, opening_stock: 4, opening_stock_rate: 25 });
  await a.post('/org/reset-transactions', { confirm: await orgName(a), clear_opening_balances: true });
  assert.equal((await a.get(`/contacts/${cust.id}`)).outstanding, 0);
  assert.equal((await a.get(`/items/${item.id}`)).opening_stock, 0);
  const accounts = await a.get('/accounts');
  assert.ok(accounts.every((x) => !x.debit && !x.credit), 'the ledger is empty');
});
