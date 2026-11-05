import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Button, Field, Input, Textarea, NumberInput, Select, Checkbox, Combo, Card, errorMessage } from '../../components/ui.jsx';
import { BILLING, BILLING_HELP, PROJECT_STATUS, BUDGET } from './util.js';

const blank = () => ({
  name: '', code: '', customer_id: '', billing_method: 'project_hours', rate: '', budget_type: 'none',
  budget_hours: '', budget_amount: '', description: '', status: 'active', users: [], tasks: [],
});

function fromProject(p) {
  return {
    name: p.name || '', code: p.code || '', customer_id: p.customer_id || '', billing_method: p.billing_method || 'project_hours',
    hiddenRates: !('rate' in p), // rates come back only to roles that can view reports
    rate: p.rate ?? '', budget_type: p.budget_type || 'none', budget_hours: p.budget_hours || '', budget_amount: p.budget_amount || '',
    description: p.description || '', status: p.status || 'active',
    users: (p.users || []).map((u) => ({ user_id: u.user_id, rate: u.rate ?? '', cost_rate: u.cost_rate ?? '' })),
    tasks: (p.tasks || []).map((t) => ({ id: t.id, name: t.name, description: t.description || '', rate: t.rate ?? '', billable: !!t.billable })),
  };
}

export default function ProjectForm() {
  const { id } = useParams();
  const isEdit = !!id;
  const nav = useNavigate();
  const { meta, toast } = useApp();
  const existing = useFetch(isEdit ? `/projects/${id}` : null);
  const customers = useFetch('/contacts', { type: 'customer', per_page: 500 });
  const [f, setF] = useState(() => (isEdit ? null : blank()));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (isEdit && existing.data && !f) setF(fromProject(existing.data));
  }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!f) return <div className="center pad"><span className="spin" /></div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });

  const staff = (meta?.users || []).filter((u) => u.status === 'active');
  const customerOptions = (customers.data || []).map((c) => ({ value: c.id, label: c.display_name, sub: c.company_name || c.email }));
  const rateLabel = f.billing_method === 'fixed' ? 'Fixed fee amount' : f.billing_method === 'project_hours' ? 'Hourly rate' : 'Default hourly rate';

  const toggleUser = (uid, on) => setF({
    ...f,
    users: on ? [...f.users, { user_id: uid, rate: '', cost_rate: '' }] : f.users.filter((u) => u.user_id !== uid),
  });
  const setUser = (uid, k, v) => setF({ ...f, users: f.users.map((u) => (u.user_id === uid ? { ...u, [k]: v } : u)) });
  const setTask = (i, k, v) => setF({ ...f, tasks: f.tasks.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });
  const addTask = () => setF({ ...f, tasks: [...f.tasks, { name: '', description: '', rate: '', billable: true }] });
  const removeTask = (i) => setF({ ...f, tasks: f.tasks.filter((_, j) => j !== i) });

  const save = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!f.name.trim()) errs.name = 'Enter a project name';
    if (f.tasks.some((t) => !t.name.trim() && (t.name !== '' || t.rate !== ''))) errs.tasks = 'Every task needs a name';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = {
      name: f.name.trim(),
      code: f.code.trim() || null,
      customer_id: f.customer_id || null,
      billing_method: f.billing_method,
      ...(f.hiddenRates ? {} : { rate: Number(f.rate) || 0 }),
      budget_type: f.budget_type,
      budget_hours: f.budget_type === 'hours' ? Number(f.budget_hours) || 0 : 0,
      ...(f.hiddenRates ? {} : { budget_amount: f.budget_type === 'amount' ? Number(f.budget_amount) || 0 : 0 }),
      description: f.description || null,
      status: f.status,
      users: f.users.map((u) => (f.hiddenRates ? { user_id: u.user_id } : { user_id: u.user_id, rate: Number(u.rate) || 0, cost_rate: Number(u.cost_rate) || 0 })),
      tasks: f.tasks.filter((t) => t.name.trim()).map((t) => ({ id: t.id, name: t.name.trim(), description: t.description || null, ...(f.hiddenRates && t.id ? {} : { rate: Number(t.rate) || 0 }), billable: t.billable ? 1 : 0 })),
    };
    setBusy(true);
    try {
      const p = isEdit ? await api.put(`/projects/${id}`, body) : await api.post('/projects', body);
      toast(isEdit ? 'Project updated' : 'Project created');
      nav(`/time/projects/${p.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    setBusy(false);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-row">
          <div className="page-title">
            <h1>{isEdit ? 'Edit Project' : 'New Project'}</h1>
          </div>
          <div className="page-actions">
            <Link className="btn btn-secondary" to={isEdit ? `/time/projects/${id}` : '/time/projects'}>Back</Link>
          </div>
        </div>
      </div>

      <form onSubmit={save} noValidate>
        <div className="form-section">
          <h3>Project details</h3>
          <div className="form-grid">
            <Field label="Project name" required error={errors.name}>
              <Input value={f.name} onChange={set('name')} autoFocus />
            </Field>
            <Field label="Project code" hint="Optional short code, e.g. WEB-01">
              <Input value={f.code} onChange={set('code')} />
            </Field>
            <Field label="Customer" hint="Invoices from this project are raised to this customer">
              <Combo value={f.customer_id} onChange={(v) => setF({ ...f, customer_id: v })} options={customerOptions} placeholder="Select a customer" />
            </Field>
            <Field label="Status">
              <Select value={f.status} onChange={set('status')} options={PROJECT_STATUS} />
            </Field>
            <Field label="Description" className="full">
              <Textarea value={f.description} onChange={set('description')} />
            </Field>
          </div>
        </div>

        <div className="form-section">
          <h3>Billing</h3>
          <div className="form-grid">
            <Field label="Billing method">
              <Select value={f.billing_method} onChange={set('billing_method')} options={BILLING} />
            </Field>
            <Field label={rateLabel} hint={BILLING_HELP[f.billing_method]}>
              <NumberInput value={f.rate} onChange={(v) => setF({ ...f, rate: v })} min="0" />
            </Field>
            <Field label="Budget">
              <Select value={f.budget_type} onChange={set('budget_type')} options={BUDGET} />
            </Field>
            {f.budget_type === 'hours' && (
              <Field label="Budget hours"><NumberInput value={f.budget_hours} onChange={(v) => setF({ ...f, budget_hours: v })} min="0" /></Field>
            )}
            {f.budget_type === 'amount' && (
              <Field label="Budget amount" hint="Compared with the invoiced amount"><NumberInput value={f.budget_amount} onChange={(v) => setF({ ...f, budget_amount: v })} min="0" /></Field>
            )}
          </div>
        </div>

        <div className="form-section">
          <h3>Team</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Choose who works on this project. The billing rate is used for staff-hours billing; the cost rate measures profitability.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th style={{ width: 40 }} /><th>Name</th><th>Role</th><th className="r">Billing rate</th><th className="r">Cost rate</th></tr>
              </thead>
              <tbody>
                {staff.map((u) => {
                  const on = f.users.find((x) => x.user_id === u.id);
                  return (
                    <tr key={u.id}>
                      <td><input type="checkbox" checked={!!on} onChange={(e) => toggleUser(u.id, e.target.checked)} /></td>
                      <td>{u.name}</td>
                      <td className="muted">{u.role}</td>
                      <td className="r">{on && <NumberInput value={on.rate} onChange={(v) => setUser(u.id, 'rate', v)} style={{ width: 120 }} />}</td>
                      <td className="r">{on && <NumberInput value={on.cost_rate} onChange={(v) => setUser(u.id, 'cost_rate', v)} style={{ width: 120 }} />}</td>
                    </tr>
                  );
                })}
                {!staff.length && <tr><td colSpan={5} className="muted center">No team members yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="form-section">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Tasks</h3>
            <Button size="sm" onClick={addTask}>+ Add task</Button>
          </div>
          {errors.tasks && <div className="field-error" style={{ marginBottom: 8 }}>{errors.tasks}</div>}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Task</th><th>Description</th><th className="r" style={{ width: 140 }}>Rate</th><th style={{ width: 90 }}>Billable</th><th style={{ width: 60 }} /></tr>
              </thead>
              <tbody>
                {f.tasks.map((t, i) => (
                  <tr key={t.id || `new-${i}`}>
                    <td><Input value={t.name} onChange={(e) => setTask(i, 'name', e.target.value)} placeholder="e.g. Design" /></td>
                    <td><Input value={t.description} onChange={(e) => setTask(i, 'description', e.target.value)} /></td>
                    <td className="r"><NumberInput value={t.rate} onChange={(v) => setTask(i, 'rate', v)} /></td>
                    <td><input type="checkbox" checked={t.billable} onChange={(e) => setTask(i, 'billable', e.target.checked)} /></td>
                    <td><Button variant="link" className="btn-danger" onClick={() => removeTask(i)}>Remove</Button></td>
                  </tr>
                ))}
                {!f.tasks.length && <tr><td colSpan={5} className="muted center">No tasks. Time can still be logged against the project.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="form-foot">
          <Button variant="primary" type="submit" loading={busy}>{isEdit ? 'Save changes' : 'Create project'}</Button>
          <Button onClick={() => nav(isEdit ? `/time/projects/${id}` : '/time/projects')}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}
