# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class POSpireOfflineSyncReviewActivity(Document):
	"""Append-only audit row.

	Rows are inserted by the parent POSpire Offline Sync Review's controller
	on every state transition (handoff, retry, void, note). They are never
	edited or deleted post-create — preventing edits is enforced at the
	parent level by treating this child as read-only in the form view, and
	by NOT exposing any whitelisted endpoint that mutates a row by name.
	"""

	pass
