// Copyright (c) 20201 Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("Payment Entry", {
	setup: function (frm) {
		set_pos_opening_shift_query(frm);
	},

	company: function (frm) {
		set_pos_opening_shift_query(frm);
		frm.refresh_field("custom_pos_opening_shift");
	},
});

function set_pos_opening_shift_query(frm) {
	frm.set_query("custom_pos_opening_shift", function (doc) {
		return {
			filters: {
				company: doc.company,
				status: "Open",
				docstatus: 1,
			},
		};
	});
}
