import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Menu, Modal, Select, Table, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const MODULES = [
  ['contact', 'Contacts'], ['item', 'Items'], ['invoice', 'Invoices'], ['quote', 'Quotes'], ['bill', 'Bills'],
  ['expense', 'Expenses'], ['salesorder', 'Sales orders'], ['purchaseorder', 'Purchase orders'],
];
const MODULE_LABEL = Object.fromEntries(MODULES);
const TYPES = [
  ['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['dropdown', 'Dropdown'],
  ['checkbox', 'Checkbox'], ['email', 'Email'], ['url', 'URL'],
];
const TYPE_LABEL = Object.fromEntries(TYPES);
const blank = { module: 'contact', label: '', data_type: 'text', options: '', is_required: false, show_in_pdf: false };

export default function CustomFields() {
  const { toast, can, refreshMeta } = useApp();
  const fields = useFetch('/custom-fields');
  const [draft, setDraft] = useState(null); // blank for a new field, or the field being edited
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const canCreate = can('settings', 'create');
  const canEdit = can('settings', 'edit');
  const canDelete = can('settings', 'delete');

  const afterChange = async () => {
    fields.reload();
    await refreshMeta().catch(() => {});
  };

  const open = (f) => setDraft(f
    ? { id: f.id, module: f.module, label: f.label, field_key: f.field_key, data_type: f.data_type, options: (f.options || []).join('\n'), is_required: !!f.is_required, show_in_pdf: !!f.show_in_pdf }
    : { ...blank });

  const submit = async () => {
    setSaving(true);
    const body = {
      label: draft.label, data_type: draft.data_type, is_required: draft.is_required, show_in_pdf: draft.show_in_pdf,
      options: draft.data_type === 'dropdown' ? draft.options.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    };
    const out = await attempt(toast, () => (draft.id
      ? api.put(`/custom-fields/${draft.id}`, body)
      : api.post('/custom-fields', { ...body, module: draft.module })),
    draft.id ? 'Custom field updated' : 'Custom field added');
    setSaving(false);
    if (out) { setDraft(null); afterChange(); }
  };

  const remove = async (f) => {
    if (!window.confirm(`Delete the custom field "${f.label}"? Values already entered on records are kept but hidden.`)) return;
    const out = await attempt(toast, () => api.del(`/custom-fields/${f.id}`), 'Custom field deleted');
    if (out) afterChange();
  };

  const rows = (fields.data || []).filter((f) => !filter || f.module === filter);
  const columns = [
    { key: 'module', label: 'Applies to', render: (f) => MODULE_LABEL[f.module] || f.module },
    { key: 'label', label: 'Label', render: (f) => <span className="bold">{f.label}</span> },
    { key: 'field_key', label: 'Key', render: (f) => <code className="small">{f.field_key}</code> },
    { key: 'data_type', label: 'Type', render: (f) => TYPE_LABEL[f.data_type] || f.data_type },
    { key: 'is_required', label: 'Required', render: (f) => (f.is_required ? <Badge color="orange">Required</Badge> : <span className="muted">No</span>) },
    { key: 'show_in_pdf', label: 'On PDF', render: (f) => (f.show_in_pdf ? 'Yes' : <span className="muted">No</span>) },
    { key: 'actions', label: '', width: 60, render: (f) => (
      <Menu items={[
        { label: 'Edit', hidden: !canEdit, onClick: () => open(f) },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(f) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Custom fields"
      subtitle="Extra details you track on contacts, items and documents."
      actions={canCreate && <Button variant="primary" onClick={() => open(null)}>+ New custom field</Button>}
    >
      <div className="page-filters" style={{ marginTop: 0, marginBottom: 12 }}>
        <Select options={[['', 'All modules'], ...MODULES]} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <Card pad={false}>
        <Table columns={columns} rows={rows} loading={fields.loading}
          empty={<Empty title="No custom fields" text="Add a field such as Loyalty Tier or Project Code." />} />
      </Card>
      <Note>The key is generated from the label and cannot change, so existing values stay linked to the field.</Note>

      {draft && (
        <Modal
          title={draft.id ? `Edit ${draft.label}` : 'New custom field'}
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.label.trim()} onClick={submit}>Save</Button>
          </>}
        >
          <Field label="Applies to" required>
            <Select options={MODULES} value={draft.module} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, module: e.target.value })} />
          </Field>
          <Field label="Label" required>
            <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </Field>
          {draft.id && <Field label="Key"><code className="small">{draft.field_key}</code></Field>}
          <Field label="Type">
            <Select options={TYPES} value={draft.data_type} onChange={(e) => setDraft({ ...draft, data_type: e.target.value })} />
          </Field>
          {draft.data_type === 'dropdown' && (
            <Field label="Options" hint="One option per line.">
              <Textarea rows={4} value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} />
            </Field>
          )}
          <Checkbox label="Required" checked={draft.is_required} onChange={(v) => setDraft({ ...draft, is_required: v })} />
          <Checkbox label="Show on PDF" checked={draft.show_in_pdf} onChange={(v) => setDraft({ ...draft, show_in_pdf: v })} />
        </Modal>
      )}
    </SettingsPage>
  );
}
