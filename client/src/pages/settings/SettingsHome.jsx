// Settings home: categories and sub-pages, grouped the way Zoho Books does it.
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui.jsx';
import { tileStyle } from './common.jsx';

const GROUPS = [
  { title: 'Organization', items: [
    { to: '/settings/profile', icon: '🏢', label: 'Organization Profile', desc: 'Name, address, fiscal year, GSTIN, danger zone' },
    { to: '/settings/branding', icon: '🎨', label: 'Branding', desc: 'Logo, accent colour, PDF template and footer' },
    { to: '/settings/users', icon: '👥', label: 'Users', desc: 'Invite people and change their access' },
    { to: '/settings/roles', icon: '🔐', label: 'Roles', desc: 'Module and action permissions per role' },
    { to: '/settings/preferences', icon: '⚙️', label: 'Preferences', desc: 'Discounts, default terms and notes, decimals, late fees' },
    { to: '/settings/currencies', icon: '💱', label: 'Currencies', desc: 'Foreign currencies and exchange rates' },
    { to: '/settings/opening-balances', icon: '📘', label: 'Opening Balances', desc: 'Starting balances for the ledger' },
  ] },
  { title: 'Taxes and Compliance', items: [
    { to: '/settings/taxes', icon: '🧮', label: 'Taxes', desc: 'Tax rates and tax groups' },
    { to: '/settings/gst', icon: '🇮🇳', label: 'GST Settings', desc: 'GSTIN, state and GST on transactions' },
  ] },
  { title: 'Customization', items: [
    { to: '/settings/number-series', icon: '#️⃣', label: 'Transaction Number Series', desc: 'Prefixes and next numbers' },
    { to: '/settings/pdf-templates', icon: '📄', label: 'PDF Templates', desc: 'Logo, signature and font on PDFs' },
    { to: '/settings/email-templates', icon: '✉️', label: 'Email Templates', desc: 'Subject and body for each document' },
    { to: '/settings/custom-fields', icon: '🧩', label: 'Custom Fields', desc: 'Extra fields on contacts, items and documents' },
    { to: '/settings/reminders', icon: '🔔', label: 'Reminders', desc: 'Payment reminders for overdue invoices' },
  ] },
  { title: 'Automation', items: [
    { to: '/settings/automation/rules', icon: '⚡', label: 'Workflow Rules', desc: 'Email, webhook and field-update actions' },
    { to: '/settings/automation/logs', icon: '🗒️', label: 'Workflow Logs', desc: 'What rules ran and what happened' },
    { to: '/settings/automation/webhooks', icon: '🔗', label: 'Incoming Webhooks', desc: 'Let other systems add notes to records' },
  ] },
  { title: 'Module settings', items: [
    { to: '/settings/payment-terms', icon: '⏳', label: 'Payment Terms', desc: 'Net 30, due on receipt and more' },
    { to: '/settings/approvals', icon: '✅', label: 'Approvals', desc: 'Which documents need approval before they go live' },
  ] },
  { title: 'Data', items: [
    { to: '/settings/data', icon: '💾', label: 'Backup and Export', desc: 'Download a full backup or CSV exports' },
  ] },
];

export default function SettingsHome() {
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Configure your organization, taxes, customization and automation." />
      <div className="stack" style={{ display: 'grid', gap: 24 }}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>{g.title}</h3>
            <div className="grid3">
              {g.items.map((it) => (
                <Link key={it.to} to={it.to} className="card" style={tileStyle}>
                  <div style={{ fontSize: 24, width: 36, textAlign: 'center' }}>{it.icon}</div>
                  <div>
                    <div className="bold">{it.label}</div>
                    <div className="muted small">{it.desc}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
