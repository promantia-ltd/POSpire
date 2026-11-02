"""Fixture for the catalogue-size test: how long does a terminal take to load N items?

Creates priced STOCK items PERF-CAT-00001..N (default 9,000, which together with the ~1,100
items already on the dev site gives a catalogue of about 10,000), each with a valuation
rate, 100 units in PERF-WH-A (Material Receipts of 500 lines) and an Item Price in
"Standard Selling". Rate of PERF-CAT-nnnnn is 50 + 10 * (n % 37).

Run (dry run is the default and writes nothing):

    bench --site pospire_dev execute pospire.pospire.tests.perf_catalogue.seed
    bench --site pospire_dev execute pospire.pospire.tests.perf_catalogue.seed --kwargs '{"dry_run": 0}'
    bench --site pospire_dev execute pospire.pospire.tests.perf_catalogue.teardown --kwargs '{"dry_run": 0}'

Re-running is safe: anything that already exists is left alone. Teardown deletes the Item
Prices and disables the items (items with stock ledger entries cannot be deleted).
"""

import frappe

COUNT = 9000
PRICE_LIST = "Standard Selling"
ITEM_GROUP = "Products"
HSN_CODE = "010190"
CURRENCY = "INR"
COMPANY = "Lifestyle Retail Stores"
WAREHOUSE = "PERF-WH-A - LRS"
STOCK_QTY = 100
RECEIPT_LINES = 500


def code(n):
	return f"PERF-CAT-{n:05d}"


def rate(n):
	return 50 + 10 * (n % 37)


def seed(dry_run=1, count=COUNT):
	dry_run, count = int(dry_run), int(count)
	existing = set(frappe.get_all("Item", filters={"item_code": ["like", "PERF-CAT-%"]}, pluck="name"))
	todo = [n for n in range(1, count + 1) if code(n) not in existing]
	print(f"{'[dry-run] would ' if dry_run else ''}create {len(todo)} item(s) of {count} ({len(existing)} already exist)")

	made = 0
	for n in todo:
		if dry_run:
			continue
		val = round(rate(n) * 0.6, 2)
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code(n),
				"item_name": code(n),
				"item_group": ITEM_GROUP,
				"stock_uom": "Nos",
				"is_stock_item": 1,
				"is_sales_item": 1,
				"gst_hsn_code": HSN_CODE,
				"valuation_rate": val,
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": code(n), "price_list": PRICE_LIST, "price_list_rate": rate(n), "currency": CURRENCY, "selling": 1}
		).insert(ignore_permissions=True)
		made += 1
		if made % 200 == 0:
			frappe.db.commit()
			print(f"[done] {made}/{len(todo)} items")
	if not dry_run:
		frappe.db.commit()

	# stock: one Material Receipt per RECEIPT_LINES items that have no ledger entry in the warehouse yet
	have_stock = set(frappe.get_all("Stock Ledger Entry", filters={"item_code": ["like", "PERF-CAT-%"], "warehouse": WAREHOUSE}, pluck="item_code"))
	need = [n for n in range(1, count + 1) if code(n) not in have_stock and (dry_run or frappe.db.exists("Item", code(n)))]
	print(f"{'[dry-run] would ' if dry_run else ''}receive {STOCK_QTY} each of {len(need)} item(s) into {WAREHOUSE} in {-(-len(need) // RECEIPT_LINES)} receipt(s)")
	if not dry_run:
		for i in range(0, len(need), RECEIPT_LINES):
			chunk = need[i : i + RECEIPT_LINES]
			se = frappe.get_doc(
				{
					"doctype": "Stock Entry",
					"stock_entry_type": "Material Receipt",
					"company": COMPANY,
					"items": [{"item_code": code(n), "t_warehouse": WAREHOUSE, "qty": STOCK_QTY, "basic_rate": round(rate(n) * 0.6, 2)} for n in chunk],
				}
			)
			se.insert(ignore_permissions=True)
			se.submit()
			frappe.db.commit()
			print(f"[done] stock receipt {i // RECEIPT_LINES + 1}: {len(chunk)} items")


def teardown(dry_run=1):
	dry_run = int(dry_run)
	items = frappe.get_all("Item", filters={"item_code": ["like", "PERF-CAT-%"], "disabled": 0}, pluck="name")
	prices = frappe.get_all("Item Price", filters={"item_code": ["like", "PERF-CAT-%"]}, pluck="name")
	print(f"{'[dry-run] would ' if dry_run else ''}delete {len(prices)} Item Price(s) and disable {len(items)} Item(s)")
	if dry_run:
		return
	for p in prices:
		frappe.delete_doc("Item Price", p, force=1, ignore_permissions=True)
	for it in items:
		frappe.db.set_value("Item", it, "disabled", 1)
	frappe.db.commit()
