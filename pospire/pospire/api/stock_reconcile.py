# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Stock Reconciliation helpers for POS invoice submission."""

from __future__ import annotations

import frappe
from erpnext.stock.doctype.batch.batch import get_batch_qty, make_batch
from erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle import (
	get_stock_ledgers_for_serial_nos,
)
from erpnext.stock.doctype.serial_no.serial_no import get_serial_nos
from erpnext.stock.serial_batch_bundle import SerialBatchCreation
from erpnext.stock.utils import get_or_make_bin, get_stock_balance
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, get_time


def ensure_stock_for_invoice(invoice_doc) -> None:
	"""Ensure stock is available for a POS Sales Invoice before submit.

	Foundation only: this currently resolves whether Auto Stock Reconciliation
	is enabled for the invoice context and exits without mutating stock.
	"""
	if not _is_auto_stock_reconcile_enabled(invoice_doc):
		return

	shortfalls = _calculate_shortfalls(invoice_doc)
	if not shortfalls:
		return

	_lock_bins(shortfalls)
	shortfalls = _calculate_shortfalls(invoice_doc)
	if not shortfalls:
		return

	for shortfall in shortfalls:
		shortfall["valuation_rate"] = _resolve_valuation_rate(shortfall, invoice_doc)

	if _find_existing_reconciliation(invoice_doc):
		return

	reconciliation = _build_stock_reconciliation(invoice_doc, shortfalls)
	if not reconciliation.items:
		return

	reconciliation.insert(ignore_permissions=True)
	reconciliation.submit()


def ensure_typed_batches_exist_for_invoice(invoice_doc) -> None:
	"""Create missing Batch masters for typed POS batches before invoice save."""
	if not _is_auto_stock_reconcile_enabled(invoice_doc):
		return

	for row in invoice_doc.get("items") or []:
		item_code = row.get("item_code")
		batch_no = row.get("batch_no")
		if not item_code or not batch_no:
			continue

		item_details = frappe.get_cached_value(
			"Item",
			item_code,
			["has_batch_no", "has_serial_no"],
			as_dict=True,
		)
		if not item_details or not cint(item_details.has_batch_no):
			continue

		_ensure_batch_exists(item_code, batch_no, invoice_doc)


