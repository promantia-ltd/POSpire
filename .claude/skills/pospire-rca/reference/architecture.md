# POSpire architecture (for debugging)

Paths are relative to `apps/pospire/`.

## Layers

```
Vue SPA (frontend/src, served at /pospire)
  │  every network call → utils/call.ts  (method registry: utils/call-registry.ts)
  │     read  → live fetch, falls back to Dexie read-cache when offline
  │     write → live fetch when online; when offline (and registry says
  │             offline:true) → outbox enqueue with a UUID offline_id
  ▼
IndexedDB (Dexie, offline/db.ts) — encrypted envelopes, shadow journal DB
  outbox rows: offline/outbox.ts      shifts: offline/shift-lifecycle.ts
  ▼
Sync scheduler (offline/sync.ts) — one leader tab (Web Locks), drains outbox
  in dependency order: customer / material_receipt / opening_entry →
  invoice / return / payment → closing_entry
  ▼
Server whitelisted endpoints (pospire/pospire/api/offline.py)
  submit_invoice, create_customer, create_opening_entry, create_closing_entry,
  create_material_receipt, create_return — idempotent on pos_offline_id
  ▼
ERPNext documents (Sales Invoice, Customer, Stock Entry, POS Opening/Closing
  Shift) carrying custom fields pos_offline_id, pos_device_id,
  pos_opening_shift_offline_id
```

Online-mode (non-queued) POS actions go through `pospire/pospire/api/posapp.py`,
`invoice.py`, `payment_entry.py`, etc. via the same `call()` wrapper.

## Outbox lifecycle (client)

`enqueued → in_flight → synced`
- transient failure (network, timeout, 5xx) → `retry_pending` with
  exponential backoff; after `MAX_ATTEMPTS = 8` → `needs_review`
  (`retry_exhausted`).
- dependency 409 (`parent_not_ready` / `siblings_not_ready`) → **parked**
  (`blocked_reason = waiting_for_parent | waiting_for_siblings`), does not
  consume attempts.
- non-retryable (400/403/404/417/426, stock/batch 409) → `needs_review`,
  then `recovery.handoff` uploads it to **POSpire Offline Sync Review** and
  the local row becomes a `handed_off` tombstone (never retried locally).
- `voided` / vacuumed once the server-side review resolves.

Error → category mapping lives in `classifySendError` (`offline/sync.ts`).

## Server-side recovery (pospire/pospire/api/recovery.py)

Sync Review status: `Pending Review → In Review → Retrying → Resolved | Voided`.
Manager actions: `retry`, `bulk_retry`, `edit_payload`, `revert_to_original`,
`void_entry`, `bulk_void` (all **write**), and `dry_run_replay` (savepoint,
rolled back). Activity child rows record each action (`handoff / retry /
void / note`, outcome `ok / error / info`) with a hash chain.

Scheduler jobs: `recovery.notify_sla_breaches` (daily),
`recovery.archive_old_recovery_rows` (daily_long),
`approval.expire_stale_requests` (every 5 min).

## Invariants that commonly explain bugs

- **P-5** — queued writes are attributed to the payload `owner_user`, not the
  replay session. `owner_user == "Guest"` is rejected (legacy capture bug).
- **P-11** — `posting_date` is the queued date, never "today". A replay days
  later can land in a closed accounting period.
- **P-12** — POS Profile flags (`custom_allow_negative_stock`,
  `custom_allow_add_to_stock_at_pos`, `posa_auto_stock_reconcile`) are read
  from the **opening shift snapshot**, not the live profile. Changing the
  profile mid-shift does not affect queued invoices.
- **D-22/D-23** — idempotency on `(doctype, pos_offline_id)`: draft = resume,
  submitted = success (`was_already_submitted`), cancelled = error.
- Closing shift requires all shift invoices submitted
  (`_ensure_all_invoices_submitted`) → `siblings_not_ready` until they are.
- Server build hash = sha1(`pospire.__version__`)[:12]; client build hash =
  service-worker build. Old SW + new server → payload / schema mismatch.

## Observability

- **POS Offline Beacon** — per-device health every 5 min (queue depth,
  oldest pending age, last sync outcome, SW build hash, user agent).
- **Error Log** titles `POSpire Offline Event: client_error | connectivity |
  sync_cycle` — shipped by `offline/log-shipper.ts` via `offline.log_batch`.
- **POS Offline Recovery Log** — encrypted journal export when the device's
  IndexedDB enters safe mode.
- `offline.get_observability_summary`, `recovery.get_metrics`,
  `recovery.dashboard_summary` — fleet rollups.
- Kill switch: **POSpire Offline Settings.enabled** (single doctype).
