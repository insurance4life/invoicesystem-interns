// Regression tests for the third-pass run-3 security fixes: the system Staff role has no accountant or reports rights,
// reactivating a member needs the right to grant their role, invites reveal temporary passwords only to an Admin, open
// invoices need sales:edit, exchange rates must be positive and fixed once paid, billable expenses stay with their first
// invoice, deposits reject repeats, contact merges need sales edit rights, adjustment and item accounts stay within
// their class, contact portal tokens and webhook secrets are hidden from read-only roles, and project pricing needs sales:create.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer(); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;

let seq = 0;
const newEmail = () => `run3p1_${++seq}_${Date.now()}@p1.test`;

/** Create a custom role in org a with the given permissions. */
const makeRole = (permissions) => a.post('/roles', { name: `Run3 P1 role ${++seq} ${Date.now()}`, permissions });

/** Invite a brand-new account into a's org with the given role and return a client signed in as them. */
async function member(role, email) {
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  return s;
}

/** The first bank account of org a (type 'bank'). */
const bankAccount = async () => (await a.get('/accounts')).find((x) => x.type === 'bank');

/** A customer contact with a single-line invoice saved by the Admin. */
async function customerWithInvoice(name) {
  const cust = await a.post('/contacts', { type: 'customer', display_name: name });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run3 P1 service', quantity: 1, rate: 100 }], save_as: 'send' });
  return { cust, inv };
}

test('the system Staff role holds no accountant or reports rights and cannot run P&L or post journals', async () => {
  const staffRole = (await a.get('/roles')).find((r) => r.name === 'Staff');
  assert.ok(staffRole, 'the org has a system Staff role');
  assert.ok(!('accountant' in staffRole.permissions), 'Staff must not hold accountant rights');
  assert.ok(!('reports' in staffRole.permissions), 'Staff must not hold reports rights');
  const s = await member(staffRole, newEmail());
  assert.equal(await status(s, 'GET', '/reports/profit-loss'), 403);
  assert.equal(await status(s, 'POST', '/journals', {}), 403);
});

test('a settings:edit role cannot reactivate a deactivated Accountant, but the Admin can', async () => {
  const accRole = (await a.get('/roles')).find((r) => r.name === 'Accountant');
  const accEmail = newEmail();
  const inv = await a.post('/users/invite', { name: accEmail, email: accEmail, role_id: accRole.id });
  await a.put(`/users/${inv.id}`, { status: 'inactive' });
  const s = await member(await makeRole({ settings: ['view', 'edit'] }), newEmail());
  assert.equal(await status(s, 'PUT', `/users/${inv.id}`, { status: 'active' }), 403);
  const still = (await a.get('/users')).find((u) => u.id === inv.id);
  assert.equal(still.status, 'inactive', 'the failed reactivation leaves the member inactive');
  const ok = await a.put(`/users/${inv.id}`, { status: 'active' });
  assert.equal(ok.status, 'active');
});

test('an invite reveals the temporary password only to the Admin, and a non-Admin invite still succeeds', async () => {
  const adminEmail = newEmail();
  const adminInv = await a.post('/users/invite', { name: adminEmail, email: adminEmail, role_id: (await makeRole({ contacts: ['view'] })).id });
  assert.equal(typeof adminInv.temp_password, 'string', 'the Admin sees the temporary password (no SMTP in tests)');

  const inviteRole = await makeRole({ contacts: ['view'] });
  const s = await member(await makeRole({ settings: ['view', 'create'], contacts: ['view'] }), newEmail());
  const newcomer = newEmail();
  const res = await s.post('/users/invite', { name: newcomer, email: newcomer, role_id: inviteRole.id });
  assert.ok(res.id, 'the non-Admin invite succeeds');
  assert.equal(res.email, newcomer);
  assert.ok(!('temp_password' in res), 'a non-Admin invite must not return a temporary password');
});

