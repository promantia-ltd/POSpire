# Copyright (c) 2020, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import now_datetime, nowdate

from pospire.pospire.tests.test_utils import (
	ensure_test_company,
	get_test_pos_profile,
)

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "POS Profile", "User", "Mode of Payment"]


class TestPOSOpeningShift(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()
		cls.pos_profile = get_test_pos_profile(cls.company)
		if not cls.pos_profile:
			cls.skipTest(cls, "No POS Profile available for testing")

	def test_opening_shift_creation(self):
		"""Opening shift is created and submitted successfully."""
		doc = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": self.company,
				"pos_profile": self.pos_profile,
				"user": "Administrator",
				"period_start_date": now_datetime(),
				"posting_date": nowdate(),
				"balance_details": [
					{"mode_of_payment": "Cash", "amount": 0},
				],
			}
		)
		doc.insert(ignore_permissions=True)
		doc.submit()
		self.assertTrue(doc.name)
		self.assertEqual(doc.status, "Open")

	def test_company_mismatch_validation(self):
		"""Throws if POS Profile company differs from shift company."""
		companies = frappe.get_all("Company", limit=2, pluck="name")
		if len(companies) < 2:
			self.skipTest("Need at least 2 companies")

		other_company = next(c for c in companies if c != self.company)
		other_profile = get_test_pos_profile(other_company)
		if not other_profile:
			self.skipTest("No POS Profile for the other company")

		doc = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": self.company,
				"pos_profile": other_profile,
				"user": "Administrator",
				"period_start_date": now_datetime(),
				"posting_date": nowdate(),
				"balance_details": [
					{"mode_of_payment": "Cash", "amount": 0},
				],
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_disabled_user_validation(self):
		"""Throws if the cashier user is disabled."""
		disabled_users = frappe.get_all(
			"User", filters={"enabled": 0, "user_type": "System User"}, limit=1, pluck="name"
		)
		if not disabled_users:
			self.skipTest("No disabled system user available for testing")

		doc = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": self.company,
				"pos_profile": self.pos_profile,
				"user": disabled_users[0],
				"period_start_date": now_datetime(),
				"posting_date": nowdate(),
				"balance_details": [
					{"mode_of_payment": "Cash", "amount": 0},
				],
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_submit_sets_open_status(self):
		"""Submitted opening shift has status Open."""
		doc = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": self.company,
				"pos_profile": self.pos_profile,
				"user": "Administrator",
				"period_start_date": now_datetime(),
				"posting_date": nowdate(),
				"balance_details": [
					{"mode_of_payment": "Cash", "amount": 0},
				],
			}
		)
		doc.insert(ignore_permissions=True)
		doc.submit()
		doc.reload()
		self.assertEqual(doc.status, "Open")
		self.assertEqual(doc.docstatus, 1)
