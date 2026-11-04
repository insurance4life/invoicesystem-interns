import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api, downloadCsv } from '../../api.js';
import { PageHeader, Button, Table, Badge, Select, SearchBox } from '../../components/ui.jsx';
import { fmtNum } from '../../lib/format.js';
import ImportDialog from '../contacts/ImportDialog.jsx';

const ITEM_IMPORT_FIELDS = [
  { key: 'name', label: 'Item Name', required: true, aliases: ['name'] },
  { key: 'sku', label: 'SKU' },
  { key: 'type', label: 'Type', aliases: ['item type'] },
  { key: 'unit', label: 'Unit' },
  { key: 'hsn_sac', label: 'HSN/SAC', aliases: ['hsn', 'sac'] },
  { key: 'description', label: 'Description' },
  { key: 'selling_price', label: 'Selling Price', aliases: ['rate'] },
  { key: 'purchase_price', label: 'Purchase Price', aliases: ['cost price'] },
  { key: 'tax_name', label: 'Tax Name', aliases: ['tax'] },
  { key: 'track_inventory', label: 'Track Inventory' },
  { key: 'opening_stock', label: 'Opening Stock' },
  { key: 'opening_stock_rate', label: 'Opening Stock Rate' },
  { key: 'reorder_level', label: 'Reorder Level' },
];

const VIEWS = [['active', 'Active Items'], ['all', 'All Items'], ['inactive', 'Inactive Items'], ['goods', 'Goods'], ['services', 'Services'], ['low_stock', 'Low Stock']];

export default function ItemList() {
  const { money, can, toast } = useApp();
  const nav = useNavigate();
  const [view, setView] = useState('active');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState([]);
  const [importing, setImporting] = useState(false);
  const params = {
    q,
    status: view === 'inactive' ? 'inactive' : view === 'low_stock' ? 'low_stock' : view === 'all' ? 'all' : 'active',
    type: view === 'goods' ? 'goods' : view === 'services' ? 'service' : undefined,
  };
  const { data, loading, reload } = useFetch('/items', params, [view]);
  const rows = data || [];

  const setStatus = async (active) => {
    let ok = 0, failed = [];
    for (const id of selected) {
      try { await api.post(`/items/${id}/status`, { active }); ok++; }
      catch (e) { failed.push(e.message); }
    }
    toast(failed.length ? `${ok} updated, ${failed.length} failed: ${failed[0]}` : `${ok} item${ok === 1 ? '' : 's'} marked ${active ? 'active' : 'inactive'}`, failed.length ? 'error' : 'success');
    setSelected([]);
    reload();
  };

  const cols = [
    { key: 'name', label: 'Name', render: (r) => <span className="bold">{r.name}</span> },
    { key: 'sku', label: 'SKU' },
    { key: 'hsn_sac', label: 'HSN/SAC' },
    { key: 'selling_price', label: 'Rate', align: 'right', render: (r) => money(r.selling_price) },
    { key: 'purchase_price', label: 'Purchase Rate', align: 'right', render: (r) => money(r.purchase_price) },
    { key: 'stock_on_hand', label: 'Stock on Hand', align: 'right', render: (r) => (r.track_inventory ? fmtNum(r.stock_on_hand, 2) : '—') },
    { key: 'reorder_level', label: 'Reorder Level', align: 'right', render: (r) => (r.track_inventory ? fmtNum(r.reorder_level || 0, 2) : '—') },
    { key: 'is_active', label: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'inactive'} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="Items"
        actions={<>
          {can('items', 'create') && <Button onClick={() => setImporting(true)}>Import</Button>}
          <Button onClick={() => downloadCsv('items', rows, [
            { key: 'name', label: 'Item Name' }, { key: 'sku', label: 'SKU' }, { key: 'type', label: 'Type' }, { key: 'unit', label: 'Unit' },
            { key: 'hsn_sac', label: 'HSN/SAC' }, { key: 'description', label: 'Description' }, { key: 'selling_price', label: 'Selling Price' },
            { key: 'purchase_price', label: 'Purchase Price' }, { key: 'track_inventory', label: 'Track Inventory', value: (r) => (r.track_inventory ? 'yes' : 'no') },
            { key: 'stock_on_hand', label: 'Stock on Hand' }, { key: 'reorder_level', label: 'Reorder Level' },
          ])}>Export CSV</Button>
          {can('items', 'create') && <Button variant="primary" onClick={() => nav('/items/new')}>+ New Item</Button>}
        </>}>
        <Select value={view} onChange={(e) => setView(e.target.value)} options={VIEWS} />
        <SearchBox value={q} onChange={setQ} placeholder="Search by name, SKU, HSN/SAC or description" />
      </PageHeader>

      {selected.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="bold">{selected.length} selected</span>
          {can('items', 'edit') && <>
            <Button size="sm" onClick={() => setStatus(true)}>Mark as Active</Button>
            <Button size="sm" onClick={() => setStatus(false)}>Mark as Inactive</Button>
          </>}
        </div>
      )}

      <Table columns={cols} rows={rows} loading={loading} selectable selected={selected} onSelect={setSelected}
        onRowClick={(r) => nav(`/items/${r.id}`)} empty="No items found. Create an item or import a CSV file." />

      {importing && (
        <ImportDialog title="Items" fields={ITEM_IMPORT_FIELDS} endpoint="/items/import" onClose={() => setImporting(false)} onDone={() => reload()} />
      )}
    </div>
  );
}
