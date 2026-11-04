import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { PageHeader, Button, Table, Badge, Menu, Modal, Tabs, Card, Stat, KeyValue, Textarea, Empty, Checkbox } from '../../components/ui.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import ContactStatement from './ContactStatement.jsx';

const GST_LABEL = {
  registered: 'Registered Business', unregistered: 'Unregistered Business', consumer: 'Consumer',
  overseas: 'Overseas', sez: 'Special Economic Zone', composition: 'Composition Scheme',
};

const CUSTOMER_TX = [
  ['Invoice', 'invoice', '/invoices/new'], ['Quote', 'quote', '/quotes/new'], ['Sales Order', 'salesorder', '/salesorders/new'],
  ['Retainer Invoice', 'retainer', '/retainerinvoices/new'], ['Credit Note', 'creditnote', '/creditnotes/new'],
  ['Payment Received', 'payment', '/payments-received/new'], ['Recurring Invoice', 'recurring', '/recurringinvoices/new'],
  ['Delivery Challan', 'challan', '/deliverychallans/new'], ['Sales Receipt', 'receipt', '/salesreceipts/new'],
];
const VENDOR_TX = [
  ['Bill', 'bill', '/bills/new'], ['Purchase Order', 'po', '/purchaseorders/new'], ['Expense', 'expense', '/expenses/new'],
  ['Payment Made', 'payment', '/payments-made/new'], ['Vendor Credit', 'vcredit', '/vendorcredits/new'],
  ['Recurring Bill', 'recurring', '/recurringbills/new'],
];

