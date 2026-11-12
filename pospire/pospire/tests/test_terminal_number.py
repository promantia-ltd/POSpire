# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import json
import uuid
from contextlib import contextmanager

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, nowdate

from pospire.pospire.api.terminal_number import (
	TerminalDeviceMismatch,
	TerminalNumberConflict,
	autoname,
	claim_terminal,
	format_number,
	fy_code,
	get_last_number,
	holds_number,
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
		self.assertEqual(format_number("ZT1", "26", 123), "ZT1/26/000123")
		self.assertEqual(parse_number("ZT1/26/000123"), ("ZT1", "26", 123))

	def test_parse_rejects_other_names(self):
		for name in ("ACC-SINV-2026-00001", "ZT1/26/000123-1", "ZT1/2627/00123", "zt1/26/000123", None):
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
		doc.pospire_invoice_prefix = "zt1"
		doc.save()
		self.assertEqual(doc.pospire_invoice_prefix, "ZT1")
		for bad in ("1AB", "ABCDE", "T-1"):
			doc.pospire_invoice_prefix = bad
			self.assertRaises(frappe.ValidationError, doc.save)

	def test_prefix_unique_across_profiles(self):
		first, second = self._profiles()
		first.pospire_invoice_prefix = "ZT1"
		first.save()
		second.pospire_invoice_prefix = "ZT1"
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
	frappe.set_user(email)  # nosemgrep: frappe-setuser
	try:
		yield
	finally:
		frappe.set_user(original)  # nosemgrep: frappe-setuser


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


# Device secrets as a till creates them (the server needs at least 32 characters).
KEY_1 = "k1" * 20
KEY_2 = "k2" * 20


@contextmanager
def _sending_key(key):
	"""Simulates the device-key request header (None: no header)."""
	from unittest.mock import patch

	with patch("pospire.pospire.api.terminal_number._presented_key", return_value=key):
		yield


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


def _payment_request(invoice, docstatus=0):
	"""Bare Payment Request row pointing at `invoice`; only the reference matters here."""
	frappe.get_doc(
		{
			"doctype": "Payment Request",
			"name": frappe.generate_hash(length=10),
			"reference_doctype": "Sales Invoice",
			"reference_name": invoice,
			"docstatus": docstatus,
		}
	).db_insert()


class TestTerminalNumbering(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal A", "ZT1")
		company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)  # FrappeTestCase only rolls back per class
		self.fy = fy_code(company, nowdate())

	def test_terminal_number_becomes_name(self):
		si = _make_si(self.profile, f"ZT1/{self.fy}/000007")
		self.assertEqual(si.name, f"ZT1/{self.fy}/000007")
		self.assertNotIn("pospire_terminal_number", frappe.db.get_table_columns("Sales Invoice"))

	def test_no_number_uses_naming_series(self):
		self.assertIsNone(parse_number(_make_si(self.profile).name))

	def test_wrong_prefix_or_year_throws(self):
		for bad in (f"ZT2/{self.fy}/000001", "ZT1/99/000001"):
			self.assertRaises(frappe.ValidationError, _make_si, self.profile, bad)

	def test_return_ignores_terminal_number(self):
		si = _make_si(self.profile, f"ZT1/{self.fy}/000008", is_return=1)
		self.assertIsNone(parse_number(si.name))

	def test_last_number_and_floor(self):
		_make_si(self.profile, f"ZT1/{self.fy}/000005", submit=True)
		self.assertEqual(get_last_number(self.profile, self.fy), 5)
		frappe.db.set_value(
			"POS Profile", self.profile, {"pospire_floor_fy": self.fy, "pospire_floor_number": 60}
		)
		self.assertEqual(get_last_number(self.profile, self.fy), 60)

	def test_last_number_counts_used_numbers_only(self):
		_make_si(self.profile, f"ZT1/{self.fy}/000003", submit=True).cancel()
		self.assertEqual(get_last_number(self.profile, self.fy), 3)  # cancelled counts
		_make_si(self.profile, f"ZT1/{self.fy}/000004", submit=True)
		self.assertEqual(get_last_number(self.profile, self.fy), 4)  # submitted counts
		unused = _make_si(self.profile, f"ZT1/{self.fy}/000005")
		self.assertEqual(get_last_number(self.profile, self.fy), 4)  # unused Pay draft does not
		_payment_request(unused.name, docstatus=2)
		self.assertEqual(get_last_number(self.profile, self.fy), 4)  # cancelled request does not
		_payment_request(unused.name)
		self.assertEqual(get_last_number(self.profile, self.fy), 5)  # draft with a request does

	def test_last_number_ignores_non_numeric_names(self):
		_make_si(self.profile, f"ZT1/{self.fy}/000005", submit=True)
		lookalike = _make_si(self.profile)
		frappe.rename_doc("Sales Invoice", lookalike.name, f"ZT1/{self.fy}/CN0001", force=True)
		_payment_request(f"ZT1/{self.fy}/CN0001")  # used, and sorts above every digit
		self.assertEqual(get_last_number(self.profile, self.fy), 5)

	def test_number_needs_a_user_of_the_till(self):
		email = _plain_user()
		with _as_user(email):
			self.assertRaises(frappe.PermissionError, _make_si, self.profile, f"ZT1/{self.fy}/000017")
		self.assertFalse(frappe.db.exists("Sales Invoice", f"ZT1/{self.fy}/000017"))

	def test_release_draft_with_payment_request_conflicts(self):
		name = f"ZT1/{self.fy}/000014"
		_make_si(self.profile, name)
		_payment_request(name)
		self.assertRaises(TerminalNumberConflict, release_stale_draft, name, self.profile)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))

	def test_naming_rule_override_refused(self):
		from unittest.mock import patch

		def rule(doc):
			if doc.doctype == "Sales Invoice":
				doc.name = frappe.generate_hash(length=10)

		with patch("frappe.model.naming.set_naming_from_document_naming_rule", side_effect=rule):
			with self.assertRaises(frappe.ValidationError) as cm:
				_make_si(self.profile, f"ZT1/{self.fy}/000015")
			self.assertIn("was not applied", str(cm.exception))
			_make_si(self.profile)  # no terminal number: rule name is fine
		si = _make_si(self.profile, f"ZT1/{self.fy}/000016")
		si.save()  # later save of the same doc keeps working
		self.assertEqual(si.name, f"ZT1/{self.fy}/000016")

	def test_amended_name_ignored_by_last_number(self):
		name = f"ZT1/{self.fy}/000009"
		si = _make_si(self.profile, name, submit=True)
		si.cancel()
		amended = frappe.copy_doc(si)
		amended.amended_from = si.name
		amended.docstatus = 0
		amended.insert(ignore_permissions=True)
		self.assertEqual(amended.name, name + "-1")
		self.assertEqual(get_last_number(self.profile, self.fy), 9)

	def test_release_stale_draft(self):
		name = f"ZT1/{self.fy}/000011"
		_make_si(self.profile, name)
		release_stale_draft(name, self.profile)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))
		release_stale_draft(name, self.profile)  # no row: no-op

	def test_release_submitted_raises_conflict(self):
		name = f"ZT1/{self.fy}/000012"
		_make_si(self.profile, name, submit=True)
		self.assertRaises(TerminalNumberConflict, release_stale_draft, name, self.profile)

	def test_prefix_locked_after_use(self):
		_make_si(self.profile, f"ZT1/{self.fy}/000013")
		for new in ("", "ZT2"):
			doc = frappe.get_doc("POS Profile", self.profile)
			doc.pospire_invoice_prefix = new
			with self.assertRaises(frappe.ValidationError) as cm:
				doc.save()
			self.assertIn("Invoice Prefix cannot be changed after invoices have used it.", str(cm.exception))


