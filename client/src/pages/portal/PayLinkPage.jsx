import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Field, Input, Select } from '../../components/ui.jsx';
import { fmtDate, fmtMoney } from '../../lib/format.js';
import { Shell, Notice, Loading, TestModeBanner } from './PublicShell.jsx';
import { usePublic, publicRequest } from './publicApi.js';

/** Pay a payment link: a fixed amount, recorded as an advance against the customer's account. */
export default function PayLinkPage() {
  const { token } = useParams();
  const link = usePublic(`/pay/${token}`);
  const [payer, setPayer] = useState('');
  const [method, setMethod] = useState('upi');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  if (link.loading && !link.data) return <Loading />;
  if (link.error) return <Notice title="Payment link not found" text="Check the link, or ask the sender for a new one." />;

  const { org, contact_name: contact, amount, description, expires_on: expires, status, currency } = link.data;
  const cur = currency || org.currency;

  const pay = async () => {
    setErr('');
    if (!payer.trim()) return setErr('Enter your name so the payment can be matched.');
    setBusy(true);
    try {
      const r = await publicRequest('POST', `/pay/${token}/pay`, { payer_name: payer.trim(), method });
      setDone(r);
      link.reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (done) {
    return (
      <Shell>
        <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
          <div className="card-body stack">
            <TestModeBanner />
            <div style={{ fontSize: 18, fontWeight: 600 }}>Payment received</div>
            <div>{fmtMoney(done.payment.amount, cur)} was paid to {org.name}.</div>
            <div className="row between"><span className="muted">Reference</span><b>{done.reference}</b></div>
            <div className="row between"><span className="muted">Receipt no.</span><b>{done.payment.number}</b></div>
          </div>
        </div>
      </Shell>
    );
  }

  if (status !== 'active') {
    const text = status === 'paid' ? 'This payment link has already been paid.' : status === 'expired' ? 'This payment link has expired. Ask the sender for a new one.' : 'This payment link is no longer active.';
    return <Notice title={`Payment link ${status === 'paid' ? 'paid' : 'unavailable'}`} text={text} />;
  }

  return (
    <Shell>
      <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
        <div className="card-body stack">
          <TestModeBanner />
          <div>
            <div className="muted small">Payment to</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{org.name}</div>
            {contact && <div className="small muted">For {contact}</div>}
          </div>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <span>{description || 'Payment'}</span>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(amount, cur)}</span>
          </div>
          {expires && <div className="small muted">Valid until {fmtDate(expires)}</div>}
          {err && <div className="callout warn" style={{ marginBottom: 0 }}>{err}</div>}
          <Field label="Your name" required><Input value={payer} onChange={(e) => setPayer(e.target.value)} autoFocus /></Field>
          <Field label="Pay with">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}
              options={[['upi', 'UPI'], ['netbanking', 'Net banking'], ['card', 'Card (redirected to the card provider)']]} />
          </Field>
          <Button variant="primary" loading={busy} onClick={pay}>Pay {fmtMoney(amount, cur)}</Button>
        </div>
      </div>
    </Shell>
  );
}
