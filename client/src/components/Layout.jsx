import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, Link } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { api } from '../api.js';
import { Menu, Modal, Button, Field, Input, Select } from './ui.jsx';
import { House, Package, Landmark, ShoppingCart, Receipt, Timer, NotebookPen, ChartColumn, FolderOpen, CircleCheck, ChevronRight, Settings, Menu as MenuIcon, Plus, Moon, Sun } from 'lucide-react';
import { INDIAN_STATES } from '@shared/calc.js';
import Assistant from './Assistant.jsx';
import { setThemeAttr } from '../lib/theme.js';

export const NAV = [
  { label: 'Home', icon: House, to: '/', end: true },
  { label: 'Items', icon: Package, module: 'items', children: [
    { label: 'Items', to: '/items' }, { label: 'Inventory Adjustments', to: '/inventory/adjustments' }, { label: 'Price Lists', to: '/inventory/price-lists' }] },
  { label: 'Banking', icon: Landmark, module: 'banking', to: '/banking' },
  { label: 'Sales', icon: ShoppingCart, module: 'sales', children: [
    { label: 'Customers', to: '/customers', module: 'contacts' }, { label: 'Quotes', to: '/quotes' }, { label: 'Sales Orders', to: '/salesorders' },
    { label: 'Delivery Challans', to: '/deliverychallans' }, { label: 'Invoices', to: '/invoices' }, { label: 'Retainer Invoices', to: '/retainerinvoices' },
    { label: 'Sales Receipts', to: '/salesreceipts' }, { label: 'Recurring Invoices', to: '/recurringinvoices' },
    { label: 'Payments Received', to: '/payments-received' }, { label: 'Credit Notes', to: '/creditnotes' }] },
  { label: 'Purchases', icon: Receipt, module: 'purchases', children: [
    { label: 'Vendors', to: '/vendors', module: 'contacts' }, { label: 'Expenses', to: '/expenses' }, { label: 'Recurring Expenses', to: '/recurring-expenses' },
    { label: 'Purchase Orders', to: '/purchaseorders' }, { label: 'Bills', to: '/bills' }, { label: 'Recurring Bills', to: '/recurringbills' },
    { label: 'Payments Made', to: '/payments-made' }, { label: 'Vendor Credits', to: '/vendorcredits' }] },
  { label: 'Time Tracking', icon: Timer, module: 'projects', children: [
    { label: 'Projects', to: '/time/projects' }, { label: 'Timesheet', to: '/time/timesheet' }] },
  { label: 'Accountant', icon: NotebookPen, module: 'accountant', children: [
    { label: 'Manual Journals', to: '/accountant/journals' }, { label: 'Recurring Journals', to: '/accountant/recurring-journals' },
    { label: 'Chart of Accounts', to: '/accountant/chart-of-accounts' }, { label: 'Budgets', to: '/accountant/budgets' },
    { label: 'Fixed Assets', to: '/accountant/fixed-assets' }, { label: 'Transaction Locking', to: '/accountant/transaction-locking' },
    { label: 'Currency Adjustments', to: '/accountant/currency-adjustments' }] },
  { label: 'Reports', icon: ChartColumn, module: 'reports', to: '/reports' },
  { label: 'Documents', icon: FolderOpen, module: 'documents', to: '/documents' },
  { label: 'Approvals', icon: CircleCheck, to: '/approvals' },
];

