# Copyright (c) 2021, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import today

from pospire.pospire.tests.test_utils import ensure_test_company

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = [
	"Company",
	"POS Profile",
	"Item",
	"Item Group",
	"Brand",
	"Warehouse",
	"Loyalty Program",
]


class TestPOSOffer(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()

	def test_offer_creation(self):
		"""POS Offer is created with required fields."""
		doc = frappe.get_doc(
			{
				"doctype": "POS Offer",
				"title": f"_Test Offer {frappe.generate_hash()[:6]}",
				"company": self.company,
				"apply_on": "Item Code",
				"offer": "Grand Total",
				"valid_from": today(),
				"description": "Test offer description",
				"discount_type": "Discount Percentage",
				"discount_percentage": 10,
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.name)
		self.assertEqual(doc.company, self.company)

	def test_offer_with_coupon_based(self):
		"""POS Offer is created with coupon_based enabled."""
		doc = frappe.get_doc(
			{
				"doctype": "POS Offer",
				"title": f"_Test Coupon Offer {frappe.generate_hash()[:6]}",
				"company": self.company,
				"apply_on": "Transaction",
				"offer": "Grand Total",
				"valid_from": today(),
				"description": "Coupon-based offer",
				"coupon_based": 1,
				"discount_type": "Discount Amount",
				"discount_amount": 100,
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.name)
		self.assertEqual(doc.coupon_based, 1)
