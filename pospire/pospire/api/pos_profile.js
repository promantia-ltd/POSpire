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
		if (frm.is_new()) {
			// Frappe places __newname (the Name prompt for autoname=Prompt) at the
			// bottom of whichever tab is currently active due to a rendering sequence
			// gap where field.frm is unset during initial layout render. Fix: start
			// on Main tab and hide the Name field when switching to other tabs.
			frm.set_active_tab && frm.set_active_tab(__("Main"));
			frm.page.main
				.off("click.pos_name_fix")
				.on("click.pos_name_fix", ".nav-tabs .nav-link", function () {
					if (!frm.is_new()) return;
					const clicked_tab = $(this).text().trim();
					frm.toggle_display("__newname", clicked_tab === __("Main"));
				});
			sync_profile_currency_from_company(frm);
		}
	},
	company(frm) {
		sync_profile_currency_from_company(frm, { force: true });
	},
	currency(frm) {
		set_denomination_query(frm);
	},
});

async function sync_profile_currency_from_company(frm, { force = false } = {}) {
	if (!frm.doc.company) return;
	if (!force && frm.doc.currency) return;

	const company_currency = await frappe.db.get_value(
		"Company",
		frm.doc.company,
		"default_currency"
	);
	const default_currency = company_currency?.message?.default_currency;

	if (default_currency && frm.doc.currency !== default_currency) {
		await frm.set_value("currency", default_currency);
	} else {
		set_denomination_query(frm);
	}
}

function set_denomination_query(frm) {
	if (!frm.fields_dict.custom_denominations) return;

	frm.fields_dict.custom_denominations.grid.get_field("denomination").get_query = function () {
		if (!frm.doc.currency) {
			return {};
		}
		return {
			filters: {
				currency: frm.doc.currency,
				enabled: 1,
			},
		};
	};
}
