# Error taxonomy

Server codes: `pospire/pospire/api/offline.py` (`ERROR_*`, `_HTTP_STATUS_BY_CODE`).
Client mapping: `classifySendError` in `frontend/src/offline/sync.ts`.

| error_category | HTTP | Client action | Usual root causes | First checks |
|---|---|---|---|---|
| `network_error` | — | retry | device offline, DNS/proxy, server down | beacon `online`, connectivity events, web/nginx logs |
| `timeout` | — | retry | slow submit (large invoice, locks), worker overload | `frappe.log` / slow query in `database.log`, lock waits |
| `server_5xx` | 5xx | retry → `retry_exhausted` after 8 | unhandled exception in endpoint or ERPNext hook | Error Log traceback near `last_attempt_at` |
| `retry_exhausted` | — | needs_review | persistent 5xx / network for 8 attempts | look at the **underlying** error in Error Log, not this label |
| `validation_error` | 400 | needs_review | missing `posting_date` / `owner_user`, Guest owner, bad UUID, ERPNext validation (mandatory field, price list, tax template) | `error_detail`, payload fields; dry-run replay |
| `permission_error` | 401 / 403 | needs_review | session expired mid-drain (401), cashier lacks role / user permission on profile, company, warehouse | user roles, User Permission rows, `owner_user` |
| `customer_missing` | 404 | needs_review | customer created offline never synced / was voided; renamed / merged customer | parent customer's offline_id in reviews; `Customer.pos_offline_id` |
| `parent_not_ready` | 409 | **park** | parent (customer, opening shift, material receipt) not yet on server | parent offline_id status on device + server |
| `siblings_not_ready` | 409 | **park** | closing shift waiting for its invoices | `get_shift_invoice_offline_ids`, which invoices are missing |
| `stock_shortage` | 409 | needs_review | `NegativeStockError`: stock sold offline beyond Bin qty; stock moved/reconciled meanwhile; snapshot flag disallows negative stock | Bin / Stock Ledger at posting time, opening-shift flag snapshot |
| `batch_or_serial_conflict` | 409 | needs_review | expired batch, serial already sold / missing | Batch expiry, Serial No status |
| `accounting_period_closed` | 417 | needs_review | late replay into closed Accounting Period (P-11) | Accounting Period rows covering `posting_date` |
| `schema_mismatch` | 426 | needs_review | old client build (service worker) vs. new server payload contract | `client_build_hash` / `sw_build_hash` vs server; `schema_version` |
| `idempotent_duplicate` | — | synced if doc name known | retry after a submit that actually succeeded | document by `pos_offline_id`; confirm exactly one |

Outbox `blocked_reason` values: `waiting_for_parent`, `waiting_for_siblings`,
`integrity_mismatch` (encrypted envelope hash mismatch — local storage
corruption or key rotation issue, see `offline/crypto.ts`, `rotation.ts`),
`schema_mismatch`.

Caveats:
- Before this branch, `recovery._classify_replay_exception` labelled every
  replay failure (stock, period, batch) as `validation_error`. Older Sync
  Review rows may carry that wrong label — read `error_detail` / activity.
- A 417 with no `error_code` is assumed `accounting_period_closed` by the
  client — and **every** raw ERPNext `ValidationError` is a 417, including
  "Insufficient Stock" re-thrown by `posapp.submit_invoice`, GST validation from
  india_compliance, and mandatory-field errors. Confirm against the message
  (catalog CLS-1/CLS-2).
- `permission_error` bursts usually mean the session expired (Frappe returns
  403 for Guest, not 401) — catalog SYNC-4.
- `network_error` on a row blocked on siblings is a mislabel (CLS-4).
- `client_build_hash = "unknown"` / empty `sw_build_hash` was the norm before
  the build-hash wiring fix (SW-6) — not evidence of an old client.
