// One page for every report: filters (date range / as-of / basis / compare / account / budget), Run, Export CSV, Print,
// then the generic table or a custom renderer (P&L chart, balance sheet check, GSTR-1 tabs).
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api, downloadCsv } from '../../api.js';
import { Button, PageHeader, Select, Input, Spinner, Empty, AccountSelect, Tabs, errorMessage } from '../../components/ui.jsx';
import { RANGE_OPTIONS, dateRange, today } from '../../lib/format.js';
import { REPORT_MAP } from './registry.js';
import ReportTable, { csvColumns } from './ReportTable.jsx';
import { PLChart, BarsChart } from './ReportCharts.jsx';
import './reports.css';

const API_KEYS = ['from', 'to', 'date', 'basis', 'compare', 'account_id', 'budget_id', 'status'];

function defaultsFor(def, fy) {
  if (def.date === 'asof') return { to: today() };
  if (def.date === 'day') return { date: today() };
  if (def.date === 'none') return {};
  const [from, to] = dateRange('this_year', fy);
  return { range: 'this_year', from, to };
}

export default function ReportView() {
  const { key } = useParams();
  const def = REPORT_MAP[key];
  const { org, toast } = useApp();
  const fy = org?.fiscal_year_start || 4;
  const [sp, setSp] = useSearchParams();
  const spKey = sp.toString();
  const applied = useMemo(() => {
    if (!def) return {};
    const fromUrl = Object.fromEntries(sp.entries());
    const base = defaultsFor(def, fy);
    if (fromUrl.from || fromUrl.to) base.range = 'custom';
    return { ...base, ...(def.basis ? { basis: 'accrual' } : {}), ...fromUrl };
  }, [spKey, def, fy]); // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setForm] = useState(applied);
  useEffect(() => setForm(applied), [applied]);
  const [view, setView] = useState('table');
  const [tab, setTab] = useState('b2b');

  const apiParams = useMemo(() => Object.fromEntries(API_KEYS.filter((k) => applied[k]).map((k) => [k, applied[k]])), [applied]);
  const skip = def?.requireAccount && !applied.account_id;
  const { data, loading, error, reload } = useFetch(def && !skip ? `/reports/${key}` : null, apiParams);

  if (!def) return <div className="page"><Empty title="Report not found" action={<Link to="/reports">Back to Reports</Link>} /></div>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setRange = (range) => {
    if (range === 'custom') return set({ range });
    const [from, to] = dateRange(range, fy);
    set({ range, from, to });
  };
  const run = () => {
    const next = new URLSearchParams(Object.entries(form).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null));
    if (next.toString() === spKey) reload(); else setSp(next);
  };
  const range = { from: data?.from || applied.from, to: data?.to || applied.to };
  const exportCsv = () => {
    if (!data) return;
    if (def.renderer === 'gstr1' && data.tabs) {
      const t = data.tabs[tab] || data.tabs.b2b;
      return downloadCsv(`${def.title} ${t.title} ${range.from}_${range.to}`, t.rows, csvColumns(t.columns));
    }
    const rows = [...(data.rows || [])];
    if (data.totals) rows.push({ ...data.totals, [data.columns[0].key]: data.totals.name || 'Total' });
    downloadCsv(`${def.title} ${range.from || ''}_${range.to || ''}`.trim(), rows, csvColumns(data.columns || []));
  };
  const downloadJson = async () => {
    try {
      const j = await api.get('/reports/gstr1', { ...apiParams, format: 'json' });
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `GSTR1_${j.gstin || 'org'}_${j.fp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const subtitle = def.date === 'asof' ? `As of ${applied.to}` : def.date === 'day' ? `On ${applied.date}` : def.date === 'none' ? '' : `From ${range.from} To ${range.to}`;

  return (
    <div className="page report-page">
      <PageHeader
        title={def.title}
        subtitle={<Link to="/reports">← Reports Center</Link>}
        actions={<>
          {def.chart && <div className="seg no-print">
            <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
            <button type="button" className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>Chart</button>
          </div>}
          {def.renderer === 'gstr1' && <Button onClick={downloadJson}>Download JSON</Button>}
          <Button onClick={exportCsv} disabled={!data}>Export CSV</Button>
          <Button onClick={() => window.print()}>Print / PDF</Button>
        </>}
      >
        {def.date === 'range' && <>
          <Select value={form.range || 'custom'} onChange={(e) => setRange(e.target.value)} options={RANGE_OPTIONS} style={{ width: 180 }} />
          <Input type="date" value={form.from} onChange={(e) => set({ from: e.target.value, range: 'custom' })} style={{ width: 150 }} />
          <span className="muted">to</span>
          <Input type="date" value={form.to} onChange={(e) => set({ to: e.target.value, range: 'custom' })} style={{ width: 150 }} />
        </>}
        {def.date === 'asof' && <><span className="muted">As of</span><Input type="date" value={form.to} onChange={(e) => set({ to: e.target.value })} style={{ width: 150 }} /></>}
        {def.date === 'day' && <><span className="muted">Date</span><Input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} style={{ width: 150 }} /></>}
        {def.basis && <Select value={form.basis || 'accrual'} onChange={(e) => set({ basis: e.target.value })} options={[['accrual', 'Accrual basis'], ['cash', 'Cash basis']]} style={{ width: 150 }} />}
        {def.compare && <Select value={form.compare || ''} onChange={(e) => set({ compare: e.target.value })} placeholder="No comparison" options={[['previous_period', 'Compare: previous period'], ['previous_year', 'Compare: previous year']]} style={{ width: 210 }} />}
        {def.account && <div style={{ width: 260 }}><AccountSelect value={form.account_id} onChange={(v) => set({ account_id: v || '' })} placeholder={def.requireAccount ? 'Choose an account' : 'All accounts'} /></div>}
        {def.budget && <Select value={form.budget_id || data?.budget?.id || ''} onChange={(e) => set({ budget_id: e.target.value })} placeholder="Choose a budget" options={(data?.budgets || []).map((b) => [b.id, `${b.name}${b.fiscal_year ? ` (FY ${b.fiscal_year})` : ''}`])} style={{ width: 240 }} />}
        <Button variant="primary" onClick={run}>Run Report</Button>
      </PageHeader>

      {skip && <Empty title="Choose an account" text="Pick an account above and run the report to see its transactions." />}
      {!skip && error && <div className="callout warn">{errorMessage(error)}</div>}
      {!skip && !data && loading && <Spinner />}
      {!skip && data && (
        <div className={`report-paper ${loading ? 'is-loading' : ''}`}>
          <div className="report-head">
            <div className="org">{org?.name}</div>
            <h2>{data.title || def.title}</h2>
            {subtitle && <div className="muted small">{subtitle}{data.basis && def.basis ? ` · ${data.basis === 'cash' ? 'Cash' : 'Accrual'} basis` : ''}{data.gstin ? ` · GSTIN ${data.gstin}` : ''}</div>}
          </div>
          {data.message && <div className="callout">{data.message}</div>}
          {def.renderer === 'gstr1'
            ? <Gstr1Body data={data} range={range} tab={tab} setTab={setTab} />
            : view === 'chart' && def.chart === 'pl' ? <PLChart data={data} />
              : view === 'chart' && def.chart === 'bars' ? <BarsChart rows={data.rows} label="Sales" valueKey="amount" />
                : <ReportTable columns={data.columns} rows={data.rows} totals={data.totals} range={range} />}
          {def.renderer === 'bs' && data.totals && (
            <div className={`callout mt ${data.balanced ? '' : 'warn'}`}>
              Total assets {data.balanced ? 'equal' : 'do not equal'} total liabilities and equity.
            </div>
          )}
          {(data.extra || []).map((x) => (
            <div key={x.title} className="mt">
              <h3 className="mb-s">{x.title}</h3>
              <ReportTable columns={x.columns} rows={x.rows} range={range} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Gstr1Body({ data, range, tab, setTab }) {
  const tabs = data.tabs || {};
  const keys = ['b2b', 'b2c', 'cdnr', 'hsn'].filter((k) => tabs[k]);
  const cur = tabs[tab] || tabs.b2b;
  return (
    <>
      <ReportTable columns={data.columns} rows={data.rows} range={range} />
      <div className="mt no-print-tabs">
        <Tabs tabs={keys.map((k) => ({ key: k, label: tabs[k].title, count: tabs[k].rows.length }))} active={tab} onChange={setTab} />
      </div>
      {cur && <ReportTable columns={cur.columns} rows={cur.rows} totals={cur.rows.length ? { ...cur.totals, name: 'Total' } : null} range={range} />}
    </>
  );
}
