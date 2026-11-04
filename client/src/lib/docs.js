// Document type ↔ URL slug, labels and per-type UI behaviour.
export const DOC_SLUGS = {
  quote: 'quotes', salesorder: 'salesorders', invoice: 'invoices', retainer: 'retainerinvoices', creditnote: 'creditnotes',
  deliverychallan: 'deliverychallans', salesreceipt: 'salesreceipts', recurring_invoice: 'recurringinvoices',
  purchaseorder: 'purchaseorders', bill: 'bills', vendorcredit: 'vendorcredits', recurring_bill: 'recurringbills',
};
export const SLUG_TYPES = Object.fromEntries(Object.entries(DOC_SLUGS).map(([k, v]) => [v, k]));
export const docUrl = (type, id, suffix = '') => `/${DOC_SLUGS[type] || type}${id ? `/${id}` : ''}${suffix}`;

export const DOC_UI = {
  quote: { label: 'Quote', plural: 'Quotes', numberLabel: 'Quote#', dueLabel: 'Expiry Date', contact: 'customer', statuses: ['draft', 'sent', 'accepted', 'declined', 'invoiced', 'expired'] },
  salesorder: { label: 'Sales Order', plural: 'Sales Orders', numberLabel: 'Sales Order#', dueLabel: 'Expected Shipment Date', contact: 'customer', statuses: ['draft', 'pending_approval', 'open', 'invoiced', 'closed', 'void'] },
  invoice: { label: 'Invoice', plural: 'Invoices', numberLabel: 'Invoice#', dueLabel: 'Due Date', contact: 'customer', statuses: ['draft', 'pending_approval', 'unpaid', 'sent', 'overdue', 'partially_paid', 'paid', 'void'], terms: true },
  retainer: { label: 'Retainer Invoice', plural: 'Retainer Invoices', numberLabel: 'Retainer Invoice#', dueLabel: 'Due Date', contact: 'customer', statuses: ['draft', 'open', 'paid', 'void'], noItems: true },
  creditnote: { label: 'Credit Note', plural: 'Credit Notes', numberLabel: 'Credit Note#', dueLabel: null, contact: 'customer', statuses: ['draft', 'pending_approval', 'open', 'closed', 'void'] },
  deliverychallan: { label: 'Delivery Challan', plural: 'Delivery Challans', numberLabel: 'Challan#', dueLabel: null, contact: 'customer', statuses: ['draft', 'open', 'delivered', 'invoiced', 'returned'], challanType: true },
  salesreceipt: { label: 'Sales Receipt', plural: 'Sales Receipts', numberLabel: 'Sales Receipt#', dueLabel: null, contact: 'customer', statuses: ['paid'], receipt: true },
  recurring_invoice: { label: 'Recurring Invoice', plural: 'Recurring Invoices', numberLabel: 'Profile Name', dueLabel: null, contact: 'customer', statuses: ['active', 'paused', 'stopped', 'expired'], profile: true, terms: true },
  purchaseorder: { label: 'Purchase Order', plural: 'Purchase Orders', numberLabel: 'Purchase Order#', dueLabel: 'Expected Delivery Date', contact: 'vendor', statuses: ['draft', 'pending_approval', 'open', 'billed', 'closed', 'cancelled'] },
  bill: { label: 'Bill', plural: 'Bills', numberLabel: 'Bill#', dueLabel: 'Due Date', contact: 'vendor', statuses: ['draft', 'pending_approval', 'open', 'overdue', 'partially_paid', 'paid', 'void'], terms: true, accounts: true },
  vendorcredit: { label: 'Vendor Credit', plural: 'Vendor Credits', numberLabel: 'Credit Note#', dueLabel: null, contact: 'vendor', statuses: ['draft', 'open', 'closed', 'void'], accounts: true },
  recurring_bill: { label: 'Recurring Bill', plural: 'Recurring Bills', numberLabel: 'Profile Name', dueLabel: null, contact: 'vendor', statuses: ['active', 'paused', 'stopped', 'expired'], profile: true, terms: true, accounts: true },
};
export const isSales = (t) => DOC_UI[t]?.contact === 'customer';
