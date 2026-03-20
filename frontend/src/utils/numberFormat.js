/**
 * Drop-in replacements for Frappe's browser globals:
 *   flt(), get_currency_symbol(), get_number_format(), format_number()
 *
 * Registered as window.* in main.js so they work anywhere bare (same as window.__).
 */

/** Parse value to float, apply optional precision. */
export function flt(value, precision, _number_format, _rounding_method) {
	if (value === "" || value === null || value === undefined) return 0;
	const num = parseFloat(value);
	if (isNaN(num)) return 0;
	if (precision !== undefined && precision !== null && precision !== false) {
		return parseFloat(num.toFixed(parseInt(precision)));
	}
	return num;
}

/** Return the currency symbol for an ISO 4217 currency code (e.g. "USD" → "$"). */
export function get_currency_symbol(currency) {
	if (!currency) return "";
	try {
		const parts = new Intl.NumberFormat("en", {
			style: "currency",
			currency,
			minimumFractionDigits: 0,
			maximumFractionDigits: 0,
		}).formatToParts(0);
		return parts.find((p) => p.type === "currency")?.value || currency;
	} catch {
		return currency;
	}
}

/**
 * Returns a format descriptor for use with format_number().
 * In Frappe this is a string like "#,###.##". We return the same
 * default format; per-currency overrides can be added later.
 */
export function get_number_format(_currency) {
	return "#,###.##";
}

/** Format a number with thousands separators and decimal precision. */
export function format_number(value, _format, precision) {
	const num = parseFloat(value) || 0;
	const prec = precision !== undefined ? parseInt(precision) : 2;
	const fixed = num.toFixed(prec);
	const [intPart, decPart] = fixed.split(".");
	const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return decPart ? `${withCommas}.${decPart}` : withCommas;
}
