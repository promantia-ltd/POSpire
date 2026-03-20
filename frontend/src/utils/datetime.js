/**
 * Datetime utilities — drop-in replacements for frappe.datetime.* methods.
 * Uses native Date API; no moment.js dependency.
 */

const DATE_FMT = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_FMT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

function pad(n) {
	return String(n).padStart(2, "0");
}

function toYMD(d) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(value) {
	if (value instanceof Date) return new Date(value);
	if (typeof value === "string") {
		// Normalise " " → "T" for ISO parsing
		return new Date(value.replace(" ", "T"));
	}
	return new Date(value);
}

export const datetime = {
	/** Returns today's date as YYYY-MM-DD */
	now_date() {
		return toYMD(new Date());
	},

	/** Alias of now_date() */
	nowdate() {
		return toYMD(new Date());
	},

	/** Add (or subtract) days from a date string / Date object; returns YYYY-MM-DD */
	add_days(date, days) {
		const d = parseDate(date);
		d.setDate(d.getDate() + days);
		return toYMD(d);
	},

	/** Converts a Date object or date string to a datetime string (YYYY-MM-DD HH:MM:SS) */
	get_datetime_as_string(value) {
		if (!value) return "";
		if (typeof value === "string" && (DATE_FMT.test(value) || DATETIME_FMT.test(value))) {
			return value.replace("T", " ").slice(0, 19);
		}
		const d = parseDate(value);
		return `${toYMD(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	},

	/**
	 * Converts a Date object to a formatted string.
	 * Supported formats: "yyyy-mm-dd" (default), "dd-mm-yyyy"
	 */
	obj_to_str(dateObj, format = "yyyy-mm-dd") {
		if (!dateObj) return "";
		const d = parseDate(dateObj);
		const y = d.getFullYear();
		const m = pad(d.getMonth() + 1);
		const day = pad(d.getDate());
		if (format === "dd-mm-yyyy") return `${day}-${m}-${y}`;
		return `${y}-${m}-${day}`;
	},

	/** Converts a date string to a Date object */
	str_to_obj(dateStr) {
		if (!dateStr) return null;
		return parseDate(dateStr);
	},
};