function NavGroup({ g, can, pathname }) {
  const anyActive = g.children.some((c) => pathname.startsWith(c.to));
  const [open, setOpen] = useState(anyActive);
  useEffect(() => { if (anyActive) setOpen(true); }, [anyActive]);
  const kids = g.children.filter((c) => can(c.module || g.module));
  if (!kids.length) return null;
  return (
    <div>
      <button className="nav-group-btn" onClick={() => setOpen((o) => !o)}>
        <span className="nav-icon"><g.icon size={16} strokeWidth={1.5} /></span>{g.label}
        <span className={`nav-caret ${open ? 'open' : ''}`}><ChevronRight size={14} strokeWidth={1.5} /></span>
      </button>
      {open && <div className="nav-sub">{kids.map((c) => <NavLink key={c.to} to={c.to} className="nav-item">{c.label}</NavLink>)}</div>}
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const nav = useNavigate();
  const ref = useRef();
  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const t = setTimeout(() => api.get('/search', { q }).then((r) => setRes(r.results)).catch(() => setRes([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const k = (e) => { if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="search-wrap">
      {!q && <span className="kbd search-kbd" aria-hidden="true">/</span>}
      <input ref={ref} className="input" placeholder="Search" aria-label="Search customers, items and documents" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setRes(null), 200)} />
      {res && (
        <div className="search-results">
          {!res.length && <div className="pad muted">No results</div>}
          {res.map((r) => (
            <a key={`${r.kind}-${r.id}`} className="search-result" href={r.url} onMouseDown={(e) => { e.preventDefault(); nav(r.url); setQ(''); setRes(null); }}>
              <div className="bold">{r.title}</div><div className="muted small">{r.kind.replace(/_/g, ' ')} · {r.subtitle}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const QUICK = [
  ['Invoice', '/invoices/new', 'sales'], ['Quote', '/quotes/new', 'sales'], ['Customer', '/customers/new', 'contacts'], ['Payment Received', '/payments-received/new', 'sales'],
  ['Bill', '/bills/new', 'purchases'], ['Expense', '/expenses/new', 'purchases'], ['Vendor', '/vendors/new', 'contacts'], ['Item', '/items/new', 'items'],
  ['Journal', '/accountant/journals/new', 'accountant'], ['Project', '/time/projects/new', 'projects'],
];

export function NewOrgModal({ onClose }) {
  const { switchOrg, reload, toast } = useApp();
  const [f, setF] = useState({ name: '', country: 'India', state: '27', currency: 'INR', industry: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const o = await api.post('/auth/orgs', f);
      await reload();
      await switchOrg(o.id);
      toast(`Organization "${o.name}" created`);
      onClose();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="New Organization" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Create</Button></>}>
      <div className="stack">
        <Field label="Organization Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Industry"><Input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} /></Field>
        <Field label="Country"><Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value, currency: e.target.value === 'India' ? 'INR' : f.currency })} options={['India', 'United States', 'United Kingdom', 'United Arab Emirates', 'Singapore', 'Australia', 'Canada', 'Other'].map((x) => [x, x])} /></Field>
        {f.country === 'India' && <Field label="State"><Select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} options={INDIAN_STATES} /></Field>}
        <Field label="Base Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} options={['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'].map((x) => [x, x])} /></Field>
      </div>
    </Modal>
  );
}

function useTheme() {
  const read = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    // the Profile page can change the theme too, so follow the attribute rather than local state
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  const toggle = () => {
    const t = read() === 'dark' ? 'light' : 'dark';
    setThemeAttr(t);
    try { localStorage.setItem('ob_theme', t); } catch { /* storage unavailable: the choice still applies for this visit */ }
    api.put('/auth/me', { theme: t }).catch(() => {}); // saved to the profile when possible; the switch never waits on it
  };
  return [theme, toggle];
}

export default function Layout({ children }) {
  const { user, org, orgs, invites, switchOrg, logout, can, reload, toast } = useApp();
  const [theme, toggleTheme] = useTheme();
  const { pathname } = useLocation();
  const answerInvite = async (o, accept) => {
    try {
      await (accept ? api.post(`/auth/invites/${o.id}/accept`) : api.del(`/auth/invites/${o.id}`));
      await reload();
      if (accept) await switchOrg(o.id);
      toast(accept ? `You joined ${o.name}` : `Invitation to ${o.name} declined`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const nav = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [newOrg, setNewOrg] = useState(false);
  useEffect(() => setMobile(false), [pathname]);
  useEffect(() => {
    // keyboard shortcuts: Alt+N new invoice, Alt+P payment, Alt+H home
    const k = (e) => {
      if (!e.altKey) return;
      const map = { n: '/invoices/new', p: '/payments-received/new', h: '/', e: '/expenses/new', b: '/bills/new', c: '/customers/new' };
      const to = map[e.key.toLowerCase()];
      if (to) { e.preventDefault(); nav(to); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [nav]);

  return (
    <div className="app">
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <div className="brand"><img className="brand-mark" src="/brand/beyondsure-mark.png" alt="" />BeyondBooks</div>
        <nav className="nav">
          {NAV.map((g) => (g.children
            ? <NavGroup key={g.label} g={g} can={can} pathname={pathname} />
            : (!g.module || can(g.module)) && <NavLink key={g.to} to={g.to} end={g.end} className="nav-item"><span className="nav-icon"><g.icon size={16} strokeWidth={1.5} /></span>{g.label}</NavLink>))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setMobile((m) => !m)} aria-label="Menu"><MenuIcon size={18} strokeWidth={1.5} /></button>
          <GlobalSearch />
          <Menu label={<><Plus size={16} strokeWidth={1.75} />New</>} variant="primary" align="left" items={QUICK.filter(([, , m]) => can(m, 'create')).map(([l, to]) => ({ label: l, onClick: () => nav(to) }))} />
          <div className="org-switch">
            <Menu label={org?.name || 'Organization'} items={[
              ...orgs.map((o) => ({ label: `${String(o.id) === String(org?.id) ? '✓ ' : ''}${o.name}`, onClick: () => switchOrg(o.id) })),
              ...(invites || []).flatMap((o) => [
                { divider: true },
                { label: `Accept invitation: ${o.name} (${o.role})`, onClick: () => answerInvite(o, true) },
                { label: `Decline invitation: ${o.name}`, onClick: () => answerInvite(o, false) },
              ]),
              { divider: true },
              { label: '+ New Organization', onClick: () => setNewOrg(true) },
            ]} />
            <button type="button" className="icon-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              {theme === 'dark' ? <Sun size={18} strokeWidth={1.5} /> : <Moon size={18} strokeWidth={1.5} />}
            </button>
            {can('settings') && <Link to="/settings" className="icon-btn" title="Settings" aria-label="Settings"><Settings size={18} strokeWidth={1.5} /></Link>}
            <Menu label={<span className="avatar">{user?.name?.[0]?.toUpperCase()}</span>} variant="link" items={[
              { label: user?.email, onClick: () => nav('/profile') },
              { label: 'My Profile', onClick: () => nav('/profile') },
              { label: 'Sign out', onClick: () => { logout(); nav('/login'); }, danger: true },
            ]} />
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
      {newOrg && <NewOrgModal onClose={() => setNewOrg(false)} />}
      {!pathname.startsWith('/print') && <Assistant />}
    </div>
  );
}
