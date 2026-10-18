# POSpire issue catalog

Known failure modes, grouped by area. Use it to generate hypotheses in step 5:
match the symptom, then confirm with the listed evidence. Each entry:
**ID** — symptom → mechanism (code) → evidence. Likelihood/severity as L/M/H.
`✔` = verified against the code when the catalog was written (Oct 2026);
others came from a code audit and should be re-confirmed before you cite them.

Paths: `O`=pospire/pospire/api/offline.py, `R`=…/recovery.py, `P`=…/posapp.py,
`INV`=…/invoice.py, `FE`=frontend/src. Line numbers drift; search by function.

---

> Security-sensitive findings (auth, permission bypass, data exposure) are
> kept out of this public repo. If `security-findings.local.md` exists next
> to this file, read it too; otherwise ask the maintainers for it.

## 1. Error classification traps (check these FIRST in any RCA)

- **CLS-1 ✔ 417 ⇒ "accounting_period_closed" by default** — review rows say period
  closed but it's open → any raw `frappe.ValidationError` is HTTP 417 and the
  client defaults 417 to that category (`FE/offline/sync.ts` classifySendError).
  → read `error_detail`; trust the message, not the label. H/H
- **CLS-2 ✔ Stock shortage hidden** — `P` submit catches `NegativeStockError` and
  re-throws plain `frappe.throw("Insufficient Stock")`, so `_reclassify_stock_error`
  misses it → lands as CLS-1. → `error_detail` contains "Insufficient Stock" /
  "has only". H/M
- **CLS-3 Batch/serial class names stale for v16** — `_BATCH_OR_SERIAL_EXC_NAMES`
  lists classes that don't exist in v16; Serial & Batch Bundle errors are generic. H/M
- **CLS-4 Sibling-wait mislabelled** — rows waiting on siblings show
  `network_error` (`sync.ts` gate calls `scheduleRetry(..., "network_error")`). H/L
- **CLS-5 404 ⇒ customer_missing** — a missing endpoint (build skew, app not
  migrated) is reported as customer missing. L/M
- **CLS-6 ✔ (fixed on branch feat/pospire-rca-observability)** — replay
  classifier stamped everything `validation_error`. Older rows keep the wrong label.
- **CLS-7 Failure Error Logs rolled back** — `frappe.log_error` inside a request
  that ends in 4xx is rolled back, so "[offline.submit_invoice] …" logs may not
  exist. **Absence of an Error Log is not evidence of absence.** H/H
- **CLS-8 Handled retry still returns 4xx** — `_throw` leaves `http_status_code`
  in `frappe.local.response`; `recovery.retry` swallows the error but the response
  keeps the status → Desk toast says failed although the row updated. H/M

## 2. Client sync engine (FE/offline/sync.ts, outbox.ts)

- **SYNC-1 Drain loop dies silently** — queue stops until reload, banner says
  online → unguarded awaits in `drainLoop` reject; `start()` no-ops because
  `running` stays true. Triggers: undecryptable row, safe mode, `markBlocked`
  "not found". → beacon `queue_depth` rising, no `sync_cycle` events, console
  error only. M/H
- **SYNC-2 Hung fetch wedges queue** — `liveFetch` has no timeout and replay
  ignores the abort signal → one row `in_flight` forever. → beacon `in_flight`>0
  constant. M/H
- **SYNC-3 Attempt burn on outage / deploy** — 8 attempts ≈ 4 min of backoff; replay
  failures don't feed the connectivity detector → bursts of `retry_exhausted`
  reviews around deploy windows. H/M
- **SYNC-4 ✔ Session expiry looks like "offline", outbox dumped to review** —
  `offline.ping` is not guest-allowed → 403 → detector goes offline; drain gets
  403 (not 401) → every row `permission_error` → handed off. → burst of OSR rows
  with the same timestamp, `permission_error`, Network 403 on ping. H/H
- **SYNC-5 Stale CSRF in long-lived tab** — `csrf_token` read once from boot (and
  cached in SW shell) → every POST 400 CSRFTokenError → needs_review
  `validation_error`. → `exc_type: CSRFTokenError` in detail. M/H
- **SYNC-6 Hidden leader tab** — first tab keeps the Web Lock; when hidden, timers
  throttle to ~1/min → visible tab barely syncs. M/M
