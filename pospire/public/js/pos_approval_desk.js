// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// Desk-side approval notification handler (Phase 3).
// Registers a realtime listener so managers receive POS approval
// toast notifications when a cashier requests remote approval.
//
// Phase 3 stub — listener registered but toast UI wired in Phase 3.

frappe.ready(function () {
	frappe.realtime.on("pos_approval_request", function (data) {
		// Full toast implementation added in Phase 3.
		// Stub ensures no JS errors when the event fires during Phase 1/2 testing.
		if (frappe.boot && frappe.boot.user && frappe.boot.user.name) {
			console.log("[POSpire] POS approval request received:", data.request_name); // noqa
		}
	});
});
