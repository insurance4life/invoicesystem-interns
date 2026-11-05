import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Card, Checkbox, Field, Input, Select, Modal } from '../../components/ui.jsx';
import { INDIAN_STATES } from '@shared/calc.js';
import { fmtDate } from '../../lib/format.js';
import { SettingsPage, attempt, Note } from './common.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_FORMATS = ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd MMM yyyy', 'dd-MM-yyyy'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const CURRENCY_CODES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'];
const COUNTRIES = ['India', 'United States', 'United Kingdom', 'United Arab Emirates', 'Singapore', 'Australia', 'Canada', 'Other'];

function toForm(org) {
  return {
    name: org.name || '', industry: org.industry || '', country: org.country || '', state: org.state || '',
    currency: org.currency || 'INR', fiscal_year_start: org.fiscal_year_start || 1, timezone: org.timezone || 'Asia/Kolkata',
    date_format: org.date_format || 'dd/MM/yyyy', gstin: org.gstin || '', phone: org.phone || '', email: org.email || '',
    website: org.website || '', address: { street: '', city: '', state: '', zip: '', country: '', ...(org.address || {}) },
  };
}

export default function OrgProfile() {
  const { org, meta, refreshMeta, toast, can, reload } = useApp();
  const nav = useNavigate();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null); // 'delete' | 'leave' | 'reset'
  const [clearOpenings, setClearOpenings] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = can('settings', 'edit');
  const isAdmin = meta?.role === 'Admin';

  useEffect(() => { if (org) setForm(toForm(org)); }, [org]);

  if (!form) return <SettingsPage title="Organization profile"><div className="muted">Loading…</div></SettingsPage>;

  const put = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const putAddr = (k, v) => setForm((f) => ({ ...f, address: { ...f.address, [k]: v } }));
  const inIndia = (form.country || 'India') === 'India';
  const tzOptions = [...new Set([form.timezone, ...TIMEZONES])];

  const save = async () => {
    setSaving(true);
    const payload = { ...form, gstin: form.gstin.trim().toUpperCase(), fiscal_year_start: Number(form.fiscal_year_start) };
    const out = await attempt(toast, () => api.put('/org', payload), 'Organization profile saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  const finish = async (fn, msg) => {
    setBusy(true);
    const out = await attempt(toast, fn, msg);
    setBusy(false);
    if (out) {
      setModal(null);
      setConfirmText('');
      await reload();
      nav('/');
    }
  };

  return (
    <SettingsPage title="Organization profile" subtitle="Details printed on documents and used for tax and reporting.">
      <div className="form-section">
        <h3>Basic details</h3>
        <div className="form-grid">
          <Field label="Organization name" required>
            <Input value={form.name} disabled={!canEdit} onChange={(e) => put('name', e.target.value)} />
          </Field>
          <Field label="Industry">
            <Input value={form.industry} disabled={!canEdit} onChange={(e) => put('industry', e.target.value)} />
          </Field>
          <Field label="Country">
            <Input list="ob-countries" value={form.country} disabled={!canEdit} onChange={(e) => put('country', e.target.value)} />
            <datalist id="ob-countries">{COUNTRIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="State" hint={inIndia ? 'Used to decide CGST+SGST or IGST' : undefined}>
            {inIndia
              ? <Select options={INDIAN_STATES} placeholder="Select a state" value={form.state} disabled={!canEdit} onChange={(e) => put('state', e.target.value)} />
              : <Input value={form.state} disabled={!canEdit} onChange={(e) => put('state', e.target.value)} />}
          </Field>
          <Field label="Base currency" hint="Cannot change once transactions exist.">
            <Select options={[...new Set([form.currency, ...CURRENCY_CODES])].map((c) => [c, c])} value={form.currency} disabled={!canEdit} onChange={(e) => put('currency', e.target.value)} />
          </Field>
          <Field label="Fiscal year starts">
            <Select options={MONTHS.map((m, i) => [i + 1, m])} value={form.fiscal_year_start} disabled={!canEdit} onChange={(e) => put('fiscal_year_start', e.target.value)} />
          </Field>
          <Field label="Time zone">
            <Select options={tzOptions.map((z) => [z, z])} value={form.timezone} disabled={!canEdit} onChange={(e) => put('timezone', e.target.value)} />
          </Field>
          <Field label="Date format" hint={`Example: ${fmtDate('2026-03-05', form.date_format)}`}>
            <Select options={DATE_FORMATS.map((f) => [f, f])} value={form.date_format} disabled={!canEdit} onChange={(e) => put('date_format', e.target.value)} />
          </Field>
          <Field label="GSTIN" hint="Also managed under GST Settings.">
            <Input value={form.gstin} maxLength={15} disabled={!canEdit} onChange={(e) => put('gstin', e.target.value.toUpperCase())} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Address and contact</h3>
        <div className="form-grid">
          <Field label="Street">
            <Input value={form.address.street || ''} disabled={!canEdit} onChange={(e) => putAddr('street', e.target.value)} />
          </Field>
          <Field label="City">
            <Input value={form.address.city || ''} disabled={!canEdit} onChange={(e) => putAddr('city', e.target.value)} />
          </Field>
          <Field label="State / Province">
            <Input value={form.address.state || ''} disabled={!canEdit} onChange={(e) => putAddr('state', e.target.value)} />
          </Field>
          <Field label="ZIP / Postal code">
            <Input value={form.address.zip || ''} disabled={!canEdit} onChange={(e) => putAddr('zip', e.target.value)} />
          </Field>
          <Field label="Address country">
            <Input value={form.address.country || ''} disabled={!canEdit} onChange={(e) => putAddr('country', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} disabled={!canEdit} onChange={(e) => put('phone', e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} disabled={!canEdit} onChange={(e) => put('email', e.target.value)} />
          </Field>
          <Field label="Website">
            <Input value={form.website} disabled={!canEdit} onChange={(e) => put('website', e.target.value)} />
          </Field>
        </div>
      </div>

      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
      <Card title="Danger zone">
        <div className="row between" style={{ marginBottom: 12 }}>
          <div>
            <div className="bold">Leave organization</div>
            <Note>You will lose access to this organization. An Admin can add you back.</Note>
          </div>
          <Button variant="secondary" onClick={() => setModal('leave')}>Leave organization</Button>
        </div>
        {isAdmin && can('settings', 'delete') && (
          <div className="row between" style={{ marginBottom: 12 }}>
            <div>
              <div className="bold">Clear all transactions</div>
              <Note>Start the books again. Settings, users, contacts, items, accounts and taxes stay.</Note>
            </div>
            <Button variant="danger" onClick={() => setModal('reset')}>Clear transactions</Button>
          </div>
        )}
        {isAdmin && can('settings', 'delete') && (
          <div className="row between">
            <div>
              <div className="bold">Delete organization</div>
              <Note>Permanently deletes all books, documents and contacts of this organization.</Note>
            </div>
            <Button variant="danger" onClick={() => setModal('delete')}>Delete organization</Button>
          </div>
        )}
      </Card>
      </div>

      {modal === 'leave' && (
        <Modal title="Leave organization" onClose={() => setModal(null)} footer={<>
          <Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => finish(() => api.post('/org/leave'), 'You have left the organization')}>Leave</Button>
        </>}>
          <p>Are you sure you want to leave <b>{org.name}</b>?</p>
        </Modal>
      )}

      {modal === 'reset' && (
        <Modal title="Clear all transactions" onClose={() => { setModal(null); setConfirmText(''); }} footer={<>
          <Button onClick={() => { setModal(null); setConfirmText(''); }}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={confirmText !== org.name}
            onClick={() => finish(() => api.post('/org/reset-transactions', { confirm: confirmText, clear_opening_balances: clearOpenings }), 'Transactions cleared')}>Clear permanently</Button>
        </>}>
          <p>This permanently deletes every quote, order, invoice, bill, credit note, payment, expense, journal, bank transaction,
            reconciliation, inventory adjustment, fixed asset and time entry in <b>{org.name}</b>, with their attachments and history.
            Number series restart at 1 and the lock date is removed.</p>
          <p>Kept: organization settings, users and roles, chart of accounts, contacts, items, taxes, TDS sections, projects, budgets and rules.</p>
          <Checkbox label="Also clear opening balances (accounts, contacts and item stock)" checked={clearOpenings} onChange={setClearOpenings} />
          <p className="mt">Download a backup first from Settings → Backup and Export if you may need this data. Type <b>{org.name}</b> to confirm.</p>
          <Field label="Organization name"><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field>
        </Modal>
      )}

      {modal === 'delete' && (
        <Modal title="Delete organization" onClose={() => setModal(null)} footer={<>
          <Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={confirmText !== org.name}
            onClick={() => finish(() => api.del('/org'), 'Organization deleted')}>Delete permanently</Button>
        </>}>
          <p>This cannot be undone. Type <b>{org.name}</b> to confirm.</p>
          <Field label="Organization name"><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} /></Field>
        </Modal>
      )}
    </SettingsPage>
  );
}