- **SYNC-7 Closing parent deadlock** — online-sold invoices (no outbox row) merged
  into closing `parentOfflineIds` → `evaluateParents` treats missing non-shift parent
  as blocked forever → shift stuck `closed_pending_sync`. → closing row
  `blocked_reason=waiting_for_parent`. M/H
- **SYNC-8 Closing readiness slow path dead** — `evaluateClosingReadiness` reads
  `.payload` on stored rows that only have `envelope` → always "ready"; server's
  `siblings_not_ready` is the only guard. M/M
- **SYNC-9 Poison row** — one undecryptable row breaks `listByStatus` (`Promise.all`)
  → blocks handoff, vacuum, drain. L/H
- **SYNC-10 Void resurrection** — `markBlocked`/`voidEntry` get-then-put outside a
  transaction → voided row back to `enqueued`. L/M
- **SYNC-11 Clock moved backwards** — `next_attempt_at` in the "future" → rows
  invisible to `listReady`; posting_date from device clock. M/H
- **SYNC-12 Timezone** — naive device-local datetimes interpreted as site-local →
  posting date off by one around midnight. M/M
- **SYNC-13 Guest / wrong cashier** — `currentCashier()` falls back to Guest;
  server rejects `owner_user=Guest`. L/M

## 3. Client storage, crypto, connectivity, SW

- **STO-1 Safe mode sticky** — one failed health probe → `enterSafeMode`; nothing
  calls `exitSafeMode` → writes blocked until reload. M/H
- **STO-2 Key race / key loss** — two fresh tabs generate keys, last write wins;
  missing key row silently creates a new key → old rows undecryptable. L/H
- **STO-3 Rotation multi-tab** — new key only in the rotating tab's memory. L/H
- **STO-4 Shadow journal never written** — no caller passes journal entries →
  `audit-export` / POS Offline Recovery Log is always empty. H/H (disaster-only)
- **STO-5 Eviction / private mode** — no `navigator.storage.persist()`; Safari
  7-day eviction or private window loses queued sales with no warning. M/H
- **STO-6 Storage init failure invisible** — `App.vue` returns before
  beacon / log shipper start → device absent from telemetry. L/M
- **CON-1 pagehide stops connectivity, no restart on pageshow** — state frozen
  (possibly offline) after bfcache restore. M/H
- **CON-2 Kill switch fails open** — default enabled, errors keep last value;
  server endpoints don't enforce it either. M/M
- **CACHE-1 Read cache served regardless of TTL** — stale prices/stock/tax/offers
  offline. H/M
- **CACHE-2 Items in localStorage** — quota error swallowed; key not scoped by price
  list/profile. M/H
- **TAX-1 Offline tax drift** — per-account rounding, single inclusive flag, Item
  Tax Template validity ignored → cents mismatch vs server. M/M
- **SW-1 Chunk 404 after deploy** — `skipWaiting` + old cache deleted + no
  `vite:preloadError`/`router.onError` handler → white screen on route change in
  open tabs. → `client_error` "Failed to fetch dynamically imported module". H/M
- **SW-2 Login page cached as shell** — redirected responses not rejected → offline
  boot shows login. M/H
- **SW-5 sw.js is Jinja-rendered** — any `{{`/`{%` in SW source → 500. L/H
- **SW-6 ✔ (fixed on branch)** — build hash globals never set, `recordSyncOutcome`
  never called → beacon `sw_build_hash` "" and `last_sync_*` empty, review
  `client_build_hash` "unknown" on older builds. Build-skew RCA impossible for
  pre-fix data.

## 4. Server replay & recovery (O, R)

- **REP-1 ✔ Savepoint name with "/"** — `savepoint = f"posapp_submit_{doc_name}"`
  only replaces "-"; naming series like `INV/25-26/001` → SQL error on every
  offline submit. M (India)/H
- **REP-2 Draft resume race** — two tabs resume same draft → TimestampMismatch, then
  edit-after-submit; row in review though invoice is submitted. → SI docstatus=1
  with same `pos_offline_id` while OSR Pending. M/M
- **REP-3 Duplicate winner is draft; retry marks Resolved on docstatus 0.** M/H
- **REP-4 Lock wait timeout** on unique offline_id → 500. L/M
- **REP-5 Accounting-period check too strict** — ignores `disabled`,
  `closed_documents`, exempted role. H (sites using periods)/H
