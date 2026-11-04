import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api, downloadCsv } from '../../api.js';
import { PageHeader, Button, Table, Badge, Select, SearchBox, Menu, Empty } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import { statusLabel } from '../../lib/format.js';

export default function DocList({ type }) {
  const ui = DOC_UI[type];
  const { money, date, can, toast } = useApp();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || 'all';
  const q = sp.get('q') || '';
  const [selected, setSelected] = useState([]);
  const module = ui.contact === 'customer' ? 'sales' : 'purchases';
  const { data, loading, reload } = useFetch(`/documents/${type}`, { status, q, per_page: 500, contact_id: sp.get('contact_id') || undefined });
  const rows = data?.rows || [];
  const set = (k, v) => { const n = new URLSearchParams(sp); v && v !== 'all' ? n.set(k, v) : n.delete(k); setSp(n); };

  const bulk = async (action) => {
    let ok = 0;
    for (const id of selected) {
      try {
        if (action === 'delete') await api.del(`/documents/${type}/${id}`);
        else await api.post(`/documents/${type}/${id}/action/${action}`);
        ok++;
      } catch (e) { toast(`${rows.find((r) => r.id === id)?.number}: ${e.message}`, 'error'); }
    }
    if (ok) toast(`${ok} ${ok === 1 ? ui.label : ui.plural} updated`);
    setSelected([]);
    reload();
  };

  const cols = ui.profile ? [
    { key: 'number', label: 'Profile Name', render: (r) => <span className="bold">{r.number}</span> },
    { key: 'contact_name', label: ui.contact === 'vendor' ? 'Vendor Name' : 'Customer Name' },
    { key: 'freq', label: 'Frequency', render: (r) => `Every ${r.recurrence?.every > 1 ? `${r.recurrence.every} ` : ''}${({ daily: 'Day', weekly: 'Week', monthly: 'Month', yearly: 'Year' })[r.recurrence?.frequency] || 'Month'}${r.recurrence?.every > 1 ? 's' : ''}` },
    { key: 'last', label: 'Last Run', render: (r) => date(r.recurrence?.last_run) },
    { key: 'next', label: 'Next Date', render: (r) => (r.status === 'active' ? date(r.recurrence?.next_date) : '—') },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.display_status} /> },
    { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total, r.currency) },
  ] : [
    { key: 'date', label: 'Date', render: (r) => date(r.date), width: 110 },
    { key: 'number', label: ui.numberLabel, render: (r) => <a className="bold" href={docUrl(type, r.id)} onClick={(e) => e.preventDefault()}>{r.number}</a> },
    { key: 'reference', label: 'Reference#' },
    { key: 'contact_name', label: ui.contact === 'vendor' ? 'Vendor Name' : 'Customer Name' },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.display_status} /> },
    ui.dueLabel && { key: 'due_date', label: ui.dueLabel, render: (r) => date(r.due_date) },
    { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total, r.currency) },
    ['invoice', 'bill', 'retainer', 'creditnote', 'vendorcredit'].includes(type) && { key: 'balance', label: ['creditnote', 'vendorcredit'].includes(type) ? 'Balance' : 'Balance Due', align: 'right', render: (r) => money(r.balance, r.currency) },
  ].filter(Boolean);

  const statusOptions = [['all', `All ${ui.plural}`], ...ui.statuses.map((s) => [s, s === 'unpaid' ? 'Unpaid' : statusLabel(s)])];
  const bulkItems = ui.profile ? [] : [
    ['draft', 'pending_approval'].some(() => true) && { label: type === 'quote' ? 'Mark as Sent' : ['purchaseorder'].includes(type) ? 'Mark as Issued' : ['salesorder'].includes(type) ? 'Mark as Confirmed' : 'Mark as Sent / Open', onClick: () => bulk('mark_sent') },
    can(module, 'approve') && { label: 'Approve', onClick: () => bulk('approve') },
    { label: 'Export Selected', onClick: () => downloadCsv(`${ui.plural}`, rows.filter((r) => selected.includes(r.id)), cols.map((c) => ({ key: c.key, label: c.label, value: (r) => (c.key === 'status' ? r.display_status : r[c.key]) }))) },
    can(module, 'delete') && { label: 'Delete', danger: true, onClick: () => window.confirm(`Delete ${selected.length} ${ui.plural}?`) && bulk('delete') },
  ];

  return (
    <div className="page">
      <PageHeader
        title={<Select className="title-select" value={status} onChange={(e) => set('status', e.target.value)} options={statusOptions} />}
        actions={<>
          {selected.length > 0 && <Menu label={`Bulk Actions (${selected.length})`} items={bulkItems} />}
          {can(module, 'create') && <Button variant="primary" onClick={() => nav(docUrl(type, null, '/new'))}>+ New</Button>}
          <Menu items={[
            { label: 'Export as CSV', onClick: () => downloadCsv(ui.plural, rows, cols.map((c) => ({ key: c.key, label: c.label, value: (r) => (c.key === 'status' ? r.display_status : c.key === 'freq' ? r.recurrence?.frequency : r[c.key]) }))) },
            type === 'recurring_invoice' || type === 'recurring_bill' ? { label: 'Run due profiles now', onClick: async () => { const r = await api.post('/recurring/run'); toast(`${r.created} document(s) created`); reload(); } } : null,
          ]} />
        </>}
      >
        <SearchBox value={q} onChange={(v) => set('q', v)} placeholder={`Search ${ui.plural.toLowerCase()}`} />
        {data && <span className="muted small">{data.total} record(s)</span>}
      </PageHeader>
      {!loading && !rows.length && status === 'all' && !q
        ? <Empty title={`Create your first ${ui.label.toLowerCase()}`} text={`${ui.plural} you create will show up here.`} action={can(module, 'create') && <Button variant="primary" onClick={() => nav(docUrl(type, null, '/new'))}>New {ui.label}</Button>} />
        : <Table columns={cols} rows={rows} loading={loading} onRowClick={(r) => nav(docUrl(type, r.id))} selectable={!ui.profile} selected={selected} onSelect={setSelected} />}
    </div>
  );
}
