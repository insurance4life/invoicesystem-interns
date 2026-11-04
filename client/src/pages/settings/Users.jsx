import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Field, Input, Menu, Modal, Select, Table, Empty } from '../../components/ui.jsx';
import { SettingsPage, attempt } from './common.jsx';

export default function Users() {
  const { user, toast, can, refreshMeta } = useApp();
  const users = useFetch('/users');
  const roles = useFetch('/roles');
  const [invite, setInvite] = useState(null); // { name, email, role_id }
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState(null); // invite result, shown once
  const [changing, setChanging] = useState(null); // member row whose role is being changed
  const [newRole, setNewRole] = useState('');
  const canEdit = can('settings', 'edit');
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');
  const roleOptions = (roles.data || []).map((r) => ({ value: r.id, label: r.name }));

  const sendInvite = async () => {
    setInviting(true);
    const out = await attempt(toast, () => api.post('/users/invite', invite), null);
    setInviting(false);
    if (out) {
      setInvite(null);
      setCreated(out);
      users.reload();
      refreshMeta().catch(() => {});
    }
  };

  const patchUser = async (row, body, msg) => {
    const out = await attempt(toast, () => api.put(`/users/${row.id}`, body), msg);
    if (out) users.reload();
    return out;
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove ${row.name} from this organization?`)) return;
    const out = await attempt(toast, () => api.del(`/users/${row.id}`), 'User removed');
    if (out) users.reload();
  };

  const columns = [
    { key: 'name', label: 'Name', render: (r) => <span className="bold">{r.name}{r.id === user?.id && <span className="muted small"> (you)</span>}</span> },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: (r) => r.role || '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    {
      key: 'actions', label: '', width: 60,
      render: (r) => {
        const self = r.id === user?.id;
        return (
          <Menu items={[
            { label: 'Change role', hidden: !canEdit, onClick: () => { setChanging(r); setNewRole(r.role_id || ''); } },
            { label: r.status === 'active' ? 'Deactivate' : 'Activate', hidden: !canEdit || self,
              onClick: () => patchUser(r, { status: r.status === 'active' ? 'inactive' : 'active' }, r.status === 'active' ? 'User deactivated' : 'User activated') },
            { divider: true, hidden: !canDelete || self },
            { label: 'Remove from organization', danger: true, hidden: !canDelete || self, onClick: () => remove(r) },
          ]} />
        );
      },
    },
  ];

  return (
    <SettingsPage
      title="Users"
      subtitle="People who can sign in to this organization."
      actions={canCreate && <Button variant="primary" onClick={() => setInvite({ name: '', email: '', role_id: roleOptions[0]?.value || '' })}>+ Invite user</Button>}
    >
      <Card pad={false}>
        <Table
          columns={columns}
          rows={users.data || []}
          loading={users.loading}
          empty={<Empty title="No users yet" text="Invite a teammate to share the books." />}
        />
      </Card>

      <p className="muted small" style={{ marginTop: 12 }}>
        Each user has one role, and the role decides which modules and actions they can use. <Link to="/settings/roles">Manage roles</Link>
      </p>

      {invite && (
        <Modal
          title="Invite user"
          onClose={() => setInvite(null)}
          footer={<>
            <Button onClick={() => setInvite(null)}>Cancel</Button>
            <Button variant="primary" loading={inviting} disabled={!invite.email || !invite.role_id} onClick={sendInvite}>Send invite</Button>
          </>}
        >
          <Field label="Name"><Input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} /></Field>
          <Field label="Email" required><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
          <Field label="Role" required hint="If they already have an account, they are added with their existing password.">
            <Select options={roleOptions} placeholder="Select a role" value={invite.role_id} onChange={(e) => setInvite({ ...invite, role_id: Number(e.target.value) })} />
          </Field>
        </Modal>
      )}

      {created && (
        <Modal title="User added" onClose={() => setCreated(null)} footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
          <p>{created.name} ({created.email}) can now sign in as <b>{created.role}</b>.</p>
          {created.temp_password && (
            <>
              <p className="muted small" style={{ marginTop: 10 }}>Temporary password (shown only once). Share it securely, and ask them to change it from their profile.</p>
              <div className="callout" style={{ fontFamily: 'monospace', fontSize: 16, justifyContent: 'center' }}>{created.temp_password}</div>
            </>
          )}
        </Modal>
      )}

      {changing && (
        <Modal
          title={`Change role for ${changing.name}`}
          onClose={() => setChanging(null)}
          footer={<>
            <Button onClick={() => setChanging(null)}>Cancel</Button>
            <Button variant="primary" disabled={!newRole} onClick={async () => {
              const out = await patchUser(changing, { role_id: Number(newRole) }, 'Role updated');
              if (out) setChanging(null);
            }}>Save</Button>
          </>}
        >
          <Field label="Role">
            <Select options={roleOptions} value={newRole} onChange={(e) => setNewRole(e.target.value)} />
          </Field>
        </Modal>
      )}
    </SettingsPage>
  );
}
