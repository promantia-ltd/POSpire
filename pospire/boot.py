import json

import frappe

from pospire.pos_core import CORE_POS_DOCTYPES, CORE_POS_PAGES, is_core_pos, route_slug

# Desk routes pos_core_route_guard.js redirects to POSpire: each Core POS
# DocType's list slug (frappe.router builds these from bootinfo.user.can_read,
# which is deliberately left unfiltered below) and the Core POS page itself.
# Blocking the page here instead of overriding desk_page.getpage keeps the app
# free of whitelisted-method overrides.
BLOCKED_ROUTES = {route_slug(doctype) for doctype in CORE_POS_DOCTYPES} | CORE_POS_PAGES


def _filter_doctypes(doctypes):
	"""
	Remove ERPNext Core POS DocTypes from bootinfo lists.
	"""

	doctypes = doctypes or []

	return [doctype for doctype in doctypes if doctype not in CORE_POS_DOCTYPES]


def _filter_workspace_sidebar(workspace_sidebar):
	"""
	Remove ERPNext Core POS items from the Workspace Sidebar.

	Matches on link_type/link_to instead of label because labels
	are translated before extend_bootinfo() is executed.
	"""

	if not workspace_sidebar:
		return workspace_sidebar

	for workspace in workspace_sidebar.values():
		items = workspace.get("items") or []

		workspace["items"] = [item for item in items if not is_core_pos(item)]

	return workspace_sidebar


def _remove_workspace_layout_gap(pages):
	"""
	Drop the "Point of Sale" card's layout block from workspace content.

	The desk draws a workspace from these content blocks, so without the
	block the card is never rendered, even though get_desktop_page still
	returns its links.
	"""

	for page in pages or []:
		content = page.get("content")

		if not content:
			continue

		try:
			blocks = json.loads(content)
		except (TypeError, ValueError):
			continue

		blocks = [
			block
			for block in blocks
			if not (block.get("type") == "card" and block.get("data", {}).get("card_name") == "Point of Sale")
		]

		page["content"] = json.dumps(blocks)


def extend_bootinfo(bootinfo):
	"""
	Layer 1
	    Hide ERPNext Core POS DocTypes from:
	        * Awesome Bar
	        * Search
	        * New

	Layer 2
	    Hide ERPNext Core POS entries from the Workspace Sidebar.

	Layer 3
	    Hide the ERPNext Core POS page from the Awesome Bar's "Open <Page>"
	    results, and remove the layout gap it leaves behind in the Selling
	    workspace.

	Layer 4
	    Expose blocked route slugs so pos_core_route_guard.js can block
	    direct navigation to them (e.g. "pos-invoice", "point-of-sale").
	"""

	bootinfo["core_pos_blocked_routes"] = sorted(BLOCKED_ROUTES)

	user = bootinfo.get("user")

	if user:
		# NOTE:
		# Do not filter can_read.
		# It is consumed by the desk router and other framework internals.
		user["can_search"] = _filter_doctypes(user.get("can_search"))
		user["can_create"] = _filter_doctypes(user.get("can_create"))

	# Single DocTypes (e.g. POS Settings) bypass can_search entirely in the
	# Awesome Bar: frappe's search_utils.get_doctypes() matches Single
	# DocTypes against bootinfo.single_types instead, based only on can_read.
	bootinfo["single_types"] = _filter_doctypes(bootinfo.get("single_types"))

	sidebar = bootinfo.get("workspace_sidebar_item")

	if sidebar:
		bootinfo["workspace_sidebar_item"] = _filter_workspace_sidebar(sidebar)

	# NOTE:
	# This only hides the page from the Awesome Bar and allowed_pages; the desk
	# still asks the server for it on navigation, so the route guard is what
	# actually keeps cashiers out.
	bootinfo["page_info"] = {
		name: info for name, info in (bootinfo.get("page_info") or {}).items() if name not in CORE_POS_PAGES
	}

	workspaces = bootinfo.get("workspaces")

	if workspaces:
		_remove_workspace_layout_gap(workspaces.get("pages"))
