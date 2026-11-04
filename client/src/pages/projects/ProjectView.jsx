import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import {
  Button, Badge, Card, Checkbox, Field, Input, Menu, Modal, PageHeader, Stat, Table, Tabs, Textarea, NumberInput, Empty, KeyValue, errorMessage,
} from '../../components/ui.jsx';
import { fmtDate, today, addDays, statusLabel } from '../../lib/format.js';
import { BILLING_LABEL, hrs, hm } from './util.js';
import TimeEntryModal from './TimeEntryModal.jsx';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'invoices', label: 'Invoices' },
];

export default function ProjectView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, money, date, toast } = useApp();
  const [tab, setTab] = useState('overview');
  const [logOpen, setLogOpen] = useState(null); // null | {} (new) | entry (edit)
  const [taskOpen, setTaskOpen] = useState(null); // null | {} | task
  const [invOpen, setInvOpen] = useState(false);

  const proj = useFetch(`/projects/${id}`);
  const entries = useFetch(tab === 'timesheets' ? '/time-entries' : null, { project_id: id });
  const expenses = useFetch(tab === 'expenses' ? '/expenses' : null, { project_id: id });
  const invoices = useFetch(tab === 'invoices' ? '/documents/invoice' : null, { project_id: id, per_page: 200 });

  const p = proj.data;
  if (proj.error) return <div className="page"><div className="empty"><h3>{proj.error.message}</h3><Link to="/time/projects">Back to projects</Link></div></div>;
  if (!p) return <div className="center pad"><span className="spin" /></div>;
  const t = p.totals;
  const fin = 'profit' in t; // cost and profit come back only to roles that can view reports
  const reloadAll = () => { proj.reload(); entries.reload(); };

  const act = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg); reloadAll(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const approve = (e, ok) => act(() => api.post(`/time-entries/${e.id}/${ok ? 'approve' : 'reject'}`), ok ? 'Time approved' : 'Time rejected');
  const removeEntry = (e) => { if (window.confirm('Delete this time entry?')) act(() => api.del(`/time-entries/${e.id}`), 'Time entry deleted'); };
  const removeProject = async () => {
    if (!window.confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
    try { await api.del(`/projects/${p.id}`); toast('Project deleted'); nav('/time/projects'); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const budgetPct = t.budget_percent;
  const over = budgetPct != null && budgetPct > 100;

  return (
    <div className="page">
      <PageHeader
        back={<Link to="/time/projects" className="btn btn-link" aria-label="Back">←</Link>}
        title={p.name}
        subtitle={[p.code, p.customer_name, BILLING_LABEL[p.billing_method], statusLabel(p.status)].filter(Boolean).join(' · ')}
        actions={(
          <>
            {can('projects', 'create') && <Button onClick={() => setLogOpen({})}>+ Log time</Button>}
            {can('sales', 'create') && <Button variant="primary" onClick={() => setInvOpen(true)}>Create invoice</Button>}
            {can('projects', 'edit') && <Link className="btn btn-secondary" to={`/time/projects/${p.id}/edit`}>Edit</Link>}
            {can('projects', 'delete') && <Menu items={[{ label: 'Delete project', danger: true, onClick: removeProject }]} />}
          </>
        )}
      />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="stack">
          <div className="grid4">
            <Stat label="Logged hours" value={hrs(t.logged_hours)} sub={`${hrs(t.billable_hours)} billable`} />
            <Stat label="Unbilled hours" value={hrs(t.unbilled_hours)} sub="ready to invoice" tone={t.unbilled_hours > 0 ? 'orange' : undefined} />
            {fin && <Stat label="Billed amount" value={money(t.billed_amount)} sub="invoiced, excluding tax" />}
            {fin && <Stat label="Profit" value={money(t.profit)} sub={`cost ${money(t.cost)}`} tone={t.profit < 0 ? 'red' : 'green'} />}
          </div>

          {t.budget_type !== 'none' && t.budget != null && (
            <Card title={t.budget_type === 'hours' ? 'Hours budget' : 'Amount budget'}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <span>
                  {t.budget_type === 'hours' ? `${hrs(t.logged_hours)} of ${hrs(t.budget)} hours used` : `${money(t.budget_used)} of ${money(t.budget)} invoiced`}
                </span>
                <span className={over ? 'neg bold' : 'bold'}>{budgetPct == null ? '' : `${budgetPct}%`}</span>
              </div>
              <div style={{ height: 8, background: 'var(--line2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, budgetPct || 0)}%`, height: '100%', background: over ? 'var(--red)' : 'var(--primary)' }} />
              </div>
            </Card>
          )}

          <div className="grid2" style={{ alignItems: 'start' }}>
            {fin && <Card title="Profitability">
              <KeyValue items={[
                ['Invoiced revenue', money(t.revenue)],
                ['Expenses', money(t.expenses_amount)],
                ['Labour cost', money(t.labor_cost)],
                ['Profit', <span className={t.profit < 0 ? 'neg bold' : 'bold'}>{money(t.profit)}</span>],
              ]} />
              <p className="muted small" style={{ marginBottom: 0 }}>Profit = invoiced revenue − (expenses + logged hours × staff cost rate).</p>
            </Card>}
            <Card title="Team">
              <Table
                columns={[
                  { key: 'name', label: 'Name' },
                  { key: 'rate', label: 'Billing rate', align: 'right', render: (u) => money(u.rate) },
                  fin && { key: 'cost_rate', label: 'Cost rate', align: 'right', render: (u) => money(u.cost_rate) },
                ].filter(Boolean)}
                rows={p.users}
                rowKey="user_id"
                empty="No one is assigned to this project."
              />
            </Card>
          </div>

          {p.description && <Card title="Description"><div style={{ whiteSpace: 'pre-wrap' }}>{p.description}</div></Card>}
        </div>
      )}

      {tab === 'timesheets' && (
        <div className="stack">
          <div className="row between">
            <span className="muted small">{hrs(t.logged_hours)} h logged · {hrs(t.unbilled_hours)} h unbilled</span>
            {can('projects', 'create') && <Button size="sm" variant="primary" onClick={() => setLogOpen({})}>+ Log time</Button>}
          </div>
          <Table
            columns={[
              { key: 'date', label: 'Date', render: (e) => date(e.date) },
              { key: 'user', label: 'Person', render: (e) => e.user_name || '—' },
              { key: 'task', label: 'Task', render: (e) => e.task_name || <span className="muted">—</span> },
              { key: 'notes', label: 'Notes', render: (e) => <span className="small">{e.notes || ''}</span> },
              { key: 'hours', label: 'Hours', align: 'right', render: (e) => (e.timer_started_at ? <Badge color="blue">running</Badge> : hrs(e.hours)) },
              { key: 'billable', label: 'Billable', render: (e) => (e.billable ? 'Yes' : <span className="muted">No</span>) },
              { key: 'status', label: 'Status', render: (e) => (e.invoice_id ? <Badge status="invoiced">{`Invoiced ${e.invoice_number || ''}`.trim()}</Badge> : <Badge status={e.approval_status === 'rejected' ? 'rejected' : 'approved'} />) },
              {
                key: 'actions',
                label: '',
                render: (e) => (
                  <span onClick={(ev) => ev.stopPropagation()} className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                    {can('projects', 'approve') && !e.invoice_id && (e.approval_status === 'rejected'
                      ? <Button size="sm" onClick={() => approve(e, true)}>Approve</Button>
                      : <Button size="sm" onClick={() => approve(e, false)}>Reject</Button>)}
                    {!e.invoice_id && <Button size="sm" variant="link" onClick={() => removeEntry(e)} className="btn-danger">Delete</Button>}
                  </span>
                ),
              },
            ]}
            rows={entries.data || []}
            loading={entries.loading}
            onRowClick={(e) => !e.invoice_id && setLogOpen(e)}
            empty="No time logged on this project yet."
            footer={entries.data?.length ? (
              <tr>
                <td colSpan={4} className="r">Total</td>
                <td className="r">{hrs((entries.data || []).reduce((s, e) => s + e.hours, 0))}</td>
                <td colSpan={3} />
              </tr>
            ) : null}
          />
        </div>
      )}

      {tab === 'tasks' && (
        <div className="stack">
          <div className="row between">
            <span className="muted small">Tasks let you bill time at a specific rate. Change them on the project's edit page for bulk edits.</span>
            {can('projects', 'edit') && <Button size="sm" variant="primary" onClick={() => setTaskOpen({})}>+ Add task</Button>}
          </div>
          <Table
            columns={[
              { key: 'name', label: 'Task', render: (x) => <span className="bold">{x.name}</span> },
              { key: 'description', label: 'Description' },
              { key: 'rate', label: 'Rate', align: 'right', render: (x) => money(x.rate) },
              { key: 'billable', label: 'Billable', render: (x) => (x.billable ? 'Yes' : <span className="muted">No</span>) },
              {
                key: 'actions',
                label: '',
                render: (x) => (
                  <span onClick={(ev) => ev.stopPropagation()} className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                    {can('projects', 'edit') && <Button size="sm" variant="link" onClick={() => setTaskOpen(x)}>Edit</Button>}
                    {can('projects', 'delete') && <Button size="sm" variant="link" className="btn-danger"
                      onClick={() => window.confirm(`Delete task "${x.name}"? Its time entries stay on the project.`) && act(() => api.del(`/projects/${p.id}/tasks/${x.id}`), 'Task deleted')}>Delete</Button>}
                  </span>
                ),
              },
            ]}
            rows={p.tasks}
            empty="No tasks yet."
          />
        </div>
      )}

      {tab === 'expenses' && (
        <div className="stack">
          <div className="row between">
            <span className="muted small">Expenses linked to this project. Billable ones can be added to an invoice.</span>
            {can('purchases', 'create') && (
              <Link className="btn btn-primary btn-sm" to={`/expenses/new?project_id=${p.id}${p.customer_id ? `&customer_id=${p.customer_id}` : ''}`}>+ New expense</Link>
            )}
          </div>
          <Table
            columns={[
              { key: 'date', label: 'Date', render: (x) => date(x.date) },
              { key: 'account', label: 'Category', render: (x) => x.account_name || '—' },
              { key: 'reference', label: 'Reference', render: (x) => x.reference || <span className="muted">—</span> },
              { key: 'billable', label: 'Billable', render: (x) => (x.is_billable ? `Yes · +${x.markup_percent || 0}%` : 'No') },
              { key: 'status', label: 'Status', render: (x) => <Badge status={x.status} /> },
              { key: 'total', label: 'Amount', align: 'right', render: (x) => money(x.total) },
            ]}
            rows={expenses.data || []}
            loading={expenses.loading}
            onRowClick={(x) => nav(`/expenses/${x.id}`)}
            empty="No expenses recorded for this project."
          />
        </div>
      )}

      {tab === 'invoices' && (
        <div className="stack">
          <div className="row between">
            <span className="muted small">Invoices raised for this project.</span>
            {can('sales', 'create') && <Button size="sm" variant="primary" onClick={() => setInvOpen(true)}>Create invoice</Button>}
          </div>
          <Table
            columns={[
              { key: 'number', label: 'Invoice #', render: (x) => <span className="bold">{x.number}</span> },
              { key: 'date', label: 'Date', render: (x) => date(x.date) },
              { key: 'due_date', label: 'Due', render: (x) => date(x.due_date) },
              { key: 'total', label: 'Total', align: 'right', render: (x) => money(x.total) },
              { key: 'balance', label: 'Balance', align: 'right', render: (x) => money(x.balance) },
              { key: 'display_status', label: 'Status', render: (x) => <Badge status={x.display_status} /> },
            ]}
            rows={invoices.data?.rows || []}
            loading={invoices.loading}
            onRowClick={(x) => nav(`/invoices/${x.id}`)}
            empty="No invoices yet. Create one from unbilled time and expenses."
          />
        </div>
      )}

      {logOpen && (
        <TimeEntryModal
          projectId={p.id}
          entry={logOpen.id ? logOpen : undefined}
          onClose={() => setLogOpen(null)}
          onSaved={reloadAll}
        />
      )}
      {taskOpen && <TaskModal projectId={p.id} task={taskOpen.id ? taskOpen : undefined} onClose={() => setTaskOpen(null)} onSaved={proj.reload} />}
      {invOpen && <InvoiceModal project={p} onClose={() => setInvOpen(false)} />}
    </div>
  );
}

function TaskModal({ projectId, task, onClose, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(task?.name || '');
  const [description, setDescription] = useState(task?.description || '');
  const [rate, setRate] = useState(task?.rate ?? '');
  const [billable, setBillable] = useState(task ? !!task.billable : true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast('Enter a task name', 'error');
    const body = { name: name.trim(), description: description || null, rate: Number(rate) || 0, billable: billable ? 1 : 0 };
    setBusy(true);
    try {
      if (task) await api.put(`/projects/${projectId}/tasks/${task.id}`, body);
      else await api.post(`/projects/${projectId}/tasks`, body);
      toast(task ? 'Task updated' : 'Task added');
      onSaved?.();
      onClose();
    } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={task ? 'Edit Task' : 'New Task'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Field label="Task name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Rate" hint="Used for task-hours billing">
          <NumberInput min="0" value={rate} onChange={setRate} />
        </Field>
        <Checkbox label="Billable" checked={billable} onChange={setBillable} />
      </div>
    </Modal>
  );
}

function InvoiceModal({ project, onClose }) {
  const nav = useNavigate();
  const { toast } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [date, setDate] = useState(today());
  const [expenses, setExpenses] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const doc = await api.post(`/projects/${project.id}/invoice`, {
        from: from || undefined, to: to || undefined, date, include_expenses: expenses,
      });
      toast(`Draft invoice ${doc.number} created`);
      nav(`/invoices/${doc.id}/edit`);
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create invoice from project"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create draft invoice</Button></>}
    >
      <div className="stack">
        <p className="muted small" style={{ marginTop: 0 }}>
          Unbilled, billable time{expenses ? ' and expenses' : ''} for <b>{project.customer_name || 'the project'}</b> become draft invoice lines. Review and send the draft afterwards.
        </p>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <Field label="Work from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Work to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Invoice date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Checkbox label="Include billable expenses" checked={expenses} onChange={setExpenses} />
        <div className="muted small">Billing method: {BILLING_LABEL[project.billing_method]}</div>
      </div>
    </Modal>
  );
}
