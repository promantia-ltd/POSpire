import frappe


def after_uninstall():
	clear_custom_fields_and_properties()


def clear_custom_fields_and_properties():
	fixtures = frappe.get_hooks("fixtures", app_name="pospire")
	for fixture in fixtures:
		if fixture.get("doctype") == "Custom Field":
			filters = fixture.get("filters")
			if filters:
				for filter in filters:
					frappe.db.delete("Custom Field", filter)
		if fixture.get("doctype") == "Property Setter":
			filters = fixture.get("filters")
			if filters:
				for filter in filters:
					frappe.db.delete("Property Setter", filter)

	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- uninstall runs outside request lifecycle
