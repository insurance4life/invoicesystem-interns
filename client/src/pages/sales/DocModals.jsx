// Modals used from document detail pages: email, record payment, apply credits, refund, convert.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Modal, Button, Field, Input, Textarea, NumberInput, Select, AccountSelect, Combo, Table, Checkbox } from '../../components/ui.jsx';
import { today, PAYMENT_MODES } from '../../lib/format.js';
import { round2 } from '@shared/calc.js';
import { taxableShare, tdsOptions } from '../../lib/tds.js';

export function EmailModal({ type, doc, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/documents/${type}/${doc.id}/email`).then(setF).catch((e) => toast(e.message, 'error')); }, []); // eslint-disable-line
  const send = async () => {
    setBusy(true);
    try { const d = await api.post(`/documents/${type}/${doc.id}/email`, f); toast(`Email sent to ${f.to}`); onDone(d); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Email ${doc.number}`} width={680} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f} onClick={send}>Send</Button></>}>
      {!f ? 'Loading…' : (
        <div className="stack">
          <Field label="To" required><Input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="customer@example.com" /></Field>
          <Field label="Cc"><Input value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></Field>
          <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Message"><Textarea rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <div className="muted small">A secure link to view {doc.number} online (and pay, for invoices) is included. Emails are recorded in the outbox and sent through SMTP when configured.</div>
        </div>
      )}
    </Modal>
  );
}

export function PaymentModal({ kind, doc, onClose, onDone }) {
  const { toast, sysAccount, meta, money } = useApp();
  const share = taxableShare(doc);
  const rateOf = (sid) => Number((meta?.tds_sections || []).find((s) => s.id === Number(sid) && s.is_active)?.rate) || 0;
  // TDS on what this payment settles of the document, charged on the part before GST
  const split = (sid, cash) => {
    const r = rateOf(sid) / 100;
    if (!r) return { tds_amount: '' };
    if (cash === undefined) {
      const tds = round2(doc.balance * share * r);
      return { tds_amount: tds, amount: round2(doc.balance - tds) };
    }
    const settled = Math.min(doc.balance, (Number(cash) || 0) / (1 - r * share));
    return { tds_amount: round2(settled * share * r) };
  };
  const [f, setF] = useState(() => {
    const sid = rateOf(doc.contact_tds_section_id) ? doc.contact_tds_section_id : '';
    return {
      amount: doc.balance, date: today(), mode: 'Cash', account_id: sysAccount(kind === 'received' ? 'undeposited_funds' : 'petty_cash')?.id,
      reference: '', bank_charges: '', tds_amount: '', tds_section_id: sid, notes: '', exchange_rate: doc.exchange_rate || 1, send_receipt: false,
      ...(sid ? split(sid) : {}),
    };
  });
  const [busy, setBusy] = useState(false);
  const rate = rateOf(f.tds_section_id);
  const applied = round2(Math.min(Number(f.amount || 0) + Number(f.tds_amount || 0), doc.balance));
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/payments/${kind}`, { ...f, contact_id: doc.contact_id, currency: doc.currency, allocations: [{ document_id: doc.id, amount: applied }] });
      toast('Payment recorded');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Payment for ${doc.number}`} onClose={onClose} width={620} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Record Payment</Button></>}>
      <div className="grid2">
        <Field label={`Amount ${kind === 'received' ? 'Received' : 'Paid'} (${doc.currency})`} required><NumberInput value={f.amount} onChange={(v) => setF({ ...f, amount: v, ...(rate ? split(f.tds_section_id, v) : {}) })} /></Field>
        <Field label="Payment Date" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Payment Mode"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={PAYMENT_MODES.map((m) => [m, m])} /></Field>
        <Field label={kind === 'received' ? 'Deposit To' : 'Paid Through'} required><AccountSelect value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} filter={['cash', 'bank', 'credit_card', 'payment_clearing', 'other_current_asset', 'other_current_liability', 'equity']} /></Field>
        <Field label="Bank Charges (if any)"><NumberInput value={f.bank_charges} onChange={(v) => setF({ ...f, bank_charges: v })} /></Field>
        <Field label="TDS section">
          <Select value={f.tds_section_id ?? ''} placeholder="No TDS" options={tdsOptions(meta?.tds_sections, f.tds_section_id)}
            onChange={(e) => setF({ ...f, tds_section_id: e.target.value, ...split(e.target.value) })} />
        </Field>
        <Field label={kind === 'received' ? 'TDS deducted by customer' : 'TDS deducted'}
          hint={rate ? `${rate}% of ${money(round2(round2(Math.min(Number(f.amount || 0) + Number(f.tds_amount || 0), doc.balance)) * share), doc.currency)} before GST` : undefined}>
          <NumberInput value={f.tds_amount} onChange={(v) => setF({ ...f, tds_amount: v })} />
        </Field>
        <Field label="Reference#"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        {doc.currency !== doc.base_currency && doc.exchange_rate !== 1 && <Field label="Exchange Rate"><NumberInput value={f.exchange_rate} onChange={(v) => setF({ ...f, exchange_rate: v })} /></Field>}
      </div>
      <Field label="Notes" className="mt"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="mt muted small">Applied to {doc.number}: {applied}. {Number(f.amount) + Number(f.tds_amount || 0) > doc.balance ? `Excess ${round2(Number(f.amount) + Number(f.tds_amount || 0) - doc.balance)} will be kept as unused credit.` : ''}</div>
      {kind === 'received' && <div className="mt"><Checkbox label="Email a payment receipt to the customer" checked={f.send_receipt} onChange={(v) => setF({ ...f, send_receipt: v })} /></div>}
    </Modal>
  );
}