- **REP-6 Material Receipt backdate lost** — `set_posting_time` not set → Stock Entry
  posted today. H/H
- **REP-7 Posting time / payments dated today** — credit JEs/PEs use `today`. H/M
- **REP-9 Flags leak across rows in bulk_retry** — `pospire_offline_shift_flags`
  never cleared → row N uses row N-1's shift snapshot. M/M
- **REP-10 Mixed-mode shifts read live profile** (P-12 broken for online-opened
  shifts); offline opening snapshot taken at sync time. M/M
- **REP-11 Late invoice after closing** — replay context allows submit against a
  closed shift; closing totals exclude it → cash variance. → SI `creation` >
  closing submit. H/H
- **REP-12 Drafts ignored by strict closure**, then deleted by
  `delete_draft_invoices`. M/H
- **REP-13 edit_payload edits wrapper, not inner doc** — edits recorded but replay
  unchanged. H/H
- **REP-14 Stuck in Retrying** — status committed before work; gunicorn timeout
  leaves it; no reaper; SLA skips it. M/H
- **REP-15 bulk_retry ignores dependency order.** H/L
- **REP-16 dry_run_replay side effects** — after_commit hooks, India Compliance
  e-invoice jobs, background-submit enqueue escape the savepoint; fresh UUID makes
  previews of already-submitted entries look "ok". M/H — **never dry-run on
  production without approval.**
- **REP-17 Archival** — reported to skip Resolved rows and delete Voided rows
  (evidence of lost sales). Verify `archive_old_recovery_rows` before relying on
  old history. H/H
