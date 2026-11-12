# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Per-terminal invoice numbers of the form PREFIX/YY/NNNNNN."""

import hashlib
import hmac
import json
import re
from contextlib import contextmanager

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe import _
from frappe.utils import add_days, getdate, nowdate
from frappe.utils.password import get_decrypted_password, set_encrypted_password

PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]{0,3}$")
_NUMBER_RE = re.compile(r"^([A-Z][A-Z0-9]{0,3})/(\d{2})/(\d{6})$")
# How far past the till's last used number (which includes a device-reset floor) a new number may be.
MAX_NUMBERS_AHEAD = 1000


def format_number(prefix: str, fy: str, n: int) -> str:
	return f"{prefix}/{fy}/{n:06d}"


def parse_number(name: str | None) -> tuple[str, str, int] | None:
	m = _NUMBER_RE.match(name or "")
	return (m.group(1), m.group(2), int(m.group(3))) if m else None


def fy_code(company: str, posting_date) -> str:
	fy = get_fiscal_year(posting_date, company=company, as_dict=True)
	return str(fy.year_start_date.year)[-2:]


def validate_prefix(doc) -> None:
	prefix = (doc.get("pospire_invoice_prefix") or "").strip().upper()
	doc.pospire_invoice_prefix = prefix

	# A new profile has no saved row yet, so this is None for it.
	old = doc.get("name") and frappe.db.get_value("POS Profile", doc.name, "pospire_invoice_prefix")
	if old and old != prefix and frappe.db.exists("Sales Invoice", {"name": ["like", f"{old}/%"]}):
		frappe.throw(_("Invoice Prefix cannot be changed after invoices have used it."))

	if not prefix:
		return
	if not PREFIX_RE.match(prefix):
		frappe.throw(_("Invoice Prefix must be 1 to 4 letters or digits and start with a letter."))

	other = frappe.db.get_value(
		"POS Profile", {"pospire_invoice_prefix": prefix, "name": ["!=", doc.name]}, "name"
	)
	if other:
		frappe.throw(_("Invoice Prefix {0} is already used by POS Profile {1}.").format(prefix, other))


class TerminalNumberConflict(frappe.ValidationError):
	pass


def autoname(doc, method=None) -> None:
	number = doc.get("pospire_terminal_number")
	if not number or doc.is_return or doc.amended_from:
		return
	parsed = parse_number(number)
	prefix = frappe.db.get_value("POS Profile", doc.pos_profile, "pospire_invoice_prefix")
	if not (
		parsed and prefix and parsed[0] == prefix and parsed[1] == fy_code(doc.company, doc.posting_date)
	):
		frappe.throw(
			_("Invoice number {0} does not belong to POS Profile {1} for this financial year.").format(
				number, doc.pos_profile
			)
		)
	assert_can_use_profile(doc.pos_profile)  # a direct insert must not take another till's number
	assert_number_writer(doc.pos_profile, number)
	last = get_last_number(doc.pos_profile, parsed[1])
	if parsed[2] > last + MAX_NUMBERS_AHEAD:
		# Nothing a till does gets this far ahead; a jump would also run the year out of numbers.
		frappe.throw(
			_("Invoice number {0} is too far ahead of the last number {1} of POS Profile {2}.").format(
				number, format_number(prefix, parsed[1], last), doc.pos_profile
			)
		)
	doc.name = number


def validate_number_applied(doc, method=None) -> None:
	"""A Document Naming Rule runs before autoname and would silently replace the terminal number."""
	number = doc.get("pospire_terminal_number")
	if not number or not doc.flags.in_insert or doc.is_return or doc.amended_from:
		return
	if doc.name != number:
		frappe.throw(
			_(
				"Invoice number {0} was not applied. Remove any Document Naming Rule for POS Sales Invoices."
			).format(number)
		)


def get_last_number(pos_profile: str, fy: str) -> int:
	prefix, floor_fy, floor_number = frappe.db.get_value(
		"POS Profile", pos_profile, ["pospire_invoice_prefix", "pospire_floor_fy", "pospire_floor_number"]
	)
	last = 0
	if prefix:
		# Used numbers only: submitted/cancelled, or a draft a Payment Request points at.
		# Zero-padded, so MAX(name) is the highest number.
		top = frappe.db.sql(
			"""
			SELECT MAX(si.name) FROM `tabSales Invoice` si
			WHERE si.name LIKE %s AND si.name REGEXP %s AND (
				si.docstatus IN (1, 2) OR EXISTS (
					SELECT 1 FROM `tabPayment Request` pr
					WHERE pr.reference_doctype = 'Sales Invoice'
						AND pr.reference_name = si.name AND pr.docstatus < 2
				)
			)
			""",
			(f"{prefix}/{fy}/______", f"^{prefix}/{fy}/[0-9]{{6}}$"),  # LIKE for the index, REGEXP for digits
		)[0][0]
		parsed = parse_number(top)
		last = parsed[2] if parsed else 0
	if floor_fy == fy:
		last = max(last, floor_number or 0)
	return last


