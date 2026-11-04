import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, trialBalanced } from './helpers.js';

let srv, c, cust, project, task, devTask, uid, invoice, shareInvoice, invTok;

// unauthenticated request to the public (portal) API
async function pub(method, url, body) {
  const res = await fetch(`${srv.base}/public${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  srv = await startServer();
  c = await signup(srv.base);
  uid = (await c.get('/auth/me')).user.id;
  cust = await c.post('/contacts', { type: 'customer', display_name: 'Blue Corp', email: 'ap@blue.test' });
});
after(() => srv.close());

test('project with task-hour billing, staff rates and budget', async () => {
  project = await c.post('/projects', {
    name: 'Website Rebuild', code: 'WEB', customer_id: cust.id, billing_method: 'task_hours', rate: 800,
    budget_type: 'hours', budget_hours: 10,
    users: [{ user_id: uid, rate: 1000, cost_rate: 400 }],
    tasks: [{ name: 'Design', rate: 1200 }, { name: 'Development', rate: 1500 }],
  });
  assert.equal(project.billing_method, 'task_hours');
  assert.equal(project.tasks.length, 2);
  devTask = project.tasks.find((t) => t.name === 'Development');
  task = project.tasks.find((t) => t.name === 'Design');
  assert.equal(project.users[0].name, 'Tester');
  assert.equal(project.totals.logged_hours, 0);

  const bad = await c.call('POST', '/projects', { name: 'X', billing_method: 'weekly' }, { expectError: true });
  assert.equal(bad.status, 400);
  const list = await c.get(`/projects?status=active`);
  assert.equal(list.length, 1);
  assert.equal(list[0].task_count, 2);
});

test('time entries roll up into totals and the invoice is built from unbilled time', async () => {
  const e1 = await c.post('/time-entries', { project_id: project.id, task_id: task.id, date: '2026-06-01', minutes: 90, notes: 'Wireframes' });
  const e2 = await c.post('/time-entries', { project_id: project.id, task_id: task.id, date: '2026-06-02', minutes: 30 });
  assert.equal(e1.hours, 1.5);
  assert.equal(e1.user_id, uid);
  assert.equal(e2.task_name, 'Design');

  // billable expense with 10% markup, billed to the same project
  const exp = await c.post('/expenses', {
    date: '2026-06-01', account_id: c.acc('travel'), paid_through_id: c.acc('petty_cash'), amount: 1000,
    is_billable: 1, customer_id: cust.id, project_id: project.id, markup_percent: 10, reference: 'Taxi',
  });
  assert.equal(exp.status, 'unbilled');

  let p = await c.get(`/projects/${project.id}`);
  assert.equal(p.totals.logged_hours, 2);
  assert.equal(p.totals.unbilled_hours, 2);
  assert.equal(p.totals.labor_cost, 800, '2 hours at a cost rate of 400/h');

  invoice = await c.post(`/projects/${project.id}/invoice`, { date: '2026-06-03', include_expenses: true });
  assert.equal(invoice.doc_type, 'invoice');
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.project_id, project.id);
  assert.equal(invoice.contact_id, cust.id);
  const timeLines = invoice.lines.filter((l) => l.src_type === 'time');
  assert.equal(timeLines.length, 2);
  assert.deepEqual(timeLines.map((l) => l.quantity), [1.5, 0.5]);
  assert.ok(timeLines.every((l) => l.rate === 1200), 'task rate applies');
  assert.deepEqual(timeLines.map((l) => l.src_id).sort((a, b) => a - b), [e1.id, e2.id].sort((a, b) => a - b));

  const expLine = invoice.lines.find((l) => l.src_type === 'expense');
  assert.equal(expLine.src_id, exp.id);
  assert.equal(expLine.rate, 1100, 'expense total × (1 + 10%)');
  assert.equal(invoice.total, 1800 + 600 + 1100);

  const entries = await c.get(`/time-entries?project_id=${project.id}`);
  assert.ok(entries.every((e) => e.invoice_id === invoice.id));
  const expAfter = await c.get(`/expenses/${exp.id}`);
  assert.equal(expAfter.invoice_id, invoice.id);
  assert.equal(expAfter.status, 'invoiced');
  const unbilled = await c.get(`/time-entries?project_id=${project.id}&unbilled=1`);
  assert.equal(unbilled.length, 0);

  // an invoice with nothing left to bill is refused
  const again = await c.call('POST', `/projects/${project.id}/invoice`, { include_expenses: true }, { expectError: true });
  assert.equal(again.status, 400);

  // invoiced time cannot be edited
  const locked = await c.call('PUT', `/time-entries/${e1.id}`, { minutes: 60 }, { expectError: true });
  assert.equal(locked.status, 400);
});

test('deleting the draft invoice frees time entries and expenses', async () => {
  const del = await c.del(`/documents/invoice/${invoice.id}`);
  assert.equal(del.ok, true);
  const entries = await c.get(`/time-entries?project_id=${project.id}`);
  assert.ok(entries.every((e) => e.invoice_id === null));
  const exps = await c.get(`/expenses?project_id=${project.id}`);
  assert.equal(exps[0].invoice_id, null);
  assert.equal(exps[0].status, 'unbilled');

  invoice = await c.post(`/projects/${project.id}/invoice`, { date: '2026-06-04', include_expenses: true });
  assert.equal(invoice.lines.length, 3);
  const sent = await c.post(`/documents/invoice/${invoice.id}/action/mark_sent`);
  assert.equal(sent.status, 'open');
  shareInvoice = sent;
  invTok = sent.share_token;
  assert.ok(await trialBalanced(c));
  const p = await c.get(`/projects/${project.id}`);
  assert.equal(p.totals.billed_amount, 3500);
  assert.equal(p.totals.unbilled_hours, 0);
  assert.equal(p.totals.budget_percent, 20, '2h of a 10h budget');
});

test('timer start, stop and single running timer per user', async () => {
  const started = await c.post('/time-entries/timer/start', { project_id: project.id, task_id: devTask.id, notes: 'Coding' });
  assert.ok(started.timer_started_at);
  assert.equal(started.minutes, 0);
  const second = await c.call('POST', '/time-entries/timer/start', { project_id: project.id }, { expectError: true });
  assert.equal(second.status, 400);
  const running = await c.get('/time-entries/timer');
  assert.equal(running.id, started.id);
  const stopped = await c.post('/time-entries/timer/stop', {});
  assert.equal(stopped.timer_started_at, null);
  assert.ok(stopped.minutes >= 1);
  assert.equal(stopped.task_name, 'Development');
  assert.equal(await c.get('/time-entries/timer'), null);
  const none = await c.call('POST', '/time-entries/timer/stop', {}, { expectError: true });
  assert.equal(none.status, 404);
});

test('approve and reject time entries', async () => {
  const e = await c.post('/time-entries', { project_id: project.id, date: '2026-06-10', hours: 1 });
  const rej = await c.post(`/time-entries/${e.id}/reject`);
  assert.equal(rej.approval_status, 'rejected');
  const ok = await c.post(`/time-entries/${e.id}/approve`);
  assert.equal(ok.approval_status, 'approved');
  await c.del(`/time-entries/${e.id}`);
});

test('file upload, download, attach and delete round-trip', async () => {
  const data = Buffer.from('hello receipt').toString('base64');
  const f = await c.post('/files', { name: 'receipt.txt', mime: 'text/plain', data, folder: 'receipts' });
  assert.equal(f.size, 13);
  assert.equal(f.folder, 'receipts');

  const headers = { authorization: `Bearer ${c.st.token}`, 'x-org-id': String(c.st.org) };
  const res = await fetch(`${srv.base}/files/${f.id}/download`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), 'hello receipt');

  // <a href> style access with query-string token and org
  const viaQuery = await fetch(`${srv.base}/files/${f.id}/download?token=${c.st.token}&org_id=${c.st.org}`);
  assert.equal(viaQuery.status, 200);
  const noAuth = await fetch(`${srv.base}/files/${f.id}/download`);
  assert.equal(noAuth.status, 401);

  // attach to an expense, then find it by entity
  const exp = await c.get('/expenses');
  const attached = await c.put(`/files/${f.id}`, { entity_type: 'expense', entity_id: exp[0].id });
  assert.equal(attached.entity_type, 'expense');
  const list = await c.get(`/files?entity_type=expense&entity_id=${exp[0].id}`);
  assert.equal(list.length, 1);
  const library = await c.get('/files?folder=receipts');
  assert.ok(library.some((x) => x.id === f.id));

  const del = await c.del(`/files/${f.id}`);
  assert.equal(del.ok, true);
  const gone = await fetch(`${srv.base}/files/${f.id}/download`, { headers });
  assert.equal(gone.status, 404);
});

test('share link works without auth and rejects bad tokens and drafts', async () => {
  const share = await pub('GET', `/share/${invTok}`);
  assert.equal(share.status, 200);
  assert.equal(share.data.doc.number, shareInvoice.number);
  assert.equal(share.data.doc.created_by, undefined, 'internal fields are not exposed');
  assert.equal(share.data.org.name, 'Test Co');
  assert.equal(share.data.payments_enabled, true);
  assert.ok(share.data.contact.display_name === 'Blue Corp');

  const bad = await pub('GET', '/share/not-a-real-token');
  assert.equal(bad.status, 404);

  const draft = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Draft work', quantity: 1, rate: 10 }] });
  const hidden = await pub('GET', `/share/${draft.share_token}`);
  assert.equal(hidden.status, 404, 'drafts are not shared');
});

test('quote accepted through the share link', async () => {
  const q = await c.post('/documents/quote', { contact_id: cust.id, save_as: 'send', lines: [{ name: 'Audit', quantity: 1, rate: 5000 }] });
  assert.equal(q.status, 'sent');
  const acc = await pub('POST', `/share/${q.share_token}/accept`, { reason: 'Go ahead' });
  assert.equal(acc.status, 200);
  assert.equal((await c.get(`/documents/quote/${q.id}`)).status, 'accepted');
  const again = await pub('POST', `/share/${q.share_token}/accept`, {});
  assert.equal(again.status, 400);
  const comments = await c.get(`/comments?entity_type=document&entity_id=${q.id}`);
  assert.equal(comments[0].author, 'Customer');
  assert.match(comments[0].text, /Go ahead/);

  const q2 = await c.post('/documents/quote', { contact_id: cust.id, save_as: 'send', lines: [{ name: 'Extra', quantity: 1, rate: 100 }] });
  const dec = await pub('POST', `/share/${q2.share_token}/decline`, {});
  assert.equal(dec.status, 200);
  assert.equal((await c.get(`/documents/quote/${q2.id}`)).status, 'declined');
});

test('online test-mode payment settles an invoice and refuses card data', async () => {
  const card = await pub('POST', `/share/${invTok}/pay`, { amount: 100, payer_name: 'Asha', method: 'card', card_number: '4111 1111 1111 1111' });
  assert.equal(card.status, 400);
  const cardInText = await pub('POST', `/share/${invTok}/pay`, { amount: 100, payer_name: 'Asha 4111111111111111', method: 'upi' });
  assert.equal(cardInText.status, 400);
  const overpay = await pub('POST', `/share/${invTok}/pay`, { amount: 999999, payer_name: 'Asha', method: 'upi' });
  assert.equal(overpay.status, 400);

  const paid = await pub('POST', `/share/${invTok}/pay`, { payer_name: 'Asha', method: 'upi' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.test_mode, true);
  assert.equal(paid.data.balance, 0);
  assert.equal(paid.data.display_status, 'paid');
  assert.match(paid.data.reference, /^TEST-/);

  const doc = await c.get(`/documents/invoice/${shareInvoice.id}`);
  assert.equal(doc.balance, 0);
  assert.equal(doc.display_status, 'paid');
  const again = await pub('POST', `/share/${invTok}/pay`, { payer_name: 'Asha', method: 'upi' });
  assert.equal(again.status, 400);
  assert.ok(await trialBalanced(c));
});

test('customer portal lists documents and balances', async () => {
  const contact = await c.get(`/contacts/${cust.id}`);
  const portal = await pub('GET', `/portal/${contact.portal_token}`);
  assert.equal(portal.status, 404, 'portal is off until enabled');

  await c.put(`/contacts/${cust.id}`, { portal_enabled: 1 });
  const res = await pub('GET', `/portal/${contact.portal_token}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.invoices.length, 1);
  assert.equal(res.data.invoices[0].display_status, 'paid');
  assert.equal(res.data.summary.outstanding, 0);
  assert.ok(res.data.payments.length >= 1);
  assert.ok(res.data.quotes.length >= 2);
  assert.ok(res.data.invoices[0].share_token);

  const note = await pub('POST', `/portal/${contact.portal_token}/comments`, { document_id: res.data.invoices[0].id, text: 'Thanks!' });
  assert.equal(note.status, 200);
  await c.put(`/contacts/${cust.id}`, { portal_enabled: 0 });
});

