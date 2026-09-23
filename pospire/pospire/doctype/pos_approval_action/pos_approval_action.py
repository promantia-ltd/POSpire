# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class POSApprovalAction(Document):
	def validate(self) -> None:
		if self.approval_mode != "Required":
			return
		pin = cint(self.pin_approval)
		remote = cint(self.remote_approval)
		if not pin and not remote:
			frappe.throw(
				_(
					"Action {0} is Required but neither Allow PIN Approval nor Allow Remote Approval is enabled."
				).format(self.action_type or _("this action"))
			)
		if remote and not self.approver_role:
			frappe.throw(
				_("Approver Role is required when Remote Approval is enabled for {0}.").format(
					self.action_type or _("this action")
				)
			)

	def before_save(self) -> None:
		if self.condition:
			self.condition_js = _normalize_condition_to_js(self.condition)
		else:
			self.condition_js = ""


def _normalize_condition_to_js(condition: str) -> str:
	"""Convert a Python boolean expression to its JavaScript equivalent.

	Handles the shared subset of operators valid in both Python and JS.
	The result is stored in condition_js for offline evaluation via expr-eval.
	"""
	return (
		condition.replace(" and ", " && ")
		.replace(" or ", " || ")
		.replace("not ", "!")
		.replace("True", "true")
		.replace("False", "false")
	)
