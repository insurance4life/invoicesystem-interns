import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { Button, PageHeader, Table, Badge, SearchBox, Select } from '../../components/ui.jsx';
import { BILLING_LABEL, PROJECT_STATUS, hrs } from './util.js';

export default function ProjectList() {
  const { can } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const { data, loading, error } = useFetch('/projects', { q, status });

  const columns = [
    {
      key: 'name',
      label: 'Project',
      render: (r) => (
        <div>
          <div className="bold">{r.name}</div>
          {r.code && <div className="muted small">{r.code}</div>}
        </div>
      ),
    },
    { key: 'customer', label: 'Customer', render: (r) => r.customer_name || <span className="muted">—</span> },
    { key: 'billing', label: 'Billing', render: (r) => BILLING_LABEL[r.billing_method] || r.billing_method },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'logged', label: 'Logged (h)', align: 'right', render: (r) => hrs(r.logged_hours) },
    { key: 'unbilled', label: 'Unbilled (h)', align: 'right', render: (r) => hrs(r.unbilled_hours) },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Track time and expenses against customer work, then bill them."
        actions={(
          <>
            <Link className="btn btn-secondary" to="/time/timesheet">Timesheet</Link>
            {can('projects', 'create') && <Link className="btn btn-primary" to="/time/projects/new">+ New Project</Link>}
          </>
        )}
      >
        <SearchBox value={q} onChange={setQ} placeholder="Search projects or customers" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}
          options={[['all', 'All projects'], ...PROJECT_STATUS]} />
      </PageHeader>

      {error && <div className="callout warn">{error.message}</div>}
      <Table
        columns={columns}
        rows={data || []}
        loading={loading}
        onRowClick={(r) => nav(`/time/projects/${r.id}`)}
        empty={q || status !== 'all' ? 'No projects match these filters.' : 'No projects yet. Create one to start tracking time.'}
      />
      {!loading && can('projects', 'create') && !(data || []).length && !q && (
        <div className="center mt"><Button variant="primary" onClick={() => nav('/time/projects/new')}>Create your first project</Button></div>
      )}
    </div>
  );
}
