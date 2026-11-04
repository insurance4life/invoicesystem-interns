import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import {
  AccountSelect, Button, Card, Checkbox, Combo, Field, Input, NumberInput, Select, Tabs, Textarea, TaxSelect, errorMessage,
} from '../../components/ui.jsx';
import { INDIAN_STATES, round2 } from '@shared/calc.js';
import { today } from '../../lib/format.js';
import Attachments from '../../components/Attachments.jsx';

const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'other_expense', 'fixed_asset', 'other_current_asset'];
const PAID_TYPES = ['cash', 'bank', 'credit_card', 'other_current_liability', 'equity'];
const FREQUENCIES = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const MODES = [{ key: 'simple', label: 'Simple' }, { key: 'itemized', label: 'Itemized' }, { key: 'mileage', label: 'Mileage' }];

const blank = (currency, search) => ({
  date: today(), account_id: '', amount: '', tax_id: '', tax_inclusive: true, currency, paid_through_id: '', vendor_id: '',
  reference: '', notes: '', place_of_supply: '', hsn_sac: '', is_billable: false,
  customer_id: search.get('customer_id') || '', markup_percent: 0, project_id: search.get('project_id') || '',
  splits: [], distance: '', mileage_rate: '',
  recurrence: { frequency: 'monthly', every: 1, start_date: today(), end_date: '' },
});

function fromExpense(e) {
  return {
    date: e.date, account_id: e.account_id || '', amount: e.amount ?? '', tax_id: e.tax_id || '', tax_inclusive: !!e.tax_inclusive,
    currency: e.currency, paid_through_id: e.paid_through_id || '', vendor_id: e.vendor_id || '', reference: e.reference || '',
    notes: e.notes || '', place_of_supply: e.place_of_supply || '', hsn_sac: e.hsn_sac || '', is_billable: !!e.is_billable,
    customer_id: e.customer_id || '', markup_percent: e.markup_percent || 0, project_id: e.project_id || '',
    splits: (e.splits || []).map((s) => ({ account_id: s.account_id || '', amount: s.amount ?? '', tax_id: s.tax_id || '', description: s.description || '' })),
    distance: e.distance ?? '', mileage_rate: e.mileage_rate ?? '',
    recurrence: { frequency: 'monthly', every: 1, start_date: e.date, end_date: '' },
  };
}

/**
 * New / edit expense. `profile` creates a recurring expense profile instead.
 * Customer and project can be pre-filled with ?customer_id= and ?project_id= in the URL.
 */
