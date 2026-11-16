# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

"""B1 — strict-closure compound index.

Adds a `(pos_opening_shift_offline_id, docstatus)` compound index to
`tabSales Invoice`. Targets the offline strict-closure check at sync time
(see `pospire/api/offline.py::_ensure_all_invoices_submitted`):

    SELECT name, pos_offline_id FROM `tabSales Invoice`
    WHERE pos_opening_shift_offline_id = %s
      AND pos_offline_id NOT IN (...)

The single-column `search_index` already declared on
`pos_opening_shift_offline_id` (custom_field.json) supports the leading
column lookup, but each matching row still needs a second probe to filter
on docstatus. For a shift with 1000 submitted invoices, that's 1000 row
reads per closing attempt — and the scheduler retries closings every few
seconds while invoices drain. Adding docstatus to the same compound index
lets MariaDB satisfy the closure check from the index alone.

Idempotent: `frappe.db.add_index` checks for the index by name before
creating it, so re-running `bench migrate` is a no-op once the index exists.
"""

import frappe

INDEX_NAME = "pospire_strict_closure_idx"


def execute() -> None:
	# Skip silently if the column is missing (test sites that haven't run the
	# offline custom-field migration yet — the index will land when those
	# fields exist).
	columns = {c.lower() for c in frappe.db.get_table_columns("Sales Invoice")}
	if "pos_opening_shift_offline_id" not in columns:
		frappe.logger().info("[B1] skipping strict-closure index: pos_opening_shift_offline_id missing")
		return

	# add_index commits pending writes before its DDL; a raw CREATE INDEX raised
	# ImplicitCommitError when run from after_migrate with writes still open.
	frappe.db.add_index("Sales Invoice", ["pos_opening_shift_offline_id", "docstatus"], INDEX_NAME)
