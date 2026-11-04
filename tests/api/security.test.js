// Regression tests for the security-audit fixes: tenant scoping of referenced ids, permission checks on
// outbox/email/role routes, credit sources, account lifecycle and the webhook destination policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a, b; // a = victim org, b = another tenant
before(async () => { srv = await startServer(); a = await signup(srv.base); b = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;

/** Invite a member into a's org with a role and return a client signed in as them (plus their user id). */
async function member(permissions, email) {
  const role = permissions === 'Admin'
    ? (await a.get('/roles')).find((r) => r.name === 'Admin')
    : await a.post('/roles', { name: `Role ${email}`, permissions });
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  return { s, id: inv.id, role, password: inv.temp_password };
}

test("another org's accounts, contacts and items are rejected on write", async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Victim Customer' });
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Victim Vendor' });
  const item = await a.post('/items', { name: 'Victim Item', type: 'service', selling_price: 100, purchase_price: 77 });
  const bCust = await b.post('/contacts', { type: 'customer', display_name: 'Own Customer' });

  // expense paid through another org's bank account, or naming another org's vendor
  assert.equal(await status(b, 'POST', '/expenses', { date: '2026-05-01', account_id: b.acc('uncategorized'), paid_through_id: a.acc('petty_cash'), amount: 100 }), 400);
  assert.equal(await status(b, 'POST', '/expenses', { date: '2026-05-01', account_id: b.acc('uncategorized'), paid_through_id: b.acc('petty_cash'), amount: 100, vendor_id: vend.id }), 400);
  // journal line naming another org's contact
  assert.equal(await status(b, 'POST', '/journals', { date: '2026-05-02', lines: [
    { account_id: b.acc('petty_cash'), debit: 10, contact_id: cust.id }, { account_id: b.acc('owners_equity'), credit: 10 }] }), 400);
  // invoice lines with another org's item or income account
  assert.equal(await status(b, 'POST', '/documents/invoice', { contact_id: bCust.id, lines: [{ item_id: item.id, quantity: 1, rate: 1 }] }), 400);
  assert.equal(await status(b, 'POST', '/documents/invoice', { contact_id: bCust.id, lines: [{ name: 'x', quantity: 1, rate: 1, account_id: a.acc('sales') }] }), 400);
  // item pointing at another org's account
  assert.equal(await status(b, 'POST', '/items', { name: 'Bad', type: 'service', sales_account_id: a.acc('sales') }), 400);

  // nothing landed in the victim's books
  const accs = await a.get('/accounts');
  assert.equal(accs.reduce((s, x) => s + x.debit + x.credit, 0), 0);
});

test("status toggles cannot reach another org's items or contacts", async () => {
  const item = await a.post('/items', { name: 'Toggle Item', type: 'service', selling_price: 5 });
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Toggle Customer' });
  assert.equal(await status(b, 'POST', `/items/${item.id}/status`, { active: false }), 404);
  assert.equal(await status(b, 'POST', `/contacts/${cust.id}/status`, { active: false }), 404);
  assert.equal((await a.get(`/items/${item.id}`)).is_active, 1);
  assert.equal((await a.get(`/contacts/${cust.id}`)).is_active, 1);
});

test("an invoice cannot claim another org's time entries", async () => {
  const me = (await a.get('/auth/me')).user;
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Project Customer' });
  const project = await a.post('/projects', { name: 'Victim Project', customer_id: cust.id, billing_method: 'task_hours', rate: 100,
    users: [{ user_id: me.id, rate: 100 }], tasks: [{ name: 'Work', rate: 100 }] });
  const entry = await a.post('/time-entries', { project_id: project.id, task_id: project.tasks[0].id, date: '2026-06-01', minutes: 60 });

  const bCust = await b.post('/contacts', { type: 'customer', display_name: 'Claimer' });
  await b.post('/documents/invoice', { contact_id: bCust.id, lines: [{ name: 'x', quantity: 1, rate: 1, src_type: 'time_entries', src_ids: [entry.id] }] });
  await b.post('/documents/invoice', { contact_id: bCust.id, lines: [{ name: 'y', quantity: 1, rate: 1, src_type: 'time', src_id: entry.id }] });

  const mine = (await a.get(`/time-entries?project_id=${project.id}`)).find((e) => e.id === entry.id);
  assert.equal(mine.invoice_id, null);
  await a.put(`/time-entries/${entry.id}`, { minutes: 90 }); // still editable, so not marked invoiced
});

test('the outbox, email preview and reminders need the matching permission', async () => {
  const { s } = await member({ projects: ['view', 'create', 'edit'] }, 'timesheet@test.dev');
  assert.equal(await status(s, 'GET', '/emails'), 403);

  const invite = (await a.get('/emails')).find((e) => e.to_addr === 'timesheet@test.dev');
  assert.ok(invite, 'invitation is in the outbox');
  assert.ok(!/temporary password: \S+/.test(invite.body), 'the stored copy does not carry the temporary password');

  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Mail Customer', email: 'm@test.dev' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send' });
  assert.equal(await status(s, 'GET', `/documents/invoice/${inv.id}/email`), 403);
  assert.equal(await status(s, 'POST', `/documents/invoice/${inv.id}/remind`, {}), 403);
  assert.equal(await status(s, 'GET', `/emails?entity_type=document&entity_id=${inv.id}`), 403);
  assert.equal(await status(a, 'GET', `/documents/bill/${inv.id}/email`), 400); // type mismatch
  assert.ok((await a.get(`/documents/invoice/${inv.id}/email`)).body.includes('/share/'), 'the owner still gets the preview');
});

