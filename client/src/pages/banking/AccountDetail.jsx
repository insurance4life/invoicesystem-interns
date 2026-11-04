import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Tabs, Menu, Badge, Spinner, Modal, Field, Input, NumberInput, Select, AccountSelect, Empty, SearchBox } from '../../components/ui.jsx';
import { AccountModal, TransactionModal, ContactSelect, SrcLink, BANK_TYPE_LABELS, TXN_LABELS, IN_TYPES, OUT_TYPES, SRC_LABELS, isTransfer, bankFilter, DEFAULT_OFFSET } from './common.jsx';
import { today } from '../../lib/format.js';

export default function AccountDetail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'uncategorized';
  const { money, date, can, toast, refreshMeta } = useApp();
  const nav = useNavigate();
  const acc = useFetch(`/banking/accounts/${id}`);
  const [modal, setModal] = useState(null);
  const a = acc.data;
  const setTab = (t) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  if (acc.loading && !a) return <div className="page"><Spinner /></div>;
  if (!a) return <div className="page"><Empty title="Account not found" /></div>;
  const reloadAll = () => acc.reload();

  return (
    <div className="page">
      <PageHeader
        back={<Button variant="link" onClick={() => nav('/banking')}>←</Button>}
        title={a.name}
        subtitle={[BANK_TYPE_LABELS[a.type], a.bank_name, a.account_number, a.ifsc].filter(Boolean).join(' · ')}
        actions={<>
          {can('banking', 'create') && <Button onClick={() => nav(`/banking/accounts/${a.id}/import`)}>Import Statement</Button>}
          {can('banking', 'create') && <Button variant="primary" onClick={() => setModal({ txn: {} })}>+ Add Transaction</Button>}
          <Menu items={[
            { label: 'Edit Account', onClick: () => setModal({ account: a }), hidden: !can('banking', 'edit') },
            { label: 'Bank Rules', onClick: () => nav('/banking/rules') },
            { label: 'Delete Account', danger: true, hidden: !can('banking', 'delete') || a.is_system, onClick: async () => {
              if (!window.confirm(`Delete ${a.name}?`)) return;
              try { await api.del(`/banking/accounts/${a.id}`); await refreshMeta(); toast('Account deleted'); nav('/banking'); } catch (e) { toast(e.message, 'error'); }
            } },
          ]} />
        </>}
      />
      <div className="bk-head card mb">
        <div><div className="muted small">BALANCE IN OPENBOOKS</div><div className="bk-big">{money(a.balance, a.currency)}</div></div>
        <div><div className="muted small">AMOUNT IN BANK</div><div className="bk-big">{a.statement_balance == null ? '—' : money(a.statement_balance, a.currency)}</div>{a.statement_balance_date && <div className="muted small">as of {date(a.statement_balance_date)}</div>}</div>
        <div><div className="muted small">UNCATEGORIZED</div><div className="bk-big">{a.uncategorized}</div></div>
        <div><div className="muted small">LAST RECONCILED</div><div className="bk-big">{a.last_reconciled ? date(a.last_reconciled) : 'Never'}</div></div>
      </div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'uncategorized', label: 'Uncategorized', count: a.uncategorized },
        { key: 'done', label: 'Categorized / Matched', count: a.categorized },
        { key: 'excluded', label: 'Excluded' },
        { key: 'all', label: 'All Transactions' },
        { key: 'reconciliations', label: 'Reconciliations' },
      ]} />
      {tab === 'uncategorized' && <UncategorizedTab account={a} onChange={reloadAll} />}
      {tab === 'done' && <LinesTab account={a} status="done" onChange={reloadAll} />}
      {tab === 'excluded' && <LinesTab account={a} status="excluded" onChange={reloadAll} />}
      {tab === 'all' && <AllTransactionsTab account={a} onChange={reloadAll} />}
      {tab === 'reconciliations' && <ReconciliationsTab account={a} />}
      {modal?.account && <AccountModal account={modal.account} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); }} />}
      {modal?.txn && <TransactionModal accountId={a.id} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); setTab('all'); }} />}
    </div>
  );
}

