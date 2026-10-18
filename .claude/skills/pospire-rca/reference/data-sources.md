# Data sources — which source answers which question

Use these with `collect.py` locally, or through a Frappe MCP connector's
list / get / search document tools on production (same doctypes, filters and
fields).

| Question | Source | Key filters / fields |
|---|---|---|
| Did the transaction reach the server? | `Sales Invoice` / `Customer` / `Stock Entry` / `POS Opening Shift` / `POS Closing Shift` | `pos_offline_id = <uuid>`; `docstatus` 0=draft (resume pending), 1=submitted, 2=cancelled |
| Why is it stuck in review? | `POSpire Offline Sync Review` | `offline_id`, `status`, `error_category`, `error_detail`, `attempt_count`, `client_build_hash`, `parent_offline_ids`, child `activity` (actor, action, outcome, detail) and `edits` |
| Which device / build / queue state? | `POS Offline Beacon` | `device_id`, `beacon_at` window; `queue_depth`, `needs_review`, `handed_off`, `oldest_minutes`, `last_sync_outcome`, `sw_build_hash`, `spa_user_agent` |
| What did the client see? | `Error Log` with `method` (title) `like "POSpire Offline Event%"` | JSON message: `kind`, `device_id`, `at` (epoch ms), `route`, `build_hash`; `client_error` → `source`, `error_name`, `message`, `stack`, `component`; `connectivity` → `from`, `to`, `reason`, `rtt_ms`; `sync_cycle` → `drained`, `parked`, `moved_to_needs_review` |
| Server exception detail | `Error Log` (any title) | `creation` window, `error` traceback, `reference_doctype/name`, `trace_id` |
| Local IndexedDB corruption | `POS Offline Recovery Log` | `device_id`, `recovered_at`, `journal_blob` (encrypted — don't decode without approval) |
| Background job failures | `Scheduled Job Log` (status Failed), RQ failed jobs (`bench --site X show-pending-jobs`, RQ dashboard) | `scheduled_job_type`, `details` |
| Shift state | `POS Opening Shift`, `POS Closing Shift` | `status`, `user`, `pos_profile`, `pos_closing_shift`, offline flag snapshot fields |
| Stock at the time | `Bin`, `Stock Ledger Entry` | `item_code`, `warehouse`, `posting_date/time` ≤ invoice |
| Period closed? | `Accounting Period` | `company`, `start_date ≤ posting_date ≤ end_date` |
| Approvals | `POS Approval Request`, `POS Approval Action` | requester, status, expiry (`approval.expire_stale_requests`) |
| Kill switch | `POSpire Offline Settings` (single) | `enabled` |

## Bench log files (`<bench>/logs/`)

| File | Contains |
|---|---|
| `frappe.log` | app-level logger output, request errors |
| `web.error.log` / `web.log` | gunicorn (production) — 5xx, timeouts, worker restarts |
| `worker.error.log` / `worker.log` | RQ background jobs (emails, enqueued submits, repost) |
| `scheduler.log` | scheduler ticks / failures |
| `database.log` | slow queries / DB errors |
| `<site>/logs/` | per-site copies of the same |

Useful one-liners (local):
```bash
echo "SELECT name, status, error_category, attempt_count FROM \`tabPOSpire Offline Sync Review\` WHERE status IN ('Pending Review','In Review','Retrying') ORDER BY creation DESC LIMIT 20" | bench --site <site> mariadb
bench --site <site> execute pospire.pospire.api.offline.get_observability_summary
grep -n "<offline_id or invoice>" logs/*.log
```

## Client-only evidence

Rows still `enqueued` / `retry_pending` / parked have **no server trace** except
beacon counts. To inspect them, on the device (DevTools → Application →
IndexedDB, or console):
- `localStorage.getItem("pospire.device_id")`
- outbox table: `status`, `type`, `offline_id`, `attempt_count`,
  `last_error_category`, `blocked_reason`, `parent_offline_ids`, `enqueued_at`
- metadata key `log_shipper.pending` — client logs not yet uploaded.
