// Catalog of every report: where it appears in the Reports Center and which filters its page shows.
// date: 'range' (from/to) | 'asof' (to only) | 'day' (single date) | 'none'
export const CATEGORIES = [
  'Business Overview', 'Sales', 'Receivables', 'Payments Received', 'Payables', 'Purchases and Expenses', 'Inventory',
  'Taxes / GST', 'Accountant', 'Projects and Timesheet', 'Budgets', 'Activity',
];

const R = (key, title, cat, desc, opts = {}) => ({ key, title, cat, desc, date: 'range', ...opts });

export const REPORTS = [
  R('profit-loss', 'Profit and Loss', 'Business Overview', 'Income, cost of goods sold, expenses and net profit.', { basis: true, compare: true, chart: 'pl', renderer: 'pl' }),
  R('balance-sheet', 'Balance Sheet', 'Business Overview', 'Assets, liabilities and equity as of a date.', { date: 'asof', renderer: 'bs' }),
  R('cash-flow', 'Cash Flow Statement', 'Business Overview', 'Cash movement by operating, investing and financing activities.'),
  R('account-type-summary', 'Account Type Summary', 'Business Overview', 'Debits, credits and balances by account type.'),

  R('sales-by-customer', 'Sales by Customer', 'Sales', 'Sales and invoice count per customer.', { chart: 'bars' }),
  R('sales-by-item', 'Sales by Item', 'Sales', 'Quantity sold, amount and average price per item.'),
  R('sales-by-salesperson', 'Sales by Sales Person', 'Sales', 'Sales grouped by sales person.'),
  R('salesreceipt-details', 'Sales Receipt Details', 'Sales', 'Every sales receipt in the period.'),

  R('ar-aging-summary', 'AR Aging Summary', 'Receivables', 'Outstanding invoices by customer and age.', { date: 'asof' }),
  R('ar-aging-details', 'AR Aging Details', 'Receivables', 'Each outstanding invoice with its age.', { date: 'asof' }),
  R('customer-balances', 'Customer Balances', 'Receivables', 'Invoiced, received, balance and unused credits.', { date: 'asof' }),
  R('invoice-details', 'Invoice Details', 'Receivables', 'Every invoice with status and balance.'),
  R('quote-details', 'Quote Details', 'Receivables', 'Every quote in the period.'),
  R('salesorder-details', 'Sales Order Details', 'Receivables', 'Every sales order in the period.'),
  R('creditnote-details', 'Credit Note Details', 'Receivables', 'Every credit note with its balance.'),

  R('payments-received', 'Payment Received', 'Payments Received', 'Customer payments, also summarised by payment mode.'),
  R('time-to-get-paid', 'Time to Get Paid', 'Payments Received', 'How quickly each customer pays.'),
  R('refund-history', 'Refund History', 'Payments Received', 'Refunds of credit notes, vendor credits and payments.'),

  R('ap-aging-summary', 'AP Aging Summary', 'Payables', 'Outstanding bills by vendor and age.', { date: 'asof' }),
  R('ap-aging-details', 'AP Aging Details', 'Payables', 'Each outstanding bill with its age.', { date: 'asof' }),
  R('vendor-balances', 'Vendor Balances', 'Payables', 'Billed, paid, balance and unused credits.', { date: 'asof' }),
  R('bill-details', 'Bill Details', 'Payables', 'Every bill with status and balance.'),
  R('vendor-credit-details', 'Vendor Credit Details', 'Payables', 'Every vendor credit with its balance.'),
  R('purchaseorder-details', 'Purchase Order Details', 'Payables', 'Every purchase order in the period.'),
  R('payments-made', 'Payments Made', 'Payables', 'Vendor payments, also summarised by payment mode.'),

  R('purchases-by-vendor', 'Purchases by Vendor', 'Purchases and Expenses', 'Purchases and bill count per vendor.'),
  R('purchases-by-item', 'Purchases by Item', 'Purchases and Expenses', 'Quantity purchased and amount per item.'),
  R('expense-details', 'Expense Details', 'Purchases and Expenses', 'Every recorded expense.'),
  R('expenses-by-category', 'Expenses by Category', 'Purchases and Expenses', 'Expenses grouped by expense account.'),
  R('billable-expenses', 'Billable Expense Details', 'Purchases and Expenses', 'Billable expenses and whether they are invoiced.'),

  R('inventory-summary', 'Inventory Summary', 'Inventory', 'Opening, in, out and closing quantity per item.'),
  R('inventory-valuation', 'Inventory Valuation Summary', 'Inventory', 'Stock on hand at weighted average cost.', { date: 'asof' }),
  R('stock-aging', 'Stock Aging Summary', 'Inventory', 'Age of the stock on hand.', { date: 'asof' }),
  R('committed-stock', 'Committed Stock Details', 'Inventory', 'Quantity committed on open sales orders.', { date: 'none' }),

  R('tax-summary', 'Tax Summary', 'Taxes / GST', 'Output tax against input tax, by tax.'),
  R('gstr1', 'GSTR-1', 'Taxes / GST', 'Outward supplies: B2B, B2C, credit notes and HSN, with JSON download.', { renderer: 'gstr1' }),
  R('gstr3b', 'GSTR-3B Summary', 'Taxes / GST', 'Outward supplies and eligible input tax credit.'),
  R('hsn-summary', 'HSN Summary', 'Taxes / GST', 'Sales by HSN/SAC code and tax rate.'),
  R('tds-payable', 'TDS Payable', 'Taxes / GST', 'TDS you deducted from vendors, by section, for the TDS return.'),
  R('tds-receivable', 'TDS Receivable', 'Taxes / GST', 'TDS customers deducted from you, to match against Form 26AS.'),

  R('trial-balance', 'Trial Balance', 'Accountant', 'Net debit and credit of every account.', { date: 'asof' }),
  R('general-ledger', 'General Ledger', 'Accountant', 'Opening, transactions and closing balance per account.', { account: true }),
  R('account-transactions', 'Account Transactions', 'Accountant', 'All transactions of one account.', { account: true, requireAccount: true }),
  R('journal', 'Journal Report', 'Accountant', 'All ledger entries grouped by transaction.'),
  R('day-book', 'Day Book', 'Accountant', 'All ledger entries of a day.', { date: 'day' }),

  R('time-by-project', 'Time by Project', 'Projects and Timesheet', 'Logged, billable and unbilled hours per project.'),
  R('project-profitability', 'Project Profitability', 'Projects and Timesheet', 'Revenue against expenses and labour cost per project.'),

  R('budget-vs-actual', 'Budget vs Actuals', 'Budgets', 'Budgeted amounts compared with actuals.', { date: 'none', budget: true }),

  R('audit-trail', 'Activity Logs & Audit Trail', 'Activity', 'Who changed what, and when.'),
];

export const REPORT_MAP = Object.fromEntries(REPORTS.map((r) => [r.key, r]));
