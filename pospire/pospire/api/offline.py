# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""POSpire offline sync endpoints.

This module is the server-side contract for the offline outbox. Every method
here implements idempotent writes keyed on `pos_offline_id` (UUID v4) and
respects snapshotted metadata (posting date, owner, POS Profile flags) from
the payload rather than the live session.

See docs/offline/12-server-side-changes.md for the full spec,
docs/offline/01-architecture-principles.md P-5/P-11/P-12 for invariants, and
docs/offline/15-decision-log.md D-22/D-23 for idempotency lock decisions.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import time
from collections.abc import Callable, Iterable, Iterator
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now

from pospire.pospire.api.posapp import submit_sales_invoice
from pospire.pospire.api.stock_reconcile import ensure_typed_batches_exist_for_invoice

# ---------------------------------------------------------------------------
# Error taxonomy (see docs/offline/12-server-side-changes.md §5)
# ---------------------------------------------------------------------------

ERROR_PARENT_NOT_READY = "parent_not_ready"
ERROR_SIBLINGS_NOT_READY = "siblings_not_ready"
ERROR_STOCK_SHORTAGE = "stock_shortage"
ERROR_BATCH_OR_SERIAL_CONFLICT = "batch_or_serial_conflict"
ERROR_ACCOUNTING_PERIOD_CLOSED = "accounting_period_closed"
ERROR_VALIDATION = "validation_error"
ERROR_PERMISSION = "permission_error"
ERROR_SCHEMA_MISMATCH = "schema_mismatch"

_HTTP_STATUS_BY_CODE: dict[str, int] = {
	ERROR_PARENT_NOT_READY: 409,
	ERROR_SIBLINGS_NOT_READY: 409,
	ERROR_STOCK_SHORTAGE: 409,
	ERROR_BATCH_OR_SERIAL_CONFLICT: 409,
	ERROR_ACCOUNTING_PERIOD_CLOSED: 417,
	ERROR_VALIDATION: 400,
	ERROR_PERMISSION: 403,
	ERROR_SCHEMA_MISMATCH: 426,
}


# ERPNext stock/batch/serial exception class names that the offline replay
# pipeline intercepts and reclassifies as structured OfflineSubmitErrors.
# Matched by class name (not import path) so the handler is resilient to
# ERPNext internal module reorganisation between minor versions.
_STOCK_SHORTAGE_EXC_NAMES: frozenset[str] = frozenset(["NegativeStockError"])
_BATCH_OR_SERIAL_EXC_NAMES: frozenset[str] = frozenset(
	[
		"BatchExpiredError",
		"SerialNoRequiredError",
		"SerialNoDuplicateError",
		"SerialNoNotExist",
		"SerialNoStatusError",
		"SerialNoQtyError",
		"SerialNoWarehouseError",
	]
)


class OfflineSubmitError(frappe.ValidationError):
	"""Structured error for offline sync failures.

	The outbox sync engine on the client parses `exc_type`, `error_code`,
	`message`, and `details` without inspecting the prose. See
	docs/offline/05-outbox-and-sync.md §5.
	"""

	http_status_code = 400

	def __init__(self, error_code: str, message: str, details: dict[str, Any] | None = None) -> None:
		self.error_code = error_code
		self.details = dict(details or {})
		super().__init__(message)


# UUID v4: 8-4-4-4-12 hex, version nibble "4", variant nibble in {8,9,a,b}.
_UUID_V4_RE = re.compile(
	r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
	re.IGNORECASE,
)

# Framework-managed fields that the offline payload carries from the cart but
# the server must own at replay time. Used on both write paths: to filter cart
# fields on the invoice-update flows, and to strip a fresh insert payload in
# `_idempotent_submit` (which re-applies `doctype` afterwards). Letting these
# leak through corrupts server-side identity / optimistic-concurrency state:
#   - name         → autoname assigns the real name. Frappe's `set_new_name`
#                    already nulls a cart-stamped one for every autoname we
#                    use (naming_series / series), so a leaked name is inert —
#                    stripping it keeps the payload from implying otherwise
#   - modified     → cart-stamped value defeats Frappe's check_if_latest
#                    (TimestampMismatchError on every save)
#   - creation     → audit trail; the cart only knew the online-load time,
#                    not the actual server insert time
#   - modified_by  → set_user_and_timestamp owns this from session.user
#   - owner        → _acting_as_user already attributes correctly
#   - docstatus    → the cart stamps `1` on opening/closing payloads. Inserting
#                    an already-submitted row turns the follow-up `.submit()`
#                    into an update-after-submit, which (a) never runs
#                    `on_submit`, so POSClosingShift never closes the opening
#                    shift, and (b) compares in-memory floats against the
#                    rounded DB values — the UpdateAfterSubmitError on
#                    Grand Total that broke offline close on the prospect site
_OFFLINE_PAYLOAD_RESERVED = frozenset(
	{"doctype", "name", "modified", "creation", "modified_by", "owner", "docstatus"}
)


def _currency_precision() -> int:
	"""Site currency precision used when aggregating closing totals."""
	return cint(frappe.get_cached_value("System Settings", None, "currency_precision")) or 3


def _float_precision() -> int:
	"""Site float precision used when aggregating closing quantities.

	The `or 3` fallback mirrors Frappe's own default for non-Currency fields
	(`get_field_precision` in frappe/model/meta.py). Falling back to anything
	tighter would round `total_quantity` below the precision of the Float
	field it lands on — visible on sites selling by weight.
	"""
	return cint(frappe.get_cached_value("System Settings", None, "float_precision")) or 3


def _throw(error_code: str, message: str, details: dict[str, Any] | None = None) -> None:
	"""Emit a structured OfflineSubmitError and set the HTTP status.

	Frappe's exception handler serialises `exc_type`, the message, and any
	fields attached to `frappe.local.response`. We shape the payload so the
	client sees `{ exc_type, error_code, message, details }` consistently.
	"""
	status = _HTTP_STATUS_BY_CODE.get(error_code, 400)
	if hasattr(frappe.local, "response"):
		frappe.local.response["http_status_code"] = status
		frappe.local.response["error_code"] = error_code
		frappe.local.response["details"] = dict(details or {})

	err = OfflineSubmitError(error_code, message, details)
	err.http_status_code = status
	raise err


def _reclassify_stock_error(exc: frappe.ValidationError) -> None:
	"""Re-raise a known ERPNext stock/batch/serial error as a structured OfflineSubmitError.

	Without this, NegativeStockError and friends escape as raw frappe.ValidationError,
	which Frappe serialises as HTTP 417 with no `error_code` field. The client
	then falls back to the 417 default category (accounting_period_closed) — wrong.

	Matched by class name so the handler survives ERPNext module reorganisation.
	Unknown ValidationErrors are not touched; the caller must re-raise them.
	"""
	exc_name = type(exc).__name__
	if exc_name in _STOCK_SHORTAGE_EXC_NAMES:
		_throw(ERROR_STOCK_SHORTAGE, str(exc), {"exc_type": exc_name})
	if exc_name in _BATCH_OR_SERIAL_EXC_NAMES:
		_throw(ERROR_BATCH_OR_SERIAL_CONFLICT, str(exc), {"exc_type": exc_name})


def _validate_uuid(offline_id: str | None, field: str = "offline_id") -> str:
	"""Require a canonical UUID v4 or throw `validation_error`."""
	if not isinstance(offline_id, str) or not _UUID_V4_RE.match(offline_id):
		_throw(
			ERROR_VALIDATION,
			_("Invalid {0}: must be UUID v4").format(field),
			{"field": field, "value": offline_id if isinstance(offline_id, str) else None},
		)
	return offline_id


def _load(payload: Any) -> dict[str, Any]:
	"""Normalise a JSON-encoded string or already-parsed dict payload."""
	if payload is None:
		return {}
	if isinstance(payload, str):
		try:
			parsed = json.loads(payload)
		except json.JSONDecodeError as exc:
			_throw(ERROR_VALIDATION, _("Payload is not valid JSON: {0}").format(exc.msg))
			return {}  # unreachable — _throw raises
		return parsed if isinstance(parsed, dict) else {}
	if isinstance(payload, dict):
		return payload
	_throw(ERROR_VALIDATION, _("Payload must be an object"))
	return {}  # unreachable — satisfies type checker


def _load_list(payload: Any) -> list[Any]:
	if payload is None:
		return []
	if isinstance(payload, str):
		try:
			parsed = json.loads(payload)
		except json.JSONDecodeError as exc:
			_throw(ERROR_VALIDATION, _("List payload is not valid JSON: {0}").format(exc.msg))
			return []  # unreachable — _throw raises
		return list(parsed) if isinstance(parsed, list | tuple) else []
	if isinstance(payload, list | tuple):
		return list(payload)
	_throw(ERROR_VALIDATION, _("Expected a list payload"))
	return []


