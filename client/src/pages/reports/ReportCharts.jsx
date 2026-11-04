// Chart views for reports. Colours follow a fixed categorical order (validated palette): slot 1 blue, slot 2 orange, ...
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useApp } from '../../store.jsx';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER = '#9a9a96';
const axis = { fontSize: 11, fill: 'var(--muted)' };
const short = (v) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};
export const axisMoney = short;

export function ChartTooltip({ active, payload, label }) {
  const { money } = useApp();
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label && <div className="bold">{label}</div>}
      {payload.map((p) => (
        <div key={p.dataKey} className="row" style={{ gap: 6 }}>
          <span className="tip-dot" style={{ background: p.color || p.payload?.fill }} />
          <span className="muted">{p.name}</span><span className="grow" /><span>{money(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** P&L: income, COGS, expenses and profit lines as bars; a second series when comparing. */
export function PLChart({ data }) {
  const t = data.totals || {}, ct = data.compare_totals;
  const keys = [['total_income', 'Income'], ['cogs', 'Cost of Goods Sold'], ['operating_expense', 'Operating Expense'], ['non_operating_expense', 'Non Operating Expense'],
    ['gross_profit', 'Gross Profit'], ['net_profit', 'Net Profit']];
  const rows = keys.map(([k, l]) => ({ name: l, current: t[k] || 0, ...(ct ? { previous: ct[k] || 0 } : {}) }));
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={340}>
        <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--line2)" />
          <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--line)' }} interval={0} />
          <YAxis tick={axis} tickFormatter={short} tickLine={false} axisLine={false} width={56} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--line2)' }} />
          {ct && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <Bar dataKey="current" name={`${data.from} – ${data.to}`} fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={44} />
          {ct && <Bar dataKey="previous" name={`${data.compare_from} – ${data.compare_to}`} fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={44} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars of the top 10 rows by value (e.g. sales by customer); single series, so no legend. */
export function BarsChart({ rows = [], valueKey = 'amount', label = 'Amount' }) {
  const top = rows.filter((r) => !r._kind).slice().sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0)).slice(0, 10)
    .map((r) => ({ name: r.name, value: r[valueKey] || 0 }));
  if (!top.length) return <div className="center muted pad">Nothing to chart for this period.</div>;
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={Math.max(200, top.length * 36 + 40)}>
        <BarChart data={top} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
          <CartesianGrid horizontal={false} stroke="var(--line2)" />
          <XAxis type="number" tick={axis} tickFormatter={short} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="name" tick={axis} width={150} tickLine={false} axisLine={{ stroke: 'var(--line)' }} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--line2)' }} />
          <Bar dataKey="value" name={label} fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
