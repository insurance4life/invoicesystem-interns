import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Card, Field, Input, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt, Note } from './common.jsx';

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'];
const ACTION_LABELS = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve' };
const MODULE_LABELS = {
  contacts: 'Contacts', items: 'Items and inventory', sales: 'Sales', purchases: 'Purchases', banking: 'Banking',
  accountant: 'Accountant', reports: 'Reports', projects: 'Projects and time', documents: 'Documents', settings: 'Settings',
};

export default function RoleEditor() {
  const { id } = useParams();
  const { meta, toast, can, refreshMeta } = useApp();
  const role = useFetch(`/roles/${id}`);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (role.data) setForm({ name: role.data.name, description: role.data.description || '', permissions: role.data.permissions || {} });
  }, [role.data]);

  if (role.error) return <SettingsPage title="Role"><div className="callout warn">{role.error.message}</div></SettingsPage>;
  if (!form) return <SettingsPage title="Role"><div className="muted">Loading…</div></SettingsPage>;

  const locked = !!(role.data?.is_system && role.data?.name === 'Admin');
  const canEdit = can('settings', 'edit') && !locked;
  const modules = meta?.modules || Object.keys(MODULE_LABELS);
  const has = (m, a) => (form.permissions[m] || []).includes(a);

  // Choosing any action other than View also grants View, because the others are meaningless without it.
  const toggle = (m, a) => setForm((f) => {
    const cur = f.permissions[m] || [];
    let next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
    if (a !== 'view' && next.length && !next.includes('view')) next = ['view', ...next];
    const perms = { ...f.permissions, [m]: ACTIONS.filter((x) => next.includes(x)) };
    if (!perms[m].length) delete perms[m];
    return { ...f, permissions: perms };
  });

  const toggleRow = (m) => setForm((f) => {
    const perms = { ...f.permissions };
    if ((perms[m] || []).length === ACTIONS.length) delete perms[m];
    else perms[m] = [...ACTIONS];
    return { ...f, permissions: perms };
  });

  const save = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.put(`/roles/${id}`, form), 'Role saved');
    if (out) {
      role.reload();
      refreshMeta().catch(() => {});
    }
    setSaving(false);
  };

  return (
    <SettingsPage
      title={form.name || 'Role'}
      subtitle={locked ? 'The Admin role always has full access and cannot be changed.' : 'Choose what this role can view, create, edit, delete and approve.'}
      actions={canEdit && <Button variant="primary" loading={saving} onClick={save}>Save role</Button>}
    >
      <div className="form-section">
        <h3>Details</h3>
        <div className="form-grid">
          <Field label="Role name" required>
            <Input value={form.name} disabled={!canEdit} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={form.description} disabled={!canEdit} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
      </div>

      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Module</th>
                {ACTIONS.map((a) => <th key={a} className="center">{ACTION_LABELS[a]}</th>)}
                <th className="center">All</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => {
                const full = (form.permissions[m] || []).length === ACTIONS.length;
                return (
                  <tr key={m}>
                    <td className="bold">{MODULE_LABELS[m] || m}</td>
                    {ACTIONS.map((a) => (
                      <td key={a} className="center">
                        <input type="checkbox" checked={has(m, a)} disabled={!canEdit} onChange={() => toggle(m, a)}
                          aria-label={`${MODULE_LABELS[m] || m}: ${ACTION_LABELS[a]}`} />
                      </td>
                    ))}
                    <td className="center">
                      <input type="checkbox" checked={full} disabled={!canEdit} onChange={() => toggleRow(m)} aria-label={`${MODULE_LABELS[m] || m}: all`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Note>Users keep the access of their role. Saving applies to everyone who has this role.</Note>
    </SettingsPage>
  );
}
