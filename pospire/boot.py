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


def eligible_dashboard_companies():
	"""
	Companies with at least one active POS Profile, narrowed to what the
	current user can actually access.

	The POS Profile scan uses frappe.get_all, which ignores permissions. That
	is on purpose: it only reads company names, and on stock ERPNext POS
	Profile is readable by Accounts roles only, so a Sales Manager who can
	see the dashboard charts would otherwise get nothing here.

	The Company query uses frappe.get_list, which does apply the user's
	permissions and any User Permission restrictions. That is what decides
	which companies the user may pick, so the dashboard never starts on (or
	offers) a company they have no access to. frappe.get_all would skip
	those checks.
	"""

	companies_with_pos_profile = frappe.get_all(
		"POS Profile", filters={"disabled": 0}, pluck="company", distinct=True
	)

	if not companies_with_pos_profile:
		return set()

	permitted = frappe.get_list(
		"Company",
		filters={"name": ["in", companies_with_pos_profile]},
		pluck="name",
		limit_page_length=0,
	)

	return set(permitted)


def _default_dashboard_company():
	"""
	Pick the company the POSpire Dashboard/Workspace filter bar should show
	before the user ever clicks Apply — falling back to the site default
	company (frappe.defaults.get_user_default("Company")) breaks on sites
	where that company has no POS Profile, leaving the dashboard blank.

	Tries each of these in order, using the first one that names a company
	in eligible_dashboard_companies():
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

	eligible = eligible_dashboard_companies()

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
	    Expose blocked route slugs so pos_core_route_guard.js can block
	    direct navigation to them (e.g. "pos-invoice", "point-of-sale").

	Layer 5
	    Give the POSpire Dashboard/Workspace filter bar a sane starting
	    Company (pospire_dashboard_company) instead of the site's default
	    company, which may have no POS Profile at all, plus the companies
	    that bar may offer (pospire_eligible_dashboard_companies). The
	    till filter needs nothing here: pos_universal_filter.js adds a
	    pos_profile condition only when one is actually selected.
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

	if user and frappe.session.user != "Guest":
		# Never let a bug here break login/boot for every desk page — this
		# feature is additive, same principle as pos_universal_filter.js's
		# own try/catch around its page-change handler.
		try:
			bootinfo["pospire_dashboard_company"] = _default_dashboard_company()
			# The filter bar offers exactly these companies, so a user cannot
			# pick one with no POS Profile and land on a blank dashboard.
			bootinfo["pospire_eligible_dashboard_companies"] = sorted(eligible_dashboard_companies())
		except Exception:
			frappe.log_error(
				title="pospire: default dashboard company resolution failed",
				message=frappe.get_traceback(with_context=True),
			)
			bootinfo["pospire_dashboard_company"] = None
			bootinfo["pospire_eligible_dashboard_companies"] = []
