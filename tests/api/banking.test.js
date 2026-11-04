import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced, bal } from './helpers.js';

let srv, c, bank, bank2;
const accBal = async (id) => (await c.get(`/banking/accounts/${id}`)).balance;

before(async () => { srv = await startServer(); c = await signup(srv.base); });
after(() => srv.close());

test('bank accounts CRUD', async () => {
  bank = await c.post('/banking/accounts', { name: 'ICICI Current', type: 'bank', bank_name: 'ICICI', account_number: '000123456789', ifsc: 'ICIC0000001', code: '1030' });
  assert.equal(bank.type, 'bank');
  assert.equal(bank.balance, 0);
  bank2 = await c.post('/banking/accounts', { name: 'Savings', type: 'bank' });
  const card = await c.post('/banking/accounts', { name: 'Corporate Card', type: 'credit_card' });
  const badType = await c.call('POST', '/banking/accounts', { name: 'X', type: 'income' }, { expectError: true });
  assert.equal(badType.status, 400);
  const dup = await c.call('POST', '/banking/accounts', { name: 'icici current' }, { expectError: true });
  assert.match(dup.error, /already exists/);
  const upd = await c.put(`/banking/accounts/${card.id}`, { bank_name: 'HDFC' });
  assert.equal(upd.bank_name, 'HDFC');
  await c.del(`/banking/accounts/${card.id}`);
  const list = await c.get('/banking/accounts');
  assert.ok(list.find((a) => a.id === bank.id));
  assert.ok(!list.find((a) => a.id === card.id));
  assert.ok(list.find((a) => a.system_code === 'undeposited_funds'));
});

test('manual deposit, transfer, edit and delete', async () => {
  const dep = await c.post('/banking/transactions', { account_id: bank.id, date: '2026-06-01', txn_type: 'owner_contribution', amount: 100000, reference: 'CAP-1' });
  assert.equal(dep.direction, 'in');
  assert.equal(await accBal(bank.id), 100000);
  assert.equal(await bal(c, 'owners_equity'), 100000);

  const tr = await c.post('/banking/transactions', { account_id: bank.id, date: '2026-06-02', txn_type: 'transfer', amount: 20000, to_account_id: bank2.id });
  assert.equal(tr.txn_type, 'transfer_out');
  assert.equal(await accBal(bank.id), 80000);
  assert.equal(await accBal(bank2.id), 20000);

  const wd = await c.post('/banking/transactions', { account_id: bank.id, date: '2026-06-03', txn_type: 'withdrawal', amount: 500, offset_account_id: c.acc('bank_charges') });
  assert.equal(await accBal(bank.id), 79500);
  await c.put(`/banking/transactions/${wd.id}`, { amount: 750 });
  assert.equal(await accBal(bank.id), 79250);
  await c.del(`/banking/transactions/${wd.id}`);
  assert.equal(await accBal(bank.id), 80000);
  assert.equal(await bal(c, 'bank_charges'), 0);

  const used = await c.call('DELETE', `/banking/accounts/${bank2.id}`, null, { expectError: true });
  assert.match(used.error, /transactions/);

  const tx = await c.get(`/banking/accounts/${bank.id}/transactions`);
  assert.equal(tx.rows.length, 2);
  assert.equal(tx.rows[1].balance, 80000);
  assert.equal(tx.rows[0].src_type, 'bank_txn');
  assert.ok(await trialBalanced(c));
});

