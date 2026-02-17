# Copyright (c) 2020, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, now_datetime, nowdate

from pospire.pospire.tests.test_utils import (
	create_test_closing_shift,
	create_test_opening_shift,
	ensure_test_company,
	get_test_pos_profile,
)

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = [
	"Company",
	"POS Profile",
	"User",
	"POS Opening Shift",
	"Sales Invoice",
	"Payment Entry",
	"Account",
	"Mode of Payment",
	"Customer",
]


class TestPOSClosingShift(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()
		cls.pos_profile = get_test_pos_profile(cls.company)
		if not cls.pos_profile:
			cls.skipTest(cls, "No POS Profile available for testing")

	def test_closing_shift_creation(self):
		"""Closing shift is created with required fields."""
		opening = create_test_opening_shift(self.company, self.pos_profile)
		closing = create_test_closing_shift(self.company, self.pos_profile, opening.name)
		self.assertTrue(closing.name)
		self.assertEqual(closing.pos_opening_shift, opening.name)

	def test_duplicate_closing_shift_validation(self):
		"""Throws if a submitted closing shift already exists for the opening shift."""
		opening = create_test_opening_shift(self.company, self.pos_profile)
		closing = create_test_closing_shift(self.company, self.pos_profile, opening.name)
		closing.submit()

		duplicate = frappe.get_doc(
			{
				"doctype": "POS Closing Shift",
				"company": self.company,
				"pos_profile": self.pos_profile,
				"user": "Administrator",
				"pos_opening_shift": opening.name,
				"period_start_date": now_datetime(),
				"period_end_date": now_datetime(),
				"posting_date": nowdate(),
				"payment_reconciliation": [
					{
						"mode_of_payment": "Cash",
						"opening_amount": 0,
						"closing_amount": 0,
						"expected_amount": 0,
					},
				],
			}
		)
		self.assertRaises(frappe.ValidationError, duplicate.insert, ignore_permissions=True)

	def test_opening_shift_must_be_open(self):
		"""Throws if the referenced opening shift is not in Open status."""
		opening = create_test_opening_shift(self.company, self.pos_profile)
		closing = create_test_closing_shift(self.company, self.pos_profile, opening.name)
		closing.submit()

		opening.reload()
		self.assertEqual(opening.status, "Closed")

		another_closing = frappe.get_doc(
			{
				"doctype": "POS Closing Shift",
				"company": self.company,
				"pos_profile": self.pos_profile,
				"user": "Administrator",
				"pos_opening_shift": opening.name,
				"period_start_date": now_datetime(),
				"period_end_date": now_datetime(),
				"posting_date": nowdate(),
				"payment_reconciliation": [
					{
						"mode_of_payment": "Cash",
						"opening_amount": 0,
						"closing_amount": 0,
						"expected_amount": 0,
					},
				],
			}
		)
		self.assertRaises(frappe.ValidationError, another_closing.insert, ignore_permissions=True)

	def test_payment_reconciliation_difference(self):
		"""Payment reconciliation calculates difference = closing - expected."""
		opening = create_test_opening_shift(self.company, self.pos_profile)
		closing = create_test_closing_shift(self.company, self.pos_profile, opening.name)
		precision = frappe.get_cached_value("System Settings", None, "currency_precision") or 3
		row = closing.payment_reconciliation[0]
		expected_diff = flt(row.closing_amount, precision) - flt(row.expected_amount, precision)
		self.assertEqual(flt(row.difference, precision), flt(expected_diff, precision))

	def test_on_submit_updates_opening_shift(self):
		"""Submitting closing shift links it to the opening shift and closes it."""
		opening = create_test_opening_shift(self.company, self.pos_profile)
		closing = create_test_closing_shift(self.company, self.pos_profile, opening.name)
		closing.submit()
		opening.reload()
		self.assertEqual(opening.pos_closing_shift, closing.name)
		self.assertEqual(opening.status, "Closed")
