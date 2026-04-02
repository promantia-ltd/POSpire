# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

import secrets
import string

import frappe
from frappe import _
from frappe.model.document import Document
from werkzeug.security import generate_password_hash


class POSManagerPIN(Document):
	def before_insert(self) -> None:
		_generate_and_dispatch_pin(self)

	def before_save(self) -> None:
		if not self.is_new() and self.has_value_changed("user"):
			_generate_and_dispatch_pin(self)


def _generate_and_dispatch_pin(doc: Document) -> None:
	"""Generate a cryptographically random PIN, hash it, email the manager.

	The plaintext PIN is discarded after sending — it is never stored,
	logged, or returned in any API response.
	"""
	pin = _generate_pin()
	doc.pin_hash = generate_password_hash(pin)
	_send_pin_email(doc.user, pin)


def _generate_pin(length: int = 6) -> str:
	return "".join(secrets.choice(string.digits) for _ in range(length))


def _send_pin_email(user: str, pin: str) -> None:
	full_name = frappe.db.get_value("User", user, "full_name") or user
	frappe.sendmail(
		recipients=[user],
		subject=_("Your POSpire Manager PIN"),
		message=frappe.render_template(
			_PIN_EMAIL_TEMPLATE,
			{"full_name": full_name, "pin": pin},
		),
		now=True,
	)


_PIN_EMAIL_TEMPLATE = """<p>Hi {{ full_name }},</p>

<p>A POS Manager PIN has been created for your account by your system administrator.</p>

<p><strong>Your PIN: {{ pin }}</strong></p>

<p>You will need this PIN to authorise manager-level actions at the POS terminal.
Please keep it confidential and do not share it with anyone.</p>

<p>If you did not expect this email, contact your system administrator immediately.</p>

<p>— POSpire</p>"""
