import { useState } from 'react';
import { Landmark } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Menu, Stat, Empty, Spinner, Badge } from '../../components/ui.jsx';
import { AccountModal, TransactionModal, BANK_TYPE_LABELS } from './common.jsx';

export default function Overview() {
  const { money, date, can, toast, refreshMeta } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch('/banking/overview');
  const [modal, setModal] = useState(null);
  const [view, setView] = useState('table');

  if (loading && !data) return <div className="page"><Spinner /></div>;
  const accounts = data?.accounts || [];
  const t = data?.totals || {};

  const remove = async (a) => {
    if (!window.confirm(`Delete ${a.name}?`)) return;
    try { await api.del(`/banking/accounts/${a.id}`); toast('Account deleted'); await refreshMeta(); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const toggleActive = async (a) => {
    try { await api.put(`/banking/accounts/${a.id}`, { is_active: a.is_active ? 0 : 1 }); await refreshMeta(); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  const cols = [
    { key: 'name', label: 'Account Details', render: (a) => (
      <div>
        <div className="bold">{a.name}</div>
        <div className="muted small">{BANK_TYPE_LABELS[a.type]}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_number ? ` · ${a.account_number}` : ''}</div>
      </div>
    ) },
    { key: 'uncategorized', label: 'Uncategorized', render: (a) => (a.uncategorized ? <Badge status="uncategorized">{a.uncategorized} to review</Badge> : <span className="muted">—</span>) },
    { key: 'statement_balance', label: 'Amount in Bank', align: 'right', render: (a) => (a.statement_balance == null ? <span className="muted">—</span> : <span>{money(a.statement_balance, a.currency)}<div className="muted small">{date(a.statement_balance_date)}</div></span>) },
    { key: 'balance', label: 'Amount in OpenBooks', align: 'right', render: (a) => <span className="bold">{money(a.balance, a.currency)}</span> },
    { key: 'last_reconciled', label: 'Last Reconciled', render: (a) => (a.last_reconciled ? date(a.last_reconciled) : <span className="muted">Never</span>) },
    { key: 'act', label: '', render: (a) => (
      <div onClick={(e) => e.stopPropagation()}>
        <Menu label="⋯" items={[
          { label: 'Import Statement', onClick: () => nav(`/banking/accounts/${a.id}/import`), hidden: !can('banking', 'create') },
          { label: 'Add Transaction', onClick: () => setModal({ txn: a.id }), hidden: !can('banking', 'create') },
          { label: 'Reconcile', onClick: () => nav(`/banking/accounts/${a.id}?tab=reconciliations`) },
          { label: 'Edit', onClick: () => setModal({ account: a }), hidden: !can('banking', 'edit') },
          { label: a.is_active ? 'Mark as Inactive' : 'Mark as Active', onClick: () => toggleActive(a), hidden: !can('banking', 'edit') || a.is_system },
          { label: 'Delete', danger: true, onClick: () => remove(a), hidden: !can('banking', 'delete') || a.is_system },
        ]} />
      </div>
    ) },
  ];

  return (
    <div className="page">
      <PageHeader title="Banking Overview" actions={<>
        <Button onClick={() => nav('/banking/rules')}>Bank Rules</Button>
        <Button onClick={() => nav('/banking/undeposited')}>Deposit Funds</Button>
        {can('banking', 'create') && <Button onClick={() => nav('/banking/import')}>Import Statement</Button>}
        {can('banking', 'create') && <Button variant="primary" onClick={() => setModal({ account: {} })}>+ Add Bank or Credit Card</Button>}
      </>} />
      <div className="grid4 mb">
        <Stat label="Bank Balance" value={money(t.bank)} />
        <Stat label="Credit Card Dues" value={money(t.credit_card)} tone={t.credit_card > 0 ? 'orange' : undefined} />
        <Stat label="Cash & Clearing" value={money(t.cash)} sub={t.undeposited ? `Undeposited: ${money(t.undeposited)}` : undefined} />
        <Stat label="Uncategorized" value={t.uncategorized || 0} sub="statement lines to review" tone={t.uncategorized ? 'orange' : undefined} />
      </div>
      <div className="row between mb">
        <h3>Active Accounts</h3>
        <div className="row">
          <Button size="sm" variant={view === 'table' ? 'primary' : 'secondary'} onClick={() => setView('table')}>Table</Button>
          <Button size="sm" variant={view === 'cards' ? 'primary' : 'secondary'} onClick={() => setView('cards')}>Cards</Button>
        </div>
      </div>
      {!accounts.length
        ? <Empty icon={Landmark} title="Connect your bank accounts" text="Add a bank or credit card account to import statements and reconcile." action={<Button variant="primary" onClick={() => setModal({ account: {} })}>Add Bank or Credit Card</Button>} />
        : view === 'table'
          ? <Table columns={cols} rows={accounts} onRowClick={(a) => nav(`/banking/accounts/${a.id}`)} />
          : (
            <div className="bk-cards">
              {accounts.map((a) => (
                <div key={a.id} className="card bk-card" onClick={() => nav(`/banking/accounts/${a.id}`)}>
                  <div className="row between"><span className="bold">{a.name}</span><span className="muted small">{BANK_TYPE_LABELS[a.type]}</span></div>
                  <div className="muted small">{a.bank_name || ' '}{a.account_number ? ` · ${a.account_number}` : ''}</div>
                  <div className="bk-card-bal">{money(a.balance, a.currency)}</div>
                  <div className="row between small">
                    <span className="muted">In bank: {a.statement_balance == null ? '—' : money(a.statement_balance, a.currency)}</span>
                    {a.uncategorized ? <Badge status="uncategorized">{a.uncategorized}</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
      {modal?.account && <AccountModal account={modal.account.id ? modal.account : null} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.txn && <TransactionModal accountId={modal.txn} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}
