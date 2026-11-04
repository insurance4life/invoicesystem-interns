// Regression tests for the second round of security-audit fixes: module rights on secondary routes, document
// workflow guards, transaction locks on opening balances, reconciliation protection, sessions and input limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer(); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
let seq = 0;

/** Invite a member into org `owner` with the given permissions and return a client signed in as them. */
async function member(owner, permissions) {
  const email = `m${++seq}@p2.test`;
  const role = await owner.post('/roles', { name: `P2 role ${seq}`, permissions });
  const inv = await owner.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = owner.st.org;
  return s;
}

test('records reached through comments, activity, attachments and contact lookups need the module right', async () => {
  const s = await member(a, { projects: ['view', 'create', 'edit'] });
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'P2 Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send' });
  await a.post('/comments', { entity_type: 'document', entity_id: inv.id, text: 'internal note' });

  assert.equal(await status(s, 'GET', '/activity'), 403);
  assert.equal(await status(s, 'GET', `/activity?entity_type=document&entity_id=${inv.id}`), 403);
  assert.equal(await status(s, 'GET', `/comments?entity_type=document&entity_id=${inv.id}`), 403);
  assert.equal(await status(s, 'POST', '/comments', { entity_type: 'document', entity_id: inv.id, text: 'hi' }), 403);
  assert.equal(await status(s, 'GET', `/files?entity_type=invoice&entity_id=${inv.id}`), 403);
  assert.equal(await status(s, 'POST', '/files', { name: 'x.txt', data: 'aGVsbG8=', entity_type: 'invoice', entity_id: inv.id }), 403);
  assert.equal(await status(s, 'GET', `/contacts/${cust.id}/open-documents`), 403);
  assert.equal(await status(s, 'GET', `/contacts/${cust.id}/credits`), 403);
  assert.equal((await a.get(`/comments?entity_type=document&entity_id=${inv.id}`)).length, 1, 'the owner still reads comments');
});

test('credits, refunds and their deletion need the matching side', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Credit Side' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 500 }], save_as: 'send' });
  const cn = await a.post('/documents/creditnote', { contact_id: cust.id, lines: [{ name: 'Refund', quantity: 1, rate: 200 }], save_as: 'open' });
  const buyer = await member(a, { purchases: ['view', 'create', 'edit', 'delete'] });
  assert.equal(await status(buyer, 'POST', '/credits/apply', { source_type: 'creditnote', source_id: cn.id, applications: [{ document_id: inv.id, amount: 50 }] }), 403);
  assert.equal(await status(buyer, 'POST', '/refunds', { source_type: 'creditnote', source_id: cn.id, amount: 10, account_id: a.acc('petty_cash') }), 403);

  await a.post('/credits/apply', { source_type: 'creditnote', source_id: cn.id, applications: [{ document_id: inv.id, amount: 50 }] });
  const rf = await a.post('/refunds', { source_type: 'creditnote', source_id: cn.id, amount: 10, account_id: a.acc('petty_cash') });
  const ca = (await a.get(`/documents/invoice/${inv.id}`)).credits_applied[0];
  assert.equal(await status(buyer, 'DELETE', `/credits/${ca.id}`), 403);
  assert.equal(await status(buyer, 'DELETE', `/refunds/${rf.id}`), 403);
});

test('bank categorization cannot record an expense without purchases rights', async () => {
  const bank = await a.post('/banking/accounts', { name: 'P2 Bank', type: 'bank' });
  await a.post(`/banking/accounts/${bank.id}/import`, { rows: [{ date: '2026-06-08', description: 'Cloud bill', withdrawal: '500' }] });
  const line = (await a.get(`/banking/accounts/${bank.id}/statement-lines?status=uncategorized`))[0];
  const clerk = await member(a, { banking: ['view', 'create', 'edit'] });
  assert.equal(await status(clerk, 'POST', `/banking/statement-lines/${line.id}/categorize`, { txn_type: 'expense', offset_account_id: a.acc('uncategorized') }), 403);
});

test('exports need the module right, backups need an Admin, and CSV cells cannot start a formula', async () => {
  const s = await member(a, { settings: ['view'] });
  assert.equal(await status(s, 'GET', '/data/export/invoices'), 403);
  assert.equal(await status(s, 'GET', '/data/backup'), 403);
  await a.post('/contacts', { type: 'customer', display_name: '=HYPERLINK("http://example.invalid","x")' });
  const res = await fetch(`${srv.base}/data/export/contacts?format=csv`, { headers: { authorization: `Bearer ${a.st.token}`, 'x-org-id': String(a.st.org) } });
  const csv = await res.text();
  assert.ok(csv.includes(`"'=HYPERLINK(`), 'formula cell is prefixed with a quote');
});

test('dashboard and assistant hide report figures from members without reports access', async () => {
  const s = await member(a, { projects: ['view'] });
  const d = await s.get('/dashboard');
  assert.equal(d.restricted, true);
  assert.deepEqual(d.bank_accounts, []);
  assert.equal(d.receivables.total, 0);
  const ans = await s.post('/assistant', { q: 'what is my cash and bank balance' });
  assert.match(ans.text, /access to reports/);
  assert.ok(!(await a.get('/dashboard')).restricted, 'an Admin sees the full dashboard');
});