/** For an invoice/bill: pick from the contact's available credits. */
export function ApplyCreditsModal({ doc, onClose, onDone }) {
  const { toast, money, date } = useApp();
  const [credits, setCredits] = useState(null);
  const [amt, setAmt] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/contacts/${doc.contact_id}/credits`).then(setCredits); }, [doc.contact_id]);
  const total = round2(Object.values(amt).reduce((s, v) => s + (Number(v) || 0), 0));
  const save = async () => {
    setBusy(true);
    try {
      for (const c of credits) {
        const a = Number(amt[`${c.source_type}-${c.id}`]);
        if (a > 0) await api.post('/credits/apply', { source_type: c.source_type, source_id: c.id, applications: [{ document_id: doc.id, amount: a }] });
      }
      toast('Credits applied');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Apply credits to ${doc.number}`} width={720} onClose={onClose} footer={<><span className="grow muted">Amount to apply: {money(total)} of balance {money(doc.balance)}</span><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!total || total > doc.balance + 0.001} onClick={save}>Apply Credits</Button></>}>
      <Table loading={!credits} rows={credits || []} rowKey="number" empty="No credits available for this contact." columns={[
        { key: 'number', label: 'Credit', render: (c) => <><div className="bold">{c.number}</div><div className="small muted">{c.kind === 'payment' ? 'Excess payment' : c.kind === 'retainer' ? 'Retainer payment' : 'Credit note'}</div></> },
        { key: 'date', label: 'Date', render: (c) => date(c.date) },
        { key: 'total', label: 'Amount', align: 'right', render: (c) => money(c.total) },
        { key: 'balance', label: 'Available', align: 'right', render: (c) => money(c.balance) },
        { key: 'apply', label: 'Amount to Apply', align: 'right', render: (c) => <NumberInput style={{ width: 120 }} value={amt[`${c.source_type}-${c.id}`]} onChange={(v) => setAmt({ ...amt, [`${c.source_type}-${c.id}`]: v })} /> },
      ]} />
    </Modal>
  );
}

