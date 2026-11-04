import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { Badge, Button, Card, Empty, Select, Table } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/format.js';
import { SettingsPage, AutomationTabs, ENTITY_LABELS, Note } from './common.jsx';

const STATUS_STYLE = { success: 'green', pending: 'blue', failed: 'red' };
const STATUS_OPTIONS = [['', 'All results'], ['success', 'Succeeded'], ['pending', 'Pending'], ['failed', 'Failed']];
const ACTION_LABELS = { email: 'Email', webhook: 'Webhook', field_update: 'Field update' };

export default function WorkflowLogs() {
  const { org } = useApp();
  const [status, setStatus] = useState('');
  const logs = useFetch('/automation/logs', { limit: 200, status: status || undefined }, [status]);

  const columns = [
    { key: 'created_at', label: 'When', render: (l) => <span className="small">{formatWhen(l.created_at, org?.date_format)}</span> },
    { key: 'rule_name', label: 'Rule', render: (l) => l.rule_name || <span className="muted">(deleted rule)</span> },
    { key: 'entity', label: 'Record', render: (l) => (
      <span>{ENTITY_LABELS[l.entity_type] ? ENTITY_LABELS[l.entity_type].replace(/s$/, '') : l.entity_type} #{l.entity_id}</span>
    ) },
    { key: 'action_type', label: 'Action', render: (l) => ACTION_LABELS[l.action_type] || l.action_type },
    { key: 'status', label: 'Result', render: (l) => <Badge color={STATUS_STYLE[l.status] || 'gray'}>{l.status}</Badge> },
    { key: 'message', label: 'Details', render: (l) => <span className="small">{l.message}</span> },
  ];

  return (
    <SettingsPage
      title="Workflow logs"
      subtitle="The most recent 200 rule runs."
      actions={<Button size="sm" onClick={() => logs.reload()}>Refresh</Button>}
    >
      <AutomationTabs active="logs" />
      <div style={{ height: 12 }} />
      <div className="page-filters" style={{ marginTop: 0, marginBottom: 12 }}>
        <Select options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>
      <Card pad={false}>
        <Table columns={columns} rows={logs.data || []} loading={logs.loading}
          empty={<Empty title="Nothing has run yet" text="Logs appear here when a rule runs." />} />
      </Card>
      <Note>A webhook shows as pending until the other system answers, or the 5 second timeout passes.</Note>
    </SettingsPage>
  );
}

function formatWhen(stamp, format) {
  if (!stamp) return '';
  const day = fmtDate(String(stamp).slice(0, 10), format);
  return `${day} ${String(stamp).slice(11, 16)}`;
}
