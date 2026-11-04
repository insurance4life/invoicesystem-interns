import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, signup, client, trialBalanced, bal } from './helpers.js';

let srv, c;
// The webhook test posts to a local listener, which the destination policy only allows when opted in.
before(async () => { srv = await startServer({ OPENBOOKS_WEBHOOK_ALLOW_PRIVATE: '1' }); c = await signup(srv.base); });
after(() => srv.close());

const daysFromToday = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    v = await fn();
  }
  return v;
}

test('invite a user, sign in with the temporary password, limited role is denied settings', async () => {
  const role = await c.post('/roles', { name: 'Sales Only', description: 'Sales', permissions: { sales: ['view', 'create', 'edit'], contacts: ['view'] } });
  assert.deepEqual(role.permissions, { sales: ['view', 'create', 'edit'], contacts: ['view'] });

  const inv = await c.post('/users/invite', { name: 'Sam Sales', email: 'sam@test.dev', role_id: role.id });
  assert.ok(inv.temp_password && inv.temp_password.length >= 8, 'temporary password returned once');
  assert.equal(inv.role, 'Sales Only');
  assert.equal(inv.status, 'active');

  const s = client(srv.base);
  const login = await s.post('/auth/login', { email: 'sam@test.dev', password: inv.temp_password });
  s.st.token = login.token;
  s.st.org = c.st.org;

  assert.equal((await s.call('GET', '/users', null, { expectError: true })).status, 403);
  assert.equal((await s.call('GET', '/taxes', null, { expectError: true })).status, 403);
  assert.equal((await s.call('PUT', '/org/settings', {}, { expectError: true })).status, 403);
  const invoices = await s.get('/documents/invoice');
  assert.ok(Array.isArray(invoices.rows), 'sales module is allowed');

  const emails = await c.get('/emails');
  assert.ok(emails.some((e) => e.to_addr === 'sam@test.dev' && e.subject.includes('invited')), 'invitation logged in the outbox');

  // the Admin role is locked, and the last Admin can neither be removed nor demoted
  const roles = await c.get('/roles');
  const admin = roles.find((r) => r.name === 'Admin');
  assert.equal((await c.call('PUT', `/roles/${admin.id}`, { name: 'Admin', permissions: {} }, { expectError: true })).status, 400);
  const me = (await c.get('/users')).find((u) => u.role === 'Admin');
  assert.equal((await c.call('DELETE', `/users/${me.id}`, null, { expectError: true })).status, 400);
  assert.equal((await c.call('PUT', `/users/${me.id}`, { role_id: role.id }, { expectError: true })).status, 400);

  // a role that still has users cannot be deleted
  assert.equal((await c.call('DELETE', `/roles/${role.id}`, null, { expectError: true })).status, 400);

  // re-inviting an existing member is refused
  assert.equal((await c.call('POST', '/users/invite', { email: 'sam@test.dev', role_id: role.id }, { expectError: true })).status, 400);
});

test('tax group sums its members and refuses to delete taxes in use', async () => {
  const a = await c.post('/taxes', { name: 'Test Service Tax', kind: 'simple', rate: 10 });
  const b = await c.post('/taxes', { name: 'Test Levy', kind: 'simple', rate: 3 });
  const g = await c.post('/taxes', { name: 'Test Combo', kind: 'group', group_ids: [a.id, b.id] });
  assert.equal(g.rate, 13);
  assert.equal((await c.call('POST', '/taxes', { name: 'Nested', kind: 'group', group_ids: [g.id] }, { expectError: true })).status, 400);

  await c.put(`/taxes/${a.id}`, { name: 'Test Service Tax', kind: 'simple', rate: 12 });
  assert.equal((await c.get('/taxes')).find((t) => t.id === g.id).rate, 15, 'group rate follows its members');

  await c.post('/items', { name: 'Taxed thing', type: 'goods', selling_price: 100, tax_id: b.id });
  assert.equal((await c.call('DELETE', `/taxes/${b.id}`, null, { expectError: true })).status, 400);
  const off = await c.put(`/taxes/${b.id}`, { name: 'Test Levy', kind: 'simple', rate: 3, is_active: false });
  assert.equal(off.is_active, 0);

  await c.del(`/taxes/${g.id}`);
  assert.equal((await c.get('/taxes')).some((t) => t.id === g.id), false);
});

