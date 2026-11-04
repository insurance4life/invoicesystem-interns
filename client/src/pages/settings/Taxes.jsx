import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Menu, Modal, NumberInput, Select, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const KINDS = [
  ['simple', 'Standard tax'],
  ['gst', 'GST (CGST + SGST, or IGST across states)'],
  ['group', 'Tax group (combines several taxes)'],
];
const KIND_LABEL = { simple: 'Standard', gst: 'GST', group: 'Group' };

export default function Taxes() {
  const { toast, can, refreshMeta } = useApp();
  const list = useFetch('/taxes');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const canEdit = can('settings', 'edit');
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');
  const taxes = list.data || [];
  const individual = taxes.filter((t) => t.kind !== 'group');
  const byId = Object.fromEntries(taxes.map((t) => [t.id, t]));

  const afterChange = async () => {
    list.reload();
    await refreshMeta().catch(() => {});
  };

  const open = (t) => setDraft(t
    ? { id: t.id, name: t.name, kind: t.kind, rate: t.rate, group_ids: t.group_ids || [], is_active: !!t.is_active }
    : { name: '', kind: 'simple', rate: '', group_ids: [], is_active: true });

  const groupRate = (ids) => ids.reduce((s, id) => s + (Number(byId[id]?.rate) || 0), 0);

  const submit = async () => {
    setSaving(true);
    const body = draft.kind === 'group'
      ? { name: draft.name, kind: 'group', group_ids: draft.group_ids, is_active: draft.is_active }
      : { name: draft.name, kind: draft.kind, rate: Number(draft.rate), is_active: draft.is_active };
    const out = await attempt(toast, () => (draft.id ? api.put(`/taxes/${draft.id}`, body) : api.post('/taxes', body)),
      draft.id ? 'Tax updated' : 'Tax added');
    setSaving(false);
    if (out) { setDraft(null); afterChange(); }
  };

  const toggleActive = async (t) => {
    const out = await attempt(toast, () => api.put(`/taxes/${t.id}`, { name: t.name, kind: t.kind, rate: t.rate, group_ids: t.group_ids || undefined, is_active: !t.is_active }),
      t.is_active ? 'Tax deactivated' : 'Tax activated');
    if (out) afterChange();
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete the tax "${t.name}"?`)) return;
    // Taxes already used on transactions are refused by the server, and the message suggests deactivating them.
    const out = await attempt(toast, () => api.del(`/taxes/${t.id}`), 'Tax deleted');
    if (out) afterChange();
  };

  const columns = [
    { key: 'name', label: 'Name', render: (t) => <span className="bold">{t.name}</span> },
    { key: 'kind', label: 'Type', render: (t) => KIND_LABEL[t.kind] || t.kind },
    { key: 'rate', label: 'Rate', align: 'right', render: (t) => `${Number(t.rate).toFixed(2).replace(/\.00$/, '')}%` },
    { key: 'parts', label: 'Includes', render: (t) => (t.kind === 'group'
      ? (t.group_ids || []).map((id) => byId[id]?.name).filter(Boolean).join(', ')
      : <span className="muted">—</span>) },
    { key: 'status', label: 'Status', render: (t) => <Badge color={t.is_active ? 'green' : 'gray'}>{t.is_active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'actions', label: '', width: 60, render: (t) => (
      <Menu items={[
        { label: 'Edit', hidden: !canEdit, onClick: () => open(t) },
        { label: t.is_active ? 'Deactivate' : 'Activate', hidden: !canEdit, onClick: () => toggleActive(t) },
        { divider: true, hidden: !canDelete },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(t) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Taxes"
      subtitle="Tax rates used on items, invoices, bills and expenses."
      actions={canCreate && <Button variant="primary" onClick={() => open(null)}>+ New tax</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={taxes} loading={list.loading}
          empty={<Empty title="No taxes" text="Add a tax rate to use it on transactions." />} />
      </Card>
      <Note>A tax that is already used on transactions cannot be deleted. Deactivate it instead, so old documents keep their history.</Note>

      {draft && (
        <Modal
          title={draft.id ? 'Edit tax' : 'New tax'}
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.name.trim() || (draft.kind === 'group' ? !draft.group_ids.length : draft.rate === '')} onClick={submit}>Save</Button>
          </>}
        >
          <Field label="Name" required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Type">
            <Select options={KINDS} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} />
          </Field>
          {draft.kind !== 'group' && (
            <Field label="Rate (%)" required hint={draft.kind === 'gst' ? 'Split into CGST and SGST for in-state sales, or IGST for inter-state.' : undefined}>
              <NumberInput value={draft.rate} onChange={(v) => setDraft({ ...draft, rate: v })} />
            </Field>
          )}
          {draft.kind === 'group' && (
            <Field label="Taxes in this group" required hint="The group rate is the sum of the taxes selected.">
              <div className="stack">
                {individual.filter((t) => t.id !== draft.id).map((t) => (
                  <Checkbox key={t.id} label={`${t.name} (${t.rate}%)`} checked={draft.group_ids.includes(t.id)}
                    onChange={(on) => setDraft({ ...draft, group_ids: on ? [...draft.group_ids, t.id] : draft.group_ids.filter((x) => x !== t.id) })} />
                ))}
                {!individual.length && <span className="muted small">Create an individual tax first.</span>}
                <span className="bold small">Group rate: {groupRate(draft.group_ids).toFixed(2).replace(/\.00$/, '')}%</span>
              </div>
            </Field>
          )}
          {draft.id && <Checkbox label="Active" checked={draft.is_active} onChange={(v) => setDraft({ ...draft, is_active: v })} />}
        </Modal>
      )}
    </SettingsPage>
  );
}
