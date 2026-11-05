import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, Textarea, NumberInput, Select, Checkbox, Tabs, Empty } from '../../components/ui.jsx';
import { INDIAN_STATES } from '@shared/calc.js';
import { today } from '../../lib/format.js';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GST_TREATMENTS = [
  ['registered', 'Registered Business - Regular'], ['unregistered', 'Unregistered Business'], ['consumer', 'Consumer'],
  ['overseas', 'Overseas'], ['sez', 'Special Economic Zone (SEZ)'], ['composition', 'Composition Scheme'],
];
const STATE_OPTIONS = INDIAN_STATES.map(([code, name]) => [code, `[${code}] ${name}`]);
const STATE_NAMES = INDIAN_STATES.map(([, name]) => [name, name]);
const SALUTATIONS = ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'];

const blankAddress = () => ({ attention: '', street: '', city: '', state: '', zip: '', country: 'India', phone: '' });
const blankPerson = () => ({ salutation: '', first_name: '', last_name: '', email: '', phone: '', designation: '' });
const addrOrNull = (a) => (Object.values(a || {}).some((v) => String(v || '').trim()) ? a : null);

/** Map a contact from the API to form state. */
function fromContact(c) {
  return {
    customer_type: c.customer_type || 'business', salutation: c.salutation || '', first_name: c.first_name || '', last_name: c.last_name || '',
    company_name: c.company_name || '', display_name: c.display_name || '', email: c.email || '', phone: c.phone || '', mobile: c.mobile || '',
    website: c.website || '', gst_treatment: c.gst_treatment || 'unregistered', gstin: c.gstin || '', place_of_supply: c.place_of_supply || '',
    pan: c.pan || '', currency: c.currency || '', payment_term_id: c.payment_term_id ?? '',
    hiddenOpening: !!c.id && !('opening_balance' in c), // AR/AP figures come back only to sales/purchases viewers
    opening_balance: c.opening_balance || '', opening_balance_date: c.opening_balance_date || today(),
    credit_limit: c.credit_limit ?? '', price_list_id: c.price_list_id ?? '', portal_enabled: !!c.portal_enabled,
    reminders_enabled: c.reminders_enabled == null ? true : !!c.reminders_enabled,
    billing: { ...blankAddress(), ...(c.billing_address || {}) }, shipping: { ...blankAddress(), ...(c.shipping_address || {}) },
    contact_persons: Array.isArray(c.contact_persons) ? c.contact_persons : [], custom_fields: c.custom_fields || {}, notes: c.notes || '',
  };
}

const blankForm = () => fromContact({ opening_balance_date: today(), reminders_enabled: true });

/** Display name suggestion from the name parts. */
function suggestName(x) {
  const person = [x.salutation, x.first_name, x.last_name].filter(Boolean).join(' ').trim();
  return x.customer_type === 'individual' ? (person || x.company_name) : (x.company_name || person);
}

