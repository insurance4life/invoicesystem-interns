// Transaction approval queue: every document waiting for approval, across types.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Table, Button, Badge, Empty } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';

const TYPES = ['invoice', 'salesorder', 'creditnote', 'purchaseorder', 'bill', 'vendorcredit'];

export default function Approvals() {
  const { money, date, toast, can, settings } = useApp();
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const load = async () => {
    const all = [];
    for (const t of TYPES) {
      const side = DOC_UI[t].contact === 'customer' ? 'sales' : 'purchases';
      if (!can(side)) continue;
      try { const r = await api.get(`/documents/${t}`, { status: 'pending_approval', per_page: 500 }); all.push(...r.rows); } catch { /* no access */ }
    }
    setRows(all.sort((a, b) => (a.date < b.date ? 1 : -1)));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line
  const act = async (r, action) => {
    try { await api.post(`/documents/${r.doc_type}/${r.id}/action/${action}`, action === 'reject' ? { reason: window.prompt('Reason for rejection') || '' } : {}); toast(action === 'approve' ? 'Approved' : 'Rejected'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const enabled = TYPES.filter((t) => settings?.approvals?.[t]);
  return (
    <div className="page">
      <PageHeader title="Pending Approvals" subtitle={enabled.length ? `Approval is required for: ${enabled.map((t) => DOC_UI[t].plural).join(', ')}` : 'Transaction approval is off. Turn it on in Settings → Approvals.'} />
      {rows && !rows.length ? <Empty icon="✅" title="All caught up" text="No documents are waiting for approval." /> : (
        <Table loading={!rows} rows={rows || []} rowKey="id" onRowClick={(r) => nav(docUrl(r.doc_type, r.id))} columns={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) },
          { key: 'type', label: 'Type', render: (r) => DOC_UI[r.doc_type].label },
          { key: 'number', label: 'Number', render: (r) => <span className="bold">{r.number}</span> },
          { key: 'contact_name', label: 'Contact' },
          { key: 'status', label: 'Status', render: (r) => <Badge status={r.display_status} /> },
          { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total, r.currency) },
          { key: 'actions', label: '', render: (r) => {
            const side = DOC_UI[r.doc_type].contact === 'customer' ? 'sales' : 'purchases';
            return can(side, 'approve') && <span className="row" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="primary" onClick={() => act(r, 'approve')}>Approve</Button><Button size="sm" onClick={() => act(r, 'reject')}>Reject</Button></span>;
          } },
        ]} />
      )}
    </div>
  );
}
