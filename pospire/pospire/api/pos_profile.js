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

	refresh: function (frm) {
		set_denomination_query(frm);
		if (frm.doc.pospire_linked_device) {
			frm.add_custom_button(__("Unlink Device"), () => {
				frappe.prompt(
					{ fieldname: "reason", fieldtype: "Small Text", label: __("Reason"), reqd: 1 },
					(values) => {
						frappe
							.xcall("pospire.pospire.api.terminal_number.unlink_terminal_device", {
								pos_profile: frm.doc.name,
								reason: values.reason,
							})
							.then(() => frm.reload_doc());
					},
					__("Unlink Device")
				);
			});
		}
		if (frm.is_new() && !frm.doc.pospire_invoice_prefix) {
			// Suggestion only: the manager types the actual prefix.
			frappe.db
				.get_list("POS Profile", { fields: ["pospire_invoice_prefix"], limit: 0 })
				.then((rows) => {
					const used = new Set(rows.map((r) => r.pospire_invoice_prefix));
					for (let i = 1; i < 100; i++) {
						const p = "T" + String(i).padStart(2, "0");
						if (!used.has(p)) {
							frm.set_df_property("pospire_invoice_prefix", "placeholder", p);
							break;
						}
					}
				});
		}
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

	custom_enable_cash_denominations(frm) {
		if (!frm.doc.custom_enable_cash_denominations) return;

		if (!frm.doc.currency) {
			frappe.msgprint(
				__("Please set the Profile Currency before enabling Cash Denominations.")
			);
			frm.set_value("custom_enable_cash_denominations", 0);
			return;
		}

		frappe.db
			.count("POS Denomination", {
				filters: { currency: frm.doc.currency, enabled: 1 },
			})
			.then((count) => {
				if (!count) {
					frappe.msgprint(
						__(
							"No active POS Denomination records found for currency {0}. Please create denominations first.",
							[frm.doc.currency]
						)
					);
					frm.set_value("custom_enable_cash_denominations", 0);
				}
			});
	},

	validate(frm) {
		if (frm.doc.custom_enable_cash_denominations) {
			const rows = frm.doc.custom_denominations || [];
			if (!rows.length) {
				frappe.msgprint(
					__(
						"Cash Denominations are enabled but no denomination rows are configured. Please add denominations or disable the feature."
					)
				);
				frm.set_value("custom_enable_cash_denominations", 0);
				frappe.validated = false;
			}
		}
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
