import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Modal, Field, Input, Textarea, Select, Menu, Empty, AccountSelect, Tabs, Money, Spinner } from '../../components/ui.jsx';
import { ACCOUNT_TYPE_LABELS } from '@shared/calc.js';
import { CLASS_LABELS, classOf, typeOptions, errText } from './common.js';
import { Star, MoreHorizontal } from 'lucide-react';

const BANK_TYPES = ['bank', 'credit_card'];

/** Create or edit an account. account = null for a new one. */
export function AccountModal({ account, onClose, onSaved }) {
  const { toast, refreshMeta } = useApp();
  const isEdit = !!account?.id;
  const [f, setF] = useState(() => ({
    name: account?.name || '', code: account?.code || '', type: account?.type || '', parent_id: account?.parent_id || '',
    description: account?.description || '', bank_name: account?.bank_name || '', account_number: account?.account_number || '', ifsc: account?.ifsc || '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const isBank = BANK_TYPES.includes(f.type);

  const save = async () => {
    if (!f.name.trim()) return toast('Account name is required', 'error');
    if (!f.type) return toast('Choose an account type', 'error');
    const body = {
      name: f.name.trim(), code: f.code || null, type: f.type, parent_id: f.parent_id || null, description: f.description || null,
      ...(isBank ? { bank_name: f.bank_name || null, account_number: f.account_number || null, ifsc: f.ifsc || null } : {}),
    };
    setBusy(true);
    try {
      const saved = isEdit ? await api.put(`/accounts/${account.id}`, body) : await api.post('/accounts', body);
      await refreshMeta();
      toast(isEdit ? 'Account updated' : 'Account created');
      onSaved?.(saved);
    } catch (e) { toast(errText(e), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title={isEdit ? 'Edit Account' : 'New Account'} onClose={onClose} width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Field label="Account Name" required><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid2">
          <Field label="Account Code"><Input value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label="Account Type" required>
            <Select placeholder="Select a type" options={typeOptions()} value={f.type} disabled={isEdit && account.is_system}
              onChange={(e) => setF((x) => ({ ...x, type: e.target.value, parent_id: '' }))} />
          </Field>
        </div>
        <Field label="Parent Account" hint="Only accounts of the same type can be parents.">
          <AccountSelect placeholder="None (top level)" value={f.parent_id}
            filter={(a) => a.type === f.type && a.id !== account?.id && a.is_active} onChange={(v) => set('parent_id', v)} />
        </Field>
        {isBank && (
          <div className="grid3">
            <Field label="Bank Name"><Input value={f.bank_name} onChange={(e) => set('bank_name', e.target.value)} /></Field>
            <Field label="Account Number"><Input value={f.account_number} onChange={(e) => set('account_number', e.target.value)} /></Field>
            <Field label="IFSC"><Input value={f.ifsc} onChange={(e) => set('ifsc', e.target.value)} /></Field>
          </div>
        )}
        <Field label="Description"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export default function ChartOfAccounts() {
  const { can, toast, refreshMeta } = useApp();
  const [status, setStatus] = useState('all');
  const [cls, setCls] = useState('');
  const [editing, setEditing] = useState(null); // null | {} (new) | account
  const { data, loading, reload } = useFetch('/accounts');

  const rows = useMemo(() => (data || []).filter((a) =>
    (status === 'all' || (status === 'active') === !!a.is_active) && (!cls || classOf(a.type) === cls)), [data, status, cls]);
  const groups = Object.keys(ACCOUNT_TYPE_LABELS)
    .map((t) => ({ type: t, items: rows.filter((a) => a.type === t) }))
    .filter((g) => g.items.length);

  const act = async (fn, msg) => {
    try { await fn(); toast(msg); reload(); refreshMeta(); } catch (e) { toast(errText(e), 'error'); }
  };
  const toggleWatch = (a) => act(() => api.put(`/accounts/${a.id}`, { watchlist: a.watchlist ? 0 : 1 }), a.watchlist ? 'Removed from watchlist' : 'Added to watchlist');
  const setActive = (a, on) => act(() => api.put(`/accounts/${a.id}`, { is_active: on ? 1 : 0 }), on ? 'Account activated' : 'Account marked inactive');
  const remove = (a) => {
    if (!window.confirm(`Delete the account "${a.name}"?`)) return;
    act(() => api.del(`/accounts/${a.id}`), 'Account deleted');
  };

  return (
    <div className="page">
      <PageHeader title="Chart of Accounts" subtitle="Every account in your general ledger, grouped by type."
        actions={can('accountant', 'create') && <Button variant="primary" onClick={() => setEditing({})}>+ New Account</Button>}>
        <Tabs active={status} onChange={setStatus} tabs={[{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'inactive', label: 'Inactive' }]} />
        <Select style={{ width: 200 }} placeholder="All types" value={cls} onChange={(e) => setCls(e.target.value)}
          options={Object.entries(CLASS_LABELS).map(([k, v]) => [k, v])} />
      </PageHeader>

      {loading && !data ? <Spinner /> : !groups.length ? <Empty title="No accounts" text="Nothing matches these filters." /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Code</th><th>Account Name</th><th>Type</th><th>Parent Account</th>
                <th className="r" style={{ width: 140 }}>Balance</th><th style={{ width: 40 }} />
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.type}>
                <tr className="section-row"><td colSpan={6}><b>{ACCOUNT_TYPE_LABELS[g.type]}</b></td></tr>
                {g.items.map((a) => (
                  <tr key={a.id} className={a.is_active ? '' : 'muted'}>
                    <td>{a.code}</td>
                    <td>
                      <Link to={`/accountant/chart-of-accounts/${a.id}`} className="bold">{a.name}</Link>
                      {!a.is_active && <span className="badge badge-gray" style={{ marginLeft: 8 }}>Inactive</span>}
                      {a.is_system ? <span className="small muted" style={{ marginLeft: 8 }}>System</span> : null}
                    </td>
                    <td>{ACCOUNT_TYPE_LABELS[a.type] || a.type}</td>
                    <td className="muted">{a.parent_name || ''}</td>
                    <td className="r"><Money value={a.balance} /></td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <button className="icon-btn" title={a.watchlist ? 'Remove from watchlist' : 'Add to watchlist'} onClick={() => toggleWatch(a)}
                          style={{ color: a.watchlist ? 'var(--orange)' : undefined }}>{a.watchlist ? <Star size={18} strokeWidth={1.5} fill="currentColor" /> : <Star size={18} strokeWidth={1.5} />}</button>
                        <Menu label={<MoreHorizontal size={18} strokeWidth={1.5} />} items={[
                          { label: 'Edit', hidden: !can('accountant', 'edit'), onClick: () => setEditing(a) },
                          { label: 'Mark as Inactive', hidden: !can('accountant', 'edit') || !a.is_active || a.is_system, onClick: () => setActive(a, false) },
                          { label: 'Mark as Active', hidden: !can('accountant', 'edit') || a.is_active, onClick: () => setActive(a, true) },
                          { divider: true },
                          { label: 'Delete', danger: true, hidden: !can('accountant', 'delete') || a.is_system, onClick: () => remove(a) },
                        ]} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {editing && <AccountModal account={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
