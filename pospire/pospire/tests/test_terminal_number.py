# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate

from pospire.pospire.api.terminal_number import (
	TerminalNumberConflict,
	format_number,
	fy_code,
	get_last_number,
	parse_number,
	release_stale_draft,
)
from pospire.pospire.tests.test_utils import (
	ensure_test_company,
	ensure_test_customer,
	get_cost_center,
	get_expense_account,
)


def _ensure_terminal_test_profile(name, prefix=None):
	"""Return a dedicated test POS Profile (created once), with its prefix set to `prefix`."""
	if not frappe.db.exists("POS Profile", name):
		company = ensure_test_company()
		if not frappe.db.exists("Mode of Payment", "Cash"):
			frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": "Cash", "type": "Cash"}).insert(
				ignore_permissions=True
			)
		frappe.get_doc(
			{
				"doctype": "POS Profile",
				"__newname": name,
				"name": name,
				"company": company,
				"currency": frappe.db.get_value("Company", company, "default_currency"),
				"warehouse": frappe.db.get_value("Warehouse", {"company": company, "is_group": 0}, "name"),
				"write_off_account": get_expense_account(company),
				"write_off_cost_center": get_cost_center(company),
				"payments": [{"mode_of_payment": "Cash", "default": 1}],
			}
		).insert(ignore_permissions=True)
	frappe.db.set_value(
		"POS Profile",
		name,
		{"pospire_invoice_prefix": prefix or "", "posa_enable_approval_workflow": 0},
	)
	return name


class TestNumberFormat(FrappeTestCase):
	def test_format_and_parse_round_trip(self):
		self.assertEqual(format_number("T01", "26", 123), "T01/26/000123")
		self.assertEqual(parse_number("T01/26/000123"), ("T01", "26", 123))

	def test_parse_rejects_other_names(self):
		for name in ("ACC-SINV-2026-00001", "T01/26/000123-1", "T01/2627/00123", "t01/26/000123", None):
			self.assertIsNone(parse_number(name))

	def test_fy_code_uses_fiscal_year_start(self):
		company = ensure_test_company()
		start = get_fiscal_year(nowdate(), company=company, as_dict=True).year_start_date
		self.assertEqual(fy_code(company, nowdate()), str(start.year)[-2:])


class TestPrefixValidation(FrappeTestCase):
	def _profiles(self):
		return [
			frappe.get_doc("POS Profile", _ensure_terminal_test_profile(n))
			for n in ("_Test POSpire Terminal A", "_Test POSpire Terminal B")
		]

	def test_prefix_upper_cased_and_validated(self):
		doc = self._profiles()[0]
		doc.pospire_invoice_prefix = "t01"
		doc.save()
		self.assertEqual(doc.pospire_invoice_prefix, "T01")
		for bad in ("1AB", "ABCDE", "T-1"):
			doc.pospire_invoice_prefix = bad
			self.assertRaises(frappe.ValidationError, doc.save)

	def test_prefix_unique_across_profiles(self):
		first, second = self._profiles()
		first.pospire_invoice_prefix = "T01"
		first.save()
		second.pospire_invoice_prefix = "T01"
		self.assertRaises(frappe.ValidationError, second.save)


def _ensure_test_item():
	code = "_Test POSpire Terminal Item"
	if not frappe.db.exists("Item", code):
		item = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code,
				"item_name": code,
				"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
				"stock_uom": frappe.db.get_value("UOM", {}, "name"),
				"is_stock_item": 0,
			}
		)
		if frappe.get_meta("Item").has_field("gst_hsn_code"):  # India Compliance requires it
			hsn = "01011010"
			if not frappe.db.exists("GST HSN Code", hsn):
				frappe.get_doc({"doctype": "GST HSN Code", "hsn_code": hsn, "description": "Test"}).insert(
					ignore_permissions=True
				)
			item.gst_hsn_code = hsn
		item.insert(ignore_permissions=True)
	return code


def _make_si(pos_profile, number=None, *, is_return=0, submit=False):
	si = frappe.get_doc(
		{
			"doctype": "Sales Invoice",
			"company": frappe.db.get_value("POS Profile", pos_profile, "company"),
			"customer": ensure_test_customer(),
			"is_pos": 0,
			"is_return": is_return,
			"pos_profile": pos_profile,
			"items": [{"item_code": _ensure_test_item(), "qty": -1 if is_return else 1, "rate": 100}],
		}
	)
	si.pospire_terminal_number = number
	si.insert(ignore_permissions=True)
	if submit:
		si.submit()
	return si


class TestTerminalNumbering(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal A", "T01")
		company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)  # FrappeTestCase only rolls back per class
		self.fy = fy_code(company, nowdate())

	def test_terminal_number_becomes_name(self):
		si = _make_si(self.profile, f"T01/{self.fy}/000007")
		self.assertEqual(si.name, f"T01/{self.fy}/000007")
		self.assertNotIn("pospire_terminal_number", frappe.db.get_table_columns("Sales Invoice"))

	def test_no_number_uses_naming_series(self):
		self.assertIsNone(parse_number(_make_si(self.profile).name))

	def test_wrong_prefix_or_year_throws(self):
		for bad in (f"T02/{self.fy}/000001", "T01/99/000001"):
			self.assertRaises(frappe.ValidationError, _make_si, self.profile, bad)

	def test_return_ignores_terminal_number(self):
		si = _make_si(self.profile, f"T01/{self.fy}/000008", is_return=1)
		self.assertIsNone(parse_number(si.name))

	def test_last_number_and_floor(self):
		_make_si(self.profile, f"T01/{self.fy}/000005")
		self.assertEqual(get_last_number(self.profile, self.fy), 5)
		frappe.db.set_value(
			"POS Profile", self.profile, {"pospire_floor_fy": self.fy, "pospire_floor_number": 60}
		)
		self.assertEqual(get_last_number(self.profile, self.fy), 60)

	def test_amended_name_ignored_by_last_number(self):
		name = f"T01/{self.fy}/000009"
		si = _make_si(self.profile, name, submit=True)
		si.cancel()
		amended = frappe.copy_doc(si)
		amended.amended_from = si.name
		amended.docstatus = 0
		amended.insert(ignore_permissions=True)
		self.assertEqual(amended.name, name + "-1")
		self.assertEqual(get_last_number(self.profile, self.fy), 9)

	def test_release_stale_draft(self):
		name = f"T01/{self.fy}/000011"
		_make_si(self.profile, name)
		release_stale_draft(name)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))
		release_stale_draft(name)  # no row: no-op

	def test_release_submitted_raises_conflict(self):
		name = f"T01/{self.fy}/000012"
		_make_si(self.profile, name, submit=True)
		self.assertRaises(TerminalNumberConflict, release_stale_draft, name)

	def test_prefix_locked_after_use(self):
		_make_si(self.profile, f"T01/{self.fy}/000013")
		for new in ("", "T02"):
			doc = frappe.get_doc("POS Profile", self.profile)
			doc.pospire_invoice_prefix = new
			with self.assertRaises(frappe.ValidationError) as cm:
				doc.save()
			self.assertIn("Invoice Prefix cannot be changed after invoices have used it.", str(cm.exception))
