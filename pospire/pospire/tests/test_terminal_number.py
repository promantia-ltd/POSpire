# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

import frappe
from erpnext.accounts.utils import get_fiscal_year
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate

from pospire.pospire.api.terminal_number import format_number, fy_code, parse_number
from pospire.pospire.tests.test_utils import ensure_test_company


class TestNumberFormat(FrappeTestCase):
	def test_format_and_parse_round_trip(self):
		self.assertEqual(format_number("T01", "26", 123), "T01/26/000123")
		self.assertEqual(parse_number("T01/26/000123"), ("T01", "26", 123))

	def test_parse_rejects_other_names(self):
		for name in ("ACC-SINV-2026-00001", "T01/26/000123-1", "T01/2627/00123", "t01/26/000123", None):
			self.assertIsNone(parse_number(name))

	def test_fy_code_uses_fiscal_year_start(self):
		company = ensure_test_company()
		start = get_fiscal_year(nowdate(), company=company, as_dict=True).year_start_date
		self.assertEqual(fy_code(company, nowdate()), str(start.year)[-2:])


class TestPrefixValidation(FrappeTestCase):
	def _profiles(self):
		names = frappe.get_all("POS Profile", pluck="name", order_by="name", limit=2)
		self.assertEqual(len(names), 2, "needs two POS Profiles")
		return [frappe.get_doc("POS Profile", n) for n in names]

	def test_prefix_upper_cased_and_validated(self):
		doc = self._profiles()[0]
		doc.pospire_invoice_prefix = "t01"
		doc.save()
		self.assertEqual(doc.pospire_invoice_prefix, "T01")
		for bad in ("1AB", "ABCDE", "T-1"):
			doc.pospire_invoice_prefix = bad
			self.assertRaises(frappe.ValidationError, doc.save)

	def test_prefix_unique_across_profiles(self):
		first, second = self._profiles()
		first.pospire_invoice_prefix = "T01"
		first.save()
		second.pospire_invoice_prefix = "T01"
		self.assertRaises(frappe.ValidationError, second.save)
