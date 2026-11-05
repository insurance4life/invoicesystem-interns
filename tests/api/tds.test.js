// TDS sections: seeded for Indian orgs, managed in settings, chosen on payments and contacts, and summarised by the
// TDS Payable / TDS Receivable reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client, bal, trialBalanced } from './helpers.js';

let srv, a, b;
before(async () => { srv = await startServer({ OPENBOOKS_AUTH_RATE_LIMIT: '500' }); a = await signup(srv.base); b = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
const section = async (cl, code, name) => (await cl.get('/tds-sections')).find((s) => s.section === code && (!name || s.name === name));

test('an Indian org starts with the common TDS sections, also listed in meta', async () => {
  const list = await a.get('/tds-sections');
  const fees = list.find((s) => s.section === '194J' && s.name === 'Professional fees');
  assert.equal(fees.rate, 10);
  assert.ok(list.some((s) => s.section === '194C'), '194C is seeded');
  assert.ok((await a.get('/meta')).tds_sections.some((s) => s.id === fees.id));
});

test('sections are validated, and one in use cannot be deleted', async () => {
  assert.equal(await status(a, 'POST', '/tds-sections', { section: '194X', name: 'Bad rate', rate: 0 }), 400);
  assert.equal(await status(a, 'POST', '/tds-sections', { section: '194X', name: 'Bad rate', rate: 101 }), 400);
  assert.equal(await status(a, 'POST', '/tds-sections', { section: '194J', name: 'Professional fees', rate: 5 }), 400, 'duplicate');
  const s = await a.post('/tds-sections', { section: '194jb', name: 'Fees for a test', rate: 7.5 });
  assert.equal(s.section, '194JB');
  const edited = await a.put(`/tds-sections/${s.id}`, { rate: 5 });
  assert.equal(edited.rate, 5);
  assert.equal(edited.name, 'Fees for a test', 'a partial edit keeps the other fields');
  const vend = await a.post('/contacts', { type: 'vendor', display_name: `TDS del ${Date.now()}`, tds_section_id: s.id });
  assert.equal(vend.tds_section_id, s.id);
  assert.equal(await status(a, 'DELETE', `/tds-sections/${s.id}`), 400, 'used by a contact');
  await a.put(`/contacts/${vend.id}`, { tds_section_id: null });
  assert.deepEqual(await a.del(`/tds-sections/${s.id}`), { ok: true });
});

test('a vendor payment under 194J posts TDS Payable and shows in the TDS Payable report', async () => {
  const fees = await section(a, '194J', 'Professional fees');
  const vend = await a.post('/contacts', { type: 'vendor', display_name: `Consultant ${Date.now()}`, pan: 'ABCPK1234F', tds_section_id: fees.id });
  const bill = await a.post('/documents/bill', { contact_id: vend.id, lines: [{ name: 'Advisory', quantity: 1, rate: 10000, tax_id: a.tax('GST18') }], save_as: 'open' });
  assert.equal(bill.total, 11800);
  const before = await bal(a, 'tds_payable');
  // 10% of the 10,000 before GST; the vendor gets the rest of the 11,800
  const pay = await a.post('/payments/made', { contact_id: vend.id, amount: 10800, tds_amount: 1000, tds_section_id: fees.id, account_id: a.acc('petty_cash'),
    allocations: [{ document_id: bill.id, amount: 11800 }] });
  assert.equal(pay.tds_section_id, fees.id);
  assert.equal(pay.tds_section, '194J');
  assert.equal(Math.abs((await bal(a, 'tds_payable')) - before), 1000);
  assert.equal((await a.get(`/documents/bill/${bill.id}`)).balance, 0);
  assert.ok(await trialBalanced(a));

  const rpt = await a.get('/reports/tds-payable');
  const row = rpt.rows.find((r) => r.payment_id === pay.id);
  assert.equal(row.section, '194J');
  assert.equal(row.pan, 'ABCPK1234F');
  assert.equal(row.gross, 11800);
  assert.equal(row.tds, 1000);
  assert.ok(rpt.extra[0].rows.some((x) => x.section === '194J' && x.tds >= 1000));
  assert.ok(!(await a.get('/reports/tds-receivable')).rows.some((r) => r.payment_id === pay.id), 'payments made stay out of TDS Receivable');
});

test('a customer payment with TDS lands in TDS Receivable', async () => {
  const fees = await section(a, '194J', 'Professional fees');
  const cust = await a.post('/contacts', { type: 'customer', display_name: `Client ${Date.now()}` });
  const inv = await a.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Audit', quantity: 1, rate: 20000 }], save_as: 'open' });
  const pay = await a.post('/payments/received', { contact_id: cust.id, amount: 18000, tds_amount: 2000, tds_section_id: fees.id,
    allocations: [{ document_id: inv.id, amount: 20000 }] });
  const row = (await a.get('/reports/tds-receivable')).rows.find((r) => r.payment_id === pay.id);
  assert.equal(row.tds, 2000);
  assert.equal(row.gross, 20000);
});

test('a section without a deduction is dropped, and another org\'s section is refused', async () => {
  const fees = await section(a, '194J', 'Professional fees');
  const vend = await a.post('/contacts', { type: 'vendor', display_name: `No TDS ${Date.now()}` });
  const pay = await a.post('/payments/made', { contact_id: vend.id, amount: 500, tds_section_id: fees.id, account_id: a.acc('petty_cash') });
  assert.equal(pay.tds_section_id, null);

  const theirs = await section(b, '194C');
  assert.equal(await status(a, 'POST', '/payments/made', { contact_id: vend.id, amount: 500, tds_amount: 10, tds_section_id: theirs.id, account_id: a.acc('petty_cash') }), 400);
  assert.equal(await status(a, 'POST', '/payments/made', { contact_id: vend.id, amount: 500, tds_amount: 10, tds_section_id: 1e12, account_id: a.acc('petty_cash') }), 400);
  assert.equal(await status(a, 'POST', '/contacts', { type: 'vendor', display_name: `Cross ${Date.now()}`, tds_section_id: theirs.id }), 400);
  assert.equal(await status(a, 'PUT', `/tds-sections/${theirs.id}`, { rate: 1 }), 404);
});

test('an inactive section cannot be picked for a new payment', async () => {
  const s = await a.post('/tds-sections', { section: '194Z', name: `Retired ${Date.now()}`, rate: 1 });
  await a.put(`/tds-sections/${s.id}`, { is_active: false });
  const vend = await a.post('/contacts', { type: 'vendor', display_name: `Inactive ${Date.now()}` });
  assert.equal(await status(a, 'POST', '/payments/made', { contact_id: vend.id, amount: 100, tds_amount: 1, tds_section_id: s.id, account_id: a.acc('petty_cash') }), 400);
});

test('TDS reports list payments, so each needs its side\'s view right on top of reports view', async () => {
  const role = await a.post('/roles', { name: `TDS reports only ${Date.now()}`, permissions: { reports: ['view'] } });
  const email = `tds_${Date.now()}@tds.test`;
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  assert.equal(await status(s, 'GET', '/reports/tds-payable'), 403);
  assert.equal(await status(s, 'GET', '/reports/tds-receivable'), 403);
  assert.equal(await status(s, 'POST', '/tds-sections', { name: 'Nope', rate: 1 }), 403);
});