/** For a credit note / vendor credit / retainer: apply to the contact's open invoices/bills. */
export function ApplyToDocsModal({ source, onClose, onDone }) {
  const { toast, money, date } = useApp();
  const [docs, setDocs] = useState(null);
  const [amt, setAmt] = useState({});
  const [busy, setBusy] = useState(false);
  const target = source.doc_type === 'vendorcredit' || source._target === 'made' ? 'bill' : 'invoice';
  const available = source.doc_type === 'retainer' ? source.retainer_available : source.balance;
  useEffect(() => { api.get(`/contacts/${source.contact_id}/open-documents`).then((d) => setDocs(d.filter((x) => x.doc_type === target))); }, [source.contact_id, target]);
  const total = round2(Object.values(amt).reduce((s, v) => s + (Number(v) || 0), 0));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/credits/apply', { source_type: source.doc_type, source_id: source.id, applications: Object.entries(amt).map(([document_id, amount]) => ({ document_id: Number(document_id), amount: Number(amount) })) });
      toast('Credits applied');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Apply ${source.number} to ${target}s`} width={720} onClose={onClose} footer={<><span className="grow muted">Applying {money(total)} of {money(available)} available</span><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!total || total > available + 0.001} onClick={save}>Save</Button></>}>
      <Table loading={!docs} rows={docs || []} empty={`No open ${target}s for this contact.`} columns={[
        { key: 'number', label: `${target === 'bill' ? 'Bill' : 'Invoice'}#` },
        { key: 'date', label: 'Date', render: (d) => date(d.date) },
        { key: 'total', label: 'Amount', align: 'right', render: (d) => money(d.total, d.currency) },
        { key: 'balance', label: 'Balance', align: 'right', render: (d) => money(d.balance, d.currency) },
        { key: 'apply', label: 'Credits to Apply', align: 'right', render: (d) => <NumberInput style={{ width: 120 }} value={amt[d.id]} onChange={(v) => setAmt({ ...amt, [d.id]: v })} /> },
      ]} />
    </Modal>
  );
}

export function RefundModal({ sourceType, source, available, contactKind = 'customer', onClose, onDone }) {
  const { toast, sysAccount } = useApp();
  const [f, setF] = useState({ amount: available, date: today(), mode: 'Cash', account_id: sysAccount('petty_cash')?.id, reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/refunds', { ...f, source_type: sourceType, source_id: source.id }); toast('Refund recorded'); onDone(); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={`Refund – ${source.number}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid2">
        <Field label="Amount" required hint={`Available: ${available}`}><NumberInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label="Refunded On"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Payment Mode"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={PAYMENT_MODES.map((m) => [m, m])} /></Field>
        <Field label={contactKind === 'customer' ? 'From Account' : 'To Account'}><AccountSelect value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} filter={['cash', 'bank', 'credit_card', 'payment_clearing']} /></Field>
        <Field label="Reference#"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <Field label="Description" className="mt"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  );
}

export function ConvertVendorModal({ onClose, onPick }) {
  const [vendors, setVendors] = useState([]);
  const [v, setV] = useState('');
  useEffect(() => { api.get('/contacts', { type: 'vendor' }).then(setVendors); }, []);
  return (
    <Modal title="Convert to Purchase Order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v} onClick={() => onPick(v)}>Convert</Button></>}>
      <Field label="Vendor" required><Combo value={v} onChange={setV} options={vendors.map((x) => ({ value: x.id, label: x.display_name }))} placeholder="Select a vendor" /></Field>
    </Modal>
  );
}

export function ReasonModal({ title, label = 'Reason', onClose, onSubmit, required }) {
  const [r, setR] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={required && !r.trim()} onClick={() => onSubmit(r)}>Submit</Button></>}>
      <Field label={label}><Textarea value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

export function WriteOffModal({ doc, onClose, onDone }) {
  const { toast } = useApp();
  const [amount, setAmount] = useState(doc.balance);
  const save = async () => {
    try { await api.post(`/documents/invoice/${doc.id}/action/writeoff`, { amount }); toast('Invoice written off'); onDone(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Write off ${doc.number}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={save}>Write Off</Button></>}>
      <p className="muted">The amount is posted to the Bad Debt expense account and the invoice is closed.</p>
      <Field label="Amount"><NumberInput value={amount} onChange={setAmount} /></Field>
    </Modal>
  );
}
