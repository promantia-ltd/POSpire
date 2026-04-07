# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

import secrets
import string

import frappe
from frappe import _
from frappe.utils import add_to_date, now_datetime
from werkzeug.security import check_password_hash, generate_password_hash

_PIN_ATTEMPT_CACHE_PREFIX = "posa_pin_attempts"
_PIN_LOCKOUT_CACHE_PREFIX = "posa_pin_lockout"
_MAX_PIN_ATTEMPTS = 5
_LOCKOUT_MINUTES = 15


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@frappe.whitelist()
def get_approval_config(pos_profile: str) -> dict:
	"""Return the full approval configuration for a POS Profile.

	Called once at POS session start and cached in the frontend.
	Includes pin_hash and condition_js so the frontend can seed
	IndexedDB for offline use.
	"""
	enabled = frappe.db.get_value("POS Profile", pos_profile, "posa_enable_approval_workflow")
	if not enabled:
		return {"enabled": False, "actions": [], "managers": []}

	actions = frappe.get_all(
		"POS Approval Action",
		filters={"parent": pos_profile, "parenttype": "POS Profile"},
		fields=[
			"action_type",
			"approval_mode",
			"condition",
			"condition_js",
			"pin_approval",
			"remote_approval",
			"expiry_minutes",
			"approver_role",
		],
		order_by="idx asc",
	)

	managers = _get_managers_with_pins(pos_profile)

	return {"enabled": True, "actions": actions, "managers": managers}


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------


@frappe.whitelist()
def evaluate_approval_condition(
	pos_profile: str,
	action_type: str,
	doc_context: str,
	action_context: str,
) -> dict:
	"""Evaluate the condition expression server-side via frappe.safe_eval.

	Returns whether approval is required for the given action and context.
	Fail-safe: any condition error returns required=True.
	"""
	action_config = _get_action_config(pos_profile, action_type)
	if not action_config:
		return {"required": False, "mode": "Not Required"}

	mode = action_config.get("approval_mode", "Not Required")

	if mode == "Not Required":
		return {"required": False, "mode": mode}

	if mode == "Blocked":
		return {"required": True, "mode": mode, "pin_allowed": False, "remote_allowed": False}

	# mode == "Required"
	pin_allowed = bool(action_config.get("pin_approval"))
	remote_allowed = bool(action_config.get("remote_approval"))
	condition = action_config.get("condition", "")

	if not condition:
		return {
			"required": True,
			"mode": mode,
			"pin_allowed": pin_allowed,
			"remote_allowed": remote_allowed,
			"condition_met": True,
		}

	doc_dict = frappe.parse_json(doc_context)
	action_dict = frappe.parse_json(action_context)

	try:
		context = _get_approval_safe_globals()
		context.update({"doc": frappe._dict(doc_dict), "action": frappe._dict(action_dict)})
		result = frappe.safe_eval(condition, eval_globals=context)
		condition_met = bool(result)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "POS Approval: condition eval error")
		condition_met = True  # fail-safe

	return {
		"required": condition_met,
		"mode": mode,
		"pin_allowed": pin_allowed,
		"remote_allowed": remote_allowed,
		"condition_met": condition_met,
	}


def _get_approval_safe_globals() -> dict:
	return {
		"flt": frappe.utils.flt,
		"cint": frappe.utils.cint,
		"abs": abs,
		"round": round,
		"int": int,
		"float": float,
		"len": len,
		"frappe": frappe._dict(
			utils=frappe._dict(
				now_datetime=frappe.utils.now_datetime,
				nowdate=frappe.utils.nowdate,
				getdate=frappe.utils.getdate,
			),
			db=frappe._dict(get_value=frappe.db.get_value),
		),
	}


# ---------------------------------------------------------------------------
# Request lifecycle
# ---------------------------------------------------------------------------


