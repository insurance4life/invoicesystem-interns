// Accountant area, mounted at /accountant/*.
import { Routes, Route, Navigate } from 'react-router-dom';
import ChartOfAccounts from './ChartOfAccounts.jsx';
import AccountDetail from './AccountDetail.jsx';
import JournalList from './JournalList.jsx';
import JournalForm from './JournalForm.jsx';
import JournalView from './JournalView.jsx';
import RecurringJournals from './RecurringJournals.jsx';
import RecurringJournalView from './RecurringJournalView.jsx';
import Budgets from './Budgets.jsx';
import BudgetForm from './BudgetForm.jsx';
import BudgetVsActual from './BudgetVsActual.jsx';
import FixedAssets from './FixedAssets.jsx';
import FixedAssetForm from './FixedAssetForm.jsx';
import FixedAssetView from './FixedAssetView.jsx';
import TransactionLocking from './TransactionLocking.jsx';
import CurrencyAdjustments from './CurrencyAdjustments.jsx';
import CurrencyAdjustmentForm from './CurrencyAdjustmentForm.jsx';

export default function AccountantRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="/accountant/journals" replace />} />
      <Route path="chart-of-accounts" element={<ChartOfAccounts />} />
      <Route path="chart-of-accounts/:id" element={<AccountDetail />} />
      <Route path="journals" element={<JournalList />} />
      <Route path="journals/new" element={<JournalForm />} />
      <Route path="journals/:id" element={<JournalView />} />
      <Route path="journals/:id/edit" element={<JournalForm />} />
      <Route path="recurring-journals" element={<RecurringJournals />} />
      <Route path="recurring-journals/new" element={<JournalForm profile />} />
      <Route path="recurring-journals/:id" element={<RecurringJournalView />} />
      <Route path="budgets" element={<Budgets />} />
      <Route path="budgets/new" element={<BudgetForm />} />
      <Route path="budgets/:id" element={<BudgetVsActual />} />
      <Route path="budgets/:id/edit" element={<BudgetForm />} />
      <Route path="fixed-assets" element={<FixedAssets />} />
      <Route path="fixed-assets/new" element={<FixedAssetForm />} />
      <Route path="fixed-assets/:id" element={<FixedAssetView />} />
      <Route path="fixed-assets/:id/edit" element={<FixedAssetForm />} />
      <Route path="transaction-locking" element={<TransactionLocking />} />
      <Route path="currency-adjustments" element={<CurrencyAdjustments />} />
      <Route path="currency-adjustments/new" element={<CurrencyAdjustmentForm />} />
      <Route path="*" element={<Navigate to="/accountant/journals" replace />} />
    </Routes>
  );
}
