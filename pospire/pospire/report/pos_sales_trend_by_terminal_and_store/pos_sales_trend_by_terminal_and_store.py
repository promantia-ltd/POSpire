# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import formatdate


def execute(filters=None):
	filters = frappe._dict(filters or {})
	validate_filters(filters)
	invoice_names = get_permitted_invoice_names(filters)
	if not invoice_names:
		return get_columns([]), []

	profiles = get_profiles(invoice_names)
	columns = get_columns(profiles)
	data = get_data(invoice_names, profiles)
	chart = get_chart(profiles, data)
	return columns, data, None, chart


def validate_filters(filters):
	# Without company/date bounds this pulls every POS invoice the user can
	# see, across all time, into a single IN-list before it can be scoped -
	# fine on a small site, expensive on one with years of history.
	if not filters.get("company"):
		frappe.throw(_("Company is required"))
	if not filters.get("from_date") or not filters.get("to_date"):
		frappe.throw(_("From Date and To Date are required"))


def get_permitted_invoice_names(filters):
	# frappe.get_list enforces the current user's read permission for
	# Sales Invoice, so the terminal/store breakdown never includes rows
	# the requesting user isn't allowed to see.
	invoice_filters = {
		"docstatus": 1,
		"is_pos": 1,
		"is_return": 0,
		"company": filters.company,
		"posting_date": ["between", [filters.from_date, filters.to_date]],
	}
	return frappe.get_list("Sales Invoice", filters=invoice_filters, pluck="name", limit_page_length=0)


def get_profiles(invoice_names):
	# Built at runtime from whichever POS Profiles actually have sales on
	# this site, instead of hardcoding one site's terminal names - those
	# would always be 0 (or missing entirely) on every other site.
	rows = frappe.db.sql(
		"select distinct pos_profile from `tabSales Invoice` "
		"where name in %(names)s and pos_profile is not null order by pos_profile",
		{"names": invoice_names},
		as_list=1,
	)
	return [row[0] for row in rows]


def get_columns(profiles):
	columns = [{"fieldname": "date", "label": _("Date"), "fieldtype": "Date", "width": 120}]
	for profile in profiles:
		columns.append(
			{
				"fieldname": frappe.scrub(profile),
				"label": profile,
				"fieldtype": "Currency",
				"width": 150,
			}
		)
	return columns


def get_data(invoice_names, profiles):
	if not profiles:
		return []

	values = {"names": invoice_names}
	select_parts = ["posting_date as `date`"]
	for profile in profiles:
		fieldname = frappe.scrub(profile)
		param = f"profile_{fieldname}"
		select_parts.append(
			f"SUM(CASE WHEN pos_profile = %({param})s THEN base_grand_total ELSE 0 END) as `{fieldname}`"
		)
		values[param] = profile

	sql = (
		"SELECT " + ", ".join(select_parts) + " "
		"FROM `tabSales Invoice` "
		"WHERE name in %(names)s "
		"GROUP BY posting_date ORDER BY posting_date"
	)
	return frappe.db.sql(sql, values, as_dict=1)


def get_chart(profiles, data):
	if not profiles or not data:
		return None
	return {
		"data": {
			"labels": [formatdate(row["date"]) for row in data],
			"datasets": [
				{
					"name": profile,
					"values": [row[frappe.scrub(profile)] for row in data],
				}
				for profile in profiles
			],
		},
		"type": "line",
	}
