import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Badge, Button, Card, KeyValue, Menu, PageHeader, Table, errorMessage } from '../../components/ui.jsx';
import Attachments from '../../components/Attachments.jsx';
import { today, statusLabel } from '../../lib/format.js';

/** Ledger lines an expense creates: category accounts (net of tax), tax accounts, and the paid-through account. */
function LedgerEffect({ e, money, accountName }) {
  const tax = Number(e.tax_amount) || 0;
  const rows = e.splits?.length
    ? e.splits.map((s) => ({ account: accountName(s.account_id) || 'Category', dr: Number(s.amount) || 0 }))
    : [{ account: e.account_name || 'Expense', dr: Number(e.total) - tax }];
  return (
    <table className="table">
      <thead><tr><th>Account</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i}><td>{r.account}</td><td className="r">{money(r.dr, e.currency)}</td><td className="r" /></tr>)}
        {tax > 0 && <tr><td>Input tax</td><td className="r">{money(tax, e.currency)}</td><td className="r" /></tr>}
        <tr><td>{e.paid_through_name || 'Paid through'}</td><td className="r" /><td className="r">{money(e.total, e.currency)}</td></tr>
      </tbody>
    </table>
  );
}

export default function ExpenseView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, can, money, date, toast } = useApp();
  const e = useFetch(`/expenses/${id}`);
  const hist = useFetch(`/activity`, { entity_type: 'expense', entity_id: id, limit: 100 });
  const projects = useFetch('/projects', { status: 'all' });
  const x = e.data;

  if (e.error) return <div className="page"><div className="empty"><h3>{e.error.message}</h3><Link to="/expenses">Back to expenses</Link></div></div>;
  if (!x) return <div className="center pad"><span className="spin" /></div>;

  const accountName = (accountId) => meta?.accounts?.find((a) => a.id === Number(accountId))?.name;
  const projectName = projects.data?.find((p) => p.id === x.project_id)?.name;

  const remove = async () => {
    if (!window.confirm('Delete this expense? Its ledger entries are removed too.')) return;
    try { await api.del(`/expenses/${x.id}`); toast('Expense deleted'); nav('/expenses'); } catch (err) { toast(errorMessage(err), 'error'); }
  };
  const clone = async () => {
    const body = {
      date: today(), account_id: x.account_id, paid_through_id: x.paid_through_id, amount: x.amount, tax_id: x.tax_id,
      tax_inclusive: x.tax_inclusive, currency: x.currency, exchange_rate: x.exchange_rate, vendor_id: x.vendor_id,
      customer_id: x.customer_id, project_id: x.project_id, is_billable: x.is_billable, markup_percent: x.markup_percent,
      reference: x.reference, notes: x.notes, place_of_supply: x.place_of_supply, hsn_sac: x.hsn_sac,
      is_mileage: x.is_mileage, distance: x.distance, mileage_rate: x.mileage_rate, splits: x.splits?.length ? x.splits : null,
    };
    try {
      const c = await api.post('/expenses', body);
      toast('Expense copied');
      nav(`/expenses/${c.id}/edit`);
    } catch (err) { toast(errorMessage(err), 'error'); }
  };

  return (
    <div className="page">
      <PageHeader
        back={<Link to="/expenses" className="btn btn-link" aria-label="Back">←</Link>}
        title={x.reference ? `Expense ${x.reference}` : x.account_name || 'Expense'}
        subtitle={`${date(x.date)} · ${money(x.total, x.currency)}`}
        actions={(
          <>
            {can('purchases', 'edit') && <Link className="btn btn-secondary" to={`/expenses/${x.id}/edit`}>Edit</Link>}
            <Menu items={[
              can('purchases', 'create') ? { label: 'Clone', onClick: clone } : null,
              can('purchases', 'delete') && !x.invoice_id ? { label: 'Delete', danger: true, onClick: remove } : null,
            ]} />
          </>
        )}
      />

      {x.invoice_id && (
        <div className="callout">
          <span>This expense is billed to <b>{x.customer_name || 'a customer'}</b> on invoice <b>{x.invoice_number}</b>.</span>
          <Link className="btn btn-secondary btn-sm" to={`/invoices/${x.invoice_id}`}>View invoice</Link>
        </div>
      )}

      <div className="grid2" style={{ alignItems: 'start' }}>
        <Card title="Details" actions={<Badge status={x.status} />}>
          <KeyValue items={[
            ['Date', date(x.date)],
            ['Category', x.account_name || (x.splits?.length ? `${x.splits.length} lines` : null)],
            ['Paid through', x.paid_through_name],
            ['Vendor', x.vendor_name && <Link to={`/vendors/${x.vendor_id}`}>{x.vendor_name}</Link>],
            ['Reference', x.reference],
            ['Amount', money(x.amount, x.currency)],
            ['Tax', x.tax_amount ? `${money(x.tax_amount, x.currency)} (${x.tax_inclusive ? 'inclusive' : 'exclusive'})` : null],
            ['Total', <b>{money(x.total, x.currency)}</b>],
            x.is_mileage ? ['Mileage', `${x.distance} × ${x.mileage_rate}`] : null,
            ['Billable', x.is_billable ? `Yes · ${x.customer_name || ''} · markup ${x.markup_percent || 0}%` : 'No'],
            ['Project', projectName],
            ['Notes', x.notes],
          ]} />
          {x.splits?.length > 0 && (
            <table className="table mt" style={{ marginTop: 14 }}>
              <thead><tr><th>Line</th><th>Account</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {x.splits.map((s, i) => <tr key={i}><td>{s.description || '—'}</td><td>{accountName(s.account_id) || '—'}</td><td className="r">{money(s.amount, x.currency)}</td></tr>)}
              </tbody>
            </table>
          )}
        </Card>

        <div className="stack">
          <Card title="Ledger effect">
            <LedgerEffect e={x} money={money} accountName={accountName} />
            <p className="muted small">Posted on {date(x.date)}. Changing or deleting the expense reverses these entries.</p>
          </Card>
          <Card title="Receipts & attachments">
            <Attachments entityType="expense" entityId={x.id} />
          </Card>
        </div>
      </div>

      <Card title="History" className="mt" pad={false}>
        <Table
          columns={[
            { key: 'created_at', label: 'When', render: (r) => r.created_at?.slice(0, 16).replace('T', ' ') },
            { key: 'user_name', label: 'By', render: (r) => r.user_name || 'System' },
            { key: 'action', label: 'Action', render: (r) => statusLabel(r.action) || r.action },
            { key: 'detail', label: 'Detail', render: (r) => <span className="small">{r.detail}</span> },
          ]}
          rows={hist.data || []}
          loading={hist.loading}
          empty="No history yet."
        />
      </Card>
    </div>
  );
}
