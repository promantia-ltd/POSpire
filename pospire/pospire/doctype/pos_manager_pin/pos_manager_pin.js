// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Manager PIN", {
	refresh(frm) {
		frm.set_intro(
			__(
				"The PIN is auto-generated and emailed directly to the manager. It is never visible here. Use Regenerate PIN to issue a new one."
			),
			"blue"
		);

		if (!frm.is_new()) {
			frm.add_custom_button(__("Regenerate PIN"), () => {
				frappe.confirm(
					__(
						"This will invalidate the current PIN and email a new one to {0}. Continue?",
						[frm.doc.user]
					),
					() => {
						frappe.call({
							method: "pospire.pospire.api.approval.regenerate_pin",
							args: { user: frm.doc.user },
							callback(r) {
								if (!r.exc) {
									frappe.show_alert({
										message: __("New PIN sent to {0}", [frm.doc.user]),
										indicator: "green",
									});
								}
							},
						});
					}
				);
			});
		}
	},
});
