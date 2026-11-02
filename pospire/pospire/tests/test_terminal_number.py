# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import json
import uuid
from contextlib import contextmanager

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate

from pospire.pospire.api.terminal_number import (
	TerminalDeviceMismatch,
	TerminalNumberConflict,
	claim_terminal,
	format_number,
	fy_code,
	get_last_number,
	parse_number,
	release_stale_draft,
	unlink_terminal_device,
)
from pospire.pospire.tests.test_utils import (
	create_test_opening_shift,
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


def _plain_user():
	email = "pospire-plain-user@example.com"
	if not frappe.db.exists("User", email):
		frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": "Plain", "send_welcome_email": 0}
		).insert(ignore_permissions=True)
	return email


@contextmanager
def _as_user(email):
	original = frappe.session.user
	frappe.set_user(email)  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-setuser
	try:
		yield
	finally:
		frappe.set_user(original)  # nosemgrep: frappe-semgrep-rules.rules.security.frappe-setuser


def _list_user_on_profile(profile, email):
	frappe.get_doc(
		{
			"doctype": "POS Profile User",
			"parent": profile,
			"parenttype": "POS Profile",
			"parentfield": "applicable_for_users",
			"user": email,
		}
	).insert(ignore_permissions=True)


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
		release_stale_draft(name, self.profile)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))
		release_stale_draft(name, self.profile)  # no row: no-op

	def test_release_submitted_raises_conflict(self):
		name = f"T01/{self.fy}/000012"
		_make_si(self.profile, name, submit=True)
		self.assertRaises(TerminalNumberConflict, release_stale_draft, name, self.profile)

	def test_prefix_locked_after_use(self):
		_make_si(self.profile, f"T01/{self.fy}/000013")
		for new in ("", "T02"):
			doc = frappe.get_doc("POS Profile", self.profile)
			doc.pospire_invoice_prefix = new
			with self.assertRaises(frappe.ValidationError) as cm:
				doc.save()
			self.assertIn("Invoice Prefix cannot be changed after invoices have used it.", str(cm.exception))


DEVICE_1 = "11111111-1111-4111-8111-111111111111"
DEVICE_2 = "22222222-2222-4222-8222-222222222222"


class TestTerminalDevice(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal B", "T02")
		frappe.db.set_value(
			"POS Profile",
			self.profile,
			{"pospire_linked_device": "", "pospire_floor_fy": "", "pospire_floor_number": 0},
		)
		self.company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)
		self.fy = fy_code(self.company, nowdate())

	def test_claim_links_first_device(self):
		res = claim_terminal(self.profile, DEVICE_1)
		self.assertEqual(res["prefix"], "T02")
		self.assertEqual(frappe.db.get_value("POS Profile", self.profile, "pospire_linked_device"), DEVICE_1)
		claim_terminal(self.profile, DEVICE_1)  # same device again is fine

	def test_claim_refuses_other_device(self):
		claim_terminal(self.profile, DEVICE_1)
		self.assertRaises(TerminalDeviceMismatch, claim_terminal, self.profile, DEVICE_2)

	def test_claim_returns_last_numbers(self):
		_make_si(self.profile, f"T02/{self.fy}/000005")
		res = claim_terminal(self.profile, DEVICE_1)
		self.assertEqual(res["last"][self.fy], 5)
		self.assertIn(self.fy, [f["code"] for f in res["fiscal_years"]])

	def test_claim_without_prefix(self):
		frappe.db.set_value("POS Profile", self.profile, "pospire_invoice_prefix", "")
		self.assertEqual(
			claim_terminal(self.profile, DEVICE_1), {"prefix": None, "fiscal_years": [], "last": {}}
		)

	def test_unlink_sets_floor_and_logs(self):
		_make_si(self.profile, f"T02/{self.fy}/000005")
		claim_terminal(self.profile, DEVICE_1)
		self.assertEqual(unlink_terminal_device(self.profile, "tablet replaced"), {"floor": 55})
		self.assertFalse(frappe.db.get_value("POS Profile", self.profile, "pospire_linked_device"))
		self.assertTrue(
			frappe.db.exists(
				"Comment",
				{
					"reference_doctype": "POS Profile",
					"reference_name": self.profile,
					"content": ["like", "Device reset%"],
				},
			)
		)
		claim_terminal(self.profile, DEVICE_2)

	def test_unlink_requires_manager(self):
		with _as_user(_plain_user()):
			self.assertRaises(frappe.PermissionError, unlink_terminal_device, self.profile, "x")

	def test_claim_needs_listed_user(self):
		email = _plain_user()
		with _as_user(email):
			self.assertRaises(frappe.PermissionError, claim_terminal, self.profile, DEVICE_1)
		_list_user_on_profile(self.profile, email)
		with _as_user(email):
			self.assertEqual(claim_terminal(self.profile, DEVICE_1)["prefix"], "T02")

	def test_second_open_shift_refused(self):
		from pospire.pospire.api.posapp import create_opening_voucher

		create_test_opening_shift(self.company, self.profile)
		self.assertRaises(
			frappe.ValidationError,
			create_opening_voucher,
			self.profile,
			self.company,
			[{"mode_of_payment": "Cash", "amount": 0}],
		)


