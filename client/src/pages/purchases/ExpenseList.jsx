import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Badge, Button, Menu, PageHeader, SearchBox, Select, Stat, Table, errorMessage } from '../../components/ui.jsx';
import { RANGE_OPTIONS, dateRange } from '../../lib/format.js';

const STATUS_FILTERS = [
  ['all', 'All statuses'], ['unbilled', 'Unbilled'], ['invoiced', 'Invoiced'], ['non-billable', 'Non-billable'],
];
const FREQ = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

/**
 * Expenses list. With `profiles` it lists recurring expense profiles instead, with pause/resume/stop.
 */
export default function ExpenseList({ profiles = false }) {
  const { meta, can, money, date, toast } = useApp();
  const nav = useNavigate();
  const fy = meta?.org?.fiscal_year_start || 4;
  const [q, setQ] = useState('');
  const [range, setRange] = useState('this_year');
  const [cFrom, setCFrom] = useState('');
  const [cTo, setCTo] = useState('');
  const [status, setStatus] = useState('all');
  const [vendorId, setVendorId] = useState('');

  const [from, to] = range === 'custom' ? [cFrom || undefined, cTo || undefined] : dateRange(range, fy);
  const list = useFetch('/expenses', profiles ? { profiles: 1 } : { q, from, to, vendor_id: vendorId || undefined });
  const vendors = useFetch('/contacts', { type: 'vendor', per_page: 500 });

  const rows = useMemo(() => {
    const data = list.data || [];
    if (profiles) return data;
    if (status === 'all') return data;
    if (status === 'non-billable') return data.filter((e) => !e.is_billable);
    return data.filter((e) => e.status === status);
  }, [list.data, status, profiles]);

  const total = rows.reduce((s, e) => s + (Number(e.total) || 0), 0);
  const billedTotal = rows.filter((e) => e.is_billable).reduce((s, e) => s + (Number(e.total) || 0), 0);
  const unbilledTotal = rows.filter((e) => e.status === 'unbilled').reduce((s, e) => s + (Number(e.total) || 0), 0);

  const profileAction = async (e, action, msg) => {
    try { await api.post(`/expenses/${e.id}/recurrence/${action}`); toast(msg); list.reload(); } catch (err) { toast(errorMessage(err), 'error'); }
  };

  if (profiles) {
    const columns = [
      { key: 'account', label: 'Category', render: (e) => <span className="bold">{e.account_name || '—'}</span> },
      { key: 'vendor', label: 'Vendor', render: (e) => e.vendor_name || <span className="muted">—</span> },
      {
        key: 'freq', label: 'Frequency',
        render: (e) => {
          const r = e.recurrence || {};
          return `Every ${r.every || 1} ${FREQ[r.frequency] || 'month'}${(r.every || 1) > 1 ? 's' : ''}`;
        },
      },
      { key: 'next', label: 'Next date', render: (e) => (e.recurrence?.next_date ? date(e.recurrence.next_date) : '—') },
      { key: 'status', label: 'Status', render: (e) => <Badge status={e.recurrence?.status || 'active'} /> },
      { key: 'total', label: 'Amount', align: 'right', render: (e) => money(e.total, e.currency) },
      {
        key: 'actions', label: '',
        render: (e) => {
          const s = e.recurrence?.status;
          if (!can('purchases', 'edit')) return null;
          return (
            <span onClick={(ev) => ev.stopPropagation()}>
              <Menu items={[
                s !== 'active' && s !== 'expired' ? { label: 'Resume', onClick: () => profileAction(e, 'resume', 'Profile resumed') } : null,
                s === 'active' ? { label: 'Pause', onClick: () => profileAction(e, 'pause', 'Profile paused') } : null,
                s !== 'stopped' ? { label: 'Stop', danger: true, onClick: () => window.confirm('Stop this recurring expense? No more expenses will be created.') && profileAction(e, 'stop', 'Profile stopped') } : null,
              ]} />
            </span>
          );
        },
      },
    ];
    return (
      <div className="page">
        <PageHeader
          title="Recurring Expenses"
          subtitle="Profiles that create an expense on a schedule"
          actions={(
            <>
              <Link className="btn btn-secondary" to="/expenses">Expenses</Link>
              {can('purchases', 'create') && <Link className="btn btn-primary" to="/recurring-expenses/new">+ New Recurring Expense</Link>}
            </>
          )}
        />
        <Table columns={columns} rows={rows} loading={list.loading} empty="No recurring expenses. Create a profile to repeat an expense automatically." />
      </div>
    );
  }

  const columns = [
    { key: 'date', label: 'Date', render: (e) => date(e.date) },
    { key: 'account', label: 'Category', render: (e) => e.account_name || (e.splits?.length ? `Itemized (${e.splits.length})` : '—') },
    { key: 'reference', label: 'Reference', render: (e) => <span className="bold">{e.reference || <span className="muted">—</span>}</span> },
    { key: 'vendor', label: 'Vendor', render: (e) => e.vendor_name || <span className="muted">—</span> },
    { key: 'paid', label: 'Paid through', render: (e) => e.paid_through_name || '—' },
    { key: 'customer', label: 'Customer', render: (e) => (e.is_billable ? (e.customer_name || '—') : <span className="muted">—</span>) },
    { key: 'status', label: 'Status', render: (e) => <Badge status={e.status} /> },
    { key: 'total', label: 'Amount', align: 'right', render: (e) => money(e.total, e.currency) },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Expenses"
        subtitle="Money spent on the business, optionally billed on to customers"
        actions={(
          <>
            <Link className="btn btn-secondary" to="/recurring-expenses">Recurring</Link>
            {can('purchases', 'create') && <Link className="btn btn-primary" to="/expenses/new">+ New Expense</Link>}
          </>
        )}
      >
        <SearchBox value={q} onChange={setQ} placeholder="Search reference, notes, vendor or category" />
        <Select value={range} onChange={(e) => setRange(e.target.value)} options={RANGE_OPTIONS} style={{ width: 180 }} />
        {range === 'custom' && (
          <>
            <input type="date" className="input" style={{ width: 150 }} value={cFrom} onChange={(e) => setCFrom(e.target.value)} />
            <input type="date" className="input" style={{ width: 150 }} value={cTo} onChange={(e) => setCTo(e.target.value)} />
          </>
        )}
        <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTERS} style={{ width: 170 }} />
        <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="All vendors"
          options={(vendors.data || []).map((v) => [String(v.id), v.display_name])} style={{ width: 200 }} />
      </PageHeader>

      <div className="grid3 mt" style={{ marginTop: 16 }}>
        <Stat label="Total" value={money(total)} sub={`${rows.length} expenses`} />
        <Stat label="Billable to customers" value={money(billedTotal)} />
        <Stat label="Unbilled" value={money(unbilledTotal)} tone={unbilledTotal ? 'orange' : undefined} sub="ready to invoice" />
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          columns={columns}
          rows={rows}
          loading={list.loading}
          onRowClick={(e) => nav(`/expenses/${e.id}`)}
          empty={q || status !== 'all' || vendorId ? 'No expenses match these filters.' : 'No expenses in this period.'}
          footer={rows.length ? (
            <tr>
              <td colSpan={7} className="r">Total</td>
              <td className="r">{money(total)}</td>
            </tr>
          ) : null}
        />
      </div>
    </div>
  );
}
