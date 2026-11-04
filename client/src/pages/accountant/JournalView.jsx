import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Card, Badge, Empty, Spinner, KeyValue } from '../../components/ui.jsx';
import { errText } from './common.js';

export default function JournalView() {
  const { id } = useParams();
  const { money, date, can, toast, org } = useApp();
  const nav = useNavigate();
  const { data: j, loading, error, reload } = useFetch(`/journals/${id}`);
  const { data: history, reload: reloadHistory } = useFetch('/activity', { entity_type: 'journal', entity_id: id, limit: 100 });

  if (loading && !j) return <Spinner />;
  if (error || !j) return <div className="page"><Empty title="Journal not found" text={error?.message} action={<Link to="/accountant/journals">Back to journals</Link>} /></div>;

  const publish = async () => {
    try { await api.post(`/journals/${j.id}/publish`); toast('Journal published'); reload(); reloadHistory(); }
    catch (e) { toast(errText(e), 'error'); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete journal ${j.number}? Its ledger entries will be removed.`)) return;
    try { await api.del(`/journals/${j.id}`); toast('Journal deleted'); nav('/accountant/journals'); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const totalDebit = j.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = j.lines.reduce((s, l) => s + Number(l.credit || 0), 0);

  return (
    <div className="page">
      <PageHeader title={`Journal ${j.number}`} subtitle={`Dated ${date(j.date)}${j.journal_type === 'reversal' ? ' · Reversing entry' : ''}`}
        actions={<>
          {j.status === 'draft' && can('accountant', 'edit') && <Button variant="primary" onClick={publish}>Publish</Button>}
          {can('accountant', 'edit') && <Link className="btn btn-secondary" to={`/accountant/journals/${j.id}/edit`}>Edit</Link>}
          {can('accountant', 'create') && <Link className="btn btn-secondary" to={`/accountant/journals/new?clone=${j.id}`}>Clone</Link>}
          {can('accountant', 'delete') && <Button variant="danger" onClick={remove}>Delete</Button>}
        </>}>
        <Link to="/accountant/journals" className="small muted">← All journals</Link>
      </PageHeader>

      <div className="grid2">
        <Card title="Details">
          <KeyValue items={[
            ['Status', <Badge color={j.status === 'published' ? 'green' : 'gray'}>{j.status === 'published' ? 'Published' : 'Draft'}</Badge>],
            ['Reference #', j.reference],
            ['Notes', j.notes],
            ['Currency', j.currency && j.currency !== org?.currency ? `${j.currency} @ ${j.exchange_rate}` : j.currency],
            ['Total', money(j.total)],
          ]} />
        </Card>
        <Card title="Reversal">
          {j.reversal && <div>Reversed by <Link to={`/accountant/journals/${j.reversal.id}`}>{j.reversal.number}</Link> on {date(j.reversal.date)}.</div>}
          {!j.reversal && j.reverse_date && j.status === 'published' && <div>Will auto-reverse on {date(j.reverse_date)}.</div>}
          {j.reversed_journal_id && <div className="mt">This entry reverses <Link to={`/accountant/journals/${j.reversed_journal_id}`}>another journal</Link>.</div>}
          {!j.reversal && !j.reverse_date && !j.reversed_journal_id && <div className="muted">No reversal scheduled.</div>}
        </Card>
      </div>

      <Card title="Line Items" className="mt" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Account</th><th>Contact</th><th>Description</th><th className="r">Debit</th><th className="r">Credit</th></tr>
            </thead>
            <tbody>
              {j.lines.map((l) => (
                <tr key={l.id}>
                  <td><Link to={`/accountant/chart-of-accounts/${l.account_id}`}>{l.account_code ? `${l.account_code} · ` : ''}{l.account_name}</Link></td>
                  <td>{l.contact_name || ''}</td>
                  <td className="muted">{l.description || ''}</td>
                  <td className="r">{Number(l.debit) ? money(l.debit) : ''}</td>
                  <td className="r">{Number(l.credit) ? money(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td colSpan={3} className="r bold">Total</td>
                <td className="r bold">{money(totalDebit)}</td>
                <td className="r bold">{money(totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card title="History" className="mt" pad={false}>
        {!history?.length ? <Empty title="No history yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td>{date(String(a.created_at).slice(0, 10))} <span className="muted small">{String(a.created_at).slice(11, 16)}</span></td>
                    <td>{a.user_name || 'System'}</td>
                    <td>{a.action}</td>
                    <td className="muted">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
