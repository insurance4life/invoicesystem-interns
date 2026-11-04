import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Card, Badge, Empty, Spinner, KeyValue, Table } from '../../components/ui.jsx';
import { freqLabel, RECUR_STATUS } from './RecurringJournals.jsx';
import { errText } from './common.js';

export default function RecurringJournalView() {
  const { id } = useParams();
  const { money, date, can, toast } = useApp();
  const nav = useNavigate();
  const { data: j, loading, error, reload } = useFetch(`/journals/${id}`);

  if (loading && !j) return <Spinner />;
  if (error || !j) return <div className="page"><Empty title="Recurring journal not found" text={error?.message} action={<Link to="/accountant/recurring-journals">Back</Link>} /></div>;

  const rc = j.recurrence || {};
  const status = rc.status || 'active';
  const act = async (action, msg) => {
    try { await api.post(`/journals/${j.id}/recurrence/${action}`); toast(msg); reload(); }
    catch (e) { toast(errText(e), 'error'); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this recurring profile? Journals already generated are kept.')) return;
    try { await api.del(`/journals/${j.id}`); toast('Recurring journal deleted'); nav('/accountant/recurring-journals'); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const childColumns = [
    { key: 'number', label: 'Journal #', render: (c) => <span className="bold">{c.number}</span> },
    { key: 'date', label: 'Date', render: (c) => date(c.date) },
    { key: 'total', label: 'Amount', align: 'right', render: (c) => money(c.total) },
  ];

  return (
    <div className="page">
      <PageHeader title={j.reference || j.notes || `Recurring ${j.number}`} subtitle={freqLabel(j)}
        actions={<>
          {can('accountant', 'edit') && status === 'active' && <Button onClick={() => act('pause', 'Paused')}>Pause</Button>}
          {can('accountant', 'edit') && status === 'paused' && <Button variant="primary" onClick={() => act('resume', 'Resumed')}>Resume</Button>}
          {can('accountant', 'edit') && status !== 'stopped' && <Button onClick={() => act('stop', 'Stopped')}>Stop</Button>}
          {can('accountant', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
        </>}>
        <Link to="/accountant/recurring-journals" className="small muted">← All recurring journals</Link>
      </PageHeader>

      <div className="grid2">
        <Card title="Schedule">
          <KeyValue items={[
            ['Status', <Badge color={RECUR_STATUS[status] || 'gray'}>{status}</Badge>],
            ['Repeats', freqLabel(j)],
            ['Start date', date(rc.start_date || j.date)],
            ['Next run', status === 'active' && rc.next_date ? date(rc.next_date) : '—'],
            ['Ends', rc.end_date ? date(rc.end_date) : 'Never'],
            ['Last run', rc.last_run ? date(rc.last_run) : '—'],
            ['Amount per run', money(j.total)],
          ]} />
        </Card>
        <Card title="Template Lines">
          <table className="table">
            <tbody>
              {j.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.account_name}</td>
                  <td className="r">{Number(l.debit) ? money(l.debit) : ''}</td>
                  <td className="r">{Number(l.credit) ? money(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title={`Generated Journals (${j.children?.length || 0})`} className="mt" pad={false}>
        <Table columns={childColumns} rows={j.children || []} empty="No journals have been generated yet."
          onRowClick={(c) => nav(`/accountant/journals/${c.id}`)} />
      </Card>
    </div>
  );
}
