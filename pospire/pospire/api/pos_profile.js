// Copyright (c) 20201 Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Profile", {
	setup: function (frm) {
		frm.set_query("posa_cash_mode_of_payment", function (doc) {
			return {
				filters: { type: "Cash" },
			};
		});
	},

	refresh: function (frm) {
		// Hardware manager section is always visible
		// The checkbox enables/disables hardware manager functionality
		set_denomination_query(frm);
	},
    currency(frm) {
        set_denomination_query(frm);
    }
});
function set_denomination_query(frm) {
    if (!frm.fields_dict.custom_denominations) return;

    frm.fields_dict.custom_denominations.grid
        .get_field("denomination")
        .get_query = function () {
            console.log("Parent currency:", frm.doc.currency);
            if (!frm.doc.currency) {
                return {};
            }
            return {
                filters: {
                    currency: frm.doc.currency,
                    enabled: 1
                }
            };
        };
}