import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Card, Empty, Spinner, Select, Table } from '../../components/ui.jsx';
import { CLASS_LABELS } from './common.js';

const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);

export default function BudgetVsActual() {
  const { id } = useParams();
  const nav = useNavigate();
  const { money, can } = useApp();
  const [view, setView] = useState('all'); // 'all' or a period index
  const { data, loading, error } = useFetch(`/budgets/${id}/vs-actual`);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <div className="page"><Empty title="Budget not found" text={error?.message} action={<Link to="/accountant/budgets">Back to budgets</Link>} /></div>;

  const { budget: b, periods, rows, totals } = data;
  const idx = view === 'all' ? null : Number(view);
  const cellOf = (r) => (idx == null ? r.total : r.periods[idx]);

  const chartData = periods.map((p, i) => ({
    name: p.label,
    'Income budget': totals.income?.periods[i]?.budget || 0,
    'Income actual': totals.income?.periods[i]?.actual || 0,
    'Expense budget': totals.expense?.periods[i]?.budget || 0,
    'Expense actual': totals.expense?.periods[i]?.actual || 0,
  }));

  const columns = [
    { key: 'name', label: 'Account', render: (r) => (
      <><span className="bold">{r.name}</span> <span className="small muted">{r.code || ''}</span></>
    ) },
    { key: 'class', label: 'Class', render: (r) => CLASS_LABELS[r.class] || r.class },
    { key: 'budget', label: 'Budget', align: 'right', render: (r) => money(cellOf(r).budget) },
    { key: 'actual', label: 'Actual', align: 'right', render: (r) => money(cellOf(r).actual) },
    { key: 'variance', label: 'Variance', align: 'right', render: (r) => <span className={cellOf(r).variance < 0 ? 'neg' : ''}>{money(cellOf(r).variance)}</span> },
    { key: 'pct', label: 'Variance %', align: 'right', render: (r) => pct(cellOf(r).variance_pct) },
  ];

  const footer = Object.entries(totals).map(([cls, t]) => {
    const c = idx == null ? t.total : t.periods[idx];
    return (
      <tr key={cls} className="total-row">
        <td colSpan={2} className="bold">Total {CLASS_LABELS[cls] || cls}</td>
        <td className="r bold">{money(c.budget)}</td>
        <td className="r bold">{money(c.actual)}</td>
        <td className="r bold">{money(c.variance)}</td>
        <td className="r bold">{pct(c.variance_pct)}</td>
      </tr>
    );
  });

  return (
    <div className="page">
      <PageHeader title={b.name} subtitle={`FY ${b.fiscal_year}–${String(b.fiscal_year + 1).slice(-2)} · ${b.period} · variance = actual − budget`}
        actions={<>
          {can('accountant', 'edit') && <Button onClick={() => nav(`/accountant/budgets/${b.id}/edit`)}>Edit</Button>}
          <Link className="btn btn-secondary" to="/accountant/budgets">All budgets</Link>
        </>}>
        <Select style={{ width: 240 }} value={view} onChange={(e) => setView(e.target.value)}
          options={[['all', 'Full fiscal year'], ...periods.map((p) => [String(p.index), p.label])]} />
      </PageHeader>

      <Card title="Budget vs actual by period" className="mt">
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => Number(v).toLocaleString('en-IN')} />
              <Tooltip formatter={(v) => money(v)} />
              <Legend />
              <Bar dataKey="Income budget" fill="#9bbcf5" />
              <Bar dataKey="Income actual" fill="#408dfb" />
              <Bar dataKey="Expense budget" fill="#f5c78a" />
              <Bar dataKey="Expense actual" fill="#e5484d" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="mt">
        {!rows.length
          ? <Empty title="No accounts in this budget" text="Edit the budget to choose income or expense accounts." />
          : <Table columns={columns} rows={rows} footer={footer} rowKey="account_id" />}
      </div>
    </div>
  );
}
