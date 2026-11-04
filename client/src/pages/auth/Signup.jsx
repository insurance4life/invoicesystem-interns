import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, session } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Button, Field, Input, Select } from '../../components/ui.jsx';
import { INDIAN_STATES } from '@shared/calc.js';

export default function Signup() {
  const { login } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', org: '', country: 'India', state: '27', currency: 'INR' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/auth/signup', {
        name: f.name, email: f.email, password: f.password,
        organization: { name: f.org || `${f.name}'s Business`, country: f.country, state: f.country === 'India' ? f.state : null, currency: f.currency },
      });
      session.orgId = r.org_id;
      await login(r.token);
      nav('/');
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Create your account</h1>
        <div className="muted">Set up your organization in a minute.</div>
        <div className="stack">
          <Field label="Your name" required><Input autoFocus required value={f.name} onChange={set('name')} /></Field>
          <Field label="Email address" required><Input type="email" required value={f.email} onChange={set('email')} /></Field>
          <Field label="Password" required hint="At least 6 characters"><Input type="password" required minLength={6} value={f.password} onChange={set('password')} /></Field>
          <Field label="Organization name"><Input value={f.org} onChange={set('org')} placeholder="e.g. Zylker Traders" /></Field>
          <div className="grid2">
            <Field label="Country"><Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value, currency: e.target.value === 'India' ? 'INR' : 'USD' })} options={['India', 'United States', 'United Kingdom', 'United Arab Emirates', 'Singapore', 'Australia', 'Canada'].map((x) => [x, x])} /></Field>
            <Field label="Currency"><Select value={f.currency} onChange={set('currency')} options={['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'].map((x) => [x, x])} /></Field>
          </div>
          {f.country === 'India' && <Field label="State / Union Territory" hint="Used to decide CGST+SGST vs IGST"><Select value={f.state} onChange={set('state')} options={INDIAN_STATES} /></Field>}
          {err && <div className="field-error">{err}</div>}
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%', justifyContent: 'center' }}>Create account</Button>
          <div className="muted center">Already have an account? <Link to="/login">Sign in</Link></div>
        </div>
      </form>
    </div>
  );
}
