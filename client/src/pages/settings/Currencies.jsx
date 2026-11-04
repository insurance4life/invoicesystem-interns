import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Empty, Field, Input, Menu, Modal, NumberInput, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const blankNew = { code: '', name: '', symbol: '', exchange_rate: '' };

export default function Currencies() {
  const { meta, toast, can, refreshMeta, currency: base } = useApp();
  const list = useFetch('/currencies');
  const [draft, setDraft] = useState(null); // { mode: 'add' | 'edit', ...fields }
  const [saving, setSaving] = useState(false);
  const canCreate = can('settings', 'create');
  const canEdit = can('settings', 'edit');
  const canDelete = can('settings', 'delete');

  const afterChange = async () => {
    list.reload();
    await refreshMeta().catch(() => {});
  };

  const submit = async () => {
    setSaving(true);
    const isAdd = draft.mode === 'add';
    const body = { name: draft.name, symbol: draft.symbol, exchange_rate: draft.exchange_rate === '' ? undefined : Number(draft.exchange_rate) };
    const out = await attempt(
      toast,
      () => (isAdd ? api.post('/currencies', { ...body, code: draft.code }) : api.put(`/currencies/${draft.id}`, body)),
      isAdd ? 'Currency added' : 'Currency updated',
    );
    setSaving(false);
    if (out) { setDraft(null); afterChange(); }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete ${c.code}?`)) return;
    const out = await attempt(toast, () => api.del(`/currencies/${c.id}`), 'Currency deleted');
    if (out) afterChange();
  };

  const columns = [
    { key: 'code', label: 'Code', render: (c) => <span className="bold">{c.code}</span> },
    { key: 'name', label: 'Name' },
    { key: 'symbol', label: 'Symbol' },
    { key: 'rate', label: 'Exchange rate', render: (c) => (c.is_base
      ? <Badge color="blue">Base currency</Badge>
      : <span className="num">1 {c.code} = {Number(c.exchange_rate).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} {base}</span>) },
    { key: 'actions', label: '', width: 60, render: (c) => (
      <Menu items={[
        { label: c.is_base ? 'Edit name and symbol' : 'Edit / update rate', hidden: !canEdit,
          onClick: () => setDraft({ mode: 'edit', id: c.id, code: c.code, name: c.name || '', symbol: c.symbol || '', exchange_rate: c.exchange_rate, is_base: !!c.is_base }) },
        { label: 'Delete', danger: true, hidden: !canDelete || c.is_base, onClick: () => remove(c) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Currencies"
      subtitle="Foreign currencies you transact in. Rates convert them into the base currency."
      actions={canCreate && <Button variant="primary" onClick={() => setDraft({ mode: 'add', ...blankNew })}>+ New currency</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={list.data || meta?.currencies || []} loading={list.loading} rowKey="id"
          empty={<Empty title="No currencies" text="Add a foreign currency to record transactions in it." />} />
      </Card>
      <Note>Changing a rate affects documents created after the change. Existing documents keep the rate they were saved with.</Note>

      {draft && (
        <Modal
          title={draft.mode === 'add' ? 'New currency' : `Edit ${draft.code}`}
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={draft.mode === 'add' && !/^[A-Za-z]{3}$/.test(draft.code)} onClick={submit}>Save</Button>
          </>}
        >
          {draft.mode === 'add' && (
            <Field label="Currency code" required hint="Three letters, e.g. USD">
              <Input maxLength={3} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
            </Field>
          )}
          <Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Symbol"><Input value={draft.symbol} onChange={(e) => setDraft({ ...draft, symbol: e.target.value })} /></Field>
          {!draft.is_base && (
            <Field label={`Exchange rate (1 ${draft.code || 'unit'} = ? ${base})`} required>
              <NumberInput step="any" value={draft.exchange_rate} onChange={(v) => setDraft({ ...draft, exchange_rate: v })} />
            </Field>
          )}
        </Modal>
      )}
    </SettingsPage>
  );
}
