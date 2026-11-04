import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { downloadCsv } from '../../api.js';
import { PageHeader, Button, Table, SearchBox, Select, Menu, Empty } from '../../components/ui.jsx';
import { PAYMENT_MODES } from '../../lib/format.js';

export default function PaymentList({ kind }) {
  const { money, date, can } = useApp();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') || '';
  const mode = sp.get('mode') || '';
  const { data, loading } = useFetch(`/payments/${kind}`, { q, mode });
  const module = kind === 'received' ? 'sales' : 'purchases';
  const title = kind === 'received' ? 'Payments Received' : 'Payments Made';
  const set = (k, v) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n); };
  const cols = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'number', label: 'Payment#', render: (r) => <span className="bold">{r.number}</span> },
    { key: 'reference', label: 'Reference#' },
    { key: 'contact_name', label: kind === 'received' ? 'Customer Name' : 'Vendor Name' },
    { key: 'documents', label: kind === 'received' ? 'Invoice#' : 'Bill#' },
    { key: 'mode', label: 'Mode' },
    { key: 'account_name', label: kind === 'received' ? 'Deposited To' : 'Paid Through' },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount, r.currency) },
    { key: 'unused', label: 'Unused Amount', align: 'right', render: (r) => (r.unused > 0 ? money(r.unused, r.currency) : '—') },
  ];
  return (
    <div className="page">
      <PageHeader title={title} actions={<>
        {can(module, 'create') && <Button variant="primary" onClick={() => nav(`/payments-${kind}/new`)}>+ New</Button>}
        <Menu items={[{ label: 'Export as CSV', onClick: () => downloadCsv(title, data || [], cols) }]} />
      </>}>
        <SearchBox value={q} onChange={(v) => set('q', v)} placeholder="Search payments" />
        <Select style={{ width: 180 }} placeholder="All modes" value={mode} onChange={(e) => set('mode', e.target.value)} options={PAYMENT_MODES.map((m) => [m, m])} />
      </PageHeader>
      {!loading && !data?.length && !q && !mode
        ? <Empty title={`No ${title.toLowerCase()} yet`} text={kind === 'received' ? 'Record the money your customers pay you.' : 'Record payments you make to vendors.'} action={<Button variant="primary" onClick={() => nav(`/payments-${kind}/new`)}>Record Payment</Button>} />
        : <Table columns={cols} rows={data || []} loading={loading} onRowClick={(r) => nav(`/payments-${kind}/${r.id}`)} />}
    </div>
  );
}
