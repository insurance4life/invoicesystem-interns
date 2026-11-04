import { useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Card, Empty, Field, Input, Menu, Modal, Select, Table } from '../../components/ui.jsx';
import { SettingsPage, attempt, AutomationTabs, ENTITY_LABELS, Note } from './common.jsx';

const MODULES = Object.entries(ENTITY_LABELS);

export default function IncomingWebhooks() {
  const { toast, can } = useApp();
  const hooks = useFetch('/automation/incoming-webhooks');
  const [draft, setDraft] = useState(null); // { name, module }
  const [saving, setSaving] = useState(false);
  const canCreate = can('settings', 'create');
  const canEdit = can('settings', 'edit');
  const canDelete = can('settings', 'delete');

  const fullUrl = (h) => `${window.location.origin}${h.url}`;

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      toast('Could not copy. Select the URL and copy it manually.', 'error');
    }
  };

  const create = async () => {
    setSaving(true);
    const out = await attempt(toast, () => api.post('/automation/incoming-webhooks', draft), 'Webhook created');
    setSaving(false);
    if (out) { setDraft(null); hooks.reload(); }
  };

  const regenerate = async (h) => {
    if (!window.confirm(`Create a new URL for "${h.name}"? The old URL will stop working.`)) return;
    const out = await attempt(toast, () => api.put(`/automation/incoming-webhooks/${h.id}`, { regenerate: true }), 'New URL created');
    if (out) hooks.reload();
  };

  const remove = async (h) => {
    if (!window.confirm(`Delete the webhook "${h.name}"?`)) return;
    const out = await attempt(toast, () => api.del(`/automation/incoming-webhooks/${h.id}`), 'Webhook deleted');
    if (out) hooks.reload();
  };

  const columns = [
    { key: 'name', label: 'Name', render: (h) => <span className="bold">{h.name}</span> },
    { key: 'module', label: 'Writes to', render: (h) => ENTITY_LABELS[h.module] || h.module },
    { key: 'url', label: 'URL', render: (h) => (!h.url ? <span className="muted small">Hidden: needs settings edit access</span> :
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <code className="small" style={{ wordBreak: 'break-all' }}>{fullUrl(h)}</code>
        <Button size="sm" onClick={() => copy(fullUrl(h))}>Copy</Button>
      </div>
    ) },
    { key: 'actions', label: '', width: 60, render: (h) => (
      <Menu items={[
        { label: 'Create a new URL', hidden: !canEdit, onClick: () => regenerate(h) },
        { label: 'Delete', danger: true, hidden: !canDelete, onClick: () => remove(h) },
      ]} />
    ) },
  ];

  return (
    <SettingsPage
      title="Incoming webhooks"
      subtitle="Other systems can post to these URLs to add a note to a record."
      actions={canCreate && <Button variant="primary" onClick={() => setDraft({ name: '', module: 'contact' })}>+ New webhook</Button>}
    >
      <AutomationTabs active="webhooks" />
      <div style={{ height: 12 }} />
      <Card pad={false}>
        <Table columns={columns} rows={hooks.data || []} loading={hooks.loading}
          empty={<Empty title="No incoming webhooks" text="Create one and give its URL to the other system." />} />
      </Card>
      <Note>
        Send a POST with a JSON body such as {'{"entity_id": 12, "text": "Paid via Stripe"}'}. The text is saved as a comment on the record,
        and every call is recorded in the activity history. Keep these URLs private, because anyone with the URL can post to it.
      </Note>

      {draft && (
        <Modal
          title="New incoming webhook"
          onClose={() => setDraft(null)}
          footer={<>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.name.trim()} onClick={create}>Create</Button>
          </>}
        >
          <Field label="Name" required hint="For example, Billing system or Payment gateway">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Writes to">
            <Select options={MODULES} value={draft.module} onChange={(e) => setDraft({ ...draft, module: e.target.value })} />
          </Field>
        </Modal>
      )}
    </SettingsPage>
  );
}
