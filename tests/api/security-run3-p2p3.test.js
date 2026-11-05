// Regression tests for the third-pass run-3 security fixes (parts 2 and 3): invoice approvals gate emails and reminders,
// quote conversion needs no sales:edit, credit dates are canonical and locked, foreign taxes are refused on lines, payment
// search escapes wildcards, invoiced expenses keep their amount, contact money and opening balances need their rights,
// statements and account types are guarded, bank matching hides documents from banking-only roles, reconciliation toggles
// de-duplicate, the activity and dashboard feeds respect reports rights, timesheet roles see no project money, logout
// revokes tokens, query-string tokens are limited to file downloads, responses frame-deny, and date formats are bounded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer(); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;

let seq = 0;
const newEmail = () => `run3p2p3_${++seq}_${Date.now()}@p2p3.test`;

/** Create a custom role in org a with the given permissions. */
const makeRole = (permissions) => a.post('/roles', { name: `Run3 P2P3 role ${++seq} ${Date.now()}`, permissions });

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
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run3 P2P3 service', quantity: 1, rate: 100 }], save_as: 'send' });
  return { cust, inv };
}

test('an invoice awaiting approval cannot be emailed and a draft cannot be reminded', async () => {
  await a.put('/org/settings', { approvals: { invoice: true } });
  try {
    const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 approval mail check' });
    const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Needs approval', quantity: 1, rate: 40 }], save_as: 'send' });
    assert.equal(inv.status, 'pending_approval', 'the invoice waits for approval');
    assert.equal(await status(a, 'POST', `/documents/invoice/${inv.id}/email`, { to: 'customer@p2p3.test', subject: 'Run3', body: 'x' }), 400);
    const sent = await a.get(`/emails?entity_type=document&entity_id=${inv.id}`);
    assert.equal(sent.length, 0, 'no email is recorded for the pending invoice');

    const draft = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Still a draft', quantity: 1, rate: 40 }] });
    assert.equal(draft.status, 'draft');
    assert.equal(await status(a, 'POST', `/documents/invoice/${draft.id}/remind`, {}), 400);
  } finally {
    await a.put('/org/settings', { approvals: { invoice: false } });
  }
});

test('converting a quote to an invoice needs no sales:edit, and the quote keeps its status', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 quote convert check' });
  const quote = await a.post('/documents/quote', { contact_id: cust.id, lines: [{ name: 'Quoted work', quantity: 1, rate: 300 }], save_as: 'send' });
  const before = await a.get(`/documents/quote/${quote.id}`);
  const s = await member(await makeRole({ sales: ['view', 'create'] }), newEmail());
  const inv = await s.post(`/documents/quote/${quote.id}/convert`, { to: 'invoice' });
  assert.equal(inv.doc_type, 'invoice', 'the invoice is created');
  assert.ok(inv.id, 'the new invoice has an id');
  const after = await a.get(`/documents/quote/${quote.id}`);
  assert.equal(after.status, before.status, 'the quote status is unchanged');
  assert.notEqual(after.status, 'invoiced');
});

test('apply credits rejects a malformed date and a date inside the lock period', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 credit date check' });
  const pay = await a.post('/payments/received', { contact_id: cust.id, amount: 100 });
  const body = (date) => ({ source_type: 'payment', source_id: pay.id, applications: [], date });
  assert.equal(await status(a, 'POST', '/credits/apply', body('2020-1-5')), 400, 'a non-ISO date is refused');
  await a.put('/org', { lock_date: '2026-01-31' });
  try {
    assert.equal(await status(a, 'POST', '/credits/apply', body('2026-01-15')), 400, 'a date before the lock date is refused');
  } finally {
    await a.put('/org', { lock_date: '' });
  }
});

test('an invoice line cannot use a tax from another org, and that tax can still be deleted in its own org', async () => {
  const b = await signup(srv.base);
  const foreign = await b.post('/taxes', { name: `Run3 P2P3 foreign tax ${Date.now()}`, rate: 5 });
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 foreign tax check' });
  assert.equal(await status(a, 'POST', '/documents/invoice', {
    contact_id: cust.id, lines: [{ name: 'Foreign tax', quantity: 1, rate: 10, tax_id: foreign.id }],
  }), 400);
  await b.del(`/taxes/${foreign.id}`);
  assert.ok(!(await b.get('/taxes')).some((t) => t.id === foreign.id), 'the unused tax in org B is deleted');
});

test('a payment search treats % literally and a very long search does not error', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 wildcard check' });
  const pay = await a.post('/payments/received', { contact_id: cust.id, amount: 25 });
  assert.ok(!pay.number.includes('%'), 'the stored payment number has no % character');
  const wild = await a.get('/payments/received?q=%25');
  assert.ok(Array.isArray(wild));
  assert.ok(!wild.some((p) => p.id === pay.id), 'a bare % does not match a payment number without one');
  const long = await a.get(`/payments/received?q=${'x'.repeat(150)}`);
  assert.ok(Array.isArray(long), 'a search longer than 100 characters is accepted');
});

