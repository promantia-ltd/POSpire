from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api.posapp import _set_company_item_tax_template

TEMPLATE_COMPANY = {"US ST 4% - BSJ": "San Jose", "US ST 4% - BNY": "New York"}


def _run(template, is_return=0, resolved="US ST 4% - BNY"):
	item = frappe._dict(item_code="ITEM-1", item_tax_template=template)
	doc = frappe._dict(
		company="New York", is_return=is_return, return_against="SINV-1" if is_return else None
	)
	with (
		patch("frappe.get_cached_value", side_effect=lambda _dt, name, _f: TEMPLATE_COMPANY.get(name)),
		patch("pospire.pospire.api.posapp.get_item_tax_template", return_value=resolved) as resolver,
	):
		_set_company_item_tax_template(item, doc)
	return item.item_tax_template, resolver.called


class TestCompanyItemTaxTemplate(FrappeTestCase):
	def test_other_company_template_is_replaced(self):
		self.assertEqual(_run("US ST 4% - BSJ"), ("US ST 4% - BNY", True))

	def test_other_company_template_dropped_when_company_has_none(self):
		self.assertEqual(_run("US ST 4% - BSJ", resolved=None), (None, True))

	def test_missing_template_is_resolved_for_company(self):
		self.assertEqual(_run(None), ("US ST 4% - BNY", True))

	def test_own_company_template_is_kept(self):
		self.assertEqual(_run("US ST 4% - BNY", resolved="other"), ("US ST 4% - BNY", False))

	def test_return_keeps_sale_template(self):
		self.assertEqual(_run("US ST 4% - BSJ", is_return=1), ("US ST 4% - BSJ", False))