@frappe.whitelist()
def create_approval_request(
	pos_profile: str,
	action_type: str,
	pos_opening_shift: str | None = None,
	invoice: str | None = None,
	item_code: str | None = None,
	item_name: str | None = None,
	original_value: float | None = None,
	requested_value: float | None = None,
	value_field_label: str | None = None,
	reason: str | None = None,
	request_payload: str | None = None,
	offline_id: str | None = None,
	device_id: str | None = None,
	selected_manager: str | None = None,
	broadcast: bool = True,
) -> dict:
	"""Create a POS Approval Request and optionally broadcast to eligible managers.

	broadcast: set False when both PIN and remote modes are available and the
	    cashier hasn't chosen remote yet — prevents premature desk notifications.
	    The frontend calls notify_remote_manager explicitly once remote is chosen.

	Idempotent when offline_id is provided: returns the existing record
	if a request with the same offline_id already exists.
	"""
	if offline_id:
		existing = frappe.db.get_value("POS Approval Request", {"offline_id": offline_id}, "name")
		if existing:
			return frappe.get_doc("POS Approval Request", existing).as_dict()

	action_config = _get_action_config(pos_profile, action_type)
	expiry_minutes = (action_config or {}).get("expiry_minutes") or 15

	doc = frappe.get_doc(
		{
			"doctype": "POS Approval Request",
			"action_type": action_type,
			"status": "Pending",
			"pos_profile": pos_profile,
			"pos_opening_shift": pos_opening_shift,
			"requested_by": frappe.session.user,
			"requested_at": now_datetime(),
			"expires_at": add_to_date(now_datetime(), minutes=expiry_minutes),
			"selected_manager": selected_manager,
			"invoice": invoice,
			"item_code": item_code,
			"item_name": item_name,
			"original_value": original_value,
			"requested_value": requested_value,
			"value_field_label": value_field_label,
			"reason": reason,
			"request_payload": request_payload,
			"offline_id": offline_id,
			"device_id": device_id,
		}
	)
	doc.insert(ignore_permissions=True)

	if broadcast and action_config and action_config.get("remote_approval"):
		_broadcast_request_to_managers(doc, action_config, selected_manager)

	return doc.as_dict()


def _broadcast_request_to_managers(
	doc: frappe.model.document.Document,
	action_config: dict,
	selected_manager: str | None = None,
) -> None:
	"""Broadcast the approval request via WebSocket to the relevant manager(s).

	If the cashier selected a specific manager, notify only that one.
	Otherwise notify all managers with the configured approver role + active PIN.
	"""
	approver_role = action_config.get("approver_role")
	if not approver_role:
		return

	if selected_manager:
		recipients = [selected_manager]
	else:
		# For remote approval notifications, include all users with the approver role
		# (PIN is only required for PIN-based approval, not remote desk approval).
		recipients = frappe.get_all(
			"Has Role",
			filters={"role": approver_role, "parenttype": "User"},
			pluck="parent",
		)

	if not recipients:
		return

	cashier_name = frappe.db.get_value("User", doc.requested_by, "full_name") or doc.requested_by

	message = {
		"request_name": doc.name,
		"action_type": doc.action_type,
		"item_code": doc.item_code,
		"item_name": doc.item_name,
		"original_value": doc.original_value,
		"requested_value": doc.requested_value,
		"value_field_label": doc.value_field_label,
		"requested_by": doc.requested_by,
		"requested_by_full_name": cashier_name,
		"pos_profile": doc.pos_profile,
		"expires_at": str(doc.expires_at),
	}

	for manager_user in recipients:
		frappe.publish_realtime(
			event="pos_approval_request",
			message=message,
			user=manager_user,
		)


# ---------------------------------------------------------------------------
# PIN verification
# ---------------------------------------------------------------------------


@frappe.whitelist()
def verify_pin_and_approve(
	request_name: str,
	pin: str,
	manager_user: str,
	resolution_note: str | None = None,
) -> dict:
	"""Verify the manager's PIN and approve the request in one step.

	Rate-limited: 5 wrong attempts per request triggers a 15-minute lockout.
	"""
	_check_lockout(request_name, manager_user)

	doc = frappe.get_doc("POS Approval Request", request_name)

	if doc.status != "Pending":
		frappe.throw(_("Approval request {0} is no longer pending.").format(request_name))

	if doc.requested_by == manager_user:
		frappe.throw(_("You cannot approve your own request."))

	_validate_approver_role(doc.pos_profile, doc.action_type, manager_user)

	pin_doc_name = frappe.db.get_value(
		"POS Manager PIN",
		{"user": manager_user, "is_active": 1},
		"name",
	)
	if not pin_doc_name:
		frappe.throw(_("No active PIN found for {0}.").format(manager_user))

	# Password fieldtype is Frappe-encrypted at rest — must use get_password() to decrypt
	pin_doc = frappe.get_doc("POS Manager PIN", pin_doc_name)
	stored_hash = pin_doc.get_password("pin_hash")

	if not check_password_hash(stored_hash, pin):
		_increment_attempts(request_name, manager_user)
		attempts = _get_attempt_count(request_name, manager_user)
		remaining = _MAX_PIN_ATTEMPTS - attempts
		if remaining <= 0:
			frappe.throw(_("Too many failed attempts. Locked for {0} minutes.").format(_LOCKOUT_MINUTES))
		frappe.throw(_("Invalid PIN. {0} attempt(s) remaining.").format(remaining))

	_clear_attempts(request_name, manager_user)
	_resolve_request(doc, "Approved", manager_user, "PIN", resolution_note)

	return {"status": "Approved", "request_name": request_name}


