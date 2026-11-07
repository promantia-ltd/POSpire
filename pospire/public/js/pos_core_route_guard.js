// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// Redirects the ERPNext Core POS routes to POSpire before the desk renders
// them: the "point-of-sale" Page and each Core POS DocType's list slug (e.g.
// "pos-invoice"), sent by boot.py as frappe.boot.core_pos_blocked_routes.
// The desk router builds DocType slugs from bootinfo.user.can_read, which
// boot.py deliberately leaves unfiltered, and asks the server for the page
// even after boot hides it, so the route change itself is intercepted here.

frappe.provide("frappe.router");

(function () {
	var blocked_routes = frappe.boot.core_pos_blocked_routes || [];

	if (!blocked_routes.length || typeof frappe.router.route !== "function") {
		return;
	}

	var blocked_set = new Set(blocked_routes);
	var original_route = frappe.router.route;

	frappe.router.route = function () {
		var sub_path = frappe.router.get_sub_path() || "";
		var first_segment = sub_path.split("/")[0];

		if (blocked_set.has(first_segment)) {
			frappe.msgprint({
				title: __("Not Allowed"),
				message: __("The page has been disabled. Please use POSpire."),
				indicator: "red",
			});
			frappe.set_route("pospire");
			return;
		}

		return original_route.apply(frappe.router, arguments);
	};
})();
