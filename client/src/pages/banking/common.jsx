// Shared banking helpers: transaction types, source links, contact picker, account + transaction modals.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useFetch } from '../../store.jsx';
import { Modal, Button, Field, Input, Textarea, NumberInput, Select, AccountSelect, Combo } from '../../components/ui.jsx';
import { docUrl } from '../../lib/docs.js';
import { today } from '../../lib/format.js';

export const BANK_TYPES = ['bank', 'credit_card', 'cash', 'payment_clearing'];
export const BANK_TYPE_LABELS = { bank: 'Bank', credit_card: 'Credit Card', cash: 'Cash', payment_clearing: 'Payment Clearing' };

export const TXN_LABELS = {
  deposit: 'Deposit', withdrawal: 'Withdrawal', transfer_in: 'Transfer From Another Account', transfer_out: 'Transfer To Another Account',
  owner_contribution: "Owner's Contribution", owner_drawings: 'Owner Drawings', other_income: 'Other Income', expense_refund: 'Expense Refund',
  interest_income: 'Interest Income', card_payment: 'Card Payment', sales_without_invoice: 'Sales Without Invoices', deposit_from_other: 'Deposit From Other Accounts',
  expense: 'Expense', customer_payment: 'Customer Payment', vendor_payment: 'Vendor Payment', expense_other: 'Other Expense', transfer: 'Transfer',
};
/** Types offered for money coming in / going out (for statement lines and manual transactions). */
export const IN_TYPES = ['customer_payment', 'deposit', 'transfer_in', 'owner_contribution', 'interest_income', 'other_income', 'expense_refund', 'sales_without_invoice', 'deposit_from_other', 'card_payment'];
export const OUT_TYPES = ['expense', 'vendor_payment', 'withdrawal', 'transfer_out', 'owner_drawings', 'card_payment'];
export const MANUAL_IN = IN_TYPES.filter((t) => t !== 'customer_payment');
export const MANUAL_OUT = ['withdrawal', 'transfer_out', 'owner_drawings', 'card_payment'];
export const isTransfer = (t) => ['transfer', 'transfer_in', 'transfer_out', 'card_payment'].includes(t);
/** Types whose offset defaults on the server, so the account is optional. */
export const DEFAULT_OFFSET = ['owner_contribution', 'owner_drawings', 'interest_income', 'other_income', 'sales_without_invoice', 'deposit_from_other'];

export const SRC_LABELS = {
  invoice: 'Invoice', creditnote: 'Credit Note', salesreceipt: 'Sales Receipt', bill: 'Bill', vendorcredit: 'Vendor Credit', writeoff: 'Write Off',
  payment_received: 'Customer Payment', payment_made: 'Vendor Payment', refund: 'Refund', expense: 'Expense', journal: 'Journal',
  contact_opening: 'Opening Balance', item_opening: 'Opening Stock', bank_txn: 'Bank Transaction', opening_balance: 'Opening Balance',
};

export function srcUrl(type, id) {
  if (!id) return null;
  if (type === 'payment_received') return `/payments-received/${id}`;
  if (type === 'payment_made') return `/payments-made/${id}`;
  if (type === 'expense') return `/expenses/${id}`;
  if (type === 'journal') return `/accountant/journals/${id}`;
  if (['invoice', 'creditnote', 'salesreceipt', 'bill', 'vendorcredit', 'retainer'].includes(type)) return docUrl(type, id);
  return null;
}

export function SrcLink({ type, id, children }) {
  const url = srcUrl(type, id);
  const label = children || SRC_LABELS[type] || type;
  return url ? <Link to={url} onClick={(e) => e.stopPropagation()}>{label}</Link> : <span>{label}</span>;
}

export const bankFilter = (a) => BANK_TYPES.includes(a.type);

/** Contact picker (customers, vendors or both). */
export function ContactSelect({ value, onChange, type, placeholder = 'Select a contact' }) {
  const { data } = useFetch('/contacts', { per_page: 1000, type });
  const opts = useMemo(() => (data || []).map((c) => ({ value: c.id, label: c.display_name, sub: c.email || '', group: c.type === 'customer' ? 'Customers' : 'Vendors' })), [data]);
  return <Combo value={value} onChange={onChange} options={opts} placeholder={placeholder} />;
}

