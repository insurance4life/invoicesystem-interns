import { useState } from 'react';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Button, Field, Input, Textarea, NumberInput, Select, Checkbox, Combo, Modal, errorMessage } from '../../components/ui.jsx';
import { today } from '../../lib/format.js';
import { hm } from './util.js';

/**
 * Log or edit a time entry. Pass `projectId` to lock the project, `entry` to edit an existing entry.
 * `onSaved(entry)` is called after the server accepts the change.
 */
export default function TimeEntryModal({ projectId, entry, onClose, onSaved, defaultDate }) {
  const { meta, user, can, toast } = useApp();
  const locked = !!projectId || !!entry;
  const projects = useFetch(locked ? null : '/projects', { status: 'active' });
  const [pid, setPid] = useState(String(entry?.project_id || projectId || ''));
  const detail = useFetch(pid ? `/projects/${pid}` : null);
  const [tid, setTid] = useState(entry?.task_id ? String(entry.task_id) : '');
  const [date, setDate] = useState(entry?.date || defaultDate || today());
  const [hours, setHours] = useState(entry ? String(Math.round((entry.minutes / 60) * 100) / 100) : '1');
  const [notes, setNotes] = useState(entry?.notes || '');
  const [billable, setBillable] = useState(entry ? !!entry.billable : true);
  const [userId, setUserId] = useState(String(entry?.user_id || user?.id || ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const projectOptions = (projects.data || []).map((p) => ({ value: p.id, label: p.name, sub: p.customer_name }));
  const tasks = detail.data?.tasks || [];
  const taskOptions = tasks.map((t) => ({ value: t.id, label: t.name, sub: t.rate ? `rate ${t.rate}` : null }));
  const chosenTask = tasks.find((t) => String(t.id) === String(tid));
  const h = Number(hours) || 0;

  const pickTask = (v) => {
    setTid(v ? String(v) : '');
    const t = tasks.find((x) => String(x.id) === String(v));
    if (t) setBillable(!!t.billable);
  };

  const save = async () => {
    setErr('');
    if (!pid) return setErr('Choose a project');
    if (!(h > 0)) return setErr('Enter the time spent (more than zero)');
    if (h > 24) return setErr('A single entry can be at most 24 hours');
    const body = {
      project_id: Number(pid),
      task_id: tid ? Number(tid) : null,
      date,
      hours: h,
      notes: notes || null,
      billable: billable ? 1 : 0,
    };
    if (userId && Number(userId) !== user?.id) body.user_id = Number(userId);
    setBusy(true);
    try {
      const saved = entry ? await api.put(`/time-entries/${entry.id}`, body) : await api.post('/time-entries', body);
      toast(entry ? 'Time entry updated' : 'Time logged');
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <Modal
      title={entry ? 'Edit Time Entry' : 'Log Time'}
      onClose={onClose}
      width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{entry ? 'Save' : 'Log time'}</Button></>}
    >
      <div className="stack">
        {err && <div className="callout warn" style={{ marginBottom: 0 }}>{err}</div>}
        <Field label="Project" required>
          {locked
            ? <div className="bold">{entry?.project_name || detail.data?.name || '—'}</div>
            : <Combo value={pid} onChange={(v) => { setPid(String(v || '')); setTid(''); }} options={projectOptions} placeholder="Select a project" />}
        </Field>
        <Field label="Task">
          <Combo value={tid} onChange={(v) => pickTask(v)} options={taskOptions} placeholder={pid ? 'No task' : 'Choose a project first'} disabled={!pid} />
        </Field>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <Field label="Date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Hours" required hint={h > 0 ? `${hm(h * 60)} (h:mm)` : 'e.g. 1.5 = 1 h 30 min'}>
            <NumberInput min="0" max="24" step="0.25" value={hours} onChange={setHours} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you work on?" />
        </Field>
        <div className="row">
          <Checkbox label="Billable" checked={billable} onChange={setBillable} />
          {chosenTask && !chosenTask.billable && <span className="muted small">This task is non-billable.</span>}
        </div>
        {can('projects', 'approve') && (
          <Field label="Logged by">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}
              options={(meta?.users || []).filter((u) => u.status === 'active').map((u) => [u.id, u.name])} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
