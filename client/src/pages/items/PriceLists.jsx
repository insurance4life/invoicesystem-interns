import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Badge, Select, SearchBox } from '../../components/ui.jsx';
import { PL_TYPE_LABELS } from './priceRules.js';

export default function PriceLists() {
  const { can } = useApp();
  const nav = useNavigate();
  const [applies, setApplies] = useState('');
  const [q, setQ] = useState('');
  const { data, loading } = useFetch('/price-lists', { applies_to: applies || undefined, q }, [applies]);
  const rows = data || [];

  const cols = [
    { key: 'name', label: 'Name', render: (r) => <span className="bold">{r.name}</span> },
    { key: 'applies_to', label: 'Applies To', render: (r) => (r.applies_to === 'purchase' ? 'Purchase' : 'Sales') },
    { key: 'type', label: 'Rate Basis', render: (r) => PL_TYPE_LABELS[r.type] || r.type },
    { key: 'percentage', label: 'Percentage / Items', align: 'right', render: (r) => (r.type === 'per_item' ? `${r.item_count} item${r.item_count === 1 ? '' : 's'}` : `${r.percentage}%`) },
    { key: 'rounding', label: 'Rounding', render: (r) => ({ none: 'None', nearest_whole: 'Nearest whole', '.99': 'Nearest .99' })[r.rounding] || r.rounding },
    { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="Price Lists"
        actions={can('items', 'create') && <Button variant="primary" onClick={() => nav('/inventory/price-lists/new')}>+ New Price List</Button>}>
        <Select value={applies} onChange={(e) => setApplies(e.target.value)} placeholder="All price lists"
          options={[['sales', 'Sales'], ['purchase', 'Purchase']]} />
        <SearchBox value={q} onChange={setQ} placeholder="Search price lists" />
      </PageHeader>
      <Table columns={cols} rows={rows} loading={loading} onRowClick={(r) => nav(`/inventory/price-lists/${r.id}`)}
        empty="No price lists yet. Create one to give customers or vendors their own rates." />
    </div>
  );
}