/** Add / edit a bank, credit card, cash or clearing account. */
export function AccountModal({ account, onClose, onSaved }) {
  const { toast, refreshMeta } = useApp();
  const [f, setF] = useState(account || { type: 'bank' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, type: f.type, code: f.code, account_number: f.account_number, bank_name: f.bank_name, ifsc: f.ifsc, currency: f.currency, description: f.description };
      const r = account?.id ? await api.put(`/banking/accounts/${account.id}`, body) : await api.post('/banking/accounts', body);
      toast(account?.id ? 'Account updated' : 'Account added');
      await refreshMeta();
      onSaved?.(r);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={account?.id ? 'Edit Account' : 'Add Bank or Credit Card'} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Field label="Account Type" required inline>
          <div className="row">
            {BANK_TYPES.map((t) => (
              <label key={t} className="checkbox"><input type="radio" name="acctype" checked={f.type === t} disabled={account?.is_system} onChange={() => set('type')(t)} /> <span>{BANK_TYPE_LABELS[t]}</span></label>
            ))}
          </div>
        </Field>
        <Field label="Account Name" required inline><Input value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Account Code" inline><Input value={f.code} onChange={set('code')} /></Field>
        {f.type !== 'cash' && <Field label={f.type === 'credit_card' ? 'Card Number' : 'Account Number'} inline><Input value={f.account_number} onChange={set('account_number')} /></Field>}
        {f.type !== 'cash' && <Field label="Bank Name" inline><Input value={f.bank_name} onChange={set('bank_name')} /></Field>}
        {f.type === 'bank' && <Field label="IFSC" inline><Input value={f.ifsc} onChange={set('ifsc')} /></Field>}
        <Field label="Currency" inline><CurrencySelect value={f.currency} onChange={set('currency')} /></Field>
        <Field label="Description" inline><Textarea value={f.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}

function CurrencySelect({ value, onChange }) {
  const { meta, currency } = useApp();
  const opts = (meta?.currencies || []).map((c) => [c.code, `${c.code}${c.name ? ` - ${c.name}` : ''}`]);
  if (!opts.length) opts.push([currency, currency]);
  return <Select value={value || currency} options={opts} onChange={(e) => onChange(e.target.value)} />;
}

/** Add / edit a manual bank transaction (deposit, withdrawal, transfer, owner contribution / drawings, ...). */
export function TransactionModal({ accountId, txn, defaultType = 'deposit', onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState(() => (txn ? {
    ...txn, to_account_id: txn.to_account_id || '', offset_account_id: txn.offset_account_id || '',
  } : { account_id: accountId, date: today(), txn_type: defaultType, amount: '' }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const dirIn = MANUAL_IN.includes(f.txn_type) && f.txn_type !== 'card_payment' ? true : MANUAL_OUT.includes(f.txn_type) && f.txn_type !== 'card_payment' ? false : f.direction === 'in';
  const transfer = isTransfer(f.txn_type);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        account_id: f.account_id, date: f.date, txn_type: f.txn_type, amount: f.amount, reference: f.reference, description: f.description, contact_id: f.contact_id || null,
        offset_account_id: transfer ? null : f.offset_account_id || null, to_account_id: transfer ? f.to_account_id || null : null,
        direction: f.txn_type === 'card_payment' ? (f.direction || 'out') : undefined,
      };
      const r = txn?.id ? await api.put(`/banking/transactions/${txn.id}`, body) : await api.post('/banking/transactions', body);
      toast(txn?.id ? 'Transaction updated' : 'Transaction recorded');
      onSaved?.(r);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const typeOpts = [
    { group: 'Money In', options: MANUAL_IN.filter((t) => t !== 'card_payment').map((t) => ({ value: t, label: TXN_LABELS[t] })) },
    { group: 'Money Out', options: MANUAL_OUT.map((t) => ({ value: t, label: TXN_LABELS[t] })) },
  ];
  return (
    <Modal title={txn?.id ? 'Edit Transaction' : 'Add Transaction'} onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Field label="Transaction Type" required inline><Select value={f.txn_type} options={typeOpts} onChange={set('txn_type')} /></Field>
        {f.txn_type === 'card_payment' && (
          <Field label="Direction" inline>
            <Select value={f.direction || 'out'} options={[['out', 'Paid from this account'], ['in', 'Received into this card']]} onChange={set('direction')} />
          </Field>
        )}
        <Field label={transfer && (f.txn_type === 'transfer_in' || (f.txn_type === 'card_payment' && f.direction === 'in')) ? 'To Account' : dirIn ? 'Deposit To' : 'Paid From'} required inline>
          <AccountSelect value={f.account_id} onChange={set('account_id')} filter={bankFilter} />
        </Field>
        {transfer
          ? <Field label={f.txn_type === 'transfer_in' || (f.txn_type === 'card_payment' && f.direction === 'in') ? 'From Account' : 'To Account'} required inline>
              <AccountSelect value={f.to_account_id} onChange={set('to_account_id')} filter={(a) => bankFilter(a) && a.id !== Number(f.account_id)} />
            </Field>
          : <Field label={dirIn ? 'From Account' : 'Expense / Offset Account'} required={!DEFAULT_OFFSET.includes(f.txn_type)} inline
              hint={DEFAULT_OFFSET.includes(f.txn_type) ? 'Leave empty to use the default account for this type' : undefined}>
              <AccountSelect value={f.offset_account_id} onChange={set('offset_account_id')} filter={(a) => a.id !== Number(f.account_id)} />
            </Field>}
        <Field label="Date" required inline><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Amount" required inline><NumberInput value={f.amount} onChange={set('amount')} /></Field>
        {!transfer && <Field label={dirIn ? 'Received From' : 'Paid To'} inline><ContactSelect value={f.contact_id} onChange={set('contact_id')} /></Field>}
        <Field label="Reference#" inline><Input value={f.reference} onChange={set('reference')} /></Field>
        <Field label="Description" inline><Textarea value={f.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}

/** Load the bank-like accounts list. */
export function useBankAccounts() {
  const r = useFetch('/banking/accounts');
  return r;
}

