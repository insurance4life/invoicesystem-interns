import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Empty, Field, Input, Menu, Modal, NumberInput, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const blank = { section: '', name: '', rate: '' };

export default function TdsSections() {
  const { toast, can, refreshMeta } = useApp();
  const list = useFetch('/tds-sections');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const canEdit = can('settings', 'edit');
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');

  const afterChange = async () => {
    list.reload();
    await refreshMeta().catch(() => {});
  };

  const submit = async () => {
    setSaving(true);
    const body = { section: draft.section, name: draft.name, rate: Number(draft.rate) };
    const out = await attempt(toast, () => (draft.id ? api.put(`/tds-sections/${draft.id}`, body) : api.post('/tds-sections', body)),
      draft.id ? 'TDS section updated' : 'TDS section added');
    setSaving(false);
    if (out) { setDraft(null); afterChange(); }
  };

  const toggle = async (t) => {
    const out = await attempt(toast, () => api.put(`/tds-sections/${t.id}`, { is_active: !t.is_active }), t.is_active ? 'Section deactivated' : 'Section activated');
    if (out) afterChange();
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.section ? `${t.section} ` : ''}${t.name}"?`)) return;
    const out = await attempt(toast, () => api.del(`/tds-sections/${t.id}`), 'TDS section deleted');
    if (out) afterChange();
  };

  const columns = [
    { key: 'section', label: 'Section', width: 100, render: (t) => <span className="mono">{t.section || '—'}</span> },
    { key: 'name', label: 'Nature of payment', render: (t) => <>{t.name}{!t.is_active && <> <Badge>Inactive</Badge></>}</> },
    { key: 'rate', label: 'Rate', align: 'right', render: (t) => <span className="num">{Number(t.rate)}%</span> },
    { key: 'actions', label: '', width: 60, render: (t) => (
      <Menu items={[
        { label: 'Edit', hidden: !canEdit, onClick: () => setDraft({ id: t.id, section: t.section || '', name: t.name, rate: t.rate }) },
        { label: t.is_active ? 'Deactivate' : 'Activate', hidden: !canEdit, onClick: () => toggle(t) },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(t) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="TDS sections"
      subtitle="Income-tax sections and the rate deducted under each. Pick one on a payment and the TDS is worked out for you."
      actions={canCreate && <Button variant="primary" onClick={() => setDraft({ ...blank })}>+ New section</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={list.data || []} loading={list.loading}
          empty={<Empty title="No TDS sections" text="Add the sections you deduct under, such as 194J for professional fees." />} />
      </Card>
      <Note>
        TDS is worked out on the amount before GST. Edit a rate when the law changes or a vendor holds a lower-deduction certificate;
        payments already recorded keep the TDS they were saved with. Sections in use cannot be deleted, only deactivated.
      </Note>

      {draft && (
        <Modal
          title={draft.id ? 'Edit TDS section' : 'New TDS section'}
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.name.trim() || !(Number(draft.rate) > 0)} onClick={submit}>Save</Button>
          </>}
        >
          <Field label="Section" hint="As in the Income-tax Act, e.g. 194J">
            <Input value={draft.section} maxLength={12} onChange={(e) => setDraft({ ...draft, section: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Nature of payment" required hint="e.g. Professional fees">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Rate (%)" required>
            <NumberInput min={0} max={100} value={draft.rate} onChange={(v) => setDraft({ ...draft, rate: v })} />
          </Field>
        </Modal>
      )}
    </SettingsPage>
  );
}