let cust, vend, payment, rule;
test('statement import with rules, categorize as expense, match to payment', async () => {
  cust = await c.post('/contacts', { type: 'customer', display_name: 'Bank Cust' });
  vend = await c.post('/contacts', { type: 'vendor', display_name: 'AWS' });
  payment = await c.post('/payments/received', { contact_id: cust.id, date: '2026-06-05', amount: 15000, account_id: bank.id });

  rule = await c.post('/banking/rules', {
    name: 'Bank fees', apply_to: 'withdrawals', match: 'all', priority: 1,
    conditions: [{ field: 'description', op: 'contains', value: 'charges' }],
    action: { txn_type: 'withdrawal', offset_account_id: c.acc('bank_charges'), auto_categorize: true },
  });
  await c.post('/banking/rules', { name: 'Interest', apply_to: 'deposits', conditions: [{ field: 'description', op: 'starts_with', value: 'INT' }], action: { txn_type: 'interest_income' } });

  const res = await c.post(`/banking/accounts/${bank.id}/import`, { rows: [
    { date: '07/06/2026', description: 'NEFT from Bank Cust', reference: 'N123', deposit: '15,000.00', withdrawal: '' },
    { date: '2026-06-08', description: 'AWS invoice', withdrawal: '2,360', balance: '' },
    { date: '2026-06-09', description: 'SMS charges', amount: '-59' },
    { date: '2026-06-10', description: 'INT credit', amount: '120.50', balance: '92701.50' },
    { date: 'bad', description: 'junk', amount: '5' },
  ] });
  assert.equal(res.imported, 4);
  assert.equal(res.skipped, 1);
  assert.equal(res.categorized, 1);
  assert.equal(res.suggested, 1);
  assert.equal(await bal(c, 'bank_charges'), 59);

  // re-import: duplicates are skipped
  const again = await c.post(`/banking/accounts/${bank.id}/import`, { rows: [{ date: '2026-06-07', description: 'NEFT from Bank Cust', amount: 15000 }] });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 1);

  let lines = await c.get(`/banking/accounts/${bank.id}/statement-lines?status=uncategorized`);
  assert.equal(lines.length, 3);
  const neft = lines.find((l) => l.description.startsWith('NEFT'));
  const aws = lines.find((l) => l.description.startsWith('AWS'));
  const int = lines.find((l) => l.description.startsWith('INT'));
  assert.equal(neft.date, '2026-06-07');
  assert.equal(int.suggestion.txn_type, 'interest_income');

  // match the deposit to the existing payment
  const sug = await c.post(`/banking/statement-lines/${neft.id}/match-suggestions`);
  const m = sug.matches.find((x) => x.matched_type === 'payment_received' && x.matched_id === payment.id);
  assert.ok(m, 'payment suggested');
  await c.post(`/banking/statement-lines/${neft.id}/match`, { matched_type: 'payment_received', matched_id: payment.id });
  const sug2 = await c.post(`/banking/statement-lines/${int.id}/match-suggestions`);
  assert.ok(!sug2.matches.find((x) => x.matched_id === payment.id));

  // categorize withdrawal as an expense
  const cat = await c.post(`/banking/statement-lines/${aws.id}/categorize`, { txn_type: 'expense', offset_account_id: c.acc('it_internet'), contact_id: vend.id, reference: 'AWS-JUN' });
  assert.equal(cat.matched_type, 'expense');
  assert.equal(cat.line.status, 'categorized');
  assert.equal(await bal(c, 'it_internet'), 2360);

  // categorize interest from suggestion
  await c.post(`/banking/statement-lines/${int.id}/categorize`, int.suggestion);
  assert.equal(await bal(c, 'interest_income'), 120.5);

  lines = await c.get(`/banking/accounts/${bank.id}/statement-lines?status=uncategorized`);
  assert.equal(lines.length, 0);
  const acct = await c.get(`/banking/accounts/${bank.id}`);
  assert.equal(acct.statement_balance, 92701.5);
  assert.equal(acct.balance, 80000 + 15000 - 2360 - 59 + 120.5);
  assert.ok(await trialBalanced(c));
});

