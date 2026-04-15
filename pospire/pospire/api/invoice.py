# Copyright (c) 2021, Youssef Restom and contributors
# For license information, please see license.txt


import frappe
from frappe import _
from frappe.model.mapper import get_mapped_doc
from frappe.utils import add_days, flt

from pospire.pospire.api.posapp import get_company_domain
from pospire.pospire.doctype.delivery_charges.delivery_charges import (
	get_applicable_delivery_charges,
)
from pospire.pospire.doctype.pos_coupon.pos_coupon import update_coupon_code_count


def validate(doc, method):
	validate_shift(doc)
	set_patient(doc)
	auto_set_delivery_charges(doc)
	calc_delivery_charges(doc)


def before_submit(doc, method):
	validate_approval_requests(doc)
	add_loyalty_point(doc)
	create_sales_order(doc)
	update_coupon(doc, "used")


def before_cancel(doc, method):
	update_coupon(doc, "cancelled")


def add_loyalty_point(invoice_doc):
	for offer in invoice_doc.posa_offers:
		if offer.offer == "Loyalty Point":
			original_offer = frappe.get_doc("POS Offer", offer.offer_name)
			if original_offer.loyalty_points > 0:
				loyalty_program = frappe.get_value("Customer", invoice_doc.customer, "loyalty_program")
				if not loyalty_program:
					loyalty_program = original_offer.loyalty_program
				doc = frappe.get_doc(
					{
						"doctype": "Loyalty Point Entry",
						"loyalty_program": loyalty_program,
						"loyalty_program_tier": original_offer.name,
						"customer": invoice_doc.customer,
						"invoice_type": "Sales Invoice",
						"invoice": invoice_doc.name,
						"loyalty_points": original_offer.loyalty_points,
						"expiry_date": add_days(invoice_doc.posting_date, 10000),
						"posting_date": invoice_doc.posting_date,
						"company": invoice_doc.company,
					}
				)
				doc.insert(ignore_permissions=True)


def create_sales_order(doc):
	if (
		doc.posa_pos_opening_shift
		and doc.pos_profile
		and doc.is_pos
		and doc.posa_delivery_date
		and not doc.update_stock
		and frappe.get_value("POS Profile", doc.pos_profile, "posa_allow_sales_order")
	):
		sales_order_doc = make_sales_order(doc.name)
		if sales_order_doc:
			sales_order_doc.posa_notes = doc.posa_notes
			sales_order_doc.flags.ignore_permissions = True
			sales_order_doc.flags.ignore_account_permission = True
			sales_order_doc.save()
			sales_order_doc.submit()
			url = frappe.utils.get_url_to_form(sales_order_doc.doctype, sales_order_doc.name)
			msgprint = f"Sales Order Created at <a href='{url}'>{sales_order_doc.name}</a>"
			frappe.msgprint(_(msgprint), title="Sales Order Created", indicator="green", alert=True)
			i = 0
			for item in sales_order_doc.items:
				doc.items[i].sales_order = sales_order_doc.name
				doc.items[i].so_detail = item.name
				i += 1


def make_sales_order(source_name, target_doc=None, ignore_permissions=True):
	def set_missing_values(source, target):
		target.ignore_pricing_rule = 1
		target.flags.ignore_permissions = ignore_permissions
		target.run_method("set_missing_values")
		target.run_method("calculate_taxes_and_totals")

	def update_item(obj, target, source_parent):
		target.stock_qty = flt(obj.qty) * flt(obj.conversion_factor)
		target.delivery_date = obj.posa_delivery_date or source_parent.posa_delivery_date

	doclist = get_mapped_doc(
		"Sales Invoice",
		source_name,
		{
			"Sales Invoice": {
				"doctype": "Sales Order",
			},
			"Sales Invoice Item": {
				"doctype": "Sales Order Item",
				"field_map": {
					"cost_center": "cost_center",
					"Warehouse": "warehouse",
					"delivery_date": "posa_delivery_date",
					"posa_notes": "posa_notes",
				},
				"postprocess": update_item,
			},
			"Sales Taxes and Charges": {
				"doctype": "Sales Taxes and Charges",
				"add_if_empty": True,
			},
			"Sales Team": {"doctype": "Sales Team", "add_if_empty": True},
			"Payment Schedule": {"doctype": "Payment Schedule", "add_if_empty": True},
		},
		target_doc,
		set_missing_values,
		ignore_permissions=ignore_permissions,
	)

	return doclist