def _calculate_shortfalls(invoice_doc) -> list[dict]:
	"""Return grouped item/warehouse shortages for the invoice."""
	required_by_location = {}
	batch_required_by_location = {}
	serial_required_rows = []

	for row in invoice_doc.get("items") or []:
		item_code = row.get("item_code")
		warehouse = row.get("warehouse")
		required_qty = flt(row.get("stock_qty") or row.get("qty"))

		if not item_code or not warehouse or required_qty <= 0:
			continue

		item_details = frappe.get_cached_value(
			"Item",
			item_code,
			["has_batch_no", "has_serial_no"],
			as_dict=True,
		)
		if not item_details:
			continue

		has_serial_no = cint(item_details.has_serial_no)
		has_batch_no = cint(item_details.has_batch_no)

		if has_serial_no:
			if has_batch_no and not row.get("batch_no"):
				frappe.throw(
					_("Batch No is required for Item {0}.").format(frappe.bold(item_code)),
					frappe.ValidationError,
				)
			serial_required_rows.append(row)
			continue

		if has_batch_no:
			batch_no = row.get("batch_no")
			if not batch_no:
				frappe.throw(
					_("Batch No is required for Item {0}.").format(frappe.bold(item_code)),
					frappe.ValidationError,
				)
			key = (item_code, warehouse, batch_no)
			if key not in batch_required_by_location:
				batch_required_by_location[key] = {
					"item_code": item_code,
					"warehouse": warehouse,
					"batch_no": batch_no,
					"required_qty": 0,
					"rows": [],
				}
			batch_required_by_location[key]["required_qty"] += required_qty
			batch_required_by_location[key]["rows"].append(row)
			continue

		key = (item_code, warehouse)
		if key not in required_by_location:
			required_by_location[key] = {
				"item_code": item_code,
				"warehouse": warehouse,
				"required_qty": 0,
				"rows": [],
			}

		required_by_location[key]["required_qty"] += required_qty
		required_by_location[key]["rows"].append(row)

	shortfalls = []
	for data in required_by_location.values():
		available_qty = flt(
			get_stock_balance(
				data["item_code"],
				data["warehouse"],
				getattr(invoice_doc, "posting_date", None),
				getattr(invoice_doc, "posting_time", None),
			)
		)
		shortage_qty = flt(data["required_qty"] - available_qty)
		if shortage_qty <= 0:
			continue

		shortfalls.append(
			{
				"item_code": data["item_code"],
				"warehouse": data["warehouse"],
				"required_qty": data["required_qty"],
				"available_qty": available_qty,
				"shortage_qty": shortage_qty,
				"rows": data["rows"],
			}
		)

	for data in batch_required_by_location.values():
		available_qty = flt(
			get_batch_qty(
				batch_no=data["batch_no"],
				warehouse=data["warehouse"],
				item_code=data["item_code"],
				posting_date=getattr(invoice_doc, "posting_date", None),
				posting_time=getattr(invoice_doc, "posting_time", None),
				for_stock_levels=True,
			)
		)
		shortage_qty = flt(data["required_qty"] - available_qty)
		if shortage_qty <= 0:
			continue

		shortfalls.append(
			{
				"item_code": data["item_code"],
				"warehouse": data["warehouse"],
				"batch_no": data["batch_no"],
				"required_qty": data["required_qty"],
				"available_qty": available_qty,
				"shortage_qty": shortage_qty,
				"rows": data["rows"],
			}
		)

	for row in serial_required_rows:
		serial_nos = get_serial_nos(row.get("serial_no"))
		required_qty = flt(row.get("stock_qty") or row.get("qty"))
		if not serial_nos:
			frappe.throw(
				_("Serial No is required for Item {0}.").format(frappe.bold(row.get("item_code"))),
				frappe.ValidationError,
			)

		available_serial_nos = _get_available_serial_nos_for_stock(
			row.get("item_code"),
			row.get("warehouse"),
			invoice_doc,
			serial_nos,
		)
		missing_serial_nos = [serial_no for serial_no in serial_nos if serial_no not in available_serial_nos]
		available_qty = flt(
			get_stock_balance(
				row.get("item_code"),
				row.get("warehouse"),
				getattr(invoice_doc, "posting_date", None),
				getattr(invoice_doc, "posting_time", None),
			)
		)

		missing_qty = len(missing_serial_nos)

		if missing_qty <= 0:
			continue

		shortfalls.append(
			{
				"item_code": row.get("item_code"),
				"warehouse": row.get("warehouse"),
				"batch_no": row.get("batch_no"),
				"required_qty": required_qty,
				"available_qty": available_qty,
				"shortage_qty": missing_qty,
				"selected_serial_nos": serial_nos,
				"available_serial_nos": list(available_serial_nos),
				"missing_serial_nos": missing_serial_nos,
				"rows": [row],
			}
		)

	return shortfalls


def _lock_bins(shortfalls: list[dict]) -> None:
	"""Lock Bin rows for shorted item/warehouse pairs in stable order."""
	pairs = sorted({(d["item_code"], d["warehouse"]) for d in shortfalls})

	for item_code, warehouse in pairs:
		bin_name = get_or_make_bin(item_code, warehouse)
		frappe.get_doc("Bin", bin_name, for_update=True)


def _first_positive_rate(*rates) -> float:
	"""Return the first positive rate from the given values."""
	for rate in rates:
		rate = flt(rate)
		if rate > 0:
			return rate

	return 0


