import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, Textarea, NumberInput, Select, AccountSelect, Combo, Empty } from '../../components/ui.jsx';
import { today, fmtNum } from '../../lib/format.js';
import { X } from 'lucide-react';

const REASONS = ['Stolen goods', 'Damaged goods', 'Stocktaking results', 'Inventory revaluation', 'Other'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'other_expense'];
const round = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;
const uid = () => Math.random().toString(36).slice(2, 10);
const emptyLine = (item_id = null) => ({ key: uid(), item_id, current_qty: 0, current_value: 0, unit: 0, input: '' });

/**
 * Stock adjustment: quantity or value mode, entered either as a change or as the new figure.
 * The server always receives the change (qty_change / value_change), computed here from the entry.
 */
export default function AdjustmentForm() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { toast, money, can } = useApp();
  const existing = useFetch(id ? `/inventory/adjustments/${id}` : null, null, [id]);
  const itemsRes = useFetch('/items', { status: 'active', type: 'goods' }, []);
  const items = (itemsRes.data || []).filter((i) => i.track_inventory);
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));

  const [f, setF] = useState({ mode: 'quantity', entry: 'change', date: today(), reference: '', reason: 'Stocktaking results', account_id: '', description: '', number: '' });
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('draft');
  const [saving, setSaving] = useState(false);
  const adjusted = status === 'adjusted';

  const loadCurrent = async (key, itemId) => {
    try {
      const d = await api.get(`/items/${itemId}`);
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, item_id: itemId, current_qty: d.stock_on_hand || 0, current_value: d.stock_value || 0, unit: d.avg_cost || 0 } : l)));
    } catch (e) { toast(e.message, 'error'); }
  };

  // new adjustment: start with one row, pre-filled when opened from an item (?item_id=)
  useEffect(() => {
    if (id) return;
    const itemId = Number(sp.get('item_id')) || null;
    const first = emptyLine(itemId);
    setLines([first]);
    if (itemId) loadCurrent(first.key, itemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // edit: rebuild the form from the saved adjustment
  useEffect(() => {
    const a = existing.data;
    if (!a) return;
    const draftNew = a.mode === 'value' && a.status !== 'adjusted' && a.lines.some((l) => l.new_value != null);
    setF({ mode: a.mode, entry: draftNew ? 'new' : 'change', date: a.date, reference: a.reference || '', reason: a.reason || 'Other',
      account_id: a.account_id ?? '', description: a.description || '', number: a.number || '' });
    setStatus(a.status);
    setLines(a.lines.map((l) => {
      const was = a.status === 'adjusted';
      // for adjusted rows the server reports stock after the adjustment; show the figure from before it
      const curQty = was ? (l.current_qty || 0) - (l.qty_change || 0) : l.current_qty;
      const curVal = was ? (l.current_value || 0) - (l.value_change || 0) : l.current_value;
      let input = a.mode === 'quantity' ? l.qty_change : (draftNew ? l.new_value : l.value_change);
      return { key: uid(), item_id: l.item_id, current_qty: round(curQty), current_value: round(curVal), unit: l.unit_cost || 0, input: input ?? '' };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setInput = (key, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, input: v } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);

  const pickItem = (key, v) => {
    const itemId = Number(v) || null;
    if (!itemId) return setLines((ls) => ls.map((l) => (l.key === key ? { ...l, item_id: null, current_qty: 0, current_value: 0, input: '' } : l)));
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, item_id: itemId, input: '' } : l)));
    loadCurrent(key, itemId);
  };

  const switchMode = (mode) => { set('mode', mode); setLines((ls) => ls.map((l) => ({ ...l, input: '' }))); };
  const switchEntry = (entry) => { set('entry', entry); setLines((ls) => ls.map((l) => ({ ...l, input: '' }))); };

  /** change and resulting figure for one line, or nulls while the input is empty */
  const calc = (l) => {
    if (l.input === '' || l.input == null) return { change: null, next: null };
    const v = Number(l.input);
    if (Number.isNaN(v)) return { change: null, next: null };
    const cur = f.mode === 'quantity' ? Number(l.current_qty) || 0 : Number(l.current_value) || 0;
    return f.entry === 'change' ? { change: v, next: round(cur + v) } : { change: round(v - cur), next: v };
  };

  const filled = lines.filter((l) => l.item_id);
  const totalChange = filled.reduce((s, l) => s + (calc(l).change || 0), 0);

  const save = async (st) => {
    if (!filled.length) return toast('Add at least one item to adjust', 'error');
    const incomplete = filled.find((l) => calc(l).change == null);
    if (incomplete) return toast(`Enter ${f.entry === 'change' ? 'a change' : 'a new figure'} for ${itemById[incomplete.item_id]?.name || 'an item'}`, 'error');
    const body = {
      mode: f.mode, date: f.date, reference: f.reference, reason: f.reason, account_id: f.account_id || null, description: f.description, status: st,
      lines: filled.map((l) => (f.mode === 'quantity' ? { item_id: l.item_id, qty_change: calc(l).change } : { item_id: l.item_id, value_change: calc(l).change })),
    };
    setSaving(true);
    try {
      if (id) await api.put(`/inventory/adjustments/${id}`, body);
      else await api.post('/inventory/adjustments', body);
      toast(st === 'adjusted' ? 'Stock adjusted' : 'Saved as draft');
      nav('/inventory/adjustments');
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete this adjustment?${adjusted ? ' Its stock and ledger entries will be reversed.' : ''}`)) return;
    try {
      await api.del(`/inventory/adjustments/${id}`);
      toast('Adjustment deleted');
      nav('/inventory/adjustments');
    } catch (e) { toast(e.message, 'error'); }
  };

  if (id && existing.loading && !existing.data) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (id && !existing.loading && !existing.data) return <div className="page"><Empty title="Adjustment not found" action={<Button onClick={() => nav('/inventory/adjustments')}>Back</Button>} /></div>;

  const qtyMode = f.mode === 'quantity';
  const itemOptions = items.map((i) => ({ value: i.id, label: i.name, sub: i.sku ? `SKU ${i.sku}` : undefined }));
  const inputLabel = f.entry === 'change' ? (qtyMode ? 'Qty Change' : 'Value Change') : (qtyMode ? 'New Qty' : 'New Value');

  return (
    <div className="page">
      <PageHeader title={id ? `Adjustment ${f.number}` : 'New Inventory Adjustment'}
        subtitle={id ? (adjusted ? 'Adjusted: stock and ledger are updated' : 'Draft: not yet applied to stock') : undefined} />

      <div className="form-section">
        <div className="form-grid">
          <Field label="Mode" inline>
            <div className="row">
              {[['quantity', 'Quantity'], ['value', 'Value']].map(([v, l]) => (
                <label key={v} className="checkbox"><input type="radio" name="adj_mode" checked={f.mode === v} onChange={() => switchMode(v)} /><span>{l}</span></label>
              ))}
            </div>
          </Field>
          <Field label="Date" inline><Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field label="Reference#" inline><Input value={f.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
          <Field label="Reason" inline>
            <Select value={f.reason} onChange={(e) => set('reason', e.target.value)} options={REASONS.map((r) => [r, r])} />
          </Field>
          <Field label="Account" inline>
            <AccountSelect value={f.account_id} onChange={(v) => set('account_id', v)} filter={EXPENSE_TYPES} placeholder="Default: Inventory Adjustments" />
          </Field>
          <Field label="Description" inline><Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        </div>
      </div>

      <div className="row between mt" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Items</h3>
        <div className="row">
          <span className="muted small">Enter</span>
          {[['change', qtyMode ? 'Quantity change' : 'Value change'], ['new', qtyMode ? 'New quantity' : 'New value']].map(([v, l]) => (
            <label key={v} className="checkbox"><input type="radio" name="adj_entry" checked={f.entry === v} onChange={() => switchEntry(v)} /><span>{l}</span></label>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table className="table lines-table">
          <thead>
            <tr>
              <th style={{ width: '34%' }}>Item</th>
              <th className="r">{qtyMode ? 'Current Qty' : 'Current Value'}</th>
              <th className="r">{inputLabel}</th>
              <th className="r">{qtyMode ? 'New Qty' : 'New Value'}</th>
              <th className="r">{qtyMode ? 'Change' : 'Value Change'}</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const c = calc(l);
              const fmt = (v) => (qtyMode ? fmtNum(v, 2) : money(v));
              return (
                <tr key={l.key}>
                  <td>
                    <Combo value={l.item_id || ''} onChange={(v) => pickItem(l.key, v)} options={itemOptions}
                      placeholder="Select a tracked item…" />
                  </td>
                  <td className="r">{l.item_id ? fmt(qtyMode ? l.current_qty : l.current_value) : '—'}</td>
                  <td className="r" style={{ width: 160 }}>
                    <NumberInput value={l.input} onChange={(v) => setInput(l.key, v)} disabled={!l.item_id} />
                  </td>
                  <td className="r">{c.next == null ? '—' : fmt(c.next)}</td>
                  <td className={`r ${c.change < 0 ? 'neg' : ''}`}>
                    {c.change == null ? '—' : `${c.change > 0 ? '+' : ''}${qtyMode ? fmtNum(c.change, 2) : money(c.change)}`}
                  </td>
                  <td><Button size="sm" variant="link" onClick={() => removeLine(l.key)} aria-label="Remove line"><X size={18} strokeWidth={1.5} /></Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row between mt">
        <Button size="sm" onClick={addLine}>+ Add Item</Button>
        <div className="bold">
          {qtyMode ? `Net quantity change: ${totalChange > 0 ? '+' : ''}${fmtNum(totalChange, 2)}` : `Net value change: ${totalChange > 0 ? '+' : ''}${money(totalChange)}`}
        </div>
      </div>
      {items.length === 0 && !itemsRes.loading && (
        <p className="muted small mt">Only goods with Track Inventory turned on can be adjusted. Turn it on for an item first.</p>
      )}

      <div className="form-foot">
        {adjusted
          ? <Button variant="primary" loading={saving} onClick={() => save('adjusted')}>Save</Button>
          : <>
            <Button loading={saving} onClick={() => save('draft')}>Save as Draft</Button>
            <Button variant="primary" loading={saving} onClick={() => save('adjusted')}>Save and Adjust</Button>
          </>}
        <Button onClick={() => nav('/inventory/adjustments')}>Cancel</Button>
        {id && can('items', 'delete') && <span style={{ flex: 1 }} />}
        {id && can('items', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
      </div>
    </div>
  );
}
