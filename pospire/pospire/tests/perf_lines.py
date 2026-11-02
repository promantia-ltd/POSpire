"""Fixture for PERF-02 (100-line cart) and PERF-03 (scanner cadence).

100 priced STOCK items PERF-LINE-001..100 (a cart of 100 distinct lines with real, varied
rates), each with a valuation rate, 1,000 units in PERF-WH-A and an Item Price in "Standard
Selling" (the price list of PERF-P1), and a barcode on the first two:

    PERF-LINE-001  barcode PERF-BC-0001
    PERF-LINE-002  barcode PERF-BC-0002

Rate of PERF-LINE-nnn is 50 + 10 * (nnn % 37), deterministic so a test can compute the
expected total without reading the server.

Also one NON-stock item, PERF-NOSTOCK-001 (rate 100), for the test of what happens when a
sale contains an item that is not inventory (defect D9).

Run (dry run is the default and writes nothing):

    bench --site pospire_dev execute pospire.pospire.tests.perf_lines.seed
    bench --site pospire_dev execute pospire.pospire.tests.perf_lines.seed --kwargs '{"dry_run": 0}'
    bench --site pospire_dev execute pospire.pospire.tests.perf_lines.teardown --kwargs '{"dry_run": 0}'

Re-running is safe: anything that already exists is left alone.
"""

import frappe

COUNT = 100
PRICE_LIST = "Standard Selling"
ITEM_GROUP = "Products"
HSN_CODE = "010190"
CURRENCY = "INR"
BARCODES = {1: "PERF-BC-0001", 2: "PERF-BC-0002"}
COMPANY = "Lifestyle Retail Stores"
WAREHOUSE = "PERF-WH-A - LRS"
STOCK_QTY = 1000
NOSTOCK = "PERF-NOSTOCK-001"
NOSTOCK_RATE = 100


def code(n):
	return f"PERF-LINE-{n:03d}"


def rate(n):
	return 50 + 10 * (n % 37)


def _log(dry_run, msg):
	print(f"{'[dry-run] would ' if dry_run else '[done] '}{msg}")


def _has_ledger(item):
	return bool(frappe.db.exists("Stock Ledger Entry", {"item_code": item}))


def seed(dry_run=1):
	dry_run = int(dry_run)
	made_items = made_prices = converted = 0
	to_receive = []
	for n in range(1, COUNT + 1):
		item = code(n)
		val = round(rate(n) * 0.6, 2)
		if not frappe.db.exists("Item", item):
			made_items += 1
			if not dry_run:
				doc = {
					"doctype": "Item",
					"item_code": item,
					"item_name": item,
					"item_group": ITEM_GROUP,
					"stock_uom": "Nos",
					"is_stock_item": 1,
					"is_sales_item": 1,
					"gst_hsn_code": HSN_CODE,
					"valuation_rate": val,
				}
				if n in BARCODES:
					doc["barcodes"] = [{"barcode": BARCODES[n]}]
				frappe.get_doc(doc).insert(ignore_permissions=True)
		else:
			cur = frappe.db.get_value("Item", item, ["is_stock_item", "valuation_rate"], as_dict=True)
			if not cur.is_stock_item and not _has_ledger(item):
				converted += 1
				_log(dry_run, f"turn {item} into a stock item (valuation rate {val})")
				if not dry_run:
					frappe.db.set_value("Item", item, {"is_stock_item": 1, "valuation_rate": val})
			if n in BARCODES and not frappe.db.exists("Item Barcode", {"parent": item, "barcode": BARCODES[n]}):
				_log(dry_run, f"add barcode {BARCODES[n]} to existing {item}")
				if not dry_run:
					doc = frappe.get_doc("Item", item)
					doc.append("barcodes", {"barcode": BARCODES[n]})
					doc.save(ignore_permissions=True)
		if not frappe.db.exists("Stock Ledger Entry", {"item_code": item, "warehouse": WAREHOUSE}):
			to_receive.append({"item_code": item, "t_warehouse": WAREHOUSE, "qty": STOCK_QTY, "basic_rate": val})
		if not frappe.db.exists("Item Price", {"item_code": item, "price_list": PRICE_LIST}):
			made_prices += 1
			if not dry_run:
				frappe.get_doc({"doctype": "Item Price", "item_code": item, "price_list": PRICE_LIST, "price_list_rate": rate(n), "currency": CURRENCY, "selling": 1}).insert(ignore_permissions=True)

	if not frappe.db.exists("Item", NOSTOCK):
		_log(dry_run, f"create non-stock Item {NOSTOCK} @ {NOSTOCK_RATE}")
		if not dry_run:
			frappe.get_doc({"doctype": "Item", "item_code": NOSTOCK, "item_name": NOSTOCK, "item_group": ITEM_GROUP, "stock_uom": "Nos", "is_stock_item": 0, "is_sales_item": 1, "gst_hsn_code": HSN_CODE}).insert(ignore_permissions=True)
	if not frappe.db.exists("Item Price", {"item_code": NOSTOCK, "price_list": PRICE_LIST}):
		if not dry_run:
			frappe.get_doc({"doctype": "Item Price", "item_code": NOSTOCK, "price_list": PRICE_LIST, "price_list_rate": NOSTOCK_RATE, "currency": CURRENCY, "selling": 1}).insert(ignore_permissions=True)

	if to_receive:
		_log(dry_run, f"receive {STOCK_QTY} each of {len(to_receive)} item(s) into {WAREHOUSE} (one Material Receipt)")
		if not dry_run:
			se = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "company": COMPANY, "items": to_receive})
			se.insert(ignore_permissions=True)
			se.submit()
	_log(dry_run, f"create {made_items} Item(s) (of {COUNT}), convert {converted} to stock items, create {made_prices} Item Price(s) in {PRICE_LIST}, barcodes {sorted(BARCODES.values())}")
	if not dry_run:
		frappe.db.commit()


def teardown(dry_run=1):
	dry_run = int(dry_run)
	for item in [code(n) for n in range(1, COUNT + 1)] + [NOSTOCK]:
		for price in frappe.get_all("Item Price", filters={"item_code": item}, pluck="name"):
			_log(dry_run, f"delete Item Price {price}")
			if not dry_run:
				frappe.delete_doc("Item Price", price, force=1, ignore_permissions=True)
		if frappe.db.exists("Item", item):
			_log(dry_run, f"delete Item {item}")
			if not dry_run:
				try:
					frappe.delete_doc("Item", item, force=1, ignore_permissions=True)
				except Exception as e:  # an item that was sold cannot be deleted: disable it instead
					frappe.db.set_value("Item", item, "disabled", 1)
					print(f"[done] {item} is in use ({e.__class__.__name__}); disabled instead")
	if not dry_run:
		frappe.db.commit()
