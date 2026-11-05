// Regression tests for the fourth-pass security fixes (run 4): member reactivation needs the role's rights, name lengths are
// bounded, sales receipts and auto-sent recurring invoices need edit rights, invoice lines cannot post to bank accounts,
// cancelled invoices cannot be reminded, credit and refund deletes need the side's delete right, payment amounts are
// validated, contact money and email changes are gated, contact imports need accountant rights for opening balances,
// invoiced expenses are frozen, expense accounts are checked, bank accounts and bank postings are guarded, report rights are
// split, task rates are hidden, time edits return to approval, webhook urls are masked, portal quote and comment rules hold,
// and custom fields must be objects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
// This file invites about fifteen members, and each invite and sign-in counts against the per-address auth throttle (30 a minute by default).
before(async () => { srv = await startServer({ OPENBOOKS_AUTH_RATE_LIMIT: '500' }); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;

let seq = 0;
const newEmail = () => `run4_${++seq}_${Date.now()}@run4.test`;

/** Create a custom role in org a with the given permissions. */
const makeRole = (permissions) => a.post('/roles', { name: `Run4 role ${++seq} ${Date.now()}`, permissions });

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

/** A built-in role of org a by its name. */
const roleNamed = async (name) => (await a.get('/roles')).find((r) => r.name === name);

test('a settings:edit role without accountant rights cannot reactivate an Accountant member, and the Admin can', async () => {
  const accountant = await roleNamed('Accountant');
  const inv = await a.post('/users/invite', { name: 'Run4 inactive accountant', email: newEmail(), role_id: accountant.id });
  await a.put(`/users/${inv.id}`, { status: 'inactive' });
  const editor = await member(await makeRole({ settings: ['view', 'edit'] }), newEmail());
  assert.equal(await status(editor, 'PUT', `/users/${inv.id}`, { status: 'active', role_id: accountant.id }), 403);
  assert.equal((await a.get('/users')).find((u) => u.id === inv.id).status, 'inactive', 'the member is still inactive');

  const second = await a.post('/users/invite', { name: 'Run4 second accountant', email: newEmail(), role_id: accountant.id });
  await a.put(`/users/${second.id}`, { status: 'inactive' });
  const back = await a.put(`/users/${second.id}`, { status: 'active', role_id: accountant.id });
  assert.equal(back.status, 'active', 'control: the Admin can reactivate the same member');
});

test('a 300-character name is refused at sign-up and on profile update, and a normal name still saves', async () => {
  const long = 'N'.repeat(300);
  assert.equal(await status(client(srv.base), 'POST', '/auth/signup', {
    name: long, email: newEmail(), password: 'secret123', organization: { name: 'Run4 long name Co', state: '27' },
  }), 400);
  assert.equal(await status(a, 'PUT', '/auth/me', { name: long }), 400);
  await a.put('/auth/me', { name: 'Run4 Admin' });
  assert.equal((await a.get('/auth/me')).user.name, 'Run4 Admin', 'control: a normal name is saved');
});

test('a sales:create role cannot post a sales receipt or an auto-sending recurring invoice, but can save one without auto-send', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 receipt customer' });
  const s = await member(await makeRole({ sales: ['create'] }), newEmail());
  const lines = [{ name: 'Run4 receipt line', quantity: 1, rate: 50 }];
  const recurrence = (auto) => ({ frequency: 'monthly', every: 1, start_date: '2026-11-05', auto_send: auto });
  assert.equal(await status(s, 'POST', '/documents/salesreceipt', { contact_id: cust.id, lines, payment_mode: 'Cash' }), 403);
  assert.equal(await status(s, 'POST', '/documents/recurring_invoice', { contact_id: cust.id, lines, recurrence: recurrence(true) }), 403);
  const profile = await s.post('/documents/recurring_invoice', { contact_id: cust.id, lines, recurrence: recurrence(false) });
  assert.equal(profile.doc_type, 'recurring_invoice', 'the profile without auto-send is saved');

  const receipt = await a.post('/documents/salesreceipt', { contact_id: cust.id, lines, payment_mode: 'Cash' });
  assert.equal(receipt.doc_type, 'salesreceipt', 'control: the Admin can post the sales receipt');
  const auto = await a.post('/documents/recurring_invoice', { contact_id: cust.id, lines, recurrence: recurrence(true) });
  assert.equal(auto.recurrence.auto_send, true, 'control: the Admin can save an auto-sending profile');
});

test('an invoice line cannot use a bank account without accountant rights, and the Admin can', async () => {
  const bank = await bankAccount();
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 bank line customer' });
  const s = await member(await makeRole({ sales: ['view', 'create', 'edit'] }), newEmail());
  const lines = [{ name: 'Run4 bank line', quantity: 1, rate: 20, account_id: bank.id }];
  assert.equal(await status(s, 'POST', '/documents/invoice', { contact_id: cust.id, lines }), 400);
  const admin = await a.post('/documents/invoice', { contact_id: cust.id, lines });
  assert.equal(admin.lines[0].account_id, bank.id, 'control: the Admin can post the line to the bank account');
});

test('a cancelled invoice with a balance cannot be reminded, and a role without sales rights cannot read the next invoice number', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 remind customer', email: 'remind@run4.test' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 cancelled', quantity: 1, rate: 90 }], save_as: 'send' });
  await a.post(`/documents/invoice/${inv.id}/action/cancel`, {});
  assert.ok((await a.get(`/documents/invoice/${inv.id}`)).balance > 0, 'the cancelled invoice still has a balance');
  assert.equal(await status(a, 'POST', `/documents/invoice/${inv.id}/remind`, {}), 400);

  const open = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 open', quantity: 1, rate: 90 }], save_as: 'send' });
  assert.deepEqual(await a.post(`/documents/invoice/${open.id}/remind`, { to: 'remind@run4.test' }), { ok: true },
    'control: a sent unpaid invoice can be reminded');

  const s = await member(await makeRole({ contacts: ['view'] }), newEmail());
  assert.equal(await status(s, 'GET', '/documents/invoice/next-number'), 403);
  assert.ok((await a.get('/documents/invoice/next-number')).number, 'control: the Admin reads the next invoice number');
});

