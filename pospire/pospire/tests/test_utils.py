# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Shared test utilities and fixture provisioning for POSpire tests.

All fixture functions follow the 'ensure' pattern: return an existing record
if available, or create one if not. This makes tests work both on developer
sites (with existing data) and on fresh CI sites (empty database).
"""

import frappe
from frappe.utils import add_days, now_datetime, nowdate, today

# ---------------------------------------------------------------------------
# Fixture Functions (ensure pattern — CI-safe)
# ---------------------------------------------------------------------------


def ensure_test_company():
	"""Return the first Company, or create one if none exists."""
	companies = frappe.get_all("Company", limit=1, pluck="name")
	if companies:
		return companies[0]

	_ensure_warehouse_types()

	doc = frappe.get_doc(
		{
			"doctype": "Company",
			"company_name": "_Test POSpire Company",
			"abbr": "_TPC",
			"default_currency": "USD",
			"country": "United States",
		}
	)
	doc.insert(ignore_permissions=True, ignore_if_duplicate=True)
	return doc.name


def _ensure_warehouse_types():
	"""Ensure required Warehouse Types exist (needed by ERPNext Company.on_update)."""
	for wtype in ("Transit", "Store", "Rejected", "Reserved"):
		if not frappe.db.exists("Warehouse Type", wtype):
			frappe.get_doc({"doctype": "Warehouse Type", "name": wtype}).insert(ignore_permissions=True)


def ensure_test_customer():
	"""Return the first Customer, or create one if none exists."""
	customers = frappe.get_all("Customer", limit=1, pluck="name")
	if customers:
		return customers[0]

	customer_group = (
		frappe.db.get_single_value("Selling Settings", "customer_group")
		or frappe.db.get_value("Customer Group", {"is_group": 1}, "name")
		or _ensure_record("Customer Group", "All Customer Groups", is_group=1)
	)
	territory = (
		frappe.db.get_single_value("Selling Settings", "territory")
		or frappe.db.get_value("Territory", {"is_group": 1}, "name")
		or _ensure_record("Territory", "All Territories", is_group=1)
	)

	doc = frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": "_Test POSpire Customer",
			"customer_group": customer_group,
			"territory": territory,
		}
	)
	doc.insert(ignore_permissions=True, ignore_if_duplicate=True)
	return doc.name


def _ensure_record(doctype, name, **kwargs):
	"""Ensure a record exists, creating it if necessary. Returns the name."""
	if not frappe.db.exists(doctype, name):
		doc = frappe.get_doc({"doctype": doctype, "name": name, **kwargs})
		doc.insert(ignore_permissions=True, ignore_if_duplicate=True)
	return name


def get_test_pos_profile(company):
	"""Return the first POS Profile for the company, or None."""
	profiles = frappe.get_all(
		"POS Profile",
		filters={"company": company},
		limit=1,
		pluck="name",
	)
	return profiles[0] if profiles else None


def get_expense_account(company):
	"""Get a non-group expense account for the company."""
	accounts = frappe.get_all(
		"Account",
		filters={"company": company, "root_type": "Expense", "is_group": 0},
		limit=1,
		pluck="name",
	)
	return accounts[0] if accounts else None


def get_cost_center(company):
	"""Get a non-group cost center for the company."""
	centers = frappe.get_all(
		"Cost Center",
		filters={"company": company, "is_group": 0},
		limit=1,
		pluck="name",
	)
	return centers[0] if centers else None


# ---------------------------------------------------------------------------
# Factory Functions (create test data)
# ---------------------------------------------------------------------------


def create_test_pos_offer(company, **kwargs):
	"""Create a POS Offer for testing."""
	title = kwargs.get("title", f"_Test Offer {frappe.generate_hash()[:6]}")
	doc = frappe.get_doc(
		{
			"doctype": "POS Offer",
			"title": title,
			"company": company,
			"apply_on": kwargs.get("apply_on", "Item Code"),
			"offer": kwargs.get("offer", "Grand Total"),
			"valid_from": kwargs.get("valid_from", today()),
			"valid_upto": kwargs.get("valid_upto"),
			"description": kwargs.get("description", "Test offer"),
			"coupon_based": kwargs.get("coupon_based", 1),
			"disable": kwargs.get("disable", 0),
			"discount_type": kwargs.get("discount_type", "Discount Percentage"),
			"discount_percentage": kwargs.get("discount_percentage", 10),
		}
	)
	doc.insert(ignore_permissions=True)
	return doc


def create_test_coupon(company, pos_offer, **kwargs):
	"""Create a POS Coupon for testing with a unique coupon code."""
	uid = frappe.generate_hash()[:8]
	coupon_name = kwargs.get("coupon_name", f"_TestCoupon{uid}")
	coupon_code = kwargs.get("coupon_code", f"TC{uid.upper()}")
	doc = frappe.get_doc(
		{
			"doctype": "POS Coupon",
			"coupon_name": coupon_name,
			"coupon_type": kwargs.get("coupon_type", "Promotional"),
			"pos_offer": pos_offer,
			"company": company,
			"customer": kwargs.get("customer"),
			"valid_from": kwargs.get("valid_from", today()),
			"valid_upto": kwargs.get("valid_upto", add_days(today(), 30)),
			"maximum_use": kwargs.get("maximum_use", 10),
			"coupon_code": coupon_code,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc


def create_test_opening_shift(company, pos_profile, user="Administrator"):
	"""Create and submit a POS Opening Shift for testing."""
	doc = frappe.get_doc(
		{
			"doctype": "POS Opening Shift",
			"company": company,
			"pos_profile": pos_profile,
			"user": user,
			"period_start_date": now_datetime(),
			"posting_date": nowdate(),
			"balance_details": [
				{"mode_of_payment": "Cash", "amount": 0},
			],
		}
	)
	doc.insert(ignore_permissions=True)
	doc.submit()
	return doc


def create_test_closing_shift(company, pos_profile, opening_shift, user="Administrator"):
	"""Create a POS Closing Shift (not submitted)."""
	doc = frappe.get_doc(
		{
			"doctype": "POS Closing Shift",
			"company": company,
			"pos_profile": pos_profile,
			"user": user,
			"pos_opening_shift": opening_shift,
			"period_start_date": now_datetime(),
			"period_end_date": now_datetime(),
			"posting_date": nowdate(),
			"payment_reconciliation": [
				{
					"mode_of_payment": "Cash",
					"opening_amount": 0,
					"closing_amount": 100,
					"expected_amount": 90,
				},
			],
		}
	)
	doc.insert(ignore_permissions=True)
	return doc


def create_test_delivery_charges(company, account, cost_center, **kwargs):
	"""Create a Delivery Charges record for testing."""
	label = kwargs.get("label", f"_Test Delivery {frappe.generate_hash()[:6]}")
	doc = frappe.get_doc(
		{
			"doctype": "Delivery Charges",
			"label": label,
			"company": company,
			"default_rate": kwargs.get("default_rate", 50),
			"shipping_account": account,
			"cost_center": cost_center,
			"disabled": kwargs.get("disabled", 0),
			"profiles": kwargs.get("profiles", []),
		}
	)
	doc.insert(ignore_permissions=True)
	return doc