DEVICE_1 = "11111111-1111-4111-8111-111111111111"
DEVICE_2 = "22222222-2222-4222-8222-222222222222"


class TestTerminalDevice(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal B", "ZT2")
		frappe.db.set_value(
			"POS Profile",
			self.profile,
			{"pospire_linked_device": "", "pospire_floor_fy": "", "pospire_floor_number": 0},
		)
		self.company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)
		self.fy = fy_code(self.company, nowdate())
		self.enterContext(_sending_key(KEY_1))

	def test_claim_links_first_device(self):
		res = claim_terminal(self.profile, DEVICE_1)
		self.assertEqual(res["prefix"], "ZT2")
		self.assertEqual(frappe.db.get_value("POS Profile", self.profile, "pospire_linked_device"), DEVICE_1)
		# Same device again, e.g. two claims in flight on boot or one whose response was lost.
		claim_terminal(self.profile, DEVICE_1)

	def test_claim_refuses_other_device(self):
		claim_terminal(self.profile, DEVICE_1)
		self.assertRaises(TerminalDeviceMismatch, claim_terminal, self.profile, DEVICE_2)

	def test_claim_returns_last_numbers(self):
		_make_si(self.profile, f"ZT2/{self.fy}/000005", submit=True)
		_make_si(self.profile, f"ZT2/{self.fy}/000006")  # unused draft: next cart reuses 6
		res = claim_terminal(self.profile, DEVICE_1)
		self.assertEqual(res["last"][self.fy], 5)
		self.assertIn(self.fy, [f["code"] for f in res["fiscal_years"]])

	def test_claim_adds_last_year_only_with_backdating(self):
		start = get_fiscal_year(nowdate(), company=self.company, as_dict=True).year_start_date
		try:
			last = get_fiscal_year(add_days(start, -1), company=self.company, as_dict=True)
		except frappe.ValidationError:
			self.skipTest("previous fiscal year not set up on this site")
		last_start = str(last.year_start_date)

		def starts():
			return [f["start"] for f in claim_terminal(self.profile, DEVICE_1)["fiscal_years"]]

		frappe.db.set_value("POS Profile", self.profile, "posa_allow_change_posting_date", 0)
		self.assertNotIn(last_start, starts())
		frappe.db.set_value("POS Profile", self.profile, "posa_allow_change_posting_date", 1)
		self.assertIn(last_start, starts())

	def test_claim_without_prefix(self):
		frappe.db.set_value("POS Profile", self.profile, "pospire_invoice_prefix", "")
		self.assertEqual(
			claim_terminal(self.profile, DEVICE_1), {"prefix": None, "fiscal_years": [], "last": {}}
		)

	def test_unlink_sets_floor_and_logs(self):
		_make_si(self.profile, f"ZT2/{self.fy}/000005", submit=True)
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

	def test_linking_needs_a_device_key(self):
		with _sending_key(None):  # a page from before device secrets
			self.assertRaises(frappe.ValidationError, claim_terminal, self.profile, DEVICE_1)
		self.assertFalse(frappe.db.get_value("POS Profile", self.profile, "pospire_linked_device"))

	def test_linked_device_proves_itself_with_its_key(self):
		claim_terminal(self.profile, DEVICE_1)
		# The device id is not secret: the same id without the device's key is another device.
		for key in (None, KEY_2):
			with _sending_key(key):
				self.assertRaises(TerminalDeviceMismatch, claim_terminal, self.profile, DEVICE_1)
		claim_terminal(self.profile, DEVICE_1)

	def test_till_linked_before_keys_takes_its_first_key(self):
		frappe.db.set_value("POS Profile", self.profile, "pospire_linked_device", DEVICE_1)
		number = format_number("ZT2", self.fy, get_last_number(self.profile, self.fy) + 1)
		with _sending_key(None):  # an old page still gets its counters, but cannot use numbers
			self.assertEqual(claim_terminal(self.profile, DEVICE_1)["prefix"], "ZT2")
			self.assertFalse(holds_number(self.profile, number))
		claim_terminal(self.profile, DEVICE_1)
		self.assertTrue(holds_number(self.profile, number))
		with _sending_key(KEY_2):
			self.assertRaises(TerminalDeviceMismatch, claim_terminal, self.profile, DEVICE_1)

	def test_numbers_need_the_device_key(self):
		claim_terminal(self.profile, DEVICE_1)
		email = _plain_user()
		_list_user_on_profile(self.profile, email)
		name = format_number("ZT2", self.fy, get_last_number(self.profile, self.fy) + 1)
		with _as_user(email):
			for key in (None, KEY_2):
				with _sending_key(key):
					self.assertRaises(TerminalDeviceMismatch, _make_si, self.profile, name)
			# Naming only: the plain test user lacks the accounts access a full insert needs.
			# posting_date: autoname reads the financial year from it, as every real invoice has one.
			doc = frappe.get_doc(
				{
					"doctype": "Sales Invoice",
					"company": self.company,
					"pos_profile": self.profile,
					"posting_date": nowdate(),
				}
			)
			doc.pospire_terminal_number = name
			autoname(doc)
		self.assertEqual(doc.name, name)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

	def test_replaced_device_key_covers_only_its_skipped_block(self):
		claim_terminal(self.profile, DEVICE_1)
		last = get_last_number(self.profile, self.fy)
		floor = unlink_terminal_device(self.profile, "replaced")["floor"]
		self.assertTrue(holds_number(self.profile, format_number("ZT2", self.fy, last + 1)))
		self.assertTrue(holds_number(self.profile, format_number("ZT2", self.fy, floor)))
		self.assertFalse(holds_number(self.profile, format_number("ZT2", self.fy, floor + 1)))
		with _sending_key(KEY_2):
			claim_terminal(self.profile, DEVICE_2)
			self.assertTrue(holds_number(self.profile, format_number("ZT2", self.fy, floor + 1)))

	def test_claim_needs_listed_user(self):
		email = _plain_user()
		with _as_user(email):
			self.assertRaises(frappe.PermissionError, claim_terminal, self.profile, DEVICE_1)
		_list_user_on_profile(self.profile, email)
		with _as_user(email):
			self.assertEqual(claim_terminal(self.profile, DEVICE_1)["prefix"], "ZT2")

	def test_claim_refuses_profile_reader_not_on_restricted_till(self):
		# Accounts User can read every POS Profile; that is not cashier access to a till that lists users.
		email = "pospire-accounts-user@example.com"
		if not frappe.db.exists("User", email):
			frappe.get_doc(
				{"doctype": "User", "email": email, "first_name": "Accounts", "send_welcome_email": 0}
			).insert(ignore_permissions=True)
		frappe.get_doc("User", email).add_roles("Accounts User")
		_list_user_on_profile(self.profile, _plain_user())
		with _as_user(email):
			self.assertTrue(frappe.has_permission("POS Profile", "read", self.profile))
			self.assertRaises(frappe.PermissionError, claim_terminal, self.profile, DEVICE_1)

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
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal C", "ZT3")
		self.company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.addCleanup(frappe.db.rollback)
		self.fy = fy_code(self.company, nowdate())
		self.enterContext(_sending_key(KEY_1))

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

		name = f"ZT3/{self.fy}/000001"
		update_invoice(self._data(name, 100))
		update_invoice(self._data(name, 250))
		self.assertEqual(frappe.db.count("Sales Invoice", {"name": name}), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice Item", {"parent": name}, "rate"), 250)

	def test_update_invoice_conflict_on_submitted(self):
		from pospire.pospire.api.posapp import update_invoice

		name = f"ZT3/{self.fy}/000002"
		_make_si(self.profile, name, submit=True)
		self.assertRaises(TerminalNumberConflict, update_invoice, self._data(name, 100))

	def test_drafts_list_hides_terminal_slots(self):
		from pospire.pospire.api.posapp import get_draft_invoices

		shift = create_test_opening_shift(self.company, self.profile)
		slot = _make_si(self.profile, f"ZT3/{self.fy}/000003")
		held = _make_si(self.profile)
		for si in (slot, held):
			frappe.db.set_value("Sales Invoice", si.name, "posa_pos_opening_shift", shift.name)
		names = [d.name for d in get_draft_invoices(shift.name)]
		self.assertIn(held.name, names)
		self.assertNotIn(slot.name, names)

	def test_drafts_list_keeps_payment_request_draft(self):
		from pospire.pospire.api.posapp import get_draft_invoices

		shift = create_test_opening_shift(self.company, self.profile)
		requested = _make_si(self.profile, f"ZT3/{self.fy}/000004")
		frappe.db.set_value("Sales Invoice", requested.name, "posa_pos_opening_shift", shift.name)
		_payment_request(requested.name)
		self.assertIn(requested.name, [d.name for d in get_draft_invoices(shift.name)])

	def test_drafts_list_keeps_lookalike_names_without_prefix(self):
		from pospire.pospire.api.posapp import get_draft_invoices

		shift = create_test_opening_shift(self.company, self.profile)
		draft = _make_si(self.profile)
		lookalike = "X/26/000001"  # custom series that looks like a terminal number
		frappe.rename_doc("Sales Invoice", draft.name, lookalike, force=True)
		frappe.db.set_value("Sales Invoice", lookalike, "posa_pos_opening_shift", shift.name)
		self.assertIn(lookalike, [d.name for d in get_draft_invoices(shift.name)])  # other prefix
		frappe.db.set_value("POS Profile", self.profile, "pospire_invoice_prefix", "")
		self.assertIn(lookalike, [d.name for d in get_draft_invoices(shift.name)])  # feature off

	def test_release_refuses_other_profile_number(self):
		other = _ensure_terminal_test_profile("_Test POSpire Terminal B", "ZT2")
		name = f"ZT2/{self.fy}/000020"
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

		name = f"ZT3/{self.fy}/000030"
		stale = _make_si(self.profile, name)
		with patch("pospire.pospire.api.posapp.make_sales_invoice", side_effect=lambda *a, **k: unsaved()):
			si = create_sales_invoice_from_order("SO-X", name, self.profile)
			self.assertEqual(si.name, name)
			self.assertNotEqual(si.creation, stale.creation)
			self.assertIsNone(parse_number(create_sales_invoice_from_order("SO-X").name))

	def test_create_from_order_refuses_other_profile(self):
		from unittest.mock import patch

		from pospire.pospire.api.posapp import create_sales_invoice_from_order

		other = _ensure_terminal_test_profile("_Test POSpire Terminal B", "ZT2")
		name = f"ZT2/{self.fy}/000031"
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
		name = f"ZT3/{self.fy}/000032"
		_make_si(self.profile, name)
		with _as_user(email):
			self.assertRaises(frappe.PermissionError, release_stale_draft, name, self.profile)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))
		frappe.db.set_value("POS Profile", self.profile, "pospire_linked_device", "")
		claim_terminal(self.profile, DEVICE_1)
		_list_user_on_profile(self.profile, email)
		with _as_user(email):
			with _sending_key(None):
				self.assertRaises(TerminalDeviceMismatch, release_stale_draft, name, self.profile)
			release_stale_draft(name, self.profile)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

	def test_release_requires_profile(self):
		self.assertRaises(frappe.ValidationError, release_stale_draft, f"ZT3/{self.fy}/000033", "")


