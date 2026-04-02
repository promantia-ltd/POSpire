# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

TERMINAL_STATUSES = {"Approved", "Rejected", "Expired", "Cancelled"}


class POSApprovalRequest(Document):
	def before_insert(self) -> None:
		if not self.requested_by:
			self.requested_by = frappe.session.user
		if not self.requested_at:
			self.requested_at = frappe.utils.now_datetime()

	def validate(self) -> None:
		if self.resolved_by and self.resolved_by == self.requested_by:
			frappe.throw(_("Approver cannot be the same as the requestor (no self-approval)."))
