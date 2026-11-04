import { useState } from 'react';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Button, Badge, Combo, PageHeader, Select, Table, Tabs, errorMessage } from '../../components/ui.jsx';
import { addDays, today } from '../../lib/format.js';
import { DOW, hrs, weekDays, weekStart } from './util.js';
import TimeEntryModal from './TimeEntryModal.jsx';
import TimerWidget from './TimerWidget.jsx';

const keyOf = (x) => `${x.project_id}:${x.task_id || 0}`;

export default function Timesheet() {
  const { can, meta, user, date, toast } = useApp();
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(today());
  const [userId, setUserId] = useState(String(user?.id || ''));
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [extra, setExtra] = useState([]); // rows added in the grid before any time is logged on them
  const [modal, setModal] = useState(null); // null | 'new' | entry

  const projects = useFetch('/projects', { status: 'all' });
  const wStart = weekStart(anchor);
  const wEnd = addDays(wStart, 6);
  const days = weekDays(wStart);
  const list = useFetch('/time-entries', {
    ...(view === 'week' ? { from: wStart, to: wEnd } : { from, to }),
    user_id: (view === 'week' ? userId || user?.id : userId) || undefined,
    project_id: projectId || undefined,
  });
  const rows = list.data || [];
  const gridUser = Number(userId || user?.id);
  const gridEntries = rows.filter((e) => e.user_id === gridUser);
  const staff = (meta?.users || []).filter((u) => u.status === 'active');

  // ----- week grid -----
  const rowMap = new Map();
  for (const e of gridEntries) if (!rowMap.has(keyOf(e))) rowMap.set(keyOf(e), { key: keyOf(e), project_id: e.project_id, project_name: e.project_name, task_id: e.task_id || 0, task_name: e.task_name });
  for (const x of extra) {
    if (projectId && String(x.project_id) !== projectId) continue;
    if (!rowMap.has(keyOf(x))) rowMap.set(keyOf(x), { key: keyOf(x), ...x });
  }
  const gridRows = [...rowMap.values()].sort((a, b) => (a.project_name || '').localeCompare(b.project_name || '') || (a.task_name || '').localeCompare(b.task_name || ''));

  const cellEntries = (row, iso) => gridEntries.filter((e) => keyOf(e) === row.key && e.date === iso);
  const cellHours = (row, iso) => cellEntries(row, iso).reduce((s, e) => s + (Number(e.minutes) || 0), 0) / 60;
  const rowTotal = (row) => days.reduce((s, d) => s + cellHours(row, d), 0);
  const dayTotal = (iso) => gridRows.reduce((s, r) => s + cellHours(r, iso), 0);
  const weekTotal = days.reduce((s, d) => s + dayTotal(d), 0);

  const saveCell = async (row, iso, raw) => {
    const v = raw === '' ? 0 : Number(raw);
    if (!(v >= 0 && v <= 24)) { toast('Enter hours between 0 and 24', 'error'); return list.reload(); }
    const es = cellEntries(row, iso);
    const current = es.reduce((s, e) => s + e.minutes, 0) / 60;
    if (Math.abs(current - v) < 0.001) return;
    if (es.some((e) => e.invoice_id)) { toast('This time has been invoiced and is locked', 'error'); return list.reload(); }
    if (es.some((e) => e.timer_started_at)) { toast('Stop the running timer before changing this day', 'error'); return list.reload(); }
    if (es.length > 1) { toast('Several entries on this day. Edit them in the list view.', 'error'); return list.reload(); }
    const minutes = Math.round(v * 60);
    try {
      if (es.length === 1) {
        if (minutes === 0) await api.del(`/time-entries/${es[0].id}`);
        else await api.put(`/time-entries/${es[0].id}`, { minutes });
      } else if (minutes > 0) {
        await api.post('/time-entries', {
          project_id: row.project_id, task_id: row.task_id || null, date: iso, minutes,
          user_id: gridUser !== user?.id ? gridUser : undefined,
        });
      }
    } catch (e) { toast(errorMessage(e), 'error'); }
    list.reload();
  };

  // ----- list view actions -----
  const act = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg); } catch (e) { toast(errorMessage(e), 'error'); }
    list.reload();
  };

  const listColumns = [
    { key: 'date', label: 'Date', render: (e) => date(e.date) },
    { key: 'project', label: 'Project', render: (e) => <span className="bold">{e.project_name}</span> },
    { key: 'task', label: 'Task', render: (e) => e.task_name || <span className="muted">—</span> },
    { key: 'user', label: 'Person', render: (e) => e.user_name || '—' },
    { key: 'notes', label: 'Notes', render: (e) => <span className="small">{e.notes || ''}</span> },
    { key: 'hours', label: 'Hours', align: 'right', render: (e) => (e.timer_started_at ? <Badge color="blue">running</Badge> : hrs(e.minutes / 60)) },
    { key: 'billable', label: 'Billable', render: (e) => (e.billable ? 'Yes' : <span className="muted">No</span>) },
    { key: 'status', label: 'Status', render: (e) => (e.invoice_id ? <Badge status="invoiced">Invoiced</Badge> : <Badge status={e.approval_status === 'rejected' ? 'rejected' : 'approved'} />) },
    {
      key: 'actions',
      label: '',
      render: (e) => (
        <span onClick={(ev) => ev.stopPropagation()} className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          {can('projects', 'approve') && !e.invoice_id && (e.approval_status === 'rejected'
            ? <Button size="sm" onClick={() => act(() => api.post(`/time-entries/${e.id}/approve`), 'Approved')}>Approve</Button>
            : <Button size="sm" onClick={() => act(() => api.post(`/time-entries/${e.id}/reject`), 'Rejected')}>Reject</Button>)}
          {!e.invoice_id && !e.timer_started_at && <Button size="sm" variant="link" onClick={() => setModal(e)}>Edit</Button>}
          {!e.invoice_id && <Button size="sm" variant="link" className="btn-danger"
            onClick={() => window.confirm('Delete this time entry?') && act(() => api.del(`/time-entries/${e.id}`), 'Deleted')}>Delete</Button>}
        </span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Timesheet"
        subtitle={view === 'week' ? `${hrs(weekTotal)} hours this week` : `${rows.length} entries`}
        actions={can('projects', 'create') && <Button variant="primary" onClick={() => setModal('new')}>+ Log time</Button>}
      >
        <Tabs tabs={[{ key: 'week', label: 'Week' }, { key: 'list', label: 'List' }]} active={view} onChange={setView} />
      </PageHeader>

      <TimerWidget onChange={list.reload} />

      <div className="row mt" style={{ marginTop: 16 }}>
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 200 }}
          placeholder={view === 'list' ? 'All people' : undefined}
          options={staff.map((u) => [String(u.id), u.name])} />
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 220 }} placeholder="All projects"
          options={(projects.data || []).map((p) => [String(p.id), p.name])} />
        {view === 'week' ? (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <Button size="sm" onClick={() => setAnchor(addDays(wStart, -7))} aria-label="Previous week">‹</Button>
            <Button size="sm" onClick={() => setAnchor(today())}>This week</Button>
            <Button size="sm" onClick={() => setAnchor(addDays(wStart, 7))} aria-label="Next week">›</Button>
            <b>{date(wStart)} – {date(wEnd)}</b>
          </div>
        ) : (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <span className="muted small">From</span>
            <input type="date" className="input" style={{ width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="muted small">to</span>
            <input type="date" className="input" style={{ width: 160 }} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
      </div>

      {view === 'week' ? (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>Project · Task</th>
                  {days.map((d, i) => (
                    <th key={d} className="r" style={{ width: 84, color: d === today() ? 'var(--primary)' : undefined }}>
                      {DOW[i]} {d.slice(8)}
                    </th>
                  ))}
                  <th className="r" style={{ width: 80 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <div className="bold">{row.project_name}</div>
                      <div className="muted small">{row.task_name || 'No task'}</div>
                    </td>
                    {days.map((iso) => {
                      const es = cellEntries(row, iso);
                      const locked = es.some((e) => e.invoice_id || e.timer_started_at) || es.length > 1;
                      const h = cellHours(row, iso);
                      const title = es.some((e) => e.invoice_id) ? 'Invoiced' : es.length > 1 ? 'Several entries: edit in list view' : '';
                      return (
                        <td key={iso} className="r">
                          <input
                            key={`${row.key}|${iso}|${h}`}
                            type="number" min="0" max="24" step="0.25" className="input num"
                            style={{ width: 70, textAlign: 'right', padding: '0 6px' }}
                            defaultValue={h ? String(Math.round(h * 100) / 100) : ''}
                            disabled={locked || !can('projects', 'create')}
                            title={title}
                            onBlur={(e) => saveCell(row, iso, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                          />
                        </td>
                      );
                    })}
                    <td className="r bold">{hrs(rowTotal(row))}</td>
                  </tr>
                ))}
                {!gridRows.length && !list.loading && (
                  <tr><td colSpan={9} className="center muted pad">No time this week. Start the timer, log time, or add a row below.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td>Daily total</td>
                  {days.map((iso) => <td key={iso} className="r">{hrs(dayTotal(iso))}</td>)}
                  <td className="r">{hrs(weekTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <AddRow projects={projects.data || []} onAdd={(row) => setExtra((x) => [...x, row])} />
          <div className="muted small">Type hours in a day and press Enter or click away to save. Invoiced days are locked.</div>
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <Table
            columns={listColumns}
            rows={rows}
            loading={list.loading}
            empty="No entries for these filters."
            footer={rows.length ? (
              <tr>
                <td colSpan={5} className="r">Total</td>
                <td className="r">{hrs(rows.reduce((s, e) => s + e.minutes, 0) / 60)}</td>
                <td colSpan={3} />
              </tr>
            ) : null}
          />
        </div>
      )}

      {modal === 'new' && <TimeEntryModal defaultDate={today()} onClose={() => setModal(null)} onSaved={list.reload} />}
      {modal && modal !== 'new' && <TimeEntryModal entry={modal} onClose={() => setModal(null)} onSaved={list.reload} />}
    </div>
  );
}

/** Adds a project/task row to the week grid so time can be typed into it. */
function AddRow({ projects, onAdd }) {
  const [pid, setPid] = useState('');
  const [tid, setTid] = useState('');
  const detail = useFetch(pid ? `/projects/${pid}` : null);
  const tasks = (detail.data?.tasks || []).map((t) => ({ value: t.id, label: t.name }));
  const add = () => {
    if (!pid) return;
    const t = (detail.data?.tasks || []).find((x) => String(x.id) === String(tid));
    onAdd({ project_id: Number(pid), project_name: detail.data?.name, task_id: tid ? Number(tid) : 0, task_name: t?.name || null });
    setPid(''); setTid('');
  };
  return (
    <div className="row">
      <div style={{ width: 260 }}>
        <Combo value={pid} onChange={(v) => { setPid(v ? String(v) : ''); setTid(''); }}
          options={projects.filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.name, sub: p.customer_name }))} placeholder="Add a project row" />
      </div>
      <div style={{ width: 200 }}>
        <Combo value={tid} onChange={(v) => setTid(v ? String(v) : '')} options={tasks} placeholder={pid ? 'Task (optional)' : 'Choose a project'} disabled={!pid} />
      </div>
      <Button size="sm" disabled={!pid} onClick={add}>Add row</Button>
    </div>
  );
}
