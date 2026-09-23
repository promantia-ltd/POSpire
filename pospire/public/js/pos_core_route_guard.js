// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// boot.py's getpage() override blocks direct navigation to the ERPNext Core
// POS *Page* named "point-of-sale" — but "pos-invoice" isn't a Page at all.
// It's Frappe's auto-generated route slug for the "POS Invoice" DocType's
// list view: frappe.router.setup() builds this.routes[slug(doctype)] from
// bootinfo.user.can_read, which boot.py deliberately leaves unfiltered (the
// desk router and other framework internals depend on it). DocType routes
// never call desk_page.getpage(), so they need a separate, client-side guard
// that intercepts the route change itself before the List view renders.

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
