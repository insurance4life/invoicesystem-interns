import { Link, useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Badge, Empty } from '../../components/ui.jsx';

const FREQ = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
export const freqLabel = (r) => {
  const rc = r.recurrence || {};
  const every = Number(rc.every) || 1;
  return `Every ${every > 1 ? `${every} ` : ''}${FREQ[rc.frequency] || 'month'}${every > 1 ? 's' : ''}`;
};
export const RECUR_STATUS = { active: 'green', paused: 'orange', stopped: 'gray', expired: 'red' };

export default function RecurringJournals() {
  const { money, date, can } = useApp();
  const nav = useNavigate();
  const { data, loading } = useFetch('/journals', { profiles: 1 });
  const rows = data || [];

  const columns = [
    { key: 'name', label: 'Profile Name', render: (r) => <span className="bold">{r.reference || r.notes || r.number}</span> },
    { key: 'freq', label: 'Frequency', render: (r) => freqLabel(r) },
    { key: 'next', label: 'Next Date', render: (r) => (r.recurrence?.status === 'active' && r.recurrence?.next_date ? date(r.recurrence.next_date) : '—') },
    { key: 'status', label: 'Status', render: (r) => <Badge color={RECUR_STATUS[r.recurrence?.status] || 'gray'}>{r.recurrence?.status || 'active'}</Badge> },
    { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total) },
  ];

  return (
    <div className="page">
      <PageHeader title="Recurring Journals" subtitle="Journals that post automatically on a schedule."
        actions={<>
          <Link className="btn btn-secondary" to="/accountant/journals">Manual Journals</Link>
          {can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/recurring-journals/new')}>+ New Recurring Journal</Button>}
        </>} />
      {!loading && !rows.length
        ? <Empty title="No recurring journals" text="Set up a journal that repeats monthly, yearly and so on." />
        : <Table columns={columns} rows={rows} loading={loading} onRowClick={(r) => nav(`/accountant/recurring-journals/${r.id}`)} />}
    </div>
  );
}
