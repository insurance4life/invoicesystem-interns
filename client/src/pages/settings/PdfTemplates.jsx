// PDF layout options. The template itself (standard, modern, minimal) is chosen under Branding.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Checkbox, Field, Select } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';
import { PDF_TEMPLATES } from './Branding.jsx';

const FONTS = ['Inter', 'Arial', 'Roboto', 'Georgia', 'Times New Roman'];
const DEFAULT_PDF = { template: 'standard', show_logo: true, show_signature: false, font: 'Inter' };

export default function PdfTemplates() {
  const { settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [pdf, setPdf] = useState(DEFAULT_PDF);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setPdf({ ...DEFAULT_PDF, ...(settings?.pdf || {}) }); }, [settings]);

  const active = PDF_TEMPLATES.find((t) => t.key === pdf.template) || PDF_TEMPLATES[0];

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put('/org/settings', {
      pdf: { show_logo: !!pdf.show_logo, show_signature: !!pdf.show_signature, font: pdf.font },
    }), 'PDF layout saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  return (
    <SettingsPage title="PDF templates" subtitle="Layout options for printed and emailed documents.">
      <div className="form-section">
        <h3>Template</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          Current template: <b>{active.label}</b>. {active.desc}
        </p>
        <Link to="/settings/branding" className="btn btn-sm btn-secondary">Change template in Branding</Link>
      </div>

      <div className="form-section">
        <h3>Layout</h3>
        <div className="form-grid">
          <Field label="Font">
            <Select options={FONTS.map((f) => [f, f])} value={pdf.font} disabled={!canEdit} onChange={(e) => setPdf((p) => ({ ...p, font: e.target.value }))} />
          </Field>
          <div className="stack">
            <Checkbox label="Show logo" checked={pdf.show_logo} onChange={(v) => setPdf((p) => ({ ...p, show_logo: v }))} />
            <Checkbox label="Show signature line" checked={pdf.show_signature} onChange={(v) => setPdf((p) => ({ ...p, show_signature: v }))} />
            <Note>Signature line appears above the authorised signatory name.</Note>
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        </div>
      )}
    </SettingsPage>
  );
}
