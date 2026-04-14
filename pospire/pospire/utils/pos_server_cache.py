# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Invalidate Redis entries created by `@redis_cache` in `posapp.get_items` / `get_customer_names`.

Frappe stores keys under a prefix derived from `func.__module__` and `func.__qualname__`.
The cached callables are nested inside those whitelist methods, so their stable
`__qualname__` values are `get_items.<locals>.__get_items` and
`get_customer_names.<locals>.__get_customer_names`.

`get_items_details` is not wrapped in Redis cache (live stock / serial / batch).
"""

from __future__ import annotations

import frappe

_POSAPP = "pospire.pospire.api.posapp"

# Prefixes passed to frappe.cache.delete_keys (wildcard appended inside get_keys).
_REDIS_CACHE_PREFIXES = (
	f"{_POSAPP}.get_items.<locals>.__get_items",
	f"{_POSAPP}.get_customer_names.<locals>.__get_customer_names",
)


def clear_posapp_master_redis_cache() -> None:
	"""Drop all site-local Redis keys for POS item-list and customer-list caching."""
	for prefix in _REDIS_CACHE_PREFIXES:
		frappe.cache.delete_keys(prefix)


def invalidate_pos_server_cache_from_doc(doc, method=None) -> None:
	"""doc_events target: bust catalog caches after master data changes."""
	clear_posapp_master_redis_cache()