def _server_build_hash() -> str:
	"""Return a short, stable fingerprint of the running server build."""
	version = frappe.get_attr("pospire.__version__") or "0"
	return hashlib.sha1(str(version).encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Idempotency helper (docs/offline/12-server-side-changes.md §2, D-22, D-23)
# ---------------------------------------------------------------------------


def _existing_by_offline_id(doctype: str, offline_id: str) -> str | None:
	return frappe.db.get_value(doctype, {"pos_offline_id": offline_id}, "name")


def _idempotent_submit(
	doctype: str,
	payload: dict[str, Any],
	offline_id: str,
	*,
	device_id: str | None = None,
	submit: bool = True,
	before_insert: Callable[[Any], None] | None = None,
	owner_user: str | None = None,
) -> dict[str, Any]:
	"""Insert (and optionally submit) a doc keyed on `pos_offline_id`.

	Idempotency is keyed on (doctype, pos_offline_id). The existing-doc
	branch is docstatus-aware (mirrors `submit_invoice`'s C2/C3 semantics):

	  - docstatus = 1  → already submitted; idempotent success.
	  - docstatus = 0  → draft from a partial replay (insert ran, submit
	                     didn't) OR background-submit deferred. Resume the
	                     submission synchronously so strict-closure /
	                     downstream gating sees a deterministic state.
	                     Returns `resumed_from_draft=True` so the client
	                     can distinguish from a fresh insert if needed.
	  - docstatus = 2  → cancelled. Cannot replay; throw validation_error
	                     so the client moves the row to needs_review.

	When `owner_user` is supplied, the insert + submit run inside
	`_acting_as_user(owner_user)` so the doc is attributed to the original
	cashier rather than the replay session (P-5).

	Cart-stamped fields in `_OFFLINE_PAYLOAD_RESERVED` (see the note on that
	constant for why each one) are stripped before `frappe.get_doc`, so a
	closing payload with `docstatus: 1` is inserted as a draft and then
	submitted properly. `doctype` is re-applied after the strip.
	"""
	existing = _existing_by_offline_id(doctype, offline_id)
	if existing:
		doc = frappe.get_doc(doctype, existing)
		existing_status = cint(doc.docstatus)
		if existing_status == 2:
			_throw(
				ERROR_VALIDATION,
				_("Cannot replay {0} {1}: it has been cancelled on the server.").format(doctype, doc.name),
				{"doctype": doctype, "name": doc.name, "docstatus": 2},
			)
		if existing_status == 1:
			return {
				"name": doc.name,
				"was_already_submitted": True,
				"docstatus": 1,
			}
		# docstatus = 0 → resume the submit. We don't repeat the insert
		# (the doc exists), but we do re-run the submit step inside the
		# acting-as-user context so attribution holds.
		if submit and doc.meta.is_submittable:
			with _acting_as_user(owner_user):
				doc.flags.ignore_permissions = True
				frappe.flags.ignore_account_permission = True
				doc.submit()
				doc.reload()
			return {
				"name": doc.name,
				"was_already_submitted": False,
				"resumed_from_draft": True,
				"docstatus": cint(doc.docstatus),
			}
		# Non-submittable doctype (e.g. Customer): existing draft IS the
		# canonical state.
		return {
			"name": doc.name,
			"was_already_submitted": True,
			"docstatus": existing_status,
		}

	payload = dict(payload)
	for key in _OFFLINE_PAYLOAD_RESERVED:
		payload.pop(key, None)
	payload["doctype"] = doctype
	payload["pos_offline_id"] = offline_id
	if device_id is not None:
		payload["pos_device_id"] = device_id

	with _acting_as_user(owner_user):
		doc = frappe.get_doc(payload)
		if before_insert is not None:
			before_insert(doc)

		try:
			doc.insert(ignore_permissions=True)
			if submit and doc.meta.is_submittable:
				doc.submit()
		except frappe.DuplicateEntryError:
			# Race: another worker inserted the same offline_id after our existence
			# check. Swallow the DB-level unique violation and re-evaluate via the
			# same docstatus-aware branch above so a draft winner doesn't get
			# falsely labelled as "submitted".
			frappe.db.rollback()
			existing = _existing_by_offline_id(doctype, offline_id)
			if not existing:
				raise
			winner = frappe.get_doc(doctype, existing)
			winner_status = cint(winner.docstatus)
			return {
				"name": winner.name,
				"was_already_submitted": winner_status == 1,
				"docstatus": winner_status,
			}

	return {
		"name": doc.name,
		"was_already_submitted": False,
		"docstatus": cint(doc.docstatus),
	}


# ---------------------------------------------------------------------------
# Rate limiter for observability endpoints
# ---------------------------------------------------------------------------

_LOG_BATCH_MAX_ENTRIES = 100
_LOG_BATCH_MAX_REQUESTS_PER_MINUTE = 10


def _log_batch_rate_limit(user: str) -> None:
	"""Throttle `log_batch` to 10 requests/minute/user using Frappe cache."""
	cache = frappe.cache()
	key = f"pospire:offline:log_batch_rate:{user}"
	now_ts = int(time.time())
	window_start = now_ts - 60

	timestamps: list[int] = list(cache.get_value(key) or [])
	timestamps = [ts for ts in timestamps if ts >= window_start]
	if len(timestamps) >= _LOG_BATCH_MAX_REQUESTS_PER_MINUTE:
		_throw(
			ERROR_VALIDATION,
			_("log_batch rate limit exceeded: {0} requests per minute per user").format(
				_LOG_BATCH_MAX_REQUESTS_PER_MINUTE
			),
			{"retry_after_seconds": 60},
		)
	timestamps.append(now_ts)
	cache.set_value(key, timestamps, expires_in_sec=120)


# ---------------------------------------------------------------------------
# POS Profile snapshot helpers (P-12, Q-2 fix)
# ---------------------------------------------------------------------------

# Profile flag names that the offline sync contract relies on. The snapshot is
# copied onto the opening shift at creation time so submit-time reads never
# touch the live POS Profile. The `custom_*` spelling is the canonical one for
# the v16 Feature 1/2 fields (phase-0 correction).
POS_PROFILE_OFFLINE_FLAGS: tuple[str, ...] = (
	"custom_allow_negative_stock",
	"custom_allow_add_to_stock_at_pos",
	"posa_auto_stock_reconcile",
)


def snapshot_profile_flags_onto_opening_shift(doc) -> None:
	"""Copy the live POS Profile flags onto the opening-shift record.

	Called from `create_opening_entry` (offline path) and from the existing
	online `create_opening_voucher` flow. The resulting snapshot is the
	only source of truth read by submit-time handlers (Q-2 constraint).

	**Cross-branch dependency**: the source POS Profile flags
	(`custom_allow_negative_stock`, `custom_allow_add_to_stock_at_pos`,
	`posa_auto_stock_reconcile`) are defined on feature branches, NOT on this
	(offline) branch. We cannot assume they exist on the running database —
	the offline branch may run alone, alongside the feature branch, or
	post-merge. To stay branch-independent we filter the read field list to
	whatever the live POS Profile schema actually contains; missing flags
	default to 0 in the snapshot. When the feature branch lands, this
	function picks up the live values automatically with no code change.
	"""
	if not getattr(doc, "pos_profile", None):
		return

	# Read only POS Profile fields that actually exist on this database.
	profile_meta = frappe.get_meta("POS Profile")
	source_fields = [f for f in POS_PROFILE_OFFLINE_FLAGS if profile_meta.has_field(f)]

	if source_fields:
		profile_values = (
			frappe.db.get_value(
				"POS Profile",
				doc.pos_profile,
				source_fields,
				as_dict=True,
			)
			or {}
		)
	else:
		profile_values = {}

	if doc.meta.has_field("pos_profile_snapshot_allow_negative_stock"):
		doc.pos_profile_snapshot_allow_negative_stock = cint(
			profile_values.get("custom_allow_negative_stock") or 0
		)
	if doc.meta.has_field("pos_profile_snapshot_allow_add_to_stock_at_pos"):
		doc.pos_profile_snapshot_allow_add_to_stock_at_pos = cint(
			profile_values.get("custom_allow_add_to_stock_at_pos") or 0
		)
	if doc.meta.has_field("pos_profile_snapshot_auto_stock_reconcile"):
		doc.pos_profile_snapshot_auto_stock_reconcile = cint(
			profile_values.get("posa_auto_stock_reconcile") or 0
		)


def _assert_offline_action_allowed_by_shift(
	opening_shift_name: str | None,
	flag: str,
	action_label: str,
) -> None:
	"""Gate an offline-replay action against the opening-shift snapshot.

	P-12 invariant: submit-time handlers MUST honour the snapshotted POS
	Profile flags from the OPENING SHIFT, never the live profile, because
	the cashier's authorisation was set when they opened the shift — a
	live-profile change after that point shouldn't retroactively widen or
	narrow what already-queued writes can do.

	This helper is the canonical consumer of `get_offline_flags_for_shift`.
	When `flag` is 0 on the snapshot, the offline replay is refused with
	HTTP 403 / `permission_error` and the client moves the row to
	needs_review. Falls open (no gate) when the shift name is missing —
	customer creates and shift opens themselves don't have a parent shift.
	"""
	if not opening_shift_name:
		return
	flags = get_offline_flags_for_shift(opening_shift_name)
	if cint(flags.get(flag) or 0) != 1:
		_throw(
			ERROR_PERMISSION,
			_(
				"{0} is not authorised on the opening shift. The shift's snapshot of `{1}` is 0; reopen a fresh shift if the profile has been updated."
			).format(action_label, flag),
			{"opening_shift": opening_shift_name, "flag": flag},
		)


def get_offline_flags_for_shift(opening_shift_name: str) -> dict[str, int]:
	"""Return the snapshotted POS Profile flags for a given opening shift.

	Submit handlers (online and offline paths) call this instead of reading
	the live POS Profile. Returns `{flag: 0|1}`. If the shift row predates
	the snapshot fields (legacy data), values default to 0.
	"""
	if not opening_shift_name:
		return {flag: 0 for flag in POS_PROFILE_OFFLINE_FLAGS}

	snapshot = (
		frappe.db.get_value(
			"POS Opening Shift",
			opening_shift_name,
			[
				"pos_profile_snapshot_allow_negative_stock",
				"pos_profile_snapshot_allow_add_to_stock_at_pos",
				"pos_profile_snapshot_auto_stock_reconcile",
			],
			as_dict=True,
		)
		or {}
	)
	return {
		"custom_allow_negative_stock": cint(snapshot.get("pos_profile_snapshot_allow_negative_stock") or 0),
		"custom_allow_add_to_stock_at_pos": cint(
			snapshot.get("pos_profile_snapshot_allow_add_to_stock_at_pos") or 0
		),
		"posa_auto_stock_reconcile": cint(snapshot.get("pos_profile_snapshot_auto_stock_reconcile") or 0),
	}


@frappe.whitelist()
def get_shift_invoice_offline_ids(
	opening_shift_name: str | None = None,
	opening_shift_offline_id: str | None = None,
) -> list[str]:
	"""Return pos_offline_id values for all submitted invoices on a shift.

	Mirrors the two-path query in _ensure_all_invoices_submitted so the frontend
	can include server-submitted invoices in the closing payload's invoice_offline_ids,
	preventing strict-closure retries from waiting on invoices that are already
	submitted on the server.

	Returns only non-null pos_offline_id values (invoices without one are not
	checked by strict closure and don't need to be listed).
	"""
	return sorted(_get_submitted_shift_invoice_offline_ids(opening_shift_name, opening_shift_offline_id))


def _get_submitted_shift_invoice_offline_ids(
	opening_shift_name: str | None = None,
	opening_shift_offline_id: str | None = None,
) -> set[str]:
	"""Return submitted Sales Invoice offline IDs linked to a POS shift."""
	ids: set[str] = set()
	if opening_shift_name:
		for x in frappe.get_all(
			"Sales Invoice",
			filters={"posa_pos_opening_shift": opening_shift_name, "docstatus": 1},
			pluck="pos_offline_id",
		):
			if x:
				ids.add(x)

	if opening_shift_offline_id:
		for x in frappe.get_all(
			"Sales Invoice",
			filters={"pos_opening_shift_offline_id": opening_shift_offline_id, "docstatus": 1},
			pluck="pos_offline_id",
		):
			if x:
				ids.add(x)

	return ids


# ---------------------------------------------------------------------------
# Posting-date / owner guards (P-5, P-11)
# ---------------------------------------------------------------------------


def _apply_payload_metadata(payload: dict[str, Any]) -> str:
	"""Validate posting_date / owner_user and pop the owner from the payload.

	P-5: server must attribute the write to `owner_user` from the payload,
	never `frappe.session.user`. We *don't* set `payload["owner"]` because
	`owner` is a Frappe core set-only-once magic field — passing it through
	`frappe.get_doc()` then a follow-up `update()`/`save()` triggers
	`CannotChangeConstantError`. Instead, callers wrap the insert/submit
	in `_acting_as_user(owner_user)` so Frappe's natural lifecycle assigns
	the owner during `set_user_and_timestamp()`.

	P-11: server must use the queued `posting_date`, never today.

	Returns the resolved owner user string so the caller can hand it to
	`_acting_as_user`.
	"""
	posting_date = payload.get("posting_date")
	if not posting_date:
		_throw(
			ERROR_VALIDATION,
			_("posting_date is required on queued writes (P-11)"),
			{"field": "posting_date"},
		)

	# Pop BOTH keys unconditionally — the previous `pop(a) or pop(b)`
	# short-circuited and left the magic `owner` field behind in payload
	# whenever `owner_user` was set. `frappe.get_doc(payload)` then tried
	# to write the (set-only-once) `owner` field on the resulting doc and
	# Frappe raises `CannotChangeConstantError` on the follow-up save.
	# See test_offline.py::test_returns_owner_user_and_pops_it_from_payload.
	popped_owner_user = payload.pop("owner_user", None)
	popped_owner = payload.pop("owner", None)
	owner_user = popped_owner_user or popped_owner
	if not owner_user:
		_throw(
			ERROR_VALIDATION,
			_("owner_user is required on queued writes (P-5)"),
			{"field": "owner_user"},
		)
	# Reject Guest explicitly. A bug in the legacy `currentCashier()`
	# fallback stamped some offline payloads as Guest when the SPA
	# couldn't read `frappe.session.user` from the Desk host (the
	# /pospire/pos route doesn't ship the Desk shell). Replaying as
	# Guest produces silent partial-success: the insert is forced
	# through with `ignore_permissions=True`, but the submit isn't,
	# and ERPNext's `on_submit` chain 403s on any guarded side effect
	# (stock ledger writes, loyalty entries, etc.). The frontend now
	# resolves the cashier from the user_id cookie, so any payload
	# arriving here with owner_user=Guest is from a pre-fix queue —
	# fail it loudly so the cashier can edit-and-retry with a real user.
	if owner_user == "Guest":
		_throw(
			ERROR_VALIDATION,
			_(
				"owner_user is 'Guest' on this queued entry. The cashier session "
				"was not captured at enqueue time. Edit the payload to set the "
				"correct cashier user, or void this entry."
			),
			{"field": "owner_user", "value": owner_user},
		)
	return owner_user


@contextlib.contextmanager
def _acting_as_user(owner_user: str | None) -> Iterator[None]:
	"""Temporarily switch `frappe.session.user` for offline replay.

	The offline outbox preserves the original cashier on each payload as
	`owner_user`. To honour P-5 (writes attributed to that user, not the
	replay session), we swap the active user for the duration of the insert
	+ submit, then restore. Falls through transparently when the requested
	user is missing/disabled — the replay still completes under the current
	session, which is logged for forensics.
	"""
	if not owner_user:
		yield
		return

	original = frappe.session.user
	if owner_user == original:
		yield
		return

	# Validate the user exists and is enabled. If not, fall back rather than
	# fail the sync — the alternative is permanent `needs_review` on every
	# entry from a removed user, which we'd rather avoid.
	user_row = frappe.db.get_value("User", owner_user, ["enabled"], as_dict=True)
	if not user_row or not cint(user_row.get("enabled")):
		frappe.logger().warning(
			f"[offline] owner_user {owner_user!r} missing/disabled; replaying as {original}"
		)
		yield
		return

	try:
		# Owner impersonation for offline replay (P-5). `owner_user` is
		# validated above (existence + enabled); session is restored in
		# the finally block. Audited pattern, not a privilege-escalation
		# path.
		frappe.set_user(owner_user)  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-setuser
		yield
	finally:
		frappe.set_user(original)  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-setuser


@contextlib.contextmanager
def _offline_replay_context() -> Iterator[None]:
	"""Flag the request as an offline replay so `validate_shift` (invoice.py)
	allows a queued invoice to submit against a shift that's been closed
	out-of-band (manual Desk close, racing live submit_closing_shift). P-11:
	queue-time state is authoritative; refusing here would orphan the sale.
	Idempotent under nesting — restores the prior flag value on exit.
	"""
	original = getattr(frappe.flags, "pospire_offline_replay", None)
	frappe.flags.pospire_offline_replay = True
	try:
		yield
	finally:
		if original is None:
			frappe.flags.pop("pospire_offline_replay", None)
		else:
			frappe.flags.pospire_offline_replay = original


def _check_accounting_period_open(posting_date: str, company: str | None) -> None:
	"""Reject submits whose `posting_date` lies in a closed accounting period.

	Uses ERPNext's Accounting Period if the doctype exists. The hard error
	here maps to HTTP 417 / `accounting_period_closed` so the client moves
	the entry to `needs_review` (see D-9).
	"""
	if not company or not posting_date:
		return
	if not frappe.db.exists("DocType", "Accounting Period"):
		return

	posting = get_datetime(posting_date).date() if isinstance(posting_date, str) else posting_date
	closed = frappe.db.sql(
		"""
		SELECT name FROM `tabAccounting Period`
		WHERE company = %s
		  AND %s BETWEEN start_date AND end_date
		  AND docstatus < 2
		LIMIT 1
		""",
		(company, posting),
		as_dict=True,
	)
	if closed:
		_throw(
			ERROR_ACCOUNTING_PERIOD_CLOSED,
			_("Accounting period for {0} is closed").format(posting_date),
			{"posting_date": str(posting_date), "company": company},
		)


# ---------------------------------------------------------------------------
# Parent resolution (offline_id → real docname) for invoice submits
# ---------------------------------------------------------------------------


def _resolve_opening_shift(opening_entry_offline_id: str | None) -> str | None:
	if not opening_entry_offline_id:
		return None
	_validate_uuid(opening_entry_offline_id, "opening_entry_offline_id")
	name = frappe.db.get_value(
		"POS Opening Shift",
		{"pos_offline_id": opening_entry_offline_id},
		"name",
	)
	if not name:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Opening shift has not yet been synced"),
			{"opening_entry_offline_id": opening_entry_offline_id},
		)
	return name


