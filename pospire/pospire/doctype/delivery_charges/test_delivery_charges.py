# Copyright (c) 2022, Youssef Restom and Contributors
# See license.txt

import json

import frappe
from frappe.tests.utils import FrappeTestCase

from pospire.pospire.doctype.delivery_charges.delivery_charges import (
	get_applicable_delivery_charges,
)
from pospire.pospire.tests.test_utils import (
	create_test_delivery_charges,
	ensure_test_company,
	get_cost_center,
	get_expense_account,
)

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "Account", "Cost Center", "POS Profile"]


class TestDeliveryCharges(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()
		cls.account = get_expense_account(cls.company)
		cls.cost_center = get_cost_center(cls.company)
		if not cls.account or not cls.cost_center:
			cls.skipTest(cls, "No expense account or cost center available")

	def test_delivery_charges_creation(self):
		"""Delivery charges record is created with required fields."""
		dc = create_test_delivery_charges(self.company, self.account, self.cost_center)
		self.assertTrue(dc.name)
		self.assertEqual(dc.company, self.company)

	def test_default_rate_zero_validation(self):
		"""Throws if default_rate is zero."""
		doc = frappe.get_doc(
			{
				"doctype": "Delivery Charges",
				"label": f"_Test ZeroRate {frappe.generate_hash()[:6]}",
				"company": self.company,
				"default_rate": 0,
				"shipping_account": self.account,
				"cost_center": self.cost_center,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_default_rate_negative_validation(self):
		"""Throws if default_rate is negative."""
		doc = frappe.get_doc(
			{
				"doctype": "Delivery Charges",
				"label": f"_Test NegRate {frappe.generate_hash()[:6]}",
				"company": self.company,
				"default_rate": -10,
				"shipping_account": self.account,
				"cost_center": self.cost_center,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_duplicate_profile_validation(self):
		"""Throws if the same POS Profile appears twice."""
		profiles = frappe.get_all(
			"POS Profile",
			filters={"company": self.company},
			limit=1,
			pluck="name",
		)
		if not profiles:
			self.skipTest("No POS Profile available")

		doc = frappe.get_doc(
			{
				"doctype": "Delivery Charges",
				"label": f"_Test DupProfile {frappe.generate_hash()[:6]}",
				"company": self.company,
				"default_rate": 50,
				"shipping_account": self.account,
				"cost_center": self.cost_center,
				"profiles": [
					{"pos_profile": profiles[0], "rate": 30},
					{"pos_profile": profiles[0], "rate": 40},
				],
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_profiles_list_json_generation(self):
		"""profiles_list is set as JSON when profiles are provided."""
		profiles = frappe.get_all(
			"POS Profile",
			filters={"company": self.company},
			limit=1,
			pluck="name",
		)
		if not profiles:
			self.skipTest("No POS Profile available")

		dc = create_test_delivery_charges(
			self.company,
			self.account,
			self.cost_center,
			profiles=[{"pos_profile": profiles[0], "rate": 30}],
		)
		self.assertIsNotNone(dc.profiles_list)
		parsed = json.loads(dc.profiles_list)
		self.assertIn(profiles[0], parsed)

	def test_profiles_list_none_when_empty(self):
		"""profiles_list is None when no profiles are provided."""
		dc = create_test_delivery_charges(self.company, self.account, self.cost_center)
		self.assertIsNone(dc.profiles_list)

	def test_get_applicable_delivery_charges(self):
		"""get_applicable_delivery_charges returns matching charges."""
		dc = create_test_delivery_charges(self.company, self.account, self.cost_center, default_rate=75)
		charges = get_applicable_delivery_charges(company=self.company)
		names = [c.name for c in charges]
		self.assertIn(dc.name, names)

	def test_get_applicable_delivery_charges_excludes_disabled(self):
		"""Disabled delivery charges are not returned."""
		dc = create_test_delivery_charges(self.company, self.account, self.cost_center, disabled=1)
		charges = get_applicable_delivery_charges(company=self.company)
		names = [c.name for c in charges]
		self.assertNotIn(dc.name, names)