export default function ContactForm({ type }) {
  const isCust = type === 'customer';
  const slug = isCust ? 'customers' : 'vendors';
  const label = isCust ? 'Customer' : 'Vendor';
  const { id } = useParams();
  const editing = !!id;
  const { meta, org, toast } = useApp();
  const nav = useNavigate();
  const existing = useFetch(editing ? `/contacts/${id}` : null, null, [id]);
  const priceLists = useFetch('/price-lists', { applies_to: isCust ? 'sales' : 'purchase' }, [type]);

  const [f, setF] = useState(blankForm);
  const [nameTouched, setNameTouched] = useState(editing);
  const [tab, setTab] = useState('other');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (existing.data) { setF(fromContact(existing.data)); setNameTouched(true); }
  }, [existing.data]);

  // auto-suggest the display name until the user edits it
  useEffect(() => {
    if (nameTouched) return;
    setF((s) => ({ ...s, display_name: suggestName(s) }));
  }, [f.salutation, f.first_name, f.last_name, f.company_name, f.customer_type, nameTouched]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setAddr = (which, k, v) => setF((s) => ({ ...s, [which]: { ...s[which], [k]: v } }));
  const setPerson = (i, k, v) => setF((s) => ({ ...s, contact_persons: s.contact_persons.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  const setCustom = (k, v) => setF((s) => ({ ...s, custom_fields: { ...s.custom_fields, [k]: v } }));

  const onGstin = (v) => setF((s) => {
    const g = v.toUpperCase().replace(/\s/g, '');
    return { ...s, gstin: g, place_of_supply: s.place_of_supply || (GSTIN_RE.test(g) ? g.slice(0, 2) : s.place_of_supply) };
  });

  const copyBilling = () => setF((s) => ({ ...s, shipping: { ...s.billing } }));

  const validate = () => {
    const e = {};
    if (!f.display_name.trim()) e.display_name = 'Display name is required';
    if (f.gstin && !GSTIN_RE.test(f.gstin)) e.gstin = 'GSTIN format is invalid (e.g. 27AAPFU0939F1ZV)';
    if (f.email && !EMAIL_RE.test(f.email)) e.email = 'Enter a valid email address';
    setErrors(e);
    if (Object.keys(e).length) {
      toast(Object.values(e)[0], 'error');
      return false;
    }
    return true;
  };

  const save = async () => {
    if (!validate()) return;
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const body = {
      type, customer_type: f.customer_type, salutation: f.salutation, first_name: f.first_name, last_name: f.last_name,
      company_name: f.company_name, display_name: f.display_name.trim(), email: f.email, phone: f.phone, mobile: f.mobile, website: f.website,
      currency: f.currency || null, payment_term_id: num(f.payment_term_id), gst_treatment: f.gst_treatment,
      gstin: f.gstin || null, pan: f.pan || null, place_of_supply: f.place_of_supply || null,
      billing_address: addrOrNull(f.billing), shipping_address: addrOrNull(f.shipping),
      contact_persons: f.contact_persons.filter((p) => p.first_name || p.last_name || p.email),
      notes: f.notes, credit_limit: isCust ? num(f.credit_limit) : null, price_list_id: num(f.price_list_id),
      portal_enabled: f.portal_enabled ? 1 : 0, reminders_enabled: f.reminders_enabled ? 1 : 0,
      ...(f.hiddenOpening ? {} : { opening_balance: Number(f.opening_balance) || 0, opening_balance_date: f.opening_balance_date }),
      custom_fields: f.custom_fields,
    };
    setSaving(true);
    try {
      const res = editing ? await api.put(`/contacts/${id}`, body) : await api.post('/contacts', body);
      toast(`${label} ${editing ? 'updated' : 'created'}`);
      nav(`/${slug}/${res.id}`);
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  };

  const customFields = (meta?.custom_fields || []).filter((c) => c.module === 'contact');
  const billingLabel = isCust ? 'Receivable' : 'Payable';

  const tabs = [
    { key: 'other', label: 'Other Details' },
    { key: 'address', label: 'Address' },
    { key: 'persons', label: 'Contact Persons', count: f.contact_persons.length || undefined },
    { key: 'custom', label: 'Custom Fields', count: customFields.length || undefined },
    { key: 'remarks', label: 'Remarks' },
  ];

  if (editing && existing.loading && !existing.data) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;

  return (
    <div className="page">
      <PageHeader title={editing ? `Edit ${label}` : `New ${label}`} />

      <div className="form-section">
        <div className="form-grid">
          <Field label={`${label} Type`} inline>
            <div className="row">
              {[['business', 'Business'], ['individual', 'Individual']].map(([v, l]) => (
                <label key={v} className="checkbox"><input type="radio" name="customer_type" checked={f.customer_type === v} onChange={() => set('customer_type', v)} /><span>{l}</span></label>
              ))}
            </div>
          </Field>
          <Field label="Name" inline>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Select value={f.salutation} onChange={(e) => set('salutation', e.target.value)} placeholder="—" options={SALUTATIONS.map((s) => [s, s])} style={{ width: 90 }} />
              <Input placeholder="First name" value={f.first_name} onChange={(e) => set('first_name', e.target.value)} />
              <Input placeholder="Last name" value={f.last_name} onChange={(e) => set('last_name', e.target.value)} />
            </div>
          </Field>
          <Field label="Company Name" inline>
            <Input value={f.company_name} onChange={(e) => set('company_name', e.target.value)} />
          </Field>
          <Field label="Display Name" required inline error={errors.display_name}
            hint={nameTouched ? undefined : 'Suggested from the name above. Edit to change it.'}>
            <Input value={f.display_name} onChange={(e) => { setNameTouched(true); set('display_name', e.target.value); }} />
          </Field>
          <Field label="Email" inline error={errors.email}><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Phone" inline><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Mobile" inline><Input value={f.mobile} onChange={(e) => set('mobile', e.target.value)} /></Field>
          <Field label="Website" inline><Input value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" /></Field>
        </div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'other' && (
        <div className="form-section">
          <div className="form-grid">
            <Field label="GST Treatment" inline>
              <Select value={f.gst_treatment} onChange={(e) => set('gst_treatment', e.target.value)} options={GST_TREATMENTS} />
            </Field>
            <Field label="GSTIN" inline error={errors.gstin} hint={f.gstin && !GSTIN_RE.test(f.gstin) ? undefined : 'Used to fill the place of supply'}>
              <Input value={f.gstin} onChange={(e) => onGstin(e.target.value)} maxLength={15} />
            </Field>
            <Field label="Place of Supply" inline>
              <Select value={f.place_of_supply} onChange={(e) => set('place_of_supply', e.target.value)} placeholder="Select a state" options={STATE_OPTIONS} />
            </Field>
            <Field label="PAN" inline>
              <Input value={f.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} maxLength={10} />
            </Field>
            <Field label="Currency" inline>
              <Select value={f.currency} onChange={(e) => set('currency', e.target.value)} placeholder={`Organization default (${org?.currency || 'INR'})`}
                options={(meta?.currencies || []).map((c) => [c.code, `${c.code}${c.name ? ` — ${c.name}` : ''}`])} />
            </Field>
            <Field label="Payment Terms" inline>
              <Select value={f.payment_term_id} onChange={(e) => set('payment_term_id', e.target.value)} placeholder="None"
                options={(meta?.payment_terms || []).map((t) => [t.id, t.name])} />
            </Field>
            <Field label={`Opening Balance (${billingLabel})`} inline>
              <NumberInput value={f.opening_balance} onChange={(v) => set('opening_balance', v)} />
            </Field>
            <Field label="Opening Balance Date" inline>
              <Input type="date" value={f.opening_balance_date} onChange={(e) => set('opening_balance_date', e.target.value)} />
            </Field>
            {isCust && (
              <Field label="Credit Limit" inline hint="Warn when an invoice would take the customer over this limit">
                <NumberInput value={f.credit_limit} onChange={(v) => set('credit_limit', v)} />
              </Field>
            )}
            <Field label={isCust ? 'Price List' : 'Purchase Price List'} inline>
              <Select value={f.price_list_id} onChange={(e) => set('price_list_id', e.target.value)} placeholder="None"
                options={(priceLists.data || []).map((p) => [p.id, p.name])} />
            </Field>
            <Field label="Customer portal" inline={false}>
              <Checkbox label={isCust ? 'Allow this customer to view invoices in the portal' : 'Allow portal access'} checked={f.portal_enabled} onChange={(v) => set('portal_enabled', v)} />
            </Field>
            <Field label="Reminders" inline={false}>
              <Checkbox label="Send payment reminders" checked={f.reminders_enabled} onChange={(v) => set('reminders_enabled', v)} />
            </Field>
          </div>
        </div>
      )}

      {tab === 'address' && (
        <div className="form-section">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Billing Address</h3>
            <Button size="sm" onClick={copyBilling}>Copy billing address to shipping</Button>
          </div>
          <div className="grid2">
            <AddressFields value={f.billing} onChange={(k, v) => setAddr('billing', k, v)} />
            <div>
              <h3 style={{ marginBottom: 12 }}>Shipping Address</h3>
              <AddressFields value={f.shipping} onChange={(k, v) => setAddr('shipping', k, v)} />
            </div>
          </div>
        </div>
      )}

      {tab === 'persons' && (
        <div className="form-section">
          {f.contact_persons.length === 0 && <Empty title="No contact persons" text="Add people you work with at this company." />}
          {f.contact_persons.length > 0 && (
            <div className="table-wrap">
              <table className="table lines-table">
                <thead><tr><th>Salutation</th><th>First Name</th><th>Last Name</th><th>Email</th><th>Phone</th><th>Designation</th><th /></tr></thead>
                <tbody>
                  {f.contact_persons.map((p, i) => (
                    <tr key={i}>
                      <td><Select value={p.salutation || ''} onChange={(e) => setPerson(i, 'salutation', e.target.value)} placeholder="—" options={SALUTATIONS.map((s) => [s, s])} /></td>
                      <td><Input value={p.first_name || ''} onChange={(e) => setPerson(i, 'first_name', e.target.value)} /></td>
                      <td><Input value={p.last_name || ''} onChange={(e) => setPerson(i, 'last_name', e.target.value)} /></td>
                      <td><Input type="email" value={p.email || ''} onChange={(e) => setPerson(i, 'email', e.target.value)} /></td>
                      <td><Input value={p.phone || ''} onChange={(e) => setPerson(i, 'phone', e.target.value)} /></td>
                      <td><Input value={p.designation || ''} onChange={(e) => setPerson(i, 'designation', e.target.value)} /></td>
                      <td><Button size="sm" variant="link" onClick={() => set('contact_persons', f.contact_persons.filter((_, j) => j !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt"><Button size="sm" onClick={() => set('contact_persons', [...f.contact_persons, blankPerson()])}>+ Add Contact Person</Button></div>
        </div>
      )}

      {tab === 'custom' && (
        <div className="form-section">
          {customFields.length === 0 && <Empty title="No custom fields" text="Add custom fields for contacts in Settings → Custom Fields." />}
          <div className="form-grid">
            {customFields.map((cf) => {
              const v = f.custom_fields[cf.field_key];
              const opts = (cf.options || []).map((o) => (typeof o === 'string' ? [o, o] : [o.value, o.label]));
              return (
                <Field key={cf.id} label={cf.label} inline required={!!cf.is_required}>
                  {cf.data_type === 'number' && <NumberInput value={v ?? ''} onChange={(x) => setCustom(cf.field_key, x)} />}
                  {cf.data_type === 'date' && <Input type="date" value={v || ''} onChange={(e) => setCustom(cf.field_key, e.target.value)} />}
                  {cf.data_type === 'dropdown' && <Select value={v || ''} placeholder="Select" options={opts} onChange={(e) => setCustom(cf.field_key, e.target.value)} />}
                  {cf.data_type === 'checkbox' && <Checkbox label="Yes" checked={!!v} onChange={(x) => setCustom(cf.field_key, x)} />}
                  {!['number', 'date', 'dropdown', 'checkbox'].includes(cf.data_type) && <Input value={v || ''} onChange={(e) => setCustom(cf.field_key, e.target.value)} />}
                </Field>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'remarks' && (
        <div className="form-section">
          <Field label="Remarks" hint="Internal notes about this contact. Not shown to the contact.">
            <Textarea rows={5} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>
      )}

      <div className="form-foot">
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={() => nav(editing ? `/${slug}/${id}` : `/${slug}`)}>Cancel</Button>
      </div>
    </div>
  );
}

function AddressFields({ value, onChange }) {
  const v = value || blankAddress();
  return (
    <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
      <Field label="Attention" inline><Input value={v.attention || ''} onChange={(e) => onChange('attention', e.target.value)} /></Field>
      <Field label="Street" inline><Textarea rows={2} value={v.street || ''} onChange={(e) => onChange('street', e.target.value)} /></Field>
      <Field label="City" inline><Input value={v.city || ''} onChange={(e) => onChange('city', e.target.value)} /></Field>
      <Field label="State" inline><Select value={v.state || ''} placeholder="Select a state" options={STATE_NAMES} onChange={(e) => onChange('state', e.target.value)} /></Field>
      <Field label="ZIP Code" inline><Input value={v.zip || ''} onChange={(e) => onChange('zip', e.target.value)} /></Field>
      <Field label="Country" inline><Input value={v.country || ''} onChange={(e) => onChange('country', e.target.value)} /></Field>
      <Field label="Phone" inline><Input value={v.phone || ''} onChange={(e) => onChange('phone', e.target.value)} /></Field>
    </div>
  );
}
