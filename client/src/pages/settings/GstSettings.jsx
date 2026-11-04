import { useEffect, useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui.jsx';
import { INDIAN_STATES } from '@shared/calc.js';
import { SettingsPage, attempt, Note } from './common.jsx';

export default function GstSettings() {
  const { org, refreshMeta, toast, can } = useApp();
  const gst = useFetch('/taxes/gst-settings');
  const canEdit = can('settings', 'edit');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (gst.data) setForm({ gstin: gst.data.gstin || '', state: gst.data.state || '', gst_enabled: !!gst.data.gst_enabled });
  }, [gst.data]);

  if (!form) return <SettingsPage title="GST settings"><div className="muted">Loading…</div></SettingsPage>;

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put('/taxes/gst-settings', { ...form, gstin: form.gstin.trim().toUpperCase() }), 'GST settings saved');
    if (out) { gst.reload(); refreshMeta().catch(() => {}); }
    setSaving(false);
  };

  return (
    <SettingsPage title="GST settings" subtitle="Your GST registration and how GST applies to transactions.">
      {org?.country && org.country !== 'India' && (
        <div className="callout warn">GST applies to Indian organizations. Your organization is set to {org.country}.</div>
      )}
      <div className="form-section">
        <h3>Registration</h3>
        <div className="form-grid">
          <Field label="GSTIN" hint="15 characters, e.g. 27AAACR5055K1Z5. Leave blank if you are not registered.">
            <Input value={form.gstin} maxLength={15} disabled={!canEdit} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Home state" hint="Sales within this state use CGST + SGST. Other states use IGST.">
            <Select options={INDIAN_STATES} placeholder="Select a state" value={form.state} disabled={!canEdit}
              onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </Field>
          <div className="stack">
            <Checkbox label="Enable GST on transactions" checked={form.gst_enabled} disabled={!canEdit} onChange={(v) => setForm({ ...form, gst_enabled: v })} />
            <Note>Turn this off only if you do not charge GST at all.</Note>
          </div>
        </div>
      </div>
      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save GST settings</Button>
        </div>
      )}
    </SettingsPage>
  );
}
