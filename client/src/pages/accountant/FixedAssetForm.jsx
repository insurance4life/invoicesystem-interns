import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, NumberInput, Select, Textarea, AccountSelect, Spinner } from '../../components/ui.jsx';
import { today } from '../../lib/format.js';
import { classOf, errText } from './common.js';

const FIN = ['purchase_date', 'purchase_value', 'salvage_value', 'useful_life_months', 'method', 'dep_rate', 'depreciation_start', 'asset_account_id', 'expense_account_id', 'accumulated_account_id'];
const blank = () => ({
  name: '', asset_number: '', asset_account_id: '', expense_account_id: '', accumulated_account_id: '', purchase_date: today(),
  purchase_value: '', salvage_value: 0, useful_life_months: 60, method: 'straight_line', dep_rate: '', depreciation_start: '', notes: '',
});

export default function FixedAssetForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { toast, meta } = useApp();
  const [f, setF] = useState(blank);
  const [status, setStatus] = useState('draft');
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!id) return;
    api.get(`/fixed-assets/${id}`).then((a) => {
      setStatus(a.status);
      setF({ ...blank(), ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v ?? ''])) });
    }).catch((e) => toast(errText(e), 'error')).finally(() => setLoading(false));
  }, [id, toast]);

  const locked = !!id && status !== 'draft';
  const isDecl = f.method === 'declining_balance';
  const accountsOf = (cls) => (a) => a.is_active && classOf(a.type) === cls;

  const save = async () => {
    if (!f.name.trim()) return toast('Asset name is required', 'error');
    if (!f.asset_account_id) return toast('Choose the fixed asset account', 'error');
    if (!f.purchase_date) return toast('Purchase date is required', 'error');
    const body = {
      name: f.name.trim(), asset_number: f.asset_number || null, asset_account_id: Number(f.asset_account_id),
      expense_account_id: f.expense_account_id ? Number(f.expense_account_id) : null,
      accumulated_account_id: f.accumulated_account_id ? Number(f.accumulated_account_id) : null,
      purchase_date: f.purchase_date, purchase_value: Number(f.purchase_value) || 0, salvage_value: Number(f.salvage_value) || 0,
      method: f.method, depreciation_start: f.depreciation_start || null, notes: f.notes || null,
      useful_life_months: Number(f.useful_life_months) || null,
      dep_rate: isDecl ? Number(f.dep_rate) || 0 : 0,
    };
    setSaving(true);
    try {
      const a = id ? await api.put(`/fixed-assets/${id}`, body) : await api.post('/fixed-assets', body);
      toast(id ? 'Asset updated' : 'Asset created');
      nav(`/accountant/fixed-assets/${a.id}`);
    } catch (e) { toast(errText(e), 'error'); }
    setSaving(false);
  };

  if (loading || !meta) return <Spinner />;

  return (
    <div className="page">
      <PageHeader title={id ? 'Edit Fixed Asset' : 'New Fixed Asset'}
        subtitle={locked ? 'This asset is active. Its value and depreciation settings are fixed; you can still change its name and notes.' : 'Depreciation starts from the depreciation start date.'} />

      <div className="form-section">
        <h3 className="mb">Asset Details</h3>
        <div className="grid3">
          <Field label="Name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Asset number"><Input value={f.asset_number} onChange={(e) => set('asset_number', e.target.value)} /></Field>
          <Field label="Fixed asset account" required>
            <AccountSelect value={f.asset_account_id} disabled={locked} filter={(a) => a.is_active && a.type === 'fixed_asset'} onChange={(v) => set('asset_account_id', v)} />
          </Field>
          <Field label="Purchase date" required><Input type="date" disabled={locked} value={f.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
          <Field label="Purchase value" required><NumberInput disabled={locked} value={f.purchase_value} onChange={(v) => set('purchase_value', v)} /></Field>
          <Field label="Salvage value" hint="Value left at the end of its life. Depreciation stops here."><NumberInput disabled={locked} value={f.salvage_value} onChange={(v) => set('salvage_value', v)} /></Field>
        </div>
      </div>

      <div className="form-section">
        <h3 className="mb">Depreciation</h3>
        <div className="grid3">
          <Field label="Method">
            <Select disabled={locked} value={f.method} onChange={(e) => set('method', e.target.value)}
              options={[['straight_line', 'Straight line'], ['declining_balance', 'Declining balance']]} />
          </Field>
          <Field label="Useful life (months)" hint={isDecl ? 'Length of the schedule. Optional for declining balance (default 120).' : undefined}>
            <NumberInput disabled={locked} value={f.useful_life_months} onChange={(v) => set('useful_life_months', v)} />
          </Field>
          {isDecl && (
            <Field label="Depreciation rate (% per year)"><NumberInput disabled={locked} value={f.dep_rate} onChange={(v) => set('dep_rate', v)} /></Field>
          )}
          <Field label="Depreciation start" hint="Defaults to the purchase date. Each month from this date gets an entry."><Input type="date" disabled={locked} value={f.depreciation_start} onChange={(e) => set('depreciation_start', e.target.value)} /></Field>
          <Field label="Depreciation expense account" hint="Defaults to Depreciation Expense.">
            <AccountSelect disabled={locked} value={f.expense_account_id} placeholder="Depreciation Expense" filter={accountsOf('expense')} onChange={(v) => set('expense_account_id', v)} />
          </Field>
          <Field label="Accumulated depreciation account" hint="Defaults to Accumulated Depreciation.">
            <AccountSelect disabled={locked} value={f.accumulated_account_id} placeholder="Accumulated Depreciation" filter={(a) => a.is_active && a.type === 'fixed_asset'} onChange={(v) => set('accumulated_account_id', v)} />
          </Field>
        </div>
        <Field label="Notes" className="mt"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>

      <div className="form-foot">
        <Button variant="primary" loading={saving} onClick={save}>{id ? 'Save Asset' : 'Save as Draft'}</Button>
        <Link className="btn btn-secondary" to={id ? `/accountant/fixed-assets/${id}` : '/accountant/fixed-assets'}>Cancel</Link>
        {!id && <span className="muted small" style={{ alignSelf: 'center' }}>Activate the asset afterwards to post its purchase to the ledger.</span>}
      </div>
    </div>
  );
}