# UUID v4 regex (matches `_UUID_V4_RE` already used by `_validate_uuid`).
_UUID_V4_PATTERN = re.compile(
	r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
	re.IGNORECASE,
)


def _resolve_opening_shift_flexible(ref: str | None) -> tuple[str | None, str | None]:
	"""H1 — accept either an offline_id UUID OR a real shift name.

	Mixed-mode use case: the cashier opens the shift online, network drops
	mid-shift, cashier closes offline. The closing's payload then carries
	the REAL shift name (e.g. `POSA-OS-26-0000030`) instead of a UUID v4
	because the shift never had an offline_id stamped.

	Returns (real_shift_name, offline_id_if_any). The offline_id is None
	for online-opened shifts; downstream `_ensure_all_invoices_submitted`
	uses it to also detect orphan invoices that reference the shift via
	`pos_opening_shift_offline_id`.
	"""
	if not ref:
		return None, None

	# UUID shape → offline-opened shift. Use the strict resolver.
	if _UUID_V4_PATTERN.match(ref):
		offline_id = ref
		name = _resolve_opening_shift(offline_id)
		return name, offline_id

	# Otherwise treat as a real shift name. Verify it exists.
	if not frappe.db.exists("POS Opening Shift", ref):
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Opening shift {0} not found on the server").format(ref),
			{"opening_entry_ref": ref},
		)
	# An online-opened shift may also have an offline_id later if it was
	# touched by an offline replay; pick it up so the orphan check can use
	# either dimension.
	offline_id = frappe.db.get_value("POS Opening Shift", ref, "pos_offline_id")
	return ref, offline_id or None


def _resolve_material_receipts(material_receipt_offline_ids: Iterable[str] | None) -> list[str]:
	ids = [x for x in (material_receipt_offline_ids or []) if x]
	if not ids:
		return []
	for i in ids:
		_validate_uuid(i, "material_receipt_offline_id")

	rows = frappe.get_all(
		"Stock Entry",
		filters={"pos_offline_id": ["in", ids], "docstatus": 1},
		fields=["name", "pos_offline_id"],
	)
	found = {r["pos_offline_id"]: r["name"] for r in rows}
	missing = [i for i in ids if i not in found]
	if missing:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Material Receipt(s) not yet synced: {0}").format(", ".join(missing)),
			{"missing_offline_ids": missing},
		)
	return [found[i] for i in ids]


def _fill_payment_accounts_from_pos_profile(payload: dict[str, Any]) -> None:
	"""Populate `account` and `type` on every payments row.

	The Vue frontend builds Sales Invoice payment rows with `mode_of_payment`,
	`amount`, `default` only — the cashier never enters a GL account
	(Invoice.vue `get_payments()` ships `account: ""`). ERPNext's
	`update_multi_mode_option` (sales_invoice.py:922) only fills account/type
	when `payments` is empty, so an offline-queued invoice with non-empty
	rows would submit with `account=""` and `type=NULL`. That breaks two
	things in `posapp.submit_invoice`: (a) the `i.type == "Cash"` check on
	line 875 misses, so the cash MOP isn't recognised; (b) GL entries fall
	through to the company default cash account instead of the per-MOP
	account, mis-mapping the resulting Payment Entry.

	The proper resolution mirrors ERPNext's `get_mode_of_payments_info`
	(sales_invoice.py:3044): join Mode of Payment Account by company. We do
	this once per submit and merge the values into `payload["payments"]`
	before `draft.insert()`, so both the initial insert and the follow-up
	`invoice_doc.update(invoice)` in `posapp_submit_invoice` see populated
	rows.
	"""
	payments = payload.get("payments") or []
	company = payload.get("company")
	if not payments or not company:
		return

	mops = sorted({row.get("mode_of_payment") for row in payments if row.get("mode_of_payment")})
	if not mops:
		return

	# Mode of Payment Account joins MOP → company → default_account.
	rows = frappe.db.sql(
		"""
		SELECT mp.name AS mop, mp.type AS type, mpa.default_account
		FROM `tabMode of Payment Account` mpa
		JOIN `tabMode of Payment` mp ON mpa.parent = mp.name
		WHERE mpa.company = %s
		  AND mp.enabled = 1
		  AND mp.name IN %s
		""",
		(company, tuple(mops)),
		as_dict=True,
	)
	by_mop: dict[str, dict[str, Any]] = {r["mop"]: r for r in rows}

	for row in payments:
		mop = row.get("mode_of_payment")
		if not mop:
			continue
		info = by_mop.get(mop)
		if not info:
			continue
		# Only fill missing values — preserve any explicit override the
		# cashier's snapshot may have carried.
		if not row.get("account"):
			row["account"] = info.get("default_account") or ""
		if not row.get("type"):
			row["type"] = info.get("type") or ""


def _resolve_customer_by_offline_id(customer_offline_id: str | None) -> str | None:
	"""Server-side placeholder resolution for offline-queued customers.

	See 12-server-side-changes.md §4.5 and 17-risk-register.md R-6: clients
	do not rewrite queued invoice payloads after a customer syncs; the
	server is the authoritative rewrite point.
	"""
	if not customer_offline_id:
		return None
	_validate_uuid(customer_offline_id, "customer_offline_id")
	name = frappe.db.get_value("Customer", {"pos_offline_id": customer_offline_id}, "name")
	if not name:
		_throw(
			ERROR_PARENT_NOT_READY,
			_("Customer has not yet been synced"),
			{"customer_offline_id": customer_offline_id},
		)
	return name


# ---------------------------------------------------------------------------
# Endpoints (docs/offline/12-server-side-changes.md §4)
# ---------------------------------------------------------------------------


@frappe.whitelist()
def ping() -> dict[str, Any]:
	"""Lightweight connectivity probe (§4.6)."""
	return {
		"ok": True,
		"server_time": now(),
		"server_version": _server_build_hash(),
	}