def _resolve_valuation_rate(shortfall: dict, invoice_doc) -> float:
	"""Resolve a positive valuation rate using the approved fallback chain."""
	item_code = shortfall["item_code"]
	warehouse = shortfall["warehouse"]

	current_stock = get_stock_balance(
		item_code,
		warehouse,
		getattr(invoice_doc, "posting_date", None),
		getattr(invoice_doc, "posting_time", None),
		with_valuation_rate=True,
	)
	current_valuation_rate = current_stock[1] if current_stock else 0
	batch_valuation_rate = _get_batch_valuation_rate(item_code, warehouse, shortfall.get("batch_no"))

	bin_valuation_rate = frappe.db.get_value(
		"Bin",
		{"item_code": item_code, "warehouse": warehouse},
		"valuation_rate",
	)

	item_rates = (
		frappe.db.get_value(
			"Item",
			item_code,
			["valuation_rate", "last_purchase_rate"],
			as_dict=True,
		)
		or {}
	)

	valuation_rate = _first_positive_rate(
		current_valuation_rate,
		batch_valuation_rate,
		bin_valuation_rate,
		item_rates.get("valuation_rate"),
		item_rates.get("last_purchase_rate"),
	)
	if valuation_rate:
		return valuation_rate

	frappe.throw(
		_(
			"Unable to determine a positive valuation rate for Item {0} in Warehouse {1}. "
			"Auto Stock Reconciliation cannot book zero-cost stock."
		).format(frappe.bold(item_code), frappe.bold(warehouse)),
		frappe.ValidationError,
	)


def _get_batch_valuation_rate(item_code: str, warehouse: str, batch_no: str | None) -> float:
	"""Return existing batch valuation from Stock Ledger Entries, if any."""
	if not batch_no or not frappe.db.exists("Batch", {"name": batch_no, "item": item_code}):
		return 0

	batch_valuation = frappe.db.sql(
		"""
		select sum(stock_value_difference) / sum(actual_qty)
		from `tabStock Ledger Entry`
		where item_code = %s
			and warehouse = %s
			and batch_no = %s
			and is_cancelled = 0
			and actual_qty > 0
		""",
		(item_code, warehouse, batch_no),
	)
	if batch_valuation and batch_valuation[0][0] is not None:
		return flt(batch_valuation[0][0])

	return 0


def _find_existing_reconciliation(invoice_doc) -> str | None:
	"""Return an existing non-cancelled reconciliation linked to the invoice."""
	meta = frappe.get_meta("Stock Reconciliation")
	filters = {"docstatus": ["!=", 2]}

	for fieldname, value in _get_reconciliation_link_values(invoice_doc).items():
		if not value or not meta.has_field(fieldname):
			continue

		existing = frappe.db.get_value(
			"Stock Reconciliation",
			{**filters, fieldname: value},
			"name",
		)
		if existing:
			return existing

	return None


def _build_stock_reconciliation(invoice_doc, shortfalls: list[dict]):
	"""Build one Stock Reconciliation for all invoice shortfalls."""
	posting_date, posting_time = _get_reconciliation_posting_datetime(invoice_doc)
	reconciliation = frappe.new_doc("Stock Reconciliation")
	reconciliation.company = invoice_doc.company
	reconciliation.purpose = "Stock Reconciliation"
	reconciliation.posting_date = posting_date
	reconciliation.posting_time = posting_time
	reconciliation.set_posting_time = 1

	for fieldname, value in _get_reconciliation_link_values(invoice_doc).items():
		if value and reconciliation.meta.has_field(fieldname):
			reconciliation.set(fieldname, value)

	for row in _get_reconciliation_rows(invoice_doc, shortfalls, posting_date, posting_time):
		reconciliation.append("items", row)

	return reconciliation


def _get_reconciliation_link_values(invoice_doc) -> dict:
	"""Return reconciliation link field values keyed by the installed field names."""
	return {
		"posa_pos_offline_id": getattr(invoice_doc, "pos_offline_id", None),
		"posa_sales_invoice": getattr(invoice_doc, "name", None),
	}


def _get_reconciliation_posting_datetime(invoice_doc) -> tuple:
	"""Return invoice posting datetime minus one second as date/time fields."""
	invoice_posting_datetime = get_datetime(
		f"{invoice_doc.posting_date} {invoice_doc.posting_time or '00:00:00'}"
	)
	reconciliation_datetime = add_to_date(invoice_posting_datetime, seconds=-1, as_datetime=True)
	if reconciliation_datetime.date() != invoice_posting_datetime.date():
		reconciliation_datetime = invoice_posting_datetime
	return reconciliation_datetime.date(), get_time(reconciliation_datetime)