# ---------------------------------------------------------------------------
# Remote resolution
# ---------------------------------------------------------------------------


@frappe.whitelist()
def resolve_approval_request(
	request_name: str,
	action: str,
	resolution_note: str | None = None,
) -> dict:
	"""Approve or reject a request remotely from the manager's desk.

	Pushes a WebSocket event back to the cashier on resolution.
	"""
	if action not in ("Approved", "Rejected"):
		frappe.throw(_("Invalid action. Must be 'Approved' or 'Rejected'."))

	doc = frappe.get_doc("POS Approval Request", request_name)

	if doc.status != "Pending":
		frappe.throw(_("Approval request {0} is no longer pending.").format(request_name))

	if doc.requested_by == frappe.session.user:
		frappe.throw(_("You cannot resolve your own request."))

	_validate_approver_role(doc.pos_profile, doc.action_type, frappe.session.user)

	_resolve_request(doc, action, frappe.session.user, "Remote", resolution_note)

	resolver_name = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
	frappe.publish_realtime(
		event="pos_approval_resolved",
		message={
			"request_name": request_name,
			"status": action,
			"resolved_by": frappe.session.user,
			"resolved_by_full_name": resolver_name,
			"resolution_note": resolution_note or "",
		},
		user=doc.requested_by,
	)

	return {"status": action, "request_name": request_name}


# ---------------------------------------------------------------------------
# Cashier cancellation
# ---------------------------------------------------------------------------


@frappe.whitelist()
def cancel_approval_request(request_name: str) -> dict:
	"""Allow the requesting cashier to cancel their own pending approval request."""
	doc = frappe.get_doc("POS Approval Request", request_name)

	if doc.requested_by != frappe.session.user:
		frappe.throw(_("You can only cancel your own approval requests."))

	if doc.status != "Pending":
		frappe.throw(_("Approval request {0} is no longer pending.").format(request_name))

	# Use db.set_value to bypass validate (which blocks self-resolution).
	# Cashier withdrawing their own request is intentionally exempt from that check.
	frappe.db.set_value(
		"POS Approval Request",
		request_name,
		{
			"status": "Cancelled",
			"resolved_by": frappe.session.user,
			"resolved_at": now_datetime(),
			"resolution_method": "Remote",
			"resolution_note": _("Cancelled by cashier"),
		},
	)
	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- set_value outside request lifecycle requires explicit commit
	return {"status": "Cancelled", "request_name": request_name}


@frappe.whitelist()
def notify_remote_manager(request_name: str, selected_manager: str | None = None) -> dict:
	"""Broadcast a pending request to a specific manager or all eligible managers.

	Called when the cashier explicitly chooses remote approval mode.
	selected_manager=None broadcasts to all managers with the approver role.
	"""
	doc = frappe.get_doc("POS Approval Request", request_name)

	if doc.requested_by != frappe.session.user:
		frappe.throw(_("You can only notify managers for your own requests."))

	if doc.status != "Pending":
		frappe.throw(_("Approval request {0} is no longer pending.").format(request_name))

	action_config = _get_action_config(doc.pos_profile, doc.action_type) or {}
	cashier_name = frappe.db.get_value("User", doc.requested_by, "full_name") or doc.requested_by

	message = {
		"request_name": doc.name,
		"action_type": doc.action_type,
		"item_code": doc.item_code,
		"item_name": doc.item_name,
		"original_value": doc.original_value,
		"requested_value": doc.requested_value,
		"value_field_label": doc.value_field_label,
		"requested_by": doc.requested_by,
		"requested_by_full_name": cashier_name,
		"pos_profile": doc.pos_profile,
		"expires_at": str(doc.expires_at),
	}

	if selected_manager:
		frappe.publish_realtime(event="pos_approval_request", message=message, user=selected_manager)
	else:
		approver_role = action_config.get("approver_role")
		recipients = (
			frappe.get_all("Has Role", filters={"role": approver_role, "parenttype": "User"}, pluck="parent")
			if approver_role
			else []
		)
		for user in recipients:
			frappe.publish_realtime(event="pos_approval_request", message=message, user=user)

	return {"status": "notified"}