@frappe.whitelist()
def get_offline_runtime_config() -> dict[str, Any]:
	"""Cashier-callable read of the cashier-tunable offline knobs.

	Returns the bits of `POSpire Offline Settings` that the client uses
	at runtime: tombstone retention window and handoff-stuck threshold.
	Excludes the `enabled` kill switch (cashiers already poll
	`is_offline_enabled` for that — keeping the two endpoints separate
	matches their cache cadence: kill switch is fast-poll 60s, runtime
	config is slow-poll 12h).

	Permission: same pattern as is_offline_enabled — `@whitelist()`
	requires a session, but we read via `frappe.db.get_single_value` to
	bypass the doctype's role-restricted read perms (cashiers have no
	read on POSpire Offline Settings; only managers do).
	"""
	if not frappe.db.exists("DocType", "POSpire Offline Settings"):
		return {
			"client_tombstone_retention_days": 14,
			"client_handoff_stuck_threshold_cycles": 10,
		}
	return {
		"client_tombstone_retention_days": cint(
			frappe.db.get_single_value("POSpire Offline Settings", "client_tombstone_retention_days") or 14
		),
		"client_handoff_stuck_threshold_cycles": cint(
			frappe.db.get_single_value("POSpire Offline Settings", "client_handoff_stuck_threshold_cycles")
			or 10
		),
	}


@frappe.whitelist()
def is_offline_enabled() -> dict[str, Any]:
	"""Read-only kill-switch lookup that authenticated POS users can call.

	The `POSpire Offline Settings` Single is restricted to System Manager
	for read/write so cashiers cannot tamper with it. That means the
	frontend cannot use `frappe.client.get_single_value` to poll the flag
	(it would hit a permission denial and the kill-switch logic would
	silently fall back to "enabled" — defeating the whole switch for the
	users who matter).

	This endpoint exposes ONLY the boolean `enabled` value through a
	whitelisted method, with `flags.ignore_permissions` so the doctype's
	per-role read restriction doesn't block the lookup. Authentication is
	still enforced (no Guest access) — the framework's `@whitelist()`
	already requires a session, and the doctype's write restriction stays
	intact: only System Manager can flip the switch through the Desk form.

	Failure semantics: if the doctype is missing entirely (fresh install
	pre-migrate) we return `enabled=True` so the boot path stays usable
	until `bench migrate` lands the doctype.
	"""
	# Fresh install pre-migrate: doctype isn't installed yet. Don't crash
	# the boot — return the safe default.
	if not frappe.db.exists("DocType", "POSpire Offline Settings"):
		return {"enabled": True}

	# `frappe.db.get_single_value` reads at the DB layer (`tabSingles`
	# directly) and bypasses doctype permissions — exactly what we want
	# for a one-bit value the cashier needs to know but should not be
	# able to mutate. Default to enabled when the field is unset (fresh
	# Single record before the doctype hook stamps a default).
	value = frappe.db.get_single_value("POSpire Offline Settings", "enabled")
	# `value` can be None (never persisted), 0/1 (Check), or a string in
	# some legacy installations. Normalise to a boolean.
	if value is None:
		return {"enabled": True}
	return {"enabled": cint(value) == 1}


@frappe.whitelist()
def get_customer_form_options() -> dict[str, list[str]]:
	"""Reference data for the offline-capable Create / Update Customer dialog.

	The dialog needs three lists to render its dropdowns: Customer Group,
	Territory, and Gender. Each one was previously fetched via a separate
	`frappe.client.get_list` call inside the dialog, which (a) cost three
	round-trips on every dialog open and (b) had no offline story — when
	the cashier was offline the dropdowns rendered empty and the cashier
	couldn't create a walk-in customer.

	This endpoint returns all three lists in one shot. The frontend caches
	the response under a stable cache key (`offline.customer_form_options`)
	so a single online fetch warms the cache for the rest of the session;
	subsequent dialog opens — including offline ones — read from cache and
	the dropdowns render normally.

	Filters mirror the previous `frappe.client.get_list` calls:
	  - Customer Group / Territory: leaf nodes only (`is_group = 0`)
	  - Gender: all entries

	Sort + limit also match (alphabetical, generous caps) so the on-screen
	values are identical to before — this is a transport change, not a
	behaviour change.
	"""
	customer_groups = [
		row.name
		for row in frappe.get_all(
			"Customer Group",
			filters={"is_group": 0},
			fields=["name"],
			order_by="name",
			limit_page_length=200,
		)
	]
	territories = [
		row.name
		for row in frappe.get_all(
			"Territory",
			filters={"is_group": 0},
			fields=["name"],
			order_by="name",
			limit_page_length=200,
		)
	]
	genders = [
		row.name
		for row in frappe.get_all(
			"Gender",
			fields=["name"],
			order_by="name",
			limit_page_length=1000,
		)
	]
	return {
		"customer_groups": customer_groups,
		"territories": territories,
		"genders": genders,
	}


@frappe.whitelist()
def create_return(
	data: dict | str,
	offline_id: str,
	device_id: str,
	opening_entry_offline_id: str | None = None,
	material_receipt_offline_ids: list[str] | str | None = None,
) -> dict[str, Any]:
	"""P2-26 — offline-queued sales return submission.

	A "return" is just a Sales Invoice with `is_return: 1` and a
	`return_against` link to the original invoice. The cashier-side
	outbox keeps `return` as its own entry_type (different parent
	tracking, different UI flow), but the server-side replay path is
	the same as a forward sale — the same idempotency, the same
	docstatus transitions, the same accounting period checks.

	This endpoint enforces the two return-specific flags upfront so a
	misconfigured cashier-side payload (missing `is_return` or missing
	`return_against`) fails loudly here instead of producing a confusing
	"can't have negative qty without is_return" error from ERPNext deep
	in the submit pipeline. Then it delegates to the existing
	`submit_invoice` so the entire idempotency / impersonation / shift
	resolution chain runs unchanged.
	"""
	payload = _load(data)
	# Force `is_return = 1`; the cashier client always sets this for
	# `return`-typed outbox entries, but the explicit guard catches a
	# stale-build cashier or a raw-edit replay that lost it.
	if not payload.get("is_return"):
		payload["is_return"] = 1
	# `return_against` links the return to the original invoice. ERPNext
	# requires it for any negative-qty Sales Invoice. Cashier-side
	# returns flow always captures it; missing here is a hard fail.
	if not payload.get("return_against"):
		_throw(
			ERROR_VALIDATION,
			_(
				"return_against is required on return payloads. The cashier "
				"flow captures the original invoice when initiating a return; "
				"a missing value here means the queued payload was edited or "
				"is from a stale client build."
			),
			{"field": "return_against"},
		)
	# Delegate. Pass back the inner data dict (re-serialise so
	# submit_invoice's `_load` is happy whether we got a dict or str
	# in the original `data`).
	return submit_invoice(
		data=payload,
		offline_id=offline_id,
		device_id=device_id,
		opening_entry_offline_id=opening_entry_offline_id,
		material_receipt_offline_ids=material_receipt_offline_ids,
	)


