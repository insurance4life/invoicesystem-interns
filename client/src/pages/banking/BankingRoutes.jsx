// Banking area: overview, account detail (statement lines, matching, categorization, ledger, reconciliations),
// statement import, reconcile, bank rules and undeposited funds.
import { Routes, Route } from 'react-router-dom';
import Overview from './Overview.jsx';
import AccountDetail from './AccountDetail.jsx';
import ImportStatement from './ImportStatement.jsx';
import Reconcile from './Reconcile.jsx';
import Rules from './Rules.jsx';
import Undeposited from './Undeposited.jsx';
import './banking.css';

export default function BankingRoutes() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="import" element={<ImportStatement />} />
      <Route path="accounts/:id" element={<AccountDetail />} />
      <Route path="accounts/:id/import" element={<ImportStatement />} />
      <Route path="reconciliations/:rid" element={<Reconcile />} />
      <Route path="rules" element={<Rules />} />
      <Route path="undeposited" element={<Undeposited />} />
      <Route path="*" element={<div className="page"><div className="empty"><h3>Page not found</h3></div></div>} />
    </Routes>
  );
}
