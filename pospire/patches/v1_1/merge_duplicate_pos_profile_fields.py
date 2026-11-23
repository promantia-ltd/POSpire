# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Merge POSpire's duplicate POS Profile checkboxes into ERPNext's own fields.

POSpire shipped four Custom Fields that duplicated standard POS Profile
fields. Three had the same label, so each showed up twice on the form
(#33943); the fourth does the same job under a slightly different label:

    posa_display_items_in_stock            ->  hide_unavailable_items
    posa_allow_user_to_edit_rate           ->  allow_rate_change
    posa_allow_partial_payment             ->  allow_partial_payment
    posa_allow_user_to_edit_item_discount  ->  allow_discount_change

POSpire now reads the standard fields. This patch carries each profile's
existing choice over, then deletes the Custom Fields. Fixture sync never
deletes records dropped from a fixture file, so without this the duplicates
would stay on every upgraded site.

Order matters: copy first, delete second. The copy runs only while the old
column still exists, so running the patch twice is harmless.
"""

import frappe

FIELD_MAP = {
	"posa_display_items_in_stock": "hide_unavailable_items",
	"posa_allow_user_to_edit_rate": "allow_rate_change",
	"posa_allow_partial_payment": "allow_partial_payment",
	"posa_allow_user_to_edit_item_discount": "allow_discount_change",
}


def execute():
	for old, new in FIELD_MAP.items():
		if frappe.db.has_column("POS Profile", old) and frappe.db.has_column("POS Profile", new):
			# Identifiers come from the constant map above, never from user input.
			frappe.db.sql(f"UPDATE `tabPOS Profile` SET `{new}` = `{old}`")  # nosemgrep

		frappe.delete_doc("Custom Field", f"POS Profile-{old}", ignore_missing=True, force=True)

	frappe.clear_cache(doctype="POS Profile")
