# OpenBooks — conventions for contributors

Stack: **Django 6.1 + PostgreSQL 16** (API, `backend/`), **React 18 + Vite 5 + react-router 6 + recharts** (web client, `client/`).
The API is plain JSON over HTTP under `/api`; the client and the API test-suite (`tests/api/`) only depend on that contract.

## Backend (`backend/`)
Read `backend/PORTING.md` for the full helper reference. In short:

- `books/models.py` defines **every table** (Django models + migrations in `books/migrations`). Change the schema there, then
  `python manage.py makemigrations books && python manage.py migrate`. Keep `db_table`, column names and `db_default`s explicit;
  use `models.DB_CASCADE` for references that must cascade in the database.
- `books/core/db.py`: `all(sql, *params)`, `get`, `run`, `insert(table, obj) -> id`, `update(table, id, obj)`, `tx(fn)`, `safe(fn)`,
  `parse_json(row, cols)`. SQL uses `?` placeholders. The database uses the `C` collation (byte-order sorting, ASCII case folding).
- `books/core/router.py`: Express-style routing (`r.get('/things/:id', perm('sales', 'view'), handler)`), `bad()/not_found()/forbidden()`.
  Handlers take `req` (`req.body`, `req.query`, `req.params`, `req.user`, `req.org`, `req.perms`) and return a dict/list (JSON) or an HttpResponse.
- `books/core/util.py`: org settings, number series, transaction locks (`assert_unlocked`), `audit()` + `on_event()`.
- `books/core/ledger.py`: **all accounting goes through `post(org_id, src_type, src_id, date=, number=, contact_id=, lines=[...])`**
  (replaces earlier lines of that source, rejects unbalanced postings), plus `unpost`, `sys_account`, `tax_account`, stock helpers.
- Engines: `books/core/documents.py` (all 12 document types), `books/core/payments.py` (payments, credits, refunds), `books/core/calc.py`
  (tax/totals; must stay identical to `shared/calc.js`, which the client uses for live previews).
- A feature = `books/modules/<name>.py` with `routes(r)`, optional `public_routes(r)` and `job(org, sys_req)`; add its name to
  `MODULES` in `books/core/loader.py` (route order matters: modules load in that list's order).
- Always scope queries by `org_id = req.org['id']`, call `audit()` on create/update/delete, and `assert_unlocked()` before changing dated records.
- API requests run one at a time under `API_LOCK` (like the original single-threaded server). Background threads must take the lock
  before touching the database and close their connection when done. Run one `serve` process per database.

## Tests
`npm test` runs `tests/api/*.test.js` with Node's built-in test runner. Each file starts `manage.py serve` on a random port against a
fresh database cloned from a migrated template (`manage.py testdb`). PostgreSQL must be running. `TEST_SERVER_LOGS=1` streams server
tracebacks. After any posting, `trialBalanced(c)` must stay true.

## Client (`client/src`)
- `api.js`: `api.get(url, params)`, `api.post`, `api.put`, `api.del` (URLs without `/api`), `downloadCsv`, `parseCsv`.
- `store.jsx`: `useApp()` → `{ user, org, settings, meta, refreshMeta, toast, money, date, can, account, sysAccount, currency }`; `useFetch(url, params)`.
- `components/ui.jsx`: the UI kit (Button, Field, Input, Select, Combo, AccountSelect, TaxSelect, Modal, Table, Tabs, Card, Badge, Menu…).
- Each feature area has one routes file (e.g. `pages/banking/BankingRoutes.jsx`) mounted in `App.jsx`.
- Check it compiles: `cd client && npx vite build`.
