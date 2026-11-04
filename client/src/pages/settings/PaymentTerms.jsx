import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Menu, Modal, NumberInput, Select, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const TYPES = [['net', 'Days after the invoice date'], ['eom', 'Days after the end of the month'], ['receipt', 'Due on receipt']];
const TYPE_LABEL = Object.fromEntries(TYPES);
const blank = { name: '', days: 30, type: 'net', is_default: false };

export default function PaymentTerms() {
  const { toast, can, refreshMeta } = useApp();
  const terms = useFetch('/payment-terms');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const canEdit = can('settings', 'edit');
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');

  const afterChange = async () => {
    terms.reload();
    await refreshMeta().catch(() => {});
  };

  const submit = async () => {
    setSaving(true);
    const body = { name: draft.name, days: Number(draft.days) || 0, type: draft.type, is_default: draft.is_default };
    const out = await attempt(toast, () => (draft.id ? api.put(`/payment-terms/${draft.id}`, body) : api.post('/payment-terms', body)),
      draft.id ? 'Payment term updated' : 'Payment term added');
    setSaving(false);
    if (out) { setDraft(null); afterChange(); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.name}"?`)) return;
    const out = await attempt(toast, () => api.del(`/payment-terms/${t.id}`), 'Payment term deleted');
    if (out) afterChange();
  };

  const columns = [
    { key: 'name', label: 'Name', render: (t) => <span className="bold">{t.name}</span> },
    { key: 'days', label: 'Days', align: 'right' },
    { key: 'type', label: 'Calculated', render: (t) => TYPE_LABEL[t.type] || t.type },
    { key: 'is_default', label: 'Default', render: (t) => (t.is_default ? <Badge color="blue">Default</Badge> : null) },
    { key: 'actions', label: '', width: 60, render: (t) => (
      <Menu items={[
        { label: 'Edit', hidden: !canEdit, onClick: () => setDraft({ id: t.id, name: t.name, days: t.days, type: t.type, is_default: !!t.is_default }) },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(t) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Payment terms"
      subtitle="How long customers and vendors have to pay. Due dates on new documents follow the term."
      actions={canCreate && <Button variant="primary" onClick={() => setDraft({ ...blank })}>+ New payment term</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={terms.data || []} loading={terms.loading}
          empty={<Empty title="No payment terms" text="Add terms such as Net 30." />} />
      </Card>
      <Note>Only one term can be the default. Terms used by contacts or documents cannot be deleted.</Note>

      {draft && (
        <Modal
          title={draft.id ? 'Edit payment term' : 'New payment term'}
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.name.trim()} onClick={submit}>Save</Button>
          </>}
        >
          <Field label="Name" required hint="e.g. Net 30, Due on receipt"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Type">
            <Select options={TYPES} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
          </Field>
          {draft.type !== 'receipt' && (
            <Field label="Days"><NumberInput min={0} value={draft.days} onChange={(v) => setDraft({ ...draft, days: v })} /></Field>
          )}
          <Checkbox label="Use as the default for new contacts and documents" checked={draft.is_default} onChange={(v) => setDraft({ ...draft, is_default: v })} />
        </Modal>
      )}
    </SettingsPage>
  );
}
