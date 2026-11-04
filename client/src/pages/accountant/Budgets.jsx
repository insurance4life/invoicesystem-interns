import { Link, useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Empty, Menu } from '../../components/ui.jsx';
import { errText } from './common.js';

const PERIOD_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

export default function Budgets() {
  const { money, can, toast } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch('/budgets');
  const rows = data || [];

  const remove = async (b) => {
    if (!window.confirm(`Delete the budget "${b.name}"?`)) return;
    try { await api.del(`/budgets/${b.id}`); toast('Budget deleted'); reload(); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const columns = [
    { key: 'name', label: 'Budget Name', render: (b) => <Link to={`/accountant/budgets/${b.id}`} className="bold">{b.name}</Link> },
    { key: 'fiscal_year', label: 'Fiscal Year', render: (b) => `FY ${b.fiscal_year}–${String(b.fiscal_year + 1).slice(-2)}` },
    { key: 'period', label: 'Period', render: (b) => PERIOD_LABEL[b.period] || b.period },
    { key: 'account_count', label: 'Accounts', align: 'right' },
    { key: 'total_budget', label: 'Total Budget', align: 'right', render: (b) => money(b.total_budget) },
    { key: 'actions', label: '', render: (b) => (
      <div onClick={(e) => e.stopPropagation()}>
        <Menu label="⋯" items={[
          { label: 'View budget vs actual', onClick: () => nav(`/accountant/budgets/${b.id}`) },
          { label: 'Edit', hidden: !can('accountant', 'edit'), onClick: () => nav(`/accountant/budgets/${b.id}/edit`) },
          { label: 'Delete', danger: true, hidden: !can('accountant', 'delete'), onClick: () => remove(b) },
        ]} />
      </div>
    ) },
  ];

  return (
    <div className="page">
      <PageHeader title="Budgets" subtitle="Plan income and expenses per period, then compare them with actuals from the ledger."
        actions={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/budgets/new')}>+ New Budget</Button>} />
      {!loading && !rows.length
        ? <Empty title="No budgets yet" text="Create a budget to track planned income and expenses." action={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/budgets/new')}>+ New Budget</Button>} />
        : <Table columns={columns} rows={rows} loading={loading} onRowClick={(b) => nav(`/accountant/budgets/${b.id}`)} />}
    </div>
  );
}
