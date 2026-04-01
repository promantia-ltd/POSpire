import os

import frappe
from frappe.modules import get_module_path, scrub

OBSOLETE_STOCK_CHART_SOURCE = "Stock Value by Item Group"


def _get_chart_source_js_path(module: str, source_name: str) -> str:
	return os.path.join(
		get_module_path(module),
		"dashboard_chart_source",
		scrub(source_name),
		f"{scrub(source_name)}.js",
	)


def execute() -> None:
	"""Remove stale Stock dashboard chart records whose source files no longer exist."""
	if not frappe.db.exists("Dashboard Chart Source", OBSOLETE_STOCK_CHART_SOURCE):
		return

	source = frappe.db.get_value(
		"Dashboard Chart Source",
		OBSOLETE_STOCK_CHART_SOURCE,
		["module", "source_name"],
		as_dict=True,
	)
	if not source or source.module != "Stock":
		return

	js_path = _get_chart_source_js_path(source.module, source.source_name or OBSOLETE_STOCK_CHART_SOURCE)
	if os.path.exists(js_path):
		return

	for chart_name in frappe.get_all(
		"Dashboard Chart",
		filters={"source": OBSOLETE_STOCK_CHART_SOURCE, "module": "Stock"},
		pluck="name",
	):
		frappe.delete_doc("Dashboard Chart", chart_name, ignore_permissions=True)

	frappe.delete_doc(
		"Dashboard Chart Source",
		OBSOLETE_STOCK_CHART_SOURCE,
		ignore_permissions=True,
	)
