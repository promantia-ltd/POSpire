import secrets

import frappe
from frappe.utils import add_days, nowdate
from frappe.utils.password import update_password

BASE_PROFILE = "MG Road - POS 2"
COMPANY = "Lifestyle Retail Stores"
PARENT_WAREHOUSE = "MG Road Store - LRS"
PERF_PRICE_LIST = "PERF Selling"
STANDARD_PRICE_LIST = "Standard Selling"
CURRENCY = "INR"
CASHIER_DOMAIN = "pospire.test"
# "Sales Manager" is required to submit a POS Closing Shift (that doctype only
# grants submit to System Manager and Sales Manager); without it a cashier can
# open a shift but the server answers 403 when closing it. Real cashiers on
# this site already hold it. Authorization negative tests must use the
# separate low-privilege user below, not these.
CASHIER_ROLES = ("Sales User", "POS User", "Sales Manager")
ITEM_GROUP = "Products"
# India Compliance rejects items without an HSN/SAC code; same code the
# site's existing sales items use.
HSN_CODE = "010190"
# Coupon-triggered offer the CON-08 tests attach their per-run one-use coupons to.
PERF_COUPON_OFFER = "PERF 10pct Coupon Offer"

# (warehouse_name, abbr is appended by ERPNext)
WAREHOUSES = ("PERF-WH-A", "PERF-WH-B")

# profile -> settings that deliberately differ between profiles
PROFILES = {
	"PERF-P1": {
		"warehouse": "PERF-WH-A",
		"price_list": STANDARD_PRICE_LIST,
		"payments": ("Cash", "Credit Card"),
	},
	"PERF-P2": {"warehouse": "PERF-WH-A", "price_list": PERF_PRICE_LIST, "payments": ("Cash", "Credit Card")},
	"PERF-P3": {"warehouse": "PERF-WH-B", "price_list": STANDARD_PRICE_LIST, "payments": ("Cash",)},
}

# cashier number -> profiles (first entry is that user's default profile)
CASHIERS = {
	1: ("PERF-P1", "PERF-P2"),
	2: ("PERF-P1",),
	3: ("PERF-P2",),
	4: ("PERF-P3",),
	5: ("PERF-P3",),
}

# One deliberately least-privilege cashier for authorization negative tests
# (CON-04 variant). It is assigned to the profile so it is a legitimate
# cashier there, but holds NO Sales Manager, so it cannot submit a POS Closing
# Shift by role. Any extra access it shows is the server's, not its roles'.
LOWPRIV_EMAIL = f"perf.lowpriv@{CASHIER_DOMAIN}"
LOWPRIV_ROLES = ("Sales User", "POS User")
LOWPRIV_PROFILES = ("PERF-P1",)

# Burst cashiers (CON-06): numbers FIRST_BURST..N, created only when seed(burst=N)
# is asked for. They all work on PERF-P1 with the same roles as cashiers 1-5 and
# share ONE generated password (POSPIRE_E2E_PERF_PASSWORD_BURST), so a 50-user
# run needs one .env.test entry and not fifty.
FIRST_BURST = 6
MAX_BURST = 55  # cashiers 6..55 = 50 burst cashiers
BURST_PROFILE = "PERF-P1"
# One burst cashier also gets Accounts Manager so a shift CAN be closed while drafts exist
# (closing deletes the shift's unprinted drafts, which the other cashiers' roles cannot do:
# they get HTTP 403, see CON-08a). Tests that race a close against in-flight sales use this
# account so they measure the race, not that role gap.
RACE_CASHIER = 55
RACE_EXTRA_ROLES = ("Accounts Manager",)


def _burst_roles(n):
	return CASHIER_ROLES + (RACE_EXTRA_ROLES if n == RACE_CASHIER else ())


# item_code -> {warehouse: qty}, selling rate in Standard / PERF price lists
ITEMS = {
	"PERF-STOCK": {"stock": {"PERF-WH-A": 500, "PERF-WH-B": 500}, "rate": 1000, "perf_rate": 1100},
	"PERF-LASTUNIT": {"stock": {"PERF-WH-A": 1}, "rate": 500, "perf_rate": 550},
	"PERF-ZERO": {"stock": {}, "rate": 300, "perf_rate": 330},
}