export default function ExpenseForm({ profile = false }) {
  const { id } = useParams();
  const isEdit = !!id && !profile;
  const [search] = useSearchParams();
  const nav = useNavigate();
  const { meta, toast, sysAccount, can } = useApp();
  const existing = useFetch(isEdit ? `/expenses/${id}` : null);
  const vendors = useFetch('/contacts', { type: 'vendor', per_page: 500 });
  const customers = useFetch('/contacts', { type: 'customer', per_page: 500 });
  const projects = useFetch('/projects', { status: 'active' });
  const baseCurrency = meta?.org?.currency || 'INR';
  const [f, setF] = useState(() => (isEdit ? null : blank(baseCurrency, search)));
  const [mode, setMode] = useState('simple');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (isEdit && existing.data && !f) {
      setF(fromExpense(existing.data));
      setMode(existing.data.is_mileage ? 'mileage' : existing.data.splits?.length ? 'itemized' : 'simple');
    }
  }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountName = (accountId) => meta?.accounts?.find((a) => a.id === Number(accountId))?.name;
  const splitTotal = useMemo(() => round2((f?.splits || []).reduce((s, x) => s + (Number(x.amount) || 0), 0)), [f?.splits]);
  const mileageAmount = round2((Number(f?.distance) || 0) * (Number(f?.mileage_rate) || 0));
  const total = mode === 'itemized' ? splitTotal : mode === 'mileage' ? mileageAmount : round2(Number(f?.amount) || 0);

  if (!f) return <div className="center pad"><span className="spin" /></div>;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const canEdit = profile ? can('purchases', 'create') : can('purchases', 'edit') || !isEdit;

  const switchMode = (m) => {
    setMode(m);
    if (m === 'mileage' && !f.account_id) set('account_id', sysAccount('mileage')?.id || '');
    if (m === 'itemized' && !f.splits.length) setF((x) => ({ ...x, splits: [{ account_id: x.account_id || '', amount: x.amount || '', tax_id: x.tax_id || '', description: '' }] }));
  };
  const setSplit = (i, k, v) => setF((x) => ({ ...x, splits: x.splits.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const addSplit = () => setF((x) => ({ ...x, splits: [...x.splits, { account_id: '', amount: '', tax_id: '', description: '' }] }));
  const removeSplit = (i) => setF((x) => ({ ...x, splits: x.splits.filter((_, j) => j !== i) }));

  const rateFor = (code) => (code === baseCurrency ? 1 : (meta?.currencies?.find((c) => c.code === code)?.exchange_rate || 1));

  const save = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!f.date) errs.date = 'Choose a date';
    if (mode === 'itemized') {
      if (!f.splits.length) errs.splits = 'Add at least one line';
      if (f.splits.some((s) => !s.account_id || !(Number(s.amount) > 0))) errs.splits = 'Every line needs an account and an amount';
    } else if (!f.account_id) errs.account_id = 'Choose an expense account';
    if (mode === 'mileage' && !(Number(f.distance) > 0)) errs.distance = 'Enter the distance travelled';
    if (!f.paid_through_id) errs.paid_through_id = 'Choose the account it was paid from';
    if (!(total > 0)) errs.total = 'The amount must be greater than zero';
    if (f.is_billable && !f.customer_id) errs.customer_id = 'Choose the customer to bill';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const body = {
      date: f.date,
      paid_through_id: Number(f.paid_through_id),
      vendor_id: f.vendor_id || null,
      tax_id: mode === 'itemized' ? null : f.tax_id || null,
      tax_inclusive: f.tax_inclusive ? 1 : 0,
      currency: f.currency,
      exchange_rate: rateFor(f.currency),
      reference: f.reference || null,
      notes: f.notes || null,
      place_of_supply: f.place_of_supply || null,
      hsn_sac: f.hsn_sac || null,
      is_billable: f.is_billable ? 1 : 0,
      customer_id: f.is_billable ? f.customer_id || null : null,
      markup_percent: f.is_billable ? Number(f.markup_percent) || 0 : 0,
      project_id: f.project_id || null,
      is_mileage: mode === 'mileage' ? 1 : 0,
      amount: total,
    };
    if (mode === 'itemized') {
      body.account_id = null;
      body.splits = f.splits.map((s) => ({ account_id: Number(s.account_id), amount: round2(s.amount), tax_id: s.tax_id || null, description: s.description || null }));
    } else {
      body.account_id = Number(f.account_id);
      body.splits = null;
    }
    if (mode === 'mileage') {
      body.distance = Number(f.distance) || 0;
      body.mileage_rate = Number(f.mileage_rate) || 0;
    }
    if (profile) {
      body.is_profile = 1;
      body.recurrence = {
        frequency: f.recurrence.frequency, every: Number(f.recurrence.every) || 1,
        start_date: f.recurrence.start_date || f.date, end_date: f.recurrence.end_date || null,
      };
    }

    setBusy(true);
    try {
      const saved = isEdit ? await api.put(`/expenses/${id}`, body) : await api.post('/expenses', body);
      toast(profile ? 'Recurring expense created' : isEdit ? 'Expense updated' : 'Expense recorded');
      nav(profile ? '/recurring-expenses' : `/expenses/${saved.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    setBusy(false);
  };

  const vendorOptions = (vendors.data || []).map((v) => ({ value: v.id, label: v.display_name, sub: v.email }));
  const customerOptions = (customers.data || []).map((c) => ({ value: c.id, label: c.display_name, sub: c.email }));
  const projectOptions = (projects.data || []).map((p) => ({ value: p.id, label: p.name, sub: p.customer_name }));
  const currencies = (meta?.currencies || []).map((c) => [c.code, `${c.code}${c.symbol ? ` (${c.symbol})` : ''}`]);

  const accountField = (label, filter, value, onChange, error) => (
    <Field label={label} required error={error}>
      <AccountSelect value={value} onChange={onChange} filter={filter} placeholder="Select an account" />
    </Field>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div className="page-title"><h1>{profile ? 'New Recurring Expense' : isEdit ? 'Edit Expense' : 'New Expense'}</h1></div>
          <div className="page-actions">
            <Link className="btn btn-secondary" to={profile ? '/recurring-expenses' : isEdit ? `/expenses/${id}` : '/expenses'}>Back</Link>
          </div>
        </div>
      </div>

      <form onSubmit={save} noValidate>
        <div className="form-section">
          <div className="row between" style={{ marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>Expense details</h3>
            <Tabs tabs={MODES} active={mode} onChange={switchMode} />
          </div>

          <div className="form-grid">
            <Field label="Date" required error={errors.date}>
              <Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Paid through" required error={errors.paid_through_id} hint="Bank, cash or card that paid for it">
              <AccountSelect value={f.paid_through_id} onChange={(v) => set('paid_through_id', v)} filter={PAID_TYPES} placeholder="Select an account" />
            </Field>

            {mode === 'simple' && accountField('Expense account', EXPENSE_TYPES, f.account_id, (v) => set('account_id', v), errors.account_id)}
            {mode === 'mileage' && accountField('Expense account', EXPENSE_TYPES, f.account_id, (v) => set('account_id', v), errors.account_id)}

            {mode === 'simple' && (
              <Field label="Amount" required error={errors.total} hint={f.tax_id ? (f.tax_inclusive ? 'Tax is included in this amount' : 'Tax is added on top') : null}>
                <NumberInput min="0" step="0.01" value={f.amount} onChange={(v) => set('amount', v)} />
              </Field>
            )}
            {mode === 'mileage' && (
              <>
                <Field label="Distance" required error={errors.distance}><NumberInput min="0" step="0.1" value={f.distance} onChange={(v) => set('distance', v)} /></Field>
                <Field label="Rate per unit" hint="Amount = distance × rate"><NumberInput min="0" step="0.01" value={f.mileage_rate} onChange={(v) => set('mileage_rate', v)} /></Field>
              </>
            )}

            {mode !== 'itemized' && (
              <Field label="Tax">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <div className="grow"><TaxSelect value={f.tax_id} onChange={(v) => set('tax_id', v)} placeholder="No tax" /></div>
                  <Select value={f.tax_inclusive ? 'incl' : 'excl'} onChange={(e) => set('tax_inclusive', e.target.value === 'incl')}
                    options={[['incl', 'Tax inclusive'], ['excl', 'Tax exclusive']]} style={{ width: 150 }} />
                </div>
              </Field>
            )}

            <Field label="Currency">
              <Select value={f.currency} onChange={(e) => set('currency', e.target.value)} options={currencies.length ? currencies : [[baseCurrency, baseCurrency]]} />
            </Field>
            <Field label="Vendor" hint="Who you paid">
              <Combo value={f.vendor_id} onChange={(v) => set('vendor_id', v)} options={vendorOptions} placeholder="Select a vendor" />
            </Field>
            <Field label="Reference #" hint="Bill, receipt or transaction number">
              <Input value={f.reference} onChange={(e) => set('reference', e.target.value)} />
            </Field>
            <Field label="Place of supply" hint="For GST on the expense">
              <Select value={f.place_of_supply} onChange={(e) => set('place_of_supply', e.target.value)} placeholder="Same as organization" options={INDIAN_STATES} />
            </Field>
            <Field label="HSN / SAC">
              <Input value={f.hsn_sac} onChange={(e) => set('hsn_sac', e.target.value)} />
            </Field>
            <Field label="Notes" className="full">
              <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </div>

        {mode === 'itemized' && (
          <div className="form-section">
            <div className="row between" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Lines</h3>
              <Button size="sm" onClick={addSplit}>+ Add line</Button>
            </div>
            {errors.splits && <div className="field-error" style={{ marginBottom: 8 }}>{errors.splits}</div>}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th style={{ width: '30%' }}>Account</th><th>Description</th><th style={{ width: 180 }}>Tax</th><th className="r" style={{ width: 150 }}>Amount</th><th style={{ width: 60 }} /></tr>
                </thead>
                <tbody>
                  {f.splits.map((s, i) => (
                    <tr key={i}>
                      <td><AccountSelect value={s.account_id} onChange={(v) => setSplit(i, 'account_id', v)} filter={EXPENSE_TYPES} placeholder="Account" /></td>
                      <td><Input value={s.description} onChange={(e) => setSplit(i, 'description', e.target.value)} /></td>
                      <td><TaxSelect value={s.tax_id} onChange={(v) => setSplit(i, 'tax_id', v)} placeholder="No tax" /></td>
                      <td className="r"><NumberInput min="0" step="0.01" value={s.amount} onChange={(v) => setSplit(i, 'amount', v)} /></td>
                      <td><Button variant="link" className="btn-danger" onClick={() => removeSplit(i)} disabled={f.splits.length === 1}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3} className="r">Total</td><td className="r">{total.toFixed(2)}</td><td /></tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        <div className="form-section">
          <h3>Billing and project</h3>
          <div className="form-grid">
            <Field label="Project" hint="Costs roll up to this project's profitability">
              <Combo value={f.project_id} onChange={(v) => set('project_id', v)} options={projectOptions} placeholder="No project" />
            </Field>
            <div className="stack">
              <Checkbox label="Billable to a customer" checked={f.is_billable} onChange={(v) => set('is_billable', v)} />
              {f.is_billable && (
                <>
                  <Field label="Customer" required error={errors.customer_id}>
                    <Combo value={f.customer_id} onChange={(v) => set('customer_id', v)} options={customerOptions} placeholder="Select a customer" />
                  </Field>
                  <Field label="Markup %" hint={`The customer is charged ${round2(total * (1 + (Number(f.markup_percent) || 0) / 100)).toFixed(2)}`}>
                    <NumberInput min="0" step="0.5" value={f.markup_percent} onChange={(v) => set('markup_percent', v)} />
                  </Field>
                </>
              )}
            </div>
          </div>
        </div>

        {profile && (
          <div className="form-section">
            <h3>Recurrence</h3>
            <p className="muted small" style={{ marginTop: 0 }}>A new expense is recorded on each occurrence, using the details above.</p>
            <div className="form-grid">
              <Field label="Repeat">
                <Select value={f.recurrence.frequency} onChange={(e) => set('recurrence', { ...f.recurrence, frequency: e.target.value })} options={FREQUENCIES} />
              </Field>
              <Field label="Every">
                <NumberInput min="1" value={f.recurrence.every} onChange={(v) => set('recurrence', { ...f.recurrence, every: v })} />
              </Field>
              <Field label="Start date">
                <Input type="date" value={f.recurrence.start_date} onChange={(e) => set('recurrence', { ...f.recurrence, start_date: e.target.value })} />
              </Field>
              <Field label="End date" hint="Optional">
                <Input type="date" value={f.recurrence.end_date} onChange={(e) => set('recurrence', { ...f.recurrence, end_date: e.target.value })} />
              </Field>
            </div>
          </div>
        )}

        {!profile && (
          <Card title="Receipts" className="mb">
            <div className="card-body" style={{ paddingTop: 0 }}>
              <Attachments entityType="expense" entityId={isEdit ? Number(id) : null} />
            </div>
          </Card>
        )}

        <div className="form-foot">
          <Button variant="primary" type="submit" loading={busy} disabled={!canEdit}>
            {profile ? 'Create profile' : isEdit ? 'Save changes' : 'Record expense'}
          </Button>
          <Button onClick={() => nav(profile ? '/recurring-expenses' : isEdit ? `/expenses/${id}` : '/expenses')}>Cancel</Button>
          <span className="grow" />
          <span className="muted small" style={{ alignSelf: 'center' }}>Total <b>{total.toFixed(2)}</b></span>
        </div>
      </form>
    </div>
  );
}
