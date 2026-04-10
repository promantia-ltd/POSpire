# Copyright (c) 2026, Rajit and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cstr


class POSDenomination(Document):
	def validate(self):
		if self.denomination_value <= 0:
			frappe.throw(_("Denomination value must be greater than zero"))

	def autoname(self):
		self.name = f"{cstr(self.currency)}-{cstr(self.denomination_value)}"