class TestOnlinePaths(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal C", "T03")
		self.company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)
		self.fy = fy_code(self.company, nowdate())

	def _data(self, number, rate):
		return {
			"doctype": "Sales Invoice",
			"company": self.company,
			"customer": ensure_test_customer(),
			"is_pos": 0,  # skips payment validation; the number logic does not depend on it
			"pos_profile": self.profile,
			"posting_date": nowdate(),
			"items": [{"item_code": _ensure_test_item(), "qty": 1, "rate": rate}],
			"pospire_terminal_number": number,
		}

	def test_update_invoice_reuses_abandoned_slot(self):
		from pospire.pospire.api.posapp import update_invoice

		name = f"T03/{self.fy}/000001"
		update_invoice(self._data(name, 100))
		update_invoice(self._data(name, 250))
		self.assertEqual(frappe.db.count("Sales Invoice", {"name": name}), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice Item", {"parent": name}, "rate"), 250)

	def test_update_invoice_conflict_on_submitted(self):
		from pospire.pospire.api.posapp import update_invoice

		name = f"T03/{self.fy}/000002"
		_make_si(self.profile, name, submit=True)
		self.assertRaises(TerminalNumberConflict, update_invoice, self._data(name, 100))

	def test_drafts_list_hides_terminal_slots(self):
		from pospire.pospire.api.posapp import get_draft_invoices

		shift = create_test_opening_shift(self.company, self.profile)
		slot = _make_si(self.profile, f"T03/{self.fy}/000003")
		held = _make_si(self.profile)
		for si in (slot, held):
			frappe.db.set_value("Sales Invoice", si.name, "posa_pos_opening_shift", shift.name)
		names = [d.name for d in get_draft_invoices(shift.name)]
		self.assertIn(held.name, names)
		self.assertNotIn(slot.name, names)

	def test_release_refuses_other_profile_number(self):
		other = _ensure_terminal_test_profile("_Test POSpire Terminal B", "T02")
		name = f"T02/{self.fy}/000020"
		_make_si(other, name)
		self.assertRaises(frappe.ValidationError, release_stale_draft, name, self.profile)
		self.assertRaises(frappe.ValidationError, release_stale_draft, name, None)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))

	def test_create_from_order_uses_number(self):
		from unittest.mock import patch

		from pospire.pospire.api.posapp import create_sales_invoice_from_order

		def unsaved():
			return frappe.get_doc(
				{
					"doctype": "Sales Invoice",
					"company": self.company,
					"customer": ensure_test_customer(),
					"is_pos": 0,
					"pos_profile": self.profile,
					"items": [{"item_code": _ensure_test_item(), "qty": 1, "rate": 100}],
				}
			)

		name = f"T03/{self.fy}/000030"
		stale = _make_si(self.profile, name)
		with patch("pospire.pospire.api.posapp.make_sales_invoice", side_effect=lambda *a, **k: unsaved()):
			si = create_sales_invoice_from_order("SO-X", name, self.profile)
			self.assertEqual(si.name, name)
			self.assertNotEqual(si.creation, stale.creation)
			self.assertIsNone(parse_number(create_sales_invoice_from_order("SO-X").name))

	def test_create_from_order_refuses_other_profile(self):
		from unittest.mock import patch

		from pospire.pospire.api.posapp import create_sales_invoice_from_order

		other = _ensure_terminal_test_profile("_Test POSpire Terminal B", "T02")
		name = f"T02/{self.fy}/000031"
		_make_si(other, name)
		order_si = frappe.get_doc(
			{
				"doctype": "Sales Invoice",
				"company": self.company,
				"customer": ensure_test_customer(),
				"is_pos": 0,
				"pos_profile": other,  # the order's own profile must not steer the check
				"items": [{"item_code": _ensure_test_item(), "qty": 1, "rate": 100}],
			}
		)
		with patch("pospire.pospire.api.posapp.make_sales_invoice", return_value=order_si):
			self.assertRaises(
				frappe.ValidationError, create_sales_invoice_from_order, "SO-X", name, self.profile
			)
			self.assertRaises(frappe.ValidationError, create_sales_invoice_from_order, "SO-X", name)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))

	def test_release_needs_listed_user(self):
		email = _plain_user()
		name = f"T03/{self.fy}/000032"
		_make_si(self.profile, name)
		with _as_user(email):
			self.assertRaises(frappe.PermissionError, release_stale_draft, name, self.profile)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))
		_list_user_on_profile(self.profile, email)
		with _as_user(email):
			release_stale_draft(name, self.profile)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

	def test_release_requires_profile(self):
		self.assertRaises(frappe.ValidationError, release_stale_draft, f"T03/{self.fy}/000033", "")


