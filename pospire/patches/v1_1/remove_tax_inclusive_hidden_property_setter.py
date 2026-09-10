# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Drop the Property Setter that used to hide POS Profile.posa_tax_inclusive.

The field is now visible via the Custom Field itself. Fixture sync never
deletes records dropped from a fixture file, so sites installed before this
change keep the old setter and the field stays hidden.

Also backfills posa_tax_inclusive to 1 as a safety net.

In normal cases this matches no rows. Frappe puts the field's own
default into the ADD COLUMN statement, so the column is created as
NOT NULL DEFAULT 1 and the database fills existing rows with 1 at
that moment. Profiles older than the field are already correct.

It only matters in one edge case: a site where the column was created
while the field had no default and the default was added afterwards,
because ALTER COLUMN SET DEFAULT does not touch rows that already
exist. Cheap to keep, so we keep it.
"""

import frappe


def execute():
	frappe.delete_doc(
		"Property Setter",
		"POS Profile-posa_tax_inclusive-hidden",
		ignore_missing=True,
		force=True,
	)
	frappe.clear_cache(doctype="POS Profile")

	if frappe.db.has_column("POS Profile", "posa_tax_inclusive"):
		frappe.db.sql("update `tabPOS Profile` set posa_tax_inclusive = 1 where posa_tax_inclusive = 0")
