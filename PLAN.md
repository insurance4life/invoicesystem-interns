# OpenBooks — a Zoho Books–style accounting app

## 1. What the investigation found

**Zoho Books (books.zoho.in)**
- Marketing site (`www.zoho.com/in/books`): static HTML plus small jQuery-era scripts (`edition.js`, `signup.js`, `drop-down-search.js`). REA's page capture showed 112 resources: 93 images, 13 scripts and 6 stylesheets.
- The app (`books.zoho.in/app`) redirects to `accounts.zoho.in/signin?servicename=ZohoBooks&serviceurl=...` before any app code loads. The signed-in single-page app was not inspected, because signing in with or creating an account was out of scope.
- Publicly documented architecture: a single-page web client talking to **REST API v3** (JSON, OAuth 2.0 via Zoho Accounts, `organization_id` on every call). Resources include `contacts`, `items`, `estimates`, `salesorders`, `invoices`, `recurringinvoices`, `creditnotes`, `customerpayments`, `purchaseorders`, `bills`, `vendorcredits`, `vendorpayments`, `expenses`, `bankaccounts`, `banktransactions`, `chartofaccounts`, `journals`, `projects`, `timeentries`, `users`, `taxes`, `currencies` and `settings`. Every transaction posts to a double-entry general ledger, and every report is derived from that ledger.
- UI pattern: a dark left navigation (Home, Items, Banking, Sales, Purchases, Time Tracking, Accountant, Reports, Documents), a list view, a detail pane with actions (Edit, Send, Record Payment, Convert, More), a document preview, and a comments/history tab.
- Feature catalogue: see the research PDF (sections 1–19). OpenBooks covers MVP and V2, plus selected V3 features.

> **Update:** the backend has since been migrated to **Django 6.1 + PostgreSQL 16** (`backend/`) with an identical API.
> The table below describes the original Node/SQLite version (since removed).

## 2. Tech stack (original version, chosen for zero-friction setup on Windows/macOS/Linux)
| Layer | Choice | Why |
|---|---|---|
| DB | SQLite via **Node 22 built-in `node:sqlite`** | No native build and no DB server; one file per install |
| API | **Node.js + Express** (ESM) | Small and familiar; REST/JSON like Zoho API v3 |
| Auth | scrypt password hashes + HMAC-signed bearer tokens | No extra deps; multi-org via `X-Org-Id` header |
| Web | **React 18 + Vite + React Router**, Recharts | Fast SPA, like Zoho's |
| Shared | `shared/calc.js` | The same tax/totals engine runs on client and server |
| PDF | Print-optimised document view (browser "Save as PDF") | No headless-browser dependency |
| Email | Outbox table, with optional SMTP via env vars | Works offline; real sending when configured |

## 3. Architecture
- `ledger` table = the single source of truth. Each posting function deletes and re-creates the lines for its source document, so edits and deletes reverse correctly.
- **Generic document engine**: quotes, sales orders, invoices, retainer invoices, credit notes, delivery challans, sales receipts, purchase orders, bills, vendor credits and recurring profiles share one `documents` and `document_lines` model, with per-type config (numbering, statuses, posting rules, conversions).
- GST: CGST and SGST for intra-state supplies, IGST for inter-state, based on place of supply vs the organisation's state. HSN/SAC is stored on items and lines.
- Inventory: stock moves with a weighted-average cost; COGS is posted on invoice.
- Multi-currency: each document has its own currency and rate; realised FX gain/loss is posted on payment.
- Roles and permissions per module; approval workflow; transaction lock date; audit trail.

## 4. Modules (build owner)
1. Core: auth, orgs, ledger, documents, payments, credits, journals, shell UI (lead)
2. Reports and dashboard (agent, Opus)
3. Banking: accounts, statement import, match/categorize, rules, transfers, reconciliation (agent, Opus)
4. Settings: org profile, users/roles, preferences/number series, currencies, payment terms, taxes, templates, custom fields, lock date, opening balances, workflow webhooks, reminders (agent, Haiku)
5. Items/inventory, price lists, adjustments, contacts detail/statements, CSV import/export (agent, Haiku)
6. Accountant: chart of accounts UI, manual/recurring/reversing journals, budgets, fixed assets (agent, Haiku)
7. Projects/timesheets/billing, documents library, customer portal + payment links (agent, Haiku)
8. End-to-end test suite + bug fixing (lead + agent)

## 5. Out of scope (these need real external accounts or services)
Live bank feeds, real payment gateways (a test-mode gateway is simulated), GSP filing and IRN e-invoicing (GSTR-1/3B JSON export is provided instead), OCR, mobile apps, and third-party integrations.
