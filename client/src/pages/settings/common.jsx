// Shared helpers for the settings pages.
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, Tabs } from '../../components/ui.jsx';
import { session } from '../../api.js';

/** Page wrapper with a back link to the settings home. */
export function SettingsPage({ title, subtitle, actions, children }) {
  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={actions}
        back={<Link to="/settings" className="btn btn-sm btn-link">‹ Settings</Link>}
      />
      {children}
    </div>
  );
}

/** Run an API call and toast the outcome. Resolves to the result, or null when it failed. */
export async function attempt(toast, fn, okMessage = 'Saved') {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/** Download a file from an /api path, sending the signed-in session headers. */
export async function download(path, filename) {
  const headers = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (session.orgId) headers['x-org-id'] = session.orgId;
  const res = await fetch(`/api${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const ENTITY_LABELS = {
  document: 'Documents', contact: 'Contacts', item: 'Items', expense: 'Expenses',
  payment_received: 'Payments received', payment_made: 'Payments made',
};

export const DOC_TYPE_LABELS = {
  quote: 'Quote', salesorder: 'Sales Order', invoice: 'Invoice', retainer: 'Retainer Invoice', creditnote: 'Credit Note',
  deliverychallan: 'Delivery Challan', salesreceipt: 'Sales Receipt', recurring_invoice: 'Recurring Invoice',
  purchaseorder: 'Purchase Order', bill: 'Bill', vendorcredit: 'Vendor Credit', recurring_bill: 'Recurring Bill',
};

export const AUTOMATION_TABS = [
  { key: 'rules', label: 'Workflow Rules', to: '/settings/automation/rules' },
  { key: 'logs', label: 'Workflow Logs', to: '/settings/automation/logs' },
  { key: 'webhooks', label: 'Incoming Webhooks', to: '/settings/automation/webhooks' },
];

export function AutomationTabs({ active }) {
  const nav = useNavigate();
  return (
    <Tabs
      tabs={AUTOMATION_TABS.map((t) => ({ key: t.key, label: t.label }))}
      active={active}
      onChange={(key) => nav(AUTOMATION_TABS.find((t) => t.key === key).to)}
    />
  );
}

/** A settings card tile used on the home grid. */
export const tileStyle = { display: 'flex', gap: 14, alignItems: 'center', padding: 16, color: 'inherit', textDecoration: 'none' };

export const Note = ({ children }) => <div className="muted small" style={{ marginTop: 4 }}>{children}</div>;
