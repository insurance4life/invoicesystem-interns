import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Card, Badge, Empty, Spinner, KeyValue, Stat, Modal, Field, Input, NumberInput, AccountSelect, Table } from '../../components/ui.jsx';
import { today } from '../../lib/format.js';
import { errText } from './common.js';
import { ASSET_STATUS, METHOD_LABEL } from './FixedAssets.jsx';

export default function FixedAssetView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { money, date, can, toast } = useApp();
  const { data, loading, error, reload } = useFetch(`/fixed-assets/${id}/schedule`);
  const [modal, setModal] = useState(null); // 'activate' | 'depreciate' | 'dispose'
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));

  if (loading && !data) return <Spinner />;
  if (error || !data) return <div className="page"><Empty title="Fixed asset not found" text={error?.message} action={<Link to="/accountant/fixed-assets">Back to fixed assets</Link>} /></div>;

  const a = data.asset;
  const sched = data.schedule;
  const nextUnposted = sched.find((r) => !r.posted);

  const open = (kind) => {
    setForm(kind === 'depreciate' ? { upto: today() } : kind === 'dispose' ? { date: today(), amount: '', account_id: '' } : { paid_through_id: '' });
    setModal(kind);
  };
  const run = async (fn, msg) => {
    setBusy(true);
    try { const r = await fn(); toast(msg(r)); setModal(null); reload(); }
    catch (e) { toast(errText(e), 'error'); }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${a.name}"? Its purchase and depreciation entries will be removed from the ledger.`)) return;
    try { await api.del(`/fixed-assets/${a.id}`); toast('Asset deleted'); nav('/accountant/fixed-assets'); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const bankish = (acc) => acc.is_active && ['cash', 'bank', 'credit_card', 'payment_clearing'].includes(acc.type);
  const schedColumns = [
    { key: 'period_no', label: '#' },
    { key: 'period_end', label: 'Period end', render: (r) => date(r.period_end) },
    { key: 'amount', label: 'Depreciation', align: 'right', render: (r) => money(r.amount) },
    { key: 'accumulated', label: 'Accumulated', align: 'right', render: (r) => money(r.accumulated) },
    { key: 'book_value', label: 'Book value', align: 'right', render: (r) => money(r.book_value) },
    { key: 'posted', label: 'Status', render: (r) => (r.posted ? <Badge color="green">Posted</Badge> : <Badge color="gray">Scheduled</Badge>) },
  ];

  return (
    <div className="page">
      <PageHeader title={a.name} subtitle={`${a.asset_number ? `${a.asset_number} · ` : ''}${METHOD_LABEL[a.method] || a.method}`}
        actions={<>
          {a.status === 'draft' && can('accountant', 'edit') && <Button variant="primary" onClick={() => open('activate')}>Activate</Button>}
          {a.status === 'active' && can('accountant', 'edit') && <Button onClick={() => open('depreciate')}>Run Depreciation</Button>}
          {a.status === 'active' && can('accountant', 'edit') && <Button onClick={() => open('dispose')}>Dispose</Button>}
          {a.status !== 'disposed' && can('accountant', 'edit') && <Link className="btn btn-secondary" to={`/accountant/fixed-assets/${a.id}/edit`}>Edit</Link>}
          {can('accountant', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
        </>}>
        <Badge color={ASSET_STATUS[a.status] || 'gray'}>{a.status}</Badge>
        <div><Link to="/accountant/fixed-assets" className="small muted">← All fixed assets</Link></div>
      </PageHeader>

      <div className="grid3">
        <Stat label="Cost" value={money(a.purchase_value)} />
        <Stat label="Accumulated depreciation" value={money(a.accumulated)} />
        <Stat label="Book value" value={money(a.book_value)} sub={`Salvage ${money(a.salvage_value)}`} tone="green" />
      </div>

      <div className="grid2 mt">
        <Card title="Details">
          <KeyValue items={[
            ['Asset account', a.asset_account_name],
            ['Depreciation expense', a.expense_account_name],
            ['Accumulated depreciation', a.accumulated_account_name],
            ['Purchase date', date(a.purchase_date)],
            ['Depreciation starts', date(a.depreciation_start)],
            ['Useful life', a.useful_life_months ? `${a.useful_life_months} months` : null],
            ['Rate', a.method === 'declining_balance' ? `${a.dep_rate}% per year` : null],
            ['Last depreciation', a.last_depreciation ? date(a.last_depreciation) : null],
            ['Disposed', a.disposed_date ? `${date(a.disposed_date)} for ${money(a.disposal_amount)}` : null],
            ['Notes', a.notes],
          ]} />
        </Card>
        <Card title="Depreciation Schedule" pad={false}>
          <Table columns={schedColumns} rows={sched} rowKey="period_no" empty="No schedule. Check the useful life." />
          {nextUnposted && a.status === 'active' && <div className="small muted" style={{ padding: 12 }}>Next entry: {date(nextUnposted.period_end)}</div>}
        </Card>
      </div>

      {modal === 'activate' && (
        <Modal title="Activate Asset" onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => run(() => api.post(`/fixed-assets/${a.id}/activate`, { paid_through_id: form.paid_through_id || null }), () => 'Asset activated')}>Activate</Button></>}>
          <p className="muted">Activating posts the purchase: Dr {a.asset_account_name} {money(a.purchase_value)} and Cr the account it was paid from. Depreciation can run after this.</p>
          <Field label="Paid from (optional)" hint="Leave blank to post against Opening Balance Offset.">
            <AccountSelect value={form.paid_through_id} placeholder="Opening Balance Offset" filter={bankish} onChange={(v) => set('paid_through_id', v)} />
          </Field>
        </Modal>
      )}

      {modal === 'depreciate' && (
        <Modal title="Run Depreciation" onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => run(() => api.post('/fixed-assets/depreciate', { upto: form.upto }), (r) => `${r.posted} depreciation ${r.posted === 1 ? 'entry' : 'entries'} posted`)}>Run</Button></>}>
          <p className="muted">Posts every monthly entry that ends on or before the date below, for all active assets. Entries already posted are skipped.</p>
          <Field label="Depreciate up to"><Input type="date" value={form.upto || ''} onChange={(e) => set('upto', e.target.value)} /></Field>
        </Modal>
      )}

      {modal === 'dispose' && (
        <Modal title="Dispose Asset" onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => run(() => api.post(`/fixed-assets/${a.id}/dispose`, { date: form.date, amount: Number(form.amount) || 0, account_id: form.account_id || null }), () => 'Asset disposed')}>Dispose</Button></>}>
          <p className="muted">Removes the asset at cost and its accumulated depreciation. The difference between the sale amount and the book value is posted as a gain or loss.</p>
          <div className="grid2">
            <Field label="Disposal date" required><Input type="date" value={form.date || ''} onChange={(e) => set('date', e.target.value)} /></Field>
            <Field label="Sale amount"><NumberInput value={form.amount} onChange={(v) => set('amount', v)} /></Field>
          </div>
          <Field label="Received into" hint="Required when the sale amount is above zero."><AccountSelect value={form.account_id} filter={bankish} onChange={(v) => set('account_id', v)} /></Field>
          <KeyValue items={[['Book value now', money(a.book_value)]]} />
        </Modal>
      )}
    </div>
  );
}
