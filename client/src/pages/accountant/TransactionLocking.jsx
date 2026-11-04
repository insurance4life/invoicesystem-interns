import { useState } from 'react';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Card, Field, Input, Textarea, Modal, Badge, KeyValue } from '../../components/ui.jsx';
import { errText } from './common.js';

const AREAS = [
  { key: 'sales', label: 'Sales', note: 'Invoices, quotes, credit notes, receipts and customer payments.' },
  { key: 'purchases', label: 'Purchases', note: 'Bills, vendor credits, expenses and vendor payments.' },
  { key: 'banking', label: 'Banking', note: 'Bank transactions, imports and reconciliation.' },
  { key: 'accountant', label: 'Accountant', note: 'Manual journals, fixed asset depreciation and currency adjustments.' },
];

export default function TransactionLocking() {
  const { org, settings, can, toast, refreshMeta } = useApp();
  const [modal, setModal] = useState(null); // { area: 'org' | key, label }
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const locks = settings?.locks || {};
  const reasons = locks.reasons || {};
  const orgLock = org?.lock_date || null;
  const allowed = can('accountant', 'edit');

  const rows = [
    { key: 'org', label: 'All transactions', note: 'Applies to every module, including the accountant area.', date: orgLock },
    ...AREAS.map((a) => ({ ...a, date: locks[a.key] || null })),
  ];

  const openLock = (r) => { setModal(r); setDate(r.date || ''); setReason(reasons[r.key] || ''); };

  const save = async () => {
    if (!date) return toast('Choose the date to lock through', 'error');
    setBusy(true);
    try {
      const nextReasons = { ...reasons, [modal.key]: reason.trim() || undefined };
      if (modal.key === 'org') {
        await api.put('/org', { lock_date: date });
        await api.put('/org/settings', { locks: { reasons: nextReasons } });
      } else {
        await api.put('/org/settings', { locks: { [modal.key]: date, reasons: nextReasons } });
      }
      toast(`${modal.label} locked through ${date}`);
      setModal(null);
      await refreshMeta();
    } catch (e) { toast(errText(e), 'error'); }
    setBusy(false);
  };

  const unlock = async (r) => {
    if (!window.confirm(`Unlock ${r.label}? Transactions dated up to ${r.date} become editable again.`)) return;
    try {
      if (r.key === 'org') await api.put('/org', { lock_date: null });
      else await api.put('/org/settings', { locks: { [r.key]: null } });
      toast(`${r.label} unlocked`);
      await refreshMeta();
    } catch (e) { toast(errText(e), 'error'); }
  };

  return (
    <div className="page">
      <PageHeader title="Transaction Locking" subtitle="Lock past periods so their transactions cannot be changed or deleted." />

      <Card title="Lock dates" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Area</th><th>Locked through</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div className="bold">{r.label}</div>
                    <div className="small muted">{r.note}</div>
                  </td>
                  <td>{r.date ? <Badge color="orange">{r.date}</Badge> : <span className="muted">Not locked</span>}</td>
                  <td className="muted">{r.date ? (reasons[r.key] || '—') : ''}</td>
                  <td className="r">
                    {allowed && <div className="row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => openLock(r)}>{r.date ? 'Change lock' : 'Lock'}</Button>
                      {r.date && <Button size="sm" variant="link" onClick={() => unlock(r)}>Unlock</Button>}
                    </div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="How locks work" className="mt">
        <KeyValue items={[
          ['Effective lock', [orgLock, ...AREAS.map((a) => locks[a.key])].filter(Boolean).sort().pop() || 'None'],
          ['Note', 'Transactions dated on or before the latest applicable lock date cannot be created, edited or deleted. Locks can be moved later to unlock or re-lock periods.'],
        ]} />
      </Card>

      {modal && (
        <Modal title={`Lock ${modal.label}`} onClose={() => setModal(null)} footer={<>
          <Button onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>Save lock</Button>
        </>}>
          <div className="stack">
            <Field label="Lock transactions up to and including" required>
              <Input type="date" autoFocus value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Reason" hint="Shown to everyone with access, e.g. 'FY25 closed and audited'.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
