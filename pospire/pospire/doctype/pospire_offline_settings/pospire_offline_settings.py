# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class POSpireOfflineSettings(Document):
	"""Global runtime kill switch for the POSpire offline outbox path.

	See docs/offline/15-decision-log.md D-29. The frontend's
	`@/offline/kill-switch.ts` polls this Single via `frappe.client.get_value`
	(cached 60s) and throws `OfflineDisabledError` from `outbox.enqueue` when
	`enabled` is 0. The scheduler also pauses on each drain attempt.
	"""

	def on_update(self) -> None:
		# Audit: stamp who flipped the switch and when, but only when
		# the switch transitioned from enabled to disabled. The opposite
		# transition is a positive event; we don't need to record it.
		if not self.has_value_changed("enabled"):
			return
		if not self.enabled:
			self.db_set("last_disabled_by", frappe.session.user, update_modified=False)
			self.db_set("last_disabled_on", now_datetime(), update_modified=False)
