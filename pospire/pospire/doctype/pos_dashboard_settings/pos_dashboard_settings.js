// Copyright (c) 2026, Promantia Business Solutions PVT Ltd and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Dashboard Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Load Default Layout"), () => {
			load_default_dashboard_layout(frm);
		});
	},
});

async function load_default_dashboard_layout(frm) {
	const has_rows = (frm.doc.widgets || []).length > 0;
	if (has_rows) {
		const confirmed = await confirm_replace_existing_layout();
		if (!confirmed) return;
	}

	let response;
	try {
		response = await frappe.call({
			method: "pospire.pospire.api.dashboard.get_default_dashboard_layout_for_settings",
		});
	} catch (error) {
		console.error("[POS Dashboard Settings] failed to load default layout", error);
		frappe.msgprint({
			title: __("Unable to Load Layout"),
			message: __("Unable to load the default dashboard layout."),
			indicator: "red",
		});
		return;
	}

	const rows = response.message || [];

	frm.clear_table("widgets");
	rows.forEach((row) => {
		const child = frm.add_child("widgets");
		child.widget_type = row.widget_type;
		child.data_key = row.data_key;
		child.variant = row.variant;
		child.enabled = row.enabled;
		child.title = row.title;
		child.icon = row.icon;
		child.column_span = row.column_span;
	});

	frm.refresh_field("widgets");
	frm.dirty();
}

function confirm_replace_existing_layout() {
	return new Promise((resolve) => {
		frappe.confirm(
			__(
				"Loading the default dashboard layout will replace the existing widget rows in this form. This will not be saved until you click Save. Continue?"
			),
			() => resolve(true),
			() => resolve(false)
		);
	});
}