class TestOfflinePaths(FrappeTestCase):
	def setUp(self):
		self.profile = _ensure_terminal_test_profile("_Test POSpire Terminal D", "ZT4")
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

		name = f"ZT4/{self.fy}/000001"
		update_invoice(self._data(name, 50))
		offline_id = str(uuid.uuid4())
		from pospire.pospire.api import offline

		offline.submit_invoice(self._data(name), offline_id, str(uuid.uuid4()))
		self.assertEqual(frappe.db.count("Sales Invoice", {"name": name}), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "docstatus"), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "pos_offline_id"), offline_id)

	def test_offline_submit_number_conflict(self):
		from pospire.pospire.api.offline import OfflineSubmitError

		name = f"ZT4/{self.fy}/000002"
		_make_si(self.profile, name, submit=True)
		with self.assertRaises(OfflineSubmitError) as cm:
			self._submit(name)
		self.assertEqual(cm.exception.error_code, "number_conflict")

	def test_offline_owner_user_cannot_skip_the_device_key(self):
		email = _plain_user()
		_list_user_on_profile(self.profile, email)
		_list_user_on_profile(self.profile, "Administrator")
		name = f"ZT4/{self.fy}/000009"
		# owner_user in the payload is Administrator, a manager; the real caller is not.
		from pospire.pospire.api.offline import OfflineSubmitError

		with _as_user(email), self.assertRaises(OfflineSubmitError) as cm:
			self._submit(name)
		# A permission problem in Sync Review, not a bare 417 the till would file as a closed period.
		self.assertEqual(cm.exception.error_code, "permission_error")
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

	def test_offline_submit_needs_caller_on_till(self):
		name = f"ZT4/{self.fy}/000005"
		_make_si(self.profile, name)  # another cart's unused Pay slot
		with _as_user(_plain_user()):  # owner_user stays Administrator, who may use the till
			self.assertRaises(frappe.PermissionError, self._submit, name)
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "docstatus"), 0)

	def _review_row(self, number, cashier="Administrator"):
		return frappe.get_doc(
			{
				"doctype": "POSpire Offline Sync Review",
				"offline_id": str(uuid.uuid4()),
				"entry_type": "invoice",
				"cashier_user": cashier,
				"error_category": "validation_error",
				"payload": json.dumps({"data": json.dumps(self._data(number))}),
				"original_payload": "{}",
			}
		).insert(ignore_permissions=True)

	def test_void_deletes_slot_draft_and_logs(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"ZT4/{self.fy}/000004"
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

	def test_void_keeps_number_of_till_the_cashier_cannot_use(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"ZT4/{self.fy}/000006"
		_make_si(self.profile, name)
		row = self._review_row(name, cashier=_plain_user())
		with patch("frappe.db.commit"):
			void_entry(row.name, "planted row")
		self.assertTrue(frappe.db.exists("Sales Invoice", name))
		row.reload()
		self.assertEqual(row.status, "Voided")
		self.assertTrue(any("not released" in (a.detail or "") for a in row.activity))

	def test_void_keeps_submitted_invoice(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"ZT4/{self.fy}/000005"
		_make_si(self.profile, name, submit=True)
		row = self._review_row(name)
		frappe.clear_messages()
		with patch("frappe.db.commit"):
			void_entry(row.name, "dup")
		# The void succeeds, so no "already used" error may reach the desk as a popup.
		self.assertFalse(any("is already used" in str(m) for m in frappe.get_message_log()))
		self.assertEqual(frappe.db.get_value("Sales Invoice", name, "docstatus"), 1)
		comments = self._comments()
		self.assertTrue(any(f"Invoice number {name} is used by another invoice" in c for c in comments))
		self.assertFalse(any(f"Invoice number {name} voided" in c for c in comments))

	def _comments(self):
		return frappe.get_all(
			"Comment",
			filters={"reference_doctype": "POS Profile", "reference_name": self.profile},
			pluck="content",
		)

	def test_void_keeps_payment_request_draft(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"ZT4/{self.fy}/000006"
		_make_si(self.profile, name)
		_payment_request(name)
		row = self._review_row(name)
		with patch("frappe.db.commit"):
			void_entry(row.name, "paid by link")
		self.assertTrue(frappe.db.exists("Sales Invoice", name))
		self.assertEqual(frappe.db.get_value("POSpire Offline Sync Review", row.name, "status"), "Voided")
		self.assertTrue(
			any(f"Invoice number {name} is used by another invoice" in c for c in self._comments())
		)

	def test_void_link_exists_treated_as_conflict(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		name = f"ZT4/{self.fy}/000007"
		_make_si(self.profile, name)
		row = self._review_row(name)

		def linked(*args, **kwargs):
			frappe.throw("linked", frappe.LinkExistsError)

		with patch("frappe.db.commit"), patch("frappe.delete_doc", side_effect=linked):
			void_entry(row.name, "linked")
		self.assertEqual(frappe.db.get_value("POSpire Offline Sync Review", row.name, "status"), "Voided")
		self.assertTrue(
			any(f"Invoice number {name} is used by another invoice" in c for c in self._comments())
		)

	def test_void_skips_other_profile_number(self):
		from unittest.mock import patch

		from pospire.pospire.api.recovery import void_entry

		other = _ensure_terminal_test_profile("_Test POSpire Terminal B", "ZT2")
		name = f"ZT2/{self.fy}/000008"
		_make_si(other, name)
		row = self._review_row(name)  # payload profile is ZT4's, number is ZT2's
		with patch("frappe.db.commit"):
			void_entry(row.name, "mismatch")
		self.assertEqual(frappe.db.get_value("POSpire Offline Sync Review", row.name, "status"), "Voided")
		self.assertTrue(frappe.db.exists("Sales Invoice", name))
		self.assertFalse(any(name in c for c in self._comments()))
