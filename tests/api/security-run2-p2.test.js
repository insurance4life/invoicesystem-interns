// Regression tests for the second-pass run-2 security fixes: document convert and clone rights, contact credit and
// statement-email sides, opening-balance rights, guards on deleting contacts and accounts, request size caps, bounded
// search, paginated document lists, org setting limits and the email action in workflow rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer(); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
const errorOf = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).error;

let seq = 0;
const newEmail = () => `run2p2_${++seq}_${Date.now()}@p2.test`;

/** Create a custom role in org a with the given permissions. */
const makeRole = (permissions) => a.post('/roles', { name: `Run2 P2 role ${++seq} ${Date.now()}`, permissions });

/** Invite a brand-new account into a's org with the given role and return a client signed in as them. */
async function member(role, email) {
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  return s;
}

test('converting a sales order needs view on the source module', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Convert Customer' });
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Convert Vendor' });
  const so = await a.post('/documents/salesorder', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send' });
  const buyer = await member(await makeRole({ purchases: ['view', 'create'] }), newEmail());
  assert.equal(await status(buyer, 'POST', `/documents/salesorder/${so.id}/convert`, { to: 'purchaseorder', contact_id: vend.id }), 403);
  await a.post(`/documents/salesorder/${so.id}/convert`, { to: 'purchaseorder', contact_id: vend.id });
});

test('cloning a document needs view on its module, not just create', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Clone Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Work', quantity: 1, rate: 50 }], save_as: 'send' });
  const s = await member(await makeRole({ sales: ['create'] }), newEmail());
  assert.equal(await status(s, 'POST', `/documents/invoice/${inv.id}/clone`), 403);
});

test('contact credits and open documents are checked on the matching side', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Side Customer' });
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Side Vendor' });
  const s = await member(await makeRole({ sales: ['view'] }), newEmail());
  assert.equal(await status(s, 'GET', `/contacts/${vend.id}/credits`), 403);
  assert.equal(await status(s, 'GET', `/contacts/${vend.id}/open-documents`), 403);
  assert.ok(Array.isArray(await s.get(`/contacts/${cust.id}/credits`)));
});

test('emailing a statement needs contacts edit, not only view', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Statement Customer', email: 'st@x.test' });
  const s = await member(await makeRole({ contacts: ['view'] }), newEmail());
  assert.equal(await status(s, 'POST', `/contacts/${cust.id}/statement/email`, { to: 'x@y.test', subject: 's', body: 'b' }), 403);
});

test('opening balances need accountant rights for both read and write', async () => {
  const s = await member(await makeRole({ settings: ['view', 'edit'] }), newEmail());
  assert.equal(await status(s, 'GET', '/opening-balances'), 403);
  assert.equal(await status(s, 'PUT', '/opening-balances', { date: '2025-01-01', lines: [] }), 403);
});

test('a contact with posted journal lines cannot be deleted', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Posted Customer' });
  await a.post('/journals', { date: '2026-01-05', lines: [
    { account_id: a.acc('petty_cash'), debit: 10, contact_id: cust.id }, { account_id: a.acc('owners_equity'), credit: 10 }] });
  assert.equal(await status(a, 'DELETE', `/contacts/${cust.id}`), 400);
});

test('an account used by a draft journal cannot be deleted', async () => {
  const acct = await a.post('/accounts', { name: 'Draft only', type: 'expense' });
  await a.post('/journals', { date: '2026-01-06', status: 'draft', lines: [
    { account_id: acct.id, debit: 5 }, { account_id: a.acc('owners_equity'), credit: 5 }] });
  assert.equal(await status(a, 'DELETE', `/accounts/${acct.id}`), 400);
});

test('requests with too many lines or a non-list id set are refused', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Cap Customer' });
  const lines = Array.from({ length: 501 }, (_, i) => ({ name: `Line ${i + 1}`, quantity: 1, rate: 1 }));
  assert.equal(await status(a, 'POST', '/documents/invoice', { contact_id: cust.id, lines, save_as: 'send' }), 400);
  const bank = await a.post('/banking/accounts', { name: 'Cap Bank', type: 'bank' });
  assert.equal(await status(a, 'POST', `/banking/accounts/${bank.id}/statement-lines/bulk-categorize`, { ids: 'abc' }), 400);
});

test('search accepts a long query and treats % literally', async () => {
  const c = await signup(srv.base);
  await c.get(`/search?q=${'a'.repeat(300)}`);
  const res = await c.get('/search?q=%25');
  assert.equal(res.results.length, 0, 'no record in this new organization contains a percent sign');
});

test('document lists are paged in SQL and the page size is capped', async () => {
  const c = await signup(srv.base);
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Paging Customer' });
  for (let i = 1; i <= 3; i++) {
    await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: `Page ${i}`, quantity: 1, rate: 10 }], save_as: 'send' });
  }
  const page2 = await c.get('/documents/invoice?per_page=2&page=2');
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.total, 3);
  const big = await c.get('/documents/invoice?per_page=100000');
  assert.equal(big.per_page, 500);
});

test('org settings and lock dates are size and format checked', async () => {
  assert.equal(await status(a, 'PUT', '/org/settings', { blob: 'x'.repeat(70000) }), 400);
  assert.equal(await status(a, 'PUT', '/org', { lock_date: '20200615' }), 400);
});

test('a workflow rule that emails needs view on its module, while an Admin can create it', async () => {
  const s = await member(await makeRole({ settings: ['view', 'create'] }), newEmail());
  const rule = { name: 'Mail out', module: 'document', doc_type: 'invoice', trigger: 'created',
    actions: [{ type: 'email', to: 'x@y.test', subject: 's', body: 'b' }] };
  assert.equal(await status(s, 'POST', '/automation/rules', rule), 403);
  await a.post('/automation/rules', { ...rule, name: 'Mail out by admin' });
});

test('contact merge respects the sales-area lock of the documents it moves', async () => {
  const c = await signup(srv.base);
  const src = await c.post('/contacts', { type: 'customer', display_name: 'Merge Source' });
  const dst = await c.post('/contacts', { type: 'customer', display_name: 'Merge Target' });
  await c.post('/documents/invoice', { contact_id: src.id, date: '2026-01-10', lines: [{ name: 'Old work', quantity: 1, rate: 50 }], save_as: 'send' });
  await c.put('/org/settings', { locks: { sales: '2026-01-31' } });
  assert.match(await errorOf(c, 'POST', '/contacts/merge', { target_id: dst.id, source_ids: [src.id] }), /locked/);
});

test('a recurring expense profile stuck in a locked period does not stop the other profiles', async () => {
  const c = await signup(srv.base);
  const base = { account_id: c.acc('uncategorized'), paid_through_id: c.acc('petty_cash'), amount: 10, is_profile: 1 };
  const today = new Date().toISOString().slice(0, 10);
  await c.put('/org', { lock_date: '2020-06-30' });
  await c.post('/expenses', { ...base, date: '2020-01-01', recurrence: { frequency: 'monthly', every: 1, start_date: '2020-01-01' } });
  const later = await c.post('/expenses', { ...base, date: today, recurrence: { frequency: 'monthly', every: 1, start_date: today } });
  await srv.runJobs();
  const children = (await c.get('/expenses')).filter((e) => e.profile_id === later.id);
  assert.equal(children.length, 1, 'the second profile still generated its expense');
});
