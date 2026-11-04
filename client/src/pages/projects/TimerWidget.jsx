import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Button, Combo, Input, errorMessage } from '../../components/ui.jsx';
import { clock } from './util.js';

/** Start/stop a timer for one project and task. The running timer is kept on the server, so it survives reloads. */
export default function TimerWidget({ onChange }) {
  const { toast } = useApp();
  const [running, setRunning] = useState(undefined); // undefined while loading, null when idle
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [notes, setNotes] = useState('');
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const projects = useFetch('/projects', { status: 'active' });
  const detail = useFetch(projectId ? `/projects/${projectId}` : null);

  useEffect(() => {
    api.get('/time-entries/timer').then((e) => { setRunning(e); setNotes(e?.notes || ''); }).catch(() => setRunning(null));
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const start = async () => {
    if (!projectId) return toast('Choose a project to start the timer', 'error');
    setBusy(true);
    try {
      const e = await api.post('/time-entries/timer/start', { project_id: Number(projectId), task_id: taskId ? Number(taskId) : null, notes: notes || null });
      setRunning(e);
      onChange?.();
    } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.post('/time-entries/timer/stop', { notes: notes || null });
      setRunning(null);
      setNotes('');
      toast('Timer stopped. Time saved.');
      onChange?.();
    } catch (e) { toast(errorMessage(e), 'error'); }
    setBusy(false);
  };

  const projectOptions = (projects.data || []).map((p) => ({ value: p.id, label: p.name, sub: p.customer_name }));
  const taskOptions = (detail.data?.tasks || []).map((t) => ({ value: t.id, label: t.name }));

  if (running === undefined) return <div className="card card-body muted">Loading timer…</div>;

  if (running) {
    const elapsed = clock(now - Date.parse(running.timer_started_at));
    return (
      <div className="card" style={{ borderColor: 'var(--green)' }}>
        <div className="card-body row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="muted small">Timer running · {running.project_name}{running.task_name ? ` · ${running.task_name}` : ''}</div>
            <div style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{elapsed}</div>
          </div>
          <div className="row grow" style={{ justifyContent: 'flex-end', maxWidth: 520 }}>
            <Input placeholder="What are you working on?" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ maxWidth: 280 }} />
            <Button variant="danger" loading={busy} onClick={stop}>■ Stop</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-body row">
        <div style={{ width: 240 }}>
          <Combo value={projectId} onChange={(v) => { setProjectId(v ? String(v) : ''); setTaskId(''); }} options={projectOptions} placeholder="Project" />
        </div>
        <div style={{ width: 200 }}>
          <Combo value={taskId} onChange={(v) => setTaskId(v ? String(v) : '')} options={taskOptions} placeholder={projectId ? 'Task (optional)' : 'Choose a project'} disabled={!projectId} />
        </div>
        <Input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} className="grow" style={{ minWidth: 160 }} />
        <Button variant="primary" loading={busy} onClick={start}>▶ Start timer</Button>
      </div>
    </div>
  );
}
