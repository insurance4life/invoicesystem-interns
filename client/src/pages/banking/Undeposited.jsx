import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Field, Input, AccountSelect } from '../../components/ui.jsx';
import { SrcLink } from './common.jsx';
import { today } from '../../lib/format.js';

export default function Undeposited() {
  const { money, date, toast, can, sysAccount } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch('/banking/undeposited');
  const [sel, setSel] = useState([]);
  const [f, setF] = useState({ account_id: '', date: today(), reference: '' });
  const [busy, setBusy] = useState(false);
  const rows = data || [];
  const total = rows.filter((r) => sel.includes(r.id)).reduce((s, r) => s + r.deposit_amount, 0);
  const ud = sysAccount('undeposited_funds')?.id;

  const deposit = async () => {
    if (!f.account_id) return toast('Choose the bank account to deposit into', 'error');
    setBusy(true);
    try {
      const t = await api.post('/banking/deposits', { ...f, payment_ids: sel });
      toast(`Deposited ${money(t.amount)}`);
      setSel([]);
      reload();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <PageHeader title="Deposit Undeposited Funds" back={<Button variant="link" onClick={() => nav('/banking')}>←</Button>}
        subtitle="Customer payments recorded to Undeposited Funds that have not been deposited to a bank account yet." />
      {can('banking', 'create') && (
        <div className="form-section">
          <div className="row">
            <Field label="Deposit To" required><div style={{ width: 280 }}><AccountSelect value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} filter={(a) => ['bank', 'cash', 'payment_clearing'].includes(a.type) && a.id !== ud} /></div></Field>
            <Field label="Date" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Reference#"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
            <div className="grow r">
              <div className="muted small">{sel.length} selected</div>
              <div className="bk-big">{money(total)}</div>
            </div>
            <Button variant="primary" loading={busy} disabled={!sel.length} onClick={deposit}>Deposit</Button>
          </div>
        </div>
      )}
      <Table rows={rows} loading={loading && !data} selectable={can('banking', 'create')} selected={sel} onSelect={setSel}
        empty="There are no undeposited payments."
        columns={[
          { key: 'date', label: 'Date', render: (r) => date(r.date) },
          { key: 'number', label: 'Payment#', render: (r) => <SrcLink type="payment_received" id={r.id}>{r.number}</SrcLink> },
          { key: 'contact_name', label: 'Customer' },
          { key: 'mode', label: 'Mode' },
          { key: 'reference', label: 'Reference#' },
          { key: 'deposit_amount', label: 'Amount', align: 'right', render: (r) => money(r.deposit_amount) },
        ]} />
    </div>
  );
}