test('document convert, clone and status actions keep their guards', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: 'Flow Customer' });
  const vend = await a.post('/contacts', { type: 'vendor', display_name: 'Flow Vendor' });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send' });
  assert.equal(await status(a, 'POST', `/documents/salesorder/${inv.id}/convert`, { to: 'purchaseorder', contact_id: vend.id }), 400);
  assert.equal(await status(a, 'POST', `/documents/quote/${inv.id}/clone`), 400);

  const draft = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Draft', quantity: 1, rate: 100 }] });
  assert.equal(await status(a, 'POST', `/documents/invoice/${draft.id}/action/close`), 400);
  assert.equal(await status(a, 'POST', `/documents/invoice/${draft.id}/action/cancel_writeoff`), 400);

  assert.equal(await status(a, 'POST', '/documents/recurring_invoice', { contact_id: cust.id, lines: [{ name: 'R', quantity: 1, rate: 1 }], recurrence: { frequency: 'daily', every: -1 } }), 400);
  assert.equal(await status(a, 'POST', '/documents/recurring_invoice', { contact_id: cust.id, lines: [{ name: 'R', quantity: 1, rate: 1 }], recurrence: { frequency: 'daily', every: 0.5 } }), 400);
  const s = await member(a, { projects: ['view'] });
  assert.equal(await status(s, 'POST', '/recurring/run'), 403);
});

test('locked periods protect document changes and opening balances', async () => {
  const o = await signup(srv.base);
  const cust = await o.post('/contacts', { type: 'customer', display_name: 'Opening Customer', opening_balance: 100, opening_balance_date: '2025-01-01' });
  const solo = await o.post('/contacts', { type: 'vendor', display_name: 'Opening Only', opening_balance: 40, opening_balance_date: '2025-01-01' });
  const item = await o.post('/items', { name: 'Stocked', type: 'goods', purchase_price: 10, track_inventory: 1, opening_stock: 5, opening_stock_rate: 10 });
  const inv = await o.post('/documents/invoice', { contact_id: cust.id, date: '2025-01-05', lines: [{ name: 'Old', quantity: 1, rate: 100 }], save_as: 'send' });
  const today = new Date().toISOString().slice(0, 10);
  await o.put('/org', { lock_date: today });

  assert.equal(await status(o, 'POST', `/documents/invoice/${inv.id}/action/mark_draft`), 400);
  assert.equal(await status(o, 'POST', `/documents/invoice/${inv.id}/action/cancel`), 400);
  assert.equal(await status(o, 'POST', '/contacts', { type: 'customer', display_name: 'Backdated', opening_balance: 50, opening_balance_date: '2025-02-01' }), 400);
  await o.put(`/contacts/${cust.id}`, { display_name: 'Opening Customer Renamed', opening_balance: 100 }); // unchanged opening is allowed
  assert.equal(await status(o, 'PUT', `/contacts/${cust.id}`, { opening_balance: 300 }), 400);
  assert.equal(await status(o, 'DELETE', `/contacts/${solo.id}`), 400); // its only posting is the locked opening balance
  await o.put(`/items/${item.id}`, { name: 'Stocked Renamed' }); // no change to the opening stock
  assert.equal(await status(o, 'PUT', `/items/${item.id}`, { opening_stock: 9 }), 400);
  assert.equal(await status(o, 'DELETE', `/items/${item.id}`), 400);
});

test('a completed reconciliation cannot be changed through payments or expenses', async () => {
  const o = await signup(srv.base);
  const bank = await o.post('/banking/accounts', { name: 'Recon Bank', type: 'bank' });
  const exp = await o.post('/expenses', { date: '2026-06-02', account_id: o.acc('uncategorized'), paid_through_id: bank.id, amount: 100 });
  const rec = await o.post(`/banking/accounts/${bank.id}/reconciliations`, { start_date: '2026-06-01', end_date: '2026-06-10', closing_balance: -100 });
  await o.post(`/banking/reconciliations/${rec.id}/toggle`, { ledger_ids: rec.rows.map((r) => r.id), cleared: true });
  await o.post(`/banking/reconciliations/${rec.id}/complete`);
  assert.equal(await status(o, 'DELETE', `/expenses/${exp.id}`), 400);
  assert.equal(await status(o, 'PUT', `/expenses/${exp.id}`, { amount: 150 }), 400);
});

test('changing the password ends other sessions and returns a fresh token', async () => {
  const email = `pw${Date.now()}@p2.test`;
  const o = await signup(srv.base, email);
  const old = o.st.token;
  const out = await o.put('/auth/me', { current_password: 'secret123', new_password: 'secret456' });
  assert.ok(out.token && out.token !== old);
  const stale = client(srv.base);
  stale.st.token = old;
  assert.equal(await status(stale, 'GET', '/auth/me'), 401);
  o.st.token = out.token;
  assert.equal((await o.get('/auth/me')).user.email, email);
});

test('inputs are bounded: non-finite numbers and oversized bulk lists are refused', async () => {
  const raw = await fetch(`${srv.base}/journals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.st.token}`, 'x-org-id': String(a.st.org) },
    body: `{"date":"2026-05-02","lines":[{"account_id":${a.acc('petty_cash')},"debit":1e999},{"account_id":${a.acc('owners_equity')},"credit":1e999}]}`,
  });
  assert.equal(raw.status, 400);
  assert.equal(await status(a, 'POST', '/contacts/bulk', { action: 'activate', ids: Array.from({ length: 1001 }, (_, i) => i + 1) }), 400);
});
