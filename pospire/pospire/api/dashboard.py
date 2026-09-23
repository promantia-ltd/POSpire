import frappe
from frappe.utils import cint, flt, get_datetime, now_datetime


def _empty_cards():
	return {
		"total_net_sales": 0,
		"bill_count": 0,
		"loyalty_redemptions": 0,
		"total_returns": 0,
		"held_invoices": 0,
		"cancelled_invoices": 0,
	}


def _empty_card_comparisons():
	return {
		key: {
			"status": "no_previous",
			"percentage": None,
		}
		for key in _empty_cards()
	}


def _empty_hourly_sales():
	return {
		"labels": [],
		"values": [],
	}


def _empty_payment_distribution():
	return []


def _empty_top_products():
	return []


def _empty_top_categories():
	return []


def _empty_shift_summary():
	return {
		"opening_float": 0,
		"cash_sales": 0,
		"cash_in": 0,
		"cash_out": 0,
	}


def _get_current_open_shift():
	open_vouchers = frappe.db.get_all(
		"POS Opening Shift",
		filters={
			"user": frappe.session.user,
			"pos_closing_shift": ["is", "not set"],
			"docstatus": 1,
			"status": "Open",
		},
		fields=["name", "period_start_date", "pos_profile"],
		order_by="period_start_date desc",
		limit_page_length=1,
	)
	return open_vouchers[0] if open_vouchers else None


def _get_cash_mode(pos_profile):
	return frappe.get_cached_value("POS Profile", pos_profile, "posa_cash_mode_of_payment") or "Cash"


def _get_previous_closed_shift(pos_profile, current_period_start_date):
	closed_vouchers = frappe.db.get_all(
		"POS Opening Shift",
		filters={
			"pos_profile": pos_profile,
			"period_start_date": ["<", current_period_start_date],
			"docstatus": 1,
			"status": "Closed",
		},
		fields=["name"],
		order_by="period_start_date desc",
		limit_page_length=1,
	)
	return closed_vouchers[0] if closed_vouchers else None


def _get_opening_float(pos_opening_shift, cash_mode):
	return flt(
		frappe.db.get_value(
			"POS Opening Shift Detail",
			{
				"parent": pos_opening_shift,
				"parenttype": "POS Opening Shift",
				"parentfield": "balance_details",
				"mode_of_payment": cash_mode,
			},
			"amount",
		)
	)


def _get_cash_sales(pos_opening_shift, cash_mode):
	rows = frappe.db.sql(
		"""
		SELECT COALESCE(SUM(sip.amount - si.change_amount), 0) AS cash_sales
		FROM `tabSales Invoice Payment` sip
		JOIN `tabSales Invoice` si
			ON si.name = sip.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND si.posa_pos_opening_shift = %(shift)s
			AND sip.mode_of_payment = %(cash_mode)s
		""",
		{"shift": pos_opening_shift, "cash_mode": cash_mode},
		as_dict=True,
	)

	return flt(rows[0].cash_sales) if rows else 0


def _get_cash_movement(pos_opening_shift, cash_mode, payment_type):
	rows = frappe.db.sql(
		"""
		SELECT COALESCE(SUM(paid_amount), 0) AS amount
		FROM `tabPayment Entry`
		WHERE docstatus = 1
			AND payment_type = %(payment_type)s
			AND custom_pos_opening_shift = %(shift)s
			AND mode_of_payment = %(cash_mode)s
		""",
		{
			"payment_type": payment_type,
			"shift": pos_opening_shift,
			"cash_mode": cash_mode,
		},
		as_dict=True,
	)

	return flt(rows[0].amount) if rows else 0


def _get_shift_summary(opening_shift):
	pos_opening_shift = opening_shift["name"]
	cash_mode = _get_cash_mode(opening_shift["pos_profile"])

	return {
		"opening_float": _get_opening_float(pos_opening_shift, cash_mode),
		"cash_sales": _get_cash_sales(pos_opening_shift, cash_mode),
		"cash_in": _get_cash_movement(pos_opening_shift, cash_mode, "Receive"),
		"cash_out": _get_cash_movement(pos_opening_shift, cash_mode, "Pay"),
	}


