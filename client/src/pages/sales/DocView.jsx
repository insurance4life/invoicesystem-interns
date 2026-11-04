import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp, useFetch } from '../../store.jsx';
import { api } from '../../api.js';
import { Button, Badge, Menu, Spinner, Tabs, Table, Card } from '../../components/ui.jsx';
import DocPaper from '../../components/DocPaper.jsx';
import ActivityPanel from '../../components/ActivityPanel.jsx';
import Attachments from '../../components/Attachments.jsx';
import { DOC_UI, docUrl } from '../../lib/docs.js';
import { EmailModal, PaymentModal, ApplyCreditsModal, ApplyToDocsModal, RefundModal, ConvertVendorModal, ReasonModal, WriteOffModal } from './DocModals.jsx';
import { Pencil, Mail, Printer, X, Hourglass } from 'lucide-react';

function SideList({ type, activeId, refreshKey }) {
  const { money } = useApp();
  const nav = useNavigate();
  const { data } = useFetch(`/documents/${type}`, { per_page: 100 }, [refreshKey]);
  return (
    <div className="split-list">
      <div className="row between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <Link to={docUrl(type)} className="bold">All {DOC_UI[type].plural}</Link>
        <Button size="sm" variant="primary" onClick={() => nav(docUrl(type, null, '/new'))}>+</Button>
      </div>
      {(data?.rows || []).map((r) => (
        <div key={r.id} className={`split-item ${String(r.id) === String(activeId) ? 'active' : ''}`} onClick={() => nav(docUrl(type, r.id))}>
          <div className="bold">{r.contact_name}</div><div className="r">{money(r.total, r.currency)}</div>
          <div className="small muted">{r.number} · {r.date}</div><div className="r"><Badge status={r.display_status} /></div>
        </div>
      ))}
    </div>
  );
}

