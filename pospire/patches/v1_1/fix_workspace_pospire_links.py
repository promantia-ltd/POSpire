import frappe


def execute() -> None:
	"""Migrate workspace links from legacy posapp desk page to Vue SPA route."""
	if not frappe.db.exists("Workspace", "POSpire"):
		return

	doc = frappe.get_doc("Workspace", "POSpire")
	changed = False

	for shortcut in doc.shortcuts:
		if shortcut.link_to == "posapp":
			shortcut.type = "URL"
			shortcut.url = "/pospire"
			shortcut.link_to = None
			changed = True

	for link in doc.links:
		if link.link_to == "posapp" and link.link_type == "Page":
			link.link_type = "URL"
			link.link_to = "/pospire"
			changed = True

	if changed:
		doc.save(ignore_permissions=True)
