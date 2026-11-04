// Regression tests for the third round of security-audit fixes: error responses, public share links, the SPA file
// handler, opening-balance and item-deletion guards, fixed-asset life and webhook response handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, signup } from './helpers.js';

let srv, a;
// the webhook test posts to a local listener, which the destination policy only allows when opted in
before(async () => { srv = await startServer({ OPENBOOKS_WEBHOOK_ALLOW_PRIVATE: '1' }); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
const site = () => srv.base.replace(/\/api$/, '');

test('server errors do not echo exception text, and signup validates its input', async () => {
  const bank = await a.post('/banking/accounts', { name: 'Err Bank', type: 'bank' });
  const r = await a.call('POST', `/banking/accounts/${bank.id}/statement-lines/bulk-categorize`, { ids: null }, { expectError: true });
  assert.equal(r.status, 500);
  assert.match(r.error, /^Something went wrong \(reference [0-9a-f]+\)$/);
  const res = await fetch(`${srv.base}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', email: `bad${Date.now()}@p3.test`, password: 'secret123', organization: 'not an object' }) });
  assert.equal(res.status, 400);
});

test('share links show only Show-on-PDF custom fields and stop working after the customer changes', async () => {
  const shown = await a.post('/custom-fields', { module: 'invoice', label: 'PO Number', data_type: 'text', show_in_pdf: true });
  const hidden = await a.post('/custom-fields', { module: 'invoice', label: 'Internal Margin', data_type: 'text' });
  const c1 = await a.post('/contacts', { type: 'customer', display_name: 'First Customer' });
  const c2 = await a.post('/contacts', { type: 'customer', display_name: 'Second Customer' });
  const inv = await a.post('/documents/invoice', { contact_id: c1.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }], save_as: 'send',
    custom_fields: { [shown.field_key]: 'PO-7', [hidden.field_key]: '42%' } });
  const token = (await a.get(`/documents/invoice/${inv.id}`)).share_token;

  const pub = await (await fetch(`${srv.base}/public/share/${token}`)).json();
  assert.deepEqual(pub.doc.custom_fields, { [shown.field_key]: 'PO-7' });

  await a.put(`/documents/invoice/${inv.id}`, { contact_id: c2.id, lines: [{ name: 'Job', quantity: 1, rate: 100 }] });
  assert.equal((await fetch(`${srv.base}/public/share/${token}`)).status, 404);
  const fresh = (await a.get(`/documents/invoice/${inv.id}`)).share_token;
  assert.equal((await fetch(`${srv.base}/public/share/${fresh}`)).status, 200);
});

test('the SPA handler never serves files outside the client build', async () => {
  for (const p of ['/%5C%5C127.0.0.1%5Cshare%5Cx', '/..%2F..%2Fbackend%2Fdata%2F.secret', '/C:%5CWindows%5Cwin.ini', '/assets/..%2F..%2F..%2Fpackage.json']) {
    const res = await fetch(site() + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/, `${p} falls back to the app shell`);
  }
});

test('opening balances cannot be replaced when the existing ones are locked', async () => {
  const o = await signup(srv.base);
  await o.put('/opening-balances', { date: '2025-01-01', lines: [{ account_id: o.acc('petty_cash'), debit: 1000 }, { account_id: o.acc('owners_equity'), credit: 1000 }] });
  await o.put('/org', { lock_date: '2025-06-30' });
  assert.equal(await status(o, 'PUT', '/opening-balances', { date: '2025-07-02', lines: [] }), 400);
});

test('an item with inventory adjustments cannot be deleted', async () => {
  const item = await a.post('/items', { name: 'Adjusted', type: 'goods', purchase_price: 10, track_inventory: 1, opening_stock: 10, opening_stock_rate: 10 });
  await a.post('/inventory/adjustments', { mode: 'quantity', reason: 'Damaged', status: 'adjusted', lines: [{ item_id: item.id, qty_change: -1 }] });
  assert.equal(await status(a, 'DELETE', `/items/${item.id}`), 400);
});

test('fixed-asset useful life is bounded', async () => {
  assert.equal(await status(a, 'POST', '/fixed-assets', { name: 'Forever desk', asset_account_id: a.acc('furniture'), purchase_date: '2026-01-01',
    purchase_value: 1000, salvage_value: 0, useful_life_months: 95000, method: 'straight_line' }), 400);
});

test('webhooks finish on the status code without reading the response body', async () => {
  // a listener that answers 200 and then keeps streaming forever
  const hook = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const t = setInterval(() => res.write('x'.repeat(1024)), 20);
    req.on('close', () => clearInterval(t));
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    const rule = await a.post('/automation/rules', { name: 'Stream', module: 'contact', trigger: 'created',
      actions: [{ type: 'webhook', url: `http://127.0.0.1:${hook.address().port}/s`, method: 'POST' }] });
    await a.post('/contacts', { type: 'customer', display_name: 'Hooked' });
    let logs = [];
    for (let i = 0; i < 60 && !logs.some((x) => x.status !== 'pending'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      logs = await a.get(`/automation/logs?rule_id=${rule.id}`);
    }
    assert.equal(logs[0].status, 'success', 'logged as soon as the status arrives');
  } finally {
    hook.closeAllConnections();
    hook.close();
  }
});
