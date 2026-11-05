# BeyondBooks

BeyondSure's accounting app (internal code name OpenBooks: package, database and `OPENBOOKS_*` settings keep that name). A full-featured, self-hosted accounting web app modelled on **Zoho Books (India edition)**: GST-ready invoicing, purchases, banking, inventory, projects, a double-entry general ledger and 40+ reports, written from scratch.

> Built from a feature study of books.zoho.in (see `PLAN.md`) and the research document *"Zoho Books Feature Reference: Every Module and Function Explained"*.

## Quick start

Requirements: **Python 3.12+**, **Node.js 20+** (for the web client and the API test-suite) and **PostgreSQL 14+**.
The easiest way to get PostgreSQL is Docker (`docker-compose.yml` is included; it creates user/password/database `openbooks`).

```bash
npm run db               # docker compose up -d  (PostgreSQL 16 on localhost:5432)
npm run setup            # pip install -r backend/requirements.txt + client npm install
npm run migrate          # create the tables (Django migrations)
npm run seed             # optional: demo company with 6 months of data
npm run dev              # Django API on :4000 + web app on http://localhost:5173
```

Sign in with **demo@openbooks.local / demo1234** (after seeding), or click *Sign up* to create your own organization.

Production (single process via waitress; serves the built web app and runs the hourly jobs):

```bash
npm run build            # builds client/dist
npm start                # python backend/manage.py serve  ->  http://localhost:4000
```

Run the test suite (API end-to-end tests with accounting invariants; each test file gets its own throw-away PostgreSQL database):

```bash
npm test
```

`python backend/manage.py seed --reset` wipes all data and recreates the demo company.

### Environment variables (all optional)
| Variable | Default | Purpose |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `127.0.0.1`, `5432`, `openbooks`, `openbooks`, `openbooks` | PostgreSQL connection |
| `PORT`, `HOST` | 4000, 127.0.0.1 | API/web port and bind address for `serve` |
| `DATA_DIR` | `backend/data` | Uploaded files and generated secrets |
| `JWT_SECRET` | auto-generated in `DATA_DIR/.secret` | Token signing key |
| `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `DJANGO_DEBUG` | generated / `*` / off | Django settings |
| `PUBLIC_URL` | `http://localhost:5173` | Base URL used in emailed links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | – | Real email delivery (otherwise emails are kept in the outbox only). Mail is always sent from `SMTP_FROM` (or `SMTP_USER`); the organization name is the display name and its email the Reply-To. TLS certificates are verified |
| `SMTP_ALLOW_INSECURE` | off | Set to `true` to allow a relay without STARTTLS (only for a trusted local relay) |
| `OPENBOOKS_EMAIL_HOURLY_LIMIT` | 100 | Emails one organization, and separately one user across all their organizations, may send per hour |
| `OPENBOOKS_EMAIL_MAX_RECIPIENTS` | 10 | Addresses allowed in To and Cc of one email |
| `OPENBOOKS_AUTH_RATE_LIMIT` | 30 | Sign-in, sign-up, profile-password and new-organization requests per client address per minute |
| `OPENBOOKS_MAX_ORGS_PER_USER` | 10 | Organizations one account may own (be an active Admin of) |
| `OPENBOOKS_WEBHOOK_CONCURRENCY` | 16 | Workflow webhook calls in flight at once; calls beyond this are logged as skipped |
| `OPENBOOKS_ORG_STORAGE_MB` | 1024 | File storage per organization |
| `OPENBOOKS_WEBHOOK_ALLOW_PRIVATE` | off | Set to `1` to let workflow webhooks reach private/loopback addresses (tests, local integrations) |
| `OPENBOOKS_JOBS` | 1 | Set to 0 to disable the hourly jobs (recurring documents, reminders, depreciation) |

`npm run seed -- --reset` wipes the database and recreates the demo data.

## Features

**Platform:** sign up and sign in, multiple organizations per user with an org switcher, users and invitations, roles with a per-module permission matrix, light/dark theme, global search (`/`), keyboard shortcuts (Alt+N invoice, Alt+P payment, Alt+E expense, Alt+B bill, Alt+C customer, Alt+H home), audit trail and comments on every record, and a rule-based **Ask assistant** ("How many invoices are overdue?", "Create customer Nova Labs").

**Sales:** customers, quotes (accept/decline, expiry), sales orders, delivery challans, invoices (draft → sent → partially paid → paid / overdue / void, write-off, reminders, credit-limit warnings), retainer invoices (advances applied to invoices), sales receipts, recurring invoices (auto-generated, optional auto-send), payments received (multiple invoices, excess as credit, bank charges, TDS, FX gain/loss), credit notes (apply / refund), conversions (quote → SO → invoice → credit note, SO → PO), email with templates, share links, print/PDF, customer portal and test-mode online payments, payment links.