test('the Staff role cannot delete a refund or a credit application, and the Admin can', async () => {
  const staff = await roleNamed('Staff (Assigned Customers Only)');
  const bank = await bankAccount();
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 refund customer' });
  const pay = await a.post('/payments/received', { contact_id: cust.id, amount: 100, account_id: bank.id });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 credit target', quantity: 1, rate: 30 }], save_as: 'send' });
  const refund = await a.post('/refunds', { source_type: 'payment', source_id: pay.id, amount: 40, account_id: bank.id });
  await a.post('/credits/apply', { source_type: 'payment', source_id: pay.id, applications: [{ document_id: inv.id, amount: 30 }] });
  const applied = (await a.get(`/payments/received/${pay.id}`)).credits_applied[0];
  assert.ok(applied, 'the payment credit is applied to the invoice');

  const s = await member(staff, newEmail());
  assert.equal(await status(s, 'DELETE', `/refunds/${refund.id}`), 403);
  assert.equal(await status(s, 'DELETE', `/credits/${applied.id}`), 403);

  assert.deepEqual(await a.del(`/credits/${applied.id}`), { ok: true }, 'control: the Admin can remove the credit application');
  assert.deepEqual(await a.del(`/refunds/${refund.id}`), { ok: true }, 'control: the Admin can delete the refund');
});

test('a payment cannot go to an equity account, or carry a negative exchange rate or negative bank charges', async () => {
  const equity = (await a.get('/accounts')).find((x) => x.type === 'equity');
  const bank = await bankAccount();
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 payment guard customer' });
  const base = { contact_id: cust.id, amount: 45, account_id: bank.id };
  assert.equal(await status(a, 'POST', '/payments/received', { ...base, account_id: equity.id }), 400);
  assert.equal(await status(a, 'POST', '/payments/received', { ...base, exchange_rate: -1 }), 400);
  assert.equal(await status(a, 'POST', '/payments/received', { ...base, bank_charges: -5 }), 400);
  const ok = await a.post('/payments/received', base);
  assert.equal(ok.amount, 45, 'control: a valid payment to the bank account is recorded');
});

