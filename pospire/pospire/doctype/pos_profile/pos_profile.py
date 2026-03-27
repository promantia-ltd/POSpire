# Copyright (c) 2026, Rajit and contributors
# For license information, please see license.txt

import frappe
from frappe import _


def validate_pos_profile(doc, method):
	if doc.custom_assortment and doc.item_groups:
		frappe.throw(_("Please select either Assortment or Item Group, not both"))
	if doc.custom_assortment:
		assortment_company = frappe.db.get_value(
			"Assortment",
			doc.custom_assortment,
			"company",
		)

		if assortment_company and assortment_company != doc.company:
			frappe.throw(
				_("Assortment belongs to '{0}', but POS Profile belongs to '{1}'").format(
					assortment_company, doc.company
				)
			)
