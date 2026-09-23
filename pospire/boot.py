import json

import frappe
from frappe import _
from frappe.desk import desk_page

from pospire.pos_core import CORE_POS_DOCTYPES, CORE_POS_PAGES, is_core_pos, route_slug

BLOCKED_PAGES = {
	"point-of-sale",
}

# Core POS DocTypes are not Pages — these are Frappe's auto-generated route
# slugs for each DocType's list view (frappe.router.setup() builds them from
# bootinfo.user.can_read, which is deliberately left unfiltered below). DocType
# routes never call desk_page.getpage(), so BLOCKED_PAGES/getpage() can't
# block them; pos_core_route_guard.js blocks these client-side instead.
BLOCKED_DOCTYPE_ROUTES = {route_slug(doctype) for doctype in CORE_POS_DOCTYPES}


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

	workspace_filter.py already removes the empty card from the desktop
	response, but the card's position is stored separately in the
	Workspace doc's `content` field. Without this, the Selling workspace
	shows an empty gap where the card used to be.
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
	    Expose blocked DocType route slugs so pos_core_route_guard.js can
	    block direct navigation to them (e.g. "pos-invoice").
	"""

	bootinfo["core_pos_blocked_routes"] = sorted(BLOCKED_DOCTYPE_ROUTES)

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
	# This also removes the page from frappe.boot.allowed_pages, so a user
	# who navigates straight to the POS URL gets a plain "not found" instead
	# of the friendly message in getpage() below.
	bootinfo["page_info"] = {
		name: info for name, info in (bootinfo.get("page_info") or {}).items() if name not in CORE_POS_PAGES
	}

	workspaces = bootinfo.get("workspaces")

	if workspaces:
		_remove_workspace_layout_gap(workspaces.get("pages"))


# `getpage` must remain guest-callable because it overrides the guest-accessible
# desk page entry point; it only blocks the POS page and delegates all other
# page handling to the ERPNext implementation.
@frappe.whitelist(allow_guest=True)  # nosemgrep: frappe-semgrep-rules.rules.security.guest-whitelisted-method
def getpage(name: str):
	"""
	Block access to the ERPNext Core Point of Sale page.

	All other desk pages continue to use the standard behaviour.
	"""

	if name in BLOCKED_PAGES:
		frappe.throw(
			_("The page has been disabled. Please use POSpire."),
			frappe.PermissionError,
		)

	# Delegate to the original implementation.
	doc = desk_page.get(name)
	frappe.response.docs.append(doc)