test('payment link creates an unallocated payment', async () => {
  const link = await c.post('/payment-links', { contact_id: cust.id, amount: 500, description: 'Advance for April' });
  assert.equal(link.status, 'active');
  const info = await pub('GET', `/pay/${link.token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.amount, 500);
  assert.equal(info.data.status, 'active');

  const paid = await pub('POST', `/pay/${link.token}/pay`, { payer_name: 'Ravi' });
  assert.equal(paid.status, 200);
  const payments = await c.get('/payments/received');
  const pay = payments.find((p) => p.number === paid.data.payment.number);
  assert.equal(pay.amount, 500);
  const detail = await c.get(`/payments/received/${pay.id}`);
  assert.equal(detail.unused, 500, 'no invoice allocation: it is an advance');
  assert.equal(detail.allocations.length, 0);

  const after = await pub('GET', `/pay/${link.token}`);
  assert.equal(after.data.status, 'paid');
  const twice = await pub('POST', `/pay/${link.token}/pay`, { payer_name: 'Ravi' });
  assert.equal(twice.status, 400);
  assert.ok(await trialBalanced(c));
});

test('projects and time entries are isolated per organization', async () => {
  const e = await c.post('/time-entries', { project_id: project.id, date: '2026-06-11', minutes: 30 });
  assert.ok(e.id);
  const other = await signup(srv.base, undefined, { name: 'Other Co' });
  const denied = await other.call('GET', `/projects/${project.id}`, null, { expectError: true });
  assert.equal(denied.status, 404);
  const foreign = await other.call('POST', '/time-entries', { project_id: project.id, date: '2026-06-11', minutes: 30 }, { expectError: true });
  assert.equal(foreign.status, 400);
});