# Site admins may use any till's numbers without its device key (they can unlink and reconfigure it
# anyway). Sales Managers only through Sync Review (recovery.retry / dry_run_replay), which mark it.
NUMBER_ADMIN_ROLE = "System Manager"


def can_use_profile(pos_profile: str, user: str | None = None) -> bool:
	"""Till access is the profile's Applicable for Users list (cashiers may lack POS Profile read).

	Profile read alone (Accounts User/Manager have it on every profile) does not open a till that
	lists its users; only an unrestricted till falls back to it, as ERPNext's own POS does.
	"""
	user = user or frappe.session.user
	users = frappe.get_all("POS Profile User", filters={"parent": pos_profile}, pluck="user")
	if users:
		return user in users
	return bool(frappe.has_permission("POS Profile", "read", pos_profile, user=user))


def assert_can_use_profile(pos_profile: str, user: str | None = None) -> None:
	if not can_use_profile(pos_profile, user):
		frappe.throw(_("Not permitted"), frappe.PermissionError)


# The linked device proves itself with a secret it creates and stores before its first claim; the
# device id is not secret (it is stored on invoices, shifts and the POS Profile). Sent as a header
# so it never lands in a stored payload. Only hashes are kept, in the encrypted password store
# (not returned by any API).
DEVICE_KEY_HEADER = "X-Pospire-Device-Key"
_KEYS_FIELD = "pospire_device_keys"


def _hash_key(key: str) -> str:
	return hashlib.sha256(key.encode()).hexdigest()


def _stored_keys(pos_profile: str) -> dict:
	raw = get_decrypted_password("POS Profile", pos_profile, _KEYS_FIELD, raise_exception=False)
	return json.loads(raw) if raw else {"current": None, "retired": []}


def _save_keys(pos_profile: str, keys: dict) -> None:
	set_encrypted_password("POS Profile", pos_profile, json.dumps(keys), _KEYS_FIELD)


def _presented_key() -> str | None:
	"""The device's own secret, created and stored on the till before its first claim."""
	request = getattr(frappe.local, "request", None)
	key = ((request.headers.get(DEVICE_KEY_HEADER) if request else None) or "").strip()
	return key if 32 <= len(key) <= 128 else None  # a short key is a client bug, never a device


def _holds(keys: dict, number: str | None = None) -> bool:
	"""The caller sends the linked device's secret, or a replaced device's secret for a number in its skipped block."""
	key = _presented_key()
	presented = _hash_key(key) if key else None

	def matches(stored):
		return bool(presented) and hmac.compare_digest(stored, presented)

	if keys["current"] and matches(keys["current"]):
		return True
	parsed = parse_number(number)
	return bool(parsed) and any(
		r["fy"] == parsed[1] and r["from"] <= parsed[2] <= r["to"] and matches(r["hash"])
		for r in keys["retired"]
	)


def holds_number(pos_profile: str, number: str) -> bool:
	return _holds(_stored_keys(pos_profile), number)


@contextmanager
def number_writer_decided(trusted: bool):
	"""Offline replay runs as a client-named owner_user, so whether the real caller is a manager is
	decided before impersonating and must not be re-read from the impersonated roles."""
	previous = frappe.flags.pospire_trusted_number_writer
	frappe.flags.pospire_trusted_number_writer = trusted
	try:
		yield
	finally:
		frappe.flags.pospire_trusted_number_writer = previous


def assert_number_writer(pos_profile: str, number: str) -> None:
	trusted = frappe.flags.pospire_trusted_number_writer
	if trusted is None:
		trusted = NUMBER_ADMIN_ROLE in frappe.get_roles()
	if trusted:
		return
	if not holds_number(pos_profile, number):
		frappe.throw(
			_("Invoice numbers of POS Profile {0} can only be used on its linked device.").format(
				pos_profile
			),
			TerminalDeviceMismatch,
		)


def release_stale_draft(name: str, pos_profile: str) -> None:
	if not pos_profile:
		frappe.throw(_("POS Profile is required to use a terminal invoice number."))
	parsed = parse_number(name)
	prefix = frappe.db.get_value("POS Profile", pos_profile, "pospire_invoice_prefix")
	if not (parsed and prefix and parsed[0] == prefix):
		frappe.throw(
			_("Invoice number {0} does not belong to POS Profile {1} for this financial year.").format(
				name, pos_profile
			)
		)
	assert_can_use_profile(pos_profile)
	assert_number_writer(pos_profile, name)
	_delete_stale_draft(name)


def _delete_stale_draft(name: str) -> None:
	docstatus = frappe.db.get_value("Sales Invoice", name, "docstatus")
	if docstatus is None:
		return
	if docstatus == 0 and not _has_payment_request(name):
		frappe.delete_doc("Sales Invoice", name, ignore_permissions=True)
		return
	frappe.throw(_("Invoice number {0} is already used.").format(name), TerminalNumberConflict)


