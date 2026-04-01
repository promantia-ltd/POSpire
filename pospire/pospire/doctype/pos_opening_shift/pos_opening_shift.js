// Copyright (c) 2020, Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Opening Shift", {
	setup(frm) {
		if (frm.doc.docstatus == 0) {
			frm.trigger("set_posting_date_read_only");
			frm.set_value("period_start_date", frappe.datetime.now_datetime());
			frm.set_value("user", frappe.session.user);
		}
		frm.set_query("user", function (doc) {
			return {
				query: "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.get_cashiers",
				filters: { parent: doc.pos_profile },
			};
		});
		frm.set_query("pos_profile", function (doc) {
			return {
				filters: { company: doc.company },
			};
		});
	},

	refresh(frm) {
		// set default posting date / time
		if (frm.doc.docstatus == 0) {
			if (!frm.doc.posting_date) {
				frm.set_value("posting_date", frappe.datetime.nowdate());
			}
			frm.trigger("set_posting_date_read_only");
		}
	},

	set_posting_date_read_only(frm) {
		if (frm.doc.docstatus == 0 && frm.doc.set_posting_date) {
			frm.set_df_property("posting_date", "read_only", 0);
		} else {
			frm.set_df_property("posting_date", "read_only", 1);
		}
	},

	set_posting_date(frm) {
		frm.trigger("set_posting_date_read_only");
	},

	pos_profile: (frm) => {
		if (frm.doc.pos_profile) {
			frappe.db.get_doc("POS Profile", frm.doc.pos_profile).then((doc) => {
				// Balance Details
				if (doc.payments && doc.payments.length) {
					frm.clear_table("balance_details");

					doc.payments.forEach(({ mode_of_payment }) => {
						frm.add_child("balance_details", { mode_of_payment });
					});

					frm.refresh_field("balance_details");
				}
				frm.clear_table("denomination_details");

				if (doc.custom_enable_cash_denominations) {
					(doc.custom_denominations || []).forEach((d) => {
						let row = frm.add_child("denomination_details");
						row.denomination = d.denomination;
						row.denomination_value = d.denomination_value;
						row.currency = d.currency;
						row.quantity = 0;
						row.amount = 0;
					});
				}
				frm.refresh_field("denomination_details");
			});
		}
	},
});
frappe.ui.form.on("POS Opening Denomination", {
	quantity(frm, cdt, cdn) {
		let row = locals[cdt][cdn];
		frappe.model.set_value(
			cdt,
			cdn,
			"amount",
			(row.denomination_value || 0) * (row.quantity || 0)
		);
	},
});
