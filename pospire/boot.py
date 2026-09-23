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


def _eligible_dashboard_companies():
	"""
	Companies with at least one active POS Profile, narrowed to what the
	current user can actually access.

	frappe.get_all() on Company applies the session user's own permissions
	(including any User Permission restrictions), so this covers "the user
	can access" for free — no explicit permission check needed here.
	"""

	companies_with_pos_profile = frappe.get_all(
		"POS Profile", filters={"disabled": 0}, pluck="company", distinct=True
	)

	if not companies_with_pos_profile:
		return set()

	permitted = frappe.get_all("Company", filters={"name": ["in", companies_with_pos_profile]}, pluck="name")

	return set(permitted)


def _default_dashboard_company():
	"""
	Pick the company the POSpire Dashboard/Workspace filter bar should show
	before the user ever clicks Apply — falling back to the site default
	company (frappe.defaults.get_user_default("Company")) breaks on sites
	where that company has no POS Profile, leaving the dashboard blank.

	Tries each of these in order, using the first one that names a company
	in _eligible_dashboard_companies():
	    1. The company the user picked last time (see set_dashboard_company()
	       in pospire.pospire.api.dashboard_filter).
	    2. The user's default Company.
	    3. The company of the user's most recent POS Opening Shift.
	    4. The company of a POS Profile assigned to the user (the one
	       marked default, if there's more than one).
	    5. The company of the site's most recent POS Opening Shift overall
	       — covers Administrator / head-office users with no shifts of
	       their own.
	    6. The global default company, else the first eligible company by
	       name.
	Returns None if no company is eligible at all — callers must handle
	that by showing an empty/zero state, not by throwing.

	POS Opening Shift is used for "most recent activity" instead of Sales
	Invoice throughout — it's a much smaller table.
	"""

	eligible = _eligible_dashboard_companies()

	if not eligible:
		return None

	user = frappe.session.user

	saved = frappe.db.get_value(
		"DefaultValue", {"parent": user, "defkey": "pospire_dashboard_company"}, "defvalue"
	)
	if saved and saved in eligible:
		return saved

	user_default = frappe.defaults.get_user_default("Company", user)
	if user_default and user_default in eligible:
		return user_default

	last_own_shift = frappe.get_all(
		"POS Opening Shift",
		filters={"user": user, "docstatus": 1},
		fields=["company"],
		order_by="period_start_date desc",
		limit_page_length=1,
		pluck="company",
	)
	if last_own_shift and last_own_shift[0] in eligible:
		return last_own_shift[0]

	assigned_profiles = frappe.get_all(
		"POS Profile User", filters={"user": user}, fields=["parent", "default"]
	)
	if assigned_profiles:
		profile_company = {
			p.name: p.company
			for p in frappe.get_all(
				"POS Profile",
				filters={"name": ["in", [row.parent for row in assigned_profiles]]},
				fields=["name", "company"],
			)
		}
		# Rows marked `default` first, then whatever else is assigned, so a
		# default pointing at an ineligible/inaccessible company still falls
		# through to another assigned profile instead of skipping this step
		# entirely.
		ordered_rows = [row for row in assigned_profiles if row.default] + assigned_profiles
		for row in ordered_rows:
			company = profile_company.get(row.parent)
			if company and company in eligible:
				return company

	latest_site_shift = frappe.get_all(
		"POS Opening Shift",
		filters={"docstatus": 1},
		fields=["company"],
		order_by="period_start_date desc",
		limit_page_length=1,
		pluck="company",
	)
	if latest_site_shift and latest_site_shift[0] in eligible:
		return latest_site_shift[0]

	global_default = frappe.defaults.get_global_default("company")
	if global_default and global_default in eligible:
		return global_default

	return sorted(eligible)[0]


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

	Layer 5
	    Give the POSpire Dashboard/Workspace filter bar a sane starting
	    Company (pospire_dashboard_company) instead of the site's default
	    company, which may have no POS Profile at all — and the full list
	    of POS Profile names (pospire_pos_profile_names) so that filter bar
	    can express "no POS Profile selected" as a real, always-true filter
	    condition rather than a SQL wildcard (see pos_universal_filter.js).
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

	if user and frappe.session.user != "Guest":
		# Never let a bug here break login/boot for every desk page — this
		# feature is additive, same principle as pos_universal_filter.js's
		# own try/catch around its page-change handler.
		try:
			bootinfo["pospire_dashboard_company"] = _default_dashboard_company()
		except Exception:
			frappe.log_error(title="pospire: default dashboard company resolution failed")
			bootinfo["pospire_dashboard_company"] = None

		bootinfo["pospire_pos_profile_names"] = frappe.get_all("POS Profile", pluck="name")


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
