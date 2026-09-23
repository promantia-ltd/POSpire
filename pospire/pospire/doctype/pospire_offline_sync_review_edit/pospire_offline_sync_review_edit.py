# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class POSpireOfflineSyncReviewEdit(Document):
	"""Append-only field-level audit row.

	Inserted by the parent doctype's `record_edit` helper on every
	manager-driven payload mutation. Rows are never edited or deleted
	post-create — the parent's controller treats this child as
	read-only in the form.
	"""

	pass
