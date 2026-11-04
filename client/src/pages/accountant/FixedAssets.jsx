import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Badge, Empty, Stat } from '../../components/ui.jsx';

export const ASSET_STATUS = { draft: 'gray', active: 'green', disposed: 'red' };
export const METHOD_LABEL = { straight_line: 'Straight line', declining_balance: 'Declining balance' };

export default function FixedAssets() {
  const { money, date, can } = useApp();
  const nav = useNavigate();
  const { data, loading } = useFetch('/fixed-assets');
  const rows = data || [];
  const sum = (k) => rows.filter((a) => a.status !== 'disposed').reduce((s, a) => s + Number(a[k] || 0), 0);

  const columns = [
    { key: 'name', label: 'Asset', render: (a) => <><span className="bold">{a.name}</span>{a.asset_number ? <div className="small muted">{a.asset_number}</div> : null}</> },
    { key: 'purchase_date', label: 'Purchase Date', render: (a) => date(a.purchase_date) },
    { key: 'method', label: 'Method', render: (a) => METHOD_LABEL[a.method] || a.method },
    { key: 'purchase_value', label: 'Cost', align: 'right', render: (a) => money(a.purchase_value) },
    { key: 'accumulated', label: 'Accumulated Dep.', align: 'right', render: (a) => money(a.accumulated) },
    { key: 'book_value', label: 'Book Value', align: 'right', render: (a) => money(a.book_value) },
    { key: 'status', label: 'Status', render: (a) => <Badge color={ASSET_STATUS[a.status] || 'gray'}>{a.status}</Badge> },
  ];

  return (
    <div className="page">
      <PageHeader title="Fixed Assets" subtitle="Equipment and property that is depreciated over its useful life."
        actions={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/fixed-assets/new')}>+ New Asset</Button>} />
      <div className="grid3 mb">
        <Stat label="Cost (in service)" value={money(sum('purchase_value'))} />
        <Stat label="Accumulated depreciation" value={money(sum('accumulated'))} />
        <Stat label="Net book value" value={money(sum('book_value'))} tone="green" />
      </div>
      {!loading && !rows.length
        ? <Empty title="No fixed assets" text="Register an asset to start depreciating it." action={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/fixed-assets/new')}>+ New Asset</Button>} />
        : <Table columns={columns} rows={rows} loading={loading} onRowClick={(a) => nav(`/accountant/fixed-assets/${a.id}`)} />}
    </div>
  );
}
