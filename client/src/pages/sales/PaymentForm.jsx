import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Field, Input, Textarea, NumberInput, Select, Combo, AccountSelect, Table, Checkbox, Spinner } from '../../components/ui.jsx';
import { today, PAYMENT_MODES } from '../../lib/format.js';
import { round2 } from '@shared/calc.js';
import { applyNet, taxableShare, tdsOnApplied, tdsOptions } from '../../lib/tds.js';

export default function PaymentForm({ kind }) {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { money, date, toast, sysAccount, currency: baseCur, meta } = useApp();
  const contactType = kind === 'received' ? 'customer' : 'vendor';
  const [contacts, setContacts] = useState([]);
  const [docs, setDocs] = useState([]);
  const [alloc, setAlloc] = useState({});
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/contacts', { type: contactType }).then(setContacts);
    if (id) {
      api.get(`/payments/${kind}/${id}`).then((p) => {
        setF({ ...p });
        setAlloc(Object.fromEntries(p.allocations.map((a) => [a.document_id, a.amount])));
      });
    } else {
      setF({ contact_id: sp.get('contact_id') ? Number(sp.get('contact_id')) : '', date: today(), amount: '', mode: 'Cash', reference: '', notes: '', bank_charges: '', tds_amount: '', tds_section_id: '', currency: baseCur, exchange_rate: 1,
        account_id: sysAccount(kind === 'received' ? 'undeposited_funds' : 'petty_cash')?.id, send_receipt: false });
    }
  }, [id, kind]); // eslint-disable-line

  useEffect(() => {
    if (!f?.contact_id) { setDocs([]); return; }
    api.get(`/contacts/${f.contact_id}/open-documents`).then((list) => {
      let d = list.filter((x) => (kind === 'received' ? ['invoice', 'retainer'] : ['bill']).includes(x.doc_type));
      if (id) {
        // when editing, the docs already paid by this payment still need to show (their balance + this allocation)
        const extra = (f.allocations || []).filter((a) => !d.some((x) => x.id === a.document_id)).map((a) => ({ id: a.document_id, number: a.number, doc_type: a.doc_type, date: a.document_date, total: a.total, balance: 0 }));
        d = [...d, ...extra].map((x) => ({ ...x, balance: round2(x.balance + ((f.allocations || []).find((a) => a.document_id === x.id)?.amount || 0)) }));
      }
      setDocs(d);
      const c = contacts.find((x) => x.id === Number(f.contact_id));
      if (!id) setF((x) => ({ ...x, tds_section_id: c?.tds_section_id || '', tds_amount: '' }));
      if (!id && c?.currency && c.currency !== f.currency) setF((x) => ({ ...x, currency: c.currency, exchange_rate: meta.currencies.find((m) => m.code === c.currency)?.exchange_rate || 1 }));
    });
  }, [f?.contact_id, contacts.length]); // eslint-disable-line

  if (!f) return <Spinner />;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const totalAlloc = round2(Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  const gross = round2(Number(f.amount || 0) + Number(f.tds_amount || 0));
  const section = (meta?.tds_sections || []).find((s) => s.id === Number(f.tds_section_id));
  const rate = Number(section?.rate) || 0;
  const taxableApplied = round2(docs.reduce((s, d) => s + (Number(alloc[d.id]) || 0) * taxableShare(d), 0));
  // with a section, the cash paid is spread over the documents and TDS settles the rest of each one
  const autoApply = (amount, r = rate) => {
    if (r > 0) {
      const out = applyNet(docs, amount, r);
      setAlloc(out.alloc);
      set('tds_amount', out.tds || '');
      return;
    }
    let left = round2(Number(amount || 0) + Number(f.tds_amount || 0));
    const a = {};
    for (const d of [...docs].sort((x, y) => (x.date < y.date ? -1 : 1))) {
      const take = round2(Math.min(left, d.balance));
      if (take > 0) { a[d.id] = take; left = round2(left - take); }
    }
    setAlloc(a);
  };
  const setApplied = (docId, v) => {
    const next = { ...alloc, [docId]: v };
    setAlloc(next);
    if (rate > 0) {
      const tds = tdsOnApplied(docs, next, rate);
      const total = round2(Object.values(next).reduce((s, x) => s + (Number(x) || 0), 0));
      setF((x) => ({ ...x, tds_amount: tds || '', amount: round2(total - tds) }));
    }
  };
  const chooseSection = (v) => {
    const r = Number((meta?.tds_sections || []).find((s) => s.id === Number(v))?.rate) || 0;
    set('tds_section_id', v);
    if (!r) return set('tds_amount', '');
    if (totalAlloc > 0) {
      const tds = tdsOnApplied(docs, alloc, r);
      setF((x) => ({ ...x, tds_section_id: v, tds_amount: tds || '', amount: round2(totalAlloc - tds) }));
    } else if (Number(f.amount) > 0) autoApply(f.amount, r);
  };
  const save = async () => {
    if (!f.contact_id) return toast(`Select a ${contactType}`, 'error');
    if (totalAlloc > gross + 0.001) return toast('Amount applied exceeds the payment amount', 'error');
    setBusy(true);
    try {
      const body = { ...f, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([document_id, amount]) => ({ document_id: Number(document_id), amount: Number(amount) })) };
      const p = id ? await api.put(`/payments/${kind}/${id}`, body) : await api.post(`/payments/${kind}`, body);
      toast(`Payment ${p.number} saved`);
      nav(`/payments-${kind}/${p.id}`);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <PageHeader title={`${id ? 'Edit' : 'Record'} Payment ${kind === 'received' ? 'Received' : 'Made'}`} />
      <div className="form-section">
        <div className="form-grid">
          <Field inline label={contactType === 'customer' ? 'Customer Name' : 'Vendor Name'} required>
            <Combo value={f.contact_id} disabled={!!id} onChange={(v) => { set('contact_id', v); setAlloc({}); }} options={contacts.map((c) => ({ value: c.id, label: c.display_name, sub: c.email }))} />
          </Field>
          <div />
          <Field inline label={`Amount (${f.currency})`} required>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <NumberInput value={f.amount} onChange={(v) => set('amount', v)} onBlur={() => !totalAlloc && autoApply(f.amount)} />
              <Button size="sm" onClick={() => autoApply(f.amount)} disabled={!docs.length}>Auto-apply</Button>
            </div>
          </Field>
          <Field inline label="Bank Charges (if any)"><NumberInput value={f.bank_charges} onChange={(v) => set('bank_charges', v)} /></Field>
          <Field inline label="Payment Date" required><Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field inline label="Payment#"><Input value={f.number} placeholder="Auto-generated" onChange={(e) => set('number', e.target.value)} /></Field>
          <Field inline label="Payment Mode"><Select value={f.mode} onChange={(e) => set('mode', e.target.value)} options={PAYMENT_MODES.map((m) => [m, m])} /></Field>
          <Field inline label={kind === 'received' ? 'Deposit To' : 'Paid Through'} required><AccountSelect value={f.account_id} onChange={(v) => set('account_id', v)} filter={['cash', 'bank', 'credit_card', 'payment_clearing', 'other_current_asset', 'other_current_liability', 'equity']} /></Field>
          <Field inline label="Reference#"><Input value={f.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
          <Field inline label="TDS section" hint={kind === 'received' ? 'If the customer deducted TDS from this payment' : 'If you deduct TDS from this payment'}>
            <Select value={f.tds_section_id ?? ''} onChange={(e) => chooseSection(e.target.value)} placeholder="No TDS" options={tdsOptions(meta?.tds_sections, f.tds_section_id)} />
          </Field>
          <Field inline label={kind === 'received' ? 'TDS deducted by customer' : 'TDS deducted'}
            hint={rate > 0 && taxableApplied > 0 ? `${rate}% of ${money(taxableApplied, f.currency)} before GST` : undefined}>
            <NumberInput value={f.tds_amount} onChange={(v) => set('tds_amount', v)} />
          </Field>
          {f.currency !== baseCur && <Field inline label={`Exchange rate (1 ${f.currency} =)`}><NumberInput value={f.exchange_rate} onChange={(v) => set('exchange_rate', v)} /></Field>}
        </div>
      </div>
      <div className="form-section">
        <div className="row between mb"><h3>{kind === 'received' ? 'Unpaid Invoices' : 'Unpaid Bills'}</h3>{docs.length > 0 && <Button size="sm" variant="link" onClick={() => setAlloc({})}>Clear applied amount</Button>}</div>
        <Table rows={docs} empty={f.contact_id ? 'There are no unpaid documents for this contact. The full amount will be recorded as an advance (unused credit).' : `Select a ${contactType} to see unpaid documents.`} columns={[
          { key: 'date', label: 'Date', render: (d) => date(d.date) },
          { key: 'number', label: kind === 'received' ? 'Invoice Number' : 'Bill#', render: (d) => <>{d.number}{d.doc_type === 'retainer' && <span className="muted small"> (retainer)</span>}</> },
          { key: 'due_date', label: 'Due Date', render: (d) => date(d.due_date) },
          { key: 'total', label: 'Amount', align: 'right', render: (d) => money(d.total, d.currency) },
          { key: 'balance', label: 'Amount Due', align: 'right', render: (d) => money(d.balance, d.currency) },
          { key: 'pay', label: 'Payment', align: 'right', render: (d) => <NumberInput style={{ width: 130 }} value={alloc[d.id]} onChange={(v) => setApplied(d.id, v)} /> },
        ]} />
        <div className="totals mt">
          <div className="t-row"><span>Amount {kind === 'received' ? 'Received' : 'Paid'}{f.tds_amount ? ' + TDS' : ''}</span><span>{money(gross, f.currency)}</span></div>
          <div className="t-row"><span>Amount used for Payments</span><span>{money(totalAlloc, f.currency)}</span></div>
          <div className="t-row t-total"><span>Amount in Excess</span><span className={gross - totalAlloc < 0 ? 'neg' : ''}>{money(round2(gross - totalAlloc), f.currency)}</span></div>
        </div>
        <Field label="Notes" className="mt"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {kind === 'received' && !id && <div className="mt"><Checkbox label="Email a thank-you note for this payment" checked={f.send_receipt} onChange={(v) => set('send_receipt', v)} /></div>}
      </div>
      <div className="form-foot">
        <Button variant="primary" loading={busy} onClick={save}>Save</Button>
        <Button onClick={() => nav(-1)}>Cancel</Button>
      </div>
    </div>
  );
}
