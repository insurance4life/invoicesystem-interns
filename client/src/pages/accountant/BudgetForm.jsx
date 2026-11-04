import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, NumberInput, Select, Checkbox, Card, Spinner } from '../../components/ui.jsx';
import { classOf, MONTHS, errText, num, typeLabel } from './common.js';

const PERIODS = { monthly: { count: 12, months: 1 }, quarterly: { count: 4, months: 3 }, yearly: { count: 1, months: 12 } };
const STEPS = ['Details', 'Accounts', 'Amounts'];

/** Column headers for a budget period grid (same ranges the server uses). */
export function periodLabels(fy, period, startMonth = 4) {
  const { count, months } = PERIODS[period];
  const m0 = (Number(startMonth) || 4) - 1;
  return Array.from({ length: count }, (_, i) => {
    const s = new Date(Date.UTC(fy, m0 + i * months, 1));
    const e = new Date(Date.UTC(fy, m0 + (i + 1) * months, 0));
    if (period === 'monthly') return `${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`;
    if (period === 'quarterly') return `Q${i + 1} ${MONTHS[s.getUTCMonth()]}–${MONTHS[e.getUTCMonth()]}`;
    return `FY ${fy}–${String(fy + 1).slice(-2)}`;
  });
}

const defaultFY = (startMonth) => {
  const t = new Date();
  return (t.getMonth() + 1 >= startMonth ? t.getFullYear() : t.getFullYear() - 1);
};

