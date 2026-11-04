import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Checkbox, NumberInput, Select, Card } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const WHEN = [['before', 'days before the due date'], ['after', 'days after the due date']];

export default function Reminders() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const r = settings.reminders || {};
    setCfg({ enabled: !!r.enabled, rules: (r.rules || []).map((x) => ({ days: x.days, when: x.when })) });
  }, [settings]);

  if (!cfg) return <SettingsPage title="Reminders"><div className="muted">Loading…</div></SettingsPage>;

  const setRule = (i, patch) => setCfg((c) => ({ ...c, rules: c.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const removeRule = (i) => setCfg((c) => ({ ...c, rules: c.rules.filter((_, j) => j !== i) }));

  const save = async () => {
    setSaving(true);
    const body = { enabled: cfg.enabled, rules: cfg.rules.map((r) => ({ days: Number(r.days) || 0, when: r.when })) };
    const out = await attempt(toast, () => api.put('/org/settings', { reminders: body }), 'Reminder settings saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  const runNow = async () => {
    setRunning(true);
    const out = await attempt(toast, () => api.post('/reminders/run'), null);
    setRunning(false);
    if (out) toast(out.sent ? `Sent ${out.sent} reminder${out.sent === 1 ? '' : 's'}` : 'No reminders were due today');
  };

  return (
    <SettingsPage
      title="Payment reminders"
      subtitle="Email customers automatically about invoices that are coming due or are overdue."
      actions={canEdit && <Button loading={running} onClick={runNow}>Run now</Button>}
    >
      <div className="form-section">
        <Checkbox label="Send payment reminders automatically" checked={cfg.enabled} disabled={!canEdit} onChange={(v) => setCfg({ ...cfg, enabled: v })} />
        <Note>Reminders go to customers with reminders turned on, for open invoices with an amount due. Each rule sends at most once a day per invoice.</Note>
      </div>

      <Card title="Rules">
        <div className="stack">
          {cfg.rules.length === 0 && <span className="muted">No rules yet. Add one to start sending reminders.</span>}
          {cfg.rules.map((r, i) => (
            <div key={i} className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="muted">Send a reminder</span>
              <div style={{ width: 90 }}>
                <NumberInput min={0} value={r.days} disabled={!canEdit} onChange={(v) => setRule(i, { days: v })} />
              </div>
              <div style={{ width: 240 }}>
                <Select options={WHEN} value={r.when} disabled={!canEdit} onChange={(e) => setRule(i, { when: e.target.value })} />
              </div>
              {canEdit && <Button size="sm" variant="link" onClick={() => removeRule(i)}>Remove</Button>}
            </div>
          ))}
          {canEdit && (
            <div>
              <Button size="sm" onClick={() => setCfg((c) => ({ ...c, rules: [...c.rules, { days: 3, when: 'after' }] }))}>+ Add rule</Button>
            </div>
          )}
        </div>
      </Card>

      <p className="muted small" style={{ marginTop: 12 }}>
        Reminder emails use the Payment reminder template. Edit it under <Link to="/settings/email-templates">Email templates</Link>.
      </p>

      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save reminder settings</Button>
        </div>
      )}
    </SettingsPage>
  );
}
