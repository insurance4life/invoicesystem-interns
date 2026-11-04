// Default email templates. Mirrors DEFAULT_TEMPLATES in backend/books/core/mailer.py, so the editor can show
// what a document sends when no custom template is saved. Keep the two in step.
export const EMAIL_DEFAULTS = {
  invoice: { subject: 'Invoice {number} from {org_name}', body: 'Dear {contact_name},\n\nThank you for your business. Your invoice {number} for {currency} {total} is due on {due_date}.\n\nView and pay online: {link}\n\nRegards,\n{org_name}' },
  quote: { subject: 'Quote {number} from {org_name}', body: 'Dear {contact_name},\n\nPlease find our quote {number} for {currency} {total}. It is valid until {due_date}.\n\nView, accept or decline: {link}\n\nRegards,\n{org_name}' },
  salesorder: { subject: 'Sales Order {number} from {org_name}', body: 'Dear {contact_name},\n\nYour sales order {number} for {currency} {total} has been confirmed.\n\n{link}\n\nRegards,\n{org_name}' },
  creditnote: { subject: 'Credit Note {number} from {org_name}', body: 'Dear {contact_name},\n\nA credit note {number} for {currency} {total} has been issued to you.\n\n{link}\n\nRegards,\n{org_name}' },
  retainer: { subject: 'Retainer Invoice {number} from {org_name}', body: 'Dear {contact_name},\n\nPlease pay the retainer {number} for {currency} {total}.\n\n{link}\n\nRegards,\n{org_name}' },
  purchaseorder: { subject: 'Purchase Order {number} from {org_name}', body: 'Dear {contact_name},\n\nPlease find our purchase order {number} for {currency} {total}.\n\n{link}\n\nRegards,\n{org_name}' },
  payment_received: { subject: 'Payment received – {number}', body: 'Dear {contact_name},\n\nWe have received your payment of {currency} {amount}. Thank you!\n\nRegards,\n{org_name}' },
  payment_made: { subject: 'Payment advice – {number}', body: 'Dear {contact_name},\n\nWe have made a payment of {currency} {amount} to you.\n\nRegards,\n{org_name}' },
  reminder: { subject: 'Payment reminder: invoice {number} is {days_overdue} days overdue', body: 'Dear {contact_name},\n\nThis is a friendly reminder that invoice {number} for {currency} {balance} was due on {due_date}.\n\nPay online: {link}\n\nRegards,\n{org_name}' },
  statement: { subject: 'Account statement from {org_name}', body: 'Dear {contact_name},\n\nPlease find your account statement attached. Your outstanding balance is {currency} {balance}.\n\nRegards,\n{org_name}' },
};

export const EMAIL_TYPE_LABELS = {
  invoice: 'Invoice', quote: 'Quote', salesorder: 'Sales order', creditnote: 'Credit note', retainer: 'Retainer invoice',
  purchaseorder: 'Purchase order', payment_received: 'Payment received', payment_made: 'Payment made', reminder: 'Payment reminder', statement: 'Statement',
};

export const EMAIL_PLACEHOLDERS = [
  ['number', 'Document or payment number'], ['contact_name', 'Customer or vendor name'], ['org_name', 'Your organization name'],
  ['total', 'Document total'], ['balance', 'Amount still due'], ['amount', 'Payment amount'], ['currency', 'Currency code'],
  ['date', 'Document date'], ['due_date', 'Due or expiry date'], ['days_overdue', 'Days past the due date'], ['link', 'Online view or pay link'],
];

export const EMAIL_SAMPLE = {
  number: 'INV-00012', contact_name: 'Acme Pvt Ltd', org_name: 'Your Company', total: '11800.00', balance: '11800.00', amount: '5000.00',
  currency: 'INR', date: '2026-10-01', due_date: '2026-10-31', days_overdue: '3', link: 'https://example.com/share/abc123',
};