def _wh(name):
	"""Full warehouse docname, e.g. PERF-WH-A -> PERF-WH-A - LRS."""
	abbr = frappe.db.get_value("Company", COMPANY, "abbr")
	return f"{name} - {abbr}"


def cashier_email(n):
	return f"perf.cashier{n:02d}@{CASHIER_DOMAIN}"


def _log(dry_run, msg):
	print(f"{'[dry-run] would ' if dry_run else '[done] '}{msg}")


def _ensure_warehouses(dry_run):
	for name in WAREHOUSES:
		full = _wh(name)
		if frappe.db.exists("Warehouse", full):
			continue
		_log(dry_run, f"create Warehouse {full}")
		if not dry_run:
			frappe.get_doc(
				{
					"doctype": "Warehouse",
					"warehouse_name": name,
					"company": COMPANY,
					"parent_warehouse": PARENT_WAREHOUSE,
				}
			).insert(ignore_permissions=True)


def _ensure_price_list(dry_run):
	if frappe.db.exists("Price List", PERF_PRICE_LIST):
		return
	_log(dry_run, f"create Price List {PERF_PRICE_LIST}")
	if not dry_run:
		frappe.get_doc(
			{
				"doctype": "Price List",
				"price_list_name": PERF_PRICE_LIST,
				"currency": CURRENCY,
				"enabled": 1,
				"selling": 1,
			}
		).insert(ignore_permissions=True)


def _ensure_items(dry_run):
	for code, spec in ITEMS.items():
		if not frappe.db.exists("Item", code):
			_log(dry_run, f"create Item {code}")
			if not dry_run:
				frappe.get_doc(
					{
						"doctype": "Item",
						"item_code": code,
						"item_name": code,
						"item_group": ITEM_GROUP,
						"stock_uom": "Nos",
						"is_stock_item": 1,
						"is_sales_item": 1,
						"gst_hsn_code": HSN_CODE,
						"valuation_rate": spec["rate"] * 0.6,
					}
				).insert(ignore_permissions=True)

		for price_list, rate in ((STANDARD_PRICE_LIST, spec["rate"]), (PERF_PRICE_LIST, spec["perf_rate"])):
			if frappe.db.exists("Item Price", {"item_code": code, "price_list": price_list}):
				continue
			_log(dry_run, f"create Item Price {code} @ {rate} in {price_list}")
			if not dry_run:
				frappe.get_doc(
					{
						"doctype": "Item Price",
						"item_code": code,
						"price_list": price_list,
						"price_list_rate": rate,
						"currency": CURRENCY,
						"selling": 1,
					}
				).insert(ignore_permissions=True)

		for wh_name, qty in spec["stock"].items():
			wh = _wh(wh_name)
			# Receive stock only if this item/warehouse has NEVER had a ledger
			# entry: re-running must not top stock back up after a test sold it.
			if frappe.db.exists("Stock Ledger Entry", {"item_code": code, "warehouse": wh}):
				continue
			_log(dry_run, f"receive {qty} x {code} into {wh}")
			if dry_run:
				continue
			se = frappe.get_doc(
				{
					"doctype": "Stock Entry",
					"stock_entry_type": "Material Receipt",
					"company": COMPANY,
					"items": [
						{
							"item_code": code,
							"t_warehouse": wh,
							"qty": qty,
							"basic_rate": spec["rate"] * 0.6,
						}
					],
				}
			)
			se.insert(ignore_permissions=True)
			se.submit()


def _ensure_roles(dry_run, email, roles):
	"""Add any of `roles` an existing user is missing (never removes roles)."""
	user = frappe.get_doc("User", email)
	have = {r.role for r in user.roles}
	missing = [r for r in roles if r not in have]
	if not missing:
		return
	_log(dry_run, f"add roles {missing} to {email}")
	if not dry_run:
		for role in missing:
			user.append("roles", {"role": role})
		user.save(ignore_permissions=True)


