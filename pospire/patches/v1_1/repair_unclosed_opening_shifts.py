# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Repair POS Opening Shifts left Open despite a submitted closing.

Before the closure post-condition landed in `offline.create_closing_entry`,
a queued closing could be accepted by the server while the opening shift
stayed Open - the client saw `synced` and the shift was never closable
again. Nothing replays those entries, so historical rows need this sweep.

Repairs only the unambiguous case: EXACTLY ONE submitted closing against
the opening. More than one is an accounting question about which close is
authoritative; those are logged and left alone.

Idempotent - re-running against a correct shift is a no-op.
"""

import frappe

from pospire.pospire.api.offline import _ensure_opening_closed


def execute():
	openings = frappe.get_all(
		"POS Opening Shift",
		filters={"docstatus": 1},
		or_filters=[
			["status", "=", "Open"],
			["pos_closing_shift", "is", "not set"],
		],
		pluck="name",
	)
	if not openings:
		return

	repaired = 0
	ambiguous = []

	for opening_name in openings:
		closings = frappe.get_all(
			"POS Closing Shift",
			filters={"pos_opening_shift": opening_name, "docstatus": 1},
			pluck="name",
		)
		if not closings:
			continue
		if len(closings) > 1:
			ambiguous.append((opening_name, closings))
			continue
		if _ensure_opening_closed(opening_name, closings[0]):
			repaired += 1

	if repaired:
		print(f"repair_unclosed_opening_shifts: repaired {repaired} opening shift(s)")

	for opening_name, closings in ambiguous:
		frappe.log_error(
			title="POS Opening Shift has multiple submitted closings",
			message=(
				f"Opening shift {opening_name} has {len(closings)} submitted "
				f"closing shifts: {', '.join(closings)}. "
				"Not repaired automatically - decide which close is authoritative."
			),
		)