const addressLines = (a) => {
  if (!a) return null;
  const parts = [a.attention, a.street, [a.city, a.state].filter(Boolean).join(', '), [a.zip, a.country].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.map((p, i) => <div key={i}>{p}</div>) : null;
};

export default function ContactView({ type }) {
  const isCust = type === 'customer';
  const slug = isCust ? 'customers' : 'vendors';
  const label = isCust ? 'Customer' : 'Vendor';
  const { id } = useParams();
  const nav = useNavigate();
  const { money, date, can, toast, meta, org } = useApp();
  const [tab, setTab] = useState('overview');
  const [mergeOpen, setMergeOpen] = useState(false);
  const { data: c, loading, reload } = useFetch(`/contacts/${id}`, null, [id]);
  const credits = useFetch(`/contacts/${id}/credits`, null, [id]);
  const openDocs = useFetch(`/contacts/${id}/open-documents`, null, [id]);
  const txs = useFetch(tab === 'transactions' ? `/contacts/${id}/transactions` : null, null, [id, tab]);
  const comments = useFetch(tab === 'comments' ? '/comments' : null, { entity_type: 'contact', entity_id: id }, [id, tab]);
  const history = useFetch(tab === 'history' ? '/activity' : null, { entity_type: 'contact', entity_id: id, limit: 200 }, [id, tab]);

  if (loading && !c) return <div className="page"><div className="center pad"><span className="spin" /></div></div>;
  if (!c) return <div className="page"><Empty title={`${label} not found`} action={<Button onClick={() => nav(`/${slug}`)}>Back to list</Button>} /></div>;

  const module = 'contacts';
  const unused = (credits.data || []).reduce((s, x) => s + (x.balance || 0), 0);
  const term = meta?.payment_terms?.find((t) => t.id === c.payment_term_id);
  const taxName = (tid) => meta?.taxes?.find((t) => t.id === tid)?.name;
  const portalUrl = c.portal_enabled && c.portal_token ? `${window.location.origin}/portal/${c.portal_token}` : null;
  const txItems = isCust ? CUSTOMER_TX : VENDOR_TX;

  const newTx = (path) => nav(`${path}?contact_id=${c.id}`);

  const toggleActive = async () => {
    try {
      await api.post(`/contacts/${c.id}/status`, { active: !c.is_active });
      toast(c.is_active ? `${label} marked inactive` : `${label} marked active`);
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${c.display_name}? This cannot be undone.`)) return;
    try {
      await api.del(`/contacts/${c.id}`);
      toast(`${label} deleted`);
      nav(`/${slug}`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const clone = async () => {
    const body = {
      type: c.type, customer_type: c.customer_type, salutation: c.salutation, first_name: c.first_name, last_name: c.last_name,
      company_name: c.company_name, display_name: `${c.display_name} (copy)`, email: c.email, phone: c.phone, mobile: c.mobile, website: c.website,
      currency: c.currency, payment_term_id: c.payment_term_id, gst_treatment: c.gst_treatment, gstin: c.gstin, pan: c.pan,
      place_of_supply: c.place_of_supply, billing_address: c.billing_address, shipping_address: c.shipping_address,
      contact_persons: c.contact_persons, notes: c.notes, credit_limit: c.credit_limit, price_list_id: c.price_list_id,
      portal_enabled: c.portal_enabled, reminders_enabled: c.reminders_enabled, opening_balance: 0,
    };
    try {
      const res = await api.post('/contacts', body);
      toast(`Cloned to ${res.display_name}`);
      nav(`/${slug}/${res.id}/edit`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const menuItems = [
    { label: 'Statement', onClick: () => setTab('statement') },
    { label: 'Clone', onClick: clone, hidden: !can(module, 'create') },
    { label: 'Merge', onClick: () => setMergeOpen(true), hidden: !can(module, 'delete') },
    { divider: true },
    { label: c.is_active ? 'Mark as Inactive' : 'Mark as Active', onClick: toggleActive, hidden: !can(module, 'edit') },
    { label: 'Delete', onClick: remove, danger: true, hidden: !can(module, 'delete') },
  ];

  const txMenu = txItems.map(([l, , path]) => ({ label: l, onClick: () => newTx(path) }));

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'transactions', label: 'Transactions' },
    { key: 'statement', label: 'Statement' },
    { key: 'comments', label: 'Comments' },
    { key: 'history', label: 'History' },
  ];

  return (
    <div className="page">
      <PageHeader
        title={<span>{c.display_name} {!c.is_active && <Badge status="inactive" />}</span>}
        subtitle={[c.company_name, c.email, c.gstin ? `GSTIN ${c.gstin}` : null].filter(Boolean).join(' · ') || undefined}
        back={<Button variant="link" onClick={() => nav(`/${slug}`)}>← {isCust ? 'Customers' : 'Vendors'}</Button>}
        actions={<>
          {can(module, 'edit') && <Button onClick={() => nav(`/${slug}/${c.id}/edit`)}>Edit</Button>}
          {can('sales', 'create') || can('purchases', 'create')
            ? <Menu label="New Transaction" items={txMenu} variant="primary" />
            : null}
          <Menu label="More" items={menuItems} />
        </>}
      />

      <div className="grid4 mt">
        <Stat label={isCust ? 'Receivables' : 'Payables'} value={money(c.outstanding, c.currency)} sub={c.opening_balance ? `Opening balance ${money(c.opening_balance, c.currency)}` : undefined} />
        <Stat label="Unused Credits" value={money(unused, c.currency)} />
        {isCust && <Stat label="Credit Limit" value={c.credit_limit ? money(c.credit_limit, c.currency) : 'No limit'} />}
        <Stat label="Payment Terms" value={term ? term.name : 'None'} />
      </div>

      <div className="mt">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
      </div>

      {tab === 'overview' && (
        <div className="grid2 mt">
          <div className="stack">
            <Card title="Contact Information">
              <KeyValue items={[
                ['Customer Type', c.customer_type === 'individual' ? 'Individual' : 'Business'],
                ['Email', c.email], ['Phone', c.phone], ['Mobile', c.mobile], ['Website', c.website],
                ['Currency', c.currency || org?.currency],
                ['Reminders', c.reminders_enabled ? 'Enabled' : 'Disabled'],
                ['Portal', c.portal_enabled ? 'Enabled' : 'Disabled'],
              ]} />
              {portalUrl && (
                <div className="callout mt">
                  <div className="small muted">Customer portal link</div>
                  <code style={{ wordBreak: 'break-all' }}>{portalUrl}</code>
                </div>
              )}
            </Card>
            <Card title="GST Information">
              <KeyValue items={[
                ['GST Treatment', GST_LABEL[c.gst_treatment] || 'Unregistered Business'],
                ['GSTIN', c.gstin], ['PAN', c.pan],
                ['Place of Supply', c.place_of_supply ? `[${c.place_of_supply}]` : null],
              ]} />
            </Card>
            <Card title="Payment Terms">
              <KeyValue items={[['Terms', term?.name || 'None'], ['Price List', c.price_list_id ? 'Assigned' : 'None']]} />
            </Card>
          </div>

          <div className="stack">
            <Card title="Addresses">
              <div className="grid2">
                <div><div className="muted small">Billing</div>{addressLines(c.billing_address) || <span className="muted">Not set</span>}</div>
                <div><div className="muted small">Shipping</div>{addressLines(c.shipping_address) || <span className="muted">Not set</span>}</div>
              </div>
            </Card>
            <Card title="Contact Persons">
              {(c.contact_persons || []).length === 0 && <span className="muted">No contact persons.</span>}
              {(c.contact_persons || []).map((p, i) => (
                <div key={i} className="small" style={{ marginBottom: 8 }}>
                  <div className="bold">{[p.salutation, p.first_name, p.last_name].filter(Boolean).join(' ')}{p.designation ? ` · ${p.designation}` : ''}</div>
                  <div className="muted">{[p.email, p.phone].filter(Boolean).join(' · ')}</div>
                </div>
              ))}
            </Card>
            <Card title={`Open ${isCust ? 'Invoices' : 'Bills'}`}>
              <Table
                columns={[
                  { key: 'number', label: 'Number', render: (r) => <Link to={docUrl(r.doc_type, r.id)}>{r.number}</Link> },
                  { key: 'due_date', label: 'Due', render: (r) => date(r.due_date) },
                  { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance, r.currency) },
                ]}
                rows={openDocs.data || []}
                loading={openDocs.loading}
                empty="Nothing outstanding."
              />
            </Card>
          </div>
        </div>
      )}

      {tab === 'transactions' && (
        <div className="stack mt">
          {txs.loading && <div className="center pad"><span className="spin" /></div>}
          {txs.data && (() => {
            const docs = txs.data.documents || [];
            const groups = Object.entries(docs.reduce((acc, d) => { (acc[d.doc_type] ||= []).push(d); return acc; }, {}));
            if (!docs.length && !txs.data.payments?.length && !txs.data.expenses?.length) return <Empty title="No transactions yet" text={`Create an invoice or payment for this ${label.toLowerCase()} to see it here.`} />;
            return (
              <>
                {groups.map(([dt, list]) => (
                  <Card key={dt} title={DOC_UI[dt]?.plural || dt}>
                    <Table
                      columns={[
                        { key: 'date', label: 'Date', render: (r) => date(r.date) },
                        { key: 'number', label: 'Number', render: (r) => <Link to={docUrl(dt, r.id)}>{r.number}</Link> },
                        { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
                        { key: 'due_date', label: 'Due', render: (r) => date(r.due_date) },
                        { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total, c.currency) },
                        { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance, c.currency) },
                      ]}
                      rows={list}
                    />
                  </Card>
                ))}
                {(txs.data.payments || []).length > 0 && (
                  <Card title="Payments">
                    <Table
                      columns={[
                        { key: 'date', label: 'Date', render: (r) => date(r.date) },
                        { key: 'number', label: 'Number', render: (r) => <Link to={`/payments-${r.type === 'made' ? 'made' : 'received'}/${r.id}`}>{r.number}</Link> },
                        { key: 'mode', label: 'Mode' },
                        { key: 'reference', label: 'Reference' },
                        { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount, c.currency) },
                      ]}
                      rows={txs.data.payments}
                    />
                  </Card>
                )}
                {(txs.data.expenses || []).length > 0 && (
                  <Card title="Expenses">
                    <Table
                      columns={[
                        { key: 'date', label: 'Date', render: (r) => date(r.date) },
                        { key: 'reference', label: 'Reference', render: (r) => <Link to={`/expenses/${r.id}`}>{r.reference || `Expense #${r.id}`}</Link> },
                        { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
                        { key: 'total', label: 'Amount', align: 'right', render: (r) => money(r.total, c.currency) },
                      ]}
                      rows={txs.data.expenses}
                    />
                  </Card>
                )}
              </>
            );
          })()}
        </div>
      )}

      {tab === 'statement' && (
        <div className="mt">
          <ContactStatement contact={c} />
        </div>
      )}

      {tab === 'comments' && (
        <CommentsPanel contactId={c.id} comments={comments.data || []} loading={comments.loading} onChange={comments.reload} />
      )}

      {tab === 'history' && (
        <Card title="History" className="mt">
          {history.loading && <div className="center pad"><span className="spin" /></div>}
          {!history.loading && (history.data || []).length === 0 && <span className="muted">No activity yet.</span>}
          {(history.data || []).map((a) => (
            <div key={a.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid var(--line2)' }}>
              <span className="bold">{a.user_name || 'System'}</span> {a.action}{a.detail ? <span className="muted"> — {a.detail}</span> : null}
              <div className="muted">{date(String(a.created_at).slice(0, 10))} {String(a.created_at).slice(11, 16)}</div>
            </div>
          ))}
        </Card>
      )}

      {mergeOpen && (
        <MergeDialog contact={c} onClose={() => setMergeOpen(false)} onDone={() => { setMergeOpen(false); reload(); }} />
      )}
    </div>
  );
}