test('custom field CRUD with generated unique keys', async () => {
  const f1 = await c.post('/custom-fields', { module: 'contact', label: 'Loyalty Tier', data_type: 'dropdown', options: ['Gold', 'Silver'] });
  assert.equal(f1.field_key, 'loyalty_tier');
  assert.deepEqual(f1.options, ['Gold', 'Silver']);
  const f2 = await c.post('/custom-fields', { module: 'contact', label: 'Loyalty Tier!', data_type: 'text' });
  assert.equal(f2.field_key, 'loyalty_tier_2');
  const other = await c.post('/custom-fields', { module: 'item', label: 'Loyalty Tier', data_type: 'number' });
  assert.equal(other.field_key, 'loyalty_tier', 'keys are unique per module only');

  const upd = await c.put(`/custom-fields/${f1.id}`, { label: 'Membership Tier', options: ['Gold', 'Silver', 'Bronze'] });
  assert.equal(upd.field_key, 'loyalty_tier', 'key never changes');
  assert.equal(upd.options.length, 3);
  assert.equal((await c.call('POST', '/custom-fields', { module: 'contact', label: 'Empty', data_type: 'dropdown', options: [] }, { expectError: true })).status, 400);

  assert.equal((await c.get('/custom-fields?module=contact')).length, 2);
  await c.del(`/custom-fields/${f2.id}`);
  assert.equal((await c.get('/custom-fields?module=contact')).length, 1);
});

test('opening balances post with an offset line and keep the trial balance balanced', async () => {
  const ob = await c.put('/opening-balances', {
    date: '2026-04-01',
    lines: [{ account_id: c.acc('petty_cash'), debit: 10000 }, { account_id: c.acc('owners_equity'), credit: 4000 }],
  });
  assert.equal(ob.date, '2026-04-01');
  assert.equal(ob.lines.length, 2, 'the offset line is hidden from the entry');
  assert.equal(await bal(c, 'petty_cash'), 10000);
  assert.equal(await bal(c, 'opening_balance_offset'), 6000, 'balancing line goes to the offset account');
  assert.ok(await trialBalanced(c));

  const ar = await c.call('PUT', '/opening-balances', { date: '2026-04-01', lines: [{ account_id: c.acc('ar'), debit: 500 }] }, { expectError: true });
  assert.equal(ar.status, 400, 'receivables are entered per contact');

  await c.put('/opening-balances', { date: '2026-04-01', lines: [] });
  assert.equal(await bal(c, 'petty_cash'), 0, 'saving an empty entry clears the old one');
  assert.ok(await trialBalanced(c));
});

test('backup contains the org rows and exports work as CSV and JSON', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Backup Customer' });
  const inv = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Service', quantity: 1, rate: 500 }], save_as: 'open' });

  const backup = await c.get('/data/backup');
  assert.equal(backup.format, 'openbooks-backup');
  assert.ok(backup.tables.contacts.some((x) => x.display_name === 'Backup Customer'));
  assert.ok(backup.tables.documents.some((d) => d.id === inv.id));
  assert.ok(backup.tables.document_lines.some((l) => l.document_id === inv.id), 'child rows included');
  assert.ok(backup.tables.ledger.length > 0);
  assert.equal('users' in backup.tables, false, 'global users are not part of the org backup');

  const res = await fetch(`${srv.base}/data/export/contacts?format=csv`, {
    headers: { authorization: `Bearer ${c.st.token}`, 'x-org-id': String(c.st.org) },
  });
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(await res.text(), /Backup Customer/);

  const invoices = await c.get('/data/export/invoices');
  assert.ok(invoices.some((x) => x.number === inv.number && x.status));
  assert.equal((await c.call('GET', '/data/export/nope', null, { expectError: true })).status, 404);
});

test('workflow rule with a webhook action fires on invoice creation', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || 'null') });
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    const port = hook.address().port;
    const rule = await c.post('/automation/rules', {
      name: 'Notify on big invoices', module: 'document', doc_type: 'invoice', trigger: 'created',
      conditions: [{ field: 'total', op: 'gt', value: 100 }],
      actions: [{ type: 'webhook', url: `http://127.0.0.1:${port}/hook`, method: 'POST', headers: { 'x-source': 'openbooks' } }],
    });
    assert.equal(rule.conditions[0].op, 'gt');

    const cust = await c.post('/contacts', { type: 'customer', display_name: 'Hook Customer' });
    const big = await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Big job', quantity: 2, rate: 500 }] });
    await c.post('/documents/invoice', { contact_id: cust.id, lines: [{ name: 'Tiny', quantity: 1, rate: 20 }] });

    assert.ok(await waitFor(() => received.length > 0), 'webhook received');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 1, 'only the large invoice matches the condition');
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].headers['x-source'], 'openbooks');
    assert.equal(received[0].body.event.action, 'created');
    assert.equal(received[0].body.entity.id, big.id);
    assert.equal(received[0].body.org.id, c.st.org);

    const logs = await waitFor(async () => {
      const l = await c.get(`/automation/logs?rule_id=${rule.id}`);
      return l.some((x) => x.status === 'success') ? l : null;
    });
    assert.ok(logs, 'webhook result logged as success');
    assert.equal(logs[0].rule_name, 'Notify on big invoices');
  } finally {
    hook.close();
  }
});

