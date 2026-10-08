# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Flag existing POS XML Print Designer templates that use Frappe-only
Jinja helpers (frappe.*, Python slicing, .upper()/.strip() etc.).

hardware_manager.py switched receipt rendering from frappe.render_template
(the shared global Jinja env, which exposes frappe.* and other Frappe
helpers) to a dedicated SandboxedEnvironment. That's the correct fix for
XML-escaping (S4) and is required for offline compatibility, but it also
changes ONLINE rendering: a template relying on a Frappe-only helper that
worked before now fails online too, not just offline.

check_offline_compatibility() (hardware_manager.py) already detects every
one of these constructs - it's run live from the POS XML Print Designer
form on every save (S5). This patch runs the same check once against every
template that already exists, so an admin finds out from the Error Log
during migration rather than from a broken receipt in production.

Non-blocking: only logs. Never edits a template.
"""

import frappe

from pospire.pospire.api.hardware_manager import check_offline_compatibility


def execute():
	templates = frappe.get_all(
		"POS XML Print Designer",
		fields=["name", "xml_template"],
	)

	flagged = []
	for row in templates:
		warnings = check_offline_compatibility(row.xml_template or "")
		if warnings:
			flagged.append((row.name, warnings))

	if not flagged:
		return

	message_lines = [f"{name}:\n" + "\n".join(f"  - {w}" for w in warnings) for name, warnings in flagged]
	frappe.log_error(
		title="POS XML Print Designer templates use Frappe-only helpers",
		message=(
			"The following templates rely on constructs that no longer work "
			"now that receipt rendering runs in a SandboxedEnvironment "
			"(see hardware_manager.py::get_receipt_jinja_env). Fix them using "
			"the offline-safe helper equivalents before this ships:\n\n" + "\n\n".join(message_lines)
		),
	)
