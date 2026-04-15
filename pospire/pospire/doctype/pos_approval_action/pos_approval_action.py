# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class POSApprovalAction(Document):
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
