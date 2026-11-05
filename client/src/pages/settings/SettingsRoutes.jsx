// Settings area: every sub-page is mounted under /settings/*.
import { Routes, Route, Navigate } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { Empty } from '../../components/ui.jsx';
import SettingsHome from './SettingsHome.jsx';
import OrgProfile from './OrgProfile.jsx';
import Branding from './Branding.jsx';
import PdfTemplates from './PdfTemplates.jsx';
import Users from './Users.jsx';
import Roles from './Roles.jsx';
import RoleEditor from './RoleEditor.jsx';
import Preferences from './Preferences.jsx';
import Currencies from './Currencies.jsx';
import OpeningBalances from './OpeningBalances.jsx';
import Taxes from './Taxes.jsx';
import TdsSections from './TdsSections.jsx';
import GstSettings from './GstSettings.jsx';
import NumberSeries from './NumberSeries.jsx';
import EmailTemplates from './EmailTemplates.jsx';
import CustomFields from './CustomFields.jsx';
import Reminders from './Reminders.jsx';
import PaymentTerms from './PaymentTerms.jsx';
import Approvals from './Approvals.jsx';
import DataBackup from './DataBackup.jsx';
import WorkflowRules from './WorkflowRules.jsx';
import RuleEditor from './RuleEditor.jsx';
import WorkflowLogs from './WorkflowLogs.jsx';
import IncomingWebhooks from './IncomingWebhooks.jsx';

export default function SettingsRoutes() {
  const { can } = useApp();
  if (!can('settings', 'view')) {
    return <div className="page"><Empty title="Settings are restricted" text="Ask an administrator for access to settings." /></div>;
  }
  return (
    <Routes>
      <Route index element={<SettingsHome />} />
      <Route path="profile" element={<OrgProfile />} />
      <Route path="branding" element={<Branding />} />
      <Route path="pdf-templates" element={<PdfTemplates />} />
      <Route path="users" element={<Users />} />
      <Route path="roles" element={<Roles />} />
      <Route path="roles/:id" element={<RoleEditor />} />
      <Route path="preferences" element={<Preferences />} />
      <Route path="currencies" element={<Currencies />} />
      <Route path="opening-balances" element={<OpeningBalances />} />
      <Route path="taxes" element={<Taxes />} />
      <Route path="tds-sections" element={<TdsSections />} />
      <Route path="gst" element={<GstSettings />} />
      <Route path="number-series" element={<NumberSeries />} />
      <Route path="email-templates" element={<EmailTemplates />} />
      <Route path="custom-fields" element={<CustomFields />} />
      <Route path="reminders" element={<Reminders />} />
      <Route path="payment-terms" element={<PaymentTerms />} />
      <Route path="approvals" element={<Approvals />} />
      <Route path="data" element={<DataBackup />} />
      <Route path="automation" element={<Navigate to="/settings/automation/rules" replace />} />
      <Route path="automation/rules" element={<WorkflowRules />} />
      <Route path="automation/rules/new" element={<RuleEditor />} />
      <Route path="automation/rules/:id" element={<RuleEditor />} />
      <Route path="automation/logs" element={<WorkflowLogs />} />
      <Route path="automation/webhooks" element={<IncomingWebhooks />} />
      <Route path="*" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}