def _get_shift_cards(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 0
				THEN net_total ELSE 0
			END), 0) AS total_net_sales,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 0
				THEN 1 ELSE 0
			END), 0) AS bill_count,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(redeem_loyalty_points, 0) = 1
				THEN loyalty_points ELSE 0
			END), 0) AS loyalty_redemptions,
			COALESCE(SUM(CASE
				WHEN docstatus = 1
					AND is_pos = 1
					AND IFNULL(is_return, 0) = 1
				THEN ABS(grand_total) ELSE 0
			END), 0) AS total_returns,
			COALESCE(SUM(CASE
				WHEN docstatus = 0
					AND IFNULL(posa_is_printed, 0) = 0
				THEN 1 ELSE 0
			END), 0) AS held_invoices
		FROM `tabSales Invoice`
		WHERE posa_pos_opening_shift = %(pos_opening_shift)s
		""",
		{"pos_opening_shift": pos_opening_shift},
		as_dict=True,
	)

	if not rows:
		return _empty_cards()

	row = rows[0]
	cancelled_invoices = frappe.db.get_value(
		"POS Opening Shift",
		pos_opening_shift,
		"custom_cancelled_count",
	)
	return {
		"total_net_sales": flt(row.total_net_sales),
		"bill_count": cint(row.bill_count),
		"loyalty_redemptions": flt(row.loyalty_redemptions),
		"total_returns": flt(row.total_returns),
		"held_invoices": cint(row.held_invoices),
		"cancelled_invoices": cint(cancelled_invoices),
	}


def _get_card_comparisons(current_cards, previous_cards=None):
	comparisons = _empty_card_comparisons()
	if not previous_cards:
		return comparisons

	for key, current_value in current_cards.items():
		previous_value = flt(previous_cards.get(key))
		current_value = flt(current_value)

		if previous_value == 0:
			comparisons[key] = {
				"status": "previous_zero",
				"percentage": None,
			}
			continue

		if current_value == previous_value:
			comparisons[key] = {
				"status": "same",
				"percentage": 0,
			}
			continue

		percentage = ((current_value - previous_value) / previous_value) * 100
		comparisons[key] = {
			"status": "up" if current_value > previous_value else "down",
			"percentage": flt(abs(percentage), 1),
		}

	return comparisons


def _get_hour_start(value):
	value = get_datetime(value)
	return value.replace(minute=0, second=0, microsecond=0)


def _get_hourly_sales(pos_opening_shift, period_start_date):
	hour_start = _get_hour_start(period_start_date)
	current_time = now_datetime()
	current_hour = _get_hour_start(current_time)
	labels = []
	bucket_keys = []
	values_by_bucket = {}

	while hour_start <= current_hour:
		bucket_key = hour_start.strftime("%Y-%m-%d %H:00:00")
		bucket_keys.append(bucket_key)
		labels.append(hour_start.strftime("%H:00"))
		values_by_bucket[bucket_key] = 0
		hour_start = frappe.utils.add_to_date(hour_start, hours=1)

	rows = frappe.db.sql(
		"""
		SELECT DATE_FORMAT(creation, '%%Y-%%m-%%d %%H:00:00') AS sales_hour,
			SUM(grand_total) AS total_sales
		FROM `tabSales Invoice`
		WHERE docstatus = %s
		  AND is_pos = %s
		  AND IFNULL(is_return, 0) = %s
		  AND posa_pos_opening_shift = %s
		  AND creation BETWEEN %s AND %s
		GROUP BY DATE_FORMAT(creation, '%%Y-%%m-%%d %%H:00:00')
		ORDER BY sales_hour
		""",
		(1, 1, 0, pos_opening_shift, period_start_date, current_time),
		as_dict=True,
	)

	for row in rows:
		if row.sales_hour in values_by_bucket:
			values_by_bucket[row.sales_hour] = flt(row.total_sales)

	return {
		"labels": labels,
		"values": [values_by_bucket[bucket_key] for bucket_key in bucket_keys],
	}


def _get_payment_distribution(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sip.mode_of_payment,
			COALESCE(SUM(sip.amount), 0) AS amount
		FROM `tabSales Invoice Payment` sip
		JOIN `tabSales Invoice` si
			ON si.name = sip.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY sip.mode_of_payment
		ORDER BY amount DESC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"mode_of_payment": row.mode_of_payment,
			"amount": flt(row.amount),
		}
		for row in rows
	]


def _get_top_products(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sii.item_code,
			sii.item_name,
			COALESCE(SUM(sii.qty), 0) AS total_qty,
			COALESCE(SUM(sii.base_net_amount), 0) AS total_sales
		FROM `tabSales Invoice Item` sii
		JOIN `tabSales Invoice` si
			ON si.name = sii.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND IFNULL(si.is_return, 0) = 0
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY
			sii.item_code,
			sii.item_name
		ORDER BY
			total_qty DESC,
			total_sales DESC,
			sii.item_name ASC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"item_code": row.item_code,
			"item_name": row.item_name,
			"total_qty": flt(row.total_qty),
			"total_sales": flt(row.total_sales),
		}
		for row in rows
	]


def _get_top_categories(pos_opening_shift):
	rows = frappe.db.sql(
		"""
		SELECT
			sii.item_group,
			COALESCE(SUM(sii.qty), 0) AS total_qty,
			COALESCE(SUM(sii.base_net_amount), 0) AS total_sales
		FROM `tabSales Invoice Item` sii
		JOIN `tabSales Invoice` si
			ON si.name = sii.parent
		WHERE si.docstatus = 1
			AND si.is_pos = 1
			AND IFNULL(si.is_return, 0) = 0
			AND si.posa_pos_opening_shift = %(shift)s
		GROUP BY
			sii.item_group
		ORDER BY
			total_sales DESC,
			total_qty DESC,
			sii.item_group ASC
		""",
		{"shift": pos_opening_shift},
		as_dict=True,
	)

	return [
		{
			"item_group": row.item_group,
			"total_qty": flt(row.total_qty),
			"total_sales": flt(row.total_sales),
		}
		for row in rows
	]


@frappe.whitelist()
def get_shift_dashboard():
	cards = _empty_cards()
	card_comparisons = _empty_card_comparisons()
	hourly_sales = _empty_hourly_sales()
	payment_distribution = _empty_payment_distribution()
	top_products = _empty_top_products()
	top_categories = _empty_top_categories()
	shift_summary = _empty_shift_summary()
	opening_shift = _get_current_open_shift()
	if not opening_shift:
		return {
			"cards": cards,
			"card_comparisons": card_comparisons,
			"hourly_sales": hourly_sales,
			"payment_distribution": payment_distribution,
			"top_products": top_products,
			"top_categories": top_categories,
			"shift_summary": shift_summary,
		}

	pos_opening_shift = opening_shift["name"]
	cards = _get_shift_cards(pos_opening_shift)
	previous_shift = _get_previous_closed_shift(
		opening_shift["pos_profile"],
		opening_shift["period_start_date"],
	)
	if previous_shift:
		previous_cards = _get_shift_cards(previous_shift["name"])
		card_comparisons = _get_card_comparisons(cards, previous_cards)

	hourly_sales = _get_hourly_sales(pos_opening_shift, opening_shift["period_start_date"])
	payment_distribution = _get_payment_distribution(pos_opening_shift)
	top_products = _get_top_products(pos_opening_shift)
	top_categories = _get_top_categories(pos_opening_shift)
	shift_summary = _get_shift_summary(opening_shift)

	return {
		"cards": cards,
		"card_comparisons": card_comparisons,
		"hourly_sales": hourly_sales,
		"payment_distribution": payment_distribution,
		"top_products": top_products,
		"top_categories": top_categories,
		"shift_summary": shift_summary,
	}


# Default layout carries only structure (which widgets, order, span, variant).
# Presentation - titles and icons - is supplied and translated by the frontend
# catalog, so these entries intentionally leave title/icon as None.
def _number_card(data_key):
	return {
		"widget_type": "Number Card",
		"data_key": data_key,
		"variant": None,
		"title": None,
		"icon": None,
		"column_span": 4,
	}


def _widget(widget_type, data_key, variant=None):
	return {
		"widget_type": widget_type,
		"data_key": data_key,
		"variant": variant,
		"title": None,
		"icon": None,
		"column_span": 6,
	}


DEFAULT_DASHBOARD_LAYOUT = [
	_number_card("total_net_sales"),
	_number_card("bill_count"),
	_number_card("loyalty_redemptions"),
	_number_card("total_returns"),
	_number_card("held_invoices"),
	_number_card("cancelled_invoices"),
	_widget("Chart", "hourly_sales", "line"),
	_widget("Chart", "payment_distribution", "donut"),
	_widget("Table", "top_products"),
	_widget("Table", "top_categories"),
	_widget("Table", "shift_summary"),
]

_WIDGET_TYPE_MAP = {
	"Number Card": "number-card",
	"Chart": "chart",
	"Table": "table",
}


@frappe.whitelist()
def get_dashboard_layout():
	settings = frappe.get_single("POS Dashboard Settings")
	rows = settings.get("widgets") or []
	layout = []
	for row in rows:
		if not row.enabled:
			continue
		layout.append(
			{
				"widget_type": _WIDGET_TYPE_MAP.get(row.widget_type, "number-card"),
				"data_key": row.data_key,
				"variant": row.variant or None,
				"title": row.title or None,
				"icon": row.icon or None,
				"column_span": row.column_span or None,
			}
		)

	if not layout:
		return _default_layout_kebab()

	return layout


def _default_layout_kebab():
	return [
		{**widget, "widget_type": _WIDGET_TYPE_MAP[widget["widget_type"]]}
		for widget in DEFAULT_DASHBOARD_LAYOUT
	]


@frappe.whitelist()
def get_default_dashboard_layout_for_settings():
	if not frappe.has_permission("POS Dashboard Settings", "write"):
		frappe.throw(
			frappe._("Not permitted to update POS Dashboard Settings."),
			frappe.PermissionError,
		)

	return [
		{
			"widget_type": widget["widget_type"],
			"data_key": widget["data_key"],
			"variant": widget.get("variant"),
			"enabled": 1,
			"title": widget.get("title"),
			"icon": widget.get("icon"),
			"column_span": widget.get("column_span"),
		}
		for widget in DEFAULT_DASHBOARD_LAYOUT
	]