@frappe.whitelist()
def submit_invoice(
	data: dict | str,
	offline_id: str,
	device_id: str,
	opening_entry_offline_id: str | None = None,
	material_receipt_offline_ids: list[str] | str | None = None,
) -> dict[str, Any]:
	"""Idempotent offline invoice submission (§4.1).

	Resolves any `offline_id` parent references to real document names, then
	hands off to the shared `_idempotent_submit` path. The submit re-uses the
	existing `pospire.pospire.api.posapp.submit_invoice` so online and offline
	paths go through the same accounting/loyalty side effects — the only
	difference is that the offline wrapper pre-applies the idempotency check
	and the parent resolutions.
	"""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	owner_user = _apply_payload_metadata(payload)
	_check_accounting_period_open(payload.get("posting_date"), payload.get("company"))

	# If the payload references a queued customer by offline id, substitute the
	# resolved customer name before we look up idempotency. The resolved name
	# becomes part of the server document; the offline id stays out of the
	# `customer` link field.
	customer_offline_id = payload.pop("customer_offline_id", None)
	if customer_offline_id:
		payload["customer"] = _resolve_customer_by_offline_id(customer_offline_id)

	# Resolve parent opening shift + any material receipts.
	opening_shift_name = _resolve_opening_shift(opening_entry_offline_id)
	mr_ids = (
		_load_list(material_receipt_offline_ids)
		if isinstance(material_receipt_offline_ids, str)
		else material_receipt_offline_ids
	)
	_resolve_material_receipts(mr_ids)

	if opening_shift_name:
		payload["posa_pos_opening_shift"] = opening_shift_name
		payload.setdefault("pos_opening_shift_offline_id", opening_entry_offline_id)
		# P-12 — read the snapshotted profile flags from the SHIFT (not the
		# live profile) and stash on frappe.flags for any submit-time
		# validator that consults them. Currently informational; the
		# negative-stock branch (parked tech debt) is the consumer.
		frappe.flags.pospire_offline_shift_flags = get_offline_flags_for_shift(opening_shift_name)
	if mr_ids:
		payload["pos_material_receipt_offline_ids"] = json.dumps(list(mr_ids))

	# Fill payment row `account` + `type` from the POS Profile so the
	# inline payments resolve to the right GL accounts on submit. Must run
	# before draft.insert() AND before invoice_ref is built — both code
	# paths reuse `payload["payments"]` and would otherwise carry empty
	# accounts through to save.
	_fill_payment_accounts_from_pos_profile(payload)

	# Delegate to the existing submit pipeline. We import lazily so this module
	# stays cheap to import from migration patches and CLI helpers.
	from pospire.pospire.api.posapp import submit_invoice as posapp_submit_invoice

	# Idempotency: there are FOUR observable states for an existing row keyed
	# on this offline_id, and they need different responses (this is the C2
	# fix — previously every existing row returned was_already_submitted=true
	# even when docstatus=0, which silently blocked the strict-closure check).
	#
	#   docstatus = 1  → already submitted, idempotent success.
	#   docstatus = 0  → draft from a prior partial attempt OR live-then-
	#                    network-error scenario where the live posapp call
	#                    inserted but never submitted. Resume the submission
	#                    instead of returning a fake success.
	#   docstatus = 2  → cancelled. Cannot replay; client moves to needs_review.
	#   none           → fresh write, insert + submit normally.
	#
	# C3 — background-submit profile mode: when the POS Profile sets
	# `posa_allow_submissions_in_background_job=1`, posapp_submit_invoice
	# saves the doc but defers `.submit()` to a Frappe queue worker. The
	# returned status is 0. Strict-closure (which requires docstatus=1) then
	# waits forever. The remedy lives in `_complete_or_resume_invoice` below:
	# when the doc is still docstatus=0 after the posapp pipeline, we force
	# the submit synchronously inside the offline endpoint so the closing's
	# sibling check can see a submitted doc.
	existing = _existing_by_offline_id("Sales Invoice", offline_id)
	if existing:
		existing_doc = frappe.get_doc("Sales Invoice", existing)
		existing_status = cint(existing_doc.docstatus)
		if existing_status == 2:
			_throw(
				ERROR_VALIDATION,
				_("Cannot replay invoice {0}: it has been cancelled on the server.").format(
					existing_doc.name
				),
				{"name": existing_doc.name, "docstatus": 2},
			)
		if existing_status == 1:
			return {
				"name": existing_doc.name,
				"was_already_submitted": True,
				"docstatus": 1,
			}
		# docstatus = 0 → resume. The doc already has the correct payload
		# fields (it was inserted by a prior partial attempt or by the live
		# posapp.update_invoice path). Skip the insert + go straight to the
		# completion step.
		# Exclude `name` from the payload spread: the cart may have stamped a
		# stale online-draft name (e.g. ACC-SINV-2026-00183) onto invoice_doc
		# before going offline, and Frappe v16's autoname series ignores that
		# value at insert time. Letting it override `existing_doc.name` here
		# would make posapp.submit_invoice's `frappe.get_doc(...)` look up a
		# name the server never assigned → DoesNotExistError.
		invoice_ref = {
			"name": existing_doc.name,
			**{k: v for k, v in payload.items() if k not in _OFFLINE_PAYLOAD_RESERVED},
		}
		with _acting_as_user(owner_user), _offline_replay_context():
			try:
				result = _complete_or_resume_invoice(
					existing_doc.name,
					invoice_ref,
					payload.get("posa_submit_data") or {},
					posapp_submit_invoice,
				)
			except (frappe.DuplicateEntryError, frappe.UniqueValidationError) as exc:
				# Resume-branch save() collided on a unique key (typically
				# pos_offline_id). Mirror the create-branch handler: roll
				# back, re-resolve via _existing_by_offline_id, return
				# idempotent success if a canonical row exists. Otherwise
				# surface validation_error so the manager retries instead
				# of inheriting the misleading 417 default category
				# (accounting_period_closed) — see offline.py:113-117.
				frappe.db.rollback()
				canonical = _existing_by_offline_id("Sales Invoice", offline_id)
				if canonical:
					canonical_doc = frappe.get_doc("Sales Invoice", canonical)
					return {
						"name": canonical_doc.name,
						"was_already_submitted": cint(canonical_doc.docstatus) == 1,
						"docstatus": cint(canonical_doc.docstatus),
						"resolved_after_save_collision": True,
					}
				_throw(
					ERROR_VALIDATION,
					_("Concurrent write collision on offline_id {0} for Sales Invoice; retry").format(
						offline_id
					),
					{"offline_id": offline_id, "exc_type": type(exc).__name__},
				)
			except (frappe.PermissionError, frappe.AuthenticationError):
				frappe.log_error(
					title=(
						f"[offline.submit_invoice] PermissionError (resume) "
						f"offline_id={offline_id} owner={owner_user} "
						f"customer={payload.get('customer')!r} "
						f"profile={payload.get('pos_profile')!r}"
					),
					message=frappe.get_traceback(),
				)
				raise
			except frappe.ValidationError as exc:
				_reclassify_stock_error(exc)
				raise
		return {
			"name": result.get("name", existing_doc.name),
			"was_already_submitted": False,
			"resumed_from_draft": True,
			"docstatus": cint(result.get("docstatus") or 0),
		}

	payload["pos_offline_id"] = offline_id
	payload["pos_device_id"] = device_id

	# posapp.submit_invoice expects an "invoice" dict that already exists (by
	# name) plus a data dict. For the offline path we first insert a draft so
	# `name` is bound, then call posapp_submit_invoice which updates + submits.
	# Wrap insert+submit in _acting_as_user so the doc owner reflects the
	# original cashier (P-5) instead of the replay session.
	with _acting_as_user(owner_user), _offline_replay_context():
		try:
			# Strip `name` from the insert payload too: the cart may have
			# stamped a stale online-draft name onto invoice_doc, but the
			# server is the authority on naming via the doctype's autoname
			# series. Letting a stale name through risks (a) a phantom INSERT
			# at that name if it happens to be free, leaving the cart and
			# server with divergent records, or (b) a name collision against
			# an unrelated existing doc.
			draft = frappe.get_doc(
				{
					"doctype": "Sales Invoice",
					**{k: v for k, v in payload.items() if k not in _OFFLINE_PAYLOAD_RESERVED},
				}
			)
			draft.flags.ignore_permissions = True
			# Populate POS/tax fields while the document is still new, so ERPNext's
			# native set_taxes() path appends GST rows before India Compliance
			# validates the insert. for_validate=True preserves offline payment rows.
			draft.set_missing_values(for_validate=True)
			ensure_typed_batches_exist_for_invoice(draft)
			draft.insert()
		except frappe.DuplicateEntryError:
			frappe.db.rollback()
			existing = _existing_by_offline_id("Sales Invoice", offline_id)
			if not existing:
				raise
			existing_doc = frappe.get_doc("Sales Invoice", existing)
			return {
				"name": existing_doc.name,
				"was_already_submitted": cint(existing_doc.docstatus) == 1,
				"docstatus": cint(existing_doc.docstatus),
			}

		# See note in the resume branch above — `name` must not be spread from
		# payload or it overrides the autonamed draft we just inserted.
		invoice_ref = {
			"name": draft.name,
			**{k: v for k, v in payload.items() if k not in _OFFLINE_PAYLOAD_RESERVED},
		}
		try:
			result = _complete_or_resume_invoice(
				draft.name,
				invoice_ref,
				payload.get("posa_submit_data") or {},
				posapp_submit_invoice,
			)
		except (frappe.DuplicateEntryError, frappe.UniqueValidationError) as exc:
			# Same race as the insert-time DuplicateEntryError handler above,
			# but tripped at save() instead of insert(). Some path between
			# draft.insert() and invoice_doc.save() wrote a second row with
			# the same pos_offline_id (concurrent scheduler, hook re-entry,
			# or sibling reconcile during validate()). Roll back our
			# half-built draft, re-resolve via _existing_by_offline_id, and
			# return idempotent success — the other writer's row IS the
			# canonical doc for this offline_id. If re-resolution misses
			# (the racer also rolled back), surface as validation_error so
			# the manager retries instead of inheriting the misleading 417
			# default category (accounting_period_closed).
			frappe.db.rollback()
			existing = _existing_by_offline_id("Sales Invoice", offline_id)
			if existing:
				existing_doc = frappe.get_doc("Sales Invoice", existing)
				return {
					"name": existing_doc.name,
					"was_already_submitted": cint(existing_doc.docstatus) == 1,
					"docstatus": cint(existing_doc.docstatus),
					"resolved_after_save_collision": True,
				}
			_throw(
				ERROR_VALIDATION,
				_("Concurrent write collision on offline_id {0} for Sales Invoice; retry").format(offline_id),
				{"offline_id": offline_id, "exc_type": type(exc).__name__},
			)
		except (frappe.PermissionError, frappe.AuthenticationError):
			# Offline replay raised a permission/auth error during
			# submit. The framework's default 403 surfaces with no
			# context — the cashier sees "PermissionError" with no
			# indication of WHICH permission was denied. Capture a
			# full traceback in the Error Log so an admin can root-
			# cause without us re-running the failure, then re-raise
			# so the HTTP layer still returns 403 (the client maps
			# that to needs_review.permission_error). Includes the
			# offline_id, owner_user, customer, and pos_profile in
			# the title so the log is greppable.
			frappe.log_error(
				title=(
					f"[offline.submit_invoice] PermissionError "
					f"offline_id={offline_id} owner={owner_user} "
					f"customer={payload.get('customer')!r} "
					f"profile={payload.get('pos_profile')!r}"
				),
				message=frappe.get_traceback(),
			)
			raise
		except frappe.ValidationError as exc:
			_reclassify_stock_error(exc)
			raise

	return {
		"name": result.get("name", draft.name),
		"was_already_submitted": False,
		"docstatus": cint(result.get("docstatus") or 0),
	}


def _complete_or_resume_invoice(
	doc_name: str,
	invoice_ref: dict[str, Any],
	posa_submit_data: dict[str, Any],
	posapp_submit_invoice,
) -> dict[str, Any]:
	"""Run posapp.submit_invoice + force docstatus=1 even under background mode.

	C3 fix: when `posa_allow_submissions_in_background_job` is enabled on the
	POS Profile, posapp.submit_invoice saves the doc and enqueues a Frappe
	background job to call `.submit()`. The synchronous return value still
	reports the pre-submit state (status=0). Strict-closure (which filters by
	`docstatus=1`) would then loop forever on the closing.

	The offline pipeline cannot afford that non-determinism — operators
	expect "queued + drained" to mean "the document is submitted on the
	server when the closing fires". So after the posapp call we re-fetch the
	doc and, if it's still docstatus=0, submit synchronously here.

	Defensive retry on TimestampMismatchError: ERPNext's Sales Invoice
	lifecycle (set_payment_schedule, status updates, etc.) can bump the row's
	`modified` post-save without `update_modified=False`. The next save
	(submit) then fails the optimistic concurrency check. Rolling back +
	reloading + retrying is the standard pattern; idempotent because all
	side effects (Payment Entry creation, child-table mutation) live in the
	same transaction and roll back together.
	"""
	max_attempts = 3
	last_exc: Exception | None = None
	# Savepoint scopes the rollback to posapp_submit_invoice's mutations
	# only — the draft row inserted by the caller (offline.submit_invoice)
	# stays in the transaction so the retry's get_doc still finds it.
	# A naive frappe.db.rollback() would wipe that insert too, leaving
	# `frappe.get_doc("Sales Invoice", doc_name)` to throw DoesNotExist.
	savepoint = f"posapp_submit_{doc_name}".replace("-", "_")
	for attempt in range(1, max_attempts + 1):
		frappe.db.savepoint(savepoint)
		try:
			posapp_submit_invoice(invoice_ref, posa_submit_data)
			doc = frappe.get_doc("Sales Invoice", doc_name)
			if cint(doc.docstatus) == 0:
				doc.flags.ignore_permissions = True
				frappe.flags.ignore_account_permission = True
				submit_sales_invoice(doc)
				doc.reload()
			return {"name": doc.name, "docstatus": cint(doc.docstatus)}
		except frappe.TimestampMismatchError as exc:
			last_exc = exc
			if attempt == max_attempts:
				break
			try:
				frappe.db.rollback(save_point=savepoint)
			except Exception:
				# Savepoint rollback failed → fall back to whole-transaction
				# rollback so we don't leave half-applied writes around.
				frappe.db.rollback()
				break
	assert last_exc is not None  # only reachable when retries were exhausted
	raise last_exc


