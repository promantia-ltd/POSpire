import frappe


def execute():
	"""
	Remove custom_show_denomination_breakdown_at_closing from POS Profile.

	Denomination breakdown at closing is now always shown when cash denominations
	are enabled (custom_enable_cash_denominations). The separate toggle is no
	longer needed and is removed to simplify the POS Profile form.
	"""
	field_name = "POS Profile-custom_show_denomination_breakdown_at_closing"

	if frappe.db.exists("Custom Field", field_name):
		frappe.delete_doc("Custom Field", field_name, ignore_permissions=True)
		frappe.clear_cache(doctype="POS Profile")
