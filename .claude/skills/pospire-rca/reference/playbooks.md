# Playbooks

Each playbook: signals → checks (in order) → typical root causes → fix
direction. Catalog IDs refer to `issue-catalog.md`. Add a new section whenever an RCA uncovers a pattern not covered
here.

## 1. Invoice "not syncing" / queue stuck
Signals: beacon `queue_depth` > 0 with rising `oldest_minutes`; cashier sees
pending count.
1. Beacons for the device: is it `online`? Is `last_sync_at` advancing?
2. If online but nothing drains: another tab holds the leader lock, or the
   user paused sync (`scheduler.user_paused`). Check `sync_cycle` events —
   none at all means the scheduler isn't running on any tab.
3. If cycles run but `parked` > 0: a parent is missing → playbook 3.
4. If `last_sync_outcome = failure` repeatedly: find the server error in
   Error Log at those times.
5. Kill switch off (`POSpire Offline Settings.enabled = 0`)?
Root causes seen: drain loop died (SYNC-1), hung fetch (SYNC-2), hidden
leader tab (SYNC-6), session expired → 403 (SYNC-4), clock moved back
(SYNC-11), server 5xx in a hook, kill switch.

## 2. Entry in Offline Sync Review (needs_review / handed_off)
1. Read `error_category` + `error_detail` + activity trail.
2. Map via `error-taxonomy.md`; for `validation_error` read the actual
   ERPNext message — it is a catch-all.
3. Compare `client_build_hash` with current server build.
4. With approval, `dry_run_replay(name)` to see if it would now succeed.
5. Has the payload been edited (`payload_hash != original_payload_hash`)? Who
   edited it and why (child `edits`)?
Fix direction: data fix via manager retry/edit (approval), plus code fix if
the client produced an invalid payload.

## 3. Parent / sibling not ready (parked)
1. Get `parent_offline_ids` (review row or outbox row).
2. For each parent: on server by `pos_offline_id`? In review? Voided?
3. A voided parent orphans its children — they need void or re-parenting.
4. Closing shift: `get_shift_invoice_offline_ids(opening)` vs invoices
   actually submitted; find the missing ones on the device.

## 4. Stock shortage / batch-serial conflict on replay
1. Item, warehouse, qty from payload; Bin + Stock Ledger at
   `posting_date`/time.
2. Opening shift flag snapshot: was negative stock allowed at shift open?
3. Concurrent stock movements between sale (offline) and sync
   (reconciliation, transfers, other outlets selling the same batch).
4. Batch expiry vs posting date; serial status.
Fix direction: stock entry / reconciliation then retry (approval), or
enable the profile flag for future shifts; never bypass validation in code.

## 5. Accounting period closed
1. Accounting Period covering `posting_date` for the company.
2. Why did sync happen so late? (device offline for days, stuck queue) →
   that delay is usually the real root cause.
Fix: finance decision — reopen period or void and re-create in open period.

## 6. Duplicate or missing invoice
0. Shift uses background submission? → SAL-1 fan-out first.
1. All docs with the same `pos_offline_id` — more than one = idempotency
   break (check `_idempotent_submit`, draft/resume path).
2. Same cart, different offline_ids = client generated a new id on retry
   (UI double-submit, offline/online race in `call.ts`).
3. Missing: no doc, no review row → still on device (client-only evidence),
   or IndexedDB safe mode → POS Offline Recovery Log.

## 7. POS screen crash / blank page / button does nothing
1. Error Log `POSpire Offline Event: client_error` for the device: message,
   stack, `component`, `route`, `build_hash`.
2. Same fingerprint across many devices after a deploy → regression; map
   the stack to `frontend/src` (source maps from `bench build`).
3. Only one device → browser version (`user_agent`), storage quota,
   private mode, stale service worker (ask to hard-reload / unregister SW).
4. Uncaught promise from a failed API call → find the matching server error
   by time.

## 8. Build skew after deploy
Signals: `schema_mismatch` (426), many `validation_error` right after a
release, mixed `sw_build_hash` values in `--fleet` output.
1. `build_hashes_seen` in the fleet bundle — which devices are on old builds?
2. Did the deploy change a payload contract without backward compatibility?
Fix: force SW update / reload devices; make server accept old shape.

## 9. Shift won't close
0. Device shows `closed_pending_sync` forever → SYNC-7 (closing parent deadlock).
1. `siblings_not_ready` → playbook 3.
2. Closing payload totals vs aggregated invoices
   (`_aggregate_closing_from_invoices`); `UpdateAfterSubmitError` on Grand
   Total → docstatus stamped by client (see `_OFFLINE_PAYLOAD_RESERVED`).
3. Opening already closed by another closing (`_ensure_opening_closed`).

## 10. Printing / hardware / M-Pesa
- Printing: `frontend/src/offline/print/`, POS XML Print Designer, Hardware
  Manager settings; client errors usually swallowed — look for
  `client_error` events and ask for console output.
- M-Pesa: `pospire/pospire/api/m_pesa.py`, `Mpesa Payment Register` rows,
  C2B callback Error Logs; check callback URL registration and
  amount/reference matching.
