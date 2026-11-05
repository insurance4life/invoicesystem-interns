// My profile (/profile): personal details, password, theme, default organization and account deletion.
import { useState } from 'react';
import { setThemeAttr } from '../../lib/theme.js';
import { useApp } from '../../store.jsx';
import { api, session } from '../../api.js';
import { Button, Card, Field, Input, Modal, PageHeader, Select, Table } from '../../components/ui.jsx';
import { attempt, Note } from './common.jsx';

const SHORTCUTS = [
  { id: 'search', shortcut: '/', action: 'Search customers, items and documents' },
  { id: 'inv', shortcut: 'Alt + N', action: 'New invoice' },
  { id: 'pay', shortcut: 'Alt + P', action: 'Record a payment' },
  { id: 'exp', shortcut: 'Alt + E', action: 'New expense' },
  { id: 'bill', shortcut: 'Alt + B', action: 'New bill' },
  { id: 'cust', shortcut: 'Alt + C', action: 'New customer' },
  { id: 'home', shortcut: 'Alt + H', action: 'Go to Home' },
];

const SHORTCUT_COLUMNS = [
  { key: 'shortcut', label: 'Shortcut', render: (s) => <code>{s.shortcut}</code> },
  { key: 'action', label: 'Action' },
];

export default function Profile() {
  const { user, setUser, orgs, toast, logout } = useApp();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [emailPw, setEmailPw] = useState('');
  const emailChanged = email.trim().toLowerCase() !== (user?.email || '').toLowerCase();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
  const [defaultOrg, setDefaultOrg] = useState(user?.default_org_id || '');
  const [busy, setBusy] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const saveDetails = async () => {
    setBusy('details');
    const body = { name: name.trim(), email: email.trim() };
    if (emailChanged) body.current_password = emailPw;
    const out = await attempt(toast, () => api.put('/auth/me', body), 'Profile updated');
    if (out) { setUser({ ...user, ...out.user }); setEmailPw(''); }
    setBusy('');
  };

  const changePassword = async () => {
    if (pw.next.length < 6) return toast('The new password must be at least 6 characters', 'error');
    if (pw.next !== pw.confirm) return toast('The new passwords do not match', 'error');
    setBusy('password');
    const out = await attempt(toast, () => api.put('/auth/me', { current_password: pw.current, new_password: pw.next }), 'Password changed');
    if (out) {
      if (out.token) session.token = out.token; // other sessions end with the old password
      setPw({ current: '', next: '', confirm: '' });
    }
    setBusy('');
  };

  const applyTheme = async (t) => {
    setTheme(t);
    setThemeAttr(t);
    try { localStorage.setItem('ob_theme', t); } catch { /* storage unavailable: the choice still applies for this visit */ }
    const out = await attempt(toast, () => api.put('/auth/me', { theme: t }), null);
    if (out) setUser({ ...user, theme: t });
  };

  const saveDefaultOrg = async () => {
    const id = Number(defaultOrg);
    const out = await attempt(toast, () => api.put('/auth/me', { default_org_id: id }), 'Default organization saved');
    if (out) setUser({ ...user, default_org_id: id });
  };

  const closeDelete = () => { setDeleteOpen(false); setConfirmText(''); };

  const deleteAccount = async () => {
    setBusy('delete');
    const out = await attempt(toast, () => api.del('/auth/me'), 'Your account has been deleted');
    setBusy('');
    if (out) logout();
  };

  return (
    <div className="page">
      <PageHeader title="My profile" subtitle={user?.email} />

      <div className="form-section">
        <h3>Personal details</h3>
        <div className="form-grid">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {emailChanged && (
            <Field label="Current password" required hint="Needed to change your email.">
              <Input type="password" autoComplete="current-password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Button variant="primary" loading={busy === 'details'} disabled={!name.trim() || !email.trim() || (emailChanged && !emailPw)} onClick={saveDetails}>Save details</Button>
        </div>
      </div>

      <div className="form-section">
        <h3>Change password</h3>
        <div className="form-grid">
          <Field label="Current password" required>
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <div />
          <Field label="New password" required hint="At least 6 characters.">
            <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <Field label="Confirm new password" required>
            <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Button variant="primary" loading={busy === 'password'} disabled={!pw.current || !pw.next} onClick={changePassword}>Change password</Button>
        </div>
      </div>

      <div className="form-section">
        <h3>Appearance and organization</h3>
        <div className="form-grid">
          <Field label="Theme">
            <div className="row" style={{ gap: 8 }}>
              <Button variant={theme === 'light' ? 'primary' : 'secondary'} onClick={() => applyTheme('light')}>Light</Button>
              <Button variant={theme === 'dark' ? 'primary' : 'secondary'} onClick={() => applyTheme('dark')}>Dark</Button>
            </div>
          </Field>
          <div />
          <Field label="Default organization" hint="Opens this organization when you sign in.">
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Select options={(orgs || []).map((o) => [o.id, o.name])} value={defaultOrg} onChange={(e) => setDefaultOrg(e.target.value)} />
              </div>
              <Button disabled={!defaultOrg} onClick={saveDefaultOrg}>Save</Button>
            </div>
          </Field>
        </div>
      </div>

      <Card title="Keyboard shortcuts" pad={false}>
        <Table columns={SHORTCUT_COLUMNS} rows={SHORTCUTS} />
      </Card>

      <div className="form-section" style={{ marginTop: 16 }}>
        <h3 style={{ color: 'var(--red)' }}>Delete account</h3>
        <p className="muted small">Your sign-in is removed. Organizations where you are the only Admin are deleted together with their data.</p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete my account</Button>
      </div>

      {deleteOpen && (
        <Modal
          title="Delete your account?"
          onClose={closeDelete}
          footer={<>
            <Button onClick={closeDelete}>Cancel</Button>
            <Button variant="danger" loading={busy === 'delete'} disabled={confirmText !== 'DELETE'} onClick={deleteAccount}>Delete account</Button>
          </>}
        >
          <p>This cannot be undone. Type <b>DELETE</b> to confirm.</p>
          <Field label="Confirmation"><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field>
          <Note>Organizations you share with other Admins keep their data.</Note>
        </Modal>
      )}
    </div>
  );
}
