import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Menu, Spinner, Card, Table, PageHeader, Tabs } from '../../components/ui.jsx';
import ActivityPanel from '../../components/ActivityPanel.jsx';
import Attachments from '../../components/Attachments.jsx';
import { docUrl } from '../../lib/docs.js';
import { ApplyToDocsModal, RefundModal } from './DocModals.jsx';
import { Pencil, Printer, X } from 'lucide-react';

export default function PaymentView({ kind }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { money, date, toast, meta, can } = useApp();
  const { data: p, reload } = useFetch(`/payments/${kind}/${id}`);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('receipt');
  if (!p) return <Spinner />;
  const module = kind === 'received' ? 'sales' : 'purchases';
  const remove = async () => {
    if (!window.confirm(`Delete payment ${p.number}? Linked invoices/bills become unpaid again.`)) return;
    try { await api.del(`/payments/${kind}/${p.id}`); toast('Payment deleted'); nav(`/payments-${kind}`); } catch (e) { toast(e.message, 'error'); }
  };
  const done = () => { setModal(null); reload(); };
  return (
    <div className="page">
      <PageHeader title={p.number} subtitle={`${kind === 'received' ? 'Payment received from' : 'Payment made to'} ${p.contact_name}`} actions={<>
        {can(module, 'edit') && <Button onClick={() => nav(`/payments-${kind}/${p.id}/edit`)}><><Pencil size={16} strokeWidth={1.5} />Edit</></Button>}
        {p.unused > 0 && <Button variant="primary" onClick={() => setModal('apply')}>Apply Excess to {kind === 'received' ? 'Invoices' : 'Bills'}</Button>}
        <Button onClick={() => window.print()}><><Printer size={16} strokeWidth={1.5} />Print</></Button>
        <Menu label="More" items={[
          { label: 'Refund excess amount', onClick: () => setModal('refund'), hidden: !(p.unused > 0) },
          { label: 'Delete', danger: true, onClick: remove, hidden: !can(module, 'delete') },
        ]} />
        <Button variant="link" onClick={() => nav(`/payments-${kind}`)}><X size={18} strokeWidth={1.5} /></Button>
      </>} />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'receipt', label: kind === 'received' ? 'Payment Receipt' : 'Payment Advice' }, { key: 'activity', label: 'Comments & History' }, { key: 'files', label: 'Attachments' }]} />
      {tab === 'receipt' && (
        <div className="doc-paper">
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div><div style={{ fontWeight: 700, fontSize: 17 }}>{meta.org.name}</div>{meta.org.gstin && <div>GSTIN {meta.org.gstin}</div>}</div>
            <div style={{ fontSize: 22, letterSpacing: 1 }}>{kind === 'received' ? 'PAYMENT RECEIPT' : 'PAYMENT ADVICE'}</div>
          </div>
          <div className="row between mt" style={{ alignItems: 'flex-start' }}>
            <table style={{ width: 'auto' }}>
              <tbody>
                {[['Payment Date', date(p.date)], ['Payment#', p.number], ['Reference Number', p.reference], ['Payment Mode', p.mode], [kind === 'received' ? 'Deposited To' : 'Paid Through', p.account_name],
                  p.bank_charges ? ['Bank Charges', money(p.bank_charges, p.currency)] : null, p.tds_amount ? ['TDS', money(p.tds_amount, p.currency)] : null].filter(Boolean).map(([k, v]) => (
                  <tr key={k}><td style={{ color: '#666', border: 0, padding: '4px 16px 4px 0' }}>{k}</td><td style={{ border: 0, padding: 4, fontWeight: 500 }}>{v || '—'}</td></tr>
                ))}
              </tbody>
            </table>
            <div style={{ background: '#22a06b', color: '#fff', padding: '18px 26px', textAlign: 'center', borderRadius: 4 }}>
              <div>Amount {kind === 'received' ? 'Received' : 'Paid'}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(p.amount, p.currency)}</div>
            </div>
          </div>
          <div className="mt"><div className="muted small">{kind === 'received' ? 'Received From' : 'Paid To'}</div><div className="bold">{p.contact_name}</div></div>
          {p.notes && <div className="mt" style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</div>}
          <h3 className="mt">Payment for</h3>
          <table className="mt">
            <thead><tr><th>Document</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Payment Amount</th></tr></thead>
            <tbody>
              {p.allocations.map((a) => <tr key={a.id}><td><Link to={docUrl(a.doc_type, a.document_id)}>{a.number}</Link></td><td>{date(a.document_date)}</td><td style={{ textAlign: 'right' }}>{money(a.total, p.currency)}</td><td style={{ textAlign: 'right' }}>{money(a.amount, p.currency)}</td></tr>)}
              {p.credits_applied.map((a) => <tr key={`c${a.id}`}><td><Link to={docUrl(a.doc_type, a.document_id)}>{a.number}</Link> <span className="muted small">(excess applied {date(a.date)})</span></td><td /><td /><td style={{ textAlign: 'right' }}>{money(a.amount, p.currency)}</td></tr>)}
              {!p.allocations.length && !p.credits_applied.length && <tr><td colSpan={4} className="muted">Not applied to any document (advance payment).</td></tr>}
            </tbody>
          </table>
          {p.refunds.length > 0 && <div className="mt">Refunded: {p.refunds.map((r) => `${money(r.amount, p.currency)} on ${date(r.date)}`).join(', ')}</div>}
          {p.unused > 0 && <div className="callout mt"><span>Unused amount: <b>{money(p.unused, p.currency)}</b> – available as credit for {p.contact_name}.</span></div>}
        </div>
      )}
      {tab === 'activity' && <Card><ActivityPanel entityType={`payment_${kind}`} entityId={p.id} /></Card>}
      {tab === 'files' && <Card><Attachments entityType={`payment_${kind}`} entityId={p.id} /></Card>}
      {modal === 'apply' && <ApplyToDocsModal source={{ ...p, doc_type: 'payment', balance: p.unused, id: p.id, number: p.number, contact_id: p.contact_id, _target: kind }} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'refund' && <RefundModal sourceType="payment" source={p} available={p.unused} contactKind={kind === 'received' ? 'customer' : 'vendor'} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}
