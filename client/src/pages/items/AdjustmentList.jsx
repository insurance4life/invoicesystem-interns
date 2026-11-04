import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Badge, Select, SearchBox } from '../../components/ui.jsx';

const STATUS_FILTER = [['all', 'All Adjustments'], ['draft', 'Draft'], ['adjusted', 'Adjusted']];
const MODE_LABEL = { quantity: 'Quantity', value: 'Value' };

export default function AdjustmentList() {
  const { money, date, can } = useApp();
  const nav = useNavigate();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const { data, loading } = useFetch('/inventory/adjustments', { status, q }, []);
  const rows = data || [];

  const cols = [
    { key: 'date', label: 'Date', width: 110, render: (r) => date(r.date) },
    { key: 'number', label: 'Adjustment#', render: (r) => <span className="bold">{r.number}</span> },
    { key: 'mode', label: 'Mode', render: (r) => MODE_LABEL[r.mode] || r.mode },
    { key: 'reason', label: 'Reason' },
    { key: 'reference', label: 'Reference#' },
    { key: 'item_names', label: 'Items', render: (r) => <span className="small">{r.item_names || `${r.item_count} item(s)`}</span> },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} color={r.status === 'adjusted' ? 'green' : 'gray'}>{r.status === 'adjusted' ? 'Adjusted' : 'Draft'}</Badge> },
    { key: 'total_value', label: 'Value Change', align: 'right', render: (r) => (r.total_value == null ? '—' : money(r.total_value)) },
  ];

  return (
    <div className="page">
      <PageHeader title="Inventory Adjustments"
        actions={can('items', 'create') && <Button variant="primary" onClick={() => nav('/inventory/adjustments/new')}>+ New Adjustment</Button>}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTER} />
        <SearchBox value={q} onChange={setQ} placeholder="Search by number, reference, reason" />
      </PageHeader>
      <Table columns={cols} rows={rows} loading={loading} onRowClick={(r) => nav(`/inventory/adjustments/${r.id}`)}
        empty="No inventory adjustments yet. Adjust stock for damaged, lost or recounted goods." />
    </div>
  );
}
