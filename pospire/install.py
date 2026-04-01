import frappe


def after_install():
	seed_default_denomination_data()


def fix_desktop_icon_on_boot(bootinfo):
	"""Ensure POSpire Desktop Icon uses Workspace Sidebar, not External.

	add_to_apps_screen creates the icon with link_type="External" on first desk
	load. This hook corrects it so the icon navigates to /desk/pospire (workspace)
	instead of opening /pospire in a new tab. Runs on every boot but is a no-op
	once the icon is already correct.
	"""
	icon = frappe.db.get_value(
		"Desktop Icon",
		{"label": "POSpire", "link_type": "External"},
		"name",
	)
	if icon:
		frappe.db.set_value("Desktop Icon", icon, {"link_type": "Workspace Sidebar", "link": None})

def seed_default_denomination_data():
    default_data={
        "INR":{
            "Note": [2000, 500, 200, 100, 50, 20, 10],
            "Coin": [5, 2, 1],
        },
        "USD":{
            "Note": [100, 50, 20, 10, 5, 1],
            "Coin": [0.25],
        },"EUR":{
            "Note":[500, 200, 100, 50, 20, 10, 5],
            "Coin":[2,1],
        },
        "GBP":{
            "Note":[50,20,10,5],
            "Coin":[2,1],
        },
    }

    for currency,types in default_data.items():
        for denomination_type, values in types.items():
            for value in values:
                name=f"{currency}-{int(value) if value % 1 ==0 else value}"

                if not frappe.db.exists("POS Denomination", name):
                    doc=frappe.get_doc({
                        "doctype":"POS Denomination",
                        "denomination_name":f"{value} {currency} {denomination_type}",
                        "denomination_value":value,
                        "denomination_type":denomination_type,
                        "currency":currency,
                        "display_order":int(value) if value % 1==0 else 0,
                        "enabled":1,
                    })
                    doc.insert(ignore_permissions=True)

    frappe.db.commit()