import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Badge, Modal, Field, Input, NumberInput, Select, AccountSelect, Checkbox } from '../../components/ui.jsx';
import { ContactSelect, TXN_LABELS, IN_TYPES, OUT_TYPES, bankFilter, isTransfer } from './common.jsx';

const FIELD_OPTS = [['description', 'Description'], ['reference', 'Reference'], ['payee', 'Payee'], ['amount', 'Amount']];
const OPS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is'], ['starts_with', 'starts with'], ['ends_with', 'ends with']],
  amount: [['equals', 'is'], ['gt', 'is greater than'], ['lt', 'is less than']],
};
const opLabel = (field, op) => (OPS[field === 'amount' ? 'amount' : 'text'].find((o) => o[0] === op) || [op, op])[1];

export default function Rules() {
  const { can, toast, account } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch('/banking/rules');
  const [edit, setEdit] = useState(null);
  const del = async (r) => {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    try { await api.del(`/banking/rules/${r.id}`); toast('Rule deleted'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const toggle = async (r) => {
    try { await api.put(`/banking/rules/${r.id}`, { is_active: r.is_active ? 0 : 1 }); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const cols = [
    { key: 'priority', label: '#', width: 40 },
    { key: 'name', label: 'Rule Name', render: (r) => <span className="bold">{r.name}</span> },
    { key: 'account_name', label: 'Account', render: (r) => r.account_name || 'All accounts' },
    { key: 'apply_to', label: 'Applies To', render: (r) => ({ deposits: 'Deposits', withdrawals: 'Withdrawals', both: 'Deposits & Withdrawals' })[r.apply_to] },
    { key: 'conditions', label: 'Conditions', render: (r) => (r.conditions || []).map((c) => `${c.field} ${opLabel(c.field, c.op)} "${c.value}"`).join(r.match === 'any' ? ' OR ' : ' AND ') },
    { key: 'action', label: 'Then', render: (r) => (
      <div>{TXN_LABELS[r.action?.txn_type] || 'Categorize'}{r.action?.offset_account_id ? ` → ${account(r.action.offset_account_id)?.name || ''}` : ''}
        {r.action?.auto_categorize ? <div className="muted small">auto-categorize</div> : <div className="muted small">suggest only</div>}</div>
    ) },
    { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> },
    { key: 'act', label: '', align: 'right', render: (r) => (
      <div className="row" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
        {can('banking', 'edit') && <Button size="sm" onClick={() => toggle(r)}>{r.is_active ? 'Deactivate' : 'Activate'}</Button>}
        {can('banking', 'delete') && <Button size="sm" variant="danger" onClick={() => del(r)}>Delete</Button>}
      </div>
    ) },
  ];
  return (
    <div className="page">
      <PageHeader title="Bank Rules" back={<Button variant="link" onClick={() => nav('/banking')}>←</Button>}
        subtitle="Rules run on every statement import, in priority order. The first matching rule wins."
        actions={can('banking', 'create') && <Button variant="primary" onClick={() => setEdit({})}>+ New Rule</Button>} />
      <Table columns={cols} rows={data || []} loading={loading && !data} onRowClick={can('banking', 'edit') ? (r) => setEdit(r) : undefined} empty="No bank rules yet. Create one to categorize recurring transactions automatically." />
      {edit && <RuleModal rule={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function RuleModal({ rule, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({
    name: rule.name || '', account_id: rule.account_id || '', priority: rule.priority ?? 0, apply_to: rule.apply_to || 'withdrawals', match: rule.match || 'all',
    is_active: rule.id ? !!rule.is_active : true,
    conditions: rule.conditions?.length ? rule.conditions : [{ field: 'description', op: 'contains', value: '' }],
    action: { txn_type: '', offset_account_id: '', contact_id: '', reference: '', auto_categorize: false, ...(rule.action || {}) },
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setAct = (k, v) => setF((x) => ({ ...x, action: { ...x.action, [k]: v } }));
  const setCond = (i, k, v) => setF((x) => ({ ...x, conditions: x.conditions.map((c, j) => (j === i ? { ...c, [k]: v, ...(k === 'field' ? { op: v === 'amount' ? 'equals' : 'contains' } : {}) } : c)) }));
  const types = f.apply_to === 'deposits' ? IN_TYPES : f.apply_to === 'withdrawals' ? OUT_TYPES : [...new Set([...OUT_TYPES, ...IN_TYPES])];
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, account_id: f.account_id || null, priority: Number(f.priority) || 0, is_active: f.is_active ? 1 : 0,
        conditions: f.conditions.filter((c) => String(c.value).trim() !== ''),
        action: { ...f.action, txn_type: f.action.txn_type || null, offset_account_id: f.action.offset_account_id || null, contact_id: f.action.contact_id || null } };
      if (rule.id) await api.put(`/banking/rules/${rule.id}`, body); else await api.post('/banking/rules', body);
      toast('Rule saved');
      onSaved();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={rule.id ? 'Edit Rule' : 'New Rule'} onClose={onClose} width={760}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="grid2">
          <Field label="Rule Name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Apply to Account"><AccountSelect value={f.account_id} onChange={(v) => set('account_id', v)} filter={bankFilter} placeholder="All bank accounts" /></Field>
          <Field label="Apply To"><Select value={f.apply_to} options={[['withdrawals', 'Withdrawals'], ['deposits', 'Deposits'], ['both', 'Both']]} onChange={(e) => set('apply_to', e.target.value)} /></Field>
          <Field label="Priority" hint="Lower numbers run first"><NumberInput value={f.priority} onChange={(v) => set('priority', v)} /></Field>
        </div>
        <hr />
        <div className="row">
          <span>If</span>
          <Select style={{ width: 90 }} value={f.match} options={[['all', 'All'], ['any', 'Any']]} onChange={(e) => set('match', e.target.value)} />
          <span>of the following conditions are met</span>
        </div>
        {f.conditions.map((c, i) => (
          <div key={i} className="bk-cond">
            <Select value={c.field} options={FIELD_OPTS} onChange={(e) => setCond(i, 'field', e.target.value)} />
            <Select value={c.op} options={OPS[c.field === 'amount' ? 'amount' : 'text']} onChange={(e) => setCond(i, 'op', e.target.value)} />
            {c.field === 'amount'
              ? <NumberInput value={c.value} onChange={(v) => setCond(i, 'value', v)} />
              : <Input value={c.value} onChange={(e) => setCond(i, 'value', e.target.value)} placeholder="Value" />}
            <Button size="sm" variant="link" disabled={f.conditions.length === 1} onClick={() => set('conditions', f.conditions.filter((_, j) => j !== i))}>×</Button>
          </div>
        ))}
        <Button size="sm" variant="link" onClick={() => set('conditions', [...f.conditions, { field: 'description', op: 'contains', value: '' }])}>+ Add condition</Button>
        <hr />
        <h3>Then categorize as</h3>
        <div className="grid2">
          <Field label="Transaction Type"><Select value={f.action.txn_type} placeholder="Deposit / Withdrawal" options={types.map((t) => [t, TXN_LABELS[t]])} onChange={(e) => setAct('txn_type', e.target.value)} /></Field>
          <Field label={isTransfer(f.action.txn_type) ? 'Other Account' : 'Account'}>
            <AccountSelect value={f.action.offset_account_id} onChange={(v) => setAct('offset_account_id', v)} filter={isTransfer(f.action.txn_type) ? bankFilter : undefined} />
          </Field>
          <Field label="Contact"><ContactSelect value={f.action.contact_id} onChange={(v) => setAct('contact_id', v)} /></Field>
          <Field label="Reference#"><Input value={f.action.reference} onChange={(e) => setAct('reference', e.target.value)} /></Field>
        </div>
        <Checkbox label="Categorize automatically on import (otherwise only suggest)" checked={f.action.auto_categorize} onChange={(v) => setAct('auto_categorize', v)} />
        <Checkbox label="Rule is active" checked={f.is_active} onChange={(v) => set('is_active', v)} />
      </div>
    </Modal>
  );
}