def _get_reconciliation_rows(
	invoice_doc,
	shortfalls: list[dict],
	posting_date,
	posting_time,
) -> list[dict]:
	"""Build Stock Reconciliation item rows for regular, batch, and serial items."""
	rows = []
	for shortfall in shortfalls:
		item_details = frappe.get_cached_value(
			"Item",
			shortfall["item_code"],
			["has_batch_no", "has_serial_no"],
			as_dict=True,
		)
		if not item_details:
			continue

		if cint(item_details.has_serial_no):
			rows.extend(_get_serial_reconciliation_rows(invoice_doc, shortfall, posting_date, posting_time))
		elif cint(item_details.has_batch_no):
			rows.extend(_get_batch_reconciliation_rows(invoice_doc, shortfall, posting_date, posting_time))
		else:
			rows.append(_get_regular_reconciliation_row(shortfall))

	return rows


def _get_regular_reconciliation_row(shortfall: dict) -> dict:
	"""Return a regular Stock Reconciliation item row."""
	return {
		"item_code": shortfall["item_code"],
		"warehouse": shortfall["warehouse"],
		"qty": flt(shortfall["available_qty"]) + flt(shortfall["shortage_qty"]),
		"valuation_rate": shortfall["valuation_rate"],
		"allow_zero_valuation_rate": 0,
	}


def _get_batch_reconciliation_rows(invoice_doc, shortfall: dict, posting_date, posting_time) -> list[dict]:
	"""Return Stock Reconciliation rows for shorted batch identities."""
	rows = []
	for batch_no, required_qty in _get_required_batches(shortfall).items():
		available_qty = flt(
			get_batch_qty(
				batch_no=batch_no,
				warehouse=shortfall["warehouse"],
				item_code=shortfall["item_code"],
				posting_date=getattr(invoice_doc, "posting_date", None),
				posting_time=getattr(invoice_doc, "posting_time", None),
				for_stock_levels=True,
			)
		)
		shortage_qty = flt(required_qty - available_qty)
		if shortage_qty <= 0:
			continue

		target_qty = flt(available_qty) + flt(shortage_qty)
		_ensure_batch_exists(shortfall["item_code"], batch_no, invoice_doc)
		bundle = _make_reconciliation_bundle(
			invoice_doc=invoice_doc,
			item_code=shortfall["item_code"],
			warehouse=shortfall["warehouse"],
			qty=target_qty,
			valuation_rate=shortfall["valuation_rate"],
			posting_date=posting_date,
			posting_time=posting_time,
			batches=frappe._dict({batch_no: target_qty}),
		)
		rows.append(
			{
				"item_code": shortfall["item_code"],
				"warehouse": shortfall["warehouse"],
				"qty": target_qty,
				"valuation_rate": shortfall["valuation_rate"],
				"allow_zero_valuation_rate": 0,
				"batch_no": batch_no,
				"serial_and_batch_bundle": bundle.name,
			}
		)

	return rows


def _get_serial_reconciliation_rows(invoice_doc, shortfall: dict, posting_date, posting_time) -> list[dict]:
	"""Return Stock Reconciliation rows for missing serial identities."""
	serial_nos = _get_missing_serial_nos(shortfall)
	if not serial_nos:
		return []

	batch_no = shortfall.get("batch_no")
	target_serial_nos = _get_target_serial_nos(shortfall)
	qty = len(target_serial_nos)
	row = {
		"item_code": shortfall["item_code"],
		"warehouse": shortfall["warehouse"],
		"qty": qty,
		"valuation_rate": shortfall["valuation_rate"],
		"allow_zero_valuation_rate": 0,
		"serial_no": "\n".join(target_serial_nos),
		"use_serial_batch_fields": 1,
		"reconcile_all_serial_batch": 1,
	}
	if batch_no:
		_ensure_batch_exists(shortfall["item_code"], batch_no, invoice_doc)
		row["batch_no"] = batch_no

	if target_serial_nos:
		bundle = _make_reconciliation_bundle(
			invoice_doc=invoice_doc,
			item_code=shortfall["item_code"],
			warehouse=shortfall["warehouse"],
			qty=qty,
			valuation_rate=shortfall["valuation_rate"],
			posting_date=posting_date,
			posting_time=posting_time,
			serial_nos=target_serial_nos,
			batch_no=batch_no,
			batches=frappe._dict({batch_no: qty}) if batch_no else None,
			use_serial_batch_fields=1,
		)
		row["serial_and_batch_bundle"] = bundle.name

	return [row]