test('an expense already billed on an invoice keeps its amount, but its notes can change', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 billed expense check' });
  const exp = await a.post('/expenses', {
    date: '2026-05-02', account_id: a.acc('travel'), paid_through_id: a.acc('petty_cash'), amount: 75,
    customer_id: cust.id, is_billable: 1,
  });
  await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Courier', quantity: 1, rate: 75, src_type: 'expense', src_id: exp.id }], save_as: 'send' });
  assert.ok((await a.get(`/expenses/${exp.id}`)).invoice_id, 'the expense is billed');
  assert.equal(await status(a, 'PUT', `/expenses/${exp.id}`, { amount: 90 }), 400);
  const noted = await a.put(`/expenses/${exp.id}`, { notes: 'Run3 P2P3 note' });
  assert.equal(noted.notes, 'Run3 P2P3 note');
  assert.equal((await a.get(`/expenses/${exp.id}`)).amount, 75, 'the stored amount is unchanged');
});

test('a contacts-only role sees no outstanding figures or credits on contacts', async () => {
  const { cust } = await customerWithInvoice('Run3 P2P3 contact figures');
  const s = await member(await makeRole({ contacts: ['view'] }), newEmail());
  const rows = await s.get('/contacts?type=customer');
  assert.ok(rows.length > 0, 'the customers are listed');
  assert.ok(rows.every((r) => r.outstanding === null), 'outstanding is null for every row');
  const adminOne = await a.get(`/contacts/${cust.id}`);
  assert.ok('outstanding' in adminOne && 'unused_credits' in adminOne, 'control: the Admin sees the figures');
  assert.ok((await a.get('/contacts?type=customer')).some((r) => r.outstanding !== null), 'control: the Admin list has figures');
  const one = await s.get(`/contacts/${cust.id}`);
  assert.ok(!('outstanding' in one), 'the contact has no outstanding figure');
  assert.ok(!('unused_credits' in one), 'the contact has no unused credits figure');
  assert.equal(await status(s, 'GET', `/contacts/${cust.id}/credits`), 403);
});

test('opening balances need accountant rights to create or change, and an unchanged one can be re-saved', async () => {
  const s = await member(await makeRole({ contacts: ['view', 'create', 'edit'] }), newEmail());
  const name = `Run3 P2P3 opening ${Date.now()}`;
  assert.equal(await status(s, 'POST', '/contacts', { type: 'customer', display_name: name, opening_balance: 500 }), 403);
  const admin = await a.post('/contacts', { type: 'customer', display_name: name, opening_balance: 500 });
  assert.equal(admin.opening_balance, 500, 'the Admin can create it with an opening balance');
  const saved = await s.put(`/contacts/${admin.id}`, { display_name: name, opening_balance: 500 });
  assert.ok(!('opening_balance' in saved), 'the AR figure is not returned to a role without sales view');
  assert.equal((await a.get(`/contacts/${admin.id}`)).opening_balance, 500, 'the unchanged opening balance is accepted and kept');
});

test('a contacts-only role without sales view cannot email a customer statement', async () => {
  const { cust } = await customerWithInvoice('Run3 P2P3 statement check');
  const s = await member(await makeRole({ contacts: ['view', 'edit'] }), newEmail());
  assert.equal(await status(s, 'POST', `/contacts/${cust.id}/statement/email`, { to: 'customer@p2p3.test' }), 403);
});

test('an accountant-only role cannot move a bank account to another type', async () => {
  const bank = await bankAccount();
  const s = await member(await makeRole({ accountant: ['view', 'edit', 'delete'] }), newEmail());
  assert.equal(await status(s, 'PUT', `/accounts/${bank.id}`, { type: 'other_current_asset' }), 403);
  const still = (await a.get('/accounts')).find((x) => x.id === bank.id);
  assert.equal(still.type, 'bank', 'the Admin still sees the bank type');
});

test('a banking-only role gets no document match suggestions for a deposit', async () => {
  const bank = await bankAccount();
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 deposit payer' });
  const amount = 123.45;
  const open = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Match me', quantity: 1, rate: amount }], save_as: 'send' });
  await a.post(`/banking/accounts/${bank.id}/import`, { rows: [{ date: '2026-11-05', description: 'Run3 P2P3 customer deposit', amount }] });
  const line = (await a.get(`/banking/accounts/${bank.id}/statement-lines`)).find((l) => l.description === 'Run3 P2P3 customer deposit');
  assert.ok(line, 'the deposit line was imported');
  const adminSuggest = await a.post(`/banking/statement-lines/${line.id}/match-suggestions`, {});
  assert.ok(adminSuggest.documents.some((d) => d.number === open.number), 'the Admin sees the matching invoice');
  const s = await member(await makeRole({ banking: ['view'] }), newEmail());
  const res = await s.post(`/banking/statement-lines/${line.id}/match-suggestions`, {});
  assert.deepEqual(res.documents, []);
});

