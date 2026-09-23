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

	_validate_approval_actions(doc)


def _validate_approval_actions(doc):
	"""Run the POS Approval Action rules from the parent.

	Frappe never invokes a child DocType's validate() on parent save --
	Document.run_before_save_methods() calls run_method("validate") on the parent
	only, and run_method() does not cascade to children. Driving the child rules
	from here is what makes them actually enforced on save.
	"""
	for row in doc.get("posa_approval_actions") or []:
		row.validate()