class TestOfflinePaths(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal D", "T04")
		self.company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)
		self.fy = fy_code(self.company, nowdate())

	def _data(self, number, rate=100):
		return {
			"doctype": "Sales Invoice",
			"owner_user": "Administrator",
			"company": self.company,
			"customer": ensure_test_customer(),
			"is_pos": 0,
			"pos_profile": self.profile,
			"posting_date": nowdate(),
			"items": [{"item_code": _ensure_test_item(), "qty": 1, "rate": rate}],
			"pospire_terminal_number": number,
		}

	def _submit(self, number):
		from pospire.pospire.api import offline

		return offline.submit_invoice(self._data(number), str(uuid.uuid4()), str(uuid.uuid4()))

	def test_offline_submit_replaces_pay_draft(self):
		from pospire.pospire.api.posapp import update_invoice

		name = f"T04/{self.fy}/000001"
		update_invoice(self._data(name, 50))
		offline_id = str(uuid.uuid4())
		from pospire.pospire.api import offline

		offline.submit_invoice(self._data(name), offline_id, str(uuid.uuid4()))
		self.assertEqual(frappe.db.count("Sales Invoice", {"name": name}), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "docstatus"), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "pos_offline_id"), offline_id)

	def test_offline_submit_number_conflict(self):
		from pospire.pospire.api.offline import OfflineSubmitError

		name = f"T04/{self.fy}/000002"
		_make_si(self.profile, name, submit=True)
		with self.assertRaises(OfflineSubmitError) as cm:
			self._submit(name)
		self.assertEqual(cm.exception.error_code, "number_conflict")

	def _review_row(self, number):
		return frappe.get_doc(
			{
				"doctype": "POSpire Offline Sync Review",
				"offline_id": str(uuid.uuid4()),
				"entry_type": "invoice",
				"cashier_user": "Administrator",
				"error_category": "validation_error",
				"payload": json.dumps({"data": json.dumps(self._data(number))}),
				"original_payload": "{}",
			}
		).insert(ignore_permissions=True)

	def test_void_deletes_slot_draft_and_logs(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"T04/{self.fy}/000004"
		_make_si(self.profile, name)
		row = self._review_row(name)
		with patch("frappe.db.commit"):
			void_entry(row.name, "customer left")
		self.assertFalse(frappe.db.exists("Sales Invoice", name))
		comments = frappe.get_all(
			"Comment",
			filters={"reference_doctype": "POS Profile", "reference_name": self.profile},
			pluck="content",
		)
		self.assertTrue(any(name in c and "customer left" in c for c in comments))

	def test_void_keeps_submitted_invoice(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"T04/{self.fy}/000005"
		_make_si(self.profile, name, submit=True)
		row = self._review_row(name)
		with patch("frappe.db.commit"):
			void_entry(row.name, "dup")
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "docstatus"), 1)
