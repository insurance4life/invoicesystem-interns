// Regression tests for the run-2 audit P1 fixes: org-creation and mail limits, the auth route matcher, date and
// record-kind lock bypasses, tenant scoping of parent accounts, inventory accounts, document actions, the outbox,
// invitation acceptance and project billing rights.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a, b;
before(async () => {
  srv = await startServer({ OPENBOOKS_MAX_ORGS_PER_USER: '2', OPENBOOKS_EMAIL_HOURLY_LIMIT: '6', OPENBOOKS_EMAIL_MAX_RECIPIENTS: '3' });
  a = await signup(srv.base);
  b = await signup(srv.base);
});
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
const errorOf = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).error;

/** Invite a brand-new account into a's org with the given role and return a client signed in as them. */
async function member(role, email) {
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  return s;
}

test('one account can own only a capped number of organizations, with bounded field sizes', async () => {
  const c = await signup(srv.base);
  assert.equal(await status(c, 'POST', '/auth/orgs', { name: 'x'.repeat(201) }), 400);
  await c.post('/auth/orgs', { name: 'Second Co' });
  assert.match(await errorOf(c, 'POST', '/auth/orgs', { name: 'Third Co' }), /at most 2 organizations/);
});

test('the auth throttle cannot be skipped with look-alike spellings of the login path', async () => {
  for (const p of ['/auth/log%C4%B1n', '/auth/login%0A', '/auth/%C5%BFignup']) {
    const res = await fetch(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"x@y.z","password":"nope"}' });
    // 401 'Please sign in' (no auth route matched) or 404 (Django's URL pattern already rejects a newline)
    assert.ok([401, 404].includes(res.status), `${p}: ${res.status}`);
    const text = await res.text();
    assert.ok(!/Invalid email or password|Name, email and password/.test(text), `${p} must not reach the login or signup handler`);
  }
});

test('mail limits count recipients per message and emails per sending user across organizations', async () => {
  const c = await signup(srv.base);
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Mail Customer', email: 'm@x.test' });
  const mail = (cl, id, to = 'm@x.test') => cl.call('POST', `/contacts/${id}/statement/email`, { to, subject: 'Statement', body: 'Hello' }, { expectError: false });
  assert.match(await errorOf(c, 'POST', `/contacts/${cust.id}/statement/email`, { to: 'a@x.test, b@x.test', cc: 'c@x.test; d@x.test', subject: 's', body: 'b' }),
    /at most 3 recipients/);
  for (let i = 0; i < 4; i++) await mail(c, cust.id);
  const second = await c.post('/auth/orgs', { name: 'Mail Co 2' });
  c.st.org = second.id;
  const cust2 = await c.post('/contacts', { type: 'customer', display_name: 'Other Customer', email: 'o@x.test' });
  await mail(c, cust2.id, 'o@x.test');
  await mail(c, cust2.id, 'o@x.test'); // 6th email from this user; the new org has sent only 2
  assert.match(await errorOf(c, 'POST', `/contacts/${cust2.id}/statement/email`, { to: 'o@x.test', subject: 's', body: 'b' }), /You have sent 6 emails/);
});

test('non-canonical dates are rejected instead of slipping past a lock', async () => {
  const c = await signup(srv.base);
  await c.put('/org', { lock_date: '2020-06-30' });
  const exp = { account_id: c.acc('uncategorized'), paid_through_id: c.acc('petty_cash'), amount: 10 };
  for (const date of ['20200615', '2020-6-15', '2020-06-30T00:00:00Z', '2020-06-45']) {
    assert.match(await errorOf(c, 'POST', '/expenses', { ...exp, date }), /Invalid date/, date);
  }
  assert.match(await errorOf(c, 'POST', '/expenses', { ...exp, date: '2020-06-15' }), /locked/);
  assert.equal(await status(c, 'POST', '/journals', { date: '2020/06/15', lines: [
    { account_id: c.acc('petty_cash'), debit: 5 }, { account_id: c.acc('owners_equity'), credit: 5 }] }), 400);
  await c.post('/expenses', { ...exp, date: '2020-07-01' }); // canonical, unlocked date still works
});

test('a body flag cannot claim a record is a profile or template to skip the lock', async () => {
  const c = await signup(srv.base);
  const j = await c.post('/journals', { date: '2020-05-10', lines: [
    { account_id: c.acc('petty_cash'), debit: 50 }, { account_id: c.acc('owners_equity'), credit: 50 }] });
  const e = await c.post('/expenses', { date: '2020-07-10', account_id: c.acc('uncategorized'), paid_through_id: c.acc('petty_cash'), amount: 20 });
  await c.put('/org', { lock_date: '2020-06-30' });
  assert.match(await errorOf(c, 'PUT', `/journals/${j.id}`, { journal_type: 'template', lines: j.lines }), /locked/);
  assert.match(await errorOf(c, 'PUT', `/expenses/${e.id}`, { is_profile: 1, date: '2020-06-10' }), /locked/);
});