- **REP-18 Beacon table unbounded** (no purge job) → fleet queries slow. H/M
- **REP-19 Rows never reconciled** — OSR stays Pending after the device later syncs
  successfully, or after the shift is closed again online (an offline closing
  superseded by an online one; manager retries then fail "POS Closing Shift
  already exists"). → compare `opening_entry_ref` in the payload with submitted
  closings for that opening. M/M
- **REP-20 Original failure reason lost** — `error_detail` is overwritten by each
  retry and the handoff activity row records only the category, so the first
  error (often a CLS-1 mislabel) is gone. → combine with CLS-7; ask the device
  for its outbox `last_error_detail` if it still has the tombstone. H/M

## 5. Online sales (P, INV, FE/components/pos)

- **SAL-1 ✔ Background-submit fan-out** — with `posa_allow_submissions_in_background_job`,
  each submit enqueues **every** printed draft in the shift with **this** invoice's
  `data`/payments/credit → wrong credit JEs, duplicate submits. → RQ failed jobs,
  JEs referencing wrong SI, worker.error.log TimestampMismatch. H/H
- **SAL-2 ✔ Return overwrites original outstanding** — `-(return_gt + orig_gt)`
  via `db_set`, ignoring earlier returns; skipped entirely in background mode. →
  Payment Ledger vs `outstanding_amount`. H/H
- **SAL-4 Pricing** — customer price not preferred; NULL `valid_from` rows dropped
  (search) but used (barcode); barcode ignores `posa_uom`; batch price not UOM
  scaled; batch remaining qty mixes UOMs. M/M–H
- **SAL-5 Coupons** — one-use check ignores the coupon (blocks all coupons for that
  customer); `used` over-count race; cancel blocked when offer disabled. H/M, M/H
- **SAL-6b Loyalty** — extra Loyalty Point Entry not revoked on cancel;
  fractional redeemed points; UOM-blind offer thresholds. M/M
- **SAL-7 Delivery charges** — arbitrary charge when customer has no address;
  charge added to returns. M/M
- **SAL-8 Taxes** — orphan tax child rows (`db_insert` on unsaved parent); inclusive
  override zeroes change. (`taxes.py customSalesInvoice` is not hooked — don't blame
  it.) H/L, M/M
- **SAL-9 Payments** — missing Mode of Payment account; `process_pos_payment`
  partial commit; change-kept PE hard-codes "Cash". H/M
- **SAL-10 Customers** — duplicates (dedupe on name only); update nulls group /
  territory; disabled customers listed. H/M
- **SAL-11 Performance** — N+1 in `get_items` / `get_items_details`; stock from
  latest SLE instead of Bin; unbounded return search. H/H
## 6. Shifts, closing, approvals

- **SHF-1 Duplicate open shifts** — `create_opening_voucher` doesn't check for an
  existing open shift. → >1 Open shift per user. H/M
- **SHF-2 Opening cash total uses literal "Cash"** (closing uses
  `posa_cash_mode_of_payment`). M/M
- **SHF-3 Exact float compare on denominations** (open & close). M/L
- **SHF-4 ✔ POS Payment Entries missing from closing** — `reference_no=shift` is
  commented out in `payment_entry.py`; closing filters by it. H/H
- **SHF-5 Change not subtracted** when cash isn't in opening `balance_details`. M/H
- **SHF-6 Close blocked by one bad draft** (`submit_printed_invoices` inline); slow
  close on big shifts (per-invoice get_doc). M/M
- **APR-5 PIN email in `before_insert` (now=True)** — SMTP failure aborts save. M/M
- **APR-6 Offline approval sync is a stub** (`sync_offline_approval_requests`
  returns []). M/M

## 7. Hardware, printing, M-Pesa, dashboards

- **HW-1 Printer unreachable** — CORS preflight, mixed content (https → http LAN),
  Private Network Access, no timeout. → browser console. H/H
- **HW-2 One site-wide printer URL**; port/path normalisation; offline caches URL at
  shift open. M/M
- **PRT-3 Templates broken by sandbox switch** (no `frappe.*` in Jinja). M/H
- **PRT-4 Offline receipt shows render time, unrounded total, missing delivery
  charge.** M/M
- **MP-2 Callback rejected / company empty** when no register URL matches
  shortcode; register URL validation has no timeout; currency hardcoded KES. M/M
- **DSH-1 Cash in/out always 0** — `custom_pos_opening_shift` never set server-side. H/M
- **DSH-2 Dashboard vs closing disagree** — change not subtracted; creation vs
  posting time; grand vs net total. H/M
- **DSH-3 Slow trend report**; boot failures blank the dashboard. M/M

## 8. Platform, deploy, cross-app

- **PLT-1 Bundle missing/stale after deploy** — build outputs gitignored,
  `emptyOutDir` → 404 on `index-*.js` if `bench build --app pospire` skipped/failed;
  Node ≥24 required. H/H
- **PLT-2 ✔ Realtime dead in SPA** — `window.frappe` never defined; profile/item
  changes and approvals don't push. H/M
- **PLT-3 Cache invalidation incomplete** — no doc_events for Pricing Rule, Price
  List, Batch, Item Tax Template…; `db.set_value` bypasses; up to 30-min stale. M/M
- **PLT-4 Redis KEYS/SCAN on every master save**; broadcast storm on imports. M/M
- **PLT-5 Worker down → invoices stay Draft silently** (background mode); scheduler
  paused → approvals never expire, SLA/archive jobs don't run. M/H
- **PLT-6 Index patch never runs on fresh sites** (fixture column created after
  post_model_sync patch). H/M
- **PLT-7 Translations never loaded** (wrong endpoint, never called). H/M
- **PLT-8 frappe_mobile `"*"` doc_events** send FCM synchronously (10 s timeout) on
  every insert/submit → slow POS submit, gunicorn timeouts. M/H
- **PLT-9 india_compliance** GST validation on SI/Customer → 417s on POS submit
  (→ CLS-1 mislabel); dry-run triggers e-invoice jobs. M/M
- **PLT-10 Role allow-list in `www/pospire.py`** excludes custom cashier roles. M/M
- **PLT-11 Fixture drift** — POS Profile tab fields missing from hooks filter;
  `field_order` property setters freeze layouts across upgrades. M/M

---

## Telemetry gaps (what you will NOT find, and why)

- Beacon lacks: safe-mode, kill-switch, leader flag, scheduler crashed, storage
  persisted/quota, clock offset, blocked count.
- Swallowed client errors (`console.warn` only) in drain crash, handoff, vacuum,
  cache writes — not visible via `client_error` unless routed through
  `captureClientError`.
- Approval PIN failures/lockouts live only in Redis.
- M-Pesa callbacks keep no raw payload / source IP.
- No server record of a failed replay when the request rolls back (CLS-7).
- No correlation id on background-submit jobs.
- Closing shift doesn't store how expected amounts were computed.