function CommentsPanel({ contactId, comments, loading, onChange }) {
  const { toast, date } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post('/comments', { entity_type: 'contact', entity_id: Number(contactId), text });
      setText('');
      onChange();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Comments" className="mt">
      <div className="stack">
        <Textarea rows={3} placeholder="Add a comment for your team" value={text} onChange={(e) => setText(e.target.value)} />
        <div><Button variant="primary" size="sm" loading={busy} disabled={!text.trim()} onClick={post}>Post Comment</Button></div>
        {loading && <span className="muted">Loading…</span>}
        {!loading && comments.length === 0 && <span className="muted">No comments yet.</span>}
        {comments.map((cm) => (
          <div key={cm.id} className="small" style={{ borderTop: '1px solid var(--line2)', paddingTop: 8 }}>
            <div><span className="bold">{cm.author || 'Someone'}</span> <span className="muted">· {date(String(cm.created_at).slice(0, 10))}</span></div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{cm.text}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MergeDialog({ contact, onClose, onDone }) {
  const { toast, can } = useApp();
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const { data } = useFetch('/contacts', { type: contact.type, status: 'all', per_page: 1000 }, [contact.id]);
  const others = (data || []).filter((x) => x.id !== contact.id);
  const merge = async () => {
    if (!picked.length) return;
    if (!window.confirm(`Merge ${picked.length} contact(s) into ${contact.display_name}? Their transactions and balances move here and the merged contacts are deleted.`)) return;
    setBusy(true);
    try {
      await api.post('/contacts/merge', { target_id: contact.id, source_ids: picked });
      toast('Contacts merged');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Merge into ${contact.display_name}`} onClose={onClose} width={560}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={!picked.length} onClick={merge}>Merge {picked.length || ''}</Button>
      </>}>
      <p className="muted small">Choose the duplicate contacts to fold into this one. Their invoices, bills, payments, expenses and balances move to {contact.display_name}, and they are deleted.</p>
      {others.length === 0 && <span className="muted">No other {contact.type} contacts.</span>}
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        {others.map((o) => (
          <div key={o.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line2)' }}>
            <Checkbox label={`${o.display_name}${o.company_name ? ` · ${o.company_name}` : ''}`} checked={picked.includes(o.id)}
              onChange={(v) => setPicked(v ? [...picked, o.id] : picked.filter((x) => x !== o.id))} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
