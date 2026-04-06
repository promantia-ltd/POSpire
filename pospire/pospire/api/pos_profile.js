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
		set_denomination_query(frm);
	},

	currency(frm) {
		set_denomination_query(frm);
	},

	custom_enable_cash_denominations(frm) {
		if (!frm.doc.custom_enable_cash_denominations) return;

		if (!frm.doc.currency) {
			frappe.msgprint(__("Please set the Profile Currency before enabling Cash Denominations."));
			frm.set_value("custom_enable_cash_denominations", 0);
			return;
		}

		frappe.db.count("POS Denomination", {
			filters: { currency: frm.doc.currency, enabled: 1 }
		}).then((count) => {
			if (!count) {
				frappe.msgprint(
					__("No active POS Denomination records found for currency {0}. Please create denominations first.", [frm.doc.currency])
				);
				frm.set_value("custom_enable_cash_denominations", 0);
			}
		});
	},

	validate(frm) {
		if (frm.doc.custom_enable_cash_denominations) {
			const rows = frm.doc.custom_denominations || [];
			if (!rows.length) {
				frappe.msgprint(__("Cash Denominations are enabled but no denomination rows are configured. Please add denominations or disable the feature."));
				frm.set_value("custom_enable_cash_denominations", 0);
				frappe.validated = false;
			}
		}
	},
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