@frappe.whitelist()
def get_approval_request_status(request_name: str) -> dict:
	"""Poll endpoint — returns current status for reconnect/catch-up."""
	doc = frappe.get_doc("POS Approval Request", request_name)

	if doc.requested_by != frappe.session.user:
		frappe.throw(_("Access denied."))

	resolver_name = None
	if doc.resolved_by:
		resolver_name = frappe.db.get_value("User", doc.resolved_by, "full_name") or doc.resolved_by

	return {
		"status": doc.status,
		"resolved_by_full_name": resolver_name,
		"resolution_note": doc.resolution_note,
	}


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


@frappe.whitelist()
def get_pending_approvals(pos_profile: str | None = None) -> list:
	"""Return pending approval requests for the manager's queue."""
	filters = {"status": "Pending"}
	if pos_profile:
		filters["pos_profile"] = pos_profile

	return frappe.get_all(
		"POS Approval Request",
		filters=filters,
		fields=[
			"name",
			"action_type",
			"pos_profile",
			"requested_by",
			"requested_at",
			"expires_at",
			"item_code",
			"item_name",
			"original_value",
			"requested_value",
			"value_field_label",
		],
		order_by="requested_at asc",
	)


@frappe.whitelist()
def get_managers_for_approval(pos_profile: str, action_type: str) -> list:
	"""Return managers eligible to approve the given action type."""
	action_config = _get_action_config(pos_profile, action_type)
	if not action_config:
		return []

	approver_role = action_config.get("approver_role")
	if not approver_role:
		return []

	return _get_eligible_managers_with_names(pos_profile, approver_role)


# ---------------------------------------------------------------------------
# PIN management
# ---------------------------------------------------------------------------


@frappe.whitelist()
def regenerate_pin(user: str) -> dict:
	"""Auto-generate a new PIN for the given user, hash and email it.

	Only callable by System Manager. Returns success with no PIN in response.
	"""
	frappe.only_for("System Manager")

	pin_doc = frappe.get_doc("POS Manager PIN", {"user": user})
	from pospire.pospire.doctype.pos_manager_pin.pos_manager_pin import (
		_generate_and_dispatch_pin,
	)

	_generate_and_dispatch_pin(pin_doc)
	pin_doc.save(ignore_permissions=True)

	return {"success": True}


# ---------------------------------------------------------------------------
# Offline sync
# ---------------------------------------------------------------------------


@frappe.whitelist()
def sync_offline_approval_requests(requests: str) -> list:
	"""Bulk validate and persist offline approval records on reconnect.

	Stub for Phase 5 — returns an empty acceptance list for now.
	Full implementation in the offline migration phase.
	"""
	return []


# ---------------------------------------------------------------------------
# Scheduler job
# ---------------------------------------------------------------------------


def expire_stale_requests() -> None:
	"""Auto-expire pending requests past their expires_at timestamp.

	Called every 5 minutes by the Frappe scheduler.
	Pushes a realtime event to each cashier so their dialog updates.
	"""
	expired = frappe.get_all(
		"POS Approval Request",
		filters={"status": "Pending", "expires_at": ["<", now_datetime()]},
		fields=["name", "requested_by"],
	)

	for row in expired:
		doc = frappe.get_doc("POS Approval Request", row.name)
		doc.status = "Expired"
		doc.resolution_method = "Auto-Expired"
		doc.resolved_at = now_datetime()
		doc.save(ignore_permissions=True)

		frappe.publish_realtime(
			event="pos_approval_resolved",
			message={"request_name": row.name, "status": "Expired"},
			user=row.requested_by,
		)

	if expired:
		frappe.db.commit()  # nosemgrep: frappe-manual-commit -- scheduler job, no request context


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_action_config(pos_profile: str, action_type: str) -> dict | None:
	rows = frappe.get_all(
		"POS Approval Action",
		filters={"parent": pos_profile, "parenttype": "POS Profile", "action_type": action_type},
		fields=[
			"action_type",
			"approval_mode",
			"condition",
			"condition_js",
			"pin_approval",
			"remote_approval",
			"expiry_minutes",
			"approver_role",
		],
		limit=1,
	)
	return rows[0] if rows else None


def _get_eligible_managers(pos_profile: str, approver_role: str) -> list[str]:
	"""Return user names with the approver role who have an active PIN."""
	users_with_role = frappe.get_all(
		"Has Role",
		filters={"role": approver_role, "parenttype": "User"},
		pluck="parent",
	)
	if not users_with_role:
		return []

	active_pin_users = frappe.get_all(
		"POS Manager PIN",
		filters={"user": ["in", users_with_role], "is_active": 1},
		pluck="user",
	)
	return active_pin_users


