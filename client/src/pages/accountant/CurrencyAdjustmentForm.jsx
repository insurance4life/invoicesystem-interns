import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, NumberInput, Select, Table, Card, Money } from '../../components/ui.jsx';
import { today } from '../../lib/format.js';
import { errText } from './common.js';

export default function CurrencyAdjustmentForm() {
  const { meta, org, date, toast } = useApp();
  const nav = useNavigate();
  const foreign = useMemo(() => (meta?.currencies || []).filter((c) => !c.is_base), [meta]);
  const [currency, setCurrency] = useState(foreign[0]?.code || '');
  const [asOf, setAsOf] = useState(today());
  const [rate, setRate] = useState(() => foreign[0]?.exchange_rate || '');
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);

  const cur = foreign.find((c) => c.code === currency);
  const inputsKey = `${currency}|${asOf}|${rate}`;
  const fresh = preview && preview.key === inputsKey;

  const pick = (code) => {
    setCurrency(code);
    const c = foreign.find((x) => x.code === code);
    setRate(c?.exchange_rate || '');
    setPreview(null);
  };

  const runPreview = async () => {
    if (!currency || !asOf || !(Number(rate) > 0)) return toast('Choose a currency, date and rate', 'error');
    setBusy('preview');
    try {
      const r = await api.get('/currency-adjustments/preview', { date: asOf, currency, rate: Number(rate) });
      setPreview({ ...r, key: inputsKey });
    } catch (e) { toast(errText(e), 'error'); }
    setBusy(null);
  };

  const save = async () => {
    if (!fresh) return toast('Run the preview first so you can see what will be posted', 'error');
    setBusy('save');
    try {
      await api.post('/currency-adjustments', { date: asOf, currency, rate: Number(rate), notes: notes || null });
      toast('Currency adjustment posted');
      nav('/accountant/currency-adjustments');
    } catch (e) { toast(errText(e), 'error'); }
    setBusy(null);
  };

  const columns = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'number', label: 'Document', render: (r) => <span className="bold">{r.number}</span> },
    { key: 'type', label: 'Type', render: (r) => (r.doc_type === 'invoice' ? 'Receivable (invoice)' : 'Payable (bill)') },
    { key: 'contact_name', label: 'Contact' },
    { key: 'balance', label: `Balance (${currency})`, align: 'right', render: (r) => Number(r.balance).toFixed(2) },
    { key: 'basis_rate', label: 'Booked rate', align: 'right', render: (r) => Number(r.basis_rate).toFixed(4) },
    { key: 'adjustment', label: `Adjustment (${org?.currency || ''})`, align: 'right', render: (r) => <Money value={r.adjustment} /> },
    { key: 'gain_loss', label: 'Gain / (loss)', align: 'right', render: (r) => <Money value={r.gain_loss} /> },
  ];

  return (
    <div className="page">
      <PageHeader title="New Currency Adjustment"
        subtitle="Revalues open invoices (receivables) and bills (payables) in one currency. Each run only books the movement since the previous run." />

      <div className="form-section">
        <div className="grid4">
          <Field label="Currency" required>
            <Select placeholder={foreign.length ? undefined : 'No foreign currencies set up'} value={currency} onChange={(e) => pick(e.target.value)}
              options={foreign.map((c) => [c.code, `${c.code}${c.name ? ` – ${c.name}` : ''}`])} />
          </Field>
          <Field label="Date" required hint="Revaluation date (usually a period end)."><Input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setPreview(null); }} /></Field>
          <Field label={`New rate (${org?.currency || 'base'} per 1 ${currency || 'unit'})`} required hint={cur ? `Current rate in settings: ${cur.exchange_rate}` : undefined}>
            <NumberInput value={rate} onChange={(v) => { setRate(v); setPreview(null); }} />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Button loading={busy === 'preview'} onClick={runPreview}>Preview</Button>
          </div>
        </div>
        <Field label="Notes" className="mt"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. June 2026 month-end revaluation" /></Field>
      </div>

      {preview && (
        <Card title={`Affected documents (${preview.rows.length})`} pad={false} className="mt">
          {!preview.rows.length
            ? <div className="pad muted">No open {currency} invoices or bills are dated on or before {date(asOf)}.</div>
            : <Table columns={columns} rows={preview.rows} rowKey="id" footer={
                <tr className="total-row">
                  <td colSpan={7} className="r bold">Net gain / (loss) to post</td>
                  <td className="r bold"><Money value={preview.total_gain_loss} /></td>
                </tr>
              } />}
          {!fresh && <div className="pad small muted">Inputs changed since this preview. Run it again before saving.</div>}
        </Card>
      )}

      <div className="form-foot">
        <Button variant="primary" loading={busy === 'save'} disabled={!fresh || !preview?.rows?.length} onClick={save}>Post Adjustment</Button>
        <Link className="btn btn-secondary" to="/accountant/currency-adjustments">Cancel</Link>
      </div>
    </div>
  );
}
