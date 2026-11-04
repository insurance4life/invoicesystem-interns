import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, Textarea, NumberInput, Select, Combo, AccountSelect, TaxSelect, Checkbox, Spinner, Modal } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import { today, PAYMENT_MODES } from '../../lib/format.js';
import { computeDocument, dueDateFor, INDIAN_STATES, round2 } from '@shared/calc.js';

let keySeq = 1;
const blankLine = () => ({ key: keySeq++, item_id: '', name: '', description: '', quantity: 1, rate: '', discount: '', tax_id: '', account_id: '', hsn_sac: '', unit: '' });

function QuickContactModal({ type, initial, onClose, onCreated }) {
  const { toast } = useApp();
  const [f, setF] = useState({ display_name: initial || '', email: '', phone: '', gstin: '', place_of_supply: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { onCreated(await api.post('/contacts', { type, ...f })); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`New ${type === 'vendor' ? 'Vendor' : 'Customer'}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Field label="Display Name" required><Input autoFocus value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="GSTIN"><Input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="Place of Supply"><Select placeholder="Select" value={f.place_of_supply} onChange={(e) => setF({ ...f, place_of_supply: e.target.value })} options={INDIAN_STATES.map(([c, n]) => [c, `[${c}] ${n}`])} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function DocForm({ type }) {
  const ui = DOC_UI[type];
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { meta, org, settings, money, toast, currency: baseCur } = useApp();
  const isSales = ui.contact === 'customer';
  const prefs = settings?.preferences || {};
  const [doc, setDoc] = useState(null);
  const [lines, setLines] = useState([blankLine()]);
  const [contacts, setContacts] = useState([]);
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [contact, setContact] = useState(null);
  const [priceList, setPriceList] = useState(null);
  const [unbilled, setUnbilled] = useState([]);
  const [saving, setSaving] = useState('');
  const [newContact, setNewContact] = useState(null);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    api.get('/contacts', { type: ui.contact }).then(setContacts).catch(() => {});
    api.get('/items').then(setItems).catch(() => {});
    api.get('/projects').then((p) => setProjects(Array.isArray(p) ? p : p.rows || [])).catch(() => {});
    if (id) {
      api.get(`/documents/${type}/${id}`).then((d) => {
        setDoc(d);
        setLines(d.lines.length ? d.lines.map((l) => ({ ...l, key: keySeq++, tax_id: l.tax_id || '', item_id: l.item_id || '' })) : [blankLine()]);
      }).catch((e) => toast(e.message, 'error'));
    } else {
      const termsKey = { invoice: 'invoice_terms', quote: 'quote_terms', salesorder: 'so_terms', purchaseorder: 'po_terms', recurring_invoice: 'invoice_terms' }[type];
      const notesKey = { invoice: 'invoice_notes', recurring_invoice: 'invoice_notes', bill: 'bill_notes' }[type];
      const d = {
        date: today(), contact_id: sp.get('contact_id') ? Number(sp.get('contact_id')) : '', reference: '', due_date: '', payment_term_id: '',
        discount_type: 'percent', discount_value: '', shipping: '', adjustment: '', adjustment_label: 'Adjustment',
        tax_inclusive: prefs.tax_inclusive_default ? 1 : 0, notes: (notesKey && prefs[notesKey]) || '', terms: (termsKey && prefs[termsKey]) || '',
        currency: baseCur, exchange_rate: 1, place_of_supply: org.state || '', salesperson: '', project_id: sp.get('project_id') || '', custom_fields: {},
        payment_mode: 'Cash', account_id: '', recurrence: ui.profile ? { frequency: 'monthly', every: 1, start_date: today(), end_date: '', auto_send: false } : null,
      };
      setDoc(d);
      if (!ui.profile) api.get(`/documents/${type}/next-number`).then((r) => setDoc((x) => ({ ...x, number: x.number || r.number }))).catch(() => {});
    }
  }, [type, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // load contact details (terms, place of supply, currency, price list, unbilled expenses)
  useEffect(() => {
    if (!doc?.contact_id) { setContact(null); setPriceList(null); setUnbilled([]); return; }
    let live = true;
    api.get(`/contacts/${doc.contact_id}`).then((c) => {
      if (!live) return;
      setContact(c);
      if (!id) {
        setDoc((d) => ({
          ...d,
          payment_term_id: c.payment_term_id || d.payment_term_id || meta.payment_terms.find((t) => t.is_default)?.id || '',
          place_of_supply: c.place_of_supply || org.state || '',
          currency: c.currency || baseCur,
          exchange_rate: c.currency && c.currency !== baseCur ? (meta.currencies.find((x) => x.code === c.currency)?.exchange_rate || 1) : 1,
        }));
      }
      if (c.price_list_id) api.get(`/price-lists/${c.price_list_id}`).then((p) => live && setPriceList(p)).catch(() => setPriceList(null));
      else setPriceList(null);
    }).catch(() => {});
    if (type === 'invoice') api.get('/expenses', { customer_id: doc.contact_id, unbilled: 1 }).then((e) => live && setUnbilled(e)).catch(() => {});
    return () => { live = false; };
  }, [doc?.contact_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // due date from payment terms
  useEffect(() => {
    if (!doc || !ui.dueLabel || ui.profile) return;
    const term = meta.payment_terms.find((t) => t.id === Number(doc.payment_term_id));
    if (term && doc.date) setDoc((d) => ({ ...d, due_date: dueDateFor(d.date, term) }));
  }, [doc?.payment_term_id, doc?.date]); // eslint-disable-line react-hooks/exhaustive-deps

  const taxes = useMemo(() => Object.fromEntries((meta?.taxes || []).map((t) => [t.id, t])), [meta]);
  const calc = useMemo(() => (doc ? computeDocument({ ...doc, lines }, { taxes, orgState: org.state, gst: !!org.gst_enabled && org.country === 'India' }) : null), [doc, lines, taxes, org]);

  if (!doc) return <Spinner />;
  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const itemRate = (it) => {
    let rate = isSales ? it.selling_price : it.purchase_price;
    if (priceList && (priceList.applies_to || 'sales') === (isSales ? 'sales' : 'purchase')) {
      const pi = priceList.items?.find((x) => Number(x.item_id) === it.id);
      if (priceList.type === 'per_item' && pi) rate = pi.rate;
      else if (priceList.type === 'markup') rate = rate * (1 + (priceList.percentage || 0) / 100);
      else if (priceList.type === 'markdown') rate = rate * (1 - (priceList.percentage || 0) / 100);
      if (priceList.rounding === 'nearest_whole') rate = Math.round(rate);
      if (priceList.rounding === '.99') rate = Math.floor(rate) + 0.99;
    }
    return round2(rate);
  };
  const pickItem = (key, itemId) => {
    const it = items.find((x) => x.id === Number(itemId));
    if (!it) return setLine(key, { item_id: '' });
    setLine(key, {
      item_id: it.id, name: it.name, description: (isSales ? it.description : it.purchase_description) || '', rate: itemRate(it),
      tax_id: (isSales ? it.tax_id : it.purchase_tax_id || it.tax_id) || '', hsn_sac: it.hsn_sac || '', unit: it.unit || '',
      account_id: isSales ? it.sales_account_id : (it.track_inventory ? it.inventory_account_id : it.purchase_account_id) || '',
    });
  };
  const addUnbilled = (e) => {
    setLines((ls) => [...ls.filter((l) => l.item_id || l.name || l.rate), {
      ...blankLine(), name: `Expense: ${e.account_name || 'Billable expense'}`, description: [e.reference, e.notes].filter(Boolean).join(' – '),
      rate: round2(e.total * (1 + (e.markup_percent || 0) / 100)), src_type: 'expense', src_id: e.id,
    }]);
    setUnbilled((u) => u.filter((x) => x.id !== e.id));
  };

  const contactOpts = contacts.filter((c) => c.is_active || c.id === Number(doc.contact_id)).map((c) => ({ value: c.id, label: c.display_name, sub: [c.email, c.gstin].filter(Boolean).join(' · ') }));
  const itemOpts = items.filter((i) => i.is_active && (isSales ? i.is_sellable : i.is_purchasable)).map((i) => ({ value: i.id, label: i.name, sub: `${i.sku ? `SKU ${i.sku} · ` : ''}Rate ${money(isSales ? i.selling_price : i.purchase_price)}${i.track_inventory ? ` · Stock ${i.stock_on_hand}` : ''}` }));
  const customFields = (meta.custom_fields || []).filter((c) => c.module === type || (ui.profile && c.module === type.replace('recurring_', '')));
  const showLineDiscount = prefs.discount_level === 'line';
  const showDocDiscount = prefs.discount_level !== 'line' && prefs.discount_level !== 'none';
  const isLiveEdit = id && !['draft'].includes(doc.status);

  const save = async (mode) => {
    const errs = {};
    if (!doc.contact_id && type !== 'deliverychallan') errs.contact = `Select a ${ui.contact}`;
    if (!lines.some((l) => l.item_id || l.name || l.description || Number(l.rate))) errs.lines = 'Add at least one item';
    if (ui.accounts && lines.some((l) => (l.name || Number(l.rate)) && !l.item_id && !l.account_id)) errs.lines = 'Choose an account for each line without an item';
    setErrors(errs);
    if (Object.keys(errs).length) { toast(Object.values(errs)[0], 'error'); return; }
    setSaving(mode);
    const body = {
      ...doc, lines: lines.map(({ key, ...l }) => ({ ...l, tax_id: l.tax_id || null, item_id: l.item_id || null, account_id: l.account_id || null })),
      save_as: mode === 'draft' ? undefined : mode,
      recurrence: ui.profile ? { ...doc.recurrence, end_date: doc.recurrence?.end_date || null } : undefined,
    };
    try {
      const r = id ? await api.put(`/documents/${type}/${id}`, body) : await api.post(`/documents/${type}`, body);
      (r.warnings || []).forEach((w) => toast(w, 'info'));
      toast(`${ui.label} ${r.number} ${id ? 'updated' : 'saved'}${r.status === 'pending_approval' ? ' and submitted for approval' : ''}`);
      nav(docUrl(type, r.id));
    } catch (e) { toast(e.message, 'error'); }
    setSaving('');
  };

  const sendLabel = { quote: 'Save and Send', salesorder: 'Save and Confirm', purchaseorder: 'Save and Issue', deliverychallan: 'Save as Open', creditnote: 'Save as Open', vendorcredit: 'Save as Open', bill: 'Save as Open', retainer: 'Save and Send', invoice: 'Save and Send' }[type];

  return (
    <div className="page">
      <PageHeader title={`${id ? 'Edit' : 'New'} ${ui.label}`} actions={<Button variant="link" onClick={() => nav(-1)}>✕</Button>} />
      <div className="form-section">
        <div className="form-grid">
          <Field inline label={`${ui.contact === 'vendor' ? 'Vendor' : 'Customer'} Name`} required={type !== 'deliverychallan'} error={errors.contact}>
            <Combo value={doc.contact_id} onChange={(v) => set('contact_id', v)} options={contactOpts} placeholder={`Select or add a ${ui.contact}`}
              onCreate={(q) => setNewContact(q)} createLabel={`+ New ${ui.contact}`} />
          </Field>
          <div>
            {contact && (
              <div className="small muted" style={{ paddingTop: 6 }}>
                {contact.gstin && <div>GSTIN: {contact.gstin} · {contact.gst_treatment || 'registered'}</div>}
                <div>Outstanding: {money(contact.outstanding, contact.currency)}{contact.unused_credits > 0 && ` · Unused credits: ${money(contact.unused_credits)}`}</div>
                {contact.credit_limit ? <div>Credit limit: {money(contact.credit_limit)}</div> : null}
                {priceList && <div>Price list: {priceList.name}</div>}
              </div>
            )}
          </div>
          {org.gst_enabled && org.country === 'India' ? (
            <Field inline label="Place of Supply" hint={doc.place_of_supply && doc.place_of_supply !== org.state ? 'Inter-state: IGST applies' : 'Intra-state: CGST + SGST apply'}>
              <Select value={doc.place_of_supply} onChange={(e) => set('place_of_supply', e.target.value)} options={INDIAN_STATES.map(([c, n]) => [c, `[${c}] ${n}`])} />
            </Field>
          ) : <div />}
          <div />
          <Field inline label={ui.numberLabel} required>
            <Input value={doc.number} onChange={(e) => set('number', e.target.value)} placeholder={ui.profile ? 'e.g. Monthly retainer – Acme' : 'Auto-generated'} />
          </Field>
          <Field inline label="Reference#"><Input value={doc.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
          {!ui.profile && <Field inline label={`${ui.label} Date`} required><Input type="date" value={doc.date} onChange={(e) => set('date', e.target.value)} /></Field>}
          {ui.dueLabel && !ui.profile && (
            <Field inline label="Terms">
              <Select value={doc.payment_term_id} placeholder="Custom" onChange={(e) => set('payment_term_id', e.target.value)} options={meta.payment_terms.map((t) => [t.id, t.name])} />
            </Field>
          )}
          {ui.dueLabel && !ui.profile && <Field inline label={ui.dueLabel}><Input type="date" value={doc.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>}
          {ui.profile && (
            <>
              <Field inline label="Repeat Every">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <NumberInput style={{ width: 70 }} value={doc.recurrence?.every} onChange={(v) => set('recurrence', { ...doc.recurrence, every: v })} />
                  <Select value={doc.recurrence?.frequency} onChange={(e) => set('recurrence', { ...doc.recurrence, frequency: e.target.value })} options={[['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)'], ['yearly', 'Year(s)']]} />
                </div>
              </Field>
              <Field inline label="Start On"><Input type="date" value={doc.recurrence?.start_date} onChange={(e) => setDoc((d) => ({ ...d, date: e.target.value, recurrence: { ...d.recurrence, start_date: e.target.value } }))} /></Field>
              <Field inline label="Ends On" hint="Leave empty for never expires"><Input type="date" value={doc.recurrence?.end_date} onChange={(e) => set('recurrence', { ...doc.recurrence, end_date: e.target.value })} /></Field>
              <Field inline label="Terms"><Select value={doc.payment_term_id} placeholder="Due on receipt" onChange={(e) => set('payment_term_id', e.target.value)} options={meta.payment_terms.map((t) => [t.id, t.name])} /></Field>
              {type === 'recurring_invoice' && <Field inline label=" "><Checkbox label="Send invoices automatically (otherwise created as Open, not Draft)" checked={doc.recurrence?.auto_send} onChange={(v) => set('recurrence', { ...doc.recurrence, auto_send: v })} /></Field>}
            </>
          )}
          {isSales && type !== 'deliverychallan' && <Field inline label="Salesperson"><Input value={doc.salesperson} onChange={(e) => set('salesperson', e.target.value)} /></Field>}
          {['invoice', 'quote', 'bill', 'salesorder'].includes(type) && projects.length > 0 && (
            <Field inline label="Project"><Select placeholder="None" value={doc.project_id} onChange={(e) => set('project_id', e.target.value)} options={projects.filter((p) => !doc.contact_id || !p.customer_id || p.customer_id === Number(doc.contact_id) || !isSales).map((p) => [p.id, p.name])} /></Field>
          )}
          {meta.currencies.length > 1 && (
            <Field inline label="Currency">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Select value={doc.currency} onChange={(e) => { const c = e.target.value; setDoc((d) => ({ ...d, currency: c, exchange_rate: c === baseCur ? 1 : meta.currencies.find((x) => x.code === c)?.exchange_rate || 1 })); }} options={meta.currencies.map((c) => [c.code, `${c.code} – ${c.name}`])} />
                {doc.currency !== baseCur && <><span className="muted small" style={{ whiteSpace: 'nowrap' }}>1 {doc.currency} =</span><NumberInput style={{ width: 100 }} value={doc.exchange_rate} onChange={(v) => set('exchange_rate', v)} /><span className="muted small">{baseCur}</span></>}
              </div>
            </Field>
          )}
          {ui.receipt && (
            <>
              <Field inline label="Payment Mode"><Select value={doc.payment_mode} onChange={(e) => set('payment_mode', e.target.value)} options={PAYMENT_MODES.map((m) => [m, m])} /></Field>
              <Field inline label="Deposit To"><AccountSelect value={doc.account_id} onChange={(v) => set('account_id', v)} filter={['cash', 'bank', 'other_current_asset', 'payment_clearing']} placeholder="Undeposited Funds" /></Field>
            </>
          )}
          {customFields.map((cf) => (
            <Field inline key={cf.id} label={cf.label} required={!!cf.is_required}>
              {cf.data_type === 'dropdown'
                ? <Select placeholder="Select" value={doc.custom_fields?.[cf.field_key]} onChange={(e) => set('custom_fields', { ...doc.custom_fields, [cf.field_key]: e.target.value })} options={(cf.options || []).map((o) => [o, o])} />
                : cf.data_type === 'checkbox'
                  ? <Checkbox checked={doc.custom_fields?.[cf.field_key]} onChange={(v) => set('custom_fields', { ...doc.custom_fields, [cf.field_key]: v })} />
                  : <Input type={{ number: 'number', date: 'date', email: 'email', url: 'url' }[cf.data_type] || 'text'} value={doc.custom_fields?.[cf.field_key]} onChange={(e) => set('custom_fields', { ...doc.custom_fields, [cf.field_key]: e.target.value })} />}
            </Field>
          ))}
        </div>
      </div>

      {unbilled.length > 0 && (
        <div className="callout">
          <span>💡 {contact?.display_name} has {unbilled.length} unbilled expense(s).</span>
          <div className="row">{unbilled.slice(0, 5).map((e) => <Button key={e.id} size="sm" onClick={() => addUnbilled(e)}>+ {e.account_name} {money(e.total)}</Button>)}</div>
        </div>
      )}

      <div className="form-section">
        <div className="row between mb">
          <h3>Item Table</h3>
          <Select style={{ width: 180 }} value={doc.tax_inclusive ? '1' : '0'} onChange={(e) => set('tax_inclusive', Number(e.target.value))} options={[['0', 'Tax Exclusive'], ['1', 'Tax Inclusive']]} />
        </div>
        {errors.lines && <div className="field-error mb">{errors.lines}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table className="lines-table">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>{ui.noItems ? 'Description' : 'Item Details'}</th>
                {ui.accounts && <th style={{ minWidth: 180 }}>Account</th>}
                {org.gst_enabled ? <th style={{ width: 100 }}>HSN/SAC</th> : null}
                <th style={{ width: 90 }} className="r">Quantity</th>
                <th style={{ width: 110 }} className="r">Rate</th>
                {showLineDiscount && <th style={{ width: 80 }} className="r">Disc %</th>}
                <th style={{ width: 170 }}>Tax</th>
                <th style={{ width: 120 }} className="r">Amount</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>
                    {!ui.noItems && <Combo value={l.item_id} onChange={(v) => pickItem(l.key, v)} options={itemOpts} placeholder="Type or click to select an item" onCreate={() => window.open('/items/new', '_blank')} createLabel="+ Add New Item" />}
                    {(!l.item_id || ui.noItems) && <Input style={{ marginTop: ui.noItems ? 0 : 4 }} placeholder={ui.noItems ? 'Description' : 'Or type a line name'} value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} />}
                    <Textarea rows={1} style={{ marginTop: 4, minHeight: 30 }} placeholder="Description" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    {l.src_type && <div className="small muted">Linked {l.src_type} #{l.src_id}</div>}
                  </td>
                  {ui.accounts && <td><AccountSelect value={l.account_id} onChange={(v) => setLine(l.key, { account_id: v })} filter={(a) => !['accounts_receivable', 'accounts_payable'].includes(a.type)} /></td>}
                  {org.gst_enabled ? <td><Input value={l.hsn_sac} onChange={(e) => setLine(l.key, { hsn_sac: e.target.value })} /></td> : null}
                  <td><NumberInput value={l.quantity} onChange={(v) => setLine(l.key, { quantity: v })} />{l.unit && <div className="small muted r">{l.unit}</div>}</td>
                  <td><NumberInput value={l.rate} onChange={(v) => setLine(l.key, { rate: v })} /></td>
                  {showLineDiscount && <td><NumberInput value={l.discount} onChange={(v) => setLine(l.key, { discount: v })} /></td>}
                  <td><TaxSelect value={l.tax_id} onChange={(v) => setLine(l.key, { tax_id: v })} placeholder="Select a Tax" /></td>
                  <td className="r bold" style={{ paddingTop: 12 }}>{(calc?.lines[i]?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td><button className="icon-btn rm" title="Remove" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row mt">
          <Button size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add New Row</Button>
          <Button size="sm" onClick={() => setLines((ls) => [...ls, ...Array.from({ length: 5 }, blankLine)])}>+ Add Rows in Bulk</Button>
        </div>

        <div className="row mt" style={{ alignItems: 'flex-start' }}>
          <div className="grow stack" style={{ maxWidth: 520 }}>
            <Field label={isSales ? 'Customer Notes' : 'Notes'}><Textarea value={doc.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Will be displayed on the document" /></Field>
            {!['deliverychallan'].includes(type) && <Field label="Terms & Conditions"><Textarea value={doc.terms} onChange={(e) => set('terms', e.target.value)} /></Field>}
          </div>
          <div className="totals">
            <div className="t-row"><span>Sub Total</span><span>{money(calc.subtotal, doc.currency)}</span></div>
            {showDocDiscount && (
              <div className="t-row">
                <span>Discount</span>
                <span className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <NumberInput style={{ width: 70 }} value={doc.discount_value} onChange={(v) => set('discount_value', v)} />
                  <Select style={{ width: 60 }} value={doc.discount_type} onChange={(e) => set('discount_type', e.target.value)} options={[['percent', '%'], ['amount', doc.currency]]} />
                </span>
                <span>-{money(calc.discount_total, doc.currency)}</span>
              </div>
            )}
            {calc.taxes.map((t) => <div className="t-row" key={t.name}><span>{t.name} [{t.rate}%]</span><span>{money(t.amount, doc.currency)}</span></div>)}
            {prefs.allow_shipping !== false && !ui.noItems && (
              <div className="t-row"><span>Shipping Charges</span><NumberInput style={{ width: 110 }} value={doc.shipping} onChange={(v) => set('shipping', v)} /></div>
            )}
            {prefs.allow_adjustment !== false && (
              <div className="t-row">
                <Input style={{ width: 120 }} value={doc.adjustment_label} onChange={(e) => set('adjustment_label', e.target.value)} />
                <NumberInput style={{ width: 110 }} value={doc.adjustment} onChange={(v) => set('adjustment', v)} />
              </div>
            )}
            <div className="t-row t-total"><span>Total ({doc.currency})</span><span>{money(calc.total, doc.currency)}</span></div>
            {doc.currency !== baseCur && <div className="t-row small muted"><span>In {baseCur}</span><span>{money(calc.total * (Number(doc.exchange_rate) || 1))}</span></div>}
          </div>
        </div>
      </div>

      <div className="form-foot">
        {(!id || doc.status === 'draft') && !ui.profile && <Button loading={saving === 'draft'} onClick={() => save('draft')}>Save as Draft</Button>}
        {(!id || doc.status === 'draft') && !ui.profile && sendLabel && <Button variant="primary" loading={saving === 'send'} onClick={() => save(type === 'invoice' || type === 'quote' || type === 'retainer' ? 'send' : 'open')}>{sendLabel}</Button>}
        {type === 'salesreceipt' && !id && <Button variant="primary" loading={saving === 'save'} onClick={() => save('draft')}>Save</Button>}
        {(isLiveEdit || ui.profile) && <Button variant="primary" loading={saving === 'save'} onClick={() => save('draft')}>Save</Button>}
        <Button onClick={() => nav(-1)}>Cancel</Button>
        {isLiveEdit && <span className="muted small" style={{ alignSelf: 'center' }}>This {ui.label.toLowerCase()} is {doc.display_status}; saving re-posts its accounting entries.</span>}
        {id && <Link className="muted small" style={{ marginLeft: 'auto', alignSelf: 'center' }} to={docUrl(type, id)}>Back to {ui.label}</Link>}
      </div>
      {newContact !== null && <QuickContactModal type={ui.contact} initial={newContact} onClose={() => setNewContact(null)} onCreated={(c) => { setContacts((cs) => [...cs, c]); set('contact_id', c.id); setNewContact(null); }} />}
    </div>
  );
}
