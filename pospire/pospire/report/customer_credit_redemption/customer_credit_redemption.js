// Copyright (c) 2025, promantia business solutions
// For license information, please see license.txt

frappe.query_reports["Customer Credit Redemption"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			default: frappe.defaults.get_user_default("Company"),
			reqd: 0,
		},
		{
			fieldname: "customer",
			label: __("Customer"),
			fieldtype: "Link",
			options: "Customer",
			reqd: 0,
		},
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_months(frappe.datetime.get_today(), -1),
			reqd: 0,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 0,
		},
		{
			fieldname: "new_invoice",
			label: __("New Invoice"),
			fieldtype: "Link",
			options: "Sales Invoice",
			reqd: 0,
		},
		{
			fieldname: "credit_note",
			label: __("Credit Note"),
			fieldtype: "Link",
			options: "Sales Invoice",
			get_query: function () {
				return {
					filters: {
						is_return: 1,
						docstatus: 1,
					},
				};
			},
			reqd: 0,
		},
	],
};
