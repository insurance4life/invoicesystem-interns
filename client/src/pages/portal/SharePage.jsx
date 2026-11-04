import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button, Field, NumberInput, Select, Textarea, Modal, Input } from '../../components/ui.jsx';
import { DOC_UI } from '../../lib/docs.js';
import { fmtDate, fmtMoney, statusLabel } from '../../lib/format.js';
import { Shell, Notice, Loading, TestModeBanner } from './PublicShell.jsx';
import { usePublic, publicRequest, formatAddress } from './publicApi.js';

const money = (v, cur) => fmtMoney(v, cur);

/** Customer-facing document page (a printable invoice, quote, credit note...). */
export default function SharePage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const share = usePublic(`/share/${token}`);
  const [payOpen, setPayOpen] = useState(params.get('pay') === '1');
  const [decision, setDecision] = useState(null); // 'accept' | 'decline'
  const [notice, setNotice] = useState('');

  if (share.loading && !share.data) return <Loading />;
  if (share.error) {
    return <Notice title="This link is not available" text="The document may have been withdrawn, or the link is mistyped. Ask the sender for a new link." />;
  }

  const { org, doc, contact, payments, payments_enabled: payable } = share.data;
  const cur = doc.currency || org.currency;
  const ui = DOC_UI[doc.doc_type] || { label: 'Document', dueLabel: 'Due Date' };
  const isQuote = doc.doc_type === 'quote';
  const canDecide = isQuote && doc.status === 'sent' && doc.display_status !== 'expired';
  const lineSubtotal = (doc.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const paid = (payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const showBalance = ['invoice', 'bill', 'retainer'].includes(doc.doc_type);
  const accent = org.settings?.pdf?.color || '#408dfb';
  const address = formatAddress(org.address);
  const billTo = formatAddress(contact?.billing_address);

  const afterAction = (msg) => { setNotice(msg); share.reload(); };

  return (
    <Shell>
      <div className="row between no-print" style={{ marginBottom: 12 }}>
        <div className="muted small">Shared by {org.name}</div>
        <div className="row">
          <Button size="sm" onClick={() => window.print()}>Print / Save as PDF</Button>
          {canDecide && <Button size="sm" onClick={() => setDecision('decline')}>Decline</Button>}
          {canDecide && <Button size="sm" variant="primary" onClick={() => setDecision('accept')}>Accept quote</Button>}
          {payable && <Button size="sm" variant="primary" onClick={() => setPayOpen(true)}>Pay now · {money(doc.balance, cur)}</Button>}
        </div>
      </div>

      {notice && <div className="callout no-print">{notice}</div>}

      <div className="doc-paper" style={{ '--accent': accent, maxWidth: '100%' }}>
        <div className={`doc-ribbon ${doc.display_status}`}>{statusLabel(doc.display_status)}</div>

        <div className="row between" style={{ alignItems: 'flex-start', gap: 24, marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            {org.logo && <img src={org.logo} alt="" style={{ maxHeight: 56, maxWidth: 160 }} />}
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{org.name}</div>
              {address && <div className="small" style={{ color: '#555' }}>{address}</div>}
              {org.gstin && <div className="small" style={{ color: '#555' }}>GSTIN {org.gstin}</div>}
              <div className="small" style={{ color: '#555' }}>{[org.email, org.phone].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, textTransform: 'uppercase' }}>{ui.label}</div>
            <div className="small"># {doc.number}</div>
          </div>
        </div>

        <div className="row between" style={{ alignItems: 'flex-start', gap: 24, marginTop: 26 }}>
          <div>
            <div className="small" style={{ color: '#888', textTransform: 'uppercase' }}>Bill to</div>
            <div style={{ fontWeight: 600 }}>{contact?.company_name || contact?.display_name}</div>
            {contact?.company_name && contact?.display_name && <div className="small">Attn: {contact.display_name}</div>}
            {billTo && <div className="small">{billTo}</div>}
            {contact?.gstin && <div className="small">GSTIN {contact.gstin}</div>}
          </div>
          <table style={{ width: 'auto', fontSize: 12.5 }}>
            <tbody>
              <tr><td style={{ paddingRight: 16, color: '#888' }}>Date</td><td>{fmtDate(doc.date)}</td></tr>
              {ui.dueLabel && doc.due_date && <tr><td style={{ paddingRight: 16, color: '#888' }}>{ui.dueLabel}</td><td>{fmtDate(doc.due_date)}</td></tr>}
              {doc.reference && <tr><td style={{ paddingRight: 16, color: '#888' }}>Reference</td><td>{doc.reference}</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ overflowX: 'auto', marginTop: 24 }}>
          <table style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>Item & description</th>
                <th>HSN/SAC</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th>Tax</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {(doc.lines || []).map((l, i) => (
                <tr key={l.id || i}>
                  <td>{i + 1}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{l.name || l.item_name || '—'}</div>
                    {l.description && <div className="small" style={{ color: '#666', whiteSpace: 'pre-wrap' }}>{l.description}</div>}
                  </td>
                  <td className="small">{l.hsn_sac || ''}</td>
                  <td style={{ textAlign: 'right' }}>{l.quantity}{l.unit ? ` ${l.unit}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>{money(l.rate, cur)}</td>
                  <td className="small">{(l.tax_breakdown || []).map((t) => t.name).join(', ') || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{money(l.amount, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', marginTop: 20 }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            {doc.notes && (<><div className="small" style={{ color: '#888', textTransform: 'uppercase' }}>Notes</div><div className="small" style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{doc.notes}</div></>)}
            {doc.terms && (<><div className="small" style={{ color: '#888', textTransform: 'uppercase' }}>Terms</div><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{doc.terms}</div></>)}
          </div>
          <div style={{ width: 320, maxWidth: '100%', fontSize: 13 }}>
            <TotalRow label="Subtotal" value={money(lineSubtotal, cur)} />
            {doc.discount_total > 0 && <TotalRow label="Discount" value={`- ${money(doc.discount_total, cur)}`} />}
            {(doc.taxes || []).map((t) => <TotalRow key={t.name} label={t.name} value={money(t.amount, cur)} small />)}
            {doc.shipping > 0 && <TotalRow label="Shipping" value={money(doc.shipping, cur)} />}
            {doc.adjustment !== 0 && doc.adjustment != null && <TotalRow label={doc.adjustment_label || 'Adjustment'} value={money(doc.adjustment, cur)} />}
            <TotalRow label="Total" value={money(doc.total, cur)} strong accent={accent} />
            {showBalance && paid > 0 && <TotalRow label="Paid" value={`- ${money(paid, cur)}`} />}
            {showBalance && <TotalRow label="Balance due" value={money(doc.balance, cur)} strong accent={accent} />}
          </div>
        </div>

        {payments?.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div className="small" style={{ color: '#888', textTransform: 'uppercase' }}>Payments received</div>
            <table style={{ marginTop: 6 }}>
              <tbody>
                {payments.map((p, i) => (
                  <tr key={i}><td className="small">{fmtDate(p.date)}</td><td className="small">{p.number} · {p.mode}</td><td className="small" style={{ textAlign: 'right' }}>{money(p.amount, cur)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {payOpen && payable && (
        <PayModal
          token={token}
          balance={doc.balance}
          currency={cur}
          onClose={() => { setPayOpen(false); share.reload(); }}
        />
      )}
      {decision && (
        <DecisionModal
          token={token}
          action={decision}
          onClose={() => setDecision(null)}
          onDone={(msg) => { setDecision(null); afterAction(msg); }}
        />
      )}
    </Shell>
  );
}

function TotalRow({ label, value, strong, accent, small }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0',
      fontWeight: strong ? 700 : 400, fontSize: strong ? 15 : small ? 12 : 13,
      borderTop: strong ? `2px solid ${accent || '#333'}` : 'none', marginTop: strong ? 6 : 0,
    }}>
      <span style={{ color: small ? '#777' : undefined }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Test-mode payment. Only a payment method is chosen; no card data is ever entered here. */
function PayModal({ token, balance, currency, onClose, onPaid }) {
  const [payer, setPayer] = useState('');
  const [method, setMethod] = useState('upi');
  const [amount, setAmount] = useState(String(balance));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  const pay = async () => {
    setErr('');
    if (!payer.trim()) return setErr('Enter your name so the payment can be matched.');
    if (!(Number(amount) > 0)) return setErr('Enter an amount greater than zero.');
    setBusy(true);
    try {
      const r = await publicRequest('POST', `/share/${token}/pay`, { amount: Number(amount), payer_name: payer.trim(), method });
      setResult(r);
      onPaid?.(r);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  if (result) {
    return (
      <Modal title="Payment received" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <TestModeBanner />
        <div className="stack">
          <div>Thank you. Your payment of <b>{money(result.payment.amount, currency)}</b> was recorded.</div>
          <KV label="Reference" value={result.reference} />
          <KV label="Receipt no." value={result.payment.number} />
          <KV label="Balance remaining" value={money(result.balance, currency)} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Pay invoice"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={pay}>Pay {money(amount || 0, currency)}</Button></>}
    >
      <div className="stack">
        <TestModeBanner />
        {err && <div className="callout warn" style={{ marginBottom: 0 }}>{err}</div>}
        <Field label="Your name" required><Input value={payer} onChange={(e) => setPayer(e.target.value)} autoFocus /></Field>
        <Field label="Amount" hint={`Up to ${money(balance, currency)}`}>
          <NumberInput min="0" max={balance} step="0.01" value={amount} onChange={setAmount} />
        </Field>
        <Field label="Pay with">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}
            options={[['upi', 'UPI'], ['netbanking', 'Net banking'], ['card', 'Card (redirected to the card provider)']]} />
        </Field>
        {method === 'card' && <p className="muted small" style={{ margin: 0 }}>In a live setup your card details would be entered on the provider's secure page. This test gateway never accepts card numbers.</p>}
      </div>
    </Modal>
  );
}

function KV({ label, value }) {
  return <div className="row between"><span className="muted">{label}</span><b>{value}</b></div>;
}

function DecisionModal({ token, action, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const accept = action === 'accept';
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await publicRequest('POST', `/share/${token}/${action}`, { reason: reason.trim() || undefined });
      onDone(accept ? 'Thank you. The quote has been accepted.' : 'The quote has been declined. The sender has been told.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal
      title={accept ? 'Accept this quote' : 'Decline this quote'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={accept ? 'primary' : 'danger'} loading={busy} onClick={submit}>{accept ? 'Accept' : 'Decline'}</Button></>}
    >
      <div className="stack">
        {err && <div className="callout warn" style={{ marginBottom: 0 }}>{err}</div>}
        <Field label={accept ? 'Note (optional)' : 'Reason (optional)'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
