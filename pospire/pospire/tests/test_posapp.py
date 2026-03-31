# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api.posapp import create_customer
from pospire.pospire.tests.test_utils import ensure_test_company

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["Company", "Customer"]


def ensure_customer_group():
	if frappe.db.exists("Customer Group", "All Customer Groups"):
		return "All Customer Groups"

	frappe.get_doc(
		{"doctype": "Customer Group", "customer_group_name": "All Customer Groups", "is_group": 1}
	).insert(ignore_permissions=True, ignore_if_duplicate=True)
	return "All Customer Groups"


def ensure_territory():
	if frappe.db.exists("Territory", "All Territories"):
		return "All Territories"

	frappe.get_doc({"doctype": "Territory", "territory_name": "All Territories", "is_group": 1}).insert(
		ignore_permissions=True, ignore_if_duplicate=True
	)
	return "All Territories"


class TestPOSApp(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.company = ensure_test_company()
		cls.customer_group = ensure_customer_group()
		cls.territory = ensure_territory()

	def test_create_customer_accepts_native_pos_profile_dict(self):
		"""SPA requests send JSON objects, not stringified form-data blobs."""
		customer_name = f"_Test SPA Customer {frappe.generate_hash(length=6)}"

		result = create_customer(
			customer_id="",
			customer_name=customer_name,
			company=self.company,
			pos_profile_doc={"posa_allow_duplicate_customer_names": 0},
			customer_group=self.customer_group,
			territory=self.territory,
			customer_type="Individual",
			gender="Male",
			method="create",
		)

		self.assertTrue(result and result.get("name"))
		self.assertTrue(frappe.db.exists("Customer", result["name"]))

	def test_update_customer_accepts_native_pos_profile_dict(self):
		"""Edit customer in the SPA uses the same endpoint with method='update'."""
		customer = frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_name": f"_Test SPA Edit Customer {frappe.generate_hash(length=6)}",
				"customer_group": self.customer_group,
				"territory": self.territory,
			}
		).insert(ignore_permissions=True)
		updated_name = f"{customer.customer_name} Updated"

		result = create_customer(
			customer_id=customer.name,
			customer_name=updated_name,
			company=self.company,
			pos_profile_doc={"posa_allow_duplicate_customer_names": 0},
			mobile_no="9999999999",
			email_id="spa-edit@example.com",
			customer_group=self.customer_group,
			territory=self.territory,
			customer_type="Individual",
			gender="Male",
			method="update",
		)

		customer.reload()
		self.assertEqual(result["name"], customer.name)
		self.assertEqual(customer.customer_name, updated_name)
		self.assertEqual(customer.mobile_no, "9999999999")
		self.assertEqual(customer.email_id, "spa-edit@example.com")