test('settings rights cannot grant more access than the caller holds', async () => {
  const { s, id, role } = await member({ settings: ['view', 'create', 'edit'] }, 'settings@test.dev');
  const adminRole = (await a.get('/roles')).find((r) => r.name === 'Admin');
  const owner = (await a.get('/users')).find((u) => u.role === 'Admin');

  assert.equal(await status(s, 'PUT', `/users/${id}`, { role_id: adminRole.id }), 403);
  assert.equal(await status(s, 'POST', '/users/invite', { email: 'sock@test.dev', role_id: adminRole.id }), 403);
  assert.equal(await status(s, 'PUT', `/roles/${role.id}`, { permissions: { settings: ['view', 'create', 'edit'], sales: ['view'] } }), 403);
  assert.equal(await status(s, 'POST', '/roles', { name: 'Wider', permissions: { accountant: ['view'] } }), 403);
  assert.equal(await status(s, 'PUT', `/users/${owner.id}`, { status: 'inactive' }), 403);
  assert.ok((await s.post('/roles', { name: 'Narrower', permissions: { settings: ['view'] } })).id, 'a role within the caller\'s rights is fine');
});

test('credits and refunds only come from credit sources', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Credit Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send' });
  assert.equal(await status(a, 'POST', '/credits/apply', { source_type: 'invoice', source_id: inv.id, applications: [{ document_id: inv.id, amount: 100 }] }), 400);
  assert.equal(await status(a, 'POST', '/refunds', { source_type: 'invoice', source_id: inv.id, amount: 10, account_id: a.acc('petty_cash') }), 400);
  assert.equal((await a.get(`/documents/invoice/${inv.id}`)).balance, 100);
});

test('a deactivated Admin deleting their account leaves the organization intact', async () => {
  const { s, id } = await member('Admin', 'second-admin@test.dev');
  await a.put(`/users/${id}`, { status: 'inactive' });
  await s.del('/auth/me');
  assert.ok((await a.get('/meta')).accounts.length > 0, 'the organization still exists');
});

test('changing the account email needs the current password', async () => {
  const { s, password } = await member({ projects: ['view'] }, 'mover@test.dev');
  assert.equal(await status(s, 'PUT', '/auth/me', { email: 'moved@test.dev' }), 400);
  const out = await s.put('/auth/me', { email: 'moved@test.dev', current_password: password });
  assert.equal(out.user.email, 'moved@test.dev');
});

test('webhook rules cannot target private or loopback addresses', async () => {
  const rule = (url) => ({ name: 'Hook', module: 'contact', trigger: 'created', actions: [{ type: 'webhook', url, method: 'POST' }] });
  for (const url of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://[::1]/']) {
    assert.equal(await status(a, 'POST', '/automation/rules', rule(url)), 400, url);
  }
});