test('a contacts:edit role without sales view gets no portal token or money figures, and cannot change the email', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 contact edit customer', email: 'edit@run4.test', opening_balance: 250 });
  const s = await member(await makeRole({ contacts: ['view', 'edit'] }), newEmail());
  const edited = await s.put(`/contacts/${cust.id}`, { notes: 'Run4 notes only' });
  assert.equal(edited.notes, 'Run4 notes only', 'changing only notes works');
  for (const k of ['portal_token', 'outstanding', 'opening_balance']) assert.ok(!(k in edited), `${k} is not returned`);
  assert.equal(await status(s, 'PUT', `/contacts/${cust.id}`, { email: 'changed@run4.test' }), 403);
  assert.equal((await a.get(`/contacts/${cust.id}`)).email, 'edit@run4.test', 'the email is unchanged');

  const adminView = await a.get(`/contacts/${cust.id}`);
  assert.ok(adminView.portal_token && 'outstanding' in adminView, 'control: the Admin sees the portal token and figures');
  assert.equal(adminView.opening_balance, 250, 'control: the Admin sees the opening balance');
  assert.equal(await a.put(`/contacts/${cust.id}`, { email: 'changed@run4.test' }).then((c) => c.email), 'changed@run4.test',
    'control: the Admin can change the email');
});

test('a contact import row with an opening balance is not created for a contacts:create role without accountant rights', async () => {
  const s = await member(await makeRole({ contacts: ['view', 'create'] }), newEmail());
  const name = `Run4 import ${Date.now()}`;
  // The import reports each refused row instead of failing the request, so the refusal is in errors[].
  const res = await s.post('/contacts/import', { type: 'customer', rows: [{ display_name: name, opening_balance: 75 }] });
  assert.equal(res.created, 0, 'no contact is created');
  assert.equal(res.errors.length, 1, 'the row is reported as an error');
  assert.match(res.errors[0].error, /accountant/i);
  assert.equal((await a.get(`/contacts?type=customer&q=${encodeURIComponent(name)}`)).length, 0, 'the contact does not exist');

  const admin = await a.post('/contacts/import', { type: 'customer', rows: [{ display_name: name, opening_balance: 75 }] });
  assert.equal(admin.created, 1, 'control: the Admin imports the row with its opening balance');
});

test('an invoiced expense keeps its splits and mileage flag but its notes can change, and a purchases role cannot post to equity', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 billed expense customer' });
  const exp = await a.post('/expenses', {
    date: '2026-05-03', account_id: a.acc('travel'), paid_through_id: a.acc('petty_cash'), amount: 60, customer_id: cust.id, is_billable: 1,
  });
  await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 courier', quantity: 1, rate: 60, src_type: 'expense', src_id: exp.id }], save_as: 'send' });
  assert.ok((await a.get(`/expenses/${exp.id}`)).invoice_id, 'the expense is billed');
  const splits = [{ account_id: a.acc('travel'), amount: 60, description: 'Run4 split' }];
  for (const body of [{ splits }, { is_mileage: true }]) {
    const err = await a.call('PUT', `/expenses/${exp.id}`, body, { expectError: true });
    assert.equal(err.status, 400, `changing ${Object.keys(body)[0]} is refused`);
    assert.match(JSON.stringify(err), /invoiced/);
  }
  const noted = await a.put(`/expenses/${exp.id}`, { notes: 'Run4 billed note' });
  assert.equal(noted.notes, 'Run4 billed note', 'the notes change');
  const kept = await a.get(`/expenses/${exp.id}`);
  assert.equal(kept.amount, 60, 'the stored amount is unchanged');
  assert.ok(!kept.is_mileage, 'the mileage flag is unchanged');

  const equity = (await a.get('/accounts')).find((x) => x.type === 'equity');
  const s = await member(await makeRole({ purchases: ['view', 'create', 'edit'] }), newEmail());
  const body = { date: '2026-05-04', account_id: equity.id, paid_through_id: a.acc('petty_cash'), amount: 20 };
  assert.equal(await status(s, 'POST', '/expenses', body), 400);
  const adminOk = await a.post('/expenses', body);
  assert.equal(adminOk.account_id, equity.id, 'control: the Admin can post the expense to the equity account');
});