def _to_stock_entry_doc(data: dict[str, Any]) -> dict[str, Any]:
	"""Normalise a Material Receipt payload into a Stock Entry doc shape.

	Client payload carries `item_code`, `qty`, `warehouse`, plus optional
	`batch_no`, `expiry`, `serial_no`, `posting_date`. The handler creates
	new Batch / Serial No docs before the Stock Entry insert if the client
	presents values that are not yet in ERPNext.
	"""
	item_code = data.get("item_code")
	qty = data.get("qty")
	warehouse = data.get("warehouse") or data.get("t_warehouse")
	if not item_code or not qty or not warehouse:
		_throw(
			ERROR_VALIDATION,
			_("Material Receipt requires item_code, qty, and warehouse"),
			{
				"missing": [
					f for f, v in (("item_code", item_code), ("qty", qty), ("warehouse", warehouse)) if not v
				]
			},
		)

	batch_no = data.get("batch_no")
	serial_no = data.get("serial_no")

	# Create Batch first if new.
	if batch_no and not frappe.db.exists("Batch", batch_no):
		try:
			batch_doc = frappe.get_doc(
				{
					"doctype": "Batch",
					"batch_id": batch_no,
					"item": item_code,
					"expiry_date": data.get("expiry") or None,
				}
			)
			batch_doc.flags.ignore_permissions = True
			batch_doc.insert()
		except frappe.DuplicateEntryError:
			# Another writer beat us to it — safe to proceed.
			pass
		except Exception as exc:
			_throw(
				ERROR_BATCH_OR_SERIAL_CONFLICT,
				_("Batch {0} could not be created: {1}").format(batch_no, str(exc)),
				{"batch_no": batch_no},
			)

	# Create Serial No if new.
	if serial_no and not frappe.db.exists("Serial No", serial_no):
		try:
			serial_doc = frappe.get_doc(
				{
					"doctype": "Serial No",
					"serial_no": serial_no,
					"item_code": item_code,
					"warehouse": warehouse,
				}
			)
			serial_doc.flags.ignore_permissions = True
			serial_doc.insert()
		except frappe.DuplicateEntryError:
			pass
		except Exception as exc:
			_throw(
				ERROR_BATCH_OR_SERIAL_CONFLICT,
				_("Serial No {0} could not be created: {1}").format(serial_no, str(exc)),
				{"serial_no": serial_no},
			)

	return {
		"doctype": "Stock Entry",
		"stock_entry_type": "Material Receipt",
		"purpose": "Material Receipt",
		"posting_date": data.get("posting_date"),
		"company": data.get("company"),
		"owner": data.get("owner") or data.get("owner_user"),
		"items": [
			{
				"item_code": item_code,
				"qty": qty,
				"t_warehouse": warehouse,
				"batch_no": batch_no,
				"serial_no": serial_no,
				"basic_rate": data.get("basic_rate") or 0,
			}
		],
	}