// ---------------- uncategorized ----------------
function UncategorizedTab({ account, onChange }) {
  const { money, date, can, toast } = useApp();
  const [q, setQ] = useState('');
  const { data, loading, reload } = useFetch(`/banking/accounts/${account.id}/statement-lines`, { status: 'uncategorized', q });
  const [sel, setSel] = useState(null);
  const [checked, setChecked] = useState([]);
  const [bulk, setBulk] = useState(false);
  const rows = data || [];
  const current = rows.find((r) => r.id === sel?.id) || null;
  const done = () => { setSel(null); setChecked([]); reload(); onChange(); };

  const bulkExclude = async () => {
    try { const r = await api.post(`/banking/accounts/${account.id}/statement-lines/bulk-exclude`, { ids: checked }); toast(`${r.ok} excluded`); done(); } catch (e) { toast(e.message, 'error'); }
  };
  const applyRules = async () => {
    try { const r = await api.post(`/banking/accounts/${account.id}/apply-rules`); toast(`Rules applied: ${r.categorized} categorized, ${r.suggested} suggested`); done(); } catch (e) { toast(e.message, 'error'); }
  };

  const cols = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'description', label: 'Statement Details', render: (r) => (
      <div>
        <div>{r.description || <span className="muted">No description</span>}</div>
        <div className="muted small">{[r.reference && `Ref: ${r.reference}`, r.payee].filter(Boolean).join(' · ')}</div>
        {r.suggestion && <div className="small bk-sugg">Rule “{r.suggestion.rule_name}” suggests {TXN_LABELS[r.suggestion.txn_type] || r.suggestion.txn_type}</div>}
      </div>
    ) },
    { key: 'deposit', label: 'Deposits', align: 'right', render: (r) => (r.deposit ? money(r.deposit, account.currency) : '') },
    { key: 'withdrawal', label: 'Withdrawals', align: 'right', render: (r) => (r.withdrawal ? money(r.withdrawal, account.currency) : '') },
  ];

  return (
    <div className={current ? 'bk-split' : ''}>
      <div>
        <div className="row between mb">
          <div className="row">
            <SearchBox value={q} onChange={setQ} placeholder="Search statement lines" />
            {checked.length > 0 && can('banking', 'edit') && <>
              <Button onClick={() => setBulk(true)}>Categorize {checked.length}</Button>
              <Button onClick={bulkExclude}>Exclude {checked.length}</Button>
            </>}
          </div>
          {can('banking', 'edit') && <Button size="sm" onClick={applyRules}>Apply Rules</Button>}
        </div>
        <Table columns={cols} rows={rows} loading={loading && !data} onRowClick={(r) => setSel(r)} rowClass={(r) => (r.id === current?.id ? 'bk-sel' : '')}
          selectable={can('banking', 'edit')} selected={checked} onSelect={setChecked}
          empty="All caught up! Import a statement to see uncategorized transactions here." />
      </div>
      {current && <MatchPanel key={current.id} line={current} account={account} onClose={() => setSel(null)} onDone={done} />}
      {bulk && <BulkModal account={account} ids={checked} lines={rows.filter((r) => checked.includes(r.id))} onClose={() => setBulk(false)} onDone={() => { setBulk(false); done(); }} />}
    </div>
  );
}

