// Copyright (c) 20201 Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Approval Action", {
	remote_approval: function (frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (
			row.remote_approval &&
			row.approval_mode === "Required" &&
			!frm.doc.posa_enable_remote_approval
		) {
			frappe.show_alert(
				{
					message: __(
						"Remote Approval is enabled on this action but <strong>Enable Remote Approval</strong> is turned off at the profile level. Turn it on above to activate remote approval in the POS."
					),
					indicator: "orange",
				},
				8
			);
		}
	},
});

frappe.ui.form.on("POS Profile", {
	setup: function (frm) {
		frm.set_query("posa_cash_mode_of_payment", function (doc) {
			return {
				filters: { type: "Cash" },
			};
		});
	},

	custom_enable_cash_denominations: async function (frm) {
		if (!frm.doc.custom_enable_cash_denominations) return;

		if (!frm.doc.currency) {
			frm.set_value("custom_enable_cash_denominations", 0);
			frappe.msgprint(
				__(
					"Please set the Profile Currency before enabling Cash Denominations."
				)
			);
			return;
		}

		const result = await frappe.db.get_list("POS Denomination", {
			filters: { currency: frm.doc.currency, enabled: 1 },
			limit: 1,
		});

		if (!result || !result.length) {
			frm.set_value("custom_enable_cash_denominations", 0);
			frappe.msgprint(
				__(
					"No active denominations found for currency {0}. Please add denominations in the POS Denomination list before enabling this.",
					[frm.doc.currency]
				)
			);
		}
	},

	validate: function (frm) {
		if (
			frm.doc.custom_enable_cash_denominations &&
			!(frm.doc.custom_denominations && frm.doc.custom_denominations.length)
		) {
			frm.set_value("custom_enable_cash_denominations", 0);
			frappe.msgprint(
				__(
					"Cash Denominations have been disabled because no denominations were added to the table. Please add at least one denomination before enabling."
				)
			);
			frappe.validated = false;
		}
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