def update_coupon(doc, transaction_type):
	for coupon in doc.posa_coupons:
		if not coupon.applied:
			continue
		update_coupon_code_count(coupon.coupon, transaction_type)


def set_patient(doc):
	domain = get_company_domain(doc.company)
	if domain != "Healthcare":
		return
	patient_list = frappe.get_all("Patient", filters={"customer": doc.customer}, page_length=1)
	if len(patient_list) > 0:
		doc.patient = patient_list[0].name


def auto_set_delivery_charges(doc):
	if not doc.pos_profile:
		return
	if doc.is_return and doc.return_against:
		return
	if not frappe.get_cached_value("POS Profile", doc.pos_profile, "posa_auto_set_delivery_charges"):
		return

	delivery_charges = get_applicable_delivery_charges(
		doc.company,
		doc.pos_profile,
		doc.customer,
		doc.shipping_address_name,
		doc.posa_delivery_charges,
		restrict=True,
	)

	if doc.posa_delivery_charges:
		if doc.posa_delivery_charges_rate:
			return
		else:
			if len(delivery_charges) > 0:
				doc.posa_delivery_charges_rate = delivery_charges[0].rate
	else:
		if len(delivery_charges) > 0:
			doc.posa_delivery_charges = delivery_charges[0].name
			doc.posa_delivery_charges_rate = delivery_charges[0].rate
		else:
			doc.posa_delivery_charges = None
			doc.posa_delivery_charges_rate = None


def calc_delivery_charges(doc):
	if not doc.pos_profile:
		return

	old_doc = None
	calculate_taxes_and_totals = False
	if not doc.is_new():
		old_doc = doc.get_doc_before_save()
		if not doc.posa_delivery_charges and not old_doc.posa_delivery_charges:
			return
	else:
		if not doc.posa_delivery_charges:
			return
	if not doc.posa_delivery_charges:
		doc.posa_delivery_charges_rate = 0

	charges_doc = None
	if doc.posa_delivery_charges:
		charges_doc = frappe.get_cached_doc("Delivery Charges", doc.posa_delivery_charges)
		doc.posa_delivery_charges_rate = charges_doc.default_rate
		charges_profile = next((i for i in charges_doc.profiles if i.pos_profile == doc.pos_profile), None)
		if charges_profile:
			doc.posa_delivery_charges_rate = charges_profile.rate

	if old_doc and old_doc.posa_delivery_charges:
		old_charges = next(
			(
				i
				for i in doc.taxes
				if i.charge_type == "Actual" and i.description == old_doc.posa_delivery_charges
			),
			None,
		)
		if old_charges:
			doc.taxes.remove(old_charges)
			calculate_taxes_and_totals = True

	if doc.posa_delivery_charges:
		doc.append(
			"taxes",
			{
				"charge_type": "Actual",
				"description": doc.posa_delivery_charges,
				"tax_amount": doc.posa_delivery_charges_rate,
				"cost_center": charges_doc.cost_center,
				"account_head": charges_doc.shipping_account,
			},
		)
		calculate_taxes_and_totals = True

	if calculate_taxes_and_totals:
		doc.calculate_taxes_and_totals()


def validate_approval_requests(doc) -> None:
	"""Enforce server-side that all required approvals exist before submit.

	This is the security boundary — the frontend dialog is UX only.
	Even if the frontend is bypassed, this blocks unauthorised submissions.
	"""
	if not doc.pos_profile:
		return

	if not frappe.db.get_value("POS Profile", doc.pos_profile, "posa_enable_approval_workflow"):
		return

	required_checks = _get_required_approval_checks(doc)
	submit_data = frappe.parse_json(getattr(doc, "posa_submit_data", None) or "{}")
	approved_requests = [
		request_name for request_name in submit_data.get("approved_requests", []) if request_name
	]

	if not required_checks:
		return

	if not approved_requests:
		frappe.throw(_("This invoice contains changes that require manager approval before submission."))

	requests = [_get_submitted_approval_request(request_name, doc) for request_name in approved_requests]
	remaining_requests = requests.copy()

	for check in required_checks:
		match_index = _find_matching_approved_request(remaining_requests, check)
		if match_index is None:
			if check.get("label"):
				frappe.throw(
					_("{0} requires manager approval for {1}. Please re-approve before submitting.").format(
						check["action_type"], check["label"]
					)
				)
			frappe.throw(
				_("{0} requires manager approval before submitting this invoice.").format(
					check["action_type"]
				)
			)

		remaining_requests.pop(match_index)