test('match a statement line to an open invoice creates a payment', async () => {
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, date: '2026-06-01', lines: [{ name: 'Service', quantity: 1, rate: 4000 }], save_as: 'send' });
  const r = await c.post(`/banking/accounts/${bank.id}/import`, { rows: [{ date: '2026-06-12', description: 'UPI Bank Cust', amount: 4000 }] });
  const id = r.ids[0];
  const sug = await c.post(`/banking/statement-lines/${id}/match-suggestions`);
  assert.ok(sug.documents.find((d) => d.invoice_id === inv.id));
  const m = await c.post(`/banking/statement-lines/${id}/match`, { invoice_id: inv.id });
  assert.equal(m.matched_type, 'payment_received');
  assert.equal((await c.get(`/documents/invoice/${inv.id}`)).balance, 0);
  // deleting that payment in core resets the line
  await c.del(`/payments/received/${m.matched_id}`);
  const line = await c.get(`/banking/statement-lines/${id}`);
  assert.equal(line.status, 'uncategorized');
  await c.post(`/banking/statement-lines/${id}/exclude`);
  assert.equal((await c.get(`/banking/statement-lines/${id}`)).status, 'excluded');
  await c.post(`/banking/statement-lines/${id}/restore`);
  await c.del(`/banking/statement-lines/${id}`);
  assert.ok(await trialBalanced(c));
});

test('uncategorize reverses bank txns, expense deletion unlinks', async () => {
  const all = await c.get(`/banking/accounts/${bank.id}/statement-lines?status=done`);
  const fee = all.find((l) => l.description === 'SMS charges');
  assert.equal(fee.matched_type, 'bank_txn');
  await c.post(`/banking/statement-lines/${fee.id}/uncategorize`);
  assert.equal(await bal(c, 'bank_charges'), 0);
  const gone = await c.call('GET', `/banking/transactions/${fee.matched_id}`, null, { expectError: true });
  assert.equal(gone.status, 404);
  // bulk categorize it again
  const bulk = await c.post(`/banking/accounts/${bank.id}/statement-lines/bulk-categorize`, { ids: [fee.id], txn_type: 'withdrawal', offset_account_id: c.acc('bank_charges') });
  assert.equal(bulk.ok, 1);
  assert.equal(await bal(c, 'bank_charges'), 59);

  const aws = all.find((l) => l.matched_type === 'expense');
  await c.del(`/expenses/${aws.matched_id}`);
  assert.equal((await c.get(`/banking/statement-lines/${aws.id}`)).status, 'uncategorized');
  // categorize with splits as a plain withdrawal
  await c.post(`/banking/statement-lines/${aws.id}/categorize`, { txn_type: 'withdrawal', splits: [{ offset_account_id: c.acc('it_internet'), amount: 2000 }, { offset_account_id: c.acc('input_igst'), amount: 360 }] });
  assert.equal(await bal(c, 'it_internet'), 2000);
  assert.ok(await trialBalanced(c));
});

test('deposit undeposited funds', async () => {
  const p1 = await c.post('/payments/received', { contact_id: cust.id, date: '2026-06-13', amount: 1000 });
  const p2 = await c.post('/payments/received', { contact_id: cust.id, date: '2026-06-13', amount: 2500 });
  const und = await c.get('/banking/undeposited');
  assert.equal(und.length, 2);
  const before = await accBal(bank.id);
  const dep = await c.post('/banking/deposits', { account_id: bank.id, date: '2026-06-14', payment_ids: [p1.id, p2.id] });
  assert.equal(dep.amount, 3500);
  assert.equal(dep.payments.length, 2);
  assert.equal(await accBal(bank.id), before + 3500);
  assert.equal(await bal(c, 'undeposited_funds'), 0);
  assert.equal((await c.get('/banking/undeposited')).length, 0);
  const again = await c.call('POST', '/banking/deposits', { account_id: bank.id, payment_ids: [p1.id] }, { expectError: true });
  assert.equal(again.status, 400);
  assert.ok(await trialBalanced(c));
});