test('a reconciliation toggle with a repeated ledger id works, and a bad end date is refused', async () => {
  const bank = await bankAccount();
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 recon payer' });
  await a.post('/payments/received', { contact_id: cust.id, amount: 60, account_id: bank.id });
  assert.equal(await status(a, 'POST', `/banking/accounts/${bank.id}/reconciliations`, { end_date: '2026-6-5', closing_balance: 0 }), 400);
  const rc = await a.post(`/banking/accounts/${bank.id}/reconciliations`, { end_date: '2026-12-31', closing_balance: 0 });
  const lid = rc.rows.find((r) => r.debit === 60 && r.credit === 0).id;
  assert.ok(lid, 'the payment is a ledger line of the bank account');
  const toggled = await a.post(`/banking/reconciliations/${rc.id}/toggle`, { ledger_ids: [lid, lid] });
  const row = toggled.rows.find((r) => r.id === lid);
  assert.equal(row.cleared, true, 'the ledger line is cleared');
  assert.equal(toggled.cleared_count, 1, 'the repeated id clears the line once');
});

test('the activity feed rejects a fractional entity id and hides contact rows from a reports-only role', async () => {
  assert.equal(await status(a, 'GET', '/activity?entity_type=payment&entity_id=5.5'), 400);
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run3 P2P3 activity check' });
  const adminRows = await a.get('/activity?entity_type=contact');
  assert.ok(adminRows.some((r) => r.entity_id === cust.id), 'the Admin sees the contact row');
  const s = await member(await makeRole({ reports: ['view'] }), newEmail());
  const rows = await s.get('/activity');
  assert.ok(Array.isArray(rows));
  assert.ok(!rows.some((r) => r.entity_type === 'contact'), 'no contact rows reach a reports-only role');
});

test('the dashboard is restricted for a role without reports view', async () => {
  const s = await member(await makeRole({ sales: ['view'] }), newEmail());
  const dash = await s.get('/dashboard');
  assert.equal(dash.restricted, true);
  const adminDash = await a.get('/dashboard');
  assert.notEqual(adminDash.restricted, true, 'the Admin gets the full dashboard');
});

test('a timesheet role sees no project rate or budget and only its own time entries', async () => {
  const s = await member(await makeRole({ projects: ['view'] }), newEmail());
  const roleUid = (await s.get('/auth/me')).user.id;
  const proj = await a.post('/projects', { name: 'Run3 P2P3 timesheet project', rate: 50, budget_amount: 1000 });
  await a.post(`/projects/${proj.id}/tasks`, { name: 'Priced task', rate: 80 });
  const adminEntry = await a.post('/time-entries', { project_id: proj.id, date: '2026-11-05', hours: 1 });
  const adminView = await a.get(`/projects/${proj.id}`);
  assert.equal(adminView.rate, 50, 'control: the Admin sees the rate');
  assert.equal(adminView.budget_amount, 1000, 'control: the Admin sees the budget');
  assert.ok(adminView.tasks.some((t) => t.rate === 80), 'control: the Admin sees task rates');
  const view = await s.get(`/projects/${proj.id}`);
  assert.ok(!('rate' in view), 'the project rate is hidden');
  assert.ok(!('budget_amount' in view), 'the project budget is hidden');
  assert.ok(view.tasks.length > 0 && view.tasks.every((t) => !('rate' in t)), 'task rates are hidden');
  const entries = await s.get('/time-entries');
  assert.ok(entries.every((e) => e.user_id === roleUid), 'only the caller entries are listed');
  assert.ok(!entries.some((e) => e.id === adminEntry.id), 'the Admin entry is not listed');
});

test('a logged-out token is refused, and logging in again works', async () => {
  const email = newEmail();
  const own = await signup(srv.base, email);
  assert.equal((await own.get('/auth/me')).user.email, email);
  await own.post('/auth/logout', {});
  assert.equal(await status(own, 'GET', '/auth/me'), 401, 'the old token no longer works');
  const login = await client(srv.base).post('/auth/login', { email, password: 'secret123' });
  const fresh = client(srv.base);
  fresh.st.token = login.token;
  assert.equal((await fresh.get('/auth/me')).user.email, email, 'a new login works');
});

test('a query-string token opens file downloads but not the API', async () => {
  const data = Buffer.from('query token file').toString('base64');
  const f = await a.post('/files', { name: 'run3-p2p3.txt', mime: 'text/plain', data, folder: 'receipts' });
  const api = await fetch(`${srv.base}/contacts?token=${a.st.token}&org_id=${a.st.org}`);
  assert.equal(api.status, 401, 'a query-string token is refused for the API');
  await api.text();
  const download = await fetch(`${srv.base}/files/${f.id}/download?token=${a.st.token}&org_id=${a.st.org}`);
  assert.equal(download.status, 200, 'the same token still downloads the file');
  assert.equal(await download.text(), 'query token file');
});

test('every response, including the SPA, is sent with X-Frame-Options DENY', async () => {
  const headers = { authorization: `Bearer ${a.st.token}`, 'x-org-id': String(a.st.org) };
  const api = await fetch(`${srv.base}/contacts`, { headers });
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  await api.text();
  const spa = await fetch(new URL('/', srv.base));
  assert.equal(spa.headers.get('x-frame-options'), 'DENY');
  await spa.text();
});

test('an organization date format longer than 20 characters is refused', async () => {
  assert.equal(await status(a, 'PUT', '/org', { date_format: 'D'.repeat(50) }), 400);
});