def _ensure_coupon_offer(dry_run):
	"""A coupon-based POS Offer (10% off the transaction); coupons themselves are made per test run."""
	if frappe.db.exists("POS Offer", {"title": PERF_COUPON_OFFER}):
		return
	_log(dry_run, f"create POS Offer {PERF_COUPON_OFFER}")
	if dry_run:
		return
	frappe.get_doc(
		{
			"doctype": "POS Offer",
			"title": PERF_COUPON_OFFER,
			"company": COMPANY,
			# Blank profile/warehouse = applies to every profile of the company.
			"apply_on": "Transaction",
			"offer": "Grand Total",
			"discount_type": "Discount Percentage",
			"discount_percentage": 10,
			"valid_from": nowdate(),
			"valid_upto": add_days(nowdate(), 365),
			"description": "PERF suite: 10% off, coupon-triggered only",
			"coupon_based": 1,
			"auto": 0,
		}
	).insert(ignore_permissions=True)


def _ensure_users(dry_run, reset_passwords):
	"""Create cashier users; return {email: password} for newly set passwords."""
	passwords = {}
	accounts = [(cashier_email(n), f"PERF Cashier {n:02d}", CASHIER_ROLES) for n in CASHIERS]
	accounts.append((LOWPRIV_EMAIL, "PERF Low Privilege", LOWPRIV_ROLES))

	for email, first_name, roles in accounts:
		exists = frappe.db.exists("User", email)
		if exists:
			_ensure_roles(dry_run, email, roles)
		if exists and not reset_passwords:
			continue
		pwd = f"perf@{secrets.randbelow(10**6):06d}"
		if not exists:
			_log(dry_run, f"create User {email}")
			if not dry_run:
				user = frappe.get_doc(
					{
						"doctype": "User",
						"email": email,
						"first_name": first_name,
						"send_welcome_email": 0,
						"user_type": "System User",
						"enabled": 1,
						"new_password": pwd,
						"roles": [{"role": r} for r in roles],
					}
				)
				user.insert(ignore_permissions=True)
				passwords[email] = pwd
		else:
			_log(dry_run, f"reset password for {email}")
			if not dry_run:
				update_password(email, pwd)
				passwords[email] = pwd
	return passwords


def _ensure_burst_users(dry_run, reset_passwords, burst, burst_password=None):
	"""Create cashiers FIRST_BURST..burst sharing one password; return {label: password} if one was set.

	Pass `burst_password` when topping up an existing burst so new users get the SAME password.
	"""
	if burst < FIRST_BURST:
		return {}
	shared = burst_password or f"perf@{secrets.randbelow(10**6):06d}"
	did_set = False
	for n in range(FIRST_BURST, burst + 1):
		email = cashier_email(n)
		if frappe.db.exists("User", email):
			_ensure_roles(dry_run, email, _burst_roles(n))
			if reset_passwords:
				_log(dry_run, f"reset password for {email}")
				if not dry_run:
					update_password(email, shared)
					did_set = True
			continue
		_log(dry_run, f"create User {email}")
		if not dry_run:
			frappe.get_doc(
				{
					"doctype": "User",
					"email": email,
					"first_name": f"PERF Cashier {n:02d}",
					"send_welcome_email": 0,
					"user_type": "System User",
					"enabled": 1,
					"new_password": shared,
					"roles": [{"role": r} for r in _burst_roles(n)],
				}
			).insert(ignore_permissions=True)
			did_set = True
	return {"POSPIRE_E2E_PERF_PASSWORD_BURST": shared} if did_set else {}


def _ensure_burst_on_profile(dry_run, burst):
	"""Make burst cashiers legitimate cashiers of BURST_PROFILE (their only, hence default, profile)."""
	if burst < FIRST_BURST or not frappe.db.exists("POS Profile", BURST_PROFILE):
		return
	doc = frappe.get_doc("POS Profile", BURST_PROFILE)
	assigned = {r.user for r in doc.applicable_for_users}
	missing = [cashier_email(n) for n in range(FIRST_BURST, burst + 1) if cashier_email(n) not in assigned]
	if not missing:
		return
	_log(
		dry_run,
		f"assign {len(missing)} burst cashier(s) ({missing[0]} .. {missing[-1]}) to POS Profile {BURST_PROFILE}",
	)
	if not dry_run:
		for email in missing:
			doc.append("applicable_for_users", {"user": email, "default": 1})
		doc.save(ignore_permissions=True)