@frappe.whitelist()
def create_material_receipt(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent Material Receipt (§4.2) for Feature 2 add-to-stock flow."""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	raw = _load(data)
	owner_user = _apply_payload_metadata(raw)
	_check_accounting_period_open(raw.get("posting_date"), raw.get("company"))

	# Warehouse validation (mirrors the live Add-to-Stock path). The POS Profile
	# linkage is passed through so we can verify the warehouse belongs to the
	# same configuration the cashier was authorised to write against.
	warehouse = raw.get("warehouse") or raw.get("t_warehouse")
	if warehouse and not frappe.db.exists("Warehouse", warehouse):
		_throw(
			ERROR_VALIDATION,
			_("Warehouse {0} does not exist").format(warehouse),
			{"warehouse": warehouse},
		)

	# P-12 — gate the replay against the opening shift's snapshotted profile
	# flags. Material Receipt is the offline add-to-stock-at-pos primitive;
	# if the cashier opened a shift on a profile that DIDN'T enable it, no
	# subsequent live-profile flip should retroactively allow this MR. The
	# helper below throws ERROR_PERMISSION (HTTP 403) when the flag is 0,
	# moving the outbox row to needs_review for manager triage.
	#
	# Also stash the full flag set on `frappe.flags` so any downstream
	# validator (Stock Entry hooks, custom apps) can consult them without
	# a second DB hit — request-scoped, no cleanup needed.
	opening_shift_name = raw.get("posa_pos_opening_shift")
	if opening_shift_name:
		frappe.flags.pospire_offline_shift_flags = get_offline_flags_for_shift(opening_shift_name)
		_assert_offline_action_allowed_by_shift(
			opening_shift_name,
			"custom_allow_add_to_stock_at_pos",
			_("Add to stock at POS"),
		)

	stock_entry_payload = _to_stock_entry_doc(raw)
	return _idempotent_submit(
		"Stock Entry",
		stock_entry_payload,
		offline_id,
		device_id=device_id,
		submit=True,
		owner_user=owner_user,
	)


@frappe.whitelist()
def create_opening_entry(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent POS Opening Shift creation (§4.3).

	Snapshots the POS Profile offline flags onto the shift record (P-12).
	All submit-time handlers must read the snapshot, never the live profile
	(see Q-2 constraint and `get_offline_flags_for_shift`).
	"""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	owner_user = _apply_payload_metadata(payload)

	def _snapshot_before_insert(doc) -> None:
		snapshot_profile_flags_onto_opening_shift(doc)

	return _idempotent_submit(
		"POS Opening Shift",
		payload,
		offline_id,
		device_id=device_id,
		submit=True,
		before_insert=_snapshot_before_insert,
		owner_user=owner_user,
	)


def _ensure_all_invoices_submitted(
	opening_ref: str,
	invoice_offline_ids: list[str],
	opening_offline_id: str | None = None,
) -> tuple[str, list[str], list[str]]:
	"""Strict-closure precondition for offline closing entries (§4.4, P-8).

	Two-part check:
	  (a) every offline id the client lists maps to a submitted Sales Invoice;
	  (b) every already-submitted Sales Invoice linked to the shift is folded
	      into the canonical sibling list, including online-before-offline
	      invoices omitted by older closing payloads.

	`opening_ref` is the REAL shift name (post-resolution).
	`opening_offline_id` is the optional UUID that lets the server-side
	enrichment also catch invoices that reference the shift via
	`pos_opening_shift_offline_id` (offline-queued invoices created before the
	shift's offline_id was rewritten).

	Returns `(opening_name, canonical_invoice_offline_ids, auto_included_ids)`.
	"""
	# Resolved name is supplied by the caller now; the previous in-line
	# offline-only lookup didn't support online-opened shifts.
	opening_name = opening_ref

	cleaned = [str(i) for i in (invoice_offline_ids or []) if i]
	for i in cleaned:
		_validate_uuid(i, "invoice_offline_id")

	if cleaned:
		mapped = frappe.get_all(
			"Sales Invoice",
			filters={"pos_offline_id": ["in", cleaned], "docstatus": 1},
			pluck="pos_offline_id",
		)
		missing_on_server = sorted(set(cleaned) - set(mapped))
		if missing_on_server:
			_throw(
				ERROR_SIBLINGS_NOT_READY,
				_("Cannot close: invoice(s) not submitted: {0}").format(", ".join(missing_on_server)),
				{"missing_offline_ids": missing_on_server},
			)

	# Server-side enrichment: every SUBMITTED Sales Invoice tied to this
	# shift is already safe for closing dependency purposes, even if an older
	# offline payload omitted it from `invoice_offline_ids` because it was
	# created online before the device went offline. We add those IDs to the
	# canonical set instead of requiring a manager to edit historical OSR
	# payloads by hand.
	#
	# Mixed-mode shifts can have invoices linked via EITHER:
	#   - `posa_pos_opening_shift = <real name>` (online-opened OR resolved)
	#   - `pos_opening_shift_offline_id = <UUID>` (offline-queued, before
	#     opening sync rewrote the link).
	# Run both checks; union the results. This does not weaken the important
	# sibling gate above: any invoice ID explicitly listed by the client still
	# must map to a submitted Sales Invoice before the close can proceed.
	#
	# `docstatus=1` filter is correctness AND performance:
	#   1. Cancelled (docstatus=2) and drafts (docstatus=0) are not siblings
	#      the closing depends on.
	#   2. The B1 compound index
	#      `pospire_strict_closure_idx (pos_opening_shift_offline_id, docstatus)`
	#      satisfies the offline-id query from the index alone.
	declared_ids = set(cleaned)
	server_submitted_ids = _get_submitted_shift_invoice_offline_ids(
		opening_name,
		opening_offline_id,
	)
	auto_included_ids = sorted(server_submitted_ids - declared_ids)
	canonical_invoice_ids = sorted(declared_ids | server_submitted_ids)

	return opening_name, canonical_invoice_ids, auto_included_ids


def _aggregate_closing_from_invoices(
	opening_name: str,
	pos_profile_name: str | None,
	opening_offline_id: str | None = None,
) -> dict[str, Any]:
	"""Aggregate invoice-derived fields for a POS Closing Shift.

	Returns a dict with keys: pos_transactions, taxes, pos_payments,
	grand_total, net_total, total_quantity, pay_expected (mop → amount).
	pay_expected is seeded from the opening shift balance_details (opening
	cash in drawer) then invoice payments are added on top — matching the
	live builder in make_closing_shift_from_opening.
	"""
	cash_mode = (
		frappe.get_cached_value("POS Profile", pos_profile_name, "posa_cash_mode_of_payment")
		if pos_profile_name
		else None
	) or "Cash"

	# Seed pay_expected from opening balance (mirrors live builder line 209-218).
	pay_expected: dict[str, float] = {}
	for bd in frappe.get_all(
		"POS Opening Shift Detail",
		filters={"parent": opening_name},
		fields=["mode_of_payment", "amount"],
	):
		pay_expected[bd.mode_of_payment] = flt(bd.amount)

	# Collect invoice names from both link paths (mirrors _ensure_all_invoices_submitted).
	inv_names: set[str] = set()
	for row in frappe.get_all(
		"Sales Invoice",
		filters={"posa_pos_opening_shift": opening_name, "docstatus": 1},
		pluck="name",
	):
		inv_names.add(row)
	if opening_offline_id:
		for row in frappe.get_all(
			"Sales Invoice",
			filters={"pos_opening_shift_offline_id": opening_offline_id, "docstatus": 1},
			pluck="name",
		):
			inv_names.add(row)

	invoices = (
		frappe.get_all(
			"Sales Invoice",
			filters={"name": ["in", sorted(inv_names)]},
			fields=[
				"name",
				"posting_date",
				"grand_total",
				"net_total",
				"total_qty",
				"customer",
				"change_amount",
			],
		)
		if inv_names
		else []
	)

	pos_transactions: list[dict] = []
	taxes: list[dict] = []
	grand_total = 0.0
	net_total = 0.0
	total_quantity = 0.0

	for inv in invoices:
		pos_transactions.append(
			{
				"sales_invoice": inv.name,
				"posting_date": inv.posting_date,
				"grand_total": inv.grand_total,
				"customer": inv.customer,
			}
		)
		grand_total += flt(inv.grand_total)
		net_total += flt(inv.net_total)
		total_quantity += flt(inv.total_qty)

		for t in frappe.get_all(
			"Sales Taxes and Charges",
			filters={"parent": inv.name},
			fields=["account_head", "rate", "tax_amount"],
		):
			existing = next(
				(tx for tx in taxes if tx["account_head"] == t.account_head and tx["rate"] == t.rate),
				None,
			)
			if existing:
				existing["amount"] += flt(t.tax_amount)
			else:
				taxes.append({"account_head": t.account_head, "rate": t.rate, "amount": flt(t.tax_amount)})

		for p in frappe.get_all(
			"Sales Invoice Payment",
			filters={"parent": inv.name},
			fields=["mode_of_payment", "amount"],
		):
			amount = flt(p.amount)
			if p.mode_of_payment == cash_mode:
				amount -= flt(inv.change_amount)
			pay_expected[p.mode_of_payment] = pay_expected.get(p.mode_of_payment, 0.0) + amount

	pos_payments: list[dict] = []
	for py in frappe.get_all(
		"Payment Entry",
		filters={"docstatus": 1, "reference_no": opening_name, "payment_type": "Receive"},
		fields=["name", "mode_of_payment", "paid_amount", "posting_date", "party"],
	):
		pos_payments.append(
			{
				"payment_entry": py.name,
				"mode_of_payment": py.mode_of_payment,
				"paid_amount": py.paid_amount,
				"posting_date": py.posting_date,
				"customer": py.party,
			}
		)
		pay_expected[py.mode_of_payment] = pay_expected.get(py.mode_of_payment, 0.0) + flt(py.paid_amount)

	precision = _currency_precision()
	qty_precision = _float_precision()
	return {
		"pos_transactions": pos_transactions,
		"taxes": [{**tx, "amount": flt(tx["amount"], precision)} for tx in taxes],
		"pos_payments": pos_payments,
		"grand_total": flt(grand_total, precision),
		"net_total": flt(net_total, precision),
		"total_quantity": flt(total_quantity, qty_precision),
		"pay_expected": {mop: flt(amt, precision) for mop, amt in pay_expected.items()},
	}


def _enrich_closing_payload(
	payload: dict[str, Any], opening_name: str, opening_offline_id: str | None = None
) -> None:
	"""Overwrite invoice-derived fields on an offline closing payload.

	Preserves cashier-entered fields (closing_amount, denomination_details,
	period dates, user, company, pos_profile). Recomputes everything that
	must come from submitted server records.
	"""
	pos_profile_name = payload.get("pos_profile") or frappe.db.get_value(
		"POS Opening Shift", opening_name, "pos_profile"
	)
	agg = _aggregate_closing_from_invoices(opening_name, pos_profile_name, opening_offline_id)

	payload["pos_transactions"] = agg["pos_transactions"]
	payload["taxes"] = agg["taxes"]
	payload["pos_payments"] = agg["pos_payments"]
	payload["grand_total"] = agg["grand_total"]
	payload["net_total"] = agg["net_total"]
	payload["total_quantity"] = agg["total_quantity"]

	pay_expected = agg["pay_expected"]
	existing_recon = payload.get("payment_reconciliation") or []
	seen_mops: set[str] = set()
	new_recon: list[dict] = []
	for row in existing_recon:
		if not isinstance(row, dict):
			continue
		mop = row.get("mode_of_payment")
		new_recon.append({**row, "expected_amount": pay_expected.get(mop, 0.0)})
		seen_mops.add(mop)
	for mop, exp in pay_expected.items():
		if mop not in seen_mops:
			new_recon.append(
				{"mode_of_payment": mop, "opening_amount": 0, "expected_amount": exp, "closing_amount": 0}
			)
	payload["payment_reconciliation"] = new_recon


def _ensure_opening_closed(opening_name: str, closing_name: str) -> bool:
	"""Assert `opening_name` is Closed against `closing_name`.

	Some _idempotent_submit branches (replay, dup-rollback) skip
	POSClosingShift.on_submit, leaving the opening shift Open after a
	"synced" response. Mirrors the repair in submit_closing_shift.
	Idempotent - no-op (incl. `modified`) if already correct.

	Returns True if a repair was applied.
	"""
	current = frappe.db.get_value(
		"POS Opening Shift",
		opening_name,
		["status", "pos_closing_shift"],
		as_dict=True,
	)
	if not current:
		return False
	if current.status == "Closed" and current.pos_closing_shift == closing_name:
		return False

	opening = frappe.get_doc("POS Opening Shift", opening_name)
	opening.pos_closing_shift = closing_name
	opening.set_status()
	opening.flags.ignore_permissions = True
	opening.save()
	return True


@frappe.whitelist()
def create_closing_entry(
	data: dict | str,
	offline_id: str,
	device_id: str,
	opening_entry_ref: str | None = None,
	opening_entry_offline_id: str | None = None,
) -> dict[str, Any]:
	"""Idempotent POS Closing Shift (§4.4) with strict-closure validation.

	`opening_entry_ref` is the new (H1) flexible parameter — either a
	UUID v4 (offline-opened shift) or a real POS Opening Shift name
	(online-opened shift). The legacy `opening_entry_offline_id` kwarg is
	still accepted for backward compatibility with already-queued payloads
	that pre-date the H1 fix; if both are supplied, `opening_entry_ref`
	wins.
	"""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	# Backward compat: callers that still pass `opening_entry_offline_id`
	# (queued payloads from before the H1 frontend rolled out) get
	# transparently mapped onto the new flexible field.
	ref = opening_entry_ref or opening_entry_offline_id
	if not ref:
		_throw(
			ERROR_VALIDATION,
			_("opening_entry_ref (or legacy opening_entry_offline_id) is required"),
			{"field": "opening_entry_ref"},
		)

	payload = _load(data)
	owner_user = _apply_payload_metadata(payload)

	invoice_offline_ids = payload.pop("invoice_offline_ids", None)
	if invoice_offline_ids is None:
		_throw(
			ERROR_VALIDATION,
			_("invoice_offline_ids is required on the closing payload (see docs 12 §4.4)"),
			{"field": "invoice_offline_ids"},
		)
	if isinstance(invoice_offline_ids, str):
		invoice_offline_ids = _load_list(invoice_offline_ids)
	if not isinstance(invoice_offline_ids, list):
		_throw(
			ERROR_VALIDATION,
			_("invoice_offline_ids must be a list"),
			{"field": "invoice_offline_ids"},
		)

	opening_name, opening_offline_id = _resolve_opening_shift_flexible(ref)
	(
		opening_name,
		canonical_invoice_offline_ids,
		auto_included_invoice_offline_ids,
	) = _ensure_all_invoices_submitted(
		opening_name,
		invoice_offline_ids,
		opening_offline_id=opening_offline_id,
	)
	payload["pos_opening_shift"] = opening_name
	_enrich_closing_payload(payload, opening_name, opening_offline_id)

	# If a draft exists from a prior partial replay, patch it with the
	# enriched payload before _idempotent_submit resumes submission — the
	# draft branch submits the existing doc as-is without re-applying fields.
	existing_draft_name = frappe.db.get_value(
		"POS Closing Shift", {"pos_offline_id": offline_id, "docstatus": 0}, "name"
	)
	if existing_draft_name:
		draft = frappe.get_doc("POS Closing Shift", existing_draft_name)
		for field in ("pos_transactions", "taxes", "pos_payments", "payment_reconciliation"):
			draft.set(field, payload.get(field, []))
		for field in ("grand_total", "net_total", "total_quantity"):
			draft.set(field, payload.get(field, 0))
		draft.flags.ignore_permissions = True
		draft.save()

	result = _idempotent_submit(
		"POS Closing Shift",
		payload,
		offline_id,
		device_id=device_id,
		submit=True,
		owner_user=owner_user,
	)

	# Assert closure post-condition on every branch (fresh, replay, dup-race).
	closing_name = result.get("name")
	if closing_name and cint(result.get("docstatus")) == 1:
		if _ensure_opening_closed(opening_name, closing_name):
			result["opening_shift_repaired"] = True

	if auto_included_invoice_offline_ids:
		result["auto_included_invoice_offline_ids"] = auto_included_invoice_offline_ids
		result["validated_invoice_offline_ids"] = canonical_invoice_offline_ids
	return result


@frappe.whitelist()
def create_customer(data: dict | str, offline_id: str, device_id: str) -> dict[str, Any]:
	"""Idempotent Customer creation for offline-created customers (§4.5)."""
	_validate_uuid(offline_id, "offline_id")
	_validate_uuid(device_id, "device_id")

	payload = _load(data)
	# Customers do not carry an accounting posting_date; relax the P-11 guard
	# to just require an `owner_user` attribution (P-5). Like the other
	# offline endpoints we *don't* set `payload["owner"]` — that magic field
	# is set-only-once in Frappe core and writing it via `frappe.get_doc()`
	# triggers `CannotChangeConstantError` on the follow-up save. Instead we
	# pass `owner_user` through to `_idempotent_submit`, which wraps the
	# insert in `_acting_as_user` so the natural lifecycle assigns the owner.
	# Pop both keys unconditionally — the prior `or` short-circuit left the
	# `owner` magic field behind in payload whenever `owner_user` was set.
	popped_owner_user = payload.pop("owner_user", None)
	popped_owner = payload.pop("owner", None)
	owner_user = popped_owner_user or popped_owner
	if not owner_user:
		_throw(
			ERROR_VALIDATION,
			_("owner_user is required on queued writes (P-5)"),
			{"field": "owner_user"},
		)

	return _idempotent_submit(
		"Customer",
		payload,
		offline_id,
		device_id=device_id,
		submit=False,
		owner_user=owner_user,
	)


@frappe.whitelist()
def log_batch(entries: list | str) -> dict[str, Any]:
	"""Accept a batch of client-side connectivity/sync log entries (§4.7).

	Rate-limited to `_LOG_BATCH_MAX_REQUESTS_PER_MINUTE` requests per minute
	per user and `_LOG_BATCH_MAX_ENTRIES` entries per request. The log entries
	are written into Frappe's Error Log so ops visibility mirrors the rest of
	the pipeline without a dedicated doctype — we keep the surface tiny in v1.
	"""
	user = frappe.session.user or "Guest"
	_log_batch_rate_limit(user)

	parsed = _load_list(entries)
	if len(parsed) > _LOG_BATCH_MAX_ENTRIES:
		_throw(
			ERROR_VALIDATION,
			_("log_batch accepts at most {0} entries per request").format(_LOG_BATCH_MAX_ENTRIES),
			{"max_entries": _LOG_BATCH_MAX_ENTRIES, "received": len(parsed)},
		)

	accepted = 0
	for entry in parsed:
		if not isinstance(entry, dict):
			continue
		# Trim free-form blobs so a single event cannot DoS the error log.
		message = json.dumps(entry, default=str)[:4000]
		frappe.log_error(message=message, title="POSpire Offline Event")
		accepted += 1

	return {"ok": True, "accepted": accepted}


@frappe.whitelist()
def record_beacon(beacon: dict | str) -> dict[str, Any]:
	"""B5 — accept a per-device 5-minute health beacon.

	Inserts one `POS Offline Beacon` row. Lighter than `log_batch`: a single
	beacon is structured fields, not free-form text, so the B6 dashboard can
	query it directly without parsing Error Log blobs.

	Validation is intentionally permissive — beacons are observability data
	that we'd rather ingest with sensible defaults than reject. The fields
	we DO validate:
	  - `device_id` is a UUID v4 (matches the device-id minted at offline
	    bootstrap; rejecting unknown shapes blocks attribution drift).
	  - `beacon_at` parses as a datetime. Stale clocks: we trust the device's
	    timestamp because the beacon's value depends on the *device's* view
	    of when state changed; the dashboard separately tracks server-side
	    creation time.
	"""
	parsed = _load(beacon)

	device_id = parsed.get("device_id")
	if not device_id:
		_throw(ERROR_VALIDATION, _("device_id is required on a beacon"), {"field": "device_id"})
	_validate_uuid(device_id, "device_id")

	beacon_at = parsed.get("beacon_at")
	if not beacon_at:
		_throw(ERROR_VALIDATION, _("beacon_at is required"), {"field": "beacon_at"})

	# Map the loose JSON into the doctype shape. Anything missing falls back
	# to a server-side default (None / 0).
	doc = frappe.new_doc("POS Offline Beacon")
	doc.device_id = device_id
	doc.beacon_at = beacon_at
	doc.online = cint(parsed.get("online", 1))
	doc.outlet = (parsed.get("outlet") or "")[:140]
	doc.user = parsed.get("user") or frappe.session.user
	doc.active_shift = (parsed.get("active_shift") or "")[:140]
	doc.queue_depth = max(0, cint(parsed.get("queue_depth") or 0))
	doc.in_flight = max(0, cint(parsed.get("in_flight") or 0))
	doc.needs_review = max(0, cint(parsed.get("needs_review") or 0))
	# `handed_off` and `oldest_handed_off_minutes` are Phase 1g additions.
	# Older clients won't send them — `parsed.get` returns None and we
	# fall through to the `or 0` default for the count + None for the
	# nullable age. Keeps the endpoint backwards-compatible during a
	# rolling client deploy.
	doc.handed_off = max(0, cint(parsed.get("handed_off") or 0))
	doc.oldest_minutes = (
		max(0, cint(parsed.get("oldest_minutes"))) if parsed.get("oldest_minutes") is not None else None
	)
	doc.oldest_handed_off_minutes = (
		max(0, cint(parsed.get("oldest_handed_off_minutes")))
		if parsed.get("oldest_handed_off_minutes") is not None
		else None
	)
	doc.last_sync_at = parsed.get("last_sync_at")
	doc.last_sync_outcome = parsed.get("last_sync_outcome") or ""
	doc.sw_build_hash = (parsed.get("sw_build_hash") or "")[:32]
	doc.spa_user_agent = (parsed.get("spa_user_agent") or "")[:240]

	doc.flags.ignore_permissions = True
	doc.insert()
	return {"ok": True, "name": doc.name}


@frappe.whitelist()
def get_observability_summary(stale_after_minutes: int = 15) -> dict[str, Any]:
	"""B6 — central observability dashboard payload.

	Aggregates the latest beacon per device, an outlet rollup, and a small
	error trend (last 7 days of `needs_review` invoice rows). The
	`POSpire Offline Beacon` doctype is the source of truth; this method
	just shapes it for a dashboard page.

	Returns a JSON dict the Vue admin route renders directly. Permissioned
	on read access to POS Offline Beacon (System Manager + Sales Manager
	per the doctype JSON).

	Args:
		stale_after_minutes: a beacon older than this is treated as "stale"
			(device hasn't checked in). Default 15 = 3 missed beacons.
	"""
	# Cheap permission gate — we don't expose dashboard data to cashier
	# users since it shows fleet-wide queue depths.
	if not frappe.has_permission("POS Offline Beacon", "read"):
		_throw(
			ERROR_PERMISSION,
			_("Read permission on POS Offline Beacon is required."),
			{"doctype": "POS Offline Beacon"},
		)

	stale_threshold_minutes = max(1, cint(stale_after_minutes))

	# Latest beacon per device. SQL because Frappe's qb doesn't have a
	# clean window-style "latest per group" idiom in v16 without a self-join.
	latest_rows = frappe.db.sql(
		"""
		SELECT b.device_id, b.beacon_at, b.online, b.outlet, b.user,
		       b.active_shift, b.queue_depth, b.in_flight, b.needs_review,
		       b.handed_off, b.oldest_minutes, b.oldest_handed_off_minutes,
		       b.last_sync_at, b.last_sync_outcome, b.sw_build_hash
		FROM `tabPOS Offline Beacon` b
		INNER JOIN (
			SELECT device_id, MAX(beacon_at) AS max_at
			FROM `tabPOS Offline Beacon`
			GROUP BY device_id
		) latest
		ON b.device_id = latest.device_id AND b.beacon_at = latest.max_at
		ORDER BY b.beacon_at DESC
		""",
		as_dict=True,
	)

	# Don't shadow the imported `now` function — Python's local-scoping rule
	# treats any name assigned inside a function as local for the WHOLE
	# function body, so the previous `now = get_datetime(now())` raised
	# UnboundLocalError because the right-hand `now()` resolved to the
	# (still-unbound) local. Use a distinct local.
	now_dt = get_datetime(now())
	stale_cutoff_seconds = stale_threshold_minutes * 60
	devices = []
	outlet_rollup: dict[str, dict[str, Any]] = {}
	for row in latest_rows:
		# Distance from "now" → flag as stale.
		beacon_dt = get_datetime(row.beacon_at) if row.beacon_at else None
		age_seconds = (now_dt - beacon_dt).total_seconds() if beacon_dt else None
		row["age_seconds"] = int(age_seconds) if age_seconds is not None else None
		row["stale"] = 1 if age_seconds is not None and age_seconds > stale_cutoff_seconds else 0
		devices.append(row)

		# Outlet rollup: max queue + sum of needs_review, count of devices.
		outlet = row.get("outlet") or "(unassigned)"
		bucket = outlet_rollup.setdefault(
			outlet,
			{
				"outlet": outlet,
				"devices": 0,
				"online_devices": 0,
				"queue_depth_max": 0,
				"queue_depth_sum": 0,
				"needs_review_sum": 0,
				"handed_off_sum": 0,
				"oldest_minutes_max": 0,
				"oldest_handed_off_minutes_max": 0,
				"stale_devices": 0,
			},
		)
		bucket["devices"] += 1
		if cint(row.get("online")):
			bucket["online_devices"] += 1
		if row.get("stale"):
			bucket["stale_devices"] += 1
		qd = cint(row.get("queue_depth"))
		bucket["queue_depth_max"] = max(bucket["queue_depth_max"], qd)
		bucket["queue_depth_sum"] += qd
		bucket["needs_review_sum"] += cint(row.get("needs_review"))
		bucket["handed_off_sum"] += cint(row.get("handed_off"))
		if row.get("oldest_minutes") is not None:
			bucket["oldest_minutes_max"] = max(bucket["oldest_minutes_max"], cint(row.get("oldest_minutes")))
		if row.get("oldest_handed_off_minutes") is not None:
			bucket["oldest_handed_off_minutes_max"] = max(
				bucket["oldest_handed_off_minutes_max"],
				cint(row.get("oldest_handed_off_minutes")),
			)

	# Fleet-wide totals — stable across queries; cheap to compute.
	totals = {
		"devices": len(devices),
		"online_devices": sum(1 for d in devices if cint(d.get("online"))),
		"stale_devices": sum(1 for d in devices if d.get("stale")),
		"queue_depth_total": sum(cint(d.get("queue_depth")) for d in devices),
		"needs_review_total": sum(cint(d.get("needs_review")) for d in devices),
		# Phase 1g — fleet-wide tombstone count (entries waiting on managers).
		# A growing handed_off_total at fixed needs_review_total means the
		# review queue is full but no one is acting on it — operational
		# bottleneck on the manager side, not the cashier device side.
		"handed_off_total": sum(cint(d.get("handed_off")) for d in devices),
		"max_queue_depth": max((cint(d.get("queue_depth")) for d in devices), default=0),
	}

	# Error trend: count of needs_review invoices grouped by day for the
	# last 7 days. Reads off the live Sales Invoice rows where
	# `pos_offline_id` is set + status hasn't moved past needs_review on
	# the device — but we don't have visibility into per-device statuses
	# without the beacon, so for v1 we use the beacon's needs_review value
	# averaged per day. Cheap, gives the trend curve.
	trend = frappe.db.sql(
		"""
		SELECT DATE(beacon_at) AS day,
		       SUM(needs_review) AS needs_review_sum,
		       AVG(queue_depth)  AS queue_depth_avg,
		       COUNT(DISTINCT device_id) AS devices
		FROM `tabPOS Offline Beacon`
		WHERE beacon_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
		GROUP BY day
		ORDER BY day ASC
		""",
		as_dict=True,
	)

	# Distinct SW build hashes seen in the last hour — a "fleet on stale
	# build" signal for ops. Two builds in flight = staged rollout in
	# progress; three or more = potential coordination issue.
	build_hashes = frappe.db.sql(
		"""
		SELECT sw_build_hash, COUNT(DISTINCT device_id) AS devices
		FROM `tabPOS Offline Beacon`
		WHERE beacon_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
		  AND sw_build_hash IS NOT NULL AND sw_build_hash != ''
		GROUP BY sw_build_hash
		ORDER BY devices DESC
		""",
		as_dict=True,
	)

	return {
		"generated_at": now_dt.isoformat(),
		"stale_after_minutes": stale_threshold_minutes,
		"totals": totals,
		"outlets": list(outlet_rollup.values()),
		"devices": devices,
		"trend_7d": trend,
		"build_hashes": build_hashes,
	}


@frappe.whitelist()
def submit_recovery_log(device_id: str, journal_blob: str, recovered_at: str) -> dict[str, Any]:
	"""Append an immutable recovery-log record (§4.8).

	The record is append-only; `POS Offline Recovery Log` rejects edits via
	the `on_update` hook wired in `hooks.py`.
	"""
	_validate_uuid(device_id, "device_id")
	if not journal_blob or not isinstance(journal_blob, str):
		_throw(ERROR_VALIDATION, _("journal_blob is required"), {"field": "journal_blob"})
	if not recovered_at:
		_throw(ERROR_VALIDATION, _("recovered_at is required"), {"field": "recovered_at"})

	# Guardrail: cap blob size at 8 MB (base64-encoded) to prevent a
	# compromised client from flooding storage.
	if len(journal_blob) > 8 * 1024 * 1024:
		_throw(
			ERROR_VALIDATION,
			_("journal_blob exceeds maximum size of 8 MiB"),
			{"max_bytes": 8 * 1024 * 1024, "received": len(journal_blob)},
		)

	doc = frappe.get_doc(
		{
			"doctype": "POS Offline Recovery Log",
			"device_id": device_id,
			"recovered_at": recovered_at,
			"journal_blob": journal_blob,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return {"ok": True, "name": doc.name}


# Small helper re-exports for the submit paths in posapp.py (Q-2 fix) — keeping
# them here keeps the snapshot contract in one file.
__all__ = [
	"ERROR_ACCOUNTING_PERIOD_CLOSED",
	"ERROR_BATCH_OR_SERIAL_CONFLICT",
	"ERROR_PARENT_NOT_READY",
	"ERROR_PERMISSION",
	"ERROR_SCHEMA_MISMATCH",
	"ERROR_SIBLINGS_NOT_READY",
	"ERROR_STOCK_SHORTAGE",
	"ERROR_VALIDATION",
	"POS_PROFILE_OFFLINE_FLAGS",
	"OfflineSubmitError",
	"create_closing_entry",
	"create_customer",
	"create_material_receipt",
	"create_opening_entry",
	"get_offline_flags_for_shift",
	"get_shift_invoice_offline_ids",
	"log_batch",
	"ping",
	"snapshot_profile_flags_onto_opening_shift",
	"submit_invoice",
	"submit_recovery_log",
]
