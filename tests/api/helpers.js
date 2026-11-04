// API conformance-test helpers: boots the Django API on a random port against a throw-away PostgreSQL database.
// Requires PostgreSQL to be running (see docker-compose.yml) and the backend dependencies installed.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbooks-test-'));
  const dbName = `obtest_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const env = { ...process.env, PGDATABASE: dbName, DATA_DIR: dataDir, OPENBOOKS_TESTING: '1', OPENBOOKS_JOBS: '0', PYTHONUNBUFFERED: '1', ...extraEnv };
  execFileSync(PYTHON, ['manage.py', 'testdb', 'create', dbName], { cwd: BACKEND, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const proc = spawn(PYTHON, ['manage.py', 'serve', '--port', '0', '--no-jobs'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (process.env.TEST_SERVER_LOGS) process.stderr.write(d); });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`server did not start:\n${stderr}`)), 60000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${stderr}`)); });
  });
  proc.removeAllListeners('exit');
  const base = `http://127.0.0.1:${port}/api`;
  const runJobs = async () => {
    const r = await fetch(`${base}/_internal/run-jobs`, { method: 'POST' });
    if (!r.ok) throw new Error(`run-jobs failed: ${r.status} ${await r.text()}`);
  };
  const close = async () => {
    await new Promise((r) => { proc.once('exit', r); proc.kill(); setTimeout(r, 5000); });
    try { execFileSync(PYTHON, ['manage.py', 'testdb', 'drop', dbName], { cwd: BACKEND, env, stdio: 'ignore' }); } catch { /* ignore */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, server: proc, runJobs, close, logs: () => stderr };
}

/** Minimal API client. `call('POST', '/documents/invoice', body)` → json (throws on HTTP errors). */
export function client(base) {
  const st = { token: null, org: null };
  async function call(method, url, body, { expectError = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(st.token ? { authorization: `Bearer ${st.token}` } : {}), ...(st.org ? { 'x-org-id': String(st.org) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (expectError) {
      if (res.ok) throw new Error(`Expected ${method} ${url} to fail but got ${res.status}`);
      return { status: res.status, ...data };
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
  return { st, call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

/** Sign up a fresh user + org and return an authenticated client. */
export async function signup(base, email = `u${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.dev`, organization = { name: 'Test Co', state: '27' }) {
  const c = client(base);
  const r = await c.post('/auth/signup', { name: 'Tester', email, password: 'secret123', organization });
  c.st.token = r.token;
  c.st.org = r.org_id;
  c.meta = await c.get('/meta');
  c.acc = (code) => c.meta.accounts.find((a) => a.system_code === code)?.id;
  c.tax = (name) => c.meta.taxes.find((t) => t.name === name)?.id;
  return c;
}

/** Sum of all ledger lines must balance. */
export async function trialBalanced(c) {
  const accs = await c.get('/accounts');
  const d = accs.reduce((s, a) => s + a.debit, 0);
  const cr = accs.reduce((s, a) => s + a.credit, 0);
  return Math.abs(d - cr) < 0.01;
}

export const bal = async (c, code) => (await c.get('/accounts')).find((a) => a.system_code === code)?.balance ?? 0;