def _ensure_profiles(dry_run):
	if not frappe.db.exists("POS Profile", BASE_PROFILE):
		frappe.throw(f"Base POS Profile {BASE_PROFILE!r} not found; cannot clone.")

	for name, spec in PROFILES.items():
		if frappe.db.exists("POS Profile", name):
			continue
		_log(dry_run, f"create POS Profile {name} ({spec['warehouse']}, {spec['price_list']})")
		if dry_run:
			continue

		doc = frappe.copy_doc(frappe.get_doc("POS Profile", BASE_PROFILE))
		doc.name = name
		doc.warehouse = _wh(spec["warehouse"])
		doc.selling_price_list = spec["price_list"]
		doc.custom_assortment = None  # would hide the PERF items, see module docstring
		doc.payments = []
		for i, mop in enumerate(spec["payments"]):
			doc.append(
				"payments", {"mode_of_payment": mop, "default": 1 if i == len(spec["payments"]) - 1 else 0}
			)
		doc.applicable_for_users = []
		for n, profiles in CASHIERS.items():
			if name in profiles:
				doc.append(
					"applicable_for_users",
					{"user": cashier_email(n), "default": 1 if profiles[0] == name else 0},
				)
		doc.insert(ignore_permissions=True)

	_ensure_lowpriv_on_profiles(dry_run)


def _ensure_lowpriv_on_profiles(dry_run):
	"""Make the least-privilege user a legitimate cashier on its profiles (also on pre-existing ones)."""
	for name in LOWPRIV_PROFILES:
		if not frappe.db.exists("POS Profile", name):
			continue  # dry run before creation; nothing to attach to yet
		doc = frappe.get_doc("POS Profile", name)
		if any(r.user == LOWPRIV_EMAIL for r in doc.applicable_for_users):
			continue
		_log(dry_run, f"assign {LOWPRIV_EMAIL} to POS Profile {name}")
		if not dry_run:
			doc.append("applicable_for_users", {"user": LOWPRIV_EMAIL, "default": 0})
			doc.save(ignore_permissions=True)


def seed(dry_run=1, reset_passwords=0, burst=0, burst_password=None):
	"""Create the PERF topology. Dry run by default; pass dry_run=0 to write.

	`burst=N` (N up to MAX_BURST) also creates cashiers 6..N for the CON-06 burst test
	(`burst=55` is the 50-cashier burst).
	Order matters: warehouses and users before the profiles that reference them.
	"""
	dry_run = bool(int(dry_run))
	reset_passwords = bool(int(reset_passwords))
	burst = int(burst)
	if burst > MAX_BURST:
		frappe.throw(f"burst may not exceed {MAX_BURST}")

	_ensure_warehouses(dry_run)
	_ensure_price_list(dry_run)
	_ensure_items(dry_run)
	_ensure_coupon_offer(dry_run)
	passwords = _ensure_users(dry_run, reset_passwords)
	passwords.update(_ensure_burst_users(dry_run, reset_passwords, burst, burst_password))
	_ensure_profiles(dry_run)
	_ensure_burst_on_profile(dry_run, burst)

	if not dry_run:
		frappe.db.commit()

	if passwords:
		print("\nGenerated passwords (shown once, store in tests/e2e/.env.test):")
		for email, pwd in passwords.items():
			print(f"  {email}  {pwd}")
	print("\nDry run only, nothing was written." if dry_run else "\nSeed complete.")


def teardown(dry_run=1):
	"""Disable the PERF users and profiles (reversible; nothing is deleted).

	Transactional data (invoices, shifts, stock entries) is deliberately left
	alone: deleting submitted accounting documents is not a supported reset.
	Per-run cleanup is a separate concern tracked by run id in the test suite.
	"""
	dry_run = bool(int(dry_run))

	burst_emails = [cashier_email(n) for n in range(FIRST_BURST, MAX_BURST + 1)]
	for email in [cashier_email(n) for n in CASHIERS] + [LOWPRIV_EMAIL] + burst_emails:
		if frappe.db.exists("User", email) and frappe.db.get_value("User", email, "enabled"):
			_log(dry_run, f"disable User {email}")
			if not dry_run:
				frappe.db.set_value("User", email, "enabled", 0)

	for name in PROFILES:
		if frappe.db.exists("POS Profile", name) and not frappe.db.get_value("POS Profile", name, "disabled"):
			_log(dry_run, f"disable POS Profile {name}")
			if not dry_run:
				frappe.db.set_value("POS Profile", name, "disabled", 1)

	if not dry_run:
		frappe.db.commit()
	print("\nDry run only, nothing was written." if dry_run else "\nTeardown complete.")