test('incoming webhook adds a comment to the matching record', async () => {
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Hooked Contact' });
  const hook = await c.post('/automation/incoming-webhooks', { name: 'Billing system', module: 'contact' });
  assert.match(hook.url, /\/api\/public\/hooks\//);

  const res = await c.post(`/public/hooks/${hook.token}`, { entity_id: cust.id, text: 'Payment received from billing' });
  assert.equal(res.comment, true);
  const comments = await c.get(`/comments?entity_type=contact&entity_id=${cust.id}`);
  assert.ok(comments.some((x) => x.text === 'Payment received from billing' && x.author === 'Webhook: Billing system'));

  assert.equal((await c.call('POST', '/public/hooks/not-a-token', {}, { expectError: true })).status, 404);
});

test('reminders job emails customers about overdue invoices once per rule per day', async () => {
  await c.put('/org/settings', { reminders: { enabled: true, rules: [{ days: 3, when: 'after' }] } });
  const cust = await c.post('/contacts', { type: 'customer', display_name: 'Late Payer', email: 'late@test.dev' });
  const overdue = await c.post('/documents/invoice', {
    contact_id: cust.id, date: daysFromToday(-10), due_date: daysFromToday(-3),
    lines: [{ name: 'Retainer', quantity: 1, rate: 1000 }], save_as: 'send',
  });
  const notDue = await c.post('/documents/invoice', {
    contact_id: cust.id, date: daysFromToday(-1), due_date: daysFromToday(5),
    lines: [{ name: 'Later', quantity: 1, rate: 1000 }], save_as: 'send',
  });

  await srv.runJobs();
  let emails = await c.get('/emails');
  const mine = emails.filter((e) => e.to_addr === 'late@test.dev' && e.subject.includes(overdue.number));
  assert.equal(mine.length, 1, 'overdue invoice reminded');
  assert.match(mine[0].subject, /3 days overdue/);
  assert.equal(emails.some((e) => e.subject.includes(notDue.number)), false, 'invoice not yet due is skipped');

  await srv.runJobs();
  emails = await c.get('/emails');
  assert.equal(emails.filter((e) => e.subject.includes(overdue.number)).length, 1, 'no second reminder the same day');
});

test('currencies and payment terms: base protection, usage checks, single default', async () => {
  const base = (await c.get('/currencies')).find((x) => x.is_base);
  assert.equal(base.code, 'INR');
  assert.equal((await c.call('DELETE', `/currencies/${base.id}`, null, { expectError: true })).status, 400);

  // INR orgs are seeded with USD/EUR/GBP/AED, so these two are added fresh
  const sgd = await c.post('/currencies', { code: 'sgd', symbol: 'S$', name: 'Singapore Dollar', exchange_rate: 61.9 });
  assert.equal(sgd.code, 'SGD');
  assert.equal((await c.post(`/currencies/${sgd.id}/rate`, { rate: 62.5 })).exchange_rate, 62.5);
  await c.post('/contacts', { type: 'customer', display_name: 'Singapore Customer', currency: 'SGD' });
  assert.equal((await c.call('DELETE', `/currencies/${sgd.id}`, null, { expectError: true })).status, 400, 'in use');

  const cad = await c.post('/currencies', { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', exchange_rate: 61.2 });
  await c.del(`/currencies/${cad.id}`);

  await c.post('/payment-terms', { name: 'Net 90', days: 90, type: 'net', is_default: true });
  const t2 = await c.post('/payment-terms', { name: 'Net 120', days: 120, type: 'net', is_default: true });
  const terms = await c.get('/payment-terms');
  assert.equal(terms.filter((t) => t.is_default).length, 1, 'only one default term');
  assert.equal(terms.find((t) => t.is_default).id, t2.id);
});

test('gst settings validate GSTIN and state', async () => {
  assert.equal((await c.call('PUT', '/taxes/gst-settings', { gstin: 'BAD', state: '27' }, { expectError: true })).status, 400);
  const ok = await c.put('/taxes/gst-settings', { gstin: '27aaacr5055k1z5', state: '27', gst_enabled: true });
  assert.equal(ok.gstin, '27AAACR5055K1Z5');
  assert.equal(ok.state, '27');
  assert.equal(ok.gst_enabled, true);
});
