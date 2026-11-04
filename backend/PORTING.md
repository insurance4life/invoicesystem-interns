# Porting a Node module to the Django backend (read fully first)

> Historical guide: the port is complete and the Node `server/` folder has been removed. The helper reference and the
> SQL/JS-semantics notes below still describe how the Django backend is written.

Goal: the Django backend must behave **exactly** like the Node backend in `server/src`. Same routes, same route order,
same request/response JSON shapes, same status codes, same error messages, same accounting effects. The React client and
the API test-suite in `tests/api/*.test.js` are unchanged and are the acceptance test.

## Layout
- `backend/books/core/`: framework + engines (DON'T EDIT): `db.py`, `router.py`, `util.py`, `auth.py`, `calc.py`, `jsutil.py`,
  `ledger.py`, `documents.py`, `payments.py`, `mailer.py`, `orgs.py`, `jobs.py`, `loader.py`.
- `backend/books/models.py`: ALL tables, already defined (DON'T EDIT; column names/types are identical to the SQLite schema,
  including each module's own tables). Schema changes need the lead.
- `backend/books/modules/<name>.py`: one file per Node module (`server/src/modules/<name>.js`). You own only the files in your brief.

## Module file shape
```python
from books.core.db import all, get, run, insert, update, tx, safe, parse_json, table_exists, column_names
from books.core.router import bad, not_found, forbidden, HttpError
from books.core.util import round2, today, token, num, next_number, peek_number, org_settings, save_org_settings, assert_unlocked, audit, on_event, clean_body
from books.core.auth import perm, can, MODULES, ACTIONS
from books.core.jsutil import jsnum, num_or_none, truthy, jsstr, to_fixed2, now_iso, to_int
from books.core.ledger import post, unpost, sys_account, tax_account, account_class, account_balance, balances_by_account, avg_cost, stock_on_hand, add_stock_move, clear_stock
from books.core.documents import DOC_TYPES, load_doc, save_document, doc_action, refresh_balance, display_status, tax_ctx, advance_date, doc_relations
from books.core.payments import save_payment, delete_payment, load_payment, payment_unused, available_credits
from books.core.mailer import send_email, fill_template, DEFAULT_TEMPLATES
from books.core.calc import compute_document, ACCOUNT_CLASS, INDIAN_STATES, sum_js, add_days, due_date_for

def routes(r):            # Express `export default function (r)`  (authenticated, req.user/req.org/req.perms set)
    r.get('/things', perm('sales', 'view'), list_things)     # middleware callables, then the handler
def public_routes(r): ...  # Express `publicRoutes(r)` (no auth)
def job(org, sys_req): ... # Express `job(org, sysReq)`
```
Other modules' helpers: `from books.modules.expenses import save_expense`, `from books.modules.accounts import save_journal`,
`from books.modules.documents import email_vars`, `from books.modules.contacts import load_contact`, `from books.modules.items import load_item`.

## Request / response
- Handler `def handler(req)` returns a dict/list (sent as JSON) or a Django `HttpResponse` (files, CSV). Raise `bad(...)`/`not_found(...)`/`forbidden()`/`HttpError(status, msg)`.
- `req.body` (dict; `{}` when empty), `req.query` (dict of strings, `.get()`), `req.params` (dict of strings), `req.headers`,
  `req.user` (dict id/name/email), `req.org` (orgs row dict), `req.perms`, `req.role`. In `job`, `sys_req` has the same attributes.
- Route params/query values are strings: convert with `to_int()`/`int()` where JS used `Number(...)`.
- Middleware = any callable `mw(req)` that raises to stop. `perm(module, action)` is one.

## JS → Python semantics (get these right)
- `Number(x) || 0` → `jsnum(x)`; `Number(x)` where NaN matters → `num_or_none(x)`; JS truthiness → `truthy(x)` (Python treats `[]`, `{}`, `'0'` differently).
- `x ?? y` → `x if x is not None else y`. `a || b` on strings/numbers → `a or b` is fine except for `[]`/`{}`.
- `round2` is JS-exact (half-up). Sum floats left-to-right (`sum_js`) when the JS used reduce.
- Interpolating numbers into strings (messages, details, audit text, CSV): use `jsstr(n)` so `18.0` prints as `18`, matching JS. `n.toFixed(2)` → `to_fixed2(n)`.
- `new Date().toISOString()` → `now_iso()`; `today()` is the UTC date string. Dates are 'YYYY-MM-DD' text; compare as strings like before.
- JS `Date` month arithmetic overflows (Jan 31 + 1 month = Mar 3): use `advance_date()` or replicate with `datetime.date(y, m, 1) + timedelta(days=d-1)` after normalising month/year.
- `JSON.stringify(v)` → `json.dumps(v, separators=(',', ':'), ensure_ascii=False)` (or just pass dict/list as a SQL param; `norm()` does it).
- Sorting in JS `arr.sort((a,b)=>...)` is stable; Python `sorted(key=...)` is too. Keep the same keys and directions.

## SQL: SQLite → PostgreSQL (same `?` placeholders; `%` is escaped for you)
- `LIKE` was case-insensitive in SQLite → use **`ILIKE`**. `COLLATE NOCASE` equality → `lower(a) = lower(?)`; `ORDER BY x COLLATE NOCASE` → `ORDER BY lower(x)`.
- `GROUP_CONCAT(x, ', ')` → `string_agg(x, ', ')` (cast to text if needed: `string_agg(x::text, ', ')`).
- `strftime('%Y-%m', date)` → `substr(date, 1, 7)`; `date(x, '+N days')` → compute in Python or `(x::date + N)::text`; `julianday(a) - julianday(b)` → `(a::date - b::date)` (an integer number of days).
- `IFNULL` → `COALESCE`. `MAX(a, b)` (scalar) → `GREATEST(a, b)`; `MIN(a,b)` → `LEAST`. Boolean expressions in aggregates: `SUM(x > 0)` → `SUM(CASE WHEN x > 0 THEN 1 ELSE 0 END)`.
- `INSERT OR IGNORE` / `ON CONFLICT` → `INSERT ... ON CONFLICT DO NOTHING`. `lastInsertRowid` → `insert()` returns the id.
- Every non-aggregated selected column must be grouped (grouping by a table's primary key `x.id` covers that table's columns).
- Integer division: `a / b` with two integer columns truncates in PG (SQLite too). REAL columns are double precision.
- Ties: SQLite returned rows in rowid order when ORDER BY values tied; PG doesn't. **Add `, id` (or `, x.id`) as the last ORDER BY key** wherever the JS ordering could tie, and add an ORDER BY (by id) where the JS query had none but the order is observable.
- `sqlite_master` / `PRAGMA table_info` → `table_exists(name)` / `column_names(table)` (all tables now always exist).
- `try { ... } catch {}` around SQL that "may fail if a module isn't installed": all tables exist now, so just run it. If you must swallow a DB error, use `safe(lambda: ...)` (a savepoint); never catch a raw DB error inside a transaction without it (PostgreSQL aborts the transaction).
- SUM/COUNT come back as int/float (Decimal is converted). `COALESCE(SUM(x),0)` stays the safe pattern.
- `insert(table, obj)` skips keys whose value is None (the column default applies). `update(table, id, obj)` writes None as NULL, so pass only the keys you mean to change.

## Concurrency
All API requests and jobs run under one global lock (like Node's single thread), so you don't need extra locking.
Background threads (webhook calls, SMTP) must take `books.core.router.API_LOCK` before touching the database, and call
`django.db.connection.close()` when the thread finishes.

## Testing
PostgreSQL must be running (`docker start openbooks-pg`). From the repo root `openbooks/`:
`node --test --test-concurrency=1 tests/api/<area>.test.js`. Set `TEST_SERVER_LOGS=1` to stream the Django server's stderr (tracebacks).
All tests must pass and `trialBalanced` must stay true. **Never edit the tests** (only the lead may change test harness files).
Quick import check: `cd backend && python -c "import django,os;os.environ['DJANGO_SETTINGS_MODULE']='openbooks_api.settings';django.setup();import books.modules.<name>"`.
