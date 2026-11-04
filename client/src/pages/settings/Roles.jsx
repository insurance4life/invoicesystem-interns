import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Empty, Field, Input, Menu, Modal, Table, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt } from './common.jsx';

export default function Roles() {
  const { toast, can, refreshMeta } = useApp();
  const roles = useFetch('/roles');
  const nav = useNavigate();
  const [draft, setDraft] = useState(null); // { name, description }
  const [saving, setSaving] = useState(false);
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');

  const create = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.post('/roles', { name: draft.name, description: draft.description, permissions: {} }), 'Role created');
    setSaving(false);
    if (out) nav(`/settings/roles/${out.id}`);
  };

  const remove = async (role) => {
    if (!window.confirm(`Delete the role "${role.name}"?`)) return;
    const out = await attempt(toast, () => api.del(`/roles/${role.id}`), 'Role deleted');
    if (out) { roles.reload(); refreshMeta().catch(() => {}); }
  };

  const columns = [
    { key: 'name', label: 'Role', render: (r) => (
      <span>
        {r.name === 'Admin' && r.is_system ? <span className="bold">{r.name}</span> : <Link to={`/settings/roles/${r.id}`} className="bold">{r.name}</Link>}
        {r.is_system ? <span className="muted small"> · system</span> : null}
      </span>
    ) },
    { key: 'description', label: 'Description', render: (r) => <span className="muted">{r.description || '—'}</span> },
    { key: 'user_count', label: 'Users', align: 'right' },
    { key: 'status', label: 'Access', render: (r) => (r.name === 'Admin' && r.is_system ? <Badge color="blue">Full access</Badge> : <Badge color="gray">Custom</Badge>) },
    { key: 'actions', label: '', width: 60, render: (r) => (
      <Menu items={[
        { label: r.name === 'Admin' && r.is_system ? 'View permissions' : 'Edit permissions', onClick: () => nav(`/settings/roles/${r.id}`) },
        { label: 'Delete role', danger: true, hidden: !canDelete || r.is_system, onClick: () => remove(r) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Roles"
      subtitle="Permissions that decide what each user can see and do."
      actions={canCreate && <Button variant="primary" onClick={() => setDraft({ name: '', description: '' })}>+ New role</Button>}
    >
      <Card pad={false}>
        <Table columns={columns} rows={roles.data || []} loading={roles.loading}
          empty={<Empty title="No roles" text="Create a role to limit what people can access." />} />
      </Card>

      {draft && (
        <Modal title="New role" onClose={() => setDraft(null)} footer={<>
          <Button onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!draft.name.trim()} onClick={create}>Create and set permissions</Button>
        </>}>
          <Field label="Role name" required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Description"><Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
        </Modal>
      )}
    </SettingsPage>
  );
}
