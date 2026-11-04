import { useEffect, useState } from 'react';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';
import { EMAIL_DEFAULTS, EMAIL_TYPE_LABELS, EMAIL_PLACEHOLDERS, EMAIL_SAMPLE } from './emailDefaults.js';

// Replace {placeholders} with sample values for the preview.
const fill = (text) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (EMAIL_SAMPLE[k] !== undefined ? EMAIL_SAMPLE[k] : m));

export default function EmailTemplates() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [type, setType] = useState('invoice');
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the saved template for the selected type, or the default when none is saved.
  useEffect(() => {
    const saved = settings?.email_templates?.[type];
    setCustom(!!saved);
    setDraft(saved ? { subject: saved.subject || '', body: saved.body || '' } : { ...EMAIL_DEFAULTS[type] });
  }, [type, settings]);

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put('/org/settings', { email_templates: { [type]: { subject: draft.subject, body: draft.body } } }), 'Email template saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  // A null entry removes the custom template, so the server falls back to its default.
  const reset = async () => {
    if (!window.confirm('Reset this template to the default text?')) return;
    setSaving(true);
    const out = await attempt(toast, () => api.put('/org/settings', { email_templates: { [type]: null } }), 'Template reset to default');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  return (
    <SettingsPage
      title="Email templates"
      subtitle="The subject and message sent with each document. Placeholders are filled in when the email is sent."
      actions={<Badge color={custom ? 'blue' : 'gray'}>{custom ? 'Customised' : 'Default'}</Badge>}
    >
      <div className="form-section">
        <div className="form-grid">
          <Field label="Document type">
            <Select options={Object.entries(EMAIL_TYPE_LABELS)} value={type} onChange={(e) => setType(e.target.value)} />
          </Field>
          <div />
          <Field label="Subject" required>
            <Input value={draft.subject} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </Field>
          <Field label="Message" required>
            <Textarea rows={10} value={draft.body} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
        </div>
        {canEdit && (
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Button variant="primary" loading={saving} disabled={!draft.subject.trim() || !draft.body.trim()} onClick={save}>Save template</Button>
            <Button variant="secondary" disabled={saving || !custom} onClick={reset}>Reset to default</Button>
          </div>
        )}
      </div>

      <div className="form-section">
        <h3>Placeholders</h3>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {EMAIL_PLACEHOLDERS.map(([k, label]) => (
            <div key={k} className="small">
              <code>{`{${k}}`}</code> <span className="muted">{label}</span>
            </div>
          ))}
        </div>
        <Note>Placeholders that are not available for a document are left as written.</Note>
      </div>

      <div className="form-section">
        <h3>Preview</h3>
        <div className="bold" style={{ marginBottom: 8 }}>Subject: {fill(draft.subject)}</div>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{fill(draft.body)}</pre>
        <Note>Sample values are used in this preview only.</Note>
      </div>
    </SettingsPage>
  );
}
