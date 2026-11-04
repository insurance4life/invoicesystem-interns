import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { AccountSelect, Button, Field, Input, NumberInput } from '../../components/ui.jsx';
import { fmtMoney } from '../../lib/format.js';
import { SettingsPage, attempt, Note } from './common.jsx';

// Receivables and payables are entered per contact, and inventory per item, so they are not offered here.
const NOT_OPENING = ['accounts_receivable', 'accounts_payable', 'stock'];
const NOT_OPENING_CODES = ['ar', 'ap', 'inventory', 'opening_balance_offset'];
const allowedAccount = (a) => !NOT_OPENING.includes(a.type) && !NOT_OPENING_CODES.includes(a.system_code);

export default function OpeningBalances() {
  const { currency, refreshMeta, toast, can } = useApp();
  const ob = useFetch('/opening-balances');
  const canEdit = can('settings', 'edit');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(1);
  const newRow = (extra = {}) => ({ k: nextKey.current++, account_id: '', debit: '', credit: '', ...extra });

  useEffect(() => {
    if (!ob.data) return;
    setDate(ob.data.date || new Date().toISOString().slice(0, 10));
    setRows(ob.data.lines.length
      ? ob.data.lines.map((l) => newRow({ account_id: l.account_id, debit: l.debit || '', credit: l.credit || '' }))
      : [newRow()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ob.data]);

  const totals = useMemo(() => {
    const debit = rows.reduce((s, r) => s + (Number(r.debit) || 0), 0);
    const credit = rows.reduce((s, r) => s + (Number(r.credit) || 0), 0);
    return { debit, credit, diff: Math.round((debit - credit) * 100) / 100 };
  }, [rows]);

  const update = (k, patch) => setRows((rs) => rs.map((r) => (r.k === k ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    const lines = rows.filter((r) => r.account_id && (Number(r.debit) || Number(r.credit)))
      .map((r) => ({ account_id: Number(r.account_id), debit: Number(r.debit) || 0, credit: Number(r.credit) || 0 }));
    const out = await attempt(toast, () => api.put('/opening-balances', { date, lines }), 'Opening balances saved');
    if (out) { ob.reload(); refreshMeta().catch(() => {}); }
    setSaving(false);
  };

  return (
    <SettingsPage
      title="Opening balances"
      subtitle="Balances your books start with, as of the opening date."
      actions={canEdit && <Button variant="primary" loading={saving} onClick={save}>Save</Button>}
    >
      <div className="form-section">
        <div className="form-grid">
          <Field label="Opening balance date" required hint="Transactions on or before this date are part of the opening position.">
            <Input type="date" value={date} disabled={!canEdit} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="table-wrap">
        <table className="lines-table">
          <thead>
            <tr>
              <th style={{ width: '50%' }}>Account</th>
              <th className="r" style={{ width: '20%' }}>Debit ({currency})</th>
              <th className="r" style={{ width: '20%' }}>Credit ({currency})</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td>
                  <AccountSelect value={r.account_id} filter={allowedAccount} placeholder="Select an account"
                    onChange={(v) => update(r.k, { account_id: v })} />
                </td>
                <td><NumberInput className="r" value={r.debit} disabled={!canEdit} onChange={(v) => update(r.k, { debit: v })} /></td>
                <td><NumberInput className="r" value={r.credit} disabled={!canEdit} onChange={(v) => update(r.k, { credit: v })} /></td>
                <td>
                  {canEdit && <button type="button" className="icon-btn rm" aria-label="Remove line" onClick={() => setRows((rs) => rs.filter((x) => x.k !== r.k))}>×</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row between" style={{ marginTop: 12, flexWrap: 'wrap', gap: 12 }}>
        {canEdit && <Button size="sm" onClick={() => setRows((rs) => [...rs, newRow()])}>+ Add line</Button>}
        <div className="totals" style={{ width: 380 }}>
          <div className="t-row"><span>Total debit</span><span className="num">{fmtMoney(totals.debit, currency)}</span></div>
          <div className="t-row"><span>Total credit</span><span className="num">{fmtMoney(totals.credit, currency)}</span></div>
          <div className="t-row t-total">
            <span>Difference</span>
            <span className="num">{fmtMoney(totals.diff, currency)}</span>
          </div>
        </div>
      </div>
      <Note>
        {Math.abs(totals.diff) > 0.001
          ? `The difference of ${fmtMoney(Math.abs(totals.diff), currency)} will be posted to the Opening Balance Offset account.`
          : 'Debits and credits balance, so nothing is posted to the Opening Balance Offset account.'}
        {' '}Saving again replaces the previous opening balances.
      </Note>
    </SettingsPage>
  );
}