def _get_eligible_managers_with_names(pos_profile: str, approver_role: str) -> list[dict]:
	users = _get_eligible_managers(pos_profile, approver_role)
	if not users:
		return []

	return frappe.get_all(
		"User",
		filters={"name": ["in", users]},
		fields=["name as user", "full_name"],
	)


def _get_managers_with_pins(pos_profile: str) -> list[dict]:
	"""Return manager PIN data for offline seeding. Called by get_approval_config."""
	action_configs = frappe.get_all(
		"POS Approval Action",
		filters={"parent": pos_profile, "parenttype": "POS Profile"},
		pluck="approver_role",
	)
	roles = list({r for r in action_configs if r})
	if not roles:
		return []

	all_managers: list[str] = []
	for role in roles:
		all_managers.extend(_get_eligible_managers(pos_profile, role))

	unique_managers = list(set(all_managers))
	if not unique_managers:
		return []

	pin_record_names = frappe.get_all(
		"POS Manager PIN",
		filters={"user": ["in", unique_managers], "is_active": 1},
		fields=["name", "user"],
	)

	result = []
	for record in pin_record_names:
		full_name = frappe.db.get_value("User", record.user, "full_name") or record.user
		# Password fieldtype is Frappe-encrypted — must use get_password() to get real hash
		pin_doc = frappe.get_doc("POS Manager PIN", record.name)
		result.append(
			{
				"user": record.user,
				"full_name": full_name,
				"pin_hash": pin_doc.get_password("pin_hash"),
				"pin_hash_expires_at": str(add_to_date(now_datetime(), hours=24)),
			}
		)

	return result


def _validate_approver_role(pos_profile: str, action_type: str, user: str) -> None:
	action_config = _get_action_config(pos_profile, action_type)
	if not action_config:
		return

	approver_role = action_config.get("approver_role")
	if not approver_role:
		return

	has_role = frappe.db.exists("Has Role", {"parenttype": "User", "parent": user, "role": approver_role})
	if not has_role:
		frappe.throw(
			_("{0} does not have the required role '{1}' to approve this action.").format(user, approver_role)
		)


def _resolve_request(
	doc: frappe.model.document.Document,
	status: str,
	resolved_by: str,
	resolution_method: str,
	resolution_note: str | None = None,
) -> None:
	doc.status = status
	doc.resolved_by = resolved_by
	doc.resolved_at = now_datetime()
	doc.resolution_method = resolution_method
	if resolution_note:
		doc.resolution_note = resolution_note
	doc.save(ignore_permissions=True)


# ---------------------------------------------------------------------------
# Rate limiting helpers (Redis cache)
# ---------------------------------------------------------------------------


def _attempt_key(request_name: str, manager_user: str) -> str:
	return f"{_PIN_ATTEMPT_CACHE_PREFIX}:{request_name}:{manager_user}"


def _lockout_key(request_name: str, manager_user: str) -> str:
	return f"{_PIN_LOCKOUT_CACHE_PREFIX}:{request_name}:{manager_user}"


def _check_lockout(request_name: str, manager_user: str) -> None:
	locked_until = frappe.cache().get_value(_lockout_key(request_name, manager_user))
	if locked_until:
		frappe.throw(
			_("PIN entry is locked. Try again after {0}.").format(locked_until),
		)


def _get_attempt_count(request_name: str, manager_user: str) -> int:
	count = frappe.cache().get_value(_attempt_key(request_name, manager_user))
	return int(count) if count else 0


def _increment_attempts(request_name: str, manager_user: str) -> None:
	key = _attempt_key(request_name, manager_user)
	count = _get_attempt_count(request_name, manager_user) + 1
	frappe.cache().set_value(key, count, expires_in_sec=_LOCKOUT_MINUTES * 60)

	if count >= _MAX_PIN_ATTEMPTS:
		locked_until = add_to_date(now_datetime(), minutes=_LOCKOUT_MINUTES)
		frappe.cache().set_value(
			_lockout_key(request_name, manager_user),
			str(locked_until),
			expires_in_sec=_LOCKOUT_MINUTES * 60,
		)


def _clear_attempts(request_name: str, manager_user: str) -> None:
	frappe.cache().delete_value(_attempt_key(request_name, manager_user))
	frappe.cache().delete_value(_lockout_key(request_name, manager_user))
