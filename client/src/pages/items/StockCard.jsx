import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Stat, Card, Empty } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import { fmtNum } from '../../lib/format.js';

const SRC_LABEL = { item_opening: 'Opening Stock', inventory_adjustment: 'Inventory Adjustment' };

function linkFor(r) {
  if (DOC_UI[r.src_type]) return docUrl(r.src_type, r.src_id);
  if (r.src_type === 'inventory_adjustment') return `/inventory/adjustments/${r.src_id}`;
  return null;
}

/** Stock card: every movement of one item with running quantity, value and average cost. */
export default function StockCard() {
  const { itemId } = useParams();
  const nav = useNavigate();
  const { money, date, can } = useApp();
  const { data, loading, error } = useFetch('/inventory/stock', { item_id: itemId }, [itemId]);

  if (loading && !data) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (error || !data) return <div className="page"><Empty title="Stock card not found" action={<Button onClick={() => nav('/items')}>Back to items</Button>} /></div>;

  const { item, rows } = data;
  const cols = [
    { key: 'date', label: 'Date', width: 110, render: (r) => date(r.date) },
    { key: 'type', label: 'Transaction', render: (r) => {
      const link = linkFor(r);
      const label = DOC_UI[r.src_type]?.label || SRC_LABEL[r.src_type] || r.type;
      return <>{link ? <Link to={link}>{label}</Link> : label}{r.number && <div className="muted small">{r.number}</div>}</>;
    } },
    { key: 'qty', label: 'Qty', align: 'right', render: (r) => <span className={r.qty < 0 ? 'neg' : ''}>{r.qty > 0 ? '+' : ''}{fmtNum(r.qty, 2)}</span> },
    { key: 'rate', label: 'Rate', align: 'right', render: (r) => (r.rate ? money(r.rate) : '—') },
    { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value) },
    { key: 'running_qty', label: 'Balance Qty', align: 'right', render: (r) => fmtNum(r.running_qty, 2) },
    { key: 'running_value', label: 'Balance Value', align: 'right', render: (r) => money(r.running_value) },
    { key: 'running_avg', label: 'Avg Cost', align: 'right', render: (r) => money(r.running_avg) },
  ];

  return (
    <div className="page">
      <PageHeader title={`Stock Card: ${item.name}`}
        subtitle={[item.sku && `SKU ${item.sku}`, item.unit].filter(Boolean).join(' · ') || undefined}
        back={<Button variant="link" onClick={() => nav(`/items/${item.id}`)}>← {item.name}</Button>}
        actions={<>
          {item.track_inventory && can('items', 'edit') && <Button variant="primary" onClick={() => nav(`/inventory/adjustments/new?item_id=${item.id}`)}>Adjust Stock</Button>}
        </>} />

      {!item.track_inventory && <Empty title="Stock is not tracked" text="Turn on Track Inventory for this item to see its stock movements." />}

      {item.track_inventory && (
        <>
          <div className="grid4 mt">
            <Stat label="Stock on Hand" value={`${fmtNum(data.stock_on_hand, 2)} ${item.unit || ''}`.trim()} tone={item.reorder_level && data.stock_on_hand <= item.reorder_level ? 'red' : undefined}
              sub={item.reorder_level ? `Reorder level ${fmtNum(item.reorder_level, 2)}` : undefined} />
            <Stat label="Stock Value" value={money(data.stock_value)} />
            <Stat label="Average Cost" value={money(data.avg_cost)} />
            <Stat label="Movements" value={rows.length} />
          </div>
          <Card title="Movements" className="mt" pad={false}>
            <Table columns={cols} rows={rows.map((r, i) => ({ ...r, id: i }))} empty="No stock movements yet." />
          </Card>
        </>
      )}
    </div>
  );
}
