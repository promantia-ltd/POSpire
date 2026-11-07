# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""get_items item-group SQL stays valid on both ERPNext 16 quoting styles."""

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from pospire.pospire.api.posapp import get_item_group_condition


class TestGetItemGroupCondition(UnitTestCase):
	def test_quotes_raw_names_and_already_escaped_names_once(self):
		raw = ["Products", "All Item Groups", "O'Brien"]
		quoted = [frappe.db.escape(name) for name in raw]
		expected = " and item_group in ({})".format(", ".join(quoted))

		for names in (raw, quoted):
			with patch("pospire.pospire.api.posapp.get_item_groups", return_value=names):
				self.assertEqual(get_item_group_condition("_Test Profile"), expected)

	def test_no_groups_matches_everything(self):
		with patch("pospire.pospire.api.posapp.get_item_groups", return_value=[]):
			self.assertEqual(get_item_group_condition("_Test Profile"), " and 1=1")
