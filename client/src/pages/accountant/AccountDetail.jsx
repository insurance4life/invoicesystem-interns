import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Card, Empty, Stat, Spinner, Money, Badge } from '../../components/ui.jsx';
import { AccountModal } from './ChartOfAccounts.jsx';
import { round2 } from '@shared/calc.js';
import { movement, typeLabel } from './common.js';

const SOURCE_LABELS = {
  invoice: 'Invoice', creditnote: 'Credit Note', salesreceipt: 'Sales Receipt', bill: 'Bill', vendorcredit: 'Vendor Credit',
  payment_received: 'Payment Received', payment_made: 'Payment Made', refund: 'Refund', expense: 'Expense', journal: 'Journal',
  writeoff: 'Write-off', depreciation: 'Depreciation', fixed_asset: 'Fixed Asset', asset_disposal: 'Asset Disposal',
  fx_revaluation: 'FX Revaluation', contact_opening: 'Opening Balance', item_opening: 'Opening Stock',
};

const SOURCE_LINKS = {
  journal: (id) => `/accountant/journals/${id}`,
};

export default function AccountDetail() {
  const { id } = useParams();
  const { money, date, can } = useApp();
  const [editing, setEditing] = useState(false);
  const { data: a, loading, error, reload } = useFetch(`/accounts/${id}`);

  if (loading && !a) return <Spinner />;
  if (error || !a) return <div className="page"><Empty title="Account not found" text={error?.message} action={<Link to="/accountant/chart-of-accounts">Back to chart of accounts</Link>} /></div>;

  // transactions arrive newest first; walk them to get the balance after each line
  let running = a.balance;
  const txs = (a.transactions || []).map((t) => {
    const row = { ...t, running: round2(running) };
    running = round2(running - movement(a.class, t.debit, t.credit));
    return row;
  });

  return (
    <div className="page">
      <PageHeader title={`${a.code ? `${a.code} · ` : ''}${a.name}`}
        subtitle={`${typeLabel(a.type)}${a.is_active ? '' : ' · Inactive'}${a.parent_name ? ` · Parent: ${a.parent_name}` : ''}`}
        actions={<>
          <Link className="btn btn-secondary" to={`/reports/account-transactions?account_id=${a.id}`}>Account Transactions Report</Link>
          {can('accountant', 'edit') && <Button onClick={() => setEditing(true)}>Edit</Button>}
          <Link className="btn btn-secondary" to="/accountant/chart-of-accounts">Back</Link>
        </>}>
        {a.is_system ? <Badge color="blue">System account</Badge> : null}
      </PageHeader>

      <div className="grid3 mt">
        <Stat label="Balance" value={<Money value={a.balance} />} sub={a.class} />
        <Stat label="Total Debits" value={<Money value={a.debit} />} />
        <Stat label="Total Credits" value={<Money value={a.credit} />} />
      </div>

      {(a.type === 'bank' || a.type === 'credit_card') && (
        <Card title="Bank Details" className="mt">
          <div className="grid3 small">
            <div><span className="muted">Bank</span><div>{a.bank_name || '—'}</div></div>
            <div><span className="muted">Account number</span><div>{a.account_number || '—'}</div></div>
            <div><span className="muted">IFSC</span><div>{a.ifsc || '—'}</div></div>
          </div>
        </Card>
      )}

      <Card title="Transactions" className="mt" pad={false}>
        {!txs.length ? <Empty title="No transactions yet" text="Postings to this account will appear here." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th><th>Source</th><th>Number</th><th>Contact</th><th>Description</th>
                  <th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => {
                  const link = SOURCE_LINKS[t.src_type]?.(t.src_id);
                  return (
                    <tr key={t.id}>
                      <td>{date(t.date)}</td>
                      <td>{SOURCE_LABELS[t.src_type] || t.src_type}</td>
                      <td>{link ? <Link to={link}>{t.number || t.src_id}</Link> : (t.number || '')}</td>
                      <td>{t.contact_name || ''}</td>
                      <td className="muted">{t.description || ''}</td>
                      <td className="r">{Number(t.debit) ? money(t.debit) : ''}</td>
                      <td className="r">{Number(t.credit) ? money(t.credit) : ''}</td>
                      <td className="r bold">{money(t.running)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <AccountModal account={a} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}
