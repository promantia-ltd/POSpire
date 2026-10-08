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

/**
 * Every number_format option System Settings allows (see
 * system_settings.json's `number_format` Select field), mapped to its
 * decimal separator / group separator / group size — mirrors
 * frappe.utils.number_format.NUMBER_FORMAT_MAP and fmt_money's grouping
 * rule exactly (the Indian format groups by 2 after the first 3 digits;
 * every other format groups by 3 throughout).
 */
const NUMBER_FORMAT_MAP = {
	"#,###.##": { decimal: ".", group: ",", groupSize: 3 },
	"#.###,##": { decimal: ",", group: ".", groupSize: 3 },
	"# ###.##": { decimal: ".", group: " ", groupSize: 3 },
	"# ###,##": { decimal: ",", group: " ", groupSize: 3 },
	"#'###.##": { decimal: ".", group: "'", groupSize: 3 },
	"#, ###.##": { decimal: ".", group: ", ", groupSize: 3 },
	"#,##,###.##": { decimal: ".", group: ",", groupSize: 2 },
	"#,###.###": { decimal: ".", group: ",", groupSize: 3 },
	"#.###": { decimal: "", group: ".", groupSize: 3 },
	"#,###": { decimal: "", group: ",", groupSize: 3 },
	"#.########": { decimal: ".", group: "", groupSize: 3 },
};

/**
 * Format a number with thousands separators and decimal precision,
 * honoring a Frappe `number_format` string (e.g. "#,##,###.##" for
 * India, "#.###,##" for EU) when one is passed. Falls back to the
 * classic Western grouping ("#,###.##") for a missing or unrecognised
 * format — the behaviour every existing caller already gets, since
 * get_number_format() above always returns that string today.
 */
export function format_number(value, format, precision) {
	const num = parseFloat(value) || 0;
	const prec = precision !== undefined ? parseInt(precision) : 2;
	const rule = NUMBER_FORMAT_MAP[format] || NUMBER_FORMAT_MAP["#,###.##"];

	const negative = num < 0;
	const fixed = Math.abs(num).toFixed(prec);
	const [intPartRaw, decPart] = fixed.split(".");

	// Mirrors frappe.utils.fmt_money: the last 3 digits are always their
	// own group; every group after that uses the format's own group size
	// (2 for Indian, 3 for everything else).
	let intPart = intPartRaw;
	const groups = [];
	if (intPart.length > 3) {
		groups.push(intPart.slice(-3));
		intPart = intPart.slice(0, -3);
		while (intPart.length > rule.groupSize) {
			groups.push(intPart.slice(-rule.groupSize));
			intPart = intPart.slice(0, -rule.groupSize);
		}
	}
	groups.push(intPart);
	groups.reverse();

	const grouped = groups.join(rule.group);
	const withDecimal = decPart && rule.decimal ? `${grouped}${rule.decimal}${decPart}` : grouped;
	return negative && withDecimal !== "0" ? `-${withDecimal}` : withDecimal;
}
