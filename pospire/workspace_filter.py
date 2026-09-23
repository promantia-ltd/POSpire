import frappe
from frappe import _
from frappe.desk.desktop import get_desktop_page as original_get_desktop_page

from pospire.pos_core import is_core_pos


def _filter_items(items):
	"""
	Remove ERPNext Core POS links from a list of workspace items.
	"""

	items = items or []

	return [item for item in items if not is_core_pos(item)]


def _filter_workspace_response(response):
	"""
	Remove ERPNext Core POS links from workspace response.
	"""

	if not response:
		return response

	#
	# Cards
	#
	cards = response.get("cards")

	if cards:
		filtered_cards = []

		# ERPNext's "Point of Sale" card also holds POS Profile and the two
		# Loyalty links, so it doesn't go empty once is_core_pos() strips out
		# the Core POS entries. Drop the whole card by name instead — POS
		# Profile and the Loyalty links have their own home in the POSpire
		# workspace. Card labels are translated (unlike item link_type/
		# link_to), so _() must be called here, per request, not cached at
		# import time when no user/language context exists yet.
		dropped_card_labels = {_("Point of Sale")}

		for card in cards.get("items") or []:
			if card.get("label") in dropped_card_labels:
				continue

			card["links"] = _filter_items(card.get("links"))

			# Drop cards that become empty after filtering.
			if card.get("links"):
				filtered_cards.append(card)

		cards["items"] = filtered_cards

	#
	# Shortcuts
	#
	shortcuts = response.get("shortcuts")

	if shortcuts:
		shortcuts["items"] = _filter_items(shortcuts.get("items") or [])

	#
	# Quick Lists
	#
	quick_lists = response.get("quick_lists")

	if quick_lists:
		quick_lists["items"] = _filter_items(quick_lists.get("items") or [])

	return response


@frappe.whitelist()
@frappe.read_only()
def get_desktop_page(page: str):
	"""
	Wrapper around ERPNext get_desktop_page().

	Only filters the Selling workspace.
	"""

	try:
		workspace = frappe.parse_json(page)
	except Exception:
		# Preserve original behaviour if page payload is invalid.
		return original_get_desktop_page(page)

	response = original_get_desktop_page(page)

	if workspace.get("name") != "Selling":
		return response

	return _filter_workspace_response(response)
