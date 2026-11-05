// Printable document layout (invoice, quote, bill...). Used by the detail page and the print route.
import { fmtMoney, fmtDate, statusLabel, taxLabel } from '../lib/format.js';
import { DOC_UI } from '../lib/docs.js';
import { INDIAN_STATES } from '@shared/calc.js';

const stateName = (code) => INDIAN_STATES.find(([c]) => c === code)?.[1] || code;

function Address({ a }) {
  if (!a || typeof a !== 'object') return null;
  return <div>{[a.attention, a.street, [a.city, a.state, a.zip].filter(Boolean).join(', '), a.country, a.phone].filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</div>;
}

export default function DocPaper({ doc, org, settings }) {
  const ui = DOC_UI[doc.doc_type] || {};
  const pdf = settings?.pdf || {};
  const color = pdf.color || '#408dfb';
  const cur = doc.currency;
  const m = (v) => fmtMoney(v, cur);
  const d = (x) => fmtDate(x, org?.date_format);
  const title = doc.doc_type === 'invoice' && org?.gst_enabled && doc.tax_total > 0 ? 'TAX INVOICE' : (ui.label || '').toUpperCase();
  const hasDiscount = doc.lines?.some((l) => Number(l.discount));
  const hasHsn = doc.lines?.some((l) => l.hsn_sac);
  const status = doc.display_status;
  const tpl = pdf.template || 'standard';
  return (
    <div className={`doc-paper tpl-${tpl}`} style={{ '--accent': color }}>
      {status && !['draft'].includes(status) && <div className={`doc-ribbon ${status}`}>{statusLabel(status)}</div>}
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          {pdf.show_logo !== false && org?.logo && <img src={org.logo} alt="" style={{ maxHeight: 64, maxWidth: 200, marginBottom: 8 }} />}
          <div style={{ fontSize: 17, fontWeight: 700 }}>{org?.name}</div>
          <Address a={org?.address} />
          {org?.gstin && <div>GSTIN {org.gstin}</div>}
          {org?.email && <div>{org.email}</div>}
          {org?.phone && <div>{org.phone}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 26, letterSpacing: 1, color: tpl === 'minimal' ? '#222' : color }}>{title}</div>
          <div style={{ fontWeight: 600 }}># {doc.number}</div>
          {ui.contact === 'customer' && doc.doc_type === 'invoice' && doc.balance > 0 && (
            <div style={{ marginTop: 10 }}><div className="small" style={{ color: '#666' }}>Balance Due</div><div style={{ fontSize: 18, fontWeight: 700 }}>{m(doc.balance)}</div></div>
          )}
        </div>
      </div>

      <div className="row between" style={{ marginTop: 28, alignItems: 'flex-start' }}>
        <div>
          <div className="small" style={{ color: '#666' }}>{ui.contact === 'vendor' ? 'Vendor' : 'Bill To'}</div>
          <div style={{ fontWeight: 700, color }}>{doc.contact_name}</div>
          <Address a={doc.billing_address} />
          {doc.contact_gstin && <div>GSTIN {doc.contact_gstin}</div>}
          {doc.shipping_address && Object.values(doc.shipping_address || {}).some(Boolean) && ui.contact === 'customer' && (
            <div style={{ marginTop: 10 }}><div className="small" style={{ color: '#666' }}>Ship To</div><Address a={doc.shipping_address} /></div>
          )}
        </div>
        <table style={{ width: 'auto' }}>
          <tbody>
            <tr><td style={{ color: '#666', border: 0, padding: '2px 12px' }}>{ui.label} Date :</td><td style={{ border: 0, padding: 2 }}>{d(doc.date)}</td></tr>
            {doc.due_date && ui.dueLabel && <tr><td style={{ color: '#666', border: 0, padding: '2px 12px' }}>{ui.dueLabel} :</td><td style={{ border: 0, padding: 2 }}>{d(doc.due_date)}</td></tr>}
            {doc.reference && <tr><td style={{ color: '#666', border: 0, padding: '2px 12px' }}>Reference :</td><td style={{ border: 0, padding: 2 }}>{doc.reference}</td></tr>}
            {doc.place_of_supply && org?.gst_enabled ? <tr><td style={{ color: '#666', border: 0, padding: '2px 12px' }}>Place of Supply :</td><td style={{ border: 0, padding: 2 }}>{stateName(doc.place_of_supply)} ({doc.place_of_supply})</td></tr> : null}
            {doc.salesperson && <tr><td style={{ color: '#666', border: 0, padding: '2px 12px' }}>Salesperson :</td><td style={{ border: 0, padding: 2 }}>{doc.salesperson}</td></tr>}
          </tbody>
        </table>
      </div>

      <table style={{ marginTop: 22 }}>
        <thead>
          <tr>
            <th style={{ width: 30 }}>#</th><th>Item &amp; Description</th>{hasHsn && <th>HSN/SAC</th>}
            <th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th>
            {hasDiscount && <th style={{ textAlign: 'right' }}>Disc %</th>}
            {doc.tax_total > 0 && <th style={{ textAlign: 'right' }}>Tax</th>}
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {(doc.lines || []).map((l, i) => (
            <tr key={l.id || i}>
              <td>{i + 1}</td>
              <td><div style={{ fontWeight: 500 }}>{l.name || l.item_name || l.account_name}</div>{l.description && <div className="small" style={{ color: '#666', whiteSpace: 'pre-wrap' }}>{l.description}</div>}</td>
              {hasHsn && <td>{l.hsn_sac}</td>}
              <td style={{ textAlign: 'right' }}>{Number(l.quantity)}{l.unit ? ` ${l.unit}` : ''}</td>
              <td style={{ textAlign: 'right' }}>{fmtMoney(l.rate, cur).replace(/^[^\d-]+/, '')}</td>
              {hasDiscount && <td style={{ textAlign: 'right' }}>{Number(l.discount) || ''}</td>}
              {doc.tax_total > 0 && <td style={{ textAlign: 'right' }} className="small">{(l.tax_breakdown || []).map((t) => <div key={t.name}>{taxLabel(t)}: {fmtMoney(t.amount, cur).replace(/^[^\d-]+/, '')}</div>)}</td>}
              <td style={{ textAlign: 'right' }}>{fmtMoney(l.amount, cur).replace(/^[^\d-]+/, '')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row between" style={{ alignItems: 'flex-start', marginTop: 16 }}>
        <div style={{ maxWidth: '48%' }}>
          {doc.notes && <><div className="small" style={{ color: '#666' }}>Notes</div><div style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{doc.notes}</div></>}
          {doc.terms && <><div className="small" style={{ color: '#666' }}>Terms &amp; Conditions</div><div style={{ whiteSpace: 'pre-wrap' }}>{doc.terms}</div></>}
        </div>
        <table style={{ width: 320 }}>
          <tbody>
            <tr><td style={{ border: 0 }}>Sub Total</td><td style={{ border: 0, textAlign: 'right' }}>{m(doc.subtotal)}</td></tr>
            {doc.discount_total > 0 && <tr><td style={{ border: 0 }}>Discount{doc.discount_type === 'percent' ? ` (${doc.discount_value}%)` : ''}</td><td style={{ border: 0, textAlign: 'right' }}>-{m(doc.discount_total)}</td></tr>}
            {(doc.taxes || []).map((t) => <tr key={t.name}><td style={{ border: 0 }}>{taxLabel(t)}</td><td style={{ border: 0, textAlign: 'right' }}>{m(t.amount)}</td></tr>)}
            {doc.shipping ? <tr><td style={{ border: 0 }}>Shipping Charges</td><td style={{ border: 0, textAlign: 'right' }}>{m(doc.shipping)}</td></tr> : null}
            {doc.adjustment ? <tr><td style={{ border: 0 }}>{doc.adjustment_label || 'Adjustment'}</td><td style={{ border: 0, textAlign: 'right' }}>{m(doc.adjustment)}</td></tr> : null}
            <tr><td style={{ border: 0, fontWeight: 700, borderTop: '1px solid #ddd' }}>Total</td><td style={{ border: 0, textAlign: 'right', fontWeight: 700, borderTop: '1px solid #ddd' }}>{m(doc.total)}</td></tr>
            {doc.doc_type === 'invoice' && doc.total !== doc.balance && doc.status !== 'draft' && <>
              <tr><td style={{ border: 0 }}>Payments / Credits</td><td style={{ border: 0, textAlign: 'right', color: 'var(--red)' }}>(-) {m(doc.total - doc.balance - (doc.write_off || 0))}</td></tr>
              {doc.write_off > 0 && <tr><td style={{ border: 0 }}>Write off</td><td style={{ border: 0, textAlign: 'right' }}>(-) {m(doc.write_off)}</td></tr>}
              <tr><td style={{ border: 0, fontWeight: 700, background: '#f5f5f5' }}>Balance Due</td><td style={{ border: 0, textAlign: 'right', fontWeight: 700, background: '#f5f5f5' }}>{m(doc.balance)}</td></tr>
            </>}
          </tbody>
        </table>
      </div>
      {pdf.show_signature && <div style={{ marginTop: 50, textAlign: 'right' }}><div style={{ borderTop: '1px solid #999', display: 'inline-block', paddingTop: 4, minWidth: 200, textAlign: 'center' }}>Authorized Signature</div></div>}
      {pdf.footer && <div className="small" style={{ marginTop: 30, color: '#777', textAlign: 'center', borderTop: '1px solid #eee', paddingTop: 10 }}>{pdf.footer}</div>}
    </div>
  );
}
