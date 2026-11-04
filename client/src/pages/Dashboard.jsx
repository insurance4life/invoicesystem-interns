// Home dashboard: receivables/payables, cash flow, income vs expense, top expenses, bank balances, watchlist, quick counts.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useApp, useFetch } from '../store.jsx';
import { Card, Select, Spinner, Stat } from '../components/ui.jsx';
import { RANGE_OPTIONS, dateRange } from '../lib/format.js';
import { ChartTooltip, axisMoney } from './reports/ReportCharts.jsx';
import { accountUrl } from './reports/ReportTable.jsx';
import './reports/reports.css';

const axis = { fontSize: 11, fill: 'var(--muted)', fontFamily: 'var(--mono)' };
// one accent per chart: the series that matters is ledger green, everything else a neutral step
const ACCENT = 'var(--primary)';
const NEUTRAL = 'color-mix(in srgb, var(--fg) 22%, transparent)';
const OVERDUE = 'var(--red)';
const RANGES = RANGE_OPTIONS.filter(([k]) => ['this_year', 'last_year', 'calendar_year'].includes(k));
const today = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function AgingCard({ title, data, link }) {
  const { money } = useApp();
  const total = data?.total || 0;
  const pct = (v) => (total ? `${Math.max(0, (v / total) * 100)}%` : '0%');
  const b = data?.buckets || {};
  return (
    <Card title={title} actions={<Link to={link} className="small">View all</Link>}>
      <div className="dash-total"><span>Unpaid {title.replace('Total ', '').toLowerCase()}</span><b className="ledger-total">{money(total)}</b></div>
      <div className="dash-bar" role="img" aria-label={`Current ${money(data?.current)}, overdue ${money(data?.overdue)}`}>
        {data?.current > 0 && <div style={{ width: pct(data.current), background: ACCENT }} title={`Current ${money(data.current)}`} />}
        {data?.overdue > 0 && <div style={{ width: pct(data.overdue), background: OVERDUE }} title={`Overdue ${money(data.overdue)}`} />}
      </div>
      <div className="dash-split">
        <div><div className="lbl"><span className="tip-dot" style={{ background: ACCENT }} />Current</div><div className="val">{money(data?.current)}</div></div>
        {[['1-15', '1–15 days'], ['16-30', '16–30 days'], ['31-45', '31–45 days'], ['>45', 'Over 45 days']].map(([k, l]) => (
          <div key={k}><div className="lbl"><span className="tip-dot" style={{ background: OVERDUE }} />{l}</div><div className={`val ${b[k] ? 'red' : ''}`}>{money(b[k])}</div></div>
        ))}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { org, money, can } = useApp();
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
  const ranked = top.slice(0, 5).map((r) => ({ name: r.account, value: r.amount, account_id: r.account_id }));
  const rest = top.slice(5).reduce((s, r) => s + r.amount, 0);
  if (rest > 0) ranked.push({ name: 'Others', value: Math.round(rest * 100) / 100 });
  const rankedTotal = ranked.reduce((s, r) => s + r.value, 0);
  const rankedMax = Math.max(0, ...ranked.map((r) => r.value));
  const reports = can('reports', 'view');

  const counts = [
    { label: 'Draft invoices', value: d.counts.draft_invoices, to: '/invoices?status=draft' },
    { label: 'Pending approvals', value: d.counts.pending_approvals, to: '/approvals', tone: d.counts.pending_approvals ? 'orange' : undefined },
    { label: 'Overdue invoices', value: d.counts.overdue_invoices, to: '/invoices?status=overdue', tone: d.counts.overdue_invoices ? 'red' : undefined },
    { label: 'Unpaid bills', value: d.counts.unpaid_bills, to: '/bills?status=unpaid' },
  ];

  return (
    <div className="page">
      <div className="dash-hello">
        <h1>{org?.name || 'Home'}</h1>
        <div className="muted">{today()}</div>
      </div>

      {d.restricted && <div className="callout mt">Financial figures are hidden because your role does not include Reports. Ask an admin for access.</div>}

      <div className="dash-counts">
        <Link to={reports ? '/reports/sales-by-customer' : '/invoices'} className="stat-link lead">
          <Stat label="Sales this month" value={money(d.sales_this_month)} />
        </Link>
        {counts.map((c) => <Link key={c.label} to={c.to} className="stat-link"><Stat label={c.label} value={c.value} tone={c.tone} /></Link>)}
      </div>

      <div className="dash-grid">
        <AgingCard title="Total Receivables" data={d.receivables} link={reports ? '/reports/ar-aging-summary' : '/invoices'} />
        <AgingCard title="Total Payables" data={d.payables} link={reports ? '/reports/ap-aging-summary' : '/bills'} />

        <Card className="span2" title="Cash flow" actions={<Select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} options={RANGES} />}>
          <div className="dash-side">
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={cf} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cfFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--line2)" />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} />
                <YAxis tick={axis} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={56} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="closing" name="Cash balance" stroke={ACCENT} strokeWidth={2} fill="url(#cfFill)" dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: ACCENT }} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="side">
              <div><div className="muted small">Cash on {cf[0]?.label || from}</div><div className="fig">{money(d.cash_opening)}</div></div>
              <div><div className="muted small">Incoming</div><div className="fig pos">+{money(cfIn)}</div></div>
              <div><div className="muted small">Outgoing</div><div className="fig neg">−{money(cfOut)}</div></div>
              <div><div className="muted small">Cash on {cf[cf.length - 1]?.label || to}</div><div className="fig ledger-total">{money(cf[cf.length - 1]?.closing ?? d.cash_opening)}</div></div>
            </div>
          </div>
        </Card>

        <Card title="Income and expense" actions={<div className="row" style={{ gap: 8 }}>
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
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="square" iconSize={8} formatter={(v) => <span style={{ color: 'var(--fg2)' }}>{v}</span>} />
              <Bar dataKey="income" name="Income" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={16} />
              <Bar dataKey="expense" name="Expense" fill={NEUTRAL} radius={[3, 3, 0, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
          <div className="row between small mt">
            <span className="muted">Total income <b className="fig">{money(d.income_expense_totals?.income)}</b></span>
            <span className="muted">Total expenses <b className="fig">{money(d.income_expense_totals?.expense)}</b></span>
          </div>
        </Card>

        <Card title="Top expenses" actions={<span className="muted small">This fiscal year</span>}>
          {!ranked.length ? <div className="center muted pad">No expenses recorded this fiscal year</div> : (
            <div className="rank">
              {ranked.map((r, i) => (
                <div key={r.name} className="rank-row">
                  <div className="rank-head">
                    <span>{r.account_id && reports ? <Link to={accountUrl(r.account_id, d.fiscal_year_start, d.as_of)}>{r.name}</Link> : r.name}</span>
                    <span className="fig">{money(r.value)} <span className="muted">{rankedTotal ? Math.round((r.value / rankedTotal) * 100) : 0}%</span></span>
                  </div>
                  <div className="rank-bar"><div style={{ width: `${rankedMax ? (r.value / rankedMax) * 100 : 0}%`, background: i === 0 ? ACCENT : NEUTRAL }} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Bank and credit cards" actions={<Link to="/banking" className="small">Banking</Link>}>
          {!d.bank_accounts.length ? <div className="center muted pad">No bank or credit card accounts yet</div> : (
            <div className="dash-list">
              {d.bank_accounts.map((a) => (
                <div key={a.id} className="dl-row">
                  <div>
                    {reports ? <Link to={accountUrl(a.id)}>{a.name}</Link> : a.name}
                    <div className="muted small">{a.type_label}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_number ? ` ${a.account_number}` : ''}</div>
                  </div>
                  <b className={`fig ${a.balance < 0 ? 'neg' : ''}`}>{money(a.balance)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Account watchlist" actions={<Link to="/accountant" className="small">Chart of Accounts</Link>}>
          {!d.watchlist.length ? <div className="center muted pad">Star accounts in the chart of accounts to follow them here</div> : (
            <div className="dash-list">
              {d.watchlist.map((a) => (
                <div key={a.id} className="dl-row">
                  <div>{reports ? <Link to={accountUrl(a.id)}>{a.name}</Link> : a.name}<div className="muted small">{a.type_label}</div></div>
                  <b className="fig">{money(a.balance)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>

        {d.projects && (
          <Card title="Projects" actions={<Link to="/time" className="small">View projects</Link>}>
            <div className="grid3">
              <Stat label="Active projects" value={d.projects.active} />
              <Stat label="Unbilled hours" value={d.projects.unbilled_hours} />
              <Stat label="Hours this month" value={d.projects.hours_this_month} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
