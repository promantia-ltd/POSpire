# Copyright (c) 2021, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "Customer", "Payment Entry", "Mode of Payment", "Currency"]


class TestMpesaPaymentRegister(FrappeTestCase):
	def test_creation(self):
		"""Mpesa Payment Register is created with basic fields."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "John",
				"middlename": "M",
				"lastname": "Doe",
				"transamount": 1000,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254712345678",
				"businessshortcode": "174379",
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.name)

	def test_set_missing_values_currency(self):
		"""set_missing_values sets currency to KES."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "Jane",
				"lastname": "Doe",
				"transamount": 500,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254700000000",
				"businessshortcode": "174379",
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertEqual(doc.currency, "KES")

	def test_set_missing_values_full_name(self):
		"""set_missing_values builds full_name from name parts."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "Alice",
				"middlename": "B",
				"lastname": "Smith",
				"transamount": 200,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254711111111",
				"businessshortcode": "174379",
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertEqual(doc.full_name, "Alice B Smith")

	def test_set_missing_values_full_name_partial(self):
		"""set_missing_values handles missing middle/last name."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "Bob",
				"transamount": 300,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254722222222",
				"businessshortcode": "174379",
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertEqual(doc.full_name, "Bob")

	def test_before_submit_requires_transamount(self):
		"""before_submit throws if transamount is missing."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "Test",
				"transamount": 0,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254733333333",
				"businessshortcode": "174379",
			}
		)
		doc.insert(ignore_permissions=True)
		self.assertRaises(frappe.ValidationError, doc.submit)

	def test_before_submit_requires_company(self):
		"""before_submit throws if company is not set."""
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa Payment Register",
				"firstname": "Test",
				"transamount": 100,
				"transid": f"TXN{frappe.generate_hash()[:8]}",
				"msisdn": "254744444444",
				"businessshortcode": "000000",
			}
		)
		doc.insert(ignore_permissions=True)
		if not doc.company:
			self.assertRaises(frappe.ValidationError, doc.submit)
		else:
			self.skipTest("Company was auto-set from register URL")
