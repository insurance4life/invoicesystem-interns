// Run-4 final-critic fixes: GSTR-1 needs sales view, sales receipt deposit account type, webhook URL credentials
// masked, and workflow rules stop when their author loses the rights they needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let srv, a;
before(async () => { srv = await startServer({ OPENBOOKS_AUTH_RATE_LIMIT: '500' }); a = await signup(srv.base); });
after(() => srv.close());

const status = async (cl, method, url, body) => (await cl.call(method, url, body, { expectError: true })).status;
let seq = 0;
const newEmail = () => `run4f_${++seq}_${Date.now()}@run4f.test`;
const makeRole = (permissions) => a.post('/roles', { name: `Run4f role ${++seq} ${Date.now()}`, permissions });
async function member(role, email) {
  const inv = await a.post('/users/invite', { name: email, email, role_id: role.id });
  const s = client(srv.base);
  s.st.token = (await s.post('/auth/login', { email, password: inv.temp_password })).token;
  s.st.org = a.st.org;
  s.uid = inv.id;
  return s;
}
const accountOf = async (code) => (await a.get('/accounts')).find((x) => x.system_code === code);

test('GSTR-1 lists invoices, so it needs sales view on top of reports view', async () => {
  const s = await member(await makeRole({ reports: ['view'] }), newEmail());
  assert.equal(await status(s, 'GET', '/reports/gstr1'), 403);
  assert.equal(await status(s, 'GET', '/reports/gstr1/json'), 403);
  assert.ok(await s.get('/reports/profit-loss'), 'summary reports still work');
  assert.ok(await a.get('/reports/gstr1'), 'control: the Admin can open it');
});

test('a sales receipt must be deposited to a bank, cash, card or clearing account', async () => {
  const cust = await a.post('/contacts', { type: 'customer', display_name: `Run4f receipt ${Date.now()}` });
  const lines = [{ name: 'Counter sale', quantity: 1, rate: 100 }];
  const equity = await accountOf('owners_equity');
  const s = await member(await makeRole({ sales: ['view', 'create', 'edit'], contacts: ['view'] }), newEmail());
  assert.equal(await status(s, 'POST', '/documents/salesreceipt', { contact_id: cust.id, lines, account_id: equity.id }), 400);
  const ok = await s.post('/documents/salesreceipt', { contact_id: cust.id, lines });
  assert.equal(ok.doc_type, 'salesreceipt', 'the default deposit account still works');
});

test('webhook URLs with user:password are masked for read-only settings roles', async () => {
  const url = 'https://hookuser:hookpass-9921@hooks.example.com/run4f';
  const rule = await a.post('/automation/rules', {
    name: `Run4f userinfo ${Date.now()}`, module: 'contact', trigger: 'created', actions: [{ type: 'webhook', url, method: 'POST' }],
  });
  const s = await member(await makeRole({ settings: ['view'] }), newEmail());
  const masked = (await s.get('/automation/rules')).find((r) => r.id === rule.id).actions[0].url;
  assert.ok(!masked.includes('hookpass-9921') && !masked.includes('hookuser'), `credentials hidden: ${masked}`);
  assert.ok(masked.startsWith('https://hooks.example.com'), 'the host is still shown');
  assert.equal((await a.get('/automation/rules')).find((r) => r.id === rule.id).actions[0].url, url, 'control: the Admin sees it');
});

test('a workflow rule stops running once its author loses the rights it needed', async () => {
  const role = await makeRole({ settings: ['view', 'create'], contacts: ['view'] });
  const s = await member(role, newEmail());
  const rule = await s.post('/automation/rules', {
    name: `Run4f author ${Date.now()}`, module: 'contact', trigger: 'created',
    actions: [{ type: 'email', to: 'author-check@run4f.test', subject: 'New contact', body: 'b' }],
  });
  await a.post('/contacts', { type: 'customer', display_name: `Run4f fires ${Date.now()}` });
  let logs = await a.get(`/automation/logs?rule_id=${rule.id}`);
  assert.ok(logs.some((l) => l.action_type === 'email'), 'control: the rule runs while its author has the rights');

  const lesser = await makeRole({ settings: ['view', 'create'] });
  await a.put(`/users/${s.uid}`, { role_id: lesser.id });
  await a.post('/contacts', { type: 'customer', display_name: `Run4f skipped ${Date.now()}` });
  logs = await a.get(`/automation/logs?rule_id=${rule.id}`);
  assert.ok(logs.some((l) => l.status === 'failed' && /no longer has the access/.test(l.message || '')), 'the rule is skipped and logged');
});