def _get_required_approval_checks(doc) -> list[dict]:
	"""Infer which protected actions are reflected in the current invoice state."""
	doc_context = frappe._dict(doc.as_dict())
	checks: list[dict] = []

	# Build posa_row_id → action_type lookup from frontend context so we can
	# disambiguate "discount amount typed" vs "rate edited directly" — both produce
	# discount_percentage=0 with rate != price_list_rate on the saved item row.
	submit_data = frappe.parse_json(getattr(doc, "posa_submit_data", None) or "{}")
	row_action_map: dict[str, str] = {
		entry["posa_row_id"]: entry["action_type"]
		for entry in (submit_data.get("approved_requests_context") or [])
		if entry.get("posa_row_id") and entry.get("action_type")
	}

	if doc.is_return and _approval_required(doc, "Sales Return", {}, doc_context):
		checks.append({"action_type": "Sales Return", "label": doc.name or _("this return")})

	deleted_items = frappe.parse_json(getattr(doc, "custom_deleted_pos_items", None) or "[]") or []
	for item in deleted_items:
		action_context = {
			"item_code": item.get("item_code"),
			"item_name": item.get("item_name"),
			"original_value": flt(item.get("qty")),
			"requested_value": 0,
			"value_field_label": "Qty",
		}
		if _approval_required(doc, "Delete Item", action_context, doc_context):
			checks.append(
				{
					"action_type": "Delete Item",
					"item_code": item.get("item_code"),
					"label": item.get("item_name") or item.get("item_code") or _("a deleted item"),
				}
			)

	additional_discount_context = {
		"requested_value": flt(doc.additional_discount_percentage or doc.discount_amount or 0),
		"discount_percentage": flt(doc.additional_discount_percentage or 0),
		"discount_amount": flt(doc.discount_amount or 0),
		"value_field_label": "Additional Discount",
	}
	if _has_additional_discount(doc) and _approval_required(
		doc, "Edit Additional Discount", additional_discount_context, doc_context
	):
		checks.append({"action_type": "Edit Additional Discount", "label": _("additional discount")})

	for item in doc.items or []:
		item_dict = item.as_dict() if hasattr(item, "as_dict") else dict(item)
		item_label = item_dict.get("item_name") or item_dict.get("item_code") or _("an item")
		posa_row_id = item_dict.get("posa_row_id") or ""

		discount_pct = flt(item_dict.get("discount_percentage") or 0)
		discount_amt = flt(item_dict.get("discount_amount") or 0)
		price_list_rate = flt(item_dict.get("price_list_rate") or 0)
		rate = flt(item_dict.get("rate") or 0)
		price_changed = abs(rate - price_list_rate) > 1e-9

		if abs(discount_pct) > 0:
			# Explicit percentage discount — unambiguously "Edit Item Discount"
			action_context = {
				"item_code": item_dict.get("item_code"),
				"item_name": item_dict.get("item_name"),
				"requested_value": flt(discount_pct or discount_amt or 0),
				"discount_percentage": discount_pct,
				"discount_amount": discount_amt,
				"value_field_label": "Discount",
			}
			if _approval_required(doc, "Edit Item Discount", action_context, doc_context):
				checks.append(
					{
						"action_type": "Edit Item Discount",
						"item_code": item_dict.get("item_code"),
						"label": item_label,
					}
				)
		elif price_changed:
			# discount_percentage == 0 but rate differs from price_list_rate.
			# When rate > price_list_rate the cashier raised the price — a discount amount
			# field can never cause this, so it is unambiguously a direct rate edit.
			# When rate < price_list_rate both "discount amount typed" and "rate lowered"
			# produce identical DB state; use the frontend context to disambiguate.
			if rate > price_list_rate:
				action_type = "Edit Rate"
			else:
				action_type = row_action_map.get(posa_row_id, "Edit Rate")

			if action_type == "Edit Item Discount":
				action_context = {
					"item_code": item_dict.get("item_code"),
					"item_name": item_dict.get("item_name"),
					"requested_value": flt(discount_amt or 0),
					"discount_percentage": 0,
					"discount_amount": discount_amt,
					"value_field_label": "Discount Amount",
				}
				if _approval_required(doc, "Edit Item Discount", action_context, doc_context):
					checks.append(
						{
							"action_type": "Edit Item Discount",
							"item_code": item_dict.get("item_code"),
							"label": item_label,
						}
					)
			else:
				change_percent = (
					abs(((rate - price_list_rate) / price_list_rate) * 100) if price_list_rate else 0
				)
				action_context = {
					"item_code": item_dict.get("item_code"),
					"item_name": item_dict.get("item_name"),
					"original_value": price_list_rate,
					"requested_value": rate,
					"change_percent": change_percent,
					"value_field_label": "Rate",
				}
				if _approval_required(doc, "Edit Rate", action_context, doc_context):
					checks.append(
						{
							"action_type": "Edit Rate",
							"item_code": item_dict.get("item_code"),
							"label": item_label,
						}
					)

	return checks