def _has_payment_request(name: str) -> bool:
	"""A payment request uses the number up (same rule as get_last_number)."""
	return bool(
		frappe.db.exists(
			"Payment Request",
			{"reference_doctype": "Sales Invoice", "reference_name": name, "docstatus": ["<", 2]},
		)
	)


def log_voided_number(pos_profile: str, number: str, reason: str) -> None:
	frappe.get_doc("POS Profile", pos_profile).add_comment(
		"Info", f"Invoice number {number} voided in Sync Review. Reason: {reason}"
	)


class TerminalDeviceMismatch(frappe.ValidationError):
	pass


@frappe.whitelist(methods=["POST"])
def claim_terminal(pos_profile: str, device_id: str) -> dict:
	from pospire.pospire.api.offline import _validate_uuid

	assert_can_use_profile(pos_profile)
	_validate_uuid(device_id, "device_id")

	prefix, linked, company, backdate = frappe.db.get_value(
		"POS Profile",
		pos_profile,
		["pospire_invoice_prefix", "pospire_linked_device", "company", "posa_allow_change_posting_date"],
		for_update=True,  # serialize concurrent claims
	)
	if not prefix:
		return {"prefix": None, "fiscal_years": [], "last": {}}

	keys = _stored_keys(pos_profile)
	key = _presented_key()
	# The device sends a secret it created and stored before claiming, so a repeated or overlapping
	# claim, or one whose response was lost, proves itself the same way.
	if not linked:
		if not key:  # a page from before device secrets: linking it would strand the till
			frappe.throw(
				_("Reopen POSpire on this computer to link it to POS Profile {0}.").format(pos_profile)
			)
		frappe.db.set_value(
			"POS Profile", pos_profile, "pospire_linked_device", device_id, update_modified=False
		)
		frappe.get_doc("POS Profile", pos_profile).add_comment("Info", f"Linked device {device_id}")
		keys["current"] = _hash_key(key)
		_save_keys(pos_profile, keys)
	elif linked != device_id or (keys["current"] and not _holds(keys)):
		# The device id alone is not proof: a copied id without the device's secret is another device.
		frappe.throw(
			_("This POS Profile is linked to another device. Ask a manager to unlink it."),
			TerminalDeviceMismatch,
		)
	elif key and not keys["current"]:
		keys["current"] = _hash_key(key)  # linked before device secrets existed: its first secret
		_save_keys(pos_profile, keys)
	# A linked till on a page from before device secrets still gets its counters; its numbered
	# writes are refused until it reloads and sends a secret.

	today_fy = get_fiscal_year(nowdate(), company=company, as_dict=True)
	years = [today_fy]
	edges = [add_days(today_fy.year_end_date, 1)]
	if backdate:  # the till may post into last year
		edges.append(add_days(today_fy.year_start_date, -1))
	for day in edges:
		try:
			years.append(get_fiscal_year(day, company=company, as_dict=True))
		except frappe.ValidationError:  # that FY is not created
			pass
	fiscal_years = [
		{
			"code": str(y.year_start_date.year)[-2:],
			"start": str(getdate(y.year_start_date)),
			"end": str(getdate(y.year_end_date)),
		}
		for y in years
	]
	return {
		"prefix": prefix,
		"fiscal_years": fiscal_years,
		"last": {y["code"]: get_last_number(pos_profile, y["code"]) for y in fiscal_years},
	}


@frappe.whitelist(methods=["POST"])
def unlink_terminal_device(pos_profile: str, reason: str) -> dict:
	frappe.only_for(("System Manager", "Sales Manager"))
	if NUMBER_ADMIN_ROLE not in frappe.get_roles():
		# Sales Manager: only a till they can see (User Permissions may limit them to some companies).
		frappe.has_permission("POS Profile", "select", pos_profile, throw=True)
	reason = (reason or "").strip()
	if not reason:
		frappe.throw(_("A reason is required to unlink a device."))

	company, skip = frappe.db.get_value("POS Profile", pos_profile, ["company", "pospire_reset_skip"])
	fy = fy_code(company, nowdate())
	last = get_last_number(pos_profile, fy)
	floor = last + (skip if skip is not None else 50)
	keys = _stored_keys(pos_profile)
	if keys["current"]:
		# The old device may still sync offline sales it numbered inside the skipped block, and nothing else.
		keys["retired"].append({"hash": keys["current"], "fy": fy, "from": last + 1, "to": floor})
		keys["current"] = None
		_save_keys(pos_profile, keys)
	frappe.db.set_value(
		"POS Profile",
		pos_profile,
		{"pospire_linked_device": "", "pospire_floor_fy": fy, "pospire_floor_number": floor},
		update_modified=False,
	)
	frappe.get_doc("POS Profile", pos_profile).add_comment(
		"Info", f"Device reset: numbers {last + 1} to {floor} skipped. Reason: {reason}"
	)
	return {"floor": floor}
