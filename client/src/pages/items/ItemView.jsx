import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Badge, Menu, Tabs, Card, Stat, KeyValue, Empty } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import { fmtNum } from '../../lib/format.js';

const SRC_LABEL = { item_opening: 'Opening Stock', inventory_adjustment: 'Inventory Adjustment' };

export default function ItemView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { money, date, can, toast, meta } = useApp();
  const [tab, setTab] = useState('overview');
  const { data: i, loading, reload } = useFetch(`/items/${id}`, null, [id]);
  const history = useFetch(tab === 'history' ? '/activity' : null, { entity_type: 'item', entity_id: id, limit: 200 }, [id, tab]);

  if (loading && !i) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (!i) return <div className="page"><Empty title="Item not found" action={<Button onClick={() => nav('/items')}>Back to items</Button>} /></div>;

  const module = 'items';
  const taxName = (tid) => meta?.taxes?.find((t) => t.id === tid)?.name;
  const accName = (aid) => meta?.accounts?.find((a) => a.id === aid)?.name;
  const available = (i.stock_on_hand || 0) - (i.committed || 0);

  const toggleActive = async () => {
    try {
      await api.post(`/items/${i.id}/status`, { active: !i.is_active });
      toast(i.is_active ? 'Item marked inactive' : 'Item marked active');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${i.name}? This cannot be undone.`)) return;
    try {
      await api.del(`/items/${i.id}`);
      toast('Item deleted');
      nav('/items');
    } catch (e) { toast(e.message, 'error'); }
  };

  const clone = async () => {
    const body = {
      type: i.type, name: `${i.name} (copy)`, sku: null, unit: i.unit, hsn_sac: i.hsn_sac, description: i.description, image: i.image,
      selling_price: i.selling_price, sales_account_id: i.sales_account_id, tax_id: i.tax_id, is_sellable: i.is_sellable,
      purchase_price: i.purchase_price, purchase_account_id: i.purchase_account_id, purchase_description: i.purchase_description,
      purchase_tax_id: i.purchase_tax_id, is_purchasable: i.is_purchasable, track_inventory: i.track_inventory,
      inventory_account_id: i.inventory_account_id, opening_stock: i.opening_stock, opening_stock_rate: i.opening_stock_rate,
      reorder_level: i.reorder_level, custom_fields: i.custom_fields,
    };
    try {
      const res = await api.post('/items', body);
      toast('Item cloned');
      nav(`/items/${res.id}/edit`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const menu = [
    { label: 'Clone', onClick: clone, hidden: !can(module, 'create') },
    { label: i.is_active ? 'Mark as Inactive' : 'Mark as Active', onClick: toggleActive, hidden: !can(module, 'edit') },
    { divider: true },
    { label: 'Delete', onClick: remove, danger: true, hidden: !can(module, 'delete') },
  ];

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'transactions', label: 'Transactions', count: i.transactions?.length },
    { key: 'stock', label: 'Stock History', count: i.track_inventory ? i.stock_moves?.length : undefined },
    { key: 'history', label: 'History' },
  ];

  return (
    <div className="page">
      <PageHeader
        title={<span>{i.name} {!i.is_active && <Badge status="inactive" />}</span>}
        subtitle={[i.type === 'service' ? 'Service' : 'Goods', i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ')}
        back={<Button variant="link" onClick={() => nav('/items')}>← Items</Button>}
        actions={<>
          {i.track_inventory && can('items', 'edit') && <Button onClick={() => nav(`/inventory/adjustments/new?item_id=${i.id}`)}>Adjust Stock</Button>}
          {can(module, 'edit') && <Button onClick={() => nav(`/items/${i.id}/edit`)}>Edit</Button>}
          <Menu label="More" items={menu} />
        </>}
      />

      {i.track_inventory && (
        <div className="grid4 mt">
          <Stat label="Stock on Hand" value={`${fmtNum(i.stock_on_hand, 2)} ${i.unit || ''}`.trim()} sub={i.reorder_level ? `Reorder at ${fmtNum(i.reorder_level, 2)}` : undefined}
            tone={i.reorder_level && i.stock_on_hand <= i.reorder_level ? 'red' : undefined} />
          <Stat label="Committed Stock" value={fmtNum(i.committed || 0, 2)} sub="Sales orders not yet invoiced" />
          <Stat label="Available for Sale" value={fmtNum(available, 2)} />
          <Stat label="Stock Value" value={money(i.stock_value)} sub={`Avg cost ${money(i.avg_cost)}`} />
        </div>
      )}

      <div className="mt"><Tabs tabs={tabs} active={tab} onChange={setTab} /></div>

      {tab === 'overview' && (
        <div className="grid2 mt">
          <Card title="Item Details">
            <KeyValue items={[
              ['Type', i.type === 'service' ? 'Service' : 'Goods'],
              ['SKU', i.sku], ['Unit', i.unit], [i.type === 'service' ? 'SAC' : 'HSN', i.hsn_sac],
              ['Description', i.description],
              ['Selling Price', money(i.selling_price)], ['Sales Account', accName(i.sales_account_id)],
              ['Sales Tax', taxName(i.tax_id)],
              ['Cost Price', money(i.purchase_price)], ['Purchase Account', accName(i.purchase_account_id)],
              ['Purchase Tax', taxName(i.purchase_tax_id)], ['Purchase Description', i.purchase_description],
              ['Track Inventory', i.track_inventory ? 'Yes' : 'No'],
              i.track_inventory ? ['Inventory Account', accName(i.inventory_account_id)] : null,
              i.track_inventory ? ['Reorder Level', fmtNum(i.reorder_level || 0, 2)] : null,
              ['Sellable', i.is_sellable ? 'Yes' : 'No'], ['Purchasable', i.is_purchasable ? 'Yes' : 'No'],
            ].filter(Boolean)} />
          </Card>
          <div className="stack">
            {i.image && <Card title="Image"><img src={i.image} alt={i.name} style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 6 }} /></Card>}
            {i.track_inventory && (
              <Card title="Stock">
                <div className="small">Stock history and the running quantity and value are on the <Link to={`/inventory/stock/${i.id}`}>stock card</Link>.</div>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'transactions' && (
        <Card title="Transactions" className="mt">
          <Table
            columns={[
              { key: 'date', label: 'Date', render: (r) => date(r.date) },
              { key: 'number', label: 'Number', render: (r) => (DOC_UI[r.doc_type] ? <Link to={docUrl(r.doc_type, r.id)}>{r.number}</Link> : r.number) },
              { key: 'type', label: 'Type', render: (r) => DOC_UI[r.doc_type]?.label || r.doc_type },
              { key: 'contact_name', label: 'Customer / Vendor' },
              { key: 'quantity', label: 'Qty', align: 'right', render: (r) => fmtNum(r.quantity, 2) },
              { key: 'rate', label: 'Rate', align: 'right', render: (r) => money(r.rate) },
              { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
              { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
            ]}
            rows={i.transactions || []}
            empty="This item has not been used in any transaction yet."
          />
        </Card>
      )}

      {tab === 'stock' && (
        <Card title="Stock History" className="mt">
          {!i.track_inventory && <span className="muted">This item does not track inventory.</span>}
          {i.track_inventory && (
            <>
              <div className="row between" style={{ marginBottom: 10 }}>
                <span className="muted small">Latest 100 movements</span>
                <Button size="sm" onClick={() => nav(`/inventory/stock/${i.id}`)}>Open full stock card</Button>
              </div>
              <Table
                columns={[
                  { key: 'date', label: 'Date', render: (r) => date(r.date) },
                  { key: 'src_type', label: 'Transaction', render: (r) => DOC_UI[r.src_type]?.label || SRC_LABEL[r.src_type] || r.src_type },
                  { key: 'qty', label: 'Qty', align: 'right', render: (r) => (r.qty > 0 ? '+' : '') + fmtNum(r.qty, 2) },
                  { key: 'rate', label: 'Rate', align: 'right', render: (r) => money(r.rate) },
                  { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value) },
                ]}
                rows={i.stock_moves || []}
                empty="No stock movements."
              />
            </>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card title="History" className="mt">
          {history.loading && <div className="center pad"><span className="spin" /></div>}
          {!history.loading && (history.data || []).length === 0 && <span className="muted">No activity yet.</span>}
          {(history.data || []).map((a) => (
            <div key={a.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid var(--line2)' }}>
              <span className="bold">{a.user_name || 'System'}</span> {a.action}{a.detail ? <span className="muted"> — {a.detail}</span> : null}
              <div className="muted">{date(String(a.created_at).slice(0, 10))} {String(a.created_at).slice(11, 16)}</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