def _get_target_serial_nos(shortfall: dict) -> list[str]:
	"""Return all serials that should exist after Stock Reconciliation."""
	missing_serial_nos = set(_get_missing_serial_nos(shortfall))
	target_serial_nos = _get_active_warehouse_serial_nos(
		shortfall["item_code"],
		shortfall["warehouse"],
		shortfall.get("batch_no"),
	)
	for serial_no in missing_serial_nos:
		if serial_no not in target_serial_nos:
			target_serial_nos.append(serial_no)

	return list(dict.fromkeys(target_serial_nos))


def _get_active_warehouse_serial_nos(
	item_code: str,
	warehouse: str,
	batch_no: str | None = None,
) -> list[str]:
	"""Return active serials currently in the warehouse for the reconciliation target."""
	filters = {
		"item_code": item_code,
		"status": "Active",
		"warehouse": warehouse,
	}
	if batch_no:
		filters["batch_no"] = batch_no

	return [
		row.serial_no
		for row in frappe.get_all(
			"Serial No",
			filters=filters,
			fields=["name as serial_no"],
			order_by="name",
		)
	]


def _get_required_batches(shortfall: dict) -> dict:
	"""Return required invoice quantities by batch number."""
	batches = {}
	for row in shortfall["rows"]:
		batch_no = row.get("batch_no")
		if not batch_no:
			frappe.throw(
				_("Batch No is required for Item {0}.").format(frappe.bold(shortfall["item_code"])),
				frappe.ValidationError,
			)
		batches[batch_no] = flt(batches.get(batch_no)) + flt(row.get("stock_qty") or row.get("qty"))

	return batches


def _get_missing_serial_nos(shortfall: dict) -> list[str]:
	"""Return serial numbers that must be brought into stock."""
	if shortfall.get("missing_serial_nos"):
		return list(dict.fromkeys(shortfall["missing_serial_nos"]))

	serial_nos = []
	for row in shortfall["rows"]:
		serial_nos.extend(get_serial_nos(row.get("serial_no")))

	if not serial_nos:
		frappe.throw(
			_("Serial No is required for Item {0}.").format(frappe.bold(shortfall["item_code"])),
			frappe.ValidationError,
		)

	required_qty = sum(flt(row.get("stock_qty") or row.get("qty")) for row in shortfall["rows"])
	if len(serial_nos) > required_qty:
		frappe.throw(
			_("Too many Serial Nos provided for Item {0}.").format(frappe.bold(shortfall["item_code"])),
			frappe.ValidationError,
		)

	return list(dict.fromkeys(serial_nos))


