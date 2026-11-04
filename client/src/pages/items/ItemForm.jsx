import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, Textarea, NumberInput, Select, Checkbox, AccountSelect, TaxSelect, Card, Empty } from '../../components/ui.jsx';

const UNITS = ['pcs', 'box', 'kg', 'g', 'ltr', 'm', 'hrs', 'nos', 'dozen'];
const INCOME_TYPES = ['income', 'other_income'];
const PURCHASE_TYPES = ['expense', 'cost_of_goods_sold', 'other_expense'];
const STOCK_TYPES = ['stock'];
const MAX_IMAGE = 300 * 1024;

const blank = () => ({
  type: 'goods', name: '', sku: '', unit: '', hsn_sac: '', image: null,
  selling_price: '', sales_account_id: '', tax_id: '', description: '', is_sellable: true,
  purchase_price: '', purchase_account_id: '', purchase_tax_id: '', purchase_description: '', is_purchasable: true,
  track_inventory: false, inventory_account_id: '', opening_stock: '', opening_stock_rate: '', reorder_level: '', custom_fields: {},
});

function fromItem(i) {
  return {
    type: i.type || 'goods', name: i.name || '', sku: i.sku || '', unit: i.unit || '', hsn_sac: i.hsn_sac || '', image: i.image || null,
    selling_price: i.selling_price ?? '', sales_account_id: i.sales_account_id ?? '', tax_id: i.tax_id ?? '', description: i.description || '',
    is_sellable: !!i.is_sellable, purchase_price: i.purchase_price ?? '', purchase_account_id: i.purchase_account_id ?? '',
    purchase_tax_id: i.purchase_tax_id ?? '', purchase_description: i.purchase_description || '', is_purchasable: !!i.is_purchasable,
    track_inventory: !!i.track_inventory, inventory_account_id: i.inventory_account_id ?? '', opening_stock: i.opening_stock || '',
    opening_stock_rate: i.opening_stock_rate || '', reorder_level: i.reorder_level || '', custom_fields: i.custom_fields || {},
  };
}