test('an accountant-only role cannot create a bank account in the chart, but can create other accounts', async () => {
  const s = await member(await makeRole({ accountant: ['view', 'create'] }), newEmail());
  const name = `Run4 bank ${Date.now()}`;
  assert.equal(await status(s, 'POST', '/accounts', { name, type: 'bank' }), 403);
  assert.equal((await s.post('/accounts', { name: `${name} expense`, type: 'expense' })).type, 'expense', 'control: a non-bank account is created');
  assert.equal((await a.post('/accounts', { name: `${name} admin`, type: 'bank' })).type, 'bank', 'control: the Admin can create a bank account');
});

test('a banking-only role cannot post a bank transaction against the receivables account, and the Admin can', async () => {
  const bank = await bankAccount();
  const ar = a.acc('ar');
  const s = await member(await makeRole({ banking: ['view', 'create'] }), newEmail());
  const body = { account_id: bank.id, date: '2026-11-05', txn_type: 'deposit', amount: 15, offset_account_id: ar, description: 'Run4 AR offset' };
  assert.equal(await status(s, 'POST', '/banking/transactions', body), 403);
  const admin = await a.post('/banking/transactions', body);
  assert.equal(admin.offset_account_id, ar, 'control: the Admin can post against receivables');
});

test('invoice details need sales view, while the profit and loss summary needs only reports view', async () => {
  const s = await member(await makeRole({ reports: ['view'] }), newEmail());
  assert.equal(await status(s, 'GET', '/reports/invoice-details'), 403);
  const pl = await s.get('/reports/profit-loss');
  assert.ok(pl && typeof pl === 'object', 'the profit and loss report loads for a reports-only role');
  assert.ok(await a.get('/reports/invoice-details'), 'control: the Admin loads invoice details');
});

test('a projects:view role sees no task rates, and an owner edit of a time entry sends it back for approval', async () => {
  const proj = await a.post('/projects', { name: 'Run4 rate project', rate: 50, budget_amount: 1000 });
  await a.post(`/projects/${proj.id}/tasks`, { name: 'Run4 priced task', rate: 80 });
  const viewer = await member(await makeRole({ projects: ['view'] }), newEmail());
  const tasks = await viewer.get(`/projects/${proj.id}/tasks`);
  assert.ok(tasks.length > 0 && tasks.every((t) => !('rate' in t)), 'no task row carries a rate');
  assert.ok((await a.get(`/projects/${proj.id}/tasks`)).some((t) => t.rate === 80), 'control: the Admin sees the task rate');

  const owner = await member(await makeRole({ projects: ['view', 'create', 'edit'] }), newEmail());
  const entry = await owner.post('/time-entries', { project_id: proj.id, date: '2026-11-05', hours: 1 });
  assert.equal(entry.approval_status, 'approved', 'a newly logged entry is approved');
  const edited = await owner.put(`/time-entries/${entry.id}`, { hours: 2 });
  assert.equal(edited.approval_status, 'pending', 'changing the time sends it back for approval');
});

