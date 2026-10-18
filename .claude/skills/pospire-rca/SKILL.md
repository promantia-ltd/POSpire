---
name: pospire-rca
description: Debug a POSpire issue and produce an evidence-backed root cause analysis (RCA). Use when a cashier, outlet, or ops reports a POSpire problem — invoice not syncing, stuck outbox / "pending" queue, entry in Offline Sync Review, shift won't close, stock shortage / batch errors on sync, duplicate or missing invoice, POS screen crash or blank page, printing / hardware failures, payment (M-Pesa) mismatch — or when a server-side error (Error Log, worker, scheduler) touches POSpire. Works against the local bench, or a production site over REST via the read-only get_rca_bundle endpoint.
---

# POSpire RCA

Goal: turn a symptom into a **root cause backed by evidence**, plus fix and
prevention. Never stop at the first error message — it is usually a symptom
of something upstream (stale build, unsynced parent, closed period, Guest
owner, etc.).

Read `reference/architecture.md` once per session if you don't already know
the client → outbox → sync → server flow. Pull the other references only
when a step needs them.

## Ground rules

- **Read-only by default.** Never call `recovery.retry`, `bulk_retry`,
  `void_entry`, `bulk_void`, `edit_payload`, `revert_to_original`, cancel /
  amend documents, or edit the DB without explicit user approval for that
  specific action. They post to the GL / stock ledger.
- `recovery.dry_run_replay` rolls back a savepoint, but still ask before
  running it on production.
- Payloads and Error Logs contain customer PII. Quote only what the RCA
  needs; don't paste whole payloads into reports.
- Production evidence bundles live outside the repo (`~/rca-bundles/`, mode
  0600) and are deleted when the RCA is done. Never commit them, and never
  write API keys / secrets to files in the repo — environment variables only.
- Separate **observed** (log line, row, field value) from **inferred**. Every
  root-cause claim cites evidence.

## Workflow

### 1. Intake
Get, or ask for, the minimum:
- **Symptom** in the user's words, and what was expected.
- **Where:** site (local `pospire.localhost` or production), outlet / POS
  Profile, cashier.
- **An identifier:** invoice name, `OSR-…` review name, offline_id,
  device_id (browser `localStorage['pospire.device_id']`), opening shift.
- **When** (approximate time window), and whether the device was offline.

If the user only has a screenshot or a vague description, start with the
fleet snapshot (step 2, `--fleet`) and narrow down from there.

### 2. Collect evidence
**Local bench** (DB must be running):
```bash
cd <bench>/sites
../env/bin/python ../apps/pospire/.claude/skills/pospire-rca/scripts/collect.py \
  --site <site> [--invoice X | --review OSR-… | --offline-id … | --device-id … | --user … | --shift …] \
  [--since "2026-10-18 09:00" --until "2026-10-18 18:00"] --out ~/rca-bundles/incident.rca.json
# fleet-wide health:
../env/bin/python …/collect.py --site <site> --fleet
```
The bundle contains: resolved documents, Sync Review rows + activity
trail, device beacons, matching Error Log rows (including client events
`POSpire Offline Event: client_error|connectivity|sync_cycle`), failed
scheduled jobs, and matching lines from `logs/*.log`.

**Production over REST (default for remote sites):** the same bundle is
served by the whitelisted `pospire.pospire.api.diagnostics.get_rca_bundle`
(read-only, rate-limited 30/min, needs `POSpire RCA Reader` or System
Manager). Credentials come from the environment — never ask the user to
paste secrets into the chat or write them to a file in the repo:
```bash
# POSPIRE_RCA_URL=https://<site>  POSPIRE_RCA_API_KEY=…  POSPIRE_RCA_API_SECRET=…
python3 apps/pospire/.claude/skills/pospire-rca/scripts/collect.py --remote --invoice X --out ~/rca-bundles/incident.rca.json
python3 …/collect.py --remote --fleet
```
If the variables are unset, tell the user to export them in their shell
(or run the command themselves with `! …`). If the site predates this
endpoint (HTTP 404 / "not whitelisted"), fall back to `/api/resource/<Doctype>`
queries from `reference/data-sources.md` with the same token, or a Frappe
MCP connector if one is attached. Setup for a new site is in
`reference/remote-access.md`.

**Client side (when the device is reachable):** ask for, or use a browser
tool to read, the DevTools console, the IndexedDB `outbox` rows
(status, `last_error_category`, `blocked_reason`, `attempt_count`), and
`localStorage['pospire.device_id']`. Rows that never reached the server
exist **only** here.

### 3. Build the timeline
Order events by time across sources: enqueue (client) → sync attempts
(beacon `last_sync_outcome`, `sync_cycle` events) → server errors (Error
Log) → handoff (review activity `handoff`) → manager actions. Note clock
skew: client `at` is device time (epoch ms); server times are site timezone.

### 4. Classify
Map the failure to the taxonomy in `reference/error-taxonomy.md`
(`error_category` / HTTP status / outbox status). The category picks the
playbook in `reference/playbooks.md`.

**Labels lie.** Before trusting `error_category`, check the classification
traps in `reference/issue-catalog.md` §1 (CLS-1…8): generic 417s become
`accounting_period_closed`, stock shortages hide behind them, session expiry
becomes `permission_error`, and failure Error Logs can be rolled back. Then
search the catalog for the symptom — it lists ~120 known failure modes by
area with the evidence that confirms each.

### 5. Test hypotheses
List 1–3 ranked hypotheses. For each, name the evidence that would confirm or
rule it out, then go and check it (query, code read, dry-run replay with
approval). Common discriminators:
- `client_build_hash` on the review / `sw_build_hash` on the beacon vs. the
  server build → build skew.
- `parent_offline_ids` resolved on the server? → dependency ordering.
- Accounting Period covering `posting_date` → period closed.
- `owner_user == "Guest"` in payload → pre-fix cashier capture bug.
- Bin `actual_qty` at posting time vs. POS Profile negative-stock flags
  snapshotted on the **opening shift** (not the live profile).
- Same `offline_id` on more than one document → idempotency break.

Cite catalog IDs (e.g. `SAL-1`, `SYNC-4`) in the report when a known
mode matches, and say whether you confirmed it in code for this incident.

Read the code path involved (`pospire/pospire/api/offline.py`,
`recovery.py`, `posapp.py`, `frontend/src/offline/sync.ts`, `outbox.ts`)
before concluding. Cite `file:line`.

### 6. Report
Use this structure (Markdown):

```
## RCA: <one-line title>
**Status:** root cause confirmed | probable (confidence %) | inconclusive
**Impact:** who/what/how many (invoices, amount, outlets, time window)

### Summary
2–4 sentences: what happened and why.

### Timeline
| Time | Source | Event |

### Root cause
The underlying defect / condition, with evidence (row names, log lines, file:line).

### Contributing factors
Why it wasn't caught or why it got worse.

### Resolution
Immediate steps for affected data (each needing approval if it writes),
and the code / config fix.

### Prevention
Tests, monitoring, guards. Link to playbook gaps found. If the RCA found a
failure mode not in `reference/issue-catalog.md`, propose adding it.

### Evidence
Bullet list of queries run and artifacts examined.
```

If the evidence is insufficient, say so and list exactly what's needed
(e.g. "IndexedDB export from device X", "worker.error.log for 14:00–15:00").

## Fixing code

If the user asks you to fix the defect: write the fix on a branch from
`version_16_dev`, follow `AGENTS.md` (minimal diff, tests in
`pospire/pospire/tests/` or `frontend/__tests__/`), and add a regression
test that reproduces the RCA scenario.
