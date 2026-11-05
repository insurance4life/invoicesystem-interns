// Settings home: categories and sub-pages, grouped the way Zoho Books does it.
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui.jsx';
import { tileStyle } from './common.jsx';
import { Building2, Palette, Users, ShieldCheck, Settings, Coins, BookOpen, Calculator, Landmark, Hash, FileText, Mail, Puzzle, Bell, Zap, NotebookPen, Link2, Hourglass, CircleCheck, Save, Percent } from 'lucide-react';

const GROUPS = [
  { title: 'Organization', items: [
    { to: '/settings/profile', icon: Building2, label: 'Organization Profile', desc: 'Name, address, fiscal year, GSTIN, danger zone' },
    { to: '/settings/branding', icon: Palette, label: 'Branding', desc: 'Logo, accent colour, PDF template and footer' },
    { to: '/settings/users', icon: Users, label: 'Users', desc: 'Invite people and change their access' },
    { to: '/settings/roles', icon: ShieldCheck, label: 'Roles', desc: 'Module and action permissions per role' },
    { to: '/settings/preferences', icon: Settings, label: 'Preferences', desc: 'Discounts, default terms and notes, decimals, late fees' },
    { to: '/settings/currencies', icon: Coins, label: 'Currencies', desc: 'Foreign currencies and exchange rates' },
    { to: '/settings/opening-balances', icon: BookOpen, label: 'Opening Balances', desc: 'Starting balances for the ledger' },
  ] },
  { title: 'Taxes and Compliance', items: [
    { to: '/settings/taxes', icon: Calculator, label: 'Taxes', desc: 'Tax rates and tax groups' },
    { to: '/settings/gst', icon: Landmark, label: 'GST Settings', desc: 'GSTIN, state and GST on transactions' },
    { to: '/settings/tds-sections', icon: Percent, label: 'TDS Sections', desc: 'Sections and rates for tax deducted at source' },
  ] },
  { title: 'Customization', items: [
    { to: '/settings/number-series', icon: Hash, label: 'Transaction Number Series', desc: 'Prefixes and next numbers' },
    { to: '/settings/pdf-templates', icon: FileText, label: 'PDF Templates', desc: 'Logo, signature and font on PDFs' },
    { to: '/settings/email-templates', icon: Mail, label: 'Email Templates', desc: 'Subject and body for each document' },
    { to: '/settings/custom-fields', icon: Puzzle, label: 'Custom Fields', desc: 'Extra fields on contacts, items and documents' },
    { to: '/settings/reminders', icon: Bell, label: 'Reminders', desc: 'Payment reminders for overdue invoices' },
  ] },
  { title: 'Automation', items: [
    { to: '/settings/automation/rules', icon: Zap, label: 'Workflow Rules', desc: 'Email, webhook and field-update actions' },
    { to: '/settings/automation/logs', icon: NotebookPen, label: 'Workflow Logs', desc: 'What rules ran and what happened' },
    { to: '/settings/automation/webhooks', icon: Link2, label: 'Incoming Webhooks', desc: 'Let other systems add notes to records' },
  ] },
  { title: 'Module settings', items: [
    { to: '/settings/payment-terms', icon: Hourglass, label: 'Payment Terms', desc: 'Net 30, due on receipt and more' },
    { to: '/settings/approvals', icon: CircleCheck, label: 'Approvals', desc: 'Which documents need approval before they go live' },
  ] },
  { title: 'Data', items: [
    { to: '/settings/data', icon: Save, label: 'Backup and Export', desc: 'Download a full backup or CSV exports' },
  ] },
];

export default function SettingsHome() {
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Configure your organization, taxes, customization and automation." />
      <div className="stack" style={{ display: 'grid', gap: 24 }}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="muted small" style={{ fontWeight: 500, marginBottom: 8 }}>{g.title}</h3>
            <div className="grid3">
              {g.items.map((it) => (
                <Link key={it.to} to={it.to} className="card" style={tileStyle}>
                  <div style={{ color: 'var(--muted)', width: 36, textAlign: 'center' }}><it.icon size={20} strokeWidth={1.5} /></div>
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