**Purchases:** vendors, expenses (itemized, mileage, billable with markup, recurring), purchase orders, bills, recurring bills, payments made, vendor credits.

**GST (India):** GSTIN validation, place of supply, automatic CGST+SGST vs IGST, HSN/SAC, tax-inclusive or exclusive pricing, tax groups, GSTR-1 / GSTR-3B / HSN summary with GSTR-1 JSON export, TDS on payments.

**Items and inventory:** goods and services, opening stock, weighted-average costing with automatic COGS, stock on hand / committed, inventory adjustments (quantity/value), price lists (markup/markdown/per item), CSV import/export.

**Banking:** bank, card and cash accounts; manual transactions and transfers; CSV statement import; match and categorize; bank rules; undeposited-funds deposits; reconciliation.

**Accountant:** chart of accounts (watchlist, sub-accounts), manual journals (draft/publish, templates, auto-reversing, recurring), budgets vs actuals, fixed assets with depreciation and disposal, base-currency revaluation, transaction locking (overall and per module), opening balances.

**Time tracking:** projects (fixed / project / task / staff hour billing), tasks, timesheets with a timer, approvals, unbilled time and expenses → invoice, profitability.

**Approvals:** optional approval workflow per document type, with a pending-approvals queue.

**Automation:** workflow rules (email / webhook / field update actions), workflow logs, incoming webhooks, automatic payment reminders.

**Reports:** dashboard (receivables, payables, cash flow, income vs expense, top expenses, bank balances, watchlist). Reports: P&L (with comparison), balance sheet, cash flow statement, trial balance, general ledger, account transactions, journal, day book, AR/AP aging, sales and purchases by customer/vendor/item, customer/vendor balances, payments, expenses by category, inventory summary/valuation, tax summary, GST returns, budget vs actual, time by project, audit trail. Accrual or cash basis, CSV export, print and drill-down.

**Documents:** a file library with folders and an inbox, plus attachments on any transaction.

## Architecture

```
backend/                       Django 6.1 project (PostgreSQL)
  openbooks_api/settings.py    database, data dir, logging
  books/models.py              the whole schema as Django models (migrations in books/migrations)
  books/core/
    router.py                  JSON API dispatcher: auth -> public -> login + org -> module routes
    db.py                      SQL helpers over Django's connection (all/get/run/insert/update/tx)
    calc.py                    tax & totals engine (Python twin of shared/calc.js)
    ledger.py                  double-entry posting (every module posts here)
    documents.py               generic engine for 12 sales/purchase document types
    payments.py                payments, credit applications, refunds
    auth.py, auth_routes.py    passwords (scrypt), signed tokens, roles/permissions, signup/login
    jobs.py, loader.py         module loader + hourly jobs
  books/modules/*.py           feature modules (routes, public routes, jobs)
  books/management/commands/   serve (waitress), seed, testdb
shared/calc.js                 tax & totals engine used by the web client for live previews
tests/api/*.test.js            end-to-end API tests (run against a throw-away PostgreSQL database)
client/src/
  components/                  UI kit, layout, document renderer, assistant
  pages/<area>/                feature screens
```

Key design points:
- **Every amount on every report comes from one `ledger` table.** Each source (an invoice, a payment, a journal...) owns its ledger lines and replaces them on every edit, so edits, voids and deletes always reverse cleanly. Postings that don't balance are rejected.
- A **single document engine** handles quotes, sales orders, invoices, retainers, credit notes, challans, sales receipts, POs, bills, vendor credits and recurring profiles, with per-type numbering, status machines, posting rules and conversions.
- Multi-currency: documents carry their own currency and rate, the ledger is kept in base currency, and realised and unrealised FX differences are posted.
- The schema is defined by Django models; cascading deletes are enforced by PostgreSQL (`DB_CASCADE`), and defaults are database defaults.
- API requests are processed one at a time (a process-wide lock, like the single-threaded original), so number series, balances and stock never race. Run one `serve` process per database.

## What's simulated vs real
These need third-party accounts, so they are simulated or exported instead: online payment gateways (a **test-mode** gateway that never accepts card data), live bank feeds (use CSV import), filing returns on the GST portal or IRN e-invoicing (GSTR JSON export is provided), OCR receipt scanning, SMS/WhatsApp, and native mobile apps.
