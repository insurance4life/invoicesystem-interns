import { Link, useNavigate } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Badge, Button, Card, Empty, Menu, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, AutomationTabs, ENTITY_LABELS, DOC_TYPE_LABELS, Note } from './common.jsx';

const TRIGGER_LABELS = { created: 'When created', updated: 'When updated', deleted: 'When deleted', any: 'On any change' };
const ACTION_LABELS = { email: 'Email', webhook: 'Webhook', field_update: 'Update field' };

export default function WorkflowRules() {
  const { toast, can } = useApp();
  const rules = useFetch('/automation/rules');
  const nav = useNavigate();
  const canEdit = can('settings', 'edit');
  const canCreate = can('settings', 'create');
  const canDelete = can('settings', 'delete');

  const toggle = async (rule) => {
    const out = await attempt(toast, () => api.put(`/automation/rules/${rule.id}`, { is_active: rule.is_active ? 0 : 1 }),
      rule.is_active ? 'Rule turned off' : 'Rule turned on');
    if (out) rules.reload();
  };

  const remove = async (rule) => {
    if (!window.confirm(`Delete the rule "${rule.name}" and its logs?`)) return;
    const out = await attempt(toast, () => api.del(`/automation/rules/${rule.id}`), 'Rule deleted');
    if (out) rules.reload();
  };

  const columns = [
    { key: 'name', label: 'Rule', render: (r) => <Link to={`/settings/automation/rules/${r.id}`} className="bold">{r.name}</Link> },
    { key: 'applies', label: 'Applies to', render: (r) => (
      <span>
        {ENTITY_LABELS[r.module] || r.module}
        {r.doc_type && <span className="muted"> · {DOC_TYPE_LABELS[r.doc_type] || r.doc_type}</span>}
      </span>
    ) },
    { key: 'trigger', label: 'Trigger', render: (r) => TRIGGER_LABELS[r.trigger] || r.trigger },
    { key: 'conditions', label: 'Conditions', render: (r) => (r.conditions?.length ? `${r.conditions.length} condition${r.conditions.length > 1 ? 's' : ''}` : <span className="muted">Always</span>) },
    { key: 'actions', label: 'Actions', render: (r) => (r.actions || []).map((a) => ACTION_LABELS[a.type] || a.type).join(', ') },
    { key: 'is_active', label: 'Status', render: (r) => <Badge color={r.is_active ? 'green' : 'gray'}>{r.is_active ? 'On' : 'Off'}</Badge> },
    { key: 'actionsMenu', label: '', width: 60, render: (r) => (
      <Menu items={[
        { label: 'Edit', hidden: !canEdit, onClick: () => nav(`/settings/automation/rules/${r.id}`) },
        { label: r.is_active ? 'Turn off' : 'Turn on', hidden: !canEdit, onClick: () => toggle(r) },
        { divider: true, hidden: !canDelete },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(r) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Workflow rules"
      subtitle="Run an action automatically when records change."
      actions={canCreate && <Button variant="primary" onClick={() => nav('/settings/automation/rules/new')}>+ New rule</Button>}
    >
      <AutomationTabs active="rules" />
      <div style={{ height: 12 }} />
      <Card pad={false}>
        <Table columns={columns} rows={rules.data || []} loading={rules.loading}
          empty={<Empty title="No workflow rules" text="Create a rule to send an email, call a webhook or fill in a field automatically." />} />
      </Card>
      <Note>Webhooks are sent in the background with a 5 second timeout. Their results appear in Workflow Logs.</Note>
    </SettingsPage>
  );
}
