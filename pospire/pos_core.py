"""
Utilities for identifying ERPNext Core POS resources.

This module is shared by boot.py and workspace_filter.py to avoid
duplicating Core POS constants and matching logic.
"""

CORE_POS_DOCTYPES = {
	"POS Invoice",
	"POS Opening Entry",
	"POS Closing Entry",
	"POS Invoice Merge Log",
	"POS Settings",
}

CORE_POS_PAGES = {
	"point-of-sale",
}


def route_slug(doctype: str) -> str:
	"""
	Build the desk route slug Frappe generates for a DocType's list view.
	"""

	return doctype.lower().replace(" ", "-")


def is_core_pos(item: dict) -> bool:
	"""
	Return True if a workspace/sidebar item belongs to ERPNext Core POS.

	Matches on link_type/link_to instead of label because labels are
	translated before bootinfo/workspace filters are applied.
	"""

	if not item:
		return False

	link_type = (item.get("link_type") or "").lower()
	link_to = item.get("link_to")

	return (link_type == "doctype" and link_to in CORE_POS_DOCTYPES) or (
		link_type == "page" and link_to in CORE_POS_PAGES
	)
