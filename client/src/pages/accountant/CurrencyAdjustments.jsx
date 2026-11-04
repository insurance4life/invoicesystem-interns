import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Empty, Money } from '../../components/ui.jsx';
import { errText } from './common.js';

export default function CurrencyAdjustments() {
  const { can, date, toast, meta } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch('/currency-adjustments');
  const rows = data || [];
  const name = (code) => meta?.currencies?.find((c) => c.code === code)?.name || code;

  const remove = async (r) => {
    if (!window.confirm(`Delete the ${r.currency} revaluation of ${date(r.date)}? Its ledger entry will be reversed.`)) return;
    try { await api.del(`/currency-adjustments/${r.id}`); toast('Revaluation deleted'); reload(); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const columns = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'currency', label: 'Currency', render: (r) => <span className="bold">{r.currency}</span> },
    { key: 'rate', label: 'New rate', align: 'right', render: (r) => Number(r.rate).toFixed(4) },
    { key: 'amount', label: 'Gain / (loss)', align: 'right', render: (r) => <Money value={r.amount} /> },
    { key: 'notes', label: 'Notes', render: (r) => <span className="muted">{r.notes || name(r.currency)}</span> },
    { key: 'actions', label: '', render: (r) => can('accountant', 'delete') && (
      <Button size="sm" variant="link" onClick={(e) => { e.stopPropagation(); remove(r); }}>Delete</Button>
    ) },
  ];

  return (
    <div className="page">
      <PageHeader title="Base Currency Adjustment"
        subtitle="Revalue open foreign-currency invoices and bills at a new exchange rate. The difference is posted to Exchange Gain or Loss."
        actions={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/currency-adjustments/new')}>+ New Adjustment</Button>} />
      {!loading && !rows.length
        ? <Empty title="No revaluations yet" text="Run one at each period end to bring foreign receivables and payables to the current rate." action={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/currency-adjustments/new')}>+ New Adjustment</Button>} />
        : <Table columns={columns} rows={rows} loading={loading} />}
    </div>
  );
}