export default function BudgetForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, org, toast } = useApp();
  const startMonth = org?.fiscal_year_start || 4;
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState(() => ({ name: '', fiscal_year: defaultFY(startMonth), period: 'monthly' }));
  // { [accountId]: amounts[] } – the selected accounts are the keys
  const [amounts, setAmounts] = useState({});
  const [fillAll, setFillAll] = useState('');

  useEffect(() => {
    if (!id) return;
    api.get(`/budgets/${id}`).then((b) => {
      setF({ name: b.name, fiscal_year: b.fiscal_year, period: b.period });
      setAmounts(Object.fromEntries(Object.entries(b.lines || {}).map(([k, v]) => [k, v.map(Number)])));
    }).catch((e) => toast(errText(e), 'error')).finally(() => setLoading(false));
  }, [id, toast]);

  const count = PERIODS[f.period]?.count || 12;
  const labels = useMemo(() => periodLabels(Number(f.fiscal_year), f.period, startMonth), [f.fiscal_year, f.period, startMonth]);
  const accounts = useMemo(() => (meta?.accounts || []).filter((a) => a.is_active && ['income', 'expense'].includes(classOf(a.type))), [meta]);
  const incomeAccounts = accounts.filter((a) => classOf(a.type) === 'income');
  const expenseAccounts = accounts.filter((a) => classOf(a.type) === 'expense');
  const selected = Object.keys(amounts);

  const setLen = (arr) => Array.from({ length: count }, (_, i) => num(arr?.[i]));
  const toggle = (accountId, on) => setAmounts((cur) => {
    const next = { ...cur };
    if (on) next[accountId] = setLen(cur[accountId]);
    else delete next[accountId];
    return next;
  });
  const setCell = (accountId, i, v) => setAmounts((cur) => ({ ...cur, [accountId]: cur[accountId].map((x, j) => (j === i ? num(v) : x)) }));
  const fillRow = (accountId, v) => setAmounts((cur) => ({ ...cur, [accountId]: Array.from({ length: count }, () => num(v)) }));
  const fillEverything = () => setAmounts((cur) => Object.fromEntries(Object.keys(cur).map((k) => [k, Array.from({ length: count }, () => num(fillAll))])));

  // changing the period resizes every row
  const onPeriod = (p) => {
    setF((x) => ({ ...x, period: p }));
    setAmounts((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Array.from({ length: PERIODS[p].count }, (_, i) => num(v[i]))])));
  };

  const next = () => {
    if (step === 0 && !f.name.trim()) return toast('Give the budget a name', 'error');
    if (step === 1 && !selected.length) return toast('Choose at least one income or expense account', 'error');
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const save = async () => {
    if (!f.name.trim()) return toast('Give the budget a name', 'error');
    setSaving(true);
    try {
      const body = { name: f.name.trim(), fiscal_year: Number(f.fiscal_year), period: f.period, lines: amounts };
      const b = id ? await api.put(`/budgets/${id}`, body) : await api.post('/budgets', body);
      toast(id ? 'Budget updated' : 'Budget created');
      nav(`/accountant/budgets/${b.id}`);
    } catch (e) { toast(errText(e), 'error'); }
    setSaving(false);
  };

  if (loading) return <Spinner />;

  const accountBox = (title, list) => (
    <Card title={title}>
      <div className="stack">
        {list.length === 0 && <div className="muted small">No accounts of this kind.</div>}
        {list.map((a) => (
          <Checkbox key={a.id} label={`${a.code ? `${a.code} · ` : ''}${a.name}`} checked={selected.includes(String(a.id))}
            onChange={(on) => toggle(String(a.id), on)} />
        ))}
      </div>
    </Card>
  );

  return (
    <div className="page">
      <PageHeader title={id ? 'Edit Budget' : 'New Budget'} subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        actions={<Link className="btn btn-secondary" to={id ? `/accountant/budgets/${id}` : '/accountant/budgets'}>Cancel</Link>} />

      <div className="row mb" style={{ gap: 8 }}>
        {STEPS.map((s, i) => (
          <span key={s} className={`badge ${i === step ? 'badge-blue' : i < step ? 'badge-green' : 'badge-gray'}`}>{i + 1}. {s}</span>
        ))}
      </div>

      {step === 0 && (
        <div className="form-section">
          <div className="grid3">
            <Field label="Budget name" required><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. FY26 Operating Budget" /></Field>
            <Field label="Fiscal year" hint={`Starts in month ${startMonth}. Enter the year it starts in.`}>
              <NumberInput value={f.fiscal_year} onChange={(v) => setF({ ...f, fiscal_year: v })} />
            </Field>
            <Field label="Budget period">
              <Select value={f.period} onChange={(e) => onPeriod(e.target.value)} options={[['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']]} />
            </Field>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="form-section">
          <p className="muted">Pick the income and expense accounts this budget covers.</p>
          <div className="grid2">
            {accountBox('Income accounts', incomeAccounts)}
            {accountBox('Expense accounts', expenseAccounts)}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="form-section">
          <div className="row mb" style={{ gap: 8 }}>
            <span className="muted small">Fill every account with the same amount:</span>
            <NumberInput style={{ width: 140 }} value={fillAll} onChange={setFillAll} placeholder="Amount" />
            <Button size="sm" onClick={fillEverything} disabled={fillAll === ''}>Fill all</Button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="lines-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 200, position: 'sticky', left: 0, background: 'var(--line2)' }}>Account</th>
                  {labels.map((l) => <th key={l} className="r" style={{ minWidth: 110 }}>{l}</th>)}
                  <th style={{ minWidth: 150 }}>Same amount</th>
                </tr>
              </thead>
              <tbody>
                {selected.map((accountId) => {
                  const a = (meta?.accounts || []).find((x) => String(x.id) === accountId);
                  return (
                    <AmountRow key={accountId} name={a?.name || `Account ${accountId}`} type={typeLabel(a?.type)} values={amounts[accountId]}
                      onCell={(i, v) => setCell(accountId, i, v)} onFill={(v) => fillRow(accountId, v)} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="form-foot">
        {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>Back</Button>}
        {step < STEPS.length - 1 && <Button variant="primary" onClick={next}>Next</Button>}
        {step === STEPS.length - 1 && <Button variant="primary" loading={saving} onClick={save}>{id ? 'Save Budget' : 'Create Budget'}</Button>}
      </div>
    </div>
  );
}

function AmountRow({ name, type, values, onCell, onFill }) {
  const [same, setSame] = useState('');
  return (
    <tr>
      <td style={{ position: 'sticky', left: 0, background: 'var(--panel)' }}>
        <div className="bold">{name}</div>
        <div className="small muted">{type}</div>
      </td>
      {values.map((v, i) => (
        <td key={i}><NumberInput value={v} onChange={(x) => onCell(i, x)} /></td>
      ))}
      <td>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <NumberInput style={{ width: 90 }} value={same} onChange={setSame} placeholder="Amount" />
          <Button size="sm" disabled={same === ''} onClick={() => onFill(same)}>Fill</Button>
        </div>
      </td>
    </tr>
  );
}
