# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class POSOfflineBeacon(Document):
	"""Per-device 5-minute offline-pipeline health snapshot.

	Records are inserted by `pospire.pospire.api.offline.record_beacon` and
	read by the central observability dashboard (B6). Auto-purge of stale
	rows is handled by a daily scheduled job in `pospire.tasks` (see
	`hooks.py` scheduler events) — we always keep the most-recent row per
	device so a device that has been offline for weeks still shows up in
	the dashboard with its last-known state.
	"""

	pass
