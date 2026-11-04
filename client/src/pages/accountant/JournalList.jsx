import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { PageHeader, Button, Table, Badge, Tabs, SearchBox, Empty } from '../../components/ui.jsx';

export default function JournalList() {
  const { money, date, can } = useApp();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || 'all';
  const q = sp.get('q') || '';
  const { data, loading } = useFetch('/journals', { status: status === 'all' ? undefined : status, q: q || undefined });
  const rows = data || [];
  const setParam = (k, v) => { const n = new URLSearchParams(sp); if (v && v !== 'all') n.set(k, v); else n.delete(k); setSp(n); };

  const columns = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'number', label: 'Journal #', render: (r) => <span className="bold">{r.number}</span> },
    { key: 'reference', label: 'Reference #', render: (r) => r.reference || '' },
    { key: 'status', label: 'Status', render: (r) => <Badge color={r.status === 'published' ? 'green' : 'gray'}>{r.status === 'published' ? 'Published' : 'Draft'}</Badge> },
    { key: 'notes', label: 'Notes', render: (r) => <span className="muted">{(r.notes || '').slice(0, 80)}</span> },
    { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total) },
  ];

  return (
    <div className="page">
      <PageHeader title="Manual Journals" subtitle="Post adjustments straight to the ledger."
        actions={<>
          <Link className="btn btn-secondary" to="/accountant/recurring-journals">Recurring Journals</Link>
          {can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/journals/new')}>+ New Journal</Button>}
        </>}>
        <Tabs active={status} onChange={(s) => setParam('status', s)} tabs={[{ key: 'all', label: 'All' }, { key: 'published', label: 'Published' }, { key: 'draft', label: 'Draft' }]} />
        <SearchBox value={q} placeholder="Search journals" onChange={(v) => setParam('q', v)} />
      </PageHeader>
      {!loading && !rows.length && !q && status === 'all'
        ? <Empty title="No journals yet" text="Create a manual journal to record an adjustment." action={can('accountant', 'create') && <Button variant="primary" onClick={() => nav('/accountant/journals/new')}>+ New Journal</Button>} />
        : <Table columns={columns} rows={rows} loading={loading} onRowClick={(r) => nav(`/accountant/journals/${r.id}`)} empty="No journals match these filters." />}
    </div>
  );
}
