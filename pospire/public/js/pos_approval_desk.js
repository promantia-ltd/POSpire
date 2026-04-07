// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// Desk-side approval notification handler.
// Shows actionable Approve/Reject dialog to managers when a cashier requests remote approval.

(function register_pos_approval_listener() {
	if (frappe.realtime && frappe.realtime.socket) {
		frappe.realtime.socket.on("pos_approval_request", function (data) {
			_show_approval_dialog(data);
		});
	} else {
		setTimeout(register_pos_approval_listener, 500);
	}
})();

function _show_approval_dialog(data) {
	var cashier = data.requested_by_full_name || data.requested_by || __("A cashier");
	var action = data.action_type || "";
	var item = data.item_name ? " — " + data.item_name : "";

	var value_line = "";
	if (data.original_value !== null && data.original_value !== undefined) {
		value_line =
			"<div style='margin:8px 0; padding:6px 10px; background:#f5f5f5; border-radius:4px; font-size:13px;'>" +
			(data.value_field_label ? "<strong>" + data.value_field_label + ":</strong> " : "") +
			"<span style='text-decoration:line-through;color:#888'>" + data.original_value + "</span>" +
			" → " +
			"<strong>" + data.requested_value + "</strong>" +
			"</div>";
	}

	var d = new frappe.ui.Dialog({
		title: __("Approval Request"),
		fields: [
			{
				fieldtype: "HTML",
				options:
					"<div style='padding:4px 0'>" +
					"<div style='font-weight:600;font-size:14px'>" + cashier + "</div>" +
					"<div style='color:#555;margin:2px 0'>" + action + item + "</div>" +
					value_line +
					"</div>",
			},
			{
				fieldtype: "Small Text",
				fieldname: "resolution_note",
				label: __("Resolution Note (optional)"),
			},
		],
		primary_action_label: __("Approve"),
		primary_action: function () {
			_resolve(data.request_name, "Approved", d.get_value("resolution_note"));
			d.hide();
		},
		secondary_action_label: __("Reject"),
		secondary_action: function () {
			_resolve(data.request_name, "Rejected", d.get_value("resolution_note"));
			d.hide();
		},
	});
	d.show();
}

function _resolve(request_name, action, resolution_note) {
	frappe.call({
		method: "pospire.pospire.api.approval.resolve_approval_request",
		args: {
			request_name: request_name,
			action: action,
			resolution_note: resolution_note || null,
		},
		callback: function (r) {
			if (!r.exc) {
				frappe.show_alert(
					{
						message: __(action === "Approved" ? "Request approved" : "Request rejected"),
						indicator: action === "Approved" ? "green" : "red",
					},
					5
				);
			}
		},
	});
}
