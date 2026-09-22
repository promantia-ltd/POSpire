/**
 * renderReceiptXml() — the browser-side counterpart to
 * pospire.pospire.api.hardware_manager.render_receipt_template (server).
 * Same template, same helper set, same `doc` shape (see context.ts) —
 * rendered with nunjucks (a Jinja-compatible engine) instead of Python
 * Jinja, since there's no server to render it on when offline.
 *
 * autoescape is ON, matching the server's SandboxedEnvironment(autoescape=True)
 * (hardware_manager.py S4) — "A & B" in a company or item name must produce
 * valid XML on both sides, not just online.
 *
 * Helper parity: every function here must return the same output as its
 * Python counterpart in hardware_manager.py::get_enhanced_context for the
 * same input — see the "Helper parity" automated test in the receipt
 * printing plan. Template authors are expected to use helpers only (cut(),
 * never doc.name[:28] — see check_offline_compatibility server-side, which
 * warns on exactly that), so this file does not need a Python-slice
 * preprocessor the way an earlier draft of this feature did.
 */
import nunjucks from "nunjucks";
import { flt } from "@/utils/numberFormat";

function cut(text, n) {
	return String(text ?? "").slice(0, Number(n));
}

function addressLines(html) {
	if (!html) return [];
	const text = String(html)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function padLeft(s, w) {
	// Mirrors the server's get_enhanced_context exactly: pad_left is
	// Python .ljust() — left-align, pad with spaces on the right.
	return String(s ?? "")
		.padEnd(w)
		.slice(0, w);
}
function padRight(s, w) {
	// pad_right is Python .rjust() — right-align, pad on the left.
	return String(s ?? "")
		.padStart(w)
		.slice(-w);
}
function padCenter(s, w) {
	const str = String(s ?? "");
	if (str.length >= w) return str.slice(0, w);
	const total = w - str.length;
	const left = Math.floor(total / 2);
	return " ".repeat(left) + str + " ".repeat(total - left);
}
function truncateHelper(s, w) {
	const str = String(s ?? "");
	return (str.length > w ? str.slice(0, w) + "..." : str.padEnd(w)).slice(0, w);
}

function formatNumber(value, precision) {
	const num = Number(value) || 0;
	const fixed = num.toFixed(precision);
	const [intPart, decPart] = fixed.split(".");
	const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return decPart ? `${withCommas}.${decPart}` : withCommas;
}

function buildEnvironment(settings) {
	const env = new nunjucks.Environment(null, { autoescape: true, throwOnUndefined: false });
	const precision = settings?.currency_precision ?? 2;
	const symbol = settings?.currency_symbol || "";

	const globals = {
		truncate: truncateHelper,
		pad_left: padLeft,
		pad_right: padRight,
		pad_center: padCenter,
		cut,
		address_lines: addressLines,
		separator: (char = "-", width = 42) => String(char).repeat(width),
		blank_line: () => "",
		// Offline uses the settings cached from get_offline_print_config
		// (S2) — the SAME site number-format/currency the online path
		// would use — rather than a browser default, so a receipt printed
		// offline is formatted identically to one printed online.
		format_money: (x) => (symbol ? symbol + " " : "") + formatNumber(x, precision),
		format_qty: (x) => flt(x, 2).toFixed(2),
		upper: (s) => String(s ?? "").toUpperCase(),
		lower: (s) => String(s ?? "").toLowerCase(),
		title: (s) =>
			String(s ?? "")
				.toLowerCase()
				.replace(/(^|\s)\S/g, (c) => c.toUpperCase()),
		format_datetime: (dt) => (dt ? String(dt) : ""),
		format_date: (d) => (d ? String(d) : ""),
		format_time: (t) => (t ? String(t) : ""),
		abs: (x) => Math.abs(Number(x) || 0),
		round: (x) => Math.round(Number(x) || 0),
		int: (x) => parseInt(x, 10) || 0,
		float: (x) => flt(x),
		format_currency: (x) => formatNumber(x, precision),
		_: (s) => s, // no offline translation catalogue
	};
	for (const [name, fn] of Object.entries(globals)) {
		env.addGlobal(name, fn);
	}
	return env;
}

/**
 * Render a POS receipt XML template against a print-context `doc` (see
 * context.ts) and the settings cached from get_offline_print_config.
 * Throws on a template construct nunjucks can't parse — callers must
 * surface that as an error to the cashier (see §6 of the plan: no silent
 * fallback to a different receipt).
 */
export function renderReceiptXml(template, doc, settings) {
	const env = buildEnvironment(settings);
	return env.renderString(template, { doc });
}
