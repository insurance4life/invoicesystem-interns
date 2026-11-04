import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Badge, Spinner, Empty, Field, Input, NumberInput, Stat } from '../../components/ui.jsx';
import { SrcLink, SRC_LABELS } from './common.jsx';

export default function Reconcile() {
  const { rid } = useParams();
  const nav = useNavigate();
  const { money, date, toast, can } = useApp();
  const { data: d, loading, setData } = useFetch(`/banking/reconciliations/${rid}`);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const [filter, setFilter] = useState('all');
  if (loading && !d) return <div className="page"><Spinner /></div>;
  if (!d) return <div className="page"><Empty title="Reconciliation not found" /></div>;
  const open = d.status === 'in_progress';
  const editable = open && can('banking', 'edit');
  const cur = d.account?.currency || undefined;

  const toggle = async (ids, cleared) => {
    if (!ids.length) return;
    // optimistic update for a snappy UI, then sync with the server
    setData((x) => ({ ...x, rows: x.rows.map((r) => (ids.includes(r.id) ? { ...r, cleared } : r)) }));
    try { setData(await api.post(`/banking/reconciliations/${rid}/toggle`, { ledger_ids: ids, cleared })); } catch (e) { toast(e.message, 'error'); }
  };
  const complete = async () => {
    setBusy(true);
    try { await api.post(`/banking/reconciliations/${rid}/complete`); toast('Reconciliation completed'); nav(`/banking/accounts/${d.account_id}?tab=reconciliations`); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const undo = async () => {
    if (!window.confirm(open ? 'Discard this reconciliation?' : 'Undo this reconciliation? Its transactions become unreconciled.')) return;
    try { await api.post(`/banking/reconciliations/${rid}/undo`); toast(open ? 'Reconciliation discarded' : 'Reconciliation undone'); nav(`/banking/accounts/${d.account_id}?tab=reconciliations`); } catch (e) { toast(e.message, 'error'); }
  };
  const saveEdit = async () => {
    try { setData(await api.put(`/banking/reconciliations/${rid}`, edit)); setEdit(null); } catch (e) { toast(e.message, 'error'); }
  };

  // live totals from current (possibly optimistic) state
  const cleared = d.rows.filter((r) => r.cleared);
  const clearedBal = Math.round((d.opening_balance + cleared.reduce((s, r) => s + r.amount, 0)) * 100) / 100;
  const diff = Math.round((d.closing_balance - clearedBal) * 100) / 100;
  const rows = d.rows.filter((r) => (filter === 'all' ? true : filter === 'cleared' ? r.cleared : !r.cleared));
  const selected = rows.filter((r) => r.cleared).map((r) => r.id);

  const cols = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'type', label: 'Type', render: (r) => <SrcLink type={r.src_type} id={r.src_id}>{SRC_LABELS[r.src_type] || r.src_type}</SrcLink> },
    { key: 'number', label: 'Reference#' },
    { key: 'description', label: 'Details', render: (r) => <div>{r.contact_name}<div className="muted small">{r.description}</div></div> },
    { key: 'debit', label: 'Deposits', align: 'right', render: (r) => (r.debit ? money(r.debit, cur) : '') },
    { key: 'credit', label: 'Withdrawals', align: 'right', render: (r) => (r.credit ? money(r.credit, cur) : '') },
  ];

  return (
    <div className="page">
      <PageHeader
        back={<Button variant="link" onClick={() => nav(`/banking/accounts/${d.account_id}?tab=reconciliations`)}>←</Button>}
        title={`Reconcile ${d.account.name}`}
        subtitle={`${d.start_date ? date(d.start_date) : 'Beginning'} – ${date(d.end_date)}`}
        actions={<>
          <Badge status={d.status} />
          {can('banking', 'delete') && <Button variant="danger" onClick={undo}>{open ? 'Discard' : 'Undo Reconciliation'}</Button>}
          {editable && <Button onClick={() => setEdit({ start_date: d.start_date || '', end_date: d.end_date, closing_balance: d.closing_balance })}>Edit Statement Info</Button>}
          {editable && <Button variant="primary" loading={busy} disabled={Math.abs(diff) > 0.005} onClick={complete}>Complete Reconciliation</Button>}
        </>}
      />
      {edit && (
        <div className="form-section row">
          <Field label="Start Date"><Input type="date" value={edit.start_date} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} /></Field>
          <Field label="End Date"><Input type="date" value={edit.end_date} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} /></Field>
          <Field label="Closing Balance"><NumberInput value={edit.closing_balance} onChange={(v) => setEdit({ ...edit, closing_balance: v })} /></Field>
          <Button variant="primary" onClick={saveEdit}>Save</Button><Button onClick={() => setEdit(null)}>Cancel</Button>
        </div>
      )}
      <div className="grid4 mb bk-recon-stats">
        <Stat label="Opening Balance" value={money(d.opening_balance, cur)} />
        <Stat label="Statement Closing Balance" value={money(d.closing_balance, cur)} />
        <Stat label="Cleared Balance" value={money(clearedBal, cur)} sub={`${cleared.length} cleared · in ${money(cleared.reduce((s, r) => s + r.debit, 0), cur)} · out ${money(cleared.reduce((s, r) => s + r.credit, 0), cur)}`} />
        <Stat label="Difference" value={money(diff, cur)} tone={Math.abs(diff) > 0.005 ? 'red' : 'green'} sub={Math.abs(diff) > 0.005 ? 'Must be zero to complete' : 'Balanced'} />
      </div>
      <div className="row between mb">
        <div className="row">
          {['all', 'uncleared', 'cleared'].map((k) => <Button key={k} size="sm" variant={filter === k ? 'primary' : 'secondary'} onClick={() => setFilter(k)}>{k[0].toUpperCase() + k.slice(1)}</Button>)}
        </div>
        {editable && <div className="row">
          <Button size="sm" onClick={() => toggle(rows.filter((r) => !r.cleared).map((r) => r.id), true)}>Clear all shown</Button>
          <Button size="sm" onClick={() => toggle(rows.filter((r) => r.cleared).map((r) => r.id), false)}>Unclear all shown</Button>
        </div>}
      </div>
      <Table columns={cols} rows={rows} empty={open ? `No unreconciled transactions up to ${date(d.end_date)}.` : 'No transactions.'}
        selectable={editable} selected={selected}
        onSelect={(ids) => {
          const add = ids.filter((x) => !selected.includes(x));
          const rem = selected.filter((x) => !ids.includes(x));
          if (add.length) toggle(add, true);
          if (rem.length) toggle(rem, false);
        }}
        onRowClick={editable ? (r) => toggle([r.id], !r.cleared) : undefined}
        rowClass={(r) => (r.cleared ? 'bk-cleared' : '')} />
    </div>
  );
}
