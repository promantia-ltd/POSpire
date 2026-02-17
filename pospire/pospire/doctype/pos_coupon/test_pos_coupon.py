# Copyright (c) 2021, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, today

from pospire.pospire.doctype.pos_coupon.pos_coupon import (
	check_coupon_code,
	update_coupon_code_count,
)
from pospire.pospire.tests.test_utils import (
	create_test_coupon,
	create_test_pos_offer,
	ensure_test_company,
	ensure_test_customer,
)

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "Customer", "Campaign", "POS Offer", "Referral Code"]


class TestPOSCoupon(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()
		cls.customer = ensure_test_customer()

	def test_promotional_coupon_creation(self):
		"""Promotional coupon is created with required fields."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name)
		self.assertTrue(coupon.name)
		self.assertEqual(coupon.coupon_type, "Promotional")

	def test_promotional_coupon_code_autogeneration(self):
		"""Promotional coupon auto-generates code from name (letters only, uppercase)."""
		offer = create_test_pos_offer(self.company)
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"Summer2025Sale{frappe.generate_hash()[:4]}",
				"coupon_type": "Promotional",
				"pos_offer": offer.name,
				"company": self.company,
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
				"maximum_use": 10,
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.coupon_code)
		self.assertEqual(doc.coupon_code, doc.coupon_code.upper())

	def test_gift_card_coupon_code_autogeneration(self):
		"""Gift Card coupon auto-generates a random hash code."""
		offer = create_test_pos_offer(self.company)
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"_TestGiftCard{frappe.generate_hash()[:6]}",
				"coupon_type": "Gift Card",
				"pos_offer": offer.name,
				"company": self.company,
				"customer": self.customer,
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.coupon_code)
		self.assertEqual(len(doc.coupon_code), 10)

	def test_gift_card_requires_customer(self):
		"""Gift Card coupon throws if customer is not set."""
		offer = create_test_pos_offer(self.company)
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"_TestGiftNoCustomer{frappe.generate_hash()[:6]}",
				"coupon_type": "Gift Card",
				"pos_offer": offer.name,
				"company": self.company,
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_company_mismatch_validation(self):
		"""Coupon throws if company differs from POS Offer company."""
		companies = frappe.get_all("Company", limit=2, pluck="name")
		if len(companies) < 2:
			self.skipTest("Need at least 2 companies")

		offer = create_test_pos_offer(companies[0])
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"_TestMismatch{frappe.generate_hash()[:6]}",
				"coupon_type": "Promotional",
				"pos_offer": offer.name,
				"company": companies[1],
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
				"maximum_use": 10,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_disabled_offer_validation(self):
		"""Coupon throws if the linked POS Offer is disabled."""
		offer = create_test_pos_offer(self.company, disable=1)
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"_TestDisabled{frappe.generate_hash()[:6]}",
				"coupon_type": "Promotional",
				"pos_offer": offer.name,
				"company": self.company,
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
				"maximum_use": 10,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_non_coupon_based_offer_validation(self):
		"""Coupon throws if POS Offer is not coupon_based."""
		offer = create_test_pos_offer(self.company, coupon_based=0)
		doc = frappe.get_doc(
			{
				"doctype": "POS Coupon",
				"coupon_name": f"_TestNonCoupon{frappe.generate_hash()[:6]}",
				"coupon_type": "Promotional",
				"pos_offer": offer.name,
				"company": self.company,
				"valid_from": today(),
				"valid_upto": add_days(today(), 30),
				"maximum_use": 10,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_check_coupon_code_valid(self):
		"""check_coupon_code returns coupon for a valid code."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name)
		result = check_coupon_code(coupon.coupon_code)
		self.assertIsNotNone(result.get("coupon"))
		self.assertEqual(result["msg"], "Apply")

	def test_check_coupon_code_nonexistent(self):
		"""check_coupon_code returns error for non-existent code."""
		result = check_coupon_code("NONEXISTENT999")
		self.assertIsNone(result.get("coupon"))
		self.assertIn("not exists", result["msg"])

	def test_check_coupon_code_expired(self):
		"""check_coupon_code returns error for expired coupon."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(
			self.company,
			offer.name,
			valid_from=add_days(today(), -60),
			valid_upto=add_days(today(), -1),
		)
		result = check_coupon_code(coupon.coupon_code)
		self.assertIsNone(result.get("coupon"))
		self.assertIn("expired", result["msg"])

	def test_check_coupon_code_not_started(self):
		"""check_coupon_code returns error for coupon not yet valid."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(
			self.company,
			offer.name,
			valid_from=add_days(today(), 10),
			valid_upto=add_days(today(), 30),
		)
		result = check_coupon_code(coupon.coupon_code)
		self.assertIsNone(result.get("coupon"))
		self.assertIn("not started", result["msg"])

	def test_check_coupon_code_exhausted(self):
		"""check_coupon_code returns error when usage limit is reached."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name, maximum_use=1)
		coupon.used = 1
		coupon.save(ignore_permissions=True)
		result = check_coupon_code(coupon.coupon_code)
		self.assertIsNone(result.get("coupon"))
		self.assertIn("no longer valid", result["msg"])

	def test_update_coupon_code_count_used(self):
		"""update_coupon_code_count increments used count."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name, maximum_use=10)
		initial_used = coupon.used or 0
		update_coupon_code_count(coupon.name, "used")
		coupon.reload()
		self.assertEqual(coupon.used, initial_used + 1)

	def test_update_coupon_code_count_cancelled(self):
		"""update_coupon_code_count decrements used count on cancellation."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name, maximum_use=10)
		update_coupon_code_count(coupon.name, "used")
		coupon.reload()
		self.assertEqual(coupon.used, 1)
		update_coupon_code_count(coupon.name, "cancelled")
		coupon.reload()
		self.assertEqual(coupon.used, 0)

	def test_update_coupon_code_count_exhausted_throws(self):
		"""update_coupon_code_count throws when max usage reached."""
		offer = create_test_pos_offer(self.company)
		coupon = create_test_coupon(self.company, offer.name, maximum_use=1)
		coupon.used = 1
		coupon.save(ignore_permissions=True)
		self.assertRaises(
			frappe.ValidationError,
			update_coupon_code_count,
			coupon.name,
			"used",
		)
