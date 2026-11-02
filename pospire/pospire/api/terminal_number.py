# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Per-terminal invoice numbers of the form PREFIX/YY/NNNNNN."""

import re

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe import _

PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]{0,3}$")
_NUMBER_RE = re.compile(r"^([A-Z][A-Z0-9]{0,3})/(\d{2})/(\d{6})$")


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

	old = None if doc.is_new() else frappe.db.get_value("POS Profile", doc.name, "pospire_invoice_prefix")
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
	doc.name = number


def get_last_number(pos_profile: str, fy: str) -> int:
	prefix, floor_fy, floor_number = frappe.db.get_value(
		"POS Profile", pos_profile, ["pospire_invoice_prefix", "pospire_floor_fy", "pospire_floor_number"]
	)
	last = 0
	if prefix:
		names = frappe.get_all(
			"Sales Invoice", filters={"name": ["like", f"{prefix}/{fy}/______"]}, pluck="name"
		)
		last = max((p[2] for p in map(parse_number, names) if p), default=0)
	if floor_fy == fy:
		last = max(last, floor_number or 0)
	return last


def release_stale_draft(name: str) -> None:
	docstatus = frappe.db.get_value("Sales Invoice", name, "docstatus")
	if docstatus is None:
		return
	if docstatus == 0:
		frappe.delete_doc("Sales Invoice", name, ignore_permissions=True)
		return
	raise TerminalNumberConflict(_("Invoice number {0} is already used.").format(name))
