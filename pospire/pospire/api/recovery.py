# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""POSpire offline-sync recovery endpoints.

Server-side workflow for offline writes that the cashier-side scheduler
classified as `needs_review`. The cashier device hands off the failed
payload to a `POSpire Offline Sync Review` row here, then keeps a local
tombstone for dependency-graph integrity (parent_offline_ids,
shift_offline_id) until this row resolves.

Only `handoff` is whitelisted in this module. The Retry / Void manager
actions land in a follow-up commit — keeping handoff as a separate edit
isolates the cashier-facing change from the manager-facing one.

Permission model:
  - `handoff` is callable by any authenticated user (the cashier who
    enqueued the failing entry). The endpoint refuses to expose other
    cashiers' rows back to the caller — handoff returns the row name
    only when this caller's `frappe.session.user` matches the existing
    row's `cashier_user`.
  - Listing / reading / writing the doctype itself is gated by the
    role permissions on the doctype JSON: System Manager + Sales
    Manager only.
"""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from pospire.pospire.doctype.pospire_offline_sync_review.pospire_offline_sync_review import (
	sha256_hex,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Schema version of the offline payload contract. Bumped when the
# offline_id-keyed write protocol changes server-side. Recovery rows store
# the version stamped by the client at enqueue time; recovery.retry (in
# Phase 1d) refuses to replay if this server's expected version diverges.
SCHEMA_VERSION = 1

# Entry types accepted by handoff. Mirrors the client's `OutboxType`
# taxonomy verbatim (see frontend/src/offline/types.ts). Keeping these
# aligned avoids a translation step at handoff time and keeps the
# doctype's `entry_type` field carrying the exact name the client
# emits. Validation is strict — an unknown type is a 400, not a silent
# accept that would land in the doctype with no replay path.
VALID_ENTRY_TYPES = {
	"invoice",
	"customer",
	"material_receipt",
	"opening_entry",
	"closing_entry",
	"return",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@frappe.whitelist()
def handoff(
	offline_id: str,
	entry_type: str,
	payload: str | dict,
	error_category: str,
	error_detail: str | None = None,
	attempt_count: int = 0,
	parent_offline_ids: list | str | None = None,
	shift_offline_id: str | None = None,
	posting_date: str | None = None,
	device_id: str | None = None,
	cashier_user: str | None = None,
	client_build_hash: str | None = None,
	schema_version: int | None = None,
) -> dict[str, Any]:
	"""Cashier-side hand-off: take ownership of a failed offline entry.

	Idempotent on `offline_id`. If a row already exists for this
	offline_id, returns it without modification — the second click from
	the same client (network-error retry, page reload mid-handoff) is a
	no-op.

	Args:
	    offline_id: UUID v4 stamped on the originating queued payload.
	    entry_type: which outbox endpoint the entry was queued against.
	    payload: the full server-shaped payload as a JSON string or dict.
	        Stored as both `original_payload` (immutable) and `payload`
	        (mutable working copy) on the row.
	    error_category: stable code from the offline error taxonomy.
	    error_detail: server-supplied error message (truncated server-side).
	    attempt_count: drain attempts the scheduler made before giving up.
	    parent_offline_ids: list of offline_ids this entry depends on.
	    shift_offline_id: opening-shift offline_id this entry posts to.
	    posting_date: P-11 snapshot.
	    device_id: cashier device identifier.
	    cashier_user: the cashier who originated the entry. Defaults to
	        the calling session's user. The caller MAY set this to a
	        different user only if they have the System Manager role —
	        used by the bench-side migration patch when an admin
	        backfills rows for other users.
	    client_build_hash: client build identifier for fleet diagnostics.
	    schema_version: contract version of the queued payload.

	Returns:
	    {
	      "name": "<recovery row name>",
	      "status": "Pending Review" | ... ,
	      "was_existing": bool — true when handoff hit the idempotent path.
	    }

	Raises:
	    frappe.ValidationError on missing/invalid offline_id, entry_type,
	    or error_category. Permissions on the doctype itself are bypassed
	    for the insert (the cashier role doesn't have create permission;
	    `flags.ignore_permissions=True` is the same pattern used by
	    `offline.submit_invoice`'s draft insert) — this is safe because
	    handoff is the only path that creates rows, and the manager
	    actions on the row are gated by the doctype's role permissions
	    (System Manager / Sales Manager).
	"""
	# --- Argument coercion + validation ----------------------------------
	if not offline_id:
		frappe.throw(_("offline_id is required"), frappe.ValidationError)
	if entry_type not in VALID_ENTRY_TYPES:
		frappe.throw(
			_("Unknown entry_type {0}. Expected one of: {1}").format(
				entry_type, ", ".join(sorted(VALID_ENTRY_TYPES))
			),
			frappe.ValidationError,
		)
	if not error_category:
		frappe.throw(_("error_category is required"), frappe.ValidationError)

	# Caller authority over `cashier_user`. Default = self. Cross-user
	# stamping requires System Manager (bench migrations, ops tooling).
	requested_cashier = cashier_user or frappe.session.user
	if requested_cashier != frappe.session.user and "System Manager" not in frappe.get_roles():
		frappe.throw(
			_(
				"cashier_user override requires System Manager. Caller {0} cannot hand off on behalf of {1}."
			).format(frappe.session.user, requested_cashier),
			frappe.PermissionError,
		)

	# Canonicalise payload to a JSON string so the immutable
	# original_payload field has stable byte-content for hashing.
	if isinstance(payload, dict):
		payload_str = json.dumps(payload, separators=(",", ":"), sort_keys=True)
	elif isinstance(payload, str):
		# Trust caller-formatted JSON. We don't re-canonicalise here
		# because the cashier device computed the hash on its side and
		# we want hash equality to round-trip verbatim.
		payload_str = payload
	else:
		frappe.throw(_("payload must be a JSON string or dict"), frappe.ValidationError)

	# Identity-coherence guard: if the wrapper payload carries its own
	# `offline_id` (every offline-endpoint shape does — see
	# call-registry.ts adapters), it MUST match the kwarg. A divergence
	# means a client bug stamped a fresh idempotency key over the entry's
	# real id (the @/utils/call wrapper at call.ts:445-449 historically
	# did this for any write missing offlineIdempotencyKey). Refusing
	# here turns a silent corruption into a loud failure on the first
	# offending request, instead of letting strict-closure deadlock the
	# closing entry waiting for an invoice id that will never appear.
	wrapper_offline_id: str | None = None
	if isinstance(payload, dict):
		wrapper_offline_id = payload.get("offline_id")
	else:
		try:
			parsed = json.loads(payload_str)
		except (TypeError, ValueError):
			parsed = None
		if isinstance(parsed, dict):
			wrapper_offline_id = parsed.get("offline_id")
	if (
		wrapper_offline_id is not None
		and isinstance(wrapper_offline_id, str)
		and wrapper_offline_id != offline_id
	):
		frappe.throw(
			_(
				"Handoff identity mismatch: kwarg offline_id={0} but payload "
				"wrapper carries offline_id={1}. The recovery row's id and the "
				"entry's id must agree, otherwise manager Retry will replay "
				"under the wrong identity and the dependent closing's strict "
				"closure check (siblings_not_ready) will deadlock. Pin the "
				"client-side offline_id via offlineIdempotencyKey in @/utils/call."
			).format(offline_id, wrapper_offline_id),
			frappe.ValidationError,
		)

	parent_ids_str = _coerce_parent_ids(parent_offline_ids)

	# --- Idempotency: existing row wins ----------------------------------
	existing_name = frappe.db.exists("POSpire Offline Sync Review", {"offline_id": offline_id})
	if existing_name:
		# Refuse to leak other cashiers' rows back to the caller. The
		# cashier-side migration runs as the cashier whose user_id cookie
		# is set; admins running the bench migration patch use
		# `frappe.set_user` to impersonate, which makes this check pass.
		existing_cashier = frappe.db.get_value("POSpire Offline Sync Review", existing_name, "cashier_user")
		is_admin = "System Manager" in frappe.get_roles() or "Sales Manager" in frappe.get_roles()
		if existing_cashier != frappe.session.user and not is_admin:
			frappe.throw(
				_("Recovery entry for offline_id {0} exists but belongs to a different cashier.").format(
					offline_id
				),
				frappe.PermissionError,
			)
		row = frappe.get_doc("POSpire Offline Sync Review", existing_name)
		# We don't update the row on idempotent re-call. The original
		# error_category / error_detail are the snapshot from the FIRST
		# handoff. Subsequent retry attempts will write fresh activity
		# rows when retry runs (Phase 1d).
		return {
			"name": row.name,
			"status": row.status,
			"was_existing": True,
		}

	# --- Fresh row -------------------------------------------------------
	original_hash = sha256_hex(payload_str)

	row = frappe.get_doc(
		{
			"doctype": "POSpire Offline Sync Review",
			"offline_id": offline_id,
			"entry_type": entry_type,
			"status": "Pending Review",
			"cashier_user": requested_cashier,
			"device_id": device_id,
			"posting_date": posting_date,
			"shift_offline_id": shift_offline_id,
			"parent_offline_ids": parent_ids_str,
			"client_build_hash": client_build_hash,
			"schema_version": int(schema_version) if schema_version else SCHEMA_VERSION,
			"error_category": error_category,
			"error_detail": (error_detail or "")[:5000],
			"attempt_count": int(attempt_count or 0),
			"last_attempt_at": now_datetime(),
			"original_payload": payload_str,
			"original_payload_hash": original_hash,
			"payload": payload_str,
			"payload_hash": original_hash,
		}
	)
	row.append_activity(
		action="handoff",
		outcome="ok",
		actor=frappe.session.user,
		detail=(
			f"category={error_category} attempt_count={attempt_count} "
			f"caller={frappe.session.user} cashier={requested_cashier}"
		),
	)
	# The cashier role doesn't have create-permission on this doctype
	# (intentional — only Sales Manager / System Manager can edit), but
	# handoff IS a privileged operation we delegate to anyone. Mirror
	# the offline.submit_invoice pattern: bypass doctype perms on insert,
	# but rely on the role check above for cross-user stamping safety.
	row.flags.ignore_permissions = True
	row.insert()

	return {
		"name": row.name,
		"status": row.status,
		"was_existing": False,
	}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@frappe.whitelist()
def retry(name: str) -> dict[str, Any]:
	"""Manager-driven replay of a `Pending Review` recovery row.

	Concurrency-safe via a CAS transition `Pending Review → Retrying`
	guarded by `SELECT ... FOR UPDATE`. Two managers clicking Retry
	simultaneously: the loser sees an "already in progress" message and
	bails. The winner runs the replay synchronously (so the Desk form
	updates with the resulting status without polling) and transitions
	to `Resolved` on success or back to `Pending Review` (with
	`attempt_count` incremented and the new error stamped) on failure.

	Attribution model:
	  - Original transaction stays attributed to the cashier (replay
	    runs inside `_acting_as_user(cashier_user)` exactly like the
	    autonomous scheduler drain path).
	  - Recovery action is attributed to the manager: `reviewer_user`
	    is set on the row, and an activity row records the actor.

	Permissions: doctype JSON gates this method to System Manager /
	Sales Manager via `frappe.has_permission` — the explicit role check
	below is belt-and-braces against `flags.ignore_permissions` paths
	bypassing it. The manager MUST have submit-level access to the
	doctype, not just write.
	"""
	if not name:
		frappe.throw(_("name is required"), frappe.ValidationError)

	# Belt-and-braces role check — doctype permissions also gate read,
	# but a future code path that runs with elevated flags could bypass
	# them. Hard-fail unprivileged callers here.
	roles = set(frappe.get_roles())
	if not (roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_(
				"Only System Manager / Sales Manager users may retry recovery "
				"entries. Caller {0} has roles: {1}."
			).format(frappe.session.user, ", ".join(sorted(roles))),
			frappe.PermissionError,
		)

	manager_user = frappe.session.user

	# CAS transition guarded by row-level lock. `for_update=True` issues
	# a SELECT ... FOR UPDATE so a concurrent retry on the same row
	# blocks here until we commit (or rolls back). The lock is released
	# at end-of-request via Frappe's transaction wrapper.
	current = frappe.db.get_value(
		"POSpire Offline Sync Review",
		name,
		[
			"status",
			"cashier_user",
			"entry_type",
			"payload",
			"offline_id",
			"schema_version",
			"reviewer_user",
			"last_attempt_at",
		],
		as_dict=True,
		for_update=True,
	)
	if not current:
		frappe.throw(_("Recovery entry {0} not found").format(name), frappe.DoesNotExistError)
	# P2-25: friendlier CAS conflict messaging. When the loser of a
	# concurrent retry attempt arrives here, we know exactly who's
	# holding the row (`reviewer_user` was stamped at the start of their
	# retry) and when (`last_attempt_at`). Surface both so the manager
	# can decide whether to coordinate or wait, instead of staring at a
	# generic "another manager may have started a retry" string.
	if current.status == "Retrying":
		holder = current.get("reviewer_user") or "(unknown)"
		held_since = current.get("last_attempt_at")
		held_for_msg = ""
		if held_since:
			try:
				delta = (
					frappe.utils.get_datetime(frappe.utils.now()) - frappe.utils.get_datetime(held_since)
				).total_seconds()
				if delta < 60:
					held_for_msg = " " + _("(started {0}s ago)").format(int(delta))
				else:
					held_for_msg = " " + _("(started {0} min ago)").format(int(delta // 60))
			except Exception:
				pass
		frappe.throw(
			_(
				"Retry already in progress: {0} started a retry on this entry{1}. "
				"Wait for them to finish (the form will reload with the outcome) "
				"or coordinate before re-issuing."
			).format(holder, held_for_msg),
			frappe.ValidationError,
		)
	if current.status not in ("Pending Review", "In Review"):
		frappe.throw(
			_(
				"Cannot retry from status {0}. The row is already in a terminal "
				"state — refresh the form to see the outcome."
			).format(current.status),
			frappe.ValidationError,
		)

	# Schema-version enforcement. The recovery row stores the contract
	# version stamped by the client at enqueue time; if the server's
	# expected version has since moved on (e.g. we changed the offline
	# payload shape), replaying the queued payload as-is would land an
	# incompatible doc. Refuse early — leave the row at Pending Review
	# with `schema_mismatch` so the manager has explicit operator
	# guidance (per docs/offline/19-recovery-runbook.md §2.8).
	row_schema = cint(current.get("schema_version") or 0)
	if row_schema and row_schema != SCHEMA_VERSION:
		row = frappe.get_doc("POSpire Offline Sync Review", name)
		row.error_category = "schema_mismatch"
		row.error_detail = (
			f"Payload was queued under schema_version={row_schema}; server "
			f"expects {SCHEMA_VERSION}. Replay refused — void this entry and "
			f"have the cashier re-create the transaction under the current "
			f"client build."
		)
		row.last_attempt_at = now_datetime()
		row.append_activity(
			action="retry",
			outcome="error",
			actor=manager_user,
			detail=(f"refused: schema_version mismatch (row={row_schema}, server={SCHEMA_VERSION})"),
		)
		row.save(ignore_permissions=True)
		frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- terminal-state save must persist before returning; caller polls via separate request.
		return {
			"name": row.name,
			"status": row.status,
			"error_category": row.error_category,
			"error_detail": row.error_detail,
			"outcome": "error",
		}

	row = frappe.get_doc("POSpire Offline Sync Review", name)
	row.status = "Retrying"
	row.reviewer_user = manager_user
	row.attempt_count = (row.attempt_count or 0) + 1
	row.last_attempt_at = now_datetime()
	row.append_activity(
		action="retry",
		outcome="info",
		actor=manager_user,
		detail=f"retry started by {manager_user}",
	)
	row.save(ignore_permissions=True)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Make the Retrying transition visible to other tabs immediately (CAS-conflict messaging in this function relies on the reviewer_user/held_since being readable cross-session).

	# --- Replay -----------------------------------------------------------
	#
	# Dispatch by entry_type. Each branch impersonates the original
	# cashier via `_acting_as_user` so the resulting server doc's
	# `owner` is the cashier, not the manager. The manager's identity
	# stays on the recovery row's `reviewer_user`.
	from pospire.pospire.api import offline as offline_api

	# Parse + pre-flight checks happen INSIDE the same rollback envelope
	# as the replay itself. Without this, a malformed payload (corruption,
	# direct DB edit, or a future code path that bypasses our save guards)
	# would raise out of `json.loads` with `row.status = Retrying` already
	# committed — leaving the row wedged forever, since the manager has no
	# UI path that allows transitioning from Retrying except via this same
	# function. Wrapping it lets the bottom `except` roll back to Pending
	# Review with an audit row, the same way an actual replay failure does.
	try:
		try:
			payload_dict = json.loads(row.payload)
		except (ValueError, TypeError) as parse_err:
			# Re-raise as ValidationError so the bottom except classifies
			# it as `validation_error` and writes a clear error_detail
			# explaining the corruption. Original parse error is wrapped
			# so the activity row preserves the message.
			frappe.throw(
				_(
					"Recovery row payload is not valid JSON: {0}. The row was "
					"likely corrupted or edited outside the supported flow; "
					"void it and re-create the transaction."
				).format(str(parse_err)[:200]),
				frappe.ValidationError,
			)
		if not isinstance(payload_dict, dict):
			frappe.throw(
				_(
					"Recovery row payload parsed to {0}, expected an object. "
					"Void this row and re-create the transaction."
				).format(type(payload_dict).__name__),
				frappe.ValidationError,
			)

		# Each branch impersonates the original cashier via the offline
		# endpoint's own `_acting_as_user(owner_user)` wrapper — we restored
		# `owner_user` into the replay payload below so `_apply_payload_metadata`
		# pops it back out and threads it through. The Sales Invoice / Customer
		# / Stock Entry that lands ends up owned by the cashier, not the manager.
		device_id = row.device_id or ""
		# Defensive: a row with no device_id can't replay because every
		# offline.* endpoint requires a UUID v4 device_id. Fail loud here
		# rather than letting a placeholder fall through and produce a
		# misleading "Invalid device_id" error from the offline endpoint.
		if not device_id:
			frappe.throw(
				_(
					"Recovery row has no device_id — cannot replay. This row was "
					"likely created via a non-standard handoff path; void it and "
					"re-create the transaction."
				),
				frappe.ValidationError,
			)
		replay_args = _normalise_replay_endpoint_args(
			payload_dict,
			offline_id=current.offline_id,
			device_id=device_id,
			owner_user=current.cashier_user,
			posting_date=row.posting_date,
		)
		if current.entry_type == "invoice":
			result = offline_api.submit_invoice(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
				opening_entry_offline_id=row.shift_offline_id or replay_args.get("opening_entry_offline_id"),
				material_receipt_offline_ids=replay_args.get("material_receipt_offline_ids"),
			)
		elif current.entry_type == "customer":
			result = offline_api.create_customer(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
			)
		elif current.entry_type == "material_receipt":
			result = offline_api.create_material_receipt(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
			)
		elif current.entry_type == "opening_entry":
			result = offline_api.create_opening_entry(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
			)
		elif current.entry_type == "closing_entry":
			# Closing entry has an extra positional: opening_entry_ref.
			# Prefer the row's stashed shift_offline_id; fall back to
			# whatever the payload itself carries (legacy queued payloads
			# that pre-date the H1 ref-flexibility fix).
			result = offline_api.create_closing_entry(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
				opening_entry_ref=row.shift_offline_id
				or replay_args.get("opening_entry_ref")
				or replay_args.get("opening_entry_offline_id"),
			)
		elif current.entry_type == "return":
			# P2-26: returns now route through `offline.create_return`
			# (a thin wrapper that enforces is_return + return_against
			# before delegating to submit_invoice). Same dispatch shape
			# as invoice; the wrapper makes the return-specific flag
			# enforcement explicit at the API boundary.
			result = offline_api.create_return(
				data=replay_args["data"],
				offline_id=replay_args["offline_id"],
				device_id=replay_args["device_id"],
				opening_entry_offline_id=row.shift_offline_id or replay_args.get("opening_entry_offline_id"),
				material_receipt_offline_ids=replay_args.get("material_receipt_offline_ids"),
			)
		else:
			frappe.throw(
				_("Unknown entry_type {0} on recovery row").format(current.entry_type),
				frappe.ValidationError,
			)
	except Exception as err:
		# Replay failed. Roll the row back to Pending Review with the
		# fresh error stamped, so the manager sees the latest reason.
		# We re-fetch to defeat any in-memory state from the failed call
		# path (e.g. partially-built Sales Invoice doc lingering on
		# `frappe.local`).
		frappe.db.rollback()
		row = frappe.get_doc("POSpire Offline Sync Review", name)
		row.status = "Pending Review"
		row.error_category = _classify_replay_exception(err)
		row.error_detail = (str(err) or "")[:5000]
		row.last_attempt_at = now_datetime()
		row.append_activity(
			action="retry",
			outcome="error",
			actor=manager_user,
			detail=f"{type(err).__name__}: {str(err)[:300]}",
		)
		row.save(ignore_permissions=True)
		frappe.db.commit()
		# Don't re-raise — the manager wants to see the new error in
		# the form, not a 500. Return a structured response so the Desk
		# JS can show the right toast.
		return {
			"name": row.name,
			"status": row.status,
			"error_category": row.error_category,
			"error_detail": row.error_detail,
			"outcome": "error",
		}

	# Success — record the resolved doctype + name.
	row = frappe.get_doc("POSpire Offline Sync Review", name)
	row.status = "Resolved"
	row.resolved_doctype = _entry_type_to_doctype(current.entry_type)
	row.resolved_doc_name = (result or {}).get("name")
	row.append_activity(
		action="retry",
		outcome="ok",
		actor=manager_user,
		detail=(
			f"resolved as {row.resolved_doctype} {row.resolved_doc_name} "
			f"docstatus={(result or {}).get('docstatus')}"
		),
	)
	row.save(ignore_permissions=True)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Resolved state must be durable before returning to the manager UI; subsequent retry-poll relies on this row being readable from another session.
	return {
		"name": row.name,
		"status": row.status,
		"resolved_doctype": row.resolved_doctype,
		"resolved_doc_name": row.resolved_doc_name,
		"outcome": "ok",
	}


@frappe.whitelist()
def dashboard_summary(window_days: int = 7) -> dict[str, Any]:
	"""P2-10/11/12: aggregate stats for the manager-facing dashboard.

	One-shot read covering everything the dashboard cards / widgets
	need:

	  totals          : current state by status
	  by_category     : Pending Review entries grouped by error_category
	                    with age-bucket counts (<5m, <1h, <8h, <24h, ≥24h)
	                    and a flag for non-editable categories.
	  oldest_pending  : top-10 oldest entries currently in Pending Review.
	  by_outlet       : SLA rollup per outlet — entries x oldest age in
	                    minutes (joined to POS Offline Beacon for the
	                    cashier→outlet mapping).
	  by_cashier      : per-cashier rollup of Pending Review counts.
	  trends          : daily retry success/failure counts derived from
	                    the activity child table over the window.

	Window defaults to 7 days. Capped at 90 to bound the query cost.
	Permission: any role with read access to the doctype (System
	Manager / Sales Manager per the doctype JSON).
	"""
	# Permission gate via has_permission — doctype JSON already lists
	# the allowed roles, but this catches a subtle case where a future
	# code path bypasses the doctype permission check via flags. The
	# dashboard surfaces fleet-wide data; do NOT leak it to cashiers.
	if not frappe.has_permission("POSpire Offline Sync Review", "read"):
		frappe.throw(
			_("You do not have permission to view the recovery dashboard."),
			frappe.PermissionError,
		)

	window_days = max(1, min(90, cint(window_days) or 7))
	window_seconds = window_days * 86400

	# --- Totals by status ---------------------------------------------
	totals_rows = frappe.db.sql(
		"""
		SELECT status, COUNT(*) AS n
		FROM `tabPOSpire Offline Sync Review`
		GROUP BY status
		""",
		as_dict=True,
	)
	totals: dict[str, int] = {
		"Pending Review": 0,
		"In Review": 0,
		"Retrying": 0,
		"Resolved": 0,
		"Voided": 0,
	}
	for r in totals_rows:
		totals[r.status] = cint(r.n)
	totals_total = sum(totals.values())

	# --- Pending Review breakdown by category + age buckets -----------
	# Age buckets are fixed (5m / 1h / 8h / 24h / ≥24h) — same shape
	# the runbook §1.1 references for SLA monitoring.
	pending_rows = frappe.db.sql(
		"""
		SELECT
		    error_category,
		    name,
		    creation,
		    cashier_user,
		    TIMESTAMPDIFF(MINUTE, creation, NOW()) AS age_minutes
		FROM `tabPOSpire Offline Sync Review`
		WHERE status = 'Pending Review'
		ORDER BY creation ASC
		""",
		as_dict=True,
	)

	def _bucket(age_min: int) -> str:
		if age_min < 5:
			return "lt_5m"
		if age_min < 60:
			return "lt_1h"
		if age_min < 480:
			return "lt_8h"
		if age_min < 1440:
			return "lt_24h"
		return "gte_24h"

	by_category: dict[str, dict[str, Any]] = {}
	for r in pending_rows:
		cat = r.error_category or "(unknown)"
		bucket = _bucket(cint(r.age_minutes))
		# `editable` reflects "manager can click Edit Payload and have
		# it apply" — both gates must pass. Categories listed in
		# EDIT_POLICY but missing a CATEGORY_VALIDATORS entry are
		# policy-permitted but the API would refuse with "no structured
		# editor is registered"; reporting them as editable misleads
		# the dashboard consumer.
		entry = by_category.setdefault(
			cat,
			{
				"category": cat,
				"editable": cat in EDIT_POLICY and cat in CATEGORY_VALIDATORS,
				"total": 0,
				"buckets": {
					"lt_5m": 0,
					"lt_1h": 0,
					"lt_8h": 0,
					"lt_24h": 0,
					"gte_24h": 0,
				},
				"oldest_age_minutes": 0,
			},
		)
		entry["total"] += 1
		entry["buckets"][bucket] += 1
		entry["oldest_age_minutes"] = max(entry["oldest_age_minutes"], cint(r.age_minutes))

	# --- Oldest pending top-N ----------------------------------------
	# Already sorted ascending by creation above; top 10 is good for the
	# dashboard's "what should I look at first" widget.
	oldest_pending = [
		{
			"name": r.name,
			"category": r.error_category or "(unknown)",
			"cashier": r.cashier_user,
			"age_minutes": cint(r.age_minutes),
		}
		for r in pending_rows[:10]
	]

	# --- SLA rollup per outlet ---------------------------------------
	# Join recovery rows → latest beacon per cashier_user → outlet.
	# Single subquery for "latest beacon per device" matched on user;
	# multiple devices for one user collapse to "the most recent beacon
	# this user appears on", which is good enough for outlet attribution.
	sla_rows = frappe.db.sql(
		"""
		SELECT
		    COALESCE(NULLIF(b.outlet, ''), '(unassigned)') AS outlet,
		    COUNT(r.name) AS pending_count,
		    MAX(TIMESTAMPDIFF(MINUTE, r.creation, NOW())) AS oldest_age_minutes
		FROM `tabPOSpire Offline Sync Review` r
		LEFT JOIN (
		    SELECT b.user AS user, b.outlet AS outlet
		    FROM `tabPOS Offline Beacon` b
		    INNER JOIN (
		        SELECT user, MAX(beacon_at) AS max_at
		        FROM `tabPOS Offline Beacon`
		        WHERE user IS NOT NULL
		        GROUP BY user
		    ) latest
		    ON b.user = latest.user AND b.beacon_at = latest.max_at
		) b
		ON b.user = r.cashier_user
		WHERE r.status = 'Pending Review'
		GROUP BY outlet
		ORDER BY pending_count DESC
		""",
		as_dict=True,
	)
	by_outlet = [
		{
			"outlet": r.outlet,
			"pending_count": cint(r.pending_count),
			"oldest_age_minutes": cint(r.oldest_age_minutes or 0),
			"sla_breached": cint(r.oldest_age_minutes or 0) > 240,  # 4h SLA per runbook
		}
		for r in sla_rows
	]

	# --- Per-cashier rollup ------------------------------------------
	cashier_rows = frappe.db.sql(
		"""
		SELECT cashier_user, COUNT(*) AS n,
		       MAX(TIMESTAMPDIFF(MINUTE, creation, NOW())) AS oldest_age_minutes
		FROM `tabPOSpire Offline Sync Review`
		WHERE status = 'Pending Review'
		GROUP BY cashier_user
		ORDER BY n DESC
		LIMIT 25
		""",
		as_dict=True,
	)
	by_cashier = [
		{
			"cashier": r.cashier_user,
			"pending_count": cint(r.n),
			"oldest_age_minutes": cint(r.oldest_age_minutes or 0),
		}
		for r in cashier_rows
	]

	# --- Trends: retry success/failure per day ------------------------
	# Read off the activity child table — every retry success / failure
	# wrote a row there. Aggregate by day + outcome.
	trend_rows = frappe.db.sql(
		"""
		SELECT
		    DATE(a.at) AS day,
		    a.outcome,
		    COUNT(*) AS n
		FROM `tabPOSpire Offline Sync Review Activity` a
		WHERE a.action = 'retry'
		  AND a.at >= DATE_SUB(NOW(), INTERVAL %s DAY)
		GROUP BY day, a.outcome
		ORDER BY day ASC
		""",
		(window_days,),
		as_dict=True,
	)
	# Pivot { day: {ok, error, info} }
	trends: dict[str, dict[str, int]] = {}
	for r in trend_rows:
		day_key = str(r.day)
		bucket = trends.setdefault(day_key, {"ok": 0, "error": 0, "info": 0})
		if r.outcome in bucket:
			bucket[r.outcome] += cint(r.n)
	trend_series = [
		{
			"day": day,
			"ok": v["ok"],
			"error": v["error"],
			"info": v["info"],
		}
		for day, v in sorted(trends.items())
	]

	return {
		"window_days": window_days,
		"window_seconds": window_seconds,
		"totals": totals,
		"totals_total": totals_total,
		"by_category": list(by_category.values()),
		"oldest_pending": oldest_pending,
		"by_outlet": by_outlet,
		"by_cashier": by_cashier,
		"trends": trend_series,
		# Same intersect gate as the per-category `editable` flag above:
		# only surface categories that have BOTH a policy entry and a
		# registered validator — policy-only categories would cause the
		# API to refuse with "no structured editor".
		"editable_categories": sorted(set(EDIT_POLICY.keys()) & set(CATEGORY_VALIDATORS.keys())),
	}


@frappe.whitelist()
def bulk_retry(names: list | str) -> dict[str, Any]:
	"""P2-13: replay multiple recovery rows in one call.

	Each row is dispatched through the same `retry()` path, with its own
	CAS lock and audit trail — bulk_retry does NOT bypass any safety
	property. Per-row outcomes are collected and returned so the manager
	can see exactly which entries resolved and which still need work.

	Best-effort: a row that fails (validation, schema_mismatch, replay
	error) does NOT abort the batch; the next row is attempted. Each
	failure is captured in the per-row result + recorded server-side
	in the row's Activity log exactly as a single retry would.

	Capped at 50 entries per call to bound transaction-time + give the
	UI a reasonable progress slice. Frontend should chunk larger lists.

	Permission: same as `retry()` (System Manager / Sales Manager).
	"""
	if isinstance(names, str):
		try:
			names = json.loads(names)
		except json.JSONDecodeError:
			frappe.throw(_("names must be a JSON array string"), frappe.ValidationError)
	if not isinstance(names, list):
		frappe.throw(_("names must be a list"), frappe.ValidationError)
	if not names:
		return {"results": [], "summary": {"ok": 0, "error": 0, "total": 0}}
	# Hard cap. Without this, a manager who multi-selects "all 5000
	# pending" rows on a list view would block a worker for minutes.
	# 50 is empirically about 60-90s of replay work in mixed-category
	# data — the UI should chunk anything larger.
	if len(names) > 50:
		frappe.throw(
			_(
				"Bulk retry cap exceeded ({0} entries). Cap is 50 per call — "
				"the UI should chunk larger selections."
			).format(len(names)),
			frappe.ValidationError,
		)

	roles = set(frappe.get_roles())
	if not (roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_("Only System Manager / Sales Manager may bulk-retry."),
			frappe.PermissionError,
		)

	results = []
	ok = 0
	err = 0
	for name in names:
		try:
			# Each retry runs in its own logical transaction (the called
			# function commits internally). A crash mid-batch leaves
			# already-processed rows in their post-retry state — which
			# is exactly what we want (idempotent + auditable).
			r = retry(name)
			results.append(r)
			if r.get("outcome") == "ok":
				ok += 1
			else:
				err += 1
		except Exception as exc:
			# Per-row hard error (e.g. row not found, status precondition
			# failure). Capture and continue.
			err += 1
			results.append(
				{
					"name": name,
					"outcome": "error",
					"error_category": _classify_replay_exception(exc),
					"error_detail": str(exc)[:500],
				}
			)
	return {
		"results": results,
		"summary": {"ok": ok, "error": err, "total": len(names)},
	}


@frappe.whitelist()
def bulk_void(names: list | str, reason: str) -> dict[str, Any]:
	"""P2-14: void multiple recovery rows in one call.

	Mandatory shared `reason` — the same string lands as `reviewer_notes`
	on every row + as the `void` Activity row's detail. Per-row CAS still
	applies: any row already in a terminal state (Resolved / Voided) or
	`Retrying` is skipped with an explicit error result and DOES NOT
	abort the batch.

	Capped at 100 entries. Voids are cheap (no replay) so the cap is
	higher than bulk_retry.

	Atomicity: each row's void is its own commit. If the request crashes
	mid-batch, the rows processed so far stay voided — desirable, not a
	leak (each void already had its reason captured).

	Permission: same as `void_entry()` (System Manager / Sales Manager).
	"""
	if isinstance(names, str):
		try:
			names = json.loads(names)
		except json.JSONDecodeError:
			frappe.throw(_("names must be a JSON array string"), frappe.ValidationError)
	if not isinstance(names, list):
		frappe.throw(_("names must be a list"), frappe.ValidationError)
	if not names:
		return {"results": [], "summary": {"ok": 0, "error": 0, "total": 0}}
	if len(names) > 100:
		frappe.throw(
			_("Bulk void cap exceeded ({0} entries). Cap is 100 per call.").format(len(names)),
			frappe.ValidationError,
		)
	if not (reason or "").strip():
		frappe.throw(
			_("A shared reason is required for bulk void."),
			frappe.ValidationError,
		)

	roles = set(frappe.get_roles())
	if not (roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_("Only System Manager / Sales Manager may bulk-void."),
			frappe.PermissionError,
		)

	results = []
	ok = 0
	err = 0
	for name in names:
		try:
			r = void_entry(name, reason)
			results.append(r)
			if r.get("outcome") == "ok":
				ok += 1
			else:
				err += 1
		except Exception as exc:
			err += 1
			results.append(
				{
					"name": name,
					"outcome": "error",
					"error_detail": str(exc)[:500],
				}
			)
	return {
		"results": results,
		"summary": {"ok": ok, "error": err, "total": len(names)},
	}


@frappe.whitelist()
def lookup_resolution(
	offline_ids: list | str,
	recovery_entry_names: list | str | None = None,
) -> dict[str, dict[str, Any]]:
	"""Cashier-side vacuum lookup: report the resolution status of a
	batch of locally-tombstoned offline_ids and/or recovery row names.

	Returns a map keyed by **the cashier's local offline_id** with the
	values the client needs to upgrade a `handed_off` tombstone:

	  {
	    "<local_offline_id>": {
	      "status": "Pending Review" | "In Review" | "Retrying" | "Resolved" | "Voided",
	      "resolved_doctype": "Sales Invoice" | ...,    # only when Resolved
	      "resolved_doc_name": "ACC-SINV-2026-00123",   # only when Resolved
	      "name": "OSR-2026-00012",
	      "matched_by": "offline_id" | "recovery_entry_name",
	    },
	    ...
	  }

	The `recovery_entry_names` parameter is a parallel list to
	`offline_ids` — entry i in offline_ids maps to entry i in
	recovery_entry_names if present. This lets the client recover
	tombstones whose OSR row was created with a divergent offline_id
	(historical bug: @/utils/call clobbering args.offline_id with a
	freshly-generated key in attemptHandoff). The vacuum prefers
	offline_id match (fast path), falls back to name match, and stamps
	`matched_by` so the client can log/alert on legacy-corruption hits.

	Offline_ids/names that don't match anything are omitted from the
	response — the client treats absence as "still tombstoned, keep
	waiting" rather than escalating.

	Permission model: cashier-callable, but server filters out rows
	owned by other cashiers so a malicious caller can't enumerate the
	whole queue. System Manager / Sales Manager bypass the cashier
	filter for support purposes.
	"""

	def _coerce_str_list(value: list | str | None, field: str) -> list:
		if value is None:
			return []
		if isinstance(value, str):
			try:
				parsed = json.loads(value)
			except json.JSONDecodeError:
				frappe.throw(
					_("{0} must be a JSON array string").format(field),
					frappe.ValidationError,
				)
		else:
			parsed = value
		if not isinstance(parsed, list):
			frappe.throw(_("{0} must be a list").format(field), frappe.ValidationError)
		return parsed

	ids = _coerce_str_list(offline_ids, "offline_ids")
	names = _coerce_str_list(recovery_entry_names, "recovery_entry_names")

	if not ids and not names:
		return {}

	# Cap each list independently — same 200 cap as before, mirrored.
	if len(ids) > 200 or len(names) > 200:
		frappe.throw(
			_(
				"Vacuum batch too large (offline_ids={0}, recovery_entry_names={1}). "
				"Cap is 200 per call — split across multiple lookups."
			).format(len(ids), len(names)),
			frappe.ValidationError,
		)

	roles = set(frappe.get_roles())
	is_admin = bool(roles & {"System Manager", "Sales Manager"})
	current_user = frappe.session.user

	# Build filter that matches EITHER offline_id OR name. We use frappe.qb
	# rather than frappe.get_all because get_all can't OR two clauses on
	# different fields without falling back to query expressions.
	osr = frappe.qb.DocType("POSpire Offline Sync Review")
	q = frappe.qb.from_(osr).select(
		osr.name, osr.offline_id, osr.status, osr.resolved_doctype, osr.resolved_doc_name
	)
	id_or_name = None
	if ids:
		id_or_name = osr.offline_id.isin(ids)
	if names:
		clause = osr.name.isin(names)
		id_or_name = clause if id_or_name is None else (id_or_name | clause)
	q = q.where(id_or_name)
	if not is_admin:
		q = q.where(osr.cashier_user == current_user)
	rows = q.run(as_dict=True)

	# Build a quick lookup so we can return ONE entry per CLIENT-supplied
	# offline_id even when the server-side row's offline_id differs.
	by_offline_id = {r.offline_id: r for r in rows}
	by_name = {r.name: r for r in rows}

	out: dict[str, dict[str, Any]] = {}
	# Pair offline_ids with names by index (None if names list is shorter).
	for i, oid in enumerate(ids):
		fallback_name = names[i] if i < len(names) else None
		matched = None
		matched_by = None
		if oid in by_offline_id:
			matched = by_offline_id[oid]
			matched_by = "offline_id"
		elif fallback_name and fallback_name in by_name:
			matched = by_name[fallback_name]
			matched_by = "recovery_entry_name"
		if not matched:
			continue
		out[oid] = {
			"name": matched.name,
			"status": matched.status,
			"resolved_doctype": matched.resolved_doctype or None,
			"resolved_doc_name": matched.resolved_doc_name or None,
			"matched_by": matched_by,
		}
	return out


@frappe.whitelist()
def void_entry(name: str, reason: str) -> dict[str, Any]:
	"""Manager-driven void of a recovery row.

	Terminal action. The corresponding outbox tombstone on the cashier
	device is upgraded to `voided` by the local vacuum pass next time it
	polls server-side state. Children that depend on this offline_id will
	stay blocked forever — the manager voiding implicitly accepts that
	the dependency chain is broken.

	`reason` is required. Free-form Small Text, persisted as
	`reviewer_notes` on the row and as the void activity row's detail.
	"""
	if not name:
		frappe.throw(_("name is required"), frappe.ValidationError)
	if not (reason or "").strip():
		frappe.throw(
			_("A reason is required to void a recovery entry."),
			frappe.ValidationError,
		)

	roles = set(frappe.get_roles())
	if not (roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_("Only System Manager / Sales Manager users may void recovery entries."),
			frappe.PermissionError,
		)
	manager_user = frappe.session.user

	current_status = frappe.db.get_value("POSpire Offline Sync Review", name, "status", for_update=True)
	if not current_status:
		frappe.throw(_("Recovery entry {0} not found").format(name), frappe.DoesNotExistError)
	if current_status in ("Resolved", "Voided"):
		frappe.throw(
			_("Cannot void from terminal status {0}.").format(current_status),
			frappe.ValidationError,
		)
	# Block Retrying explicitly. Row-level `for_update` would otherwise
	# park us until the retry commits — at which point the row is
	# Resolved and the terminal-state check above fires with a confusing
	# message. Refuse upfront so the caller (bulk-void / single-void UI)
	# sees a clear "currently retrying — wait or refresh" error,
	# matching what the bulk-void contract documents and the list-view
	# dashboard claims. If a future need arises for an emergency
	# override of an in-flight retry, that should be a separate
	# whitelisted endpoint with explicit "force" semantics — not an
	# implicit branch of void_entry.
	if current_status == "Retrying":
		frappe.throw(
			_(
				"Cannot void while a retry is in-flight. Wait for the current "
				"retry to finish (Resolved or Pending Review) and re-issue the "
				"void from there. If the row appears stuck in Retrying for more "
				"than ~5 min, see runbook §3.3 — manually transition to Pending "
				"Review (System Manager only) before voiding."
			),
			frappe.ValidationError,
		)

	row = frappe.get_doc("POSpire Offline Sync Review", name)
	row.status = "Voided"
	row.reviewer_user = manager_user
	row.reviewer_notes = (reason or "").strip()[:1000]
	row.append_activity(
		action="void",
		outcome="ok",
		actor=manager_user,
		detail=f"void reason: {reason[:300]}",
	)
	row.save(ignore_permissions=True)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Voided is a terminal state; commit before returning so other tabs (and the legal-hold audit) see the row out of Pending Review.
	return {"name": row.name, "status": row.status, "outcome": "ok"}


# ---------------------------------------------------------------------------
# Phase 2-A: structured payload edits
# ---------------------------------------------------------------------------

# Per-category policy gate. Each value is the SET of roles allowed to edit
# rows in that category. Categories absent from the map are NOT editable
# (the only paths are Retry / Void). Centralised here so policy changes
# happen in one place, not scattered across editors.
#
# Notes on gating:
#   - `permission_error` and `schema_mismatch` are deliberately
#     non-editable: editing the payload doesn't move the needle (the
#     issue is server-side config / client version, not data) and we
#     don't want to encourage "fix" attempts that mask the real cause.
#     Manager voids; cashier re-creates the transaction.
#   - `accounting_period_closed` is System-Manager-only: changing
#     posting_date has accounting / audit implications that go beyond
#     a Sales Manager's normal scope.
#   - `customer_missing`, `stock_shortage`, `validation_error` allow
#     both Sales Manager and System Manager to edit — those are the
#     day-to-day ops cases.
EDIT_POLICY: dict[str, set[str]] = {
	"accounting_period_closed": {"System Manager"},
	"customer_missing": {"System Manager", "Sales Manager"},
	"stock_shortage": {"System Manager", "Sales Manager"},
	"validation_error": {"System Manager", "Sales Manager"},
	"parent_not_ready": {"System Manager", "Sales Manager"},
	"siblings_not_ready": {"System Manager", "Sales Manager"},
	"customer_missing_offline": {"System Manager", "Sales Manager"},
	"batch_or_serial_conflict": {"System Manager", "Sales Manager"},
}

# Per-category validators. Each function takes (working_payload_dict,
# patch_dict, row_doc) and returns the SET of (field_path, before, after)
# tuples to record + applies the patch in-place to working_payload_dict.
# Returns [] when no actual change was made (idempotent re-edit).
#
# Validators raise frappe.ValidationError on bad input — the calling
# endpoint catches and returns a structured error.


def _validate_accounting_period_edit(
	payload: dict[str, Any],
	patch: dict[str, Any],
	row,
) -> list[tuple[str, Any, Any]]:
	"""P2-01: posting_date change for accounting_period_closed.

	Patch shape: `{"posting_date": "YYYY-MM-DD"}`. The new date must:
	  - parse as a valid date,
	  - fall in an OPEN Accounting Period for the payload's company
	    (we re-use the same gate as the live submit path).

	If the company isn't on the payload (older queued shape), we skip
	the period check — the live submit will catch it later.
	"""
	new_date_raw = patch.get("posting_date")
	if not new_date_raw:
		frappe.throw(_("posting_date is required"), frappe.ValidationError)
	try:
		new_date = frappe.utils.getdate(new_date_raw)
	except Exception as exc:  # broad — getdate raises various
		frappe.throw(
			_("Invalid posting_date {0}: {1}").format(new_date_raw, str(exc)),
			frappe.ValidationError,
		)
	new_date_str = str(new_date)

	# Check accounting period openness via the same helper the live
	# submit_invoice path uses, so behaviour stays aligned.
	from pospire.pospire.api.offline import _check_accounting_period_open

	company = payload.get("company")
	if company:
		# Will raise ValidationError if the date is in a closed period.
		_check_accounting_period_open(new_date_str, company)

	old_date = payload.get("posting_date")
	if old_date == new_date_str:
		return []  # idempotent
	payload["posting_date"] = new_date_str
	return [("posting_date", old_date, new_date_str)]


def _validate_customer_edit(
	payload: dict[str, Any],
	patch: dict[str, Any],
	row,
) -> list[tuple[str, Any, Any]]:
	"""P2-02: customer relink for customer_missing.

	Patch shape: `{"customer": "<existing customer name>"}`. The new
	customer must exist server-side and the cashier must have access
	to it (the live submit path enforces that; we re-check here so the
	manager sees the validation error early).
	"""
	new_customer = (patch.get("customer") or "").strip()
	if not new_customer:
		frappe.throw(_("customer is required"), frappe.ValidationError)
	if not frappe.db.exists("Customer", new_customer):
		frappe.throw(
			_("Customer {0} does not exist").format(new_customer),
			frappe.ValidationError,
		)
	# Probe access as the cashier (so we catch territory-restricted access
	# at edit time, not at retry time). Use `frappe.has_permission` with
	# user=cashier so the check is evaluated under their roles.
	if not frappe.has_permission(
		doctype="Customer",
		ptype="read",
		doc=new_customer,
		user=row.cashier_user,
	):
		frappe.throw(
			_(
				"Cashier {0} does not have read access to customer {1}. The "
				"link would fail at retry time anyway — pick a customer the "
				"cashier can access, or void this entry."
			).format(row.cashier_user, new_customer),
			frappe.ValidationError,
		)

	# Drop the offline customer reference if present — once we've relinked
	# to a real Customer doc, the *_offline_id resolution path is moot and
	# leaving it can cause `_resolve_customer_by_offline_id` to override
	# our explicit relink.
	changes: list[tuple[str, Any, Any]] = []
	old_customer = payload.get("customer")
	if old_customer != new_customer:
		payload["customer"] = new_customer
		changes.append(("customer", old_customer, new_customer))
	if "customer_offline_id" in payload:
		old_offline = payload.pop("customer_offline_id")
		changes.append(("customer_offline_id", old_offline, None))
	return changes


def _validate_stock_edit(
	payload: dict[str, Any],
	patch: dict[str, Any],
	row,
) -> list[tuple[str, Any, Any]]:
	"""P2-03: warehouse / qty reassignment for stock_shortage.

	Patch shape:
	  {
	    "warehouse": "<new warehouse>",     # optional, top-level
	    "items": [                          # optional, indexed list
	      {"index": 0, "qty": 2, "warehouse": "..."},
	      ...
	    ]
	  }

	`warehouse` at the top level updates `update_stock`-relevant fields
	on the payload (`set_warehouse` / each item's warehouse).
	`items[].index` matches the position in `payload["items"]`. We
	deliberately don't allow item insertion / removal — that would
	change the cart shape beyond what a recovery edit should do.

	Stock availability is NOT re-checked here — the live submit will
	catch it. A "preview availability" probe is part of P2-09 (dry-run
	replay).
	"""
	changes: list[tuple[str, Any, Any]] = []
	new_top_warehouse = patch.get("warehouse")
	if new_top_warehouse is not None:
		new_top_warehouse = str(new_top_warehouse).strip()
		if not frappe.db.exists("Warehouse", new_top_warehouse):
			frappe.throw(
				_("Warehouse {0} does not exist").format(new_top_warehouse),
				frappe.ValidationError,
			)
		old = payload.get("set_warehouse")
		if old != new_top_warehouse:
			payload["set_warehouse"] = new_top_warehouse
			changes.append(("set_warehouse", old, new_top_warehouse))

	item_patches = patch.get("items") or []
	if not isinstance(item_patches, list):
		frappe.throw(_("items must be a list"), frappe.ValidationError)
	cart_items = payload.get("items") or []
	if not isinstance(cart_items, list):
		frappe.throw(
			_("payload.items is malformed; expected list"),
			frappe.ValidationError,
		)

	for ip in item_patches:
		if not isinstance(ip, dict):
			frappe.throw(_("each items[] entry must be an object"), frappe.ValidationError)
		idx = ip.get("index")
		if not isinstance(idx, int) or idx < 0 or idx >= len(cart_items):
			frappe.throw(
				_("items[].index {0} is out of range (cart has {1} items)").format(idx, len(cart_items)),
				frappe.ValidationError,
			)
		row_payload = cart_items[idx]
		if "qty" in ip:
			new_qty = ip["qty"]
			try:
				new_qty = float(new_qty)
			except (TypeError, ValueError):
				frappe.throw(
					_("items[{0}].qty must be a number").format(idx),
					frappe.ValidationError,
				)
			if new_qty <= 0:
				frappe.throw(
					_("items[{0}].qty must be > 0").format(idx),
					frappe.ValidationError,
				)
			old_qty = row_payload.get("qty")
			if old_qty != new_qty:
				row_payload["qty"] = new_qty
				changes.append((f"items[{idx}].qty", old_qty, new_qty))
		if "warehouse" in ip:
			new_wh = (ip["warehouse"] or "").strip()
			if not frappe.db.exists("Warehouse", new_wh):
				frappe.throw(
					_("Warehouse {0} does not exist").format(new_wh),
					frappe.ValidationError,
				)
			old_wh = row_payload.get("warehouse")
			if old_wh != new_wh:
				row_payload["warehouse"] = new_wh
				changes.append((f"items[{idx}].warehouse", old_wh, new_wh))
	return changes


def _validate_targeted_field_edit(
	payload: dict[str, Any],
	patch: dict[str, Any],
	row,
) -> list[tuple[str, Any, Any]]:
	"""P2-04: targeted single-field editor for validation_error.

	Patch shape: `{"field_path": "<top-level field name>", "value": <new value>}`.

	Constraints:
	  - `field_path` MUST be a single top-level field name. We refuse
	    nested paths in this validator because nested edits cover too
	    broad a surface for a generic editor — use a category-specific
	    validator if you need to mutate `items[i].x`.
	  - The field MUST already exist on the payload. Adding a brand-new
	    field via this path could mask a real schema problem; require
	    the field to be present so the manager is editing what was
	    queued, not extending it.
	  - Type of `value` must match the type of the existing field
	    (str/int/float/bool/None). Refuse silent type changes.
	"""
	field_path = (patch.get("field_path") or "").strip()
	if not field_path:
		frappe.throw(_("field_path is required"), frappe.ValidationError)
	if "." in field_path or "[" in field_path:
		frappe.throw(
			_(
				"Nested field_path {0} not supported by the targeted-field editor. "
				"Use a category-specific editor for nested edits, or void and "
				"re-create the transaction."
			).format(field_path),
			frappe.ValidationError,
		)
	if field_path not in payload:
		frappe.throw(
			_(
				"Field {0} is not on the queued payload. The targeted-field editor "
				"refuses to add new fields — that risks masking a real schema bug."
			).format(field_path),
			frappe.ValidationError,
		)
	old_value = payload[field_path]
	new_value = patch.get("value")
	# Type-match guard. None on either side is permissive (queued field
	# may legitimately be null; manager may legitimately null it out).
	if old_value is not None and new_value is not None and type(old_value) is not type(new_value):
		frappe.throw(
			_(
				"Type mismatch on {0}: queued value is {1}, new value is {2}. "
				"Refusing silent type change — pass the same type as the queued "
				"field."
			).format(
				field_path,
				type(old_value).__name__,
				type(new_value).__name__,
			),
			frappe.ValidationError,
		)
	if old_value == new_value:
		return []
	payload[field_path] = new_value
	return [(field_path, old_value, new_value)]


# Map error_category → validator. Categories absent from this map have
# no editor — even when listed in EDIT_POLICY, the endpoint refuses
# because there's nothing to apply.
#
# `customer_missing` and `customer_missing_offline` both map to the
# SAME validator (_validate_customer_edit) intentionally. They are two
# variants of the same problem — a customer reference that the server
# can't resolve — and the fix is identical in both cases: relink to a
# real Customer doc and drop the offline_id link. Keeping them as
# distinct categories preserves the reason the entry was queued (which
# the dashboard breakdown surfaces) without forcing two separate edit
# UIs. This is documented so the dashboard's `editable_categories`
# correctly enumerating BOTH names is intentional, not a leak.
CATEGORY_VALIDATORS = {
	"accounting_period_closed": _validate_accounting_period_edit,
	"customer_missing": _validate_customer_edit,
	"customer_missing_offline": _validate_customer_edit,  # shared with above
	"stock_shortage": _validate_stock_edit,
	"validation_error": _validate_targeted_field_edit,
	# parent_not_ready / siblings_not_ready / batch_or_serial_conflict
	# are policy-allowed but don't have a structured editor yet — the
	# endpoint will return a clear "not editable" error. They're listed
	# in EDIT_POLICY so the future PR adding their editors only needs
	# to register here.
}


@frappe.whitelist()
def edit_payload(
	name: str,
	patch: dict | str,
	reason: str,
) -> dict[str, Any]:
	"""Manager-driven structured edit of a recovery row's working payload.

	Per-category policy + validation:
	  - Caller's role must include one of the roles in
	    EDIT_POLICY[error_category]. Categories absent from EDIT_POLICY
	    are non-editable.
	  - Edit only allowed when status ∈ {Pending Review, In Review}.
	    Refuses on Retrying / Resolved / Voided.
	  - The category-specific validator receives the patch + working
	    payload + row, validates, applies in-place, and returns a list
	    of (field_path, before, after) tuples.

	Side effects:
	  - `payload` is rewritten with the canonicalised post-edit JSON.
	    `payload_hash` is recomputed (the validate() hook does this).
	  - `original_payload` and `original_payload_hash` are NEVER touched.
	  - Each (field_path, before, after) becomes one Edit child row.
	  - One activity row per call summarising what changed.
	  - `status` flips Pending Review → In Review (signals the row is
	    being worked on). Manager retries from In Review when ready.

	Idempotent: a no-op patch (validator returns []) is permitted and
	logged as an info activity row; no edit children are written.
	"""
	if not name:
		frappe.throw(_("name is required"), frappe.ValidationError)
	if not (reason or "").strip():
		frappe.throw(
			_("A reason is required for every edit (audit requirement)."),
			frappe.ValidationError,
		)
	patch_dict = json.loads(patch) if isinstance(patch, str) else patch
	if not isinstance(patch_dict, dict):
		frappe.throw(_("patch must be a JSON object"), frappe.ValidationError)

	# Read + lock the row.
	current = frappe.db.get_value(
		"POSpire Offline Sync Review",
		name,
		["status", "error_category", "payload"],
		as_dict=True,
		for_update=True,
	)
	if not current:
		frappe.throw(_("Recovery entry {0} not found").format(name), frappe.DoesNotExistError)
	if current.status not in ("Pending Review", "In Review"):
		frappe.throw(
			_(
				"Cannot edit from status {0}. Only Pending Review / In Review rows accept payload edits."
			).format(current.status),
			frappe.ValidationError,
		)

	# Policy gate.
	allowed_roles = EDIT_POLICY.get(current.error_category or "", set())
	if not allowed_roles:
		frappe.throw(
			_(
				"Category {0} is not editable from the recovery form. The only "
				"valid actions are Retry (after the underlying issue is fixed "
				"elsewhere) or Void."
			).format(current.error_category or "unknown"),
			frappe.ValidationError,
		)
	caller_roles = set(frappe.get_roles())
	if not (caller_roles & allowed_roles):
		frappe.throw(
			_("Your role does not allow editing {0} entries. Required: any of {1}. Caller has: {2}.").format(
				current.error_category,
				", ".join(sorted(allowed_roles)),
				", ".join(sorted(caller_roles)) or "(none)",
			),
			frappe.PermissionError,
		)

	validator = CATEGORY_VALIDATORS.get(current.error_category)
	if validator is None:
		# Listed in EDIT_POLICY but no validator yet — fail explicit so
		# we don't silently accept patches we can't apply.
		frappe.throw(
			_(
				"Category {0} is policy-permitted to edit but no structured "
				"editor is registered. Track this in the recovery follow-up "
				"backlog."
			).format(current.error_category),
			frappe.ValidationError,
		)

	# Apply.
	row = frappe.get_doc("POSpire Offline Sync Review", name)
	working = json.loads(row.payload) if row.payload else {}
	if not isinstance(working, dict):
		frappe.throw(
			_(
				"Working payload is not a JSON object (got {0}); cannot apply "
				"structured edit. Void this entry."
			).format(type(working).__name__),
			frappe.ValidationError,
		)
	changes = validator(working, patch_dict, row)

	# Re-serialise with the same canonicalisation as handoff so the hash
	# regenerates predictably.
	row.payload = json.dumps(working, separators=(",", ":"), sort_keys=True)

	if changes:
		for field_path, before_value, after_value in changes:
			row.record_edit(
				field_path=field_path,
				before_value=before_value,
				after_value=after_value,
				reason=reason,
			)
		row.append_activity(
			action="note",
			outcome="ok",
			detail=(
				f"edit by {frappe.session.user}: "
				+ ", ".join(c[0] for c in changes)
				+ f" — reason: {reason[:200]}"
			),
		)
	else:
		row.append_activity(
			action="note",
			outcome="info",
			detail=f"no-op edit by {frappe.session.user} — reason: {reason[:200]}",
		)

	# Move to In Review (signals row is being worked on; CAS for
	# concurrent edits — second editor sees the In Review status and
	# the per-row lock above blocks parallel edits).
	if row.status == "Pending Review":
		row.status = "In Review"
	row.save(ignore_permissions=True)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Edited payload + In Review CAS marker must be visible to other reviewers before the manager sees the success response.

	return {
		"name": row.name,
		"status": row.status,
		"changes": [{"field": f, "before": b, "after": a} for (f, b, a) in changes],
		"outcome": "ok" if changes else "noop",
	}


@frappe.whitelist()
def revert_to_original(name: str, reason: str) -> dict[str, Any]:
	"""P2-08: revert the working payload to original_payload.

	Convenience action that takes whatever the working `payload` field
	currently holds, replaces it with `original_payload`, recomputes
	the hash, and writes a `note` activity row + a single `edits` row
	with field_path = `(payload root)`. Useful when a manager has
	mid-edit and wants to reset.

	Allowed from Pending Review or In Review only — same gating as
	edit_payload. Reason is mandatory (treat reverts as audited
	actions just like edits).
	"""
	if not name:
		frappe.throw(_("name is required"), frappe.ValidationError)
	if not (reason or "").strip():
		frappe.throw(_("A reason is required to revert."), frappe.ValidationError)

	current = frappe.db.get_value(
		"POSpire Offline Sync Review",
		name,
		["status", "payload", "original_payload"],
		as_dict=True,
		for_update=True,
	)
	if not current:
		frappe.throw(_("Recovery entry {0} not found").format(name), frappe.DoesNotExistError)
	if current.status not in ("Pending Review", "In Review"):
		frappe.throw(
			_("Cannot revert from status {0}.").format(current.status),
			frappe.ValidationError,
		)

	row = frappe.get_doc("POSpire Offline Sync Review", name)
	# Same role gating as edit — managers only.
	caller_roles = set(frappe.get_roles())
	if not (caller_roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_("Only System Manager / Sales Manager may revert."),
			frappe.PermissionError,
		)

	if row.payload == row.original_payload:
		# Idempotent — nothing to revert.
		row.append_activity(
			action="note",
			outcome="info",
			detail=f"revert no-op (already at original) by {frappe.session.user}",
		)
		row.save(ignore_permissions=True)
		frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- noop revert still appends an audit-trail activity row; commit so the chain stays observable cross-session.
		return {"name": row.name, "outcome": "noop"}

	# Record one edit row capturing the whole-payload revert. before is
	# the current working payload; after is the original.
	try:
		before_obj = json.loads(row.payload) if row.payload else None
	except (ValueError, TypeError):
		before_obj = row.payload
	try:
		after_obj = json.loads(row.original_payload) if row.original_payload else None
	except (ValueError, TypeError):
		after_obj = row.original_payload
	row.record_edit(
		field_path="(payload root)",
		before_value=before_obj,
		after_value=after_obj,
		reason=reason,
	)
	row.payload = row.original_payload
	row.append_activity(
		action="note",
		outcome="ok",
		detail=f"reverted to original by {frappe.session.user} — {reason[:200]}",
	)
	row.save(ignore_permissions=True)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Revert mutates payload + appends an audit edit; both must be durable before returning so dry_run_replay sees the reverted state.
	return {"name": row.name, "outcome": "ok"}


@frappe.whitelist()
def dry_run_replay(name: str) -> dict[str, Any]:
	"""P2-09: replay against a savepoint and roll back, surfacing the
	would-be outcome without mutating real state.

	Same dispatch as `retry()` — including the cashier impersonation
	via `_acting_as_user(owner_user)` — but every branch runs inside a
	server-side savepoint that is unconditionally rolled back at the
	end. The endpoint returns:

	  {
	    "outcome": "ok" | "error",
	    "would_resolve_doctype": "...",     # when ok
	    "would_resolve_doc_name": "...",    # when ok (provisional name)
	    "error_category": "...",            # when error
	    "error_detail": "...",              # when error
	  }

	Read-only from the manager's perspective: no recovery row mutation
	(no attempt_count++, no Activity row, no status change) and the
	savepoint rollback rewinds any side effects of the would-be insert
	(Sales Invoice draft, Stock Ledger Entry probes, etc.) — manager
	gets a preview without committing to a state transition.

	Permission: same gate as retry/void. CAS not required because we
	don't transition the row; concurrent dry-runs are safe.
	"""
	if not name:
		frappe.throw(_("name is required"), frappe.ValidationError)
	caller_roles = set(frappe.get_roles())
	if not (caller_roles & {"System Manager", "Sales Manager"}):
		frappe.throw(
			_("Only System Manager / Sales Manager may dry-run a replay."),
			frappe.PermissionError,
		)

	row = frappe.db.get_value(
		"POSpire Offline Sync Review",
		name,
		[
			"status",
			"cashier_user",
			"entry_type",
			"payload",
			"offline_id",
			"shift_offline_id",
			"device_id",
			"schema_version",
		],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Recovery entry {0} not found").format(name), frappe.DoesNotExistError)
	if row.status in ("Resolved", "Voided"):
		frappe.throw(
			_("Cannot dry-run a {0} entry.").format(row.status),
			frappe.ValidationError,
		)
	if row.get("schema_version") and cint(row.get("schema_version")) != SCHEMA_VERSION:
		return {
			"outcome": "error",
			"error_category": "schema_mismatch",
			"error_detail": (
				f"Schema mismatch — payload version {row.get('schema_version')}, "
				f"server expects {SCHEMA_VERSION}. Cannot dry-run."
			),
		}

	try:
		payload = json.loads(row.payload)
	except (ValueError, TypeError) as exc:
		return {
			"outcome": "error",
			"error_category": "validation_error",
			"error_detail": f"Payload is not valid JSON: {exc}",
		}
	if not isinstance(payload, dict):
		return {
			"outcome": "error",
			"error_category": "validation_error",
			"error_detail": "Payload is not a JSON object.",
		}
	payload["owner_user"] = row.cashier_user
	device_id = row.device_id or ""
	if not device_id:
		return {
			"outcome": "error",
			"error_category": "validation_error",
			"error_detail": "Recovery row has no device_id; cannot dry-run.",
		}

	# Lazy import after argument validation so a failure during these
	# checks doesn't cost us the import.
	from pospire.pospire.api import offline as offline_api

	# Savepoint name — Frappe-on-MariaDB supports savepoints but the
	# wrapper is `frappe.db.savepoint` / `release_savepoint` /
	# `rollback(save_point=...)`. We unconditionally roll back at the
	# end — the dispatch's writes never reach the outer transaction's
	# COMMIT.
	savepoint = "recovery_dry_run"
	frappe.db.savepoint(savepoint)
	try:
		# Stash the original_payload-derived offline_id so the dispatch
		# DOESN'T trigger the cross-path idempotent return (which would
		# read the existing draft instead of dry-running). Use a fresh
		# UUID for the dry-run only.
		import uuid as _uuid

		dry_offline_id = str(_uuid.uuid4())
		# Same per-entry-type dispatch as retry().
		if row.entry_type == "invoice":
			result = offline_api.submit_invoice(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
				opening_entry_offline_id=row.shift_offline_id,
			)
		elif row.entry_type == "customer":
			result = offline_api.create_customer(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
			)
		elif row.entry_type == "material_receipt":
			result = offline_api.create_material_receipt(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
			)
		elif row.entry_type == "opening_entry":
			result = offline_api.create_opening_entry(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
			)
		elif row.entry_type == "closing_entry":
			result = offline_api.create_closing_entry(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
				opening_entry_ref=row.shift_offline_id or payload.get("opening_entry_offline_id"),
			)
		elif row.entry_type == "return":
			result = offline_api.create_return(
				data=payload,
				offline_id=dry_offline_id,
				device_id=device_id,
				opening_entry_offline_id=row.shift_offline_id,
			)
		else:
			return {
				"outcome": "error",
				"error_category": "validation_error",
				"error_detail": f"Unknown entry_type {row.entry_type}",
			}
	except Exception as err:
		# Always roll back, then surface the error to the manager.
		try:
			frappe.db.rollback(save_point=savepoint)
		except Exception:
			# If savepoint rollback itself fails, fall back to full
			# rollback to ensure we don't accidentally commit.
			frappe.db.rollback()
		return {
			"outcome": "error",
			"error_category": _classify_replay_exception(err),
			"error_detail": (str(err) or "")[:5000],
		}

	# Roll back the savepoint unconditionally — this is dry-run.
	try:
		frappe.db.rollback(save_point=savepoint)
	except Exception:
		# Same belt-and-braces.
		frappe.db.rollback()

	return {
		"outcome": "ok",
		"would_resolve_doctype": _entry_type_to_doctype(row.entry_type),
		"would_resolve_doc_name": (result or {}).get("name"),
		"would_docstatus": (result or {}).get("docstatus"),
	}


# ---------------------------------------------------------------------------
# P2-18: extended server metrics
# ---------------------------------------------------------------------------


@frappe.whitelist()
def get_metrics(window_hours: int = 24) -> dict[str, Any]:
	"""24h x category x cashier/outlet aggregates for monitoring.

	Distinct from `dashboard_summary` (which is the manager-facing
	cards): this endpoint is shaped for monitoring / alerting consumers
	(Prometheus exporters, custom dashboards, the SLA breach notifier
	below). Returns counters keyed for time-series ingest.

	Window is in hours, capped at 168 (7d). Default 24h matches the
	usual "last day" SRE rollup.
	"""
	if not frappe.has_permission("POSpire Offline Sync Review", "read"):
		frappe.throw(
			_("You do not have permission to read recovery metrics."),
			frappe.PermissionError,
		)

	window_hours = max(1, min(168, cint(window_hours) or 24))

	retry_metrics = frappe.db.sql(
		"""
		SELECT
		    r.error_category AS category,
		    SUM(CASE WHEN a.outcome = 'ok' THEN 1 ELSE 0 END) AS retry_ok,
		    SUM(CASE WHEN a.outcome = 'error' THEN 1 ELSE 0 END) AS retry_error,
		    COUNT(*) AS retry_total
		FROM `tabPOSpire Offline Sync Review Activity` a
		INNER JOIN `tabPOSpire Offline Sync Review` r
		    ON a.parent = r.name
		WHERE a.action = 'retry'
		  AND a.outcome IN ('ok', 'error')
		  AND a.at >= DATE_SUB(NOW(), INTERVAL %s HOUR)
		GROUP BY r.error_category
		""",
		(window_hours,),
		as_dict=True,
	)

	cashier_metrics = frappe.db.sql(
		"""
		SELECT
		    cashier_user,
		    COUNT(*) AS pending,
		    MAX(TIMESTAMPDIFF(MINUTE, creation, NOW())) AS oldest_age_minutes
		FROM `tabPOSpire Offline Sync Review`
		WHERE status = 'Pending Review'
		GROUP BY cashier_user
		""",
		as_dict=True,
	)

	terminal = frappe.db.sql(
		"""
		SELECT
		    SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved_count,
		    SUM(CASE WHEN status = 'Voided'   THEN 1 ELSE 0 END) AS voided_count
		FROM `tabPOSpire Offline Sync Review`
		WHERE modified >= DATE_SUB(NOW(), INTERVAL %s HOUR)
		""",
		(window_hours,),
		as_dict=True,
	)
	terminal_row = (terminal[0] if terminal else {}) or {}

	legal_hold_count = cint(frappe.db.count("POSpire Offline Sync Review", {"legal_hold": 1}))

	return {
		"window_hours": window_hours,
		"by_category": [
			{
				"category": r.category or "(unknown)",
				"retry_ok": cint(r.retry_ok),
				"retry_error": cint(r.retry_error),
				"retry_total": cint(r.retry_total),
				"success_rate": (
					round(cint(r.retry_ok) / cint(r.retry_total), 3) if cint(r.retry_total) > 0 else None
				),
			}
			for r in retry_metrics
		],
		"by_cashier": [
			{
				"cashier": r.cashier_user,
				"pending_count": cint(r.pending),
				"oldest_age_minutes": cint(r.oldest_age_minutes or 0),
			}
			for r in cashier_metrics
		],
		"resolved_count": cint(terminal_row.get("resolved_count") or 0),
		"voided_count": cint(terminal_row.get("voided_count") or 0),
		"legal_hold_count": legal_hold_count,
	}


# ---------------------------------------------------------------------------
# P2-23: compliant activity exports
# ---------------------------------------------------------------------------


@frappe.whitelist()
def export_activity(
	from_date: str | None = None,
	to_date: str | None = None,
	cashier_user: str | None = None,
	category: str | None = None,
	include_chain_verify: bool = True,
) -> dict[str, Any]:
	"""Compliance-friendly activity log export with hash-chain proof.

	Returns a flat array of activity rows + parent recovery context,
	filtered by date / cashier / category. Per-recovery-row chain
	verification (P2-21) is included by default so the consumer can
	prove the audit trail is intact at export time.

	**Audit-grade clean contract:** a downstream consumer should NOT
	conclude "audit-grade clean" without verifying ALL THREE:
	  1. `truncated == False` (response is the complete filtered set,
	     no 5000-row cap was hit), AND
	  2. `verification_complete == True` (every recovery row in scope
	     has its full chain present — no anchor missing, no tail cut),
	     AND
	  3. every `chain_verifications[*].ok == True` (no break in any
	     returned chain).
	The response carries `audit_grade_clean` as a pre-computed boolean
	combining all three so consumers don't have to re-derive the
	predicate (and risk getting it wrong). The individual flags remain
	exposed for diagnostic / partial-exception use cases.

	Capped at 5000 rows. Truncation is signalled in the response.
	"""
	if not frappe.has_permission("POSpire Offline Sync Review", "read"):
		frappe.throw(
			_("You do not have permission to export the activity log."),
			frappe.PermissionError,
		)

	values: list[Any] = []
	parent_filter_sql = ""
	if cashier_user:
		parent_filter_sql += " AND r.cashier_user = %s"
		values.append(cashier_user)
	if category:
		parent_filter_sql += " AND r.error_category = %s"
		values.append(category)

	activity_filters = ""
	if from_date:
		activity_filters += " AND a.at >= %s"
		values.append(from_date)
	if to_date:
		activity_filters += " AND a.at <= %s"
		values.append(to_date)

	# parent_filter_sql / activity_filters are server-built fragments
	# composed only of literal " AND col = %s" clauses (see above); the
	# actual values go through `tuple(values)` placeholder substitution.
	# No user input flows into the f-string.
	rows = frappe.db.sql(  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-sql-format-injection
		f"""
		SELECT
		    r.name AS recovery_name,
		    r.offline_id,
		    r.entry_type,
		    r.error_category,
		    r.cashier_user,
		    r.status,
		    r.legal_hold,
		    a.actor,
		    a.at,
		    a.action,
		    a.outcome,
		    a.detail,
		    a.prev_hash,
		    a.entry_hash,
		    a.idx AS row_idx
		FROM `tabPOSpire Offline Sync Review Activity` a
		INNER JOIN `tabPOSpire Offline Sync Review` r
		    ON a.parent = r.name
		WHERE 1=1
		    {parent_filter_sql}
		    {activity_filters}
		ORDER BY r.name ASC, a.idx ASC
		LIMIT 5001
		""",
		tuple(values),
		as_dict=True,
	)

	truncated = len(rows) > 5000
	rows = rows[:5000]

	chain_verifications: dict[str, dict[str, Any]] = {}
	verification_complete = True  # flips to False if any recovery row's chain is partially in scope
	if include_chain_verify:
		from pospire.pospire.doctype.pospire_offline_sync_review.pospire_offline_sync_review import (
			ZERO_HASH,
			_compute_entry_hash,
		)

		groups: dict[str, list[Any]] = {}
		for r in rows:
			groups.setdefault(r.recovery_name, []).append(r)

		# Determine which recovery rows have ALL their activity in the
		# returned subset, vs. which were truncated mid-chain. A partial
		# chain can still be verified over the returned slice IF it
		# starts at the parent's MIN(idx) — that gives us the chain
		# anchor (prev_hash = ZERO_HASH on the first row). But ok=true
		# on a partial chain is NOT equivalent to "audit-grade clean":
		# a break could exist at idx > returned_count. The consumer
		# combines `ok` + `complete_chain` for the clean verdict.
		#
		# Frappe child `idx` is 1-based, not 0-based — comparing against
		# the actual MIN(idx) per parent rather than a hardcoded 0 or 1
		# is robust to any future change in Frappe's child-row numbering.
		actual_row_counts: dict[str, int] = {}
		actual_min_idx: dict[str, int] = {}
		if groups:
			# `placeholders` is a "%s, %s, ..." string built from len(groups),
			# not user input; the actual parent names go through `tuple(groups.keys())`.
			placeholders = ", ".join(["%s"] * len(groups))
			# nosemgrep: frappe-semgrep-rules.rules.security.frappe-sql-format-injection
			count_sql = f"""
				SELECT parent, COUNT(*) AS n, MIN(idx) AS min_idx
				FROM `tabPOSpire Offline Sync Review Activity`
				WHERE parent IN ({placeholders})
				GROUP BY parent
			"""
			count_rows = frappe.db.sql(count_sql, tuple(groups.keys()), as_dict=True)
			for r in count_rows:
				actual_row_counts[r.parent] = cint(r.n)
				actual_min_idx[r.parent] = cint(r.min_idx)

		for recovery_name, group in groups.items():
			group.sort(key=lambda x: cint(x.row_idx))
			# Chain anchor present iff the returned group's earliest idx
			# matches the parent's MIN(idx). Complete iff anchor is in
			# scope AND we returned every row.
			parent_min = actual_min_idx.get(recovery_name)
			parent_total = actual_row_counts.get(recovery_name, len(group))
			earliest_idx = cint(group[0].row_idx) if group else None
			anchor_in_scope = (
				earliest_idx is not None and parent_min is not None and earliest_idx == parent_min
			)
			complete_chain = anchor_in_scope and len(group) == parent_total
			if not complete_chain:
				verification_complete = False

			# If the chain anchor is NOT in scope, we have no way to
			# compute the expected prev_hash for the first returned row
			# (we'd need the row PRIOR to it, which the date filter
			# excluded). Mark unverifiable for this group.
			if not anchor_in_scope:
				chain_verifications[recovery_name] = {
					"ok": None,
					"rows": len(group),
					"first_break_idx": None,
					"complete_chain": False,
					"reason": (
						"chain anchor not in returned subset — date filter "
						"excluded earlier activity rows; widen the window or "
						"export by recovery_name to verify"
					),
				}
				continue

			expected_prev = ZERO_HASH
			ok = True
			break_idx = None
			for i, row in enumerate(group):
				# Same canonical encoding as `append_activity` and
				# `verify_activity_chain` — sourced from the doctype
				# module to keep the three call sites lockstep.
				recomputed = _compute_entry_hash(
					prev_hash=expected_prev,
					actor=str(row.actor or ""),
					at=str(row.at or ""),
					action=row.action or "",
					outcome=row.outcome or "",
					detail=row.detail or "",
				)
				if (row.prev_hash or "") != expected_prev or (row.entry_hash or "") != recomputed:
					ok = False
					break_idx = i
					break
				expected_prev = recomputed
			chain_verifications[recovery_name] = {
				"ok": ok,
				"rows": len(group),
				"first_break_idx": break_idx,
				# When complete_chain is False, ok=true means "the prefix
				# we returned hashes consistently from ZERO_HASH" but
				# does NOT prove there's no break later in the chain.
				# The consumer should refuse to declare audit-clean
				# without complete_chain=True.
				"complete_chain": complete_chain,
			}

	# Pre-compute the audit-grade-clean predicate so downstream consumers
	# don't have to derive it from three separate flags. Returns False
	# whenever chain verification was skipped (`include_chain_verify=False`)
	# — caller asked us not to verify, so we can't claim clean. All three
	# safety conditions (truncation + completeness + per-row ok) must
	# hold for the True branch.
	if include_chain_verify:
		all_chains_ok = all((cv or {}).get("ok") is True for cv in chain_verifications.values())
		audit_grade_clean = (not truncated) and verification_complete and all_chains_ok
	else:
		audit_grade_clean = False

	return {
		"rows": [
			{
				"recovery_name": r.recovery_name,
				"offline_id": r.offline_id,
				"entry_type": r.entry_type,
				"error_category": r.error_category,
				"cashier_user": r.cashier_user,
				"recovery_status": r.status,
				"legal_hold": cint(r.legal_hold),
				"actor": r.actor,
				"at": str(r.at) if r.at else None,
				"action": r.action,
				"outcome": r.outcome,
				"detail": r.detail,
				"prev_hash": r.prev_hash,
				"entry_hash": r.entry_hash,
			}
			for r in rows
		],
		"truncated": truncated,
		"row_count": len(rows),
		"chain_verifications": chain_verifications if include_chain_verify else None,
		# True iff every recovery row in the export has its FULL activity
		# chain in scope (no missing prefix from a date filter, no
		# truncation tail). Audit-grade clean requires this flag AND every
		# chain_verifications[*].ok == True AND truncated == False. When
		# False, the per-row `complete_chain: False` explains which rows
		# are partial and why.
		"verification_complete": verification_complete if include_chain_verify else None,
		# Pre-computed AND of all three audit-grade clean conditions.
		# Consumers should treat this as the canonical "is this export
		# proof of an intact audit trail?" signal. False can mean any
		# of: truncation, partial chain, broken chain, or verification
		# was disabled by the caller. Diagnostic flags (truncated,
		# verification_complete, chain_verifications) explain WHICH.
		"audit_grade_clean": audit_grade_clean,
		"filters": {
			"from_date": from_date,
			"to_date": to_date,
			"cashier_user": cashier_user,
			"category": category,
		},
	}


# ---------------------------------------------------------------------------
# P2-19: SLA breach notifications
# ---------------------------------------------------------------------------

SLA_BREACH_MINUTES = 240


def notify_sla_breaches() -> dict[str, Any]:
	"""Scheduled job (daily): scan for SLA-breached entries and email
	System Manager / Sales Manager users a digest. Bound from hooks.py.

	Idempotent in spirit: a daily digest naturally re-sends until ops
	clears the breaches. Returns a structured summary so the job can
	be invoked manually for testing without going through the
	scheduler.

	NOTE: only email delivery is implemented. A webhook-delivery path
	(POST a JSON digest to a configurable URL) was scoped but deferred
	until an operator asks — implementing it now would be unused
	plumbing. To add: pull a `recovery_sla_webhook_url` Data field onto
	POSpire Offline Settings, then POST the same digest payload here.
	"""
	breaches = frappe.db.sql(
		"""
		SELECT name, error_category, cashier_user,
		       TIMESTAMPDIFF(MINUTE, creation, NOW()) AS age_minutes
		FROM `tabPOSpire Offline Sync Review`
		WHERE status IN ('Pending Review', 'In Review')
		  AND TIMESTAMPDIFF(MINUTE, creation, NOW()) >= %s
		ORDER BY age_minutes DESC
		""",
		(SLA_BREACH_MINUTES,),
		as_dict=True,
	)

	if not breaches:
		return {"breaches": 0, "sent": False}

	recipients = [
		r.name
		for r in frappe.db.sql(
			"""
			SELECT DISTINCT u.name
			FROM `tabUser` u
			INNER JOIN `tabHas Role` hr ON hr.parent = u.name
			WHERE u.enabled = 1
			  AND u.user_type = 'System User'
			  AND hr.role IN ('System Manager', 'Sales Manager')
			""",
			as_dict=True,
		)
	]
	if not recipients:
		return {"breaches": len(breaches), "sent": False, "reason": "no recipients"}

	rows_html = "".join(
		"<tr>"
		+ f"<td><a href='/app/pospire-offline-sync-review/{frappe.utils.escape_html(b.name)}'>{frappe.utils.escape_html(b.name)}</a></td>"
		+ f"<td>{frappe.utils.escape_html(b.error_category or '')}</td>"
		+ f"<td>{frappe.utils.escape_html(b.cashier_user or '')}</td>"
		+ f"<td>{cint(b.age_minutes)} min</td>"
		+ "</tr>"
		for b in breaches
	)
	subject = _("[POSpire] {0} offline-sync recovery entries past SLA").format(len(breaches))
	body = (
		f"<p>{_('These entries have been Pending Review or In Review longer than the {0} min SLA threshold:').format(SLA_BREACH_MINUTES)}</p>"
		f"<table border='1' cellspacing='0' cellpadding='6'>"
		f"<thead><tr><th>{_('Entry')}</th><th>{_('Category')}</th><th>{_('Cashier')}</th><th>{_('Age')}</th></tr></thead>"
		f"<tbody>{rows_html}</tbody></table>"
		f"<p>{_('Runbook: docs/offline/19-recovery-runbook.md §1.2 covers thresholds and per-category playbooks.')}</p>"
	)
	try:
		frappe.sendmail(
			recipients=recipients,
			subject=subject,
			message=body,
			reference_doctype="POSpire Offline Sync Review",
		)
	except Exception as exc:
		frappe.log_error(
			title="notify_sla_breaches: sendmail failed",
			message=frappe.get_traceback(),
		)
		return {"breaches": len(breaches), "sent": False, "reason": str(exc)[:200]}

	return {"breaches": len(breaches), "sent": True, "recipients": len(recipients)}


# ---------------------------------------------------------------------------
# P2-27 + P2-29: daily auto-archive job + safety check
# ---------------------------------------------------------------------------


def archive_old_recovery_rows() -> dict[str, Any]:
	"""Scheduled job: delete Resolved / Voided rows older than the
	retention window AND not under legal hold AND not referenced by
	any unresolved descendant.

	Retention window comes from POSpire Offline Settings's
	`recovery_archive_after_days` (default 90). 0 disables archival.

	Safety predicates (P2-29):
	  1. legal_hold flag clears the row from the candidate set.
	  2. No unresolved descendant doc: a Sales Invoice / Customer
	     with `pos_offline_id` matching a parent recovery row's
	     `offline_id` would lose its lineage if the parent is
	     deleted. We skip parents whose offline_id appears in any
	     non-archive scope.
	"""
	retention_days = cint(
		frappe.db.get_single_value("POSpire Offline Settings", "recovery_archive_after_days") or 0
	)
	if retention_days <= 0:
		return {
			"archived": 0,
			"skipped_legal_hold": 0,
			"skipped_referenced": 0,
			"reason": "retention disabled",
		}

	candidates = frappe.db.sql(
		"""
		SELECT name, offline_id, entry_type, status
		FROM `tabPOSpire Offline Sync Review`
		WHERE status IN ('Resolved', 'Voided')
		  AND modified < DATE_SUB(NOW(), INTERVAL %s DAY)
		  AND COALESCE(legal_hold, 0) = 0
		LIMIT 5000
		""",
		(retention_days,),
		as_dict=True,
	)
	# `skipped_legal_hold` should describe THIS run, not the global
	# population: count only rows that WOULD have been candidates this
	# cycle if they weren't on hold (terminal status + modified before
	# cutoff). Without the run-scope filter, this metric overstates by
	# including legal-hold rows that aren't yet old enough to archive.
	skipped_legal_hold_row = frappe.db.sql(
		"""
		SELECT COUNT(*) AS n
		FROM `tabPOSpire Offline Sync Review`
		WHERE status IN ('Resolved', 'Voided')
		  AND modified < DATE_SUB(NOW(), INTERVAL %s DAY)
		  AND COALESCE(legal_hold, 0) = 1
		""",
		(retention_days,),
		as_dict=True,
	)
	skipped_legal_hold = cint((skipped_legal_hold_row[0] if skipped_legal_hold_row else {}).get("n") or 0)
	if not candidates:
		return {
			"archived": 0,
			"skipped_legal_hold": skipped_legal_hold,
			"skipped_referenced": 0,
			# Empty list when there's nothing to scan — the field is
			# present on every successful return so the consumer can
			# treat its presence as the contract, not a conditional.
			"skipped_columns": [],
		}

	# P2-29: protected-reference check — every resolved doctype that
	# carries a `pos_offline_id` (or equivalent) must be scanned, not
	# just Sales Invoice. Each entry_type in the recovery taxonomy maps
	# to a specific doctype:
	#
	#   invoice          → Sales Invoice          (pos_offline_id)
	#   return           → Sales Invoice          (same — covered by above)
	#   customer         → Customer               (pos_offline_id)
	#   material_receipt → Stock Entry            (pos_offline_id)
	#   opening_entry    → POS Opening Shift      (pos_offline_id)
	#   closing_entry    → POS Closing Shift      (pos_offline_id)
	#
	# Each check is gated on `frappe.db.has_column` so a schema
	# variant where one of these fields hasn't been added yet doesn't
	# halt archival across the fleet — fail-open with a warning log.
	# False negatives (archive when we shouldn't) here would orphan
	# lineage; we'd rather skip a candidate than break an audit chain.
	candidate_offline_ids = [c.offline_id for c in candidates if c.offline_id]
	referenced: set[str] = set()
	scan_targets = [
		"Sales Invoice",
		"Customer",
		"Stock Entry",
		"POS Opening Shift",
		"POS Closing Shift",
	]
	skipped_columns: list[str] = []
	if candidate_offline_ids:
		chunk_size = 500
		for doctype in scan_targets:
			if not frappe.db.has_column(doctype, "pos_offline_id"):
				# Schema variant: doctype exists but no `pos_offline_id`
				# column. Log once per run + carry on. Operator can
				# decide whether to add the column or accept the gap.
				skipped_columns.append(doctype)
				continue
			# `frappe.db.escape_table_name` style isn't exposed; `doctype`
			# is iterated over the hardcoded `scan_targets` list above
			# (not user input). `placeholders` is "%s, %s, ..." built
			# from len(chunk). Values go through tuple substitution.
			tab = f"`tab{doctype}`"
			for i in range(0, len(candidate_offline_ids), chunk_size):
				chunk = candidate_offline_ids[i : i + chunk_size]
				placeholders = ", ".join(["%s"] * len(chunk))
				refs = frappe.db.sql(  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-sql-format-injection
					f"""
					SELECT DISTINCT pos_offline_id
					FROM {tab}
					WHERE pos_offline_id IN ({placeholders})
					""",
					tuple(chunk),
				)
				for (oid,) in refs:
					if oid:
						referenced.add(oid)
		if skipped_columns:
			frappe.logger().warning(
				f"[archive_old_recovery_rows] skipped pos_offline_id scan on "
				f"doctypes without that column: {skipped_columns}. Rows whose "
				f"resolved_doctype is one of these still archive — add the "
				f"column or accept the lineage gap."
			)

	to_archive: list[str] = []
	skipped_referenced = 0
	for c in candidates:
		if c.offline_id and c.offline_id in referenced:
			skipped_referenced += 1
			continue
		to_archive.append(c.name)

	archived = 0
	for name in to_archive:
		try:
			frappe.delete_doc(
				"POSpire Offline Sync Review",
				name,
				force=True,
				ignore_permissions=True,
			)
			archived += 1
		except Exception:
			frappe.log_error(
				title=f"archive_old_recovery_rows: delete {name} failed",
				message=frappe.get_traceback(),
			)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- Scheduled archive batch can run for minutes; commit so deletions survive a worker restart mid-loop.
	return {
		"archived": archived,
		"skipped_legal_hold": skipped_legal_hold,
		"skipped_referenced": skipped_referenced,
		"retention_days": retention_days,
		# Doctypes that were scanned for pos_offline_id; populated only
		# when the column is missing on a target. Empty list = all five
		# resolved doctypes participated in the safety check.
		"skipped_columns": skipped_columns,
	}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _entry_type_to_doctype(entry_type: str) -> str:
	"""Map our outbox entry_type taxonomy to the server doctype the
	resolution lands in. Used to populate `resolved_doctype` on success."""
	return {
		"invoice": "Sales Invoice",
		"customer": "Customer",
		"material_receipt": "Stock Entry",
		"opening_entry": "POS Opening Shift",
		"closing_entry": "POS Closing Shift",
		"return": "Sales Invoice",
	}.get(entry_type, "")


def _classify_replay_exception(err: Exception) -> str:
	"""Best-effort mapping from Python exception class to the offline
	error taxonomy. Keeps the recovery row's `error_category` consistent
	with what the autonomous scheduler would have stamped via the wire-
	level classifier."""
	name = type(err).__name__
	if name == "PermissionError":
		return "permission_error"
	if name in {"ValidationError", "MandatoryError"}:
		return "validation_error"
	if name == "DuplicateEntryError":
		return "idempotent_duplicate"
	return "validation_error"


def _normalise_replay_endpoint_args(
	payload: dict[str, Any],
	*,
	offline_id: str,
	device_id: str,
	owner_user: str,
	posting_date: str | None = None,
) -> dict[str, Any]:
	"""Return offline endpoint kwargs from a stored recovery payload.

	Recovery handoff stores the outbox payload exactly as the cashier client
	queued it. For current clients that payload is the *offline endpoint
	argument wrapper*:

	  {"data": "{...inner doc...}", "offline_id": "...", "device_id": "..."}

	Manager retry must replay the same endpoint contract, not treat that
	wrapper as the document itself. Legacy/manual recovery rows may instead
	store the inner document directly, so support both shapes.
	"""
	if _looks_like_endpoint_wrapper(payload):
		args = dict(payload)
		args["data"] = _patch_replay_inner_metadata(
			args.get("data"),
			owner_user=owner_user,
			posting_date=posting_date,
		)
	else:
		inner = dict(payload)
		if not inner.get("owner_user") and not inner.get("owner"):
			inner["owner_user"] = owner_user
		if posting_date and not inner.get("posting_date"):
			inner["posting_date"] = posting_date
		args = {"data": inner}

	# The recovery row is the authority. Values inside the stored wrapper
	# came from the cashier client and should not be allowed to redirect a
	# manager retry to a different offline_id or device.
	args["offline_id"] = offline_id
	args["device_id"] = device_id
	return args


def _looks_like_endpoint_wrapper(payload: dict[str, Any]) -> bool:
	return "data" in payload and (
		"offline_id" in payload
		or "device_id" in payload
		or "opening_entry_offline_id" in payload
		or "opening_entry_ref" in payload
		or "material_receipt_offline_ids" in payload
	)


def _patch_replay_inner_metadata(
	data: Any,
	*,
	owner_user: str,
	posting_date: str | None = None,
) -> Any:
	"""Ensure owner/posting metadata lands inside wrapper `data`.

	The offline endpoints read P-5/P-11 metadata from the inner document,
	not from the endpoint wrapper. This mirrors the client scheduler's
	defensive patch so manager retries also work for older queued rows.
	"""
	if isinstance(data, dict):
		inner = dict(data)
		mutated = _patch_replay_metadata_dict(
			inner,
			owner_user=owner_user,
			posting_date=posting_date,
		)
		return inner if mutated else data

	if isinstance(data, str):
		try:
			parsed = json.loads(data)
		except (TypeError, ValueError):
			return data
		if not isinstance(parsed, dict):
			return data
		if not _patch_replay_metadata_dict(
			parsed,
			owner_user=owner_user,
			posting_date=posting_date,
		):
			return data
		return json.dumps(parsed, separators=(",", ":"), sort_keys=True)

	return data


def _patch_replay_metadata_dict(
	payload: dict[str, Any],
	*,
	owner_user: str,
	posting_date: str | None = None,
) -> bool:
	mutated = False
	if not payload.get("owner_user") and not payload.get("owner"):
		payload["owner_user"] = owner_user
		mutated = True
	if posting_date and not payload.get("posting_date"):
		payload["posting_date"] = str(posting_date)
		mutated = True
	return mutated


def _coerce_parent_ids(value: list | str | None) -> str:
	"""Normalise parent_offline_ids into a JSON string for the Long Text
	column. Accepts list (Python), str (already JSON), or None."""
	if not value:
		return "[]"
	if isinstance(value, list):
		return json.dumps(value)
	if isinstance(value, str):
		# Trust caller-formatted JSON. Validate parseable up-front so a
		# garbage string doesn't poison the doctype.
		try:
			parsed = json.loads(value)
		except json.JSONDecodeError:
			frappe.throw(
				_("parent_offline_ids must be a JSON array string"),
				frappe.ValidationError,
			)
		if not isinstance(parsed, list):
			frappe.throw(
				_("parent_offline_ids must be a JSON array, got {0}").format(type(parsed).__name__),
				frappe.ValidationError,
			)
		return value
	frappe.throw(
		_("parent_offline_ids must be a list or JSON string"),
		frappe.ValidationError,
	)
