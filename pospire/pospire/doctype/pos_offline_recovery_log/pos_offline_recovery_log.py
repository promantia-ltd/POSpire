# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""POS Offline Recovery Log — immutable audit record.

Journal blobs are captured when a POS device enters corruption safe mode and
are uploaded via `pospire.pospire.api.offline.submit_recovery_log`. The record
is append-only: managers may only amend the review fields through a dedicated
resolution flow that re-inserts a new row. See docs/offline/12-server-side-changes.md §4.8.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

# Fields a manager may change post-insert (review workflow); everything else is frozen.
_MUTABLE_REVIEW_FIELDS: frozenset[str] = frozenset({"reviewed_by", "reviewed_at", "resolution_notes"})


class POSOfflineRecoveryLog(Document):
	def before_save(self) -> None:
		# Reject edits on the immutable audit surface. We still let managers
		# append review metadata, but the captured journal and device attribution
		# cannot be rewritten.
		if self.is_new():
			return

		before = self.get_doc_before_save()
		if before is None:
			return

		changed = {
			fieldname
			for fieldname in ("device_id", "recovered_at", "journal_blob")
			if (self.get(fieldname) or "") != (before.get(fieldname) or "")
		}
		if changed:
			frappe.throw(
				_("POS Offline Recovery Log is immutable. Cannot modify: {0}").format(
					", ".join(sorted(changed))
				),
				frappe.PermissionError,
			)


def prevent_delete(doc, method=None) -> None:
	"""Hook target: disallow deletion of recovery records."""
	# System Manager has delete in DocType permissions for cleanup of erroneous
	# test data; in production, deletions should be blocked. Gate on a flag so
	# tooling can opt in explicitly.
	if getattr(frappe.flags, "allow_pos_recovery_log_delete", False):
		return
	frappe.throw(
		_("POS Offline Recovery Log records are immutable and cannot be deleted."),
		frappe.PermissionError,
	)