export default function ItemForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const { meta, toast, money } = useApp();
  const existing = useFetch(editing ? `/items/${id}` : null, null, [id]);
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (existing.data) setF(fromItem(existing.data)); }, [existing.data]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const goods = f.type === 'goods';
  const customFields = (meta?.custom_fields || []).filter((c) => c.module === 'item');

  const onImage = (file) => {
    if (!file) return;
    if (file.size > MAX_IMAGE) return toast('Image must be 300 KB or smaller', 'error');
    if (!/^image\//.test(file.type)) return toast('Choose an image file', 'error');
    const reader = new FileReader();
    reader.onload = () => set('image', reader.result);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    const e = {};
    if (!f.name.trim()) e.name = 'Item name is required';
    if (f.opening_stock !== '' && Number(f.opening_stock) < 0) e.opening_stock = 'Opening stock cannot be negative';
    setErrors(e);
    if (Object.keys(e).length) return toast(Object.values(e)[0], 'error');
    const num = (v) => (v === '' || v == null ? 0 : Number(v));
    const nul = (v) => (v === '' || v == null ? null : v);
    const body = {
      type: f.type, name: f.name.trim(), sku: f.sku.trim() || null, unit: f.unit || null, hsn_sac: f.hsn_sac || null, image: f.image,
      selling_price: num(f.selling_price), sales_account_id: nul(f.sales_account_id), tax_id: nul(f.tax_id), description: f.description || null,
      is_sellable: f.is_sellable ? 1 : 0,
      purchase_price: num(f.purchase_price), purchase_account_id: nul(f.purchase_account_id), purchase_tax_id: nul(f.purchase_tax_id),
      purchase_description: f.purchase_description || null, is_purchasable: f.is_purchasable ? 1 : 0,
      track_inventory: goods && f.track_inventory ? 1 : 0,
      inventory_account_id: goods && f.track_inventory ? nul(f.inventory_account_id) : null,
      opening_stock: goods && f.track_inventory ? num(f.opening_stock) : 0,
      opening_stock_rate: goods && f.track_inventory ? num(f.opening_stock_rate) : 0,
      reorder_level: goods && f.track_inventory ? num(f.reorder_level) : 0,
      custom_fields: f.custom_fields,
    };
    setSaving(true);
    try {
      const res = editing ? await api.put(`/items/${id}`, body) : await api.post('/items', body);
      toast(`Item ${editing ? 'updated' : 'created'}`);
      nav(`/items/${res.id}`);
    } catch (err) {
      toast(err.message, 'error');
      setSaving(false);
    }
  };

  if (editing && existing.loading && !existing.data) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (editing && !existing.loading && !existing.data) return <div className="page"><Empty title="Item not found" action={<Button onClick={() => nav('/items')}>Back to items</Button>} /></div>;

  return (
    <div className="page">
      <PageHeader title={editing ? 'Edit Item' : 'New Item'} />

      <div className="form-section">
        <div className="form-grid">
          <Field label="Type" inline>
            <div className="row">
              {[['goods', 'Goods'], ['service', 'Service']].map(([v, l]) => (
                <label key={v} className="checkbox"><input type="radio" name="item_type" checked={f.type === v} onChange={() => set('type', v)} /><span>{l}</span></label>
              ))}
            </div>
          </Field>
          <Field label="Name" required inline error={errors.name}><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="SKU" inline hint="Stock keeping unit"><Input value={f.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
          <Field label="Unit" inline>
            <>
              <Input list="unit-options" value={f.unit} placeholder="Select or type a unit" onChange={(e) => set('unit', e.target.value)} />
              <datalist id="unit-options">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
            </>
          </Field>
          <Field label={`HSN/SAC`} inline hint={goods ? 'HSN code for goods' : 'SAC code for services'}><Input value={f.hsn_sac} onChange={(e) => set('hsn_sac', e.target.value)} /></Field>
          <Field label="Image" inline hint="PNG or JPG, up to 300 KB">
            <div className="row">
              {f.image && <img src={f.image} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />}
              <input type="file" accept="image/*" onChange={(e) => onImage(e.target.files?.[0])} />
              {f.image && <Button size="sm" variant="link" onClick={() => set('image', null)}>Remove</Button>}
            </div>
          </Field>
        </div>
      </div>

      <div className="grid2">
        <Card title="Sales Information">
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Selling Price" inline><NumberInput value={f.selling_price} onChange={(v) => set('selling_price', v)} /></Field>
            <Field label="Account" inline><AccountSelect value={f.sales_account_id} onChange={(v) => set('sales_account_id', v)} filter={INCOME_TYPES} placeholder="Default: Sales" /></Field>
            <Field label="Tax" inline><TaxSelect value={f.tax_id} onChange={(v) => set('tax_id', v)} placeholder="None" /></Field>
            <Field label="Description" inline><Textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <Field label="Sellable" inline><Checkbox label="Available for sale on invoices and quotes" checked={f.is_sellable} onChange={(v) => set('is_sellable', v)} /></Field>
          </div>
        </Card>
        <Card title="Purchase Information">
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Cost Price" inline><NumberInput value={f.purchase_price} onChange={(v) => set('purchase_price', v)} /></Field>
            <Field label="Account" inline><AccountSelect value={f.purchase_account_id} onChange={(v) => set('purchase_account_id', v)} filter={PURCHASE_TYPES} placeholder="Default: Cost of Goods Sold" /></Field>
            <Field label="Purchase Tax" inline><TaxSelect value={f.purchase_tax_id} onChange={(v) => set('purchase_tax_id', v)} placeholder="None" /></Field>
            <Field label="Description" inline><Textarea rows={3} value={f.purchase_description} onChange={(e) => set('purchase_description', e.target.value)} /></Field>
            <Field label="Purchasable" inline><Checkbox label="Available for purchase on bills and orders" checked={f.is_purchasable} onChange={(v) => set('is_purchasable', v)} /></Field>
          </div>
        </Card>
      </div>

      <div className="form-section mt">
        <h3>Track Inventory</h3>
        {!goods && <p className="muted small">Inventory tracking applies to goods only. Switch the type to Goods to track stock.</p>}
        <div className="form-grid" style={{ opacity: goods ? 1 : 0.55 }}>
          <Field label="Track Inventory" inline>
            <Checkbox label="Track stock for this item" checked={goods && f.track_inventory} disabled={!goods} onChange={(v) => set('track_inventory', v)} />
          </Field>
          {goods && f.track_inventory && <>
            <Field label="Inventory Account" inline><AccountSelect value={f.inventory_account_id} onChange={(v) => set('inventory_account_id', v)} filter={STOCK_TYPES} placeholder="Default: Inventory Asset" /></Field>
            <Field label="Opening Stock" inline error={errors.opening_stock}><NumberInput value={f.opening_stock} onChange={(v) => set('opening_stock', v)} /></Field>
            <Field label="Opening Stock Rate" inline hint="Per unit. Defaults to the cost price"><NumberInput value={f.opening_stock_rate} onChange={(v) => set('opening_stock_rate', v)} /></Field>
            <Field label="Reorder Level" inline hint="Low stock alerts trigger below this quantity"><NumberInput value={f.reorder_level} onChange={(v) => set('reorder_level', v)} /></Field>
            {f.opening_stock !== '' && f.opening_stock_rate !== '' && Number(f.opening_stock) > 0 && (
              <Field label="Opening Value" inline><span className="bold">{money(Number(f.opening_stock) * Number(f.opening_stock_rate))}</span></Field>
            )}
          </>}
        </div>
      </div>

      {customFields.length > 0 && (
        <div className="form-section">
          <h3>Custom Fields</h3>
          <div className="form-grid">
            {customFields.map((cf) => {
              const v = f.custom_fields[cf.field_key];
              const opts = (cf.options || []).map((o) => (typeof o === 'string' ? [o, o] : [o.value, o.label]));
              const setCF = (x) => setF((s) => ({ ...s, custom_fields: { ...s.custom_fields, [cf.field_key]: x } }));
              return (
                <Field key={cf.id} label={cf.label} inline required={!!cf.is_required}>
                  {cf.data_type === 'number' && <NumberInput value={v ?? ''} onChange={setCF} />}
                  {cf.data_type === 'date' && <Input type="date" value={v || ''} onChange={(e) => setCF(e.target.value)} />}
                  {cf.data_type === 'dropdown' && <Select value={v || ''} placeholder="Select" options={opts} onChange={(e) => setCF(e.target.value)} />}
                  {cf.data_type === 'checkbox' && <Checkbox label="Yes" checked={!!v} onChange={setCF} />}
                  {!['number', 'date', 'dropdown', 'checkbox'].includes(cf.data_type) && <Input value={v || ''} onChange={(e) => setCF(e.target.value)} />}
                </Field>
              );
            })}
          </div>
        </div>
      )}

      <div className="form-foot">
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={() => nav(editing ? `/items/${id}` : '/items')}>Cancel</Button>
      </div>
    </div>
  );
}
