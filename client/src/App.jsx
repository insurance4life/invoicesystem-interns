import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from './store.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import { DOC_SLUGS } from './lib/docs.js';
import Login from './pages/auth/Login.jsx';
import Signup from './pages/auth/Signup.jsx';

const L = (f) => lazy(f);
// core pages
const DocList = L(() => import('./pages/sales/DocList.jsx'));
const DocForm = L(() => import('./pages/sales/DocForm.jsx'));
const DocView = L(() => import('./pages/sales/DocView.jsx'));
const PaymentList = L(() => import('./pages/sales/PaymentList.jsx'));
const PaymentForm = L(() => import('./pages/sales/PaymentForm.jsx'));
const PaymentView = L(() => import('./pages/sales/PaymentView.jsx'));
const ContactList = L(() => import('./pages/contacts/ContactList.jsx'));
const ContactForm = L(() => import('./pages/contacts/ContactForm.jsx'));
const ContactView = L(() => import('./pages/contacts/ContactView.jsx'));
const ItemList = L(() => import('./pages/items/ItemList.jsx'));
const ItemForm = L(() => import('./pages/items/ItemForm.jsx'));
const ItemView = L(() => import('./pages/items/ItemView.jsx'));
const ExpenseList = L(() => import('./pages/purchases/ExpenseList.jsx'));
const ExpenseForm = L(() => import('./pages/purchases/ExpenseForm.jsx'));
const ExpenseView = L(() => import('./pages/purchases/ExpenseView.jsx'));
const Approvals = L(() => import('./pages/sales/Approvals.jsx'));
const DocPrint = L(() => import('./pages/print/DocPrint.jsx'));
// feature areas (each owns its nested routes)
const Dashboard = L(() => import('./pages/Dashboard.jsx'));
const ReportsRoutes = L(() => import('./pages/reports/ReportsRoutes.jsx'));
const BankingRoutes = L(() => import('./pages/banking/BankingRoutes.jsx'));
const SettingsRoutes = L(() => import('./pages/settings/SettingsRoutes.jsx'));
const Profile = L(() => import('./pages/settings/Profile.jsx'));
const InventoryRoutes = L(() => import('./pages/items/InventoryRoutes.jsx'));
const AccountantRoutes = L(() => import('./pages/accountant/AccountantRoutes.jsx'));
const ProjectsRoutes = L(() => import('./pages/projects/ProjectsRoutes.jsx'));
const DocumentsPage = L(() => import('./pages/documents/DocumentsPage.jsx'));
const PublicRoutes = L(() => import('./pages/portal/PublicRoutes.jsx'));

function Authed() {
  const { pathname } = useLocation();
  useEffect(() => { document.querySelector('.content')?.scrollTo(0, 0); }, [pathname]);
  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {Object.entries(DOC_SLUGS).map(([type, slug]) => [
            <Route key={`${slug}-l`} path={`/${slug}`} element={<DocList type={type} />} />,
            <Route key={`${slug}-n`} path={`/${slug}/new`} element={<DocForm type={type} />} />,
            <Route key={`${slug}-v`} path={`/${slug}/:id`} element={<DocView type={type} />} />,
            <Route key={`${slug}-e`} path={`/${slug}/:id/edit`} element={<DocForm type={type} />} />,
          ])}
          {['received', 'made'].map((k) => [
            <Route key={`${k}-l`} path={`/payments-${k}`} element={<PaymentList kind={k} />} />,
            <Route key={`${k}-n`} path={`/payments-${k}/new`} element={<PaymentForm kind={k} />} />,
            <Route key={`${k}-v`} path={`/payments-${k}/:id`} element={<PaymentView kind={k} />} />,
            <Route key={`${k}-e`} path={`/payments-${k}/:id/edit`} element={<PaymentForm kind={k} />} />,
          ])}
          {[['customers', 'customer'], ['vendors', 'vendor']].map(([slug, t]) => [
            <Route key={`${slug}-l`} path={`/${slug}`} element={<ContactList type={t} />} />,
            <Route key={`${slug}-n`} path={`/${slug}/new`} element={<ContactForm type={t} />} />,
            <Route key={`${slug}-v`} path={`/${slug}/:id`} element={<ContactView type={t} />} />,
            <Route key={`${slug}-e`} path={`/${slug}/:id/edit`} element={<ContactForm type={t} />} />,
          ])}
          <Route path="/items" element={<ItemList />} />
          <Route path="/items/new" element={<ItemForm />} />
          <Route path="/items/:id" element={<ItemView />} />
          <Route path="/items/:id/edit" element={<ItemForm />} />
          <Route path="/expenses" element={<ExpenseList />} />
          <Route path="/recurring-expenses" element={<ExpenseList profiles />} />
          <Route path="/expenses/new" element={<ExpenseForm />} />
          <Route path="/recurring-expenses/new" element={<ExpenseForm profile />} />
          <Route path="/expenses/:id" element={<ExpenseView />} />
          <Route path="/expenses/:id/edit" element={<ExpenseForm />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/print/:type/:id" element={<DocPrint />} />
          <Route path="/reports/*" element={<ReportsRoutes />} />
          <Route path="/banking/*" element={<BankingRoutes />} />
          <Route path="/settings/*" element={<SettingsRoutes />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/inventory/*" element={<InventoryRoutes />} />
          <Route path="/accountant/*" element={<AccountantRoutes />} />
          <Route path="/time/*" element={<ProjectsRoutes />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/signup" element={<Navigate to="/" replace />} />
          <Route path="*" element={<div className="page"><div className="empty"><h3>Page not found</h3></div></div>} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  const { user, meta, booting } = useApp();
  const { pathname } = useLocation();
  if (pathname.startsWith('/share/') || pathname.startsWith('/portal/')) {
    return <Suspense fallback={<Spinner />}><PublicRoutes /></Suspense>;
  }
  if (booting) return <Spinner />;
  if (!user) {
    return (
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (!meta) return <Spinner />;
  return <Authed />;
}
