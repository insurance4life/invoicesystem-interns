import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, NumberInput, Select, Checkbox, Table, Empty } from '../../components/ui.jsx';
import { PL_TYPE_LABELS, PL_ROUNDING, previewRate } from './priceRules.js';

const BLANK = { name: '', description: '', applies_to: 'sales', type: 'markup', percentage: '', rounding: 'none', currency: '', is_active: true };

export default function PriceListForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { toast, meta, org, money, can } = useApp();
  const existing = useFetch(id ? `/price-lists/${id}` : null, null, [id]);
  const itemsRes = useFetch('/items', { status: 'active' }, []);
  const [f, setF] = useState(BLANK);
  const [rates, setRates] = useState({});
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    setF({ name: p.name, description: p.description || '', applies_to: p.applies_to || 'sales', type: p.type, percentage: p.percentage ?? '',
      rounding: p.rounding || 'none', currency: p.currency || '', is_active: !!p.is_active });
    setRates(Object.fromEntries((p.items || []).map((x) => [x.item_id, String(x.rate)])));
  }, [existing.data]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const perItem = f.type === 'per_item';
  const items = (itemsRes.data || []).filter((i) => !q || `${i.name} ${i.sku || ''}`.toLowerCase().includes(q.toLowerCase()));
  const baseOf = (i) => Number((f.applies_to === 'purchase' ? i.purchase_price : i.selling_price) || 0);

  const save = async () => {
    if (!f.name.trim()) return toast('Price list name is required', 'error');
    if (!perItem && (f.percentage === '' || Number.isNaN(Number(f.percentage)))) return toast('Enter a percentage for this price list', 'error');
    const itemRates = Object.entries(rates)
      .filter(([, v]) => v !== '' && v != null && !Number.isNaN(Number(v)))
      .map(([k, v]) => ({ item_id: Number(k), rate: Number(v) }));
    const body = { ...f, name: f.name.trim(), percentage: perItem ? 0 : Number(f.percentage) || 0, items: itemRates, currency: f.currency || org?.currency };
    setSaving(true);
    try {
      if (id) await api.put(`/price-lists/${id}`, body);
      else await api.post('/price-lists', body);
      toast('Price list saved');
      nav('/inventory/price-lists');
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${f.name}? Customers and vendors using it will go back to standard rates.`)) return;
    try {
      await api.del(`/price-lists/${id}`);
      toast('Price list deleted');
      nav('/inventory/price-lists');
    } catch (e) { toast(e.message, 'error'); }
  };

  if (id && existing.loading && !existing.data) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (id && !existing.loading && !existing.data) return <div className="page"><Empty title="Price list not found" action={<Button onClick={() => nav('/inventory/price-lists')}>Back</Button>} /></div>;

  const cols = [
    { key: 'name', label: 'Item', render: (i) => <><div className="bold">{i.name}</div>{i.sku && <div className="muted small">SKU {i.sku}</div>}</> },
    { key: 'base', label: f.applies_to === 'purchase' ? 'Cost Price' : 'Selling Price', align: 'right', render: (i) => money(baseOf(i)) },
    { key: 'rate', label: 'Price List Rate', align: 'right', render: (i) => (perItem
      ? <div style={{ width: 160, marginLeft: 'auto' }}><NumberInput value={rates[i.id] ?? ''} placeholder={String(baseOf(i))}
          onChange={(v) => setRates((r) => ({ ...r, [i.id]: v }))} /></div>
      : <span className="bold">{money(previewRate({ type: f.type, percentage: Number(f.percentage) || 0, rounding: f.rounding }, baseOf(i)))}</span>) },
  ];

  return (
    <div className="page">
      <PageHeader title={id ? `Edit Price List` : 'New Price List'} />

      <div className="form-section">
        <div className="form-grid">
          <Field label="Name" required inline><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Description" inline><Input value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Applies To" inline>
            <Select value={f.applies_to} onChange={(e) => set('applies_to', e.target.value)} options={[['sales', 'Sales (customers)'], ['purchase', 'Purchase (vendors)']]} />
          </Field>
          <Field label="Rate Basis" inline>
            <Select value={f.type} onChange={(e) => set('type', e.target.value)} options={Object.entries(PL_TYPE_LABELS)} />
          </Field>
          {!perItem && <Field label="Percentage" inline hint={f.type === 'markdown' ? 'Taken off the standard rate' : 'Added to the standard rate'}>
            <NumberInput value={f.percentage} onChange={(v) => set('percentage', v)} />
          </Field>}
          {!perItem && <Field label="Rounding" inline>
            <Select value={f.rounding} onChange={(e) => set('rounding', e.target.value)} options={PL_ROUNDING} />
          </Field>}
          <Field label="Currency" inline>
            <Select value={f.currency} onChange={(e) => set('currency', e.target.value)} placeholder={`Organization default (${org?.currency || 'INR'})`}
              options={(meta?.currencies || []).map((c) => [c.code, c.code])} />
          </Field>
          <Field label="Status" inline><Checkbox label="Active" checked={f.is_active} onChange={(v) => set('is_active', v)} /></Field>
        </div>
      </div>

      <div className="form-section">
        <div className="row between" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{perItem ? 'Item Rates' : 'Preview'}</h3>
          <Input className="search" placeholder="Filter items" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="muted small">
          {perItem
            ? 'Enter the rate for each item. Items left blank use their standard rate.'
            : `Rates are calculated from each item's standard rate (${PL_TYPE_LABELS[f.type]?.toLowerCase()}). Switch the rate basis to per-item rates to set them by hand.`}
        </p>
        <Table columns={cols} rows={items} empty="No active items." />
      </div>

      <div className="form-foot">
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={() => nav('/inventory/price-lists')}>Cancel</Button>
        {id && can('items', 'delete') && <span style={{ flex: 1 }} />}
        {id && can('items', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
      </div>
    </div>
  );
}