export default function DocView({ type }) {
  const ui = DOC_UI[type];
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, org, settings, money, date, toast, can } = useApp();
  const { data: d, loading, reload } = useFetch(`/documents/${type}/${id}`);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('preview');
  const [rk, setRk] = useState(0);
  const module = ui.contact === 'customer' ? 'sales' : 'purchases';
  const refresh = () => { setModal(null); reload(); setRk((k) => k + 1); };

  if (loading && !d) return <Spinner />;
  if (!d) return <div className="page"><div className="empty"><h3>Not found</h3></div></div>;

  const act = async (action, body, msg) => {
    try { await api.post(`/documents/${type}/${d.id}/action/${action}`, body); toast(msg || 'Updated'); refresh(); } catch (e) { toast(e.message, 'error'); }
  };
  const convert = async (to, extra = {}) => {
    try { const n = await api.post(`/documents/${type}/${d.id}/convert`, { to, ...extra }); toast(`${DOC_UI[to].label} ${n.number} created as draft`); nav(docUrl(to, n.id, '/edit')); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${ui.label} ${d.number}? This cannot be undone.`)) return;
    try { await api.del(`/documents/${type}/${d.id}`); toast(`${ui.label} deleted`); nav(docUrl(type)); } catch (e) { toast(e.message, 'error'); }
  };
  const clone = async () => {
    try { const n = await api.post(`/documents/${type}/${d.id}/clone`); toast('Cloned as draft'); nav(docUrl(type, n.id, '/edit')); } catch (e) { toast(e.message, 'error'); }
  };
  const shareLink = `${window.location.origin}/share/${d.share_token}`;
  const st = d.display_status;
  const isDraft = d.status === 'draft';
  const pending = d.status === 'pending_approval';
  const payable = ['invoice', 'bill', 'retainer'].includes(type) && d.status === 'open' && d.balance > 0;
  const creditDoc = ['creditnote', 'vendorcredit'].includes(type) && d.status === 'open' && d.balance > 0;
  const kind = ui.contact === 'customer' ? 'received' : 'made';
  const openLabel = { quote: 'Mark as Sent', salesorder: 'Confirm', purchaseorder: 'Mark as Issued', bill: 'Mark as Open', creditnote: 'Convert to Open', vendorcredit: 'Convert to Open', deliverychallan: 'Mark as Open', retainer: 'Mark as Sent', invoice: 'Mark as Sent' }[type];

  const primary = [];
  if (isDraft && openLabel && can(module, 'edit')) primary.push(<Button key="open" variant="primary" onClick={() => act(type === 'quote' || type === 'invoice' || type === 'retainer' ? 'mark_sent' : 'open', {}, 'Status updated')}>{openLabel}</Button>);
  if (pending && can(module, 'approve')) primary.push(<Button key="ap" variant="primary" onClick={() => act('approve', {}, 'Approved')}>Approve</Button>, <Button key="rj" onClick={() => setModal('reject')}>Reject</Button>);
  if (payable && can(module, 'create')) primary.push(<Button key="pay" variant="primary" onClick={() => setModal('pay')}>Record Payment</Button>);
  if (type === 'quote' && ['sent', 'expired'].includes(st)) primary.push(<Button key="acc" onClick={() => act('accept', {}, 'Quote accepted')}>Mark as Accepted</Button>, <Button key="dec" onClick={() => act('decline', {}, 'Quote declined')}>Mark as Declined</Button>);
  if (creditDoc) primary.push(<Button key="apply" variant="primary" onClick={() => setModal('applyTo')}>Apply to {type === 'creditnote' ? 'Invoices' : 'Bills'}</Button>);
  if (type === 'retainer' && d.retainer_available > 0) primary.push(<Button key="applyR" variant="primary" onClick={() => setModal('applyTo')}>Apply to Invoice</Button>);
  if (ui.profile) {
    if (d.status === 'active') primary.push(<Button key="pause" onClick={() => act('pause', {}, 'Profile paused')}>Pause</Button>);
    if (d.status === 'paused') primary.push(<Button key="res" variant="primary" onClick={() => act('resume', {}, 'Profile resumed')}>Resume</Button>);
  }

  const convertItems = [
    type === 'quote' && !['invoiced', 'declined'].includes(d.status) && { label: 'Convert to Invoice', onClick: () => convert('invoice') },
    type === 'quote' && !['invoiced', 'declined'].includes(d.status) && { label: 'Convert to Sales Order', onClick: () => convert('salesorder') },
    type === 'salesorder' && ['open', 'draft'].includes(d.status) && { label: 'Convert to Invoice', onClick: () => convert('invoice') },
    type === 'salesorder' && { label: 'Create Purchase Order', onClick: () => setModal('vendor') },
    type === 'purchaseorder' && ['open', 'draft'].includes(d.status) && { label: 'Convert to Bill', onClick: () => convert('bill') },
    type === 'deliverychallan' && !['invoiced'].includes(d.status) && { label: 'Convert to Invoice', onClick: () => convert('invoice') },
    type === 'invoice' && d.status === 'open' && { label: 'Create Credit Note', onClick: () => convert('creditnote') },
    type === 'bill' && d.status === 'open' && { label: 'Create Vendor Credit', onClick: () => convert('vendorcredit') },
  ].filter(Boolean);

  const more = [
    { label: 'Clone', onClick: clone, hidden: !can(module, 'create') },
    { label: 'Copy share link', onClick: () => { navigator.clipboard?.writeText(shareLink); toast('Link copied'); }, hidden: ui.contact !== 'customer' || ui.profile },
    { label: 'Apply Credits', onClick: () => setModal('credits'), hidden: !payable || type === 'retainer' },
    { label: 'Send Payment Reminder', onClick: async () => { try { await api.post(`/documents/invoice/${d.id}/remind`); toast('Reminder sent'); setRk((k) => k + 1); } catch (e) { toast(e.message, 'error'); } }, hidden: type !== 'invoice' || !payable },
    { label: 'Write Off', onClick: () => setModal('writeoff'), hidden: type !== 'invoice' || !payable },
    { label: 'Cancel Write Off', onClick: () => act('cancel_writeoff', {}, 'Write off cancelled'), hidden: !(d.write_off > 0) },
    { label: 'Refund', onClick: () => setModal('refund'), hidden: !creditDoc },
    { label: 'Mark as Delivered', onClick: () => act('deliver'), hidden: type !== 'deliverychallan' || d.status !== 'open' },
    { label: 'Mark as Returned', onClick: () => act('return'), hidden: type !== 'deliverychallan' || !['open', 'delivered'].includes(d.status) },
    { label: 'Mark as Closed', onClick: () => act('close'), hidden: !['salesorder', 'purchaseorder'].includes(type) || d.status !== 'open' },
    { label: 'Mark as Invoiced', onClick: () => act('mark_invoiced'), hidden: !['quote', 'salesorder', 'deliverychallan'].includes(type) || ['invoiced', 'draft'].includes(d.status) },
    { label: 'Mark as Billed', onClick: () => act('mark_invoiced'), hidden: type !== 'purchaseorder' || d.status !== 'open' },
    { label: 'Cancel', onClick: () => act('cancel'), hidden: type !== 'purchaseorder' || ['cancelled', 'billed'].includes(d.status) },
    { label: 'Submit for Approval', onClick: () => act('submit', {}, 'Submitted'), hidden: !isDraft || !settings?.approvals?.[type] },
    { label: 'Convert to Draft', onClick: () => act('mark_draft', {}, 'Moved to draft'), hidden: isDraft || ui.profile || ['salesreceipt'].includes(type) },
    { label: 'Stop Profile', onClick: () => act('stop'), hidden: !ui.profile || d.status === 'stopped' },
    { divider: true },
    { label: 'Void', onClick: () => window.confirm(`Void ${d.number}? Its accounting entries are removed.`) && act('void', {}, 'Voided'), danger: true, hidden: !['invoice', 'bill', 'creditnote', 'vendorcredit', 'salesorder', 'retainer', 'salesreceipt'].includes(type) || d.status === 'void' },
    { label: 'Delete', onClick: remove, danger: true, hidden: !can(module, 'delete') },
  ];

  const relCount = (d.payments?.length || 0) + (d.credits_applied?.length || 0) + (d.applied_to?.length || 0) + (d.refunds?.length || 0) + (d.children?.length || 0);

  return (
    <div className="split">
      <SideList type={type} activeId={id} refreshKey={rk} />
      <div className="split-detail">
        <div className="page-head">
          <div className="page-head-row">
            <div className="page-title"><h1>{d.number}</h1><Badge status={st} /></div>
            <div className="page-actions">
              {d.status !== 'void' && can(module, 'edit') && <Button onClick={() => nav(docUrl(type, d.id, '/edit'))}><><Pencil size={16} strokeWidth={1.5} />Edit</></Button>}
              {ui.contact === 'customer' && !ui.profile && <Button onClick={() => setModal('email')}><><Mail size={16} strokeWidth={1.5} />Send</></Button>}
              {type === 'purchaseorder' && <Button onClick={() => setModal('email')}><><Mail size={16} strokeWidth={1.5} />Send</></Button>}
              {!ui.profile && <Button onClick={() => window.open(`/print/${type}/${d.id}`, '_blank')}><><Printer size={16} strokeWidth={1.5} />PDF / Print</></Button>}
              {primary}
              {convertItems.length > 0 && <Menu label="Convert" items={convertItems} />}
              <Menu label="More" items={more} />
              <Button variant="link" onClick={() => nav(docUrl(type))}><X size={18} strokeWidth={1.5} /></Button>
            </div>
          </div>
        </div>

        {pending && <div className="callout warn"><span><Hourglass size={16} strokeWidth={1.5} /> This {ui.label.toLowerCase()} is waiting for approval.</span></div>}
        {isDraft && type === 'invoice' && <div className="callout"><span><b>WHAT'S NEXT?</b> Send this invoice to your customer or mark it as sent so it's recorded in your books.</span><span className="row"><Button size="sm" variant="primary" onClick={() => setModal('email')}>Send Invoice</Button><Button size="sm" onClick={() => act('mark_sent', {}, 'Invoice marked as sent')}>Mark as Sent</Button></span></div>}
        {payable && type === 'invoice' && d.status === 'open' && <div className="callout"><span>Balance due <b>{money(d.balance, d.currency)}</b>{d.due_date ? ` · due ${date(d.due_date)}` : ''}. Customers can pay online through the share link.</span><span className="row"><Button size="sm" variant="primary" onClick={() => setModal('pay')}>Record Payment</Button></span></div>}
        {d.source_doc && <div className="muted small mb">Created from <Link to={docUrl(d.source_doc.doc_type, d.source_doc.id)}>{DOC_UI[d.source_doc.doc_type]?.label} {d.source_doc.number}</Link></div>}
        {ui.profile && (
          <Card title="Profile" className="mb">
            <div className="grid4">
              <div><div className="muted small">Customer/Vendor</div>{d.contact_name}</div>
              <div><div className="muted small">Frequency</div>Every {d.recurrence?.every} {d.recurrence?.frequency}</div>
              <div><div className="muted small">Next {ui.label.replace('Recurring ', '')} Date</div>{d.status === 'active' ? date(d.recurrence?.next_date) : '—'}</div>
              <div><div className="muted small">Ends</div>{d.recurrence?.end_date ? date(d.recurrence.end_date) : 'Never'}</div>
            </div>
          </Card>
        )}

        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'preview', label: ui.profile ? 'Template' : 'Preview' },
          { key: 'related', label: ui.profile ? `${ui.label.replace('Recurring ', '')}s` : 'Payments & Related', count: relCount || undefined },
          { key: 'activity', label: 'Comments & History' },
          { key: 'emails', label: 'Emails' },
          { key: 'files', label: 'Attachments' },
        ]} />

        {tab === 'preview' && <DocPaper doc={d} org={meta.org} settings={settings} />}

        {tab === 'related' && (
          <div className="stack">
            {d.payments?.length > 0 && <Card title="Payments" pad={false}><Table rows={d.payments} rowKey="allocation_id" onRowClick={(p) => nav(`/payments-${p.type}/${p.id}`)} columns={[
              { key: 'date', label: 'Date', render: (p) => date(p.date) }, { key: 'number', label: 'Payment#' }, { key: 'reference', label: 'Reference' },
              { key: 'mode', label: 'Mode' }, { key: 'amount', label: 'Amount', align: 'right', render: (p) => money(p.amount, d.currency) }]} /></Card>}
            {d.credits_applied?.length > 0 && <Card title="Credits Applied" pad={false}><Table rows={d.credits_applied} columns={[
              { key: 'date', label: 'Date', render: (c) => date(c.date) }, { key: 'source_number', label: 'Credit' }, { key: 'source_type', label: 'Type' },
              { key: 'amount', label: 'Amount', align: 'right', render: (c) => money(c.amount, d.currency) },
              { key: 'x', label: '', render: (c) => <Button size="sm" variant="link" onClick={async () => { if (!window.confirm('Remove this credit application?')) return; await api.del(`/credits/${c.id}`); refresh(); }}>Remove</Button> }]} /></Card>}
            {d.applied_to?.length > 0 && <Card title={`${type === 'retainer' ? 'Applied to Invoices' : 'Credits Applied To'}`} pad={false}><Table rows={d.applied_to} onRowClick={(c) => nav(docUrl(c.document_type, c.document_id))} columns={[
              { key: 'date', label: 'Date', render: (c) => date(c.date) }, { key: 'document_number', label: 'Document' },
              { key: 'amount', label: 'Amount', align: 'right', render: (c) => money(c.amount, d.currency) },
              { key: 'x', label: '', render: (c) => <Button size="sm" variant="link" onClick={async (e) => { e.stopPropagation(); if (!window.confirm('Remove?')) return; await api.del(`/credits/${c.id}`); refresh(); }}>Remove</Button> }]} /></Card>}
            {d.refunds?.length > 0 && <Card title="Refunds" pad={false}><Table rows={d.refunds} columns={[
              { key: 'date', label: 'Date', render: (r) => date(r.date) }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference' },
              { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount, d.currency) },
              { key: 'x', label: '', render: (r) => <Button size="sm" variant="link" onClick={async () => { if (!window.confirm('Delete refund?')) return; await api.del(`/refunds/${r.id}`); refresh(); }}>Delete</Button> }]} /></Card>}
            {d.children?.length > 0 && <Card title={ui.profile ? 'Generated Documents' : 'Related Documents'} pad={false}><Table rows={d.children} onRowClick={(c) => nav(docUrl(c.doc_type, c.id))} columns={[
              { key: 'date', label: 'Date', render: (c) => date(c.date) }, { key: 'number', label: 'Number' }, { key: 'doc_type', label: 'Type', render: (c) => DOC_UI[c.doc_type]?.label },
              { key: 'status', label: 'Status', render: (c) => <Badge status={c.status} /> }, { key: 'total', label: 'Amount', align: 'right', render: (c) => money(c.total) }]} /></Card>}
            {!relCount && <div className="muted pad center">Nothing recorded against this {ui.label.toLowerCase()} yet.</div>}
          </div>
        )}
        {tab === 'activity' && <Card><ActivityPanel entityType="document" entityId={d.id} refreshKey={rk} /></Card>}
        {tab === 'emails' && <EmailLog id={d.id} rk={rk} />}
        {tab === 'files' && <Card><Attachments entityType={type} entityId={d.id} /></Card>}

        {modal === 'email' && <EmailModal type={type} doc={d} onClose={() => setModal(null)} onDone={refresh} />}
        {modal === 'pay' && <PaymentModal kind={kind} doc={{ ...d, base_currency: org.currency }} onClose={() => setModal(null)} onDone={refresh} />}
        {modal === 'credits' && <ApplyCreditsModal doc={d} onClose={() => setModal(null)} onDone={refresh} />}
        {modal === 'applyTo' && <ApplyToDocsModal source={d} onClose={() => setModal(null)} onDone={refresh} />}
        {modal === 'refund' && <RefundModal sourceType={type} source={d} available={d.balance} contactKind={ui.contact} onClose={() => setModal(null)} onDone={refresh} />}
        {modal === 'vendor' && <ConvertVendorModal onClose={() => setModal(null)} onPick={(v) => convert('purchaseorder', { contact_id: v })} />}
        {modal === 'reject' && <ReasonModal title="Reject" required onClose={() => setModal(null)} onSubmit={(reason) => act('reject', { reason }, 'Rejected')} />}
        {modal === 'writeoff' && <WriteOffModal doc={d} onClose={() => setModal(null)} onDone={refresh} />}
      </div>
    </div>
  );
}

function EmailLog({ id, rk }) {
  const { data } = useFetch('/emails', { entity_type: 'document', entity_id: id }, [rk]);
  return (
    <Table rows={data || []} empty="No emails sent yet." columns={[
      { key: 'created_at', label: 'Sent', render: (e) => new Date(`${e.created_at.replace(' ', 'T')}Z`).toLocaleString() },
      { key: 'to_addr', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status', render: (e) => <Badge status={e.status} /> },
    ]} />
  );
}
