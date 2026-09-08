# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# For license information, please see license.txt

import frappe
from frappe import _


def execute(filters=None):
	filters = frappe._dict(filters or {})
	validate_filters(filters)
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def validate_filters(filters):
	if not filters.get("company"):
		frappe.throw(_("Company is required"))
	if not filters.get("from_date") or not filters.get("to_date"):
		frappe.throw(_("From Date and To Date are required"))


def get_data(filters):
	# frappe.get_list enforces the current user's read permission and any
	# user-permission restrictions (e.g. on Company) for Sales Invoice.
	# A raw frappe.db.sql query bypasses that entirely, which is what let
	# any POS User see every company's data regardless of who was asking.
	invoice_filters = {
		"docstatus": 1,
		"is_pos": 1,
		"company": filters.company,
		"posting_date": ["between", [filters.from_date, filters.to_date]],
	}
	if filters.get("pos_profile"):
		invoice_filters["pos_profile"] = filters.pos_profile
	if filters.get("customer_group"):
		invoice_filters["customer_group"] = filters.customer_group

	permitted_invoices = frappe.get_list(
		"Sales Invoice", filters=invoice_filters, pluck="name", limit_page_length=0
	)
	if not permitted_invoices:
		return []

	conditions = ["si.name in %(invoices)s"]
	values = {"invoices": permitted_invoices}
	if filters.get("brand"):
		conditions.append("sii.brand = %(brand)s")
		values["brand"] = filters.brand

	where_clause = " AND ".join(conditions)

	sql = (
		"SELECT "
		"si.name as pos_invoice, "
		"si.posting_date, "
		"si.customer, "
		"si.customer_name, "
		"si.company as organization, "
		"si.territory, "
		"si.tax_id, "
		"si.debit_to as receivable_account, "
		"(SELECT GROUP_CONCAT(DISTINCT sip.mode_of_payment SEPARATOR ', ') FROM `tabSales Invoice Payment` sip "
		"WHERE sip.parent = si.name AND sip.parenttype = 'Sales Invoice') as mode_of_payment, "
		"si.pos_profile, "
		"si.customer_group as customer_category, "
		"si.project, "
		"si.cost_center, "
		"si.currency, "
		"sii.item_code, "
		"sii.item_name, "
		"sii.item_group as item_category, "
		"sii.brand, "
		"sii.warehouse, "
		"sii.sales_order, "
		"sii.delivery_note, "
		"sii.qty, "
		"sii.uom, "
		"sii.rate, "
		"sii.amount, "
		"si.net_total, "
		"si.total_taxes_and_charges as tax_total, "
		"si.grand_total, "
		"si.rounded_total, "
		"si.outstanding_amount, "
		"si.remarks, "
		"si.owner "
		"FROM `tabSales Invoice` si "
		"INNER JOIN `tabSales Invoice Item` sii ON sii.parent = si.name "
		"WHERE " + where_clause + " "
		"ORDER BY si.posting_date DESC, si.name"
	)

	return frappe.db.sql(sql, values, as_dict=1)


def get_columns():
	return [
		{"fieldname": "pos_invoice", "label": _("POS Invoice"), "fieldtype": "Link", "options": "Sales Invoice", "width": 130},
		{"fieldname": "posting_date", "label": _("Posting Date"), "fieldtype": "Date", "width": 90},
		{"fieldname": "customer", "label": _("Customer"), "fieldtype": "Link", "options": "Customer", "width": 120},
		{"fieldname": "customer_name", "label": _("Customer Name"), "fieldtype": "Data", "width": 120},
		{"fieldname": "organization", "label": _("Organization"), "fieldtype": "Link", "options": "Company", "width": 120},
		{"fieldname": "territory", "label": _("Territory"), "fieldtype": "Link", "options": "Territory", "width": 90},
		{"fieldname": "tax_id", "label": _("Tax Id"), "fieldtype": "Data", "width": 90},
		{"fieldname": "receivable_account", "label": _("Receivable Account"), "fieldtype": "Link", "options": "Account", "width": 110},
		{"fieldname": "mode_of_payment", "label": _("Mode Of Payment"), "fieldtype": "Data", "width": 120},
		{"fieldname": "pos_profile", "label": _("POS Profile"), "fieldtype": "Link", "options": "POS Profile", "width": 120},
		{"fieldname": "customer_category", "label": _("Customer Category"), "fieldtype": "Link", "options": "Customer Group", "width": 120},
		{"fieldname": "project", "label": _("Project"), "fieldtype": "Link", "options": "Project", "width": 90},
		{"fieldname": "cost_center", "label": _("Cost Center"), "fieldtype": "Link", "options": "Cost Center", "width": 100},
		{"fieldname": "currency", "label": _("Currency"), "fieldtype": "Data", "width": 80},
		{"fieldname": "item_code", "label": _("Item Code"), "fieldtype": "Link", "options": "Item", "width": 120},
		{"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 140},
		{"fieldname": "item_category", "label": _("Item Category"), "fieldtype": "Link", "options": "Item Group", "width": 120},
		{"fieldname": "brand", "label": _("Brand"), "fieldtype": "Link", "options": "Brand", "width": 100},
		{"fieldname": "warehouse", "label": _("Warehouse"), "fieldtype": "Link", "options": "Warehouse", "width": 100},
		{"fieldname": "sales_order", "label": _("Sales Order"), "fieldtype": "Link", "options": "Sales Order", "width": 100},
		{"fieldname": "delivery_note", "label": _("Delivery Note"), "fieldtype": "Link", "options": "Delivery Note", "width": 110},
		{"fieldname": "qty", "label": _("Qty"), "fieldtype": "Float", "width": 80},
		{"fieldname": "uom", "label": _("UOM"), "fieldtype": "Link", "options": "UOM", "width": 80},
		{"fieldname": "rate", "label": _("Rate"), "fieldtype": "Currency", "width": 100},
		{"fieldname": "amount", "label": _("Amount"), "fieldtype": "Currency", "width": 110},
		{"fieldname": "net_total", "label": _("Net Total"), "fieldtype": "Currency", "width": 110},
		{"fieldname": "tax_total", "label": _("Tax Total"), "fieldtype": "Currency", "width": 100},
		{"fieldname": "grand_total", "label": _("Grand Total"), "fieldtype": "Currency", "width": 110},
		{"fieldname": "rounded_total", "label": _("Rounded Total"), "fieldtype": "Currency", "width": 110},
		{"fieldname": "outstanding_amount", "label": _("Outstanding Amount"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "remarks", "label": _("Remarks"), "fieldtype": "Data", "width": 140},
		{"fieldname": "owner", "label": _("Created By"), "fieldtype": "Data", "width": 120},
	]