test('an open invoice needs sales:edit, but a draft invoice works with sales:create alone', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 open check' });
  const s = await member(await makeRole({ sales: ['create'] }), newEmail());
  const before = (await a.get('/documents/invoice')).total;
  assert.equal(await status(s, 'POST', '/documents/invoice', {
    contact_id: cust.id, lines: [{ name: 'Open attempt', quantity: 1, rate: 10 }], save_as: 'open',
  }), 403);
  assert.equal((await a.get('/documents/invoice')).total, before, 'no invoice is created by the refused request');

  const draft = await s.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Draft attempt', quantity: 1, rate: 10 }] });
  assert.equal(draft.status, 'draft');
});

test('an exchange rate must be positive, and it cannot change once a payment is applied', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 rate check' });
  assert.equal(await status(a, 'POST', '/documents/invoice', {
    contact_id: cust.id, lines: [{ name: 'Negative rate', quantity: 1, rate: 10 }], exchange_rate: -1,
  }), 400);

  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Paid later', quantity: 1, rate: 80 }], save_as: 'send' });
  await a.post('/payments/received', { contact_id: cust.id, amount: 30, allocations: [{ document_id: inv.id, amount: 30 }] });
  assert.equal(await status(a, 'PUT', `/documents/invoice/${inv.id}`, {
    contact_id: cust.id, lines: [{ name: 'Paid later', quantity: 1, rate: 80 }], exchange_rate: 1.5,
  }), 400);
  const kept = await a.get(`/documents/invoice/${inv.id}`);
  assert.equal(kept.exchange_rate, 1, 'the stored rate is unchanged');
});

test('an expense billed to one invoice is not re-linked when a second invoice for the customer includes it', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 billable check' });
  const exp = await a.post('/expenses', {
    date: '2026-05-02', account_id: a.acc('travel'), paid_through_id: a.acc('petty_cash'), amount: 75,
    customer_id: cust.id, is_billable: 1,
  });
  const line = [{ name: 'Courier', quantity: 1, rate: 75, src_type: 'expense', src_id: exp.id }];
  const invA = await a.post('/documents/invoice', { contact_id: cust.id, lines: line, save_as: 'send' });
  assert.equal((await a.get(`/expenses/${exp.id}`)).invoice_id, invA.id, 'the first invoice bills the expense');
  await a.post('/documents/invoice', { contact_id: cust.id, lines: line, save_as: 'send' });
  assert.equal((await a.get(`/expenses/${exp.id}`)).invoice_id, invA.id, 'the expense still belongs to the first invoice');
});

test('a deposit lists the same received payment only once', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 deposit check' });
  const pay = await a.post('/payments/received', { contact_id: cust.id, amount: 60 });
  assert.equal(await status(a, 'POST', '/banking/deposits', {
    account_id: (await bankAccount()).id, payment_ids: [pay.id, pay.id],
  }), 400);
  const undeposited = (await a.get('/banking/undeposited')).find((p) => p.id === pay.id);
  assert.ok(undeposited, 'the payment is still waiting in Undeposited Funds');
});

test('a contacts-only role cannot merge a customer that has invoices', async () => {
  const { cust: source } = await customerWithInvoice('Run3 P1 merge source');
  const target = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 merge target' });
  const s = await member(await makeRole({ contacts: ['view', 'delete'] }), newEmail());
  assert.equal(await status(s, 'POST', '/contacts/merge', { target_id: target.id, source_ids: [source.id] }), 403);
  const still = await a.get(`/contacts/${source.id}`);
  assert.ok(still.id === source.id, 'the source contact is not merged away');
});

test('an items role cannot post an adjustment offset to a bank account, but the default offset works', async () => {
  const item = await a.post('/items', { name: 'Run3 P1 stock item', track_inventory: true });
  const bank = await bankAccount();
  const s = await member(await makeRole({ items: ['create'] }), newEmail());
  const body = (extra) => ({ mode: 'quantity', date: '2026-05-03', reason: 'count', lines: [{ item_id: item.id, qty_change: 1 }], ...extra });
  assert.equal(await status(s, 'POST', '/inventory/adjustments', body({ account_id: bank.id })), 400);
  const ok = await s.post('/inventory/adjustments', body({}));
  assert.ok(ok.id, 'the default adjustment account is accepted');
});

