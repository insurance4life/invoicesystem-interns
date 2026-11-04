// Regression tests for the third-pass run-2 security fixes: comment ids must be whole numbers, incoming webhook text is
// capped, the file library hides attachments whose record the caller cannot see, contact transactions, statements and
// item detail respect the sales/purchases view rights, project cost rates and totals are hidden without reports:view,
// project edits keep stored cost rates, and projects and price lists in use cannot be deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer(); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;

let seq = 0;
const newEmail = () => `run2p3_${++seq}_${Date.now()}@p3.test`;

/** Create a custom role in org a with the given permissions. */
const makeRole = (permissions) => a.post('/roles', { name: `Run2 P3 role ${++seq} ${Date.now()}`, permissions });

/** Invite a brand-new account into a's org with the given role and return a client signed in as them. */
async function member(role, email) {
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  return s;
}

const b64 = (s) => Buffer.from(s).toString('base64');

test('comments on a document need a whole-number record id', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Comment Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Commented', quantity: 1, rate: 20 }], save_as: 'send' });
  assert.equal(await status(a, 'POST', '/comments', { entity_type: 'document', entity_id: inv.id + 0.5, text: 'fractional' }), 400);
  const ok = await a.post('/comments', { entity_type: 'document', entity_id: inv.id, text: 'whole number' });
  assert.equal(ok.entity_id, inv.id);
  const stored = await a.get(`/comments?entity_type=document&entity_id=${inv.id}`);
  assert.ok(stored.some((c) => c.text === 'whole number' && c.entity_id === inv.id));
});

test('incoming webhook text is capped at 5000 characters in the activity log', async () => {
  const hook = await a.post('/automation/incoming-webhooks', { name: 'Run2 P3 cap hook', module: 'document' });
  assert.ok(hook.token, 'the created webhook returns its token');
  const res = await a.post(`/public/hooks/${hook.token}`, { text: 'x'.repeat(20000) });
  assert.equal(res.ok, true);
  const rows = await a.get('/activity?limit=50');
  const newest = rows.find((r) => r.action === 'incoming webhook');
  assert.ok(newest, 'the webhook wrote an activity entry');
  const detail = typeof newest.detail === 'string' ? JSON.parse(newest.detail) : newest.detail;
  assert.equal(detail.hook, 'Run2 P3 cap hook');
  assert.ok(detail.text.length <= 5000, `text length ${detail.text.length} should be <= 5000`);
});

test('the file library hides a file attached to a bill from a user without purchases view', async () => {
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Library Vendor' });
  const bill = await a.post('/documents/bill', { contact_id: vend.id, lines: [{ name: 'Supplies', quantity: 1, rate: 30 }], save_as: 'send' });
  const attached = await a.post('/files', { name: 'Bill receipt.txt', data: `data:text/plain;base64,${b64('receipt')}`, entity_type: 'document', entity_id: bill.id });
  const loose = await a.post('/files', { name: 'Loose note.txt', data: `data:text/plain;base64,${b64('note')}` });
  const s = await member(await makeRole({ documents: ['view'] }), newEmail());
  const ids = (await s.get('/files')).map((f) => f.id);
  assert.ok(!ids.includes(attached.id), 'the bill attachment must not be listed');
  assert.ok(ids.includes(loose.id), 'an unattached library file is still listed');
});

test('contact transactions are empty for a contacts-only role and the vendor statement is refused', async () => {
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Contacts Only Vendor' });
  await a.post('/documents/bill', { contact_id: vend.id, lines: [{ name: 'Rent', quantity: 1, rate: 500 }], save_as: 'send' });
  await a.post('/expenses', { date: '2026-03-01', account_id: a.acc('travel'), paid_through_id: a.acc('petty_cash'), amount: 40, vendor_id: vend.id });
  const adminTx = await a.get(`/contacts/${vend.id}/transactions`);
  assert.ok(adminTx.documents.length > 0 && adminTx.expenses.length > 0, 'the admin sees the vendor history');
  const s = await member(await makeRole({ contacts: ['view'] }), newEmail());
  const tx = await s.get(`/contacts/${vend.id}/transactions`);
  assert.deepEqual(tx.documents, []);
  assert.deepEqual(tx.payments, []);
  assert.deepEqual(tx.expenses, []);
  assert.equal(await status(s, 'GET', `/contacts/${vend.id}/statement`), 403);
});

