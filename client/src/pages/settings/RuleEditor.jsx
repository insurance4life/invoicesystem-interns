import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Card, Checkbox, Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { SettingsPage, attempt, AutomationTabs, ENTITY_LABELS, DOC_TYPE_LABELS, Note } from './common.jsx';

const MODULES = Object.entries(ENTITY_LABELS).map(([k, v]) => [k, v]);
const TRIGGERS = [['created', 'When created'], ['updated', 'When updated'], ['deleted', 'When deleted'], ['any', 'On any change']];
const OPS = [['equals', 'is'], ['not_equals', 'is not'], ['gt', 'is greater than'], ['lt', 'is less than'], ['contains', 'contains']];
const METHODS = ['POST', 'PUT', 'PATCH', 'GET'];
const ACTION_TYPES = [['email', 'Send an email'], ['webhook', 'Call a webhook'], ['field_update', 'Update a field']];
// Mirrors the field whitelist on the server (automation.js).
const UPDATABLE = {
  contact: ['notes', 'website', 'is_active', 'reminders_enabled', 'credit_limit', 'payment_term_id'],
  item: ['description', 'unit', 'is_active', 'selling_price', 'purchase_price', 'reorder_level'],
};
const FIELD_HINTS = {
  document: ['total', 'balance', 'status', 'display_status', 'number', 'reference', 'contact_name', 'date', 'due_date'],
  contact: ['display_name', 'email', 'type', 'is_active', 'credit_limit', 'place_of_supply'],
  item: ['name', 'sku', 'selling_price', 'purchase_price', 'is_active', 'track_inventory'],
  expense: ['total', 'amount', 'reference', 'status'],
  payment_received: ['amount', 'mode', 'reference', 'contact_id'],
  payment_made: ['amount', 'mode', 'reference', 'contact_id'],
};
const EMAIL_HINT = '{number}, {contact_name}, {contact_email}, {total}, {balance}, {due_date}, {link}, {org_name}';

const emptyCondition = () => ({ field: '', op: 'equals', value: '' });
const emptyAction = (type = 'email') => (type === 'email'
  ? { type, to: '{contact_email}', subject: '', body: '' }
  : type === 'webhook' ? { type, url: '', method: 'POST', headers: '' } : { type, field: '', value: '' });

const headersToText = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const textToHeaders = (t) => Object.fromEntries(String(t || '').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; })
  .filter(Boolean));

