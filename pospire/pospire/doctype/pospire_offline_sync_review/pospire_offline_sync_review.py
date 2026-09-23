# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""POSpire Offline Sync Review controller.

Per-row state machine + audit log helpers. The whitelisted endpoints that
the rest of the system actually calls live in
`pospire.pospire.api.recovery` — this controller only owns invariants
that must hold no matter how a row was edited (e.g. payload_hash matches
the payload field, status transitions are valid, original_payload is
write-once).
"""

from __future__ import annotations

import hashlib
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, now_datetime

# Status transitions allowed by the state machine. Keys are the OLD state;
# values are the SET of states the row may move to from there. Any other
# transition raises a ValidationError on save. Manual edits via Desk that
# violate this map will be rejected.
# P2-21: hash chain anchor — prev_hash on the first activity row of any
# review is sha256("") would-be value; we use 64 zeros as the explicit
# sentinel so a verifier can spot "this is the first row" without having
# to reason about the hash function. The chain breaks deterministically
# if someone edits a row's detail / actor / etc — recomputing yields a
# different entry_hash, and the next row's prev_hash no longer matches.
ZERO_HASH = "0" * 64


ALLOWED_TRANSITIONS: dict[str, set[str]] = {
	"Pending Review": {"In Review", "Retrying", "Voided", "Pending Review"},
	"In Review": {"Pending Review", "Retrying", "Voided", "In Review"},
	"Retrying": {"Resolved", "Pending Review", "Voided", "Retrying"},
	"Resolved": {"Resolved"},  # terminal
	"Voided": {"Voided"},  # terminal
}


def sha256_hex(payload: str) -> str:
	"""sha256 hex digest of a (utf-8) string. Centralised so handoff,
	retry-edit, and tamper checks all use the same canonicalisation."""
	return hashlib.sha256((payload or "").encode("utf-8")).hexdigest()


def _compute_entry_hash(
	*,
	prev_hash: str,
	actor: str,
	at: str,
	action: str,
	outcome: str,
	detail: str,
) -> str:
	"""Canonical hash for one activity row.

	Earlier versions concatenated fields with a `|` delimiter — fragile
	because `detail` is free-form text and a `|` inside it would shift
	subsequent fields, producing a different hash for an unchanged row
	(or, in pathological cases, a collision between two semantically-
	different rows).

	JSON canonical encoding (sorted keys, no whitespace, deterministic
	escapes) sidesteps both: every field's bytes are unambiguously
	delimited by JSON quoting, and the same logical row always
	serialises to the same byte string. Used by both `append_activity`
	(stamp the hash) and `verify_activity_chain` (recompute it).
	"""
	import json as _json

	canonical_obj = {
		"prev_hash": prev_hash,
		"actor": actor,
		"at": at,
		"action": action,
		"outcome": outcome,
		"detail": detail,
	}
	canonical = _json.dumps(
		canonical_obj,
		sort_keys=True,
		separators=(",", ":"),
		ensure_ascii=True,
	)
	return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class POSpireOfflineSyncReview(Document):
	"""See module docstring."""

	def validate(self) -> None:
		# P2-22: legal_hold is a System-Manager-only field. Sales Manager
		# has write access to the doctype generally (Retry/Void/Edit
		# notes etc), but the legal-hold flag exists specifically to
		# block their reach for audit/dispute holds, so a controller
		# gate enforces that here. Both directions of the toggle (set
		# AND clear) are gated — an unauthorised lift is the bigger
		# compliance risk than an unauthorised set.
		#
		# Also writes an Activity row on every toggle so we can prove
		# "who flipped, when, why" without a separate audit table. The
		# Activity row goes through the same hash chain as everything
		# else, so post-hoc tampering is detectable.
		if not self.is_new():
			old_hold = cint(self.get_db_value("legal_hold") or 0)
			new_hold = cint(self.legal_hold or 0)
			if old_hold != new_hold:
				if "System Manager" not in frappe.get_roles():
					frappe.throw(
						_(
							"Only System Manager can change the Legal Hold flag. Caller {0} has roles: {1}."
						).format(
							frappe.session.user,
							", ".join(sorted(frappe.get_roles())),
						),
						frappe.PermissionError,
					)
				direction = "set" if new_hold else "lifted"
				reason = (self.legal_hold_reason or "").strip()
				if direction == "lifted" and not reason:
					# A lifted hold without a reason loses audit value.
					# Require the operator to provide one — if they're
					# clearing the hold the reason field is no longer
					# mandatory_depends_on, but we still want it.
					frappe.throw(
						_(
							"Lifting a Legal Hold requires a reason — capture "
							"the resolution reference (case closed, dispute "
							"resolved, etc) in 'Legal Hold Reason' before "
							"saving."
						),
						frappe.ValidationError,
					)
				self.append_activity(
					action="note",
					outcome="ok",
					detail=f"legal_hold {direction} by {frappe.session.user} — reason: {reason[:300] or '(none)'}",
				)

		# Hash invariants. payload_hash and original_payload_hash are
		# stamped at handoff and re-stamped on every save. If a row is
		# edited via Desk in a way that nulls the hashes, this re-derives
		# them from the payload fields rather than rejecting — saves an
		# operator step. But original_payload itself MUST NOT change post-
		# handoff.
		if self.original_payload:
			expected = sha256_hex(self.original_payload)
			if not self.original_payload_hash:
				self.original_payload_hash = expected
			elif self.original_payload_hash != expected:
				# Someone overwrote original_payload via direct DB or a
				# bypass path. Fail loud — the audit chain is broken.
				frappe.throw(
					_(
						"original_payload has been mutated post-handoff. The audit "
						"chain is broken. Restore from a database backup or void "
						"this entry and re-create."
					)
				)
		if self.payload:
			self.payload_hash = sha256_hex(self.payload)

		# State machine guard. Compare against the persisted value, not
		# `self.status` (which is the new value being saved).
		if not self.is_new():
			old_status = self.get_db_value("status")
			if old_status and old_status != self.status:
				allowed = ALLOWED_TRANSITIONS.get(old_status, set())
				if self.status not in allowed:
					frappe.throw(
						_("Invalid status transition from {0} to {1}. Allowed: {2}.").format(
							old_status, self.status, ", ".join(sorted(allowed))
						)
					)

	def record_edit(
		self,
		field_path: str,
		before_value: Any,
		after_value: Any,
		reason: str,
		actor: str | None = None,
	) -> None:
		"""Append a row to the field-level edit history child table.

		Caller must follow up with `self.save(ignore_permissions=...)`.
		Same single-transaction-with-parent guarantee as `append_activity`:
		the audit row commits with the parent's payload mutation, never
		separately.

		`before_value` / `after_value` are JSON-serialised before storage
		so the schema stays uniform regardless of the source value type
		(scalar, dict, list). Truncation at 5000 chars per side guards
		MariaDB row-size limits — full payload diffs are reconstructable
		from `original_payload` + the sequence of edits.
		"""
		import json as _json

		def _serialise(v: Any) -> str:
			try:
				if isinstance(v, str):
					return v[:5000]
				return _json.dumps(v, default=str, ensure_ascii=False)[:5000]
			except (TypeError, ValueError):
				return str(v)[:5000]

		self.append(
			"edits",
			{
				"editor": actor or frappe.session.user,
				"edited_at": now_datetime(),
				"category": self.error_category or "",
				"field_path": (field_path or "")[:140],
				"reason": (reason or "")[:500],
				"before_value": _serialise(before_value),
				"after_value": _serialise(after_value),
			},
		)

	def append_activity(
		self,
		action: str,
		outcome: str,
		actor: str | None = None,
		detail: str | None = None,
	) -> None:
		"""Append a row to the activity child table.

		Callers MUST follow up with `self.save(ignore_permissions=...)` —
		this method only mutates the in-memory child list, so the audit
		row only persists when the parent save runs. That's intentional:
		the audit row commits in the SAME transaction as the parent state
		change, so we never end up with an audit-without-action or an
		action-without-audit.

		P2-21: each row is hash-chained to the previous one. prev_hash is
		the previous row's entry_hash (or 64 zeros for the first row).
		entry_hash is sha256(prev_hash | actor | at | action | outcome |
		detail). A tamper later (manager edits a row directly via DB)
		breaks the chain — `verify_activity_chain()` reports the gap.
		Both fields are read-only at the doctype level, so the only path
		to mutate them is via this method.
		"""
		actor_value = actor or frappe.session.user
		at_value = now_datetime()
		detail_value = (detail or "")[:500]

		# Find the previous row's entry_hash. We index off the in-memory
		# child list so multiple appends in the same save call chain to
		# each other, not to a stale DB read.
		prev_hash = ZERO_HASH
		if self.activity:
			prev_hash = self.activity[-1].entry_hash or ZERO_HASH

		entry_hash = _compute_entry_hash(
			prev_hash=prev_hash,
			actor=str(actor_value),
			at=str(at_value),
			action=action,
			outcome=outcome,
			detail=detail_value,
		)

		self.append(
			"activity",
			{
				"actor": actor_value,
				"at": at_value,
				"action": action,
				"outcome": outcome,
				"detail": detail_value,
				"prev_hash": prev_hash,
				"entry_hash": entry_hash,
			},
		)

	def verify_activity_chain(self) -> dict[str, Any]:
		"""Re-derive the hash chain and report the first break.

		Returns:
			{"ok": True, "rows": <count>}     when the chain is intact, OR
			{"ok": False, "rows": <count>, "first_break_idx": int,
			 "first_break_field_path": str, "expected": str, "actual": str}

		Used by the compliance export (P2-23) to surface tampering risk
		before the export is written. Cheap — recomputes O(n) hashes
		over the activity child list. Uses the SAME canonical encoding
		as `append_activity`, so a chain produced by appending will
		always re-verify by this method.
		"""
		expected_prev = ZERO_HASH
		for idx, row in enumerate(self.activity or []):
			recomputed = _compute_entry_hash(
				prev_hash=expected_prev,
				actor=str(row.actor or ""),
				at=str(row.at or ""),
				action=row.action or "",
				outcome=row.outcome or "",
				detail=row.detail or "",
			)
			# Two failure modes: the prev_hash claim or the entry_hash
			# can be tampered. We surface whichever is wrong first.
			if (row.prev_hash or "") != expected_prev:
				return {
					"ok": False,
					"rows": len(self.activity),
					"first_break_idx": idx,
					"first_break_field_path": f"activity[{idx}].prev_hash",
					"expected": expected_prev,
					"actual": row.prev_hash or "",
				}
			if (row.entry_hash or "") != recomputed:
				return {
					"ok": False,
					"rows": len(self.activity),
					"first_break_idx": idx,
					"first_break_field_path": f"activity[{idx}].entry_hash",
					"expected": recomputed,
					"actual": row.entry_hash or "",
				}
			expected_prev = recomputed
		return {"ok": True, "rows": len(self.activity or [])}

	def get_db_value(self, field: str) -> Any:
		"""Read the persisted value of a field, ignoring in-memory edits.

		Used by the validate() state-machine check so we compare against
		what's actually committed, not what the caller is trying to write.
		"""
		if self.is_new():
			return None
		return frappe.db.get_value(self.doctype, self.name, field)