test('a settings:view role sees a webhook url masked, and the Admin sees it in full', async () => {
  const url = 'https://hooks.example.com/run4/SECRET-PATH-4471';
  const rule = await a.post('/automation/rules', {
    name: `Run4 webhook ${Date.now()}`, module: 'contact', trigger: 'created', actions: [{ type: 'webhook', url, method: 'POST' }],
  });
  const s = await member(await makeRole({ settings: ['view'] }), newEmail());
  const seen = (await s.get('/automation/rules')).find((r) => r.id === rule.id);
  const masked = seen.actions[0].url;
  assert.ok(masked.includes('********'), 'the url is masked');
  assert.ok(!masked.includes('SECRET-PATH-4471'), 'the secret path is hidden');
  const full = (await a.get('/automation/rules')).find((r) => r.id === rule.id);
  assert.equal(full.actions[0].url, url, 'control: the Admin sees the full url');
});

test('a quote already converted to an invoice cannot be accepted online, and a bad share link is refused before its body', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 portal quote customer' });
  const quote = await a.post('/documents/quote', { contact_id: cust.id, lines: [{ name: 'Run4 quoted work', quantity: 1, rate: 200 }], save_as: 'send' });
  const quoteToken = (await a.get(`/documents/quote/${quote.id}`)).share_token;
  await a.post(`/documents/quote/${quote.id}/convert`, { to: 'invoice' });
  const pub = client(srv.base);
  assert.equal(await status(pub, 'POST', `/public/share/${quoteToken}/accept`, {}), 400);

  const open = await a.post('/documents/quote', { contact_id: cust.id, lines: [{ name: 'Run4 open quote', quantity: 1, rate: 200 }], save_as: 'send' });
  const openToken = (await a.get(`/documents/quote/${open.id}`)).share_token;
  assert.equal((await pub.post(`/public/share/${openToken}/accept`, {})).status, 'accepted', 'control: an unconverted sent quote can be accepted');

  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 pay link', quantity: 1, rate: 10 }], save_as: 'send' });
  const invToken = (await a.get(`/documents/invoice/${inv.id}`)).share_token;
  assert.equal(await status(pub, 'POST', '/public/share/not-a-real-token/pay', [{ amount: 1 }]), 404);
  assert.equal(await status(pub, 'POST', `/public/share/${invToken}/pay`, [{ amount: 1 }]), 400,
    'control: a real link still refuses a non-object body');
});

test('a document with custom fields as a JSON array is refused, and the public share view only returns an object', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 custom field customer' });
  const lines = [{ name: 'Run4 custom line', quantity: 1, rate: 15 }];
  assert.equal(await status(a, 'POST', '/documents/invoice', { contact_id: cust.id, lines, custom_fields: ['Run4', 'array'] }), 400);
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines, custom_fields: { run4_note: 'kept' }, save_as: 'send' });
  assert.equal((await a.get(`/documents/invoice/${inv.id}`)).custom_fields.run4_note, 'kept', 'control: the Admin keeps the object');
  const share = await client(srv.base).get(`/public/share/${(await a.get(`/documents/invoice/${inv.id}`)).share_token}`);
  const cf = share.doc.custom_fields;
  assert.ok(cf && typeof cf === 'object' && !Array.isArray(cf), 'the public custom fields are an object');
});

test('a customer portal comment can be deleted by the Admin, and then it is no longer listed', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Run4 portal comment customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Run4 portal line', quantity: 1, rate: 35 }], save_as: 'send' });
  await a.put(`/contacts/${cust.id}`, { portal_enabled: 1 });
  const { portal_token: token } = await a.get(`/contacts/${cust.id}`);
  const text = `Run4 portal comment ${Date.now()}`;
  assert.deepEqual(await client(srv.base).post(`/public/portal/${token}/comments`, { document_id: inv.id, text }), { ok: true });

  const posted = (await a.get(`/comments?entity_type=document&entity_id=${inv.id}`)).find((c) => c.text === text);
  assert.ok(posted, 'the Admin sees the customer comment');
  assert.equal(posted.author, 'Customer');
  assert.deepEqual(await a.del(`/comments/${posted.id}`), { ok: true });
  assert.ok(!(await a.get(`/comments?entity_type=document&entity_id=${inv.id}`)).some((c) => c.id === posted.id),
    'the deleted comment is no longer listed');
});