test('item detail lists no transactions for a user without sales or purchases view', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Item Customer' });
  const item = await a.post('/items', { name: 'Run2 P3 widget', rate: 15 });
  await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ item_id: item.id, quantity: 2, rate: 15 }], save_as: 'send' });
  assert.ok((await a.get(`/items/${item.id}`)).transactions.length > 0, 'the admin sees the item on an invoice');
  const s = await member(await makeRole({ items: ['view'] }), newEmail());
  const detail = await s.get(`/items/${item.id}`);
  assert.deepEqual(detail.transactions, []);
});

test('project profit, cost and cost rates are hidden without reports view but shown to the Admin', async () => {
  const adminUid = (await a.get('/auth/me')).user.id;
  const proj = await a.post('/projects', { name: 'Run2 P3 hidden costs', users: [{ user_id: adminUid, rate: 1000, cost_rate: 400 }] });
  const s = await member(await makeRole({ projects: ['view'] }), newEmail());
  const view = await s.get(`/projects/${proj.id}`);
  for (const k of ['profit', 'cost', 'labor_cost']) assert.ok(!(k in view.totals), `totals must not include ${k}`);
  assert.ok(view.users.every((u) => !('cost_rate' in u)), 'project users must not include cost_rate');
  const listed = (await s.get('/projects')).find((p) => p.id === proj.id);
  assert.ok(listed, 'the project is listed');
  assert.ok(listed.users.every((u) => !('cost_rate' in u)), 'listed project users must not include cost_rate');
  const adminView = await a.get(`/projects/${proj.id}`);
  assert.ok('profit' in adminView.totals && 'cost' in adminView.totals && 'labor_cost' in adminView.totals);
  assert.equal(adminView.users[0].cost_rate, 400);
});

test('a project edit by a timesheet-style role keeps the stored cost rates', async () => {
  const adminUid = (await a.get('/auth/me')).user.id;
  const proj = await a.post('/projects', { name: 'Run2 P3 keep rates', users: [{ user_id: adminUid, rate: 1000, cost_rate: 400 }] });
  const s = await member(await makeRole({ projects: ['view', 'edit'] }), newEmail());
  const seen = await s.get(`/projects/${proj.id}`);
  const res = await s.put(`/projects/${proj.id}`, { description: 'Updated by the timesheet role', users: seen.users });
  assert.equal(res.description, 'Updated by the timesheet role');
  const adminView = await a.get(`/projects/${proj.id}`);
  assert.equal(adminView.users[0].cost_rate, 400, 'the stored cost rate is unchanged');
});

test('a project with an expense cannot be deleted and the expense keeps its project', async () => {
  const proj = await a.post('/projects', { name: 'Run2 P3 used project' });
  const exp = await a.post('/expenses', { date: '2026-04-02', account_id: a.acc('travel'), paid_through_id: a.acc('petty_cash'), amount: 75, project_id: proj.id });
  assert.equal(await status(a, 'DELETE', `/projects/${proj.id}`), 400);
  const kept = (await a.get('/expenses')).find((e) => e.id === exp.id);
  assert.equal(kept.project_id, proj.id);
});

test('a price list cannot be deleted while a contact uses it', async () => {
  const pl = await a.post('/price-lists', { name: 'Run2 P3 wholesale' });
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Price List Customer', price_list_id: pl.id });
  assert.equal(await status(a, 'DELETE', `/price-lists/${pl.id}`), 400);
  await a.put(`/contacts/${cust.id}`, { price_list_id: null });
  const res = await a.del(`/price-lists/${pl.id}`);
  assert.equal(res.ok, true);
});
