import { useEffect, useState } from 'react';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Field, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

export const PDF_TEMPLATES = [
  { key: 'standard', label: 'Standard', desc: 'Classic layout with a coloured table header.' },
  { key: 'modern', label: 'Modern', desc: 'Large title band and airy spacing.' },
  { key: 'minimal', label: 'Minimal', desc: 'Plain black and white, no decoration.' },
];
const DEFAULT_PDF = { template: 'standard', color: '#408dfb', footer: '' };
const MAX_LOGO_BYTES = 300 * 1024;

export default function Branding() {
  const { org, settings, refreshMeta, toast, can } = useApp();
  const canEdit = can('settings', 'edit');
  const [pdf, setPdf] = useState(DEFAULT_PDF);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setPdf({ ...DEFAULT_PDF, ...(settings?.pdf || {}) }); }, [settings]);

  const pickLogo = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Choose an image file', 'error');
    if (file.size > MAX_LOGO_BYTES) return toast('Logo must be under 300 KB', 'error');
    const reader = new FileReader();
    reader.onload = async () => {
      const out = await attempt(toast, () => api.put('/org', { logo: reader.result }), 'Logo updated');
      if (out) await refreshMeta().catch(() => {});
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = async () => {
    const out = await attempt(toast, () => api.put('/org', { logo: '' }), 'Logo removed');
    if (out) await refreshMeta().catch(() => {});
  };

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put('/org/settings', { pdf }), 'Branding saved');
    if (out) await refreshMeta().catch(() => {});
    setSaving(false);
  };

  return (
    <SettingsPage title="Branding" subtitle="How your documents look when printed or emailed.">
      <div className="form-section">
        <h3>Logo</h3>
        <div className="row" style={{ gap: 20, alignItems: 'center' }}>
          <div style={{ width: 180, height: 80, border: '1px dashed var(--line)', borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--panel)' }}>
            {org?.logo
              ? <img src={org.logo} alt="Organization logo" style={{ maxWidth: 170, maxHeight: 70 }} />
              : <span className="muted small">No logo</span>}
          </div>
          {canEdit && (
            <div className="stack">
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                Upload logo
                <input type="file" accept="image/*" hidden onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {org?.logo && <Button size="sm" variant="link" onClick={removeLogo}>Remove logo</Button>}
              <Note>PNG, JPG or SVG, up to 300 KB.</Note>
            </div>
          )}
        </div>
      </div>

      <div className="form-section">
        <h3>PDF template</h3>
        <div className="grid3" style={{ marginBottom: 14 }}>
          {PDF_TEMPLATES.map((t) => {
            const selected = pdf.template === t.key;
            return (
              <div
                key={t.key}
                onClick={() => canEdit && setPdf((p) => ({ ...p, template: t.key }))}
                className="card"
                style={{ padding: 14, cursor: canEdit ? 'pointer' : 'default', borderColor: selected ? 'var(--primary)' : undefined, boxShadow: selected ? '0 0 0 2px var(--primary-l)' : undefined }}
              >
                <div className="row between">
                  <span className="bold">{t.label}</span>
                  {selected && <span className="badge badge-blue">Selected</span>}
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>{t.desc}</div>
              </div>
            );
          })}
        </div>
        <div className="form-grid">
          <Field label="Accent colour" hint="Used for table headers and totals.">
            <input type="color" className="input" style={{ height: 38, padding: 4, width: 90 }} value={pdf.color || '#408dfb'} disabled={!canEdit}
              onChange={(e) => setPdf((p) => ({ ...p, color: e.target.value }))} />
          </Field>
          <Field label="Footer text" hint="Printed at the bottom of every document.">
            <Textarea rows={3} value={pdf.footer || ''} disabled={!canEdit} onChange={(e) => setPdf((p) => ({ ...p, footer: e.target.value }))} />
          </Field>
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
