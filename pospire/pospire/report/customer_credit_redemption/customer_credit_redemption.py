# Copyright (c) 2025, promantia business solutions PVT LTD
# For license information, please see license.txt

import frappe
from frappe import _


def execute(filters=None):
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_columns():
	return [
		{
			"fieldname": "new_invoice",
			"label": _("New Invoice"),
			"fieldtype": "Link",
			"options": "Sales Invoice",
			"width": 140,
		},
		{"fieldname": "invoice_date", "label": _("Invoice Date"), "fieldtype": "Date", "width": 100},
		{
			"fieldname": "customer",
			"label": _("Customer"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 150,
		},
		{"fieldname": "invoice_total", "label": _("Invoice Total"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "credit_used", "label": _("Credit Used"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "outstanding", "label": _("Outstanding"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 100},
		{
			"fieldname": "credit_note",
			"label": _("Credit Note Used"),
			"fieldtype": "Link",
			"options": "Sales Invoice",
			"width": 140,
		},
		{
			"fieldname": "credit_amount",
			"label": _("Credit Note Amount"),
			"fieldtype": "Currency",
			"width": 130,
		},
		{
			"fieldname": "journal_entry",
			"label": _("Journal Entry"),
			"fieldtype": "Link",
			"options": "Journal Entry",
			"width": 140,
		},
		{"fieldname": "je_date", "label": _("JE Date"), "fieldtype": "Date", "width": 100},
		{
			"fieldname": "company",
			"label": _("Company"),
			"fieldtype": "Link",
			"options": "Company",
			"width": 150,
		},
	]


def get_data(filters):
	conditions = get_conditions(filters)

	query = """
        SELECT
            new_invoice.name as new_invoice,
            new_invoice.posting_date as invoice_date,
            new_invoice.customer as customer,
            new_invoice.grand_total as invoice_total,
            jea_credit.credit_in_account_currency as credit_used,
            new_invoice.outstanding_amount as outstanding,
            new_invoice.status as status,
            credit_note.name as credit_note,
            credit_note.grand_total as credit_amount,
            je.name as journal_entry,
            je.posting_date as je_date,
            new_invoice.company as company
        FROM `tabJournal Entry` je
        JOIN `tabJournal Entry Account` jea_credit
            ON jea_credit.parent = je.name
            AND jea_credit.credit_in_account_currency > 0
        JOIN `tabJournal Entry Account` jea_debit
            ON jea_debit.parent = je.name
            AND jea_debit.debit_in_account_currency > 0
        JOIN `tabSales Invoice` new_invoice
            ON new_invoice.name = jea_credit.reference_name
        JOIN `tabSales Invoice` credit_note
            ON credit_note.name = jea_debit.reference_name
            AND credit_note.is_return = 1
        WHERE je.docstatus = 1
            """
	query += conditions
	query += " ORDER BY je.posting_date DESC, je.creation DESC"

	data = frappe.db.sql(query, filters, as_dict=1)
	return data


def get_conditions(filters):
	conditions = []

	if filters.get("customer"):
		conditions.append("AND new_invoice.customer = %(customer)s")

	if filters.get("company"):
		conditions.append("AND new_invoice.company = %(company)s")

	if filters.get("from_date"):
		conditions.append("AND new_invoice.posting_date >= %(from_date)s")

	if filters.get("to_date"):
		conditions.append("AND new_invoice.posting_date <= %(to_date)s")

	if filters.get("new_invoice"):
		conditions.append("AND new_invoice.name = %(new_invoice)s")

	if filters.get("credit_note"):
		conditions.append("AND credit_note.name = %(credit_note)s")

	return " ".join(conditions)