test('an items role cannot point an item sales account at a bank account, but the default works', async () => {
  const bank = await bankAccount();
  const s = await member(await makeRole({ items: ['create'] }), newEmail());
  assert.equal(await status(s, 'POST', '/items', { name: 'Run3 P1 bank-sales item', sales_account_id: bank.id }), 400);
  const ok = await s.post('/items', { name: 'Run3 P1 default-sales item', rate: 20 });
  assert.ok(ok.id, 'an item with the default sales account is created');
});

test('a contacts-only role gets no portal token, while the Admin does', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P1 portal check' });
  assert.ok(cust.portal_token, 'the Admin sees the portal token');
  const s = await member(await makeRole({ contacts: ['view'] }), newEmail());
  const seen = await s.get(`/contacts/${cust.id}`);
  assert.equal(seen.id, cust.id);
  assert.ok(!('portal_token' in seen), 'a contacts-only role must not see the portal token');
  const adminSeen = await a.get(`/contacts/${cust.id}`);
  assert.ok(adminSeen.portal_token, 'the Admin still sees the portal token');
});

test('a settings:create role cannot add a field-update workflow on contacts without contacts:edit', async () => {
  const s = await member(await makeRole({ settings: ['create', 'view'] }), newEmail());
  const rule = { name: 'Run3 P1 notes rule', module: 'contact', trigger: 'created', actions: [{ type: 'field_update', field: 'notes', value: 'x' }] };
  assert.equal(await status(s, 'POST', '/automation/rules', rule), 403);
  const admin = await a.post('/automation/rules', rule);
  assert.ok(admin.id, 'the Admin can create the same rule');
});

test('a settings:view role sees incoming webhooks without token or url, and webhook header values are masked', async () => {
  const hook = await a.post('/automation/incoming-webhooks', { name: 'Run3 P1 hook', module: 'contact' });
  assert.ok(hook.token && hook.url, 'the Admin sees the token and url');
  await a.post('/automation/rules', {
    name: 'Run3 P1 webhook rule', module: 'contact', trigger: 'created',
    actions: [{ type: 'webhook', url: 'https://example.com/run3-p1', method: 'POST', headers: { 'X-Api-Key': 'run3-secret-value' } }],
  });
  const s = await member(await makeRole({ settings: ['view'] }), newEmail());
  const hooks = (await s.get('/automation/incoming-webhooks')).filter((h) => h.name === 'Run3 P1 hook');
  assert.equal(hooks.length, 1);
  assert.ok(!('token' in hooks[0]), 'the webhook token is hidden');
  assert.ok(!('url' in hooks[0]), 'the webhook url is hidden');
  const adminHooks = (await a.get('/automation/incoming-webhooks')).find((h) => h.name === 'Run3 P1 hook');
  assert.ok(adminHooks.token, 'the Admin still sees the token');

  const rules = await s.get('/automation/rules');
  const rule = rules.find((r) => r.name === 'Run3 P1 webhook rule');
  assert.ok(rule, 'the read-only role can list the rule');
  assert.equal(rule.actions[0].headers['X-Api-Key'], '********', 'header values are masked for the read-only role');
  const adminRule = (await a.get('/automation/rules')).find((r) => r.name === 'Run3 P1 webhook rule');
  assert.equal(adminRule.actions[0].headers['X-Api-Key'], 'run3-secret-value', 'the Admin sees the header value');
});

test('a projects role without sales:create cannot price projects or tasks, but rate 0 works', async () => {
  const s = await member(await makeRole({ projects: ['view', 'create', 'edit'] }), newEmail());
  assert.equal(await status(s, 'POST', '/projects', { name: 'Run3 P1 priced project', rate: 50 }), 403);

  const proj = await a.post('/projects', { name: 'Run3 P1 task host' });
  assert.equal(await status(s, 'POST', `/projects/${proj.id}/tasks`, { name: 'Priced task', rate: 10 }), 403);

  const free = await s.post('/projects', { name: 'Run3 P1 free project', rate: 0 });
  assert.ok(free.id, 'a project with rate 0 is created');
  const task = await s.post(`/projects/${free.id}/tasks`, { name: 'Free task', rate: 0 });
  assert.ok(task.id, 'a task with rate 0 is created');
});
