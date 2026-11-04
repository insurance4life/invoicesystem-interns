import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Button, Field, Input } from '../../components/ui.jsx';

export default function Login() {
  const { login } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/auth/login', f);
      await login(r.token);
      nav('/');
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ background: 'none', color: 'var(--fg)', padding: 0, marginBottom: 12 }}><span className="brand-logo">📘</span>OpenBooks</div>
        <h1>Sign in</h1>
        <div className="muted">to access your books</div>
        <div className="stack">
          <Field label="Email address"><Input type="email" autoFocus required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Password"><Input type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          {err && <div className="field-error">{err}</div>}
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%', justifyContent: 'center' }}>Sign in</Button>
          <div className="muted center">Don't have an account? <Link to="/signup">Sign up now</Link></div>
          <div className="muted small center">Demo: run <code>npm run seed</code>, then sign in as demo@openbooks.local / demo1234</div>
        </div>
      </form>
    </div>
  );
}