function MatchPanel({ line, account, onClose, onDone }) {
  const { money, date, toast, can } = useApp();
  const [mode, setMode] = useState('match');
  const [sug, setSug] = useState(null);
  const [choice, setChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const dirIn = line.amount > 0;
  const amt = Math.abs(line.amount);

  useEffect(() => {
    let live = true;
    api.post(`/banking/statement-lines/${line.id}/match-suggestions`).then((s) => {
      if (!live) return;
      setSug(s);
      if (!s.matches.length && !s.documents.length) setMode('categorize');
      if (s.matches.length) setChoice(`t:${s.matches[0].matched_type}:${s.matches[0].matched_id}`);
    }).catch((e) => toast(e.message, 'error'));
    return () => { live = false; };
  }, [line.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); toast(msg); onDone(); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const doMatch = () => {
    if (!choice) return toast('Choose a transaction to match', 'error');
    const [k, a, b] = choice.split(':');
    const body = k === 't' ? { matched_type: a, matched_id: Number(b) } : { [`${a}_id`]: Number(b) };
    return act(() => api.post(`/banking/statement-lines/${line.id}/match`, body), 'Transaction matched');
  };

  return (
    <div className="bk-panel card">
      <div className="card-head">
        <div>
          <h3>{dirIn ? 'Deposit' : 'Withdrawal'} of {money(amt, account.currency)}</h3>
          <div className="muted small">{date(line.date)} · {line.description || 'No description'}{line.reference ? ` · Ref ${line.reference}` : ''}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="card-body">
        <Tabs active={mode} onChange={setMode} tabs={[{ key: 'match', label: 'Match Transactions', count: sug ? sug.matches.length + sug.documents.length : undefined }, { key: 'categorize', label: 'Categorize Manually' }]} />
        {mode === 'match' && (!sug ? <Spinner /> : (
          <div className="stack">
            {!sug.matches.length && !sug.documents.length && <p className="muted">No transactions of {money(amt)} within 7 days of {date(line.date)}. Categorize it manually instead.</p>}
            {sug.matches.length > 0 && <div className="muted small bold">BEST MATCHES</div>}
            {sug.matches.map((m) => {
              const key = `t:${m.matched_type}:${m.matched_id}`;
              return (
                <label key={key} className={`bk-opt ${choice === key ? 'on' : ''}`}>
                  <input type="radio" name="match" checked={choice === key} onChange={() => setChoice(key)} />
                  <div className="grow">
                    <div className="row between"><span className="bold">{m.label}{m.number ? ` · ${m.number}` : ''}</span><span>{money(m.amount)}</span></div>
                    <div className="muted small">{date(m.date)}{m.contact_name ? ` · ${m.contact_name}` : ''}{m.description ? ` · ${m.description}` : ''}</div>
                  </div>
                </label>
              );
            })}
            {sug.documents.length > 0 && <div className="muted small bold">OPEN {dirIn ? 'INVOICES' : 'BILLS'} (RECORDS A PAYMENT)</div>}
            {sug.documents.map((d) => {
              const kind = dirIn ? 'invoice' : 'bill';
              const key = `d:${kind}:${d[`${kind}_id`]}`;
              return (
                <label key={key} className={`bk-opt ${choice === key ? 'on' : ''}`}>
                  <input type="radio" name="match" checked={choice === key} onChange={() => setChoice(key)} />
                  <div className="grow">
                    <div className="row between"><span className="bold">{d.label} {d.number}</span><span>{money(d.amount)}</span></div>
                    <div className="muted small">{d.contact_name} · {date(d.date)}{d.due_date ? ` · due ${date(d.due_date)}` : ''}</div>
                  </div>
                </label>
              );
            })}
            {(sug.matches.length > 0 || sug.documents.length > 0) && can('banking', 'edit') && (
              <div className="row"><Button variant="primary" loading={busy} onClick={doMatch}>Match</Button></div>
            )}
          </div>
        ))}
        {mode === 'categorize' && <CategorizeForm line={line} account={account} busy={busy} onSubmit={(body) => act(() => api.post(`/banking/statement-lines/${line.id}/categorize`, body), 'Transaction categorized')} />}
        {can('banking', 'edit') && (
          <div className="row mt bk-panel-foot">
            <Button size="sm" onClick={() => act(() => api.post(`/banking/statement-lines/${line.id}/exclude`), 'Transaction excluded')}>Exclude</Button>
            {can('banking', 'delete') && <Button size="sm" variant="danger" onClick={() => window.confirm('Delete this statement line?') && act(() => api.del(`/banking/statement-lines/${line.id}`), 'Statement line deleted')}>Delete</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Categorize form; also used for bulk categorization (line = first selected line). */
export function CategorizeForm({ line, account, onSubmit, busy, bulkDirIn }) {
  const { money } = useApp();
  const isBulk = bulkDirIn !== undefined;
  const dirIn = isBulk ? bulkDirIn : line.amount > 0;
  const amt = line ? Math.abs(line.amount) : 0;
  const s = line?.suggestion || {};
  const [f, setF] = useState({
    txn_type: s.txn_type || (dirIn ? 'deposit' : 'expense'), offset_account_id: s.offset_account_id || '', contact_id: s.contact_id || '',
    reference: s.reference || line?.reference || '', description: line?.description || '', to_account_id: '',
  });
  const [split, setSplit] = useState(false);
  const [splits, setSplits] = useState([{ offset_account_id: '', amount: amt }, { offset_account_id: '', amount: '' }]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const types = (dirIn ? IN_TYPES : OUT_TYPES).map((t) => [t, TXN_LABELS[t]]);
  const transfer = isTransfer(f.txn_type);
  const payment = ['customer_payment', 'vendor_payment'].includes(f.txn_type);
  const splitTotal = splits.reduce((x, y) => x + (Number(y.amount) || 0), 0);
  const canSplit = !transfer && !payment && !isBulk;

  const submit = () => {
    const body = { ...f, offset_account_id: f.offset_account_id || null, to_account_id: f.to_account_id || null, contact_id: f.contact_id || null };
    if (transfer) { body.to_account_id = f.to_account_id; body.offset_account_id = null; }
    if (split && canSplit) { body.splits = splits.filter((x) => x.offset_account_id && Number(x.amount)); body.offset_account_id = null; }
    onSubmit(body);
  };

  const contactType = f.txn_type === 'customer_payment' ? 'customer' : f.txn_type === 'vendor_payment' ? 'vendor' : f.txn_type === 'expense' ? 'vendor' : undefined;
  return (
    <div className="stack">
      <Field label="Category"><Select value={f.txn_type} options={types} onChange={set('txn_type')} /></Field>
      {transfer && (
        <Field label={dirIn ? 'From Account' : 'To Account'} required>
          <AccountSelect value={f.to_account_id} onChange={set('to_account_id')} filter={(a) => bankFilter(a) && a.id !== account.id} />
        </Field>
      )}
      {!transfer && !payment && !split && (
        <Field label={f.txn_type === 'expense' ? 'Expense Account' : dirIn ? 'From Account' : 'To Account'} required={!DEFAULT_OFFSET.includes(f.txn_type)}
          hint={DEFAULT_OFFSET.includes(f.txn_type) ? 'Optional: the default account for this category is used when empty' : undefined}>
          <AccountSelect value={f.offset_account_id} onChange={set('offset_account_id')} filter={f.txn_type === 'expense' ? ['expense', 'cost_of_goods_sold', 'other_expense', 'fixed_asset', 'other_current_asset'] : (a) => a.id !== account.id} />
        </Field>
      )}
      {split && canSplit && (
        <div className="bk-splits">
          {splits.map((x, i) => (
            <div key={i} className="row">
              <div className="grow"><AccountSelect value={x.offset_account_id} onChange={(v) => setSplits((p) => p.map((y, j) => (j === i ? { ...y, offset_account_id: v } : y)))} filter={(a) => a.id !== account.id} /></div>
              <div style={{ width: 120 }}><NumberInput value={x.amount} onChange={(v) => setSplits((p) => p.map((y, j) => (j === i ? { ...y, amount: v } : y)))} /></div>
              <Button size="sm" variant="link" onClick={() => setSplits((p) => p.filter((_, j) => j !== i))}>×</Button>
            </div>
          ))}
          <div className="row between small">
            <Button size="sm" variant="link" onClick={() => setSplits((p) => [...p, { offset_account_id: '', amount: '' }])}>+ Add split</Button>
            <span className={Math.abs(splitTotal - amt) > 0.005 ? 'neg' : 'muted'}>Total {money(splitTotal)} of {money(amt)}</span>
          </div>
        </div>
      )}
      {canSplit && <Button size="sm" variant="link" onClick={() => setSplit((x) => !x)}>{split ? 'Use a single account' : 'Split across accounts'}</Button>}
      {!transfer && (
        <Field label={f.txn_type === 'customer_payment' ? 'Customer' : f.txn_type === 'vendor_payment' || f.txn_type === 'expense' ? 'Vendor' : 'Contact'} required={payment}>
          <ContactSelect value={f.contact_id} onChange={set('contact_id')} type={contactType} />
        </Field>
      )}
      <Field label="Reference#"><Input value={f.reference} onChange={set('reference')} /></Field>
      {!isBulk && <Field label="Description"><Input value={f.description} onChange={set('description')} /></Field>}
      {f.txn_type === 'customer_payment' && <p className="muted small">The payment is recorded as an advance (unused credit) that you can apply to invoices later.</p>}
      <div className="row"><Button variant="primary" loading={busy} onClick={submit}>Save</Button></div>
    </div>
  );
}

function BulkModal({ account, ids, lines, onClose, onDone }) {
  const { toast } = useApp();
  const dirs = new Set(lines.map((l) => l.amount > 0));
  const [busy, setBusy] = useState(false);
  if (dirs.size > 1) {
    return <Modal title="Categorize" onClose={onClose}><p>Select either only deposits or only withdrawals to categorize them together.</p></Modal>;
  }
  const dirIn = [...dirs][0];
  const submit = async (body) => {
    setBusy(true);
    try {
      const r = await api.post(`/banking/accounts/${account.id}/statement-lines/bulk-categorize`, { ids, ...body, description: undefined });
      toast(`${r.ok} categorized${r.errors.length ? `, ${r.errors.length} failed: ${r.errors[0].error}` : ''}`, r.errors.length ? 'error' : 'success');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Categorize ${ids.length} ${dirIn ? 'deposits' : 'withdrawals'}`} onClose={onClose}>
      <CategorizeForm line={{ ...lines[0], suggestion: null, reference: '', description: '' }} account={account} bulkDirIn={dirIn} busy={busy} onSubmit={submit} />
    </Modal>
  );
}

// ---------------- categorized / excluded ----------------
function LinesTab({ account, status, onChange }) {
  const { money, date, can, toast } = useApp();
  const { data, loading, reload } = useFetch(`/banking/accounts/${account.id}/statement-lines`, { status });
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); onChange(); } catch (e) { toast(e.message, 'error'); } };
  const cols = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'description', label: 'Statement Details', render: (r) => <div>{r.description}<div className="muted small">{r.reference}</div></div> },
    ...(status === 'done' ? [{ key: 'matched', label: 'Transaction', render: (r) => (
      <div>
        <Badge status={r.status} />{' '}
        <SrcLink type={r.matched_type} id={r.matched_id}>{SRC_LABELS[r.matched_type] || r.matched_type}{r.matched_number ? ` ${r.matched_number}` : ''}</SrcLink>
        <div className="muted small">{[r.matched_txn_type && TXN_LABELS[r.matched_txn_type], r.matched_account, r.matched_contact].filter(Boolean).join(' · ')}</div>
      </div>
    ) }] : []),
    { key: 'deposit', label: 'Deposits', align: 'right', render: (r) => (r.deposit ? money(r.deposit, account.currency) : '') },
    { key: 'withdrawal', label: 'Withdrawals', align: 'right', render: (r) => (r.withdrawal ? money(r.withdrawal, account.currency) : '') },
    { key: 'act', label: '', align: 'right', render: (r) => (can('banking', 'edit') ? (
      status === 'done'
        ? <Button size="sm" onClick={() => window.confirm(r.matched_type === 'bank_txn' ? 'Uncategorize? The bank transaction created for this line will be deleted.' : 'Unmatch this line? The linked transaction is kept.') && act(() => api.post(`/banking/statement-lines/${r.id}/uncategorize`), 'Line uncategorized')}>{r.status === 'matched' ? 'Unmatch' : 'Uncategorize'}</Button>
        : <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => act(() => api.post(`/banking/statement-lines/${r.id}/restore`), 'Line restored')}>Restore</Button>
            {can('banking', 'delete') && <Button size="sm" variant="danger" onClick={() => window.confirm('Delete this statement line?') && act(() => api.del(`/banking/statement-lines/${r.id}`), 'Line deleted')}>Delete</Button>}
          </div>
    ) : null) },
  ];
  return <Table columns={cols} rows={data || []} loading={loading && !data} empty={status === 'done' ? 'No categorized or matched statement lines yet.' : 'No excluded statement lines.'} />;
}

// ---------------- all transactions (ledger) ----------------
function AllTransactionsTab({ account, onChange }) {
  const { money, date, can, toast } = useApp();
  const [range, setRange] = useState({ from: '', to: '' });
  const { data, loading, reload } = useFetch(`/banking/accounts/${account.id}/transactions`, range);
  const [edit, setEdit] = useState(null);
  const rows = [...(data?.rows || [])].reverse();
  const open = async (r) => {
    if (r.src_type !== 'bank_txn') return;
    try { setEdit(await api.get(`/banking/transactions/${r.src_id}`)); } catch (e) { toast(e.message, 'error'); }
  };
  const del = async (r) => {
    if (!window.confirm('Delete this bank transaction?')) return;
    try { await api.del(`/banking/transactions/${r.src_id}`); toast('Transaction deleted'); reload(); onChange(); } catch (e) { toast(e.message, 'error'); }
  };
  const cols = [
    { key: 'date', label: 'Date', render: (r) => date(r.date) },
    { key: 'type', label: 'Type', render: (r) => <SrcLink type={r.src_type} id={r.src_id}>{r.txn_type ? TXN_LABELS[r.txn_type] : SRC_LABELS[r.src_type] || r.src_type}</SrcLink> },
    { key: 'number', label: 'Reference#', render: (r) => r.number || '' },
    { key: 'description', label: 'Details', render: (r) => <div>{r.contact_name}<div className="muted small">{r.description}</div></div> },
    { key: 'status', label: 'Status', render: (r) => (r.reconciled ? <Badge status="reconciled" /> : r.matched ? <Badge status="matched" /> : null) },
    { key: 'deposit', label: 'Deposits', align: 'right', render: (r) => (r.deposit ? money(r.deposit, account.currency) : '') },
    { key: 'withdrawal', label: 'Withdrawals', align: 'right', render: (r) => (r.withdrawal ? money(r.withdrawal, account.currency) : '') },
    { key: 'balance', label: 'Running Balance', align: 'right', render: (r) => money(r.balance, account.currency) },
    { key: 'act', label: '', render: (r) => (r.src_type === 'bank_txn' && !r.reconciled && can('banking', 'delete')
      ? <span onClick={(e) => e.stopPropagation()}><Button size="sm" variant="link" onClick={() => del(r)}>Delete</Button></span> : null) },
  ];
  return (
    <div>
      <div className="row mb">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))} /></Field>
        {data && <div className="grow r muted small">Opening {money(data.opening_balance, account.currency)} · Closing <span className="bold">{money(data.closing_balance, account.currency)}</span></div>}
      </div>
      <Table columns={cols} rows={rows} loading={loading && !data} onRowClick={open} rowClass={(r) => (r.src_type === 'bank_txn' ? '' : 'bk-dim')} empty="No transactions in this account yet." />
      {edit && <TransactionModal accountId={account.id} txn={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); onChange(); }} />}
    </div>
  );
}

// ---------------- reconciliations ----------------
function ReconciliationsTab({ account }) {
  const { money, date, can, toast } = useApp();
  const nav = useNavigate();
  const { data, loading, reload } = useFetch(`/banking/accounts/${account.id}/reconciliations`);
  const [start, setStart] = useState(false);
  const rows = data || [];
  const inProgress = rows.find((r) => r.status === 'in_progress');
  const undo = async (r) => {
    if (!window.confirm(r.status === 'completed' ? 'Undo this reconciliation? Its transactions become unreconciled.' : 'Discard this reconciliation?')) return;
    try { await api.post(`/banking/reconciliations/${r.id}/undo`); toast('Reconciliation undone'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const cols = [
    { key: 'period', label: 'Period', render: (r) => `${r.start_date ? date(r.start_date) : 'Beginning'} – ${date(r.end_date)}` },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'opening_balance', label: 'Opening Balance', align: 'right', render: (r) => money(r.opening_balance, account.currency) },
    { key: 'closing_balance', label: 'Closing Balance', align: 'right', render: (r) => money(r.closing_balance, account.currency) },
    { key: 'cleared_count', label: 'Transactions', align: 'right' },
    { key: 'act', label: '', align: 'right', render: (r) => (
      <div className="row" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
        <Button size="sm" onClick={() => nav(`/banking/reconciliations/${r.id}`)}>{r.status === 'in_progress' ? 'Continue' : 'View'}</Button>
        {can('banking', 'delete') && <Button size="sm" variant="danger" onClick={() => undo(r)}>{r.status === 'completed' ? 'Undo' : 'Discard'}</Button>}
      </div>
    ) },
  ];
  return (
    <div>
      <div className="row between mb">
        <span className="muted">{account.last_reconciled ? `Reconciled up to ${date(account.last_reconciled)}` : 'This account has never been reconciled.'}</span>
        {can('banking', 'create') && !inProgress && <Button variant="primary" onClick={() => setStart(true)}>Start Reconciliation</Button>}
      </div>
      <Table columns={cols} rows={rows} loading={loading && !data} onRowClick={(r) => nav(`/banking/reconciliations/${r.id}`)} empty="No reconciliations yet." />
      {start && <StartReconModal account={account} onClose={() => setStart(false)} onStarted={(r) => nav(`/banking/reconciliations/${r.id}`)} />}
    </div>
  );
}

function StartReconModal({ account, onClose, onStarted }) {
  const { toast } = useApp();
  const [f, setF] = useState({ start_date: '', end_date: today(), closing_balance: account.statement_balance ?? '' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { onStarted(await api.post(`/banking/accounts/${account.id}/reconciliations`, f)); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Reconcile ${account.name}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Start Reconciliation</Button></>}>
      <div className="stack">
        <Field label="Statement Start Date" inline hint={account.last_reconciled ? 'Defaults to the day after the last reconciliation' : undefined}><Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        <Field label="Statement End Date" required inline><Input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
        <Field label="Closing Balance" required inline hint={account.type === 'credit_card' ? 'Amount owed on the card as per the statement' : 'Balance as per the bank statement'}>
          <NumberInput value={f.closing_balance} onChange={(v) => setF({ ...f, closing_balance: v })} />
        </Field>
      </div>
    </Modal>
  );
}

