# Copyright (c) 2026, Rajit and Contributors
# See license.txt

# import frappe
from frappe.tests.utils import FrappeTestCase

# Prevent ERPNext fixture chain: Assortment.company → Company → _Test Holiday List
# Also ignore Item (via child table Assortment Item) → Item Default → Company → _Test Holiday List
test_ignore = ["Company", "Item"]


class TestAssortment(FrappeTestCase):
	pass