test("an account's parent must belong to the same organization", async () => {
  const foreign = a.acc('petty_cash');
  assert.equal(await status(b, 'POST', '/accounts', { name: 'Child', type: 'expense', parent_id: foreign }), 400);
  const own = await b.post('/accounts', { name: 'Child ok', type: 'expense' });
  assert.equal(await status(b, 'PUT', `/accounts/${own.id}`, { parent_id: foreign }), 400);
});

test("an item's inventory account must be a Stock account", async () => {
  const c = await signup(srv.base);
  assert.match(await errorOf(c, 'POST', '/items', { name: 'Gadget', type: 'goods', track_inventory: 1, opening_stock: 10, opening_stock_rate: 100,
    inventory_account_id: c.acc('petty_cash') }), /Stock account/);
  const ok = await c.post('/items', { name: 'Gadget', type: 'goods', track_inventory: 1, opening_stock: 1, opening_stock_rate: 5 });
  assert.equal(ok.inventory_account_id, c.acc('inventory'));
});

test('fulfilment marks do not apply to invoices, so a paid invoice cannot be voided around its payments', async () => {
  const c = await signup(srv.base);
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Paid Customer' });
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Work', quantity: 1, rate: 100 }], save_as: 'send' });
  await c.post('/payments/received', { contact_id: cust.id, amount: 100, account_id: c.acc('undeposited_funds'), allocations: [{ document_id: inv.id, amount: 100 }] });
  for (const action of ['deliver', 'return', 'mark_invoiced']) {
    assert.equal(await status(c, 'POST', `/documents/invoice/${inv.id}/action/${action}`), 400, action);
  }
  assert.match(await errorOf(c, 'POST', `/documents/invoice/${inv.id}/action/void`), /Delete the payments/);
});

test('the outbox list only shows mail for records the member can view', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Outbox Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Work', quantity: 1, rate: 10 }], save_as: 'send' });
  await a.post(`/documents/invoice/${inv.id}/email`, { to: 'buyer@x.test', subject: 'Invoice', body: 'Pay here' });
  const s = await member(await a.post('/roles', { name: 'Settings viewer', permissions: { settings: ['view'] } }), `outbox${Date.now()}@test.dev`);
  const rows = await s.get('/emails');
  assert.ok(!rows.some((e) => e.entity_type === 'document'), 'no document mail without sales:view');
  assert.equal(await status(s, 'GET', `/emails?entity_type=document&entity_id=${inv.id}`), 403);
  assert.ok((await a.get('/emails')).some((e) => e.entity_type === 'document'), 'the Admin still sees it');
});

test('an invitation to an existing account takes effect only after that account accepts it', async () => {
  const email = `existing${Date.now()}@test.dev`;
  const x = await signup(srv.base, email);
  const role = (await a.get('/roles')).find((r) => r.name === 'Staff');
  await a.post('/users/invite', { email, role_id: role.id });
  const me = await x.get('/auth/me');
  assert.ok(!me.orgs.some((o) => o.id === a.st.org), 'not a member yet');
  assert.ok(me.invites.some((o) => o.id === a.st.org), 'the invitation is listed');
  const guest = client(srv.base);
  guest.st.token = x.st.token;
  guest.st.org = a.st.org;
  assert.equal(await status(guest, 'GET', '/contacts'), 403);
  const uid = (await a.get('/users')).find((u) => u.email === email).id;
  assert.match(await errorOf(a, 'PUT', `/users/${uid}`, { status: 'active' }), /not accepted/);
  await x.post(`/auth/invites/${a.st.org}/accept`);
  assert.ok(Array.isArray(await guest.get('/contacts')));
});

test('timesheet-only roles cannot delete tasks or change billing through a project edit', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Project Customer' });
  const p = await a.post('/projects', { name: 'Billing Project', customer_id: cust.id, billing_method: 'task_hours', rate: 100,
    tasks: [{ name: 'Design', rate: 50 }, { name: 'Build', rate: 80 }] });
  const s = await member((await a.get('/roles')).find((r) => r.name === 'Timesheet Staff'), `timesheet${Date.now()}@test.dev`);
  assert.equal(await status(s, 'PUT', `/projects/${p.id}`, { tasks: [] }), 403);
  assert.equal(await status(s, 'PUT', `/projects/${p.id}`, { rate: 1 }), 403);
  await s.put(`/projects/${p.id}`, { description: 'Updated notes', rate: 100 }); // unchanged billing is fine
  assert.equal((await a.get(`/projects/${p.id}`)).tasks.length, 2);
});
