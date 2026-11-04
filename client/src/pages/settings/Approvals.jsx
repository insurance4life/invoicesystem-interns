import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Checkbox } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const APPROVABLE = [
  ['invoice', 'Invoices'], ['bill', 'Bills'], ['salesorder', 'Sales orders'], ['purchaseorder', 'Purchase orders'],
  ['creditnote', 'Credit notes'], ['vendorcredit', 'Vendor credits'],
];

export default function Approvals() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [flags, setFlags] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) setFlags(Object.fromEntries(APPROVABLE.map(([k]) => [k, !!settings.approvals?.[k]])));
  }, [settings]);

  if (!flags) return <SettingsPage title="Approvals"><div className="muted">Loading…</div></SettingsPage>;

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put('/org/settings', { approvals: flags }), 'Approval settings saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  return (
    <SettingsPage title="Approvals" subtitle="Documents switched on here must be approved before they are sent or posted.">
      <div className="form-section">
        <div className="form-grid">
          {APPROVABLE.map(([k, label]) => (
            <Checkbox key={k} label={`${label} need approval`} checked={flags[k]} disabled={!canEdit}
              onChange={(v) => setFlags((f) => ({ ...f, [k]: v }))} />
          ))}
        </div>
        <Note>Approve or reject waiting documents on the <Link to="/approvals">Approvals</Link> page.</Note>
      </div>
      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save approval settings</Button>
        </div>
      )}
    </SettingsPage>
  );
}