def _get_available_serial_nos_for_stock(
	item_code: str,
	warehouse: str,
	invoice_doc,
	serial_nos: list[str],
) -> set[str]:
	"""Return serial numbers available in stock ledger at the invoice posting time."""
	serial_nos = list(dict.fromkeys(serial_nos or []))
	if not serial_nos:
		return set()

	posting_date = getattr(invoice_doc, "posting_date", None)
	posting_time = getattr(invoice_doc, "posting_time", None) or "00:00:00"
	posting_datetime = get_datetime(f"{posting_date} {posting_time}") if posting_date else None
	ledger_entries = get_stock_ledgers_for_serial_nos(
		frappe._dict(
			{
				"item_code": item_code,
				"warehouse": warehouse,
				"posting_datetime": posting_datetime,
				"serial_nos": serial_nos,
			}
		)
	)
	if not ledger_entries:
		return set()

	selected_serial_nos = set(serial_nos)
	bundle_names = [
		row.serial_and_batch_bundle for row in ledger_entries if row.get("serial_and_batch_bundle")
	]
	bundle_serial_nos = {}
	if bundle_names:
		for row in frappe.get_all(
			"Serial and Batch Entry",
			filters={
				"parent": ["in", list(set(bundle_names))],
				"serial_no": ["in", serial_nos],
			},
			fields=["parent", "serial_no"],
		):
			bundle_serial_nos.setdefault(row.parent, set()).add(row.serial_no)

	available_serial_nos = set()
	for row in ledger_entries:
		if row.get("serial_and_batch_bundle"):
			row_serial_nos = bundle_serial_nos.get(row.serial_and_batch_bundle, set())
		else:
			row_serial_nos = {
				serial_no
				for serial_no in get_serial_nos(row.get("serial_no"))
				if serial_no in selected_serial_nos
			}

		if flt(row.get("actual_qty")) > 0:
			available_serial_nos.update(row_serial_nos)
		else:
			available_serial_nos.difference_update(row_serial_nos)

	return available_serial_nos


def _ensure_batch_exists(item_code: str, batch_no: str, invoice_doc) -> None:
	"""Create a typed/scanned batch id if it does not already exist."""
	existing_item = frappe.db.get_value("Batch", batch_no, "item")
	if existing_item:
		if existing_item != item_code:
			frappe.throw(
				_("Batch {0} belongs to Item {1}, not Item {2}.").format(
					frappe.bold(batch_no),
					frappe.bold(existing_item),
					frappe.bold(item_code),
				),
				frappe.ValidationError,
			)
		return

	make_batch(
		frappe._dict(
			{
				"item": item_code,
				"batch_id": batch_no,
				"manufacturing_date": invoice_doc.posting_date,
				"reference_doctype": "Sales Invoice",
				"reference_name": invoice_doc.name,
			}
		)
	)


def _make_reconciliation_bundle(
	*,
	invoice_doc,
	item_code: str,
	warehouse: str,
	qty: float,
	valuation_rate: float,
	posting_date,
	posting_time,
	batches=None,
	serial_nos=None,
	batch_no: str | None = None,
	use_serial_batch_fields: int = 0,
):
	"""Create a draft inward Serial and Batch Bundle for Stock Reconciliation."""
	bundle = SerialBatchCreation(
		frappe._dict(
			{
				"item_code": item_code,
				"warehouse": warehouse,
				"qty": qty,
				"actual_qty": qty,
				"voucher_type": "Stock Reconciliation",
				"company": invoice_doc.company,
				"posting_date": posting_date,
				"posting_time": posting_time,
				"type_of_transaction": "Inward",
				"incoming_rate": valuation_rate,
				"batches": batches or frappe._dict(),
				"serial_nos": serial_nos or [],
				"batch_no": batch_no,
				"use_serial_batch_fields": use_serial_batch_fields,
				"do_not_submit": True,
			}
		)
	).make_serial_and_batch_bundle()
	if not bundle:
		frappe.throw(
			_("Could not create Serial and Batch Bundle for Item {0}.").format(frappe.bold(item_code)),
			frappe.ValidationError,
		)

	return bundle


def _is_auto_stock_reconcile_enabled(invoice_doc) -> bool:
	"""Return the feature flag for online or offline invoice submission."""
	offline_flags = getattr(frappe.flags, "pospire_offline_shift_flags", None)
	if isinstance(offline_flags, dict) and "posa_auto_stock_reconcile" in offline_flags:
		return cint(offline_flags.get("posa_auto_stock_reconcile")) == 1

	pos_profile = getattr(invoice_doc, "pos_profile", None)
	if not pos_profile:
		return False

	if not frappe.get_meta("POS Profile").has_field("posa_auto_stock_reconcile"):
		return False

	return cint(frappe.db.get_value("POS Profile", pos_profile, "posa_auto_stock_reconcile")) == 1
