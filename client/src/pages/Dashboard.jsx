// Home dashboard: receivables/payables, cash flow, income vs expense, top expenses, bank balances, watchlist, quick counts.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useApp, useFetch } from '../store.jsx';
import { Card, Select, Spinner, Stat } from '../components/ui.jsx';
import { RANGE_OPTIONS, dateRange } from '../lib/format.js';
import { SERIES, OTHER, ChartTooltip, axisMoney } from './reports/ReportCharts.jsx';
import { accountUrl } from './reports/ReportTable.jsx';
import './reports/reports.css';

const axis = { fontSize: 11, fill: 'var(--muted)' };
const CURRENT = SERIES[0];
const OVERDUE = '#d03b3b'; // status: critical
const RANGES = RANGE_OPTIONS.filter(([k]) => ['this_year', 'last_year', 'calendar_year'].includes(k));

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function AgingCard({ title, data, link }) {
  const { money } = useApp();
  const total = data?.total || 0;
  const pct = (v) => (total ? `${Math.max(0, (v / total) * 100)}%` : '0%');
  const b = data?.buckets || {};
  return (
    <Card title={title} actions={<Link to={link} className="small">View all</Link>}>
      <div className="dash-total">Total Unpaid {title.replace('Total ', '')}<b>{money(total)}</b></div>
      <div className="dash-bar" role="img" aria-label={`Current ${money(data?.current)}, overdue ${money(data?.overdue)}`}>
        {data?.current > 0 && <div style={{ width: pct(data.current), background: CURRENT }} title={`Current ${money(data.current)}`} />}
        {data?.overdue > 0 && <div style={{ width: pct(data.overdue), background: OVERDUE }} title={`Overdue ${money(data.overdue)}`} />}
      </div>
      <div className="dash-split">
        <div><div className="lbl"><span className="tip-dot" style={{ background: CURRENT }} />Current</div><div className="val">{money(data?.current)}</div></div>
        {[['1-15', '1-15 Days'], ['16-30', '16-30 Days'], ['31-45', '31-45 Days'], ['>45', 'Above 45 Days']].map(([k, l]) => (
          <div key={k}><div className="lbl"><span className="tip-dot" style={{ background: OVERDUE }} />{l}</div><div className={`val ${b[k] ? 'red' : ''}`}>{money(b[k])}</div></div>
        ))}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { user, org, money, can } = useApp();
  const fy = org?.fiscal_year_start || 4;
  const [rangeKey, setRangeKey] = useState('this_year');
  const [basis, setBasis] = useState('accrual');
  const [from, to] = dateRange(rangeKey, fy);
  const { data, loading, error } = useFetch('/dashboard', { basis, from, to });

  if (!data && loading) return <div className="page"><Spinner /></div>;
  if (error && !data) return <div className="page"><div className="callout warn mt">{error.message}</div></div>;
  const d = data;
  const cf = d.cash_flow || [];
  const cfIn = cf.reduce((s, r) => s + r.incoming, 0), cfOut = cf.reduce((s, r) => s + r.outgoing, 0);
  const top = d.top_expenses || [];
  const pie = top.slice(0, 5).map((r, i) => ({ name: r.account, value: r.amount, fill: SERIES[i], account_id: r.account_id }));
  const rest = top.slice(5).reduce((s, r) => s + r.amount, 0);
  if (rest > 0) pie.push({ name: 'Others', value: Math.round(rest * 100) / 100, fill: OTHER });
  const pieTotal = pie.reduce((s, r) => s + r.value, 0);
  const reports = can('reports', 'view');

  const counts = [
    { label: 'Draft Invoices', value: d.counts.draft_invoices, to: '/invoices?status=draft' },
    { label: 'Pending Approvals', value: d.counts.pending_approvals, to: '/approvals', tone: d.counts.pending_approvals ? 'orange' : undefined },
    { label: 'Overdue Invoices', value: d.counts.overdue_invoices, to: '/invoices?status=overdue', tone: d.counts.overdue_invoices ? 'red' : undefined },
    { label: 'Unpaid Bills', value: d.counts.unpaid_bills, to: '/bills?status=unpaid' },
    { label: 'Sales This Month', value: money(d.sales_this_month), to: reports ? '/reports/sales-by-customer' : '/invoices' },
  ];

  return (
    <div className="page">
      <div className="dash-hello">
        <div className="avatar-l">{(org?.name || 'O').slice(0, 1).toUpperCase()}</div>
        <div>
          <h1>{greeting()}, {user?.name?.split(' ')[0] || 'there'}</h1>
          <div className="muted">{org?.name}</div>
        </div>
      </div>

      {d.restricted && <div className="callout mt">Financial figures are hidden because your role does not include Reports. Ask an admin for access.</div>}

      <div className="dash-counts">
        {counts.map((c) => <Link key={c.label} to={c.to} className="stat-link"><Stat label={c.label} value={c.value} tone={c.tone} /></Link>)}
      </div>

      <div className="dash-grid">
        <AgingCard title="Total Receivables" data={d.receivables} link={reports ? '/reports/ar-aging-summary' : '/invoices'} />
        <AgingCard title="Total Payables" data={d.payables} link={reports ? '/reports/ap-aging-summary' : '/bills'} />

        <Card className="span2" title="Cash Flow" actions={<Select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} options={RANGES} />}>
          <div className="dash-side">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={cf} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cfFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--line2)" />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} />
                <YAxis tick={axis} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={56} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="closing" name="Cash balance" stroke={SERIES[0]} strokeWidth={2} fill="url(#cfFill)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="side">
              <div><div className="muted small">Cash as on {cf[0]?.label || from}</div><div className="bold">{money(d.cash_opening)}</div></div>
              <div><div className="muted small">Incoming</div><div className="bold pos">+ {money(cfIn)}</div></div>
              <div><div className="muted small">Outgoing</div><div className="bold neg">- {money(cfOut)}</div></div>
              <div><div className="muted small">Cash as on {cf[cf.length - 1]?.label || to}</div><div className="bold">{money(cf[cf.length - 1]?.closing ?? d.cash_opening)}</div></div>
            </div>
          </div>
        </Card>

        <Card title="Income and Expense" actions={<div className="row" style={{ gap: 8 }}>
          <div className="seg">
            <button type="button" className={basis === 'accrual' ? 'on' : ''} onClick={() => setBasis('accrual')}>Accrual</button>
            <button type="button" className={basis === 'cash' ? 'on' : ''} onClick={() => setBasis('cash')}>Cash</button>
          </div>
          <Select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} options={RANGES} />
        </div>}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={d.income_expense} margin={{ top: 10, right: 6, left: 0, bottom: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--line2)" />
              <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tickFormatter={(v) => String(v).slice(0, 3)} />
              <YAxis tick={axis} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={56} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--line2)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="income" name="Income" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="expense" name="Expense" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
          <div className="row between small mt">
            <span className="muted">Total Income <b className="pos">{money(d.income_expense_totals?.income)}</b></span>
            <span className="muted">Total Expenses <b className="neg">{money(d.income_expense_totals?.expense)}</b></span>
          </div>
        </Card>

        <Card title="Top Expenses" actions={<span className="muted small">This fiscal year</span>}>
          {!pie.length ? <div className="center muted pad">No expenses recorded this fiscal year.</div> : (
            <div className="dash-side" style={{ gridTemplateColumns: '220px 1fr' }}>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pie} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={1} stroke="var(--panel)" strokeWidth={2}>
                    {pie.map((p) => <Cell key={p.name} fill={p.fill} />)}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="dash-list">
                {pie.map((p) => (
                  <div key={p.name} className="dl-row">
                    <span className="row" style={{ gap: 8 }}><span className="tip-dot" style={{ background: p.fill }} />
                      {p.account_id && reports ? <Link to={accountUrl(p.account_id, d.fiscal_year_start, d.as_of)}>{p.name}</Link> : p.name}</span>
                    <span className="small"><b>{money(p.value)}</b> <span className="muted">{pieTotal ? Math.round((p.value / pieTotal) * 100) : 0}%</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card title="Bank and Credit Cards" actions={<Link to="/banking" className="small">Go to Banking</Link>}>
          {!d.bank_accounts.length ? <div className="center muted pad">No bank or credit card accounts yet.</div> : (
            <div className="dash-list">
              {d.bank_accounts.map((a) => (
                <div key={a.id} className="dl-row">
                  <div>
                    {reports ? <Link to={accountUrl(a.id)}>{a.name}</Link> : a.name}
                    <div className="muted small">{a.type_label}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_number ? ` ${a.account_number}` : ''}</div>
                  </div>
                  <b className={a.balance < 0 ? 'neg' : ''}>{money(a.balance)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Account Watchlist" actions={<Link to="/accountant" className="small">Chart of Accounts</Link>}>
          {!d.watchlist.length ? <div className="center muted pad">Add accounts to the watchlist from the chart of accounts to track them here.</div> : (
            <div className="dash-list">
              {d.watchlist.map((a) => (
                <div key={a.id} className="dl-row">
                  <div>{reports ? <Link to={accountUrl(a.id)}>{a.name}</Link> : a.name}<div className="muted small">{a.type_label}</div></div>
                  <b>{money(a.balance)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>

        {d.projects && (
          <Card title="Projects" actions={<Link to="/time" className="small">View projects</Link>}>
            <div className="grid3">
              <Stat label="Active Projects" value={d.projects.active} />
              <Stat label="Unbilled Hours" value={d.projects.unbilled_hours} />
              <Stat label="Hours This Month" value={d.projects.hours_this_month} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