test('reconciliation to zero difference, complete, undo', async () => {
  const before = await c.get(`/banking/accounts/${bank.id}/transactions?to=2026-06-10`);
  const closing = before.closing_balance;
  const rec = await c.post(`/banking/accounts/${bank.id}/reconciliations`, { start_date: '2026-06-01', end_date: '2026-06-10', closing_balance: closing });
  assert.equal(rec.status, 'in_progress');
  assert.equal(rec.opening_balance, 0);
  assert.equal(rec.difference, closing);
  const dupe = await c.call('POST', `/banking/accounts/${bank.id}/reconciliations`, { end_date: '2026-06-30', closing_balance: 0 }, { expectError: true });
  assert.match(dupe.error, /in progress/);
  // clear all but one, cannot complete
  const ids = rec.rows.map((r) => r.id);
  let d = await c.post(`/banking/reconciliations/${rec.id}/toggle`, { ledger_ids: ids.slice(1), cleared: true });
  assert.notEqual(d.difference, 0);
  const fail = await c.call('POST', `/banking/reconciliations/${rec.id}/complete`, null, { expectError: true });
  assert.match(fail.error, /difference/);
  d = await c.post(`/banking/reconciliations/${rec.id}/toggle`, { ledger_ids: [ids[0]], cleared: true });
  assert.equal(d.difference, 0);
  const done = await c.post(`/banking/reconciliations/${rec.id}/complete`);
  assert.equal(done.status, 'completed');
  const tx = await c.get(`/banking/accounts/${bank.id}/transactions`);
  assert.ok(tx.rows.filter((r) => r.date <= '2026-06-10').every((r) => r.reconciled));
  assert.equal((await c.get(`/banking/accounts/${bank.id}`)).last_reconciled, '2026-06-10');

  // reconciled bank txns cannot be deleted
  const capital = tx.rows.find((r) => r.src_type === 'bank_txn' && r.number === 'CAP-1');
  const locked = await c.call('DELETE', `/banking/transactions/${capital.src_id}`, null, { expectError: true });
  assert.match(locked.error, /reconciliation/);

  // next period: opening = previous closing
  const rec2 = await c.post(`/banking/accounts/${bank.id}/reconciliations`, { end_date: '2026-06-30', closing_balance: closing });
  assert.equal(rec2.opening_balance, closing);
  assert.equal(rec2.start_date, '2026-06-11');
  const blocked = await c.call('POST', `/banking/reconciliations/${rec.id}/undo`, null, { expectError: true });
  assert.match(blocked.error, /later/);
  await c.post(`/banking/reconciliations/${rec2.id}/undo`);
  await c.post(`/banking/reconciliations/${rec.id}/undo`);
  const list = await c.get(`/banking/accounts/${bank.id}/reconciliations`);
  assert.equal(list.length, 0);
  const tx2 = await c.get(`/banking/accounts/${bank.id}/transactions`);
  assert.ok(tx2.rows.every((r) => !r.reconciled));
  await c.del(`/banking/transactions/${capital.src_id}`);
  assert.equal(await bal(c, 'owners_equity'), 0);
  assert.ok(await trialBalanced(c));
});

test('overview, rules CRUD and transaction lock', async () => {
  const ov = await c.get('/banking/overview');
  assert.ok(ov.accounts.find((a) => a.id === bank.id));
  assert.equal(typeof ov.totals.bank, 'number');
  const rules = await c.get('/banking/rules');
  assert.equal(rules.length, 2);
  await c.put(`/banking/rules/${rule.id}`, { is_active: 0 });
  assert.equal((await c.get(`/banking/rules/${rule.id}`)).is_active, 0);
  await c.del(`/banking/rules/${rule.id}`);
  assert.equal((await c.get('/banking/rules')).length, 1);
  const noCond = await c.call('POST', '/banking/rules', { name: 'Empty', conditions: [] }, { expectError: true });
  assert.equal(noCond.status, 400);

  await c.put('/org/settings', { locks: { banking: '2026-06-30' } });
  const locked = await c.call('POST', '/banking/transactions', { account_id: bank.id, date: '2026-06-15', txn_type: 'deposit', amount: 10 }, { expectError: true });
  assert.match(locked.error, /locked/);
  await c.put('/org/settings', { locks: { banking: null } });
  assert.ok(await trialBalanced(c));
});
