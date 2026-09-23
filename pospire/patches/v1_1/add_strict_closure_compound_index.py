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

Idempotent: checks `INFORMATION_SCHEMA.STATISTICS` before creating, so
re-running `bench migrate` is a no-op once the index exists.
"""

import frappe

INDEX_NAME = "pospire_strict_closure_idx"
TABLE = "tabSales Invoice"


def execute() -> None:
	# Skip silently if the column is missing (test sites that haven't run the
	# offline custom-field migration yet — the index will land when those
	# fields exist).
	columns = {c.lower() for c in frappe.db.get_table_columns("Sales Invoice")}
	if "pos_opening_shift_offline_id" not in columns:
		frappe.logger().info("[B1] skipping strict-closure index: pos_opening_shift_offline_id missing")
		return

	if _index_exists(TABLE, INDEX_NAME):
		return

	# `frappe.db.add_index` would auto-name the index, but we want a stable
	# name we can reference from the rollback patch and from operator
	# runbooks. Drop to raw SQL. INDEX_NAME and TABLE are module-level
	# constants (no user input), so the f-string is safe.
	frappe.db.sql(  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-sql-format-injection
		f"""
		CREATE INDEX `{INDEX_NAME}`
		ON `{TABLE}` (`pos_opening_shift_offline_id`, `docstatus`)
		"""
	)
	frappe.db.commit()  # nosemgrep: frappe-semgrep-rules.rules.frappe-manual-commit -- DDL must commit; bench migrate wraps the patch and needs the index visible before the next patch runs.
	frappe.logger().info(f"[B1] created compound index {INDEX_NAME} on {TABLE}")


def _index_exists(table: str, index_name: str) -> bool:
	rows = frappe.db.sql(
		"""
		SELECT 1
		FROM INFORMATION_SCHEMA.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = %s
		  AND INDEX_NAME = %s
		LIMIT 1
		""",
		(table, index_name),
	)
	return bool(rows)
