# Copyright (c) 2026, Rajit and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Assortment(Document):
	def on_update(self):
		frappe.clear_cache()

	def validate(self):
		items = [d.item for d in self.assortment_items if d.item]

		if len(items) != len(set(items)):
			frappe.throw("Duplicate items are not allowed in Assortment")
			