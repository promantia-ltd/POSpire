import frappe


def after_install():
	"""Run installation tasks."""
	seed_default_denomination_data()
	frappe.clear_cache()


def after_migrate():
	"""Refresh cached desk metadata after migrations."""
	frappe.clear_cache()


def fix_desktop_icon_on_boot(bootinfo):
	"""
	Correct known issues with the auto-created POSpire Desktop Icon.

	add_to_apps_screen (Frappe core) creates a Desktop Icon for every newly
	installed app with link_type="External" and icon_type="App":
	  - "External" opens /pospire in a new tab instead of navigating to the
	    desk workspace like the icon's siblings do.
	  - "App" icon_type is for icons that group several child workspaces
	    (e.g. "Framework"). POSpire has no child icons, so desktop.js's
	    click handler falls through to its single-workspace route-resolution
	    path — which, unlike Organization/Buying/Selling/Stock (the other
	    single-workspace icons here, all icon_type "Link"), never resolves
	    a route, showing "Icon is not correctly configured" on every click.
	"""
	icon = frappe.db.get_value(
		"Desktop Icon",
		{"label": "POSpire"},
		["name", "link_type", "icon_type"],
		as_dict=True,
	)

	if not icon:
		return

	updates = {}
	if icon.link_type == "External":
		updates["link_type"] = "Workspace Sidebar"
		updates["link"] = None
	if icon.icon_type == "App":
		updates["icon_type"] = "Link"

	if updates:
		frappe.db.set_value("Desktop Icon", icon.name, updates)

		# Ensure subsequent boots pick up the updated icon.
		frappe.clear_cache()


def seed_default_denomination_data():
	default_data = {
		"INR": {
			"Note": [2000, 500, 200, 100, 50, 20, 10],
			"Coin": [5, 2, 1],
		},
		"USD": {
			"Note": [100, 50, 20, 10, 5, 1],
			"Coin": [0.25],
		},
		"EUR": {
			"Note": [500, 200, 100, 50, 20, 10, 5],
			"Coin": [2, 1],
		},
		"GBP": {
			"Note": [50, 20, 10, 5],
			"Coin": [2, 1],
		},
	}

	for currency, types in default_data.items():
		for denomination_type, values in types.items():
			for value in values:
				name = f"{currency}-{int(value) if value % 1 == 0 else value}"

				if frappe.db.exists("POS Denomination", name):
					continue

				doc = frappe.get_doc(
					{
						"doctype": "POS Denomination",
						"denomination_name": f"{value} {currency} {denomination_type}",
						"denomination_value": value,
						"denomination_type": denomination_type,
						"currency": currency,
						"display_order": int(value) if value % 1 == 0 else 0,
						"enabled": 1,
					}
				)

				doc.insert(ignore_permissions=True)
