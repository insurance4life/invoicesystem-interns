import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Stat, Tabs } from '../../components/ui.jsx';
import { fmtDate, fmtMoney } from '../../lib/format.js';
import { DOC_UI } from '../../lib/docs.js';
import { Shell, Notice, Loading } from './PublicShell.jsx';
import { usePublic } from './publicApi.js';

const TABS = [
  { key: 'invoices', label: 'Invoices' },
  { key: 'quotes', label: 'Quotes & orders' },
  { key: 'payments', label: 'Payments' },
  { key: 'statement', label: 'Statement' },
];

/** Customer portal: everything a customer has with this organization, read-only. */
export default function PortalPage() {
  const { token } = useParams();
  const portal = usePublic(`/portal/${token}`);
  const [tab, setTab] = useState('invoices');

  if (portal.loading && !portal.data) return <Loading />;
  if (portal.error) {
    return <Notice title="Portal not available" text="This customer portal link is not active. Ask the sender for a new link." />;
  }

  const { org, contact, currency, invoices, quotes, salesorders, creditnotes, retainers, payments, summary } = portal.data;
  const cur = currency || org.currency;
  const m = (v) => fmtMoney(v, cur);
  const open = invoices.filter((i) => i.balance > 0.004 && i.display_status !== 'void');
  const ctaTo = (d) => `/share/${d.share_token}`;

  const docColumns = (extra) => [
    { key: 'number', label: 'Number', render: (d) => <Link to={ctaTo(d)} className="bold">{d.number}</Link> },
    { key: 'date', label: 'Date', render: (d) => fmtDate(d.date) },
    ...extra,
    { key: 'status', label: 'Status', render: (d) => <Badge status={d.display_status} /> },
  ];

  return (
    <Shell>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="muted small">Customer portal · {org.name}</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{contact.company_name || contact.display_name}</div>
            {contact.email && <div className="small muted">{contact.email}</div>}
          </div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <Stat label="Outstanding" value={m(summary.outstanding)} tone={summary.outstanding > 0 ? 'orange' : 'green'} />
            <Stat label="Unused credits" value={m(summary.unused_credits)} />
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'invoices' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Invoice</th><th>Date</th><th>Due</th><th className="r">Total</th><th className="r">Balance</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {invoices.map((d) => (
                <tr key={d.id}>
                  <td><Link to={ctaTo(d)} className="bold">{d.number}</Link></td>
                  <td>{fmtDate(d.date)}</td>
                  <td>{fmtDate(d.due_date)}</td>
                  <td className="r">{m(d.total)}</td>
                  <td className="r">{m(d.balance)}</td>
                  <td><Badge status={d.display_status} /></td>
                  <td className="r">
                    {d.balance > 0.004 && d.display_status !== 'draft' && (
                      <Link className="btn btn-primary btn-sm" to={`${ctaTo(d)}?pay=1`}>Pay</Link>
                    )}
                  </td>
                </tr>
              ))}
              {!invoices.length && <tr><td colSpan={7} className="center muted pad">No invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'quotes' && (
        <div className="stack">
          <Section title="Quotes">
            <DocTable rows={quotes} columns={docColumns([{ key: 'total', label: 'Total', align: 'r', render: (d) => m(d.total) }])} empty="No quotes." />
          </Section>
          <Section title="Sales orders">
            <DocTable rows={salesorders} columns={docColumns([{ key: 'total', label: 'Total', align: 'r', render: (d) => m(d.total) }])} empty="No sales orders." />
          </Section>
        </div>
      )}

      {tab === 'payments' && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Receipt</th><th>Date</th><th>Mode</th><th>Reference</th><th className="r">Amount</th><th className="r">Unused</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="bold">{p.number}</td><td>{fmtDate(p.date)}</td><td>{p.mode}</td><td className="small">{p.reference || '—'}</td>
                  <td className="r">{m(p.amount)}</td><td className="r">{m(p.unused)}</td>
                </tr>
              ))}
              {!payments.length && <tr><td colSpan={6} className="center muted pad">No payments recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'statement' && (
        <div className="stack">
          <div className="card">
            <div className="card-body">
              <div className="row between"><span>Invoices outstanding</span><b>{m(summary.outstanding)}</b></div>
              <div className="row between mt" style={{ marginTop: 8 }}><span>Unused credits you can apply</span><b>{m(summary.unused_credits)}</b></div>
            </div>
          </div>
          <Section title="Open invoices">
            <DocTable rows={open} columns={docColumns([{ key: 'balance', label: 'Balance', align: 'r', render: (d) => m(d.balance) }])} empty="Nothing is outstanding. Thank you!" />
          </Section>
          {(creditnotes.length > 0 || retainers.length > 0) && (
            <Section title="Credit notes & retainers">
              <DocTable
                rows={[...creditnotes.map((d) => ({ ...d, _type: DOC_UI.creditnote.label })), ...retainers.map((d) => ({ ...d, _type: DOC_UI.retainer.label }))]}
                columns={docColumns([
                  { key: 'type', label: 'Type', render: (d) => d._type },
                  { key: 'balance', label: 'Balance', align: 'r', render: (d) => m(d.balance) },
                ])}
                empty=""
              />
            </Section>
          )}
        </div>
      )}
    </Shell>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="bold" style={{ margin: '4px 0 8px' }}>{title}</div>
      {children}
    </div>
  );
}

function DocTable({ rows, columns, empty }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.align === 'r' ? 'r' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              {columns.map((c) => <td key={c.key} className={c.align === 'r' ? 'r' : ''}>{c.render ? c.render(d) : d[c.key]}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length} className="center muted pad">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
