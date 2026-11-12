# Copyright (c) 2026, Rajit and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from pospire.pospire.api.terminal_number import validate_prefix


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

	validate_prefix(doc)
	_keep_device_link(doc)
	_validate_approval_actions(doc)


_DEVICE_LINK_FIELDS = ("pospire_linked_device", "pospire_floor_fy", "pospire_floor_number")


def _keep_device_link(doc):
	"""Server-owned: only claim_terminal and unlink_terminal_device move them (with db.set_value).
	A REST/form save keeps the stored values, so neither a user with POS Profile write nor a form
	opened before the till was claimed can unlink it or lower its number floor."""
	# By name, not is_new(): a profile not saved yet reads as nothing, so it starts unlinked.
	name = doc.get("name")
	saved = name and frappe.db.get_value("POS Profile", name, _DEVICE_LINK_FIELDS, as_dict=True)
	for field in _DEVICE_LINK_FIELDS:
		setattr(doc, field, (saved or {}).get(field))


def _validate_approval_actions(doc):
	"""Run the POS Approval Action rules from the parent.

	Frappe never invokes a child DocType's validate() on parent save --
	Document.run_before_save_methods() calls run_method("validate") on the parent
	only, and run_method() does not cascade to children. Driving the child rules
	from here is what makes them actually enforced on save.
	"""
	for row in doc.get("posa_approval_actions") or []:
		row.validate()
