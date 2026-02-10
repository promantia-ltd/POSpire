# Copyright (c) 2021, Youssef Restom and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "Mode of Payment", "Mpesa Settings"]


class TestMpesaC2BRegisterURL(FrappeTestCase):
	def test_creation_fields(self):
		"""Mpesa C2B Register URL has the expected field structure."""
		meta = frappe.get_meta("Mpesa C2B Register URL")
		field_names = [f.fieldname for f in meta.fields]
		self.assertIn("mpesa_settings", field_names)
		self.assertIn("mode_of_payment", field_names)
		self.assertIn("company", field_names)
		self.assertIn("register_status", field_names)

	def test_default_register_status(self):
		"""Default register_status is Pending."""
		meta = frappe.get_meta("Mpesa C2B Register URL")
		status_field = meta.get_field("register_status")
		self.assertEqual(status_field.default, "Pending")
