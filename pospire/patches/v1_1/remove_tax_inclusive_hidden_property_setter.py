# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Drop the Property Setter that used to hide POS Profile.posa_tax_inclusive.

The field is now visible via the Custom Field itself. Fixture sync never
deletes records dropped from a fixture file, so sites installed before this
change keep the old setter and the field stays hidden.

Also backfills posa_tax_inclusive to 1 on POS Profiles created before this
field existed. The field's own "default": "1" only applies to newly inserted
rows, so a pre-existing profile sits at 0 - Check fields get a NOT NULL
DEFAULT 0 column, they are never actually NULL. The frontend used to hardcode
tax-inclusive behaviour regardless of this field, so a profile at 0 silently
switching to tax-exclusive would change real invoice totals with no warning.

Safe to backfill unconditionally at 0: before this change the field was
hidden and had no effect, so no site could have deliberately unchecked it.
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

	frappe.db.sql("update `tabPOS Profile` set posa_tax_inclusive = 1 where posa_tax_inclusive = 0")
