import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api, downloadCsv } from '../../api.js';
import { Button, Select, Input, Modal, Field, Textarea, Table, Card } from '../../components/ui.jsx';
import { dateRange, RANGE_OPTIONS } from '../../lib/format.js';
import { DOC_UI, docUrl } from '../../lib/docs.js';

const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  .stmt-print, .stmt-print * { visibility: visible !important; }
  .stmt-print { position: absolute; left: 0; top: 0; width: 100%; padding: 0; margin: 0; }
  .stmt-print .card { border: none; }
}`;

/** Where a statement row should link to. */
function rowLink(r) {
  if (!r.ref_id) return null;
  if (DOC_UI[r.src_type]) return docUrl(r.src_type, r.ref_id);
  if (r.src_type === 'payment_received') return `/payments-received/${r.ref_id}`;
  if (r.src_type === 'payment_made') return `/payments-made/${r.ref_id}`;
  if (r.src_type === 'expense') return `/expenses/${r.ref_id}`;
  if (r.src_type === 'inventory_adjustment') return `/inventory/adjustments/${r.ref_id}/edit`;
  return null;
}

export default function ContactStatement({ contact }) {
  const { org, money, date, toast } = useApp();
  const fy = org?.fiscal_year_start || 4;
  const [range, setRange] = useState('this_year');
  const initial = dateRange('this_year', fy);
  const [from, setFrom] = useState(initial[0]);
  const [to, setTo] = useState(initial[1]);
  const [emailing, setEmailing] = useState(false);
  const [mail, setMail] = useState({ to: '', subject: '', body: '' });
  const [sending, setSending] = useState(false);
  const { data: st, loading, error } = useFetch(`/contacts/${contact.id}/statement`, { from, to }, [contact.id]);

  const pick = (k) => {
    setRange(k);
    if (k !== 'custom') { const [a, b] = dateRange(k, fy); setFrom(a); setTo(b); }
  };

  const sendEmail = async () => {
    setSending(true);
    try {
      await api.post(`/contacts/${contact.id}/statement/email`, { to: mail.to, subject: mail.subject, body: mail.body, period_from: from, period_to: to });
      toast(`Statement sent to ${mail.to}`);
      setEmailing(false);
    } catch (e) { toast(e.message, 'error'); }
    finally { setSending(false); }
  };

  const openEmail = () => { setMail({ to: contact.email || '', subject: '', body: '' }); setEmailing(true); };

  const exportCsv = () => {
    const rows = st ? [
      { date: from, type: 'Opening Balance', number: '', details: '', amount: '', payments: '', balance: st.opening_balance },
      ...st.rows.map((r) => ({ ...r, date: r.date })),
    ] : [];
    downloadCsv(`statement-${contact.display_name}-${from}-${to}`, rows, [
      { key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction' }, { key: 'number', label: 'Number' },
      { key: 'details', label: 'Details' }, { key: 'amount', label: 'Amount' }, { key: 'payments', label: 'Payments' }, { key: 'balance', label: 'Balance' },
    ]);
  };

  const cols = [
    { key: 'date', label: 'Date', width: 110, render: (r) => (r.id === 'open' ? date(from) : date(r.date)) },
    { key: 'type', label: 'Transaction', render: (r) => {
      if (r.id === 'open') return <span className="bold">Opening Balance</span>;
      const link = rowLink(r);
      return <>
        <div>{link ? <Link to={link}>{r.type}</Link> : r.type}</div>
        {r.number && <div className="muted small">{r.number}</div>}
      </>;
    } },
    { key: 'details', label: 'Details', render: (r) => <span className="small">{r.details}</span> },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => (r.amount == null || r.id === 'open' ? '' : money(r.amount, st?.currency)) },
    { key: 'payments', label: 'Payments', align: 'right', render: (r) => (r.payments == null || r.id === 'open' ? '' : money(r.payments, st?.currency)) },
    { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance, st?.currency) },
  ];

  const rows = st ? [{ id: 'open', balance: st.opening_balance }, ...st.rows.map((r, i) => ({ ...r, id: `${r.src_type}-${r.ref_id}-${i}` }))] : [];
  const label = contact.type === 'vendor' ? 'payable' : 'receivable';

  return (
    <div className="stack">
      <style>{PRINT_CSS}</style>
      <div className="row between">
        <div className="row">
          <Select value={range} onChange={(e) => pick(e.target.value)} options={RANGE_OPTIONS} style={{ width: 200 }} />
          <Field label="From" inline><Input type="date" value={from} onChange={(e) => { setRange('custom'); setFrom(e.target.value); }} /></Field>
          <Field label="To" inline><Input type="date" value={to} onChange={(e) => { setRange('custom'); setTo(e.target.value); }} /></Field>
        </div>
        <div className="row">
          <Button onClick={exportCsv} disabled={!st}>Export CSV</Button>
          <Button onClick={() => window.print()} disabled={!st}>Print</Button>
          <Button variant="primary" onClick={openEmail} disabled={!st}>Email</Button>
        </div>
      </div>

      <Card pad={false} className="stmt-print">
        <div className="pad">
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="bold" style={{ fontSize: 16 }}>{org?.name}</div>
              {org?.gstin && <div className="small muted">GSTIN {org.gstin}</div>}
            </div>
            <div className="r">
              <div className="bold" style={{ fontSize: 16 }}>Statement of Account</div>
              <div className="small muted">{date(from)} to {date(to)}</div>
            </div>
          </div>
          <div className="mt"><div className="muted small">To</div><div className="bold">{contact.display_name}</div>
            {contact.email && <div className="small">{contact.email}</div>}</div>
        </div>
        {error && <div className="pad field-error">{error.message}</div>}
        <Table
          columns={cols}
          rows={rows}
          loading={loading && !st}
          empty="No transactions in this period."
          footer={st ? (
            <tr className="total-row">
              <td colSpan={3} className="bold">Total for this period</td>
              <td className="r bold">{money(st.total_amount, st.currency)}</td>
              <td className="r bold">{money(st.total_payments, st.currency)}</td>
              <td className="r bold">{money(st.closing_balance, st.currency)}</td>
            </tr>
          ) : null}
        />
        {st && (
          <div className="pad small muted r">
            Closing balance: <span className="bold">{money(st.closing_balance, st.currency)}</span> ({label})
          </div>
        )}
      </Card>

      {emailing && (
        <Modal title="Email statement" onClose={() => setEmailing(false)} width={560}
          footer={<>
            <Button onClick={() => setEmailing(false)}>Cancel</Button>
            <Button variant="primary" loading={sending} disabled={!mail.to} onClick={sendEmail}>Send</Button>
          </>}>
          <div className="stack">
            <Field label="To" required><Input type="email" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} /></Field>
            <Field label="Subject" hint="Leave blank to use the statement template"><Input value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} /></Field>
            <Field label="Message" hint="Leave blank to use the statement template"><Textarea rows={5} value={mail.body} onChange={(e) => setMail({ ...mail, body: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
