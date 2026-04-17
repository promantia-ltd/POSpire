# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Cache key management and invalidation for posapp.get_items / get_customer_names.

Key format (manual frappe.cache, NOT @redis_cache):
    Items:     pospire:items:{profile_name}::{sha256_of_remaining_args}
    Customers: pospire:customers:{profile_name}::{sha256_of_remaining_args}

The profile name is a *literal* path segment so targeted per-profile deletion
is possible without touching entries for other profiles.

Invalidation strategy:
    POS Profile saved  → invalidate that profile's keys only + realtime pos_profile_updated
    Item / Item Price / Assortment / Item Group / Item Barcode
                       → invalidate item Redis keys only  + realtime pos_master_data_invalidated
    Customer           → invalidate customer Redis keys only + realtime pos_master_data_invalidated

The realtime event payload carries ``{"doctype": ..., "items": bool, "customers": bool}``
so the frontend can decide which catalogs to refresh and whether to defer until cart is empty.

``get_items_details`` is never cached (live stock / serial / batch).
"""

from __future__ import annotations

import frappe

# Must stay in sync with the key construction in posapp.py.
# Keys use `::` as a separator between the profile name and the hash/version
# so that prefix deletion (e.g. `pospire:items:POS-1:`) cannot accidentally
# match a profile whose name starts with the same characters (e.g. `POS-10`).
ITEMS_KEY_PREFIX = "pospire:items:"
CUSTOMERS_KEY_PREFIX = "pospire:customers:"

# Doctype → which cache family it affects.
_ITEM_DOCTYPES = frozenset(["Item", "Item Price", "Assortment", "Item Group", "Item Barcode"])
_CUSTOMER_DOCTYPES = frozenset(["Customer"])


# ── Scoped helpers ────────────────────────────────────────────────────────────


def clear_posapp_items_cache() -> None:
	"""Drop ALL item-catalog Redis cache entries across every POS Profile."""
	frappe.cache.delete_keys(ITEMS_KEY_PREFIX)


def clear_posapp_customers_cache() -> None:
	"""Drop ALL customer-list Redis cache entries across every POS Profile."""
	frappe.cache.delete_keys(CUSTOMERS_KEY_PREFIX)


def clear_posapp_master_redis_cache() -> None:
	"""Drop ALL site-local Redis cache entries across every POS Profile.

	Manual / operational broad-wipe utility only.  Does **not** publish realtime
	events — use ``invalidate_pos_server_cache_from_doc`` for doc-event paths.
	"""
	clear_posapp_items_cache()
	clear_posapp_customers_cache()


# ── Profile-targeted ──────────────────────────────────────────────────────────


def invalidate_pos_profile_cache(profile_name: str) -> None:
	"""Drop Redis cache entries for a single POS Profile only.

	Safe against partial name collisions because every key contains ``::``
	immediately after the profile name, so ``delete_keys("...POS-1:")`` matches
	``...POS-1::*`` and cannot hit ``...POS-10::*``.
	"""
	frappe.cache.delete_keys(f"{ITEMS_KEY_PREFIX}{profile_name}:")
	frappe.cache.delete_keys(f"{CUSTOMERS_KEY_PREFIX}{profile_name}:")


# ── doc_events entry-point ────────────────────────────────────────────────────


def invalidate_pos_server_cache_from_doc(doc, method=None) -> None:
	"""doc_events target: bust catalog caches after master data changes.

	POS Profile  → targeted invalidation + ``pos_profile_updated``
	Item family  → item cache only        + ``pos_master_data_invalidated``
	Customer     → customer cache only    + ``pos_master_data_invalidated``
	"""
	if doc.doctype == "POS Profile":
		invalidate_pos_profile_cache(doc.name)
		# Broadcast to all connected clients intentionally — no server-side
		# tracking of which users run POS sessions for which profiles.
		# The frontend guards on `data.pos_profile === this.pos_profile.name`
		# so only the matching session acts on the event.
		frappe.publish_realtime(  # nosemgrep: frappe-semgrep-rules.rules.frappe-realtime-pick-room
			"pos_profile_updated",
			{"pos_profile": doc.name},
			after_commit=True,
		)
		return

	affects_items = doc.doctype in _ITEM_DOCTYPES
	affects_customers = doc.doctype in _CUSTOMER_DOCTYPES

	if affects_items:
		clear_posapp_items_cache()
	if affects_customers:
		clear_posapp_customers_cache()

	if affects_items or affects_customers:
		# Broadcast to all POS sessions — item/customer master data can
		# affect every profile.  No user-scoping is possible without session
		# tracking infrastructure; the frontend decides which catalogs to refresh
		# based on the payload flags.
		frappe.publish_realtime(  # nosemgrep: frappe-semgrep-rules.rules.frappe-realtime-pick-room
			"pos_master_data_invalidated",
			{
				"doctype": doc.doctype,
				"items": affects_items,
				"customers": affects_customers,
			},
			after_commit=True,
		)