export default function RuleEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { toast, can } = useApp();
  const nav = useNavigate();
  const rule = useFetch(isNew ? null : `/automation/rules/${id}`);
  const canEdit = can('settings', 'edit');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef(0);
  const withKey = (x) => ({ ...x, _k: ++keys.current });

  useEffect(() => {
    if (isNew) {
      setForm({ name: '', module: 'document', doc_type: 'invoice', trigger: 'created', is_active: true,
        conditions: [withKey(emptyCondition())], actions: [withKey(emptyAction('email'))] });
    } else if (rule.data) {
      const r = rule.data;
      setForm({
        name: r.name, module: r.module, doc_type: r.doc_type || '', trigger: r.trigger, is_active: !!r.is_active,
        conditions: (r.conditions || []).map((c) => withKey({ ...c })),
        actions: (r.actions || []).map((a) => withKey(a.type === 'webhook' ? { ...a, headers: headersToText(a.headers) } : { ...a })),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rule.data]);

  if (!isNew && rule.error) return <SettingsPage title="Workflow rule"><div className="callout warn">{rule.error.message}</div></SettingsPage>;
  if (!form) return <SettingsPage title="Workflow rule"><div className="muted">Loading…</div></SettingsPage>;

  const setA = (k, patch) => setForm((f) => ({ ...f, actions: f.actions.map((a) => (a._k === k ? { ...a, ...patch } : a)) }));
  const setC = (k, patch) => setForm((f) => ({ ...f, conditions: f.conditions.map((c) => (c._k === k ? { ...c, ...patch } : c)) }));
  const fieldsFor = form.module;

  const save = async () => {
    setSaving(true);
    const body = {
      name: form.name,
      module: form.module,
      doc_type: form.module === 'document' && form.doc_type ? form.doc_type : null,
      trigger: form.trigger,
      is_active: form.is_active ? 1 : 0,
      conditions: form.conditions.filter((c) => c.field.trim()).map(({ field, op, value }) => ({ field: field.trim(), op, value })),
      actions: form.actions.map((a) => {
        const { _k, ...rest } = a;
        if (a.type === 'webhook') return { ...rest, headers: textToHeaders(a.headers) };
        return rest;
      }),
    };
    const out = await attempt(toast, () => (isNew ? api.post('/automation/rules', body) : api.put(`/automation/rules/${id}`, body)),
      isNew ? 'Rule created' : 'Rule saved');
    setSaving(false);
    if (out) nav('/settings/automation/rules');
  };

  const hints = FIELD_HINTS[fieldsFor] || [];
  const actionsValid = form.actions.length > 0 && form.actions.every((a) => (a.type === 'email' ? a.to && a.subject
    : a.type === 'webhook' ? /^https?:\/\//.test(a.url || '') : a.field));

  return (
    <SettingsPage title={isNew ? 'New workflow rule' : form.name || 'Workflow rule'} subtitle="Runs when a record changes and every condition matches.">
      <AutomationTabs active="rules" />
      <div style={{ height: 12 }} />

      <div className="form-section">
        <h3>When</h3>
        <div className="form-grid">
          <Field label="Rule name" required>
            <Input value={form.name} disabled={!canEdit} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Trigger">
            <Select options={TRIGGERS} value={form.trigger} disabled={!canEdit} onChange={(e) => setForm({ ...form, trigger: e.target.value })} />
          </Field>
          <Field label="Applies to">
            <Select options={MODULES} value={form.module} disabled={!canEdit || !isNew}
              onChange={(e) => setForm({ ...form, module: e.target.value, doc_type: '', actions: form.actions.filter((a) => a.type !== 'field_update' || ['contact', 'item'].includes(e.target.value)) })} />
          </Field>
          {form.module === 'document' && (
            <Field label="Document type" hint="Leave empty for every document type.">
              <Select options={[['', 'All document types'], ...Object.entries(DOC_TYPE_LABELS)]} value={form.doc_type} disabled={!canEdit}
                onChange={(e) => setForm({ ...form, doc_type: e.target.value })} />
            </Field>
          )}
          <div className="stack">
            <Checkbox label="Rule is on" checked={form.is_active} disabled={!canEdit} onChange={(v) => setForm({ ...form, is_active: v })} />
          </div>
        </div>
        {form.trigger === 'deleted' && <Note>Rules on deleted records run only without conditions and document type, because the record no longer exists to check.</Note>}
      </div>

      <div className="form-section">
        <h3>Only if</h3>
        <datalist id="ob-rule-fields">{hints.map((h) => <option key={h} value={h} />)}</datalist>
        <div className="stack">
          {form.conditions.length === 0 && <span className="muted">No conditions. The rule runs every time.</span>}
          {form.conditions.map((c) => (
            <div key={c._k} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div style={{ width: 200 }}>
                <Input list="ob-rule-fields" placeholder="Field, e.g. total" value={c.field} disabled={!canEdit} onChange={(e) => setC(c._k, { field: e.target.value })} />
              </div>
              <div style={{ width: 170 }}>
                <Select options={OPS} value={c.op} disabled={!canEdit} onChange={(e) => setC(c._k, { op: e.target.value })} />
              </div>
              <div style={{ width: 200 }}>
                <Input placeholder="Value" value={c.value} disabled={!canEdit} onChange={(e) => setC(c._k, { value: e.target.value })} />
              </div>
              {canEdit && <Button size="sm" variant="link" onClick={() => setForm((f) => ({ ...f, conditions: f.conditions.filter((x) => x._k !== c._k) }))}>Remove</Button>}
            </div>
          ))}
          {canEdit && <div><Button size="sm" onClick={() => setForm((f) => ({ ...f, conditions: [...f.conditions, withKey(emptyCondition())] }))}>+ Add condition</Button></div>}
        </div>
        <Note>All conditions must match. Numbers compare as numbers, text ignores case.</Note>
      </div>

      <div className="form-section">
        <h3>Then</h3>
        <div className="stack">
          {form.actions.map((a, idx) => (
            <Card key={a._k} title={`Action ${idx + 1}`} actions={canEdit && form.actions.length > 1
              ? <Button size="sm" variant="link" onClick={() => setForm((f) => ({ ...f, actions: f.actions.filter((x) => x._k !== a._k) }))}>Remove</Button>
              : null}>
              <div className="form-grid">
                <Field label="Action">
                  <Select
                    options={ACTION_TYPES.filter(([t]) => t !== 'field_update' || UPDATABLE[fieldsFor])}
                    value={a.type}
                    disabled={!canEdit}
                    onChange={(e) => setForm((f) => ({ ...f, actions: f.actions.map((x) => (x._k === a._k ? { _k: x._k, ...emptyAction(e.target.value) } : x)) }))}
                  />
                </Field>
                {a.type === 'email' && <>
                  <Field label="To" required hint={`Address or placeholder. Available: ${EMAIL_HINT}`}>
                    <Input value={a.to} disabled={!canEdit} onChange={(e) => setA(a._k, { to: e.target.value })} />
                  </Field>
                  <Field label="Subject" required>
                    <Input value={a.subject} disabled={!canEdit} onChange={(e) => setA(a._k, { subject: e.target.value })} />
                  </Field>
                  <Field label="Message">
                    <Textarea rows={4} value={a.body} disabled={!canEdit} onChange={(e) => setA(a._k, { body: e.target.value })} />
                  </Field>
                </>}
                {a.type === 'webhook' && <>
                  <Field label="URL" required hint="Sent as JSON with the event, the organization and the record.">
                    <Input placeholder="https://example.com/hook" value={a.url} disabled={!canEdit} onChange={(e) => setA(a._k, { url: e.target.value })} />
                  </Field>
                  <Field label="Method">
                    <Select options={METHODS} value={a.method} disabled={!canEdit} onChange={(e) => setA(a._k, { method: e.target.value })} />
                  </Field>
                  <Field label="Headers" hint="One per line, e.g. Authorization: Bearer abc">
                    <Textarea rows={3} value={a.headers} disabled={!canEdit} onChange={(e) => setA(a._k, { headers: e.target.value })} />
                  </Field>
                </>}
                {a.type === 'field_update' && <>
                  <Field label="Field" required>
                    <Select options={(UPDATABLE[fieldsFor] || []).map((f) => [f, f])} placeholder="Choose a field" value={a.field} disabled={!canEdit}
                      onChange={(e) => setA(a._k, { field: e.target.value })} />
                  </Field>
                  <Field label="New value" hint="Leave empty to clear the field.">
                    <Input value={a.value} disabled={!canEdit} onChange={(e) => setA(a._k, { value: e.target.value })} />
                  </Field>
                </>}
              </div>
            </Card>
          ))}
          {canEdit && <div><Button size="sm" onClick={() => setForm((f) => ({ ...f, actions: [...f.actions, withKey(emptyAction('email'))] }))}>+ Add action</Button></div>}
        </div>
      </div>

      {canEdit && (
        <div className="form-foot">
          <Button variant="primary" loading={saving} disabled={!form.name.trim() || !actionsValid} onClick={save}>{isNew ? 'Create rule' : 'Save rule'}</Button>
          <Button onClick={() => nav('/settings/automation/rules')}>Cancel</Button>
        </div>
      )}
    </SettingsPage>
  );
}