def _approval_required(doc, action_type: str, action_context: dict, doc_context=None) -> bool:
	from pospire.pospire.api.approval import _get_action_config, _get_approval_safe_globals

	action_config = _get_action_config(doc.pos_profile, action_type)
	if not action_config:
		return False

	mode = action_config.get("approval_mode", "Not Required")
	if mode == "Not Required":
		return False
	if mode == "Blocked":
		return True

	condition = action_config.get("condition")
	if not condition:
		return True

	context = _get_approval_safe_globals()
	context.update(
		{
			"doc": frappe._dict(doc_context or frappe._dict(doc.as_dict())),
			"action": frappe._dict(action_context or {}),
		}
	)

	try:
		return bool(frappe.safe_eval(condition, eval_globals=context))
	except Exception:
		frappe.log_error(
			frappe.get_traceback(), f"POS Approval: submit-time condition eval error ({action_type})"
		)
		return True


def _get_submitted_approval_request(request_name: str, doc):
	if str(request_name).startswith("OFFLINE-AR-"):
		request = frappe.db.get_value(
			"POS Approval Request",
			{"offline_id": request_name},
			["name", "status", "pos_profile", "action_type", "item_code", "requested_by", "invoice"],
			as_dict=True,
		)
	else:
		request = frappe.db.get_value(
			"POS Approval Request",
			request_name,
			["name", "status", "pos_profile", "action_type", "item_code", "requested_by", "invoice"],
			as_dict=True,
		)

	if not request:
		frappe.throw(_("Approval request {0} not found. Please re-approve the action.").format(request_name))

	if request.status != "Approved":
		frappe.throw(
			_("Approval request {0} has status '{1}'. Only Approved requests are valid.").format(
				request_name, request.status
			)
		)

	if request.pos_profile != doc.pos_profile:
		frappe.throw(_("Approval request {0} belongs to a different POS Profile.").format(request_name))

	if request.requested_by and request.requested_by != frappe.session.user:
		frappe.throw(_("Approval request {0} belongs to a different cashier.").format(request_name))

	if request.invoice and doc.name and request.invoice != doc.name:
		frappe.throw(_("Approval request {0} belongs to a different invoice.").format(request_name))

	return request


def _find_matching_approved_request(requests: list, check: dict) -> int | None:
	for index, request in enumerate(requests):
		if request.action_type != check["action_type"]:
			continue
		if check.get("item_code") and request.item_code != check["item_code"]:
			continue
		return index

	return None


def _has_additional_discount(doc) -> bool:
	return abs(flt(doc.discount_amount or 0)) > 0 or abs(flt(doc.additional_discount_percentage or 0)) > 0


def validate_shift(doc):
	if doc.posa_pos_opening_shift and doc.pos_profile and doc.is_pos:
		# check if shift is open
		shift = frappe.get_cached_doc("POS Opening Shift", doc.posa_pos_opening_shift)
		if shift.status != "Open":
			frappe.throw(_("POS Shift {0} is not open").format(shift.name))
		# check if shift is for the same profile
		if shift.pos_profile != doc.pos_profile:
			frappe.throw(_("POS Opening Shift {0} is not for the same POS Profile").format(shift.name))
		# check if shift is for the same company
		if shift.company != doc.company:
			frappe.throw(_("POS Opening Shift {0} is not for the same company").format(shift.name))
