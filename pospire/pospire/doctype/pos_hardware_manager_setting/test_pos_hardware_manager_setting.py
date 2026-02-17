# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase


class TestPOSHardwareManagerSetting(FrappeTestCase):
	def test_single_doctype_exists(self):
		"""POS Hardware Manager Setting Single DocType can be accessed."""
		doc = frappe.get_single("POS Hardware Manager Setting")
		self.assertIsNotNone(doc)
		self.assertEqual(doc.doctype, "POS Hardware Manager Setting")

	def test_set_hardware_url(self):
		"""Hardware URL can be set and retrieved."""
		doc = frappe.get_single("POS Hardware Manager Setting")
		original_url = doc.hardware_url
		original_port = doc.port

		doc.hardware_url = "http://localhost"
		doc.port = 8080
		doc.save(ignore_permissions=True)

		doc.reload()
		self.assertEqual(doc.hardware_url, "http://localhost")
		self.assertEqual(doc.port, 8080)

		# Restore original values (hardware_url is mandatory, so keep a valid value)
		doc.hardware_url = original_url or "http://localhost"
		doc.port = original_port
		doc.save(ignore_permissions=True)
