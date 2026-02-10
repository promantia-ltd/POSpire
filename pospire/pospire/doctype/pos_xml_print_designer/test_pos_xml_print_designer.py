# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase

# Skip ERPNext test record bootstrapping — tests create their own fixtures
test_ignore = ["DocType"]

VALID_XML_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<output>
  <ticket>
    <text>{{ doc.name }}</text>
  </ticket>
</output>"""


class TestPOSXMLPrintDesigner(FrappeTestCase):
	def _create_designer(self, **kwargs):
		"""Helper to create a POS XML Print Designer document."""
		doc = frappe.get_doc(
			{
				"doctype": "POS XML Print Designer",
				"print_format": kwargs.get(
					"print_format",
					f"_Test Format {frappe.generate_hash()[:6]}",
				),
				"ref_doctype": kwargs.get("ref_doctype", "Sales Invoice"),
				"ref_docname": kwargs.get("ref_docname"),
				"xml_template": kwargs.get("xml_template"),
				"is_default": kwargs.get("is_default", 0),
			}
		)
		return doc

	def _get_ref_docname(self, doctype="Sales Invoice"):
		"""Get an existing document name for the given DocType."""
		docs = frappe.get_all(doctype, limit=1, pluck="name")
		return docs[0] if docs else None

	def test_creation(self):
		"""POS XML Print Designer is created with required fields."""
		ref_docname = self._get_ref_docname()
		if not ref_docname:
			self.skipTest("No Sales Invoice available for testing")

		doc = self._create_designer(ref_docname=ref_docname)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.name)

	def test_default_requires_template(self):
		"""Throws if is_default is set without xml_template content."""
		ref_docname = self._get_ref_docname()
		if not ref_docname:
			self.skipTest("No Sales Invoice available for testing")

		doc = self._create_designer(
			ref_docname=ref_docname,
			is_default=1,
			xml_template=None,
		)
		self.assertRaises(frappe.ValidationError, doc.insert, ignore_permissions=True)

	def test_default_with_template_succeeds(self):
		"""Succeeds when is_default is set with valid xml_template."""
		ref_docname = self._get_ref_docname()
		if not ref_docname:
			self.skipTest("No Sales Invoice available for testing")

		doc = self._create_designer(
			ref_docname=ref_docname,
			is_default=1,
			xml_template=VALID_XML_TEMPLATE,
		)
		doc.insert(ignore_permissions=True)
		self.assertTrue(doc.name)
		self.assertEqual(doc.is_default, 1)

	def test_ensure_single_default(self):
		"""Setting a new default unsets other defaults for the same DocType."""
		ref_docname = self._get_ref_docname()
		if not ref_docname:
			self.skipTest("No Sales Invoice available for testing")

		first = self._create_designer(
			ref_docname=ref_docname,
			is_default=1,
			xml_template=VALID_XML_TEMPLATE,
		)
		first.insert(ignore_permissions=True)
		self.assertEqual(first.is_default, 1)

		second = self._create_designer(
			ref_docname=ref_docname,
			is_default=1,
			xml_template=VALID_XML_TEMPLATE,
		)
		second.insert(ignore_permissions=True)

		first.reload()
		self.assertEqual(first.is_default, 0)
		self.assertEqual(second.is_default, 1)
