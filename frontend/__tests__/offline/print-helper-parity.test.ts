/**
 * Helper parity between the offline (nunjucks, xml.ts) and online (Jinja,
 * hardware_manager.py::get_enhanced_context) receipt template engines.
 *
 * A receipt template is written once and must render identically whether
 * it runs on the server (online) or in the browser (offline) — that's the
 * whole point of the template-first design. These fixtures are the known
 * outputs of the PYTHON helpers for the same inputs (traced from
 * pospire/pospire/api/hardware_manager.py::get_enhanced_context and
 * frappe.utils.fmt_money / number_format.NUMBER_FORMAT_MAP); the offline
 * helpers in xml.ts must match them byte-for-byte. A prior version of this
 * file diverged on pad_right, round(x, n), and every non-default
 * number/date/time format — see the PR review that caught it.
 */
import { describe, it, expect } from "vitest";
import { renderReceiptXml } from "@/offline/print/xml";

const EMPTY_DOC = {};

describe("offline/online receipt helper parity", () => {
	it("pad_right keeps the FIRST w characters (Python: str(s).rjust(w)[:w])", () => {
		// str("1,234,567.00").rjust(8)[:8] == "1,234,56" — the string is
		// already longer than 8, so rjust is a no-op and [:8] truncates from
		// the front. A .slice(-w) implementation truncates from the back
		// instead and returns "4,567.00".
		expect(renderReceiptXml("{{ pad_right('1,234,567.00', 8) }}", EMPTY_DOC, {})).toBe(
			"1,234,56",
		);
		// Shorter than w: rjust pads on the left with spaces, [:w] is then a
		// no-op — both implementations agree here, kept as a control case.
		expect(renderReceiptXml("{{ pad_right('ab', 5) }}", EMPTY_DOC, {})).toBe("   ab");
	});

	it("pad_left keeps parity too (Python: str(s).ljust(w)[:w])", () => {
		expect(renderReceiptXml("{{ pad_left('ab', 5) }}", EMPTY_DOC, {})).toBe("ab   ");
		expect(renderReceiptXml("{{ pad_left('1234567890', 5) }}", EMPTY_DOC, {})).toBe("12345");
	});

	it("round(x, n) honours precision, matching Python's round(x, n)", () => {
		// The old implementation ignored n entirely (Math.round(x)), so
		// round(123.456, 2) printed "123" offline vs "123.46" online.
		expect(renderReceiptXml("{{ round(123.456, 2) }}", EMPTY_DOC, {})).toBe("123.46");
		expect(renderReceiptXml("{{ round(123.456, 0) }}", EMPTY_DOC, {})).toBe("123");
		expect(renderReceiptXml("{{ round(2.5) }}", EMPTY_DOC, {})).toBe("3");
	});

	it("format_money/format_currency honour the site's number_format, not a hardcoded Western default", () => {
		// Indian grouping: #,##,###.## groups the last 3 digits, then by 2 —
		// frappe.utils.fmt_money's exact rule (number_format.py, fmt_money).
		expect(
			renderReceiptXml("{{ format_money(1234567.89) }}", EMPTY_DOC, {
				number_format: "#,##,###.##",
				currency_precision: 2,
				currency_symbol: "₹",
			}),
		).toBe("₹ 12,34,567.89");

		// EU: '.' as the group separator, ',' as the decimal separator.
		expect(
			renderReceiptXml("{{ format_currency(1234567.89) }}", EMPTY_DOC, {
				number_format: "#.###,##",
				currency_precision: 2,
			}),
		).toBe("1.234.567,89");

		// Missing/unrecognised number_format falls back to the Western
		// default — matches every existing on-screen amount in the POS UI,
		// which has always used "#,###.##" (see numberFormat.js).
		expect(
			renderReceiptXml("{{ format_money(1234.5) }}", EMPTY_DOC, {
				currency_precision: 2,
				currency_symbol: "$",
			}),
		).toBe("$ 1,234.50");

		// Negative amount (a return/refund line) — the sign sits inside the
		// number, after the currency symbol, matching frappe.utils.fmt_money
		// exactly (symbol + " " + minus + digits, not minus + symbol).
		expect(
			renderReceiptXml("{{ format_money(-1234.5) }}", EMPTY_DOC, {
				currency_precision: 2,
				currency_symbol: "$",
			}),
		).toBe("$ -1,234.50");
	});

	it("format_date honours the site's date_format instead of returning the raw value", () => {
		expect(
			renderReceiptXml("{{ format_date('2026-09-25') }}", EMPTY_DOC, {
				date_format: "dd-mm-yyyy",
			}),
		).toBe("25-09-2026");
		expect(
			renderReceiptXml("{{ format_date('2026-09-25') }}", EMPTY_DOC, {
				date_format: "mm/dd/yyyy",
			}),
		).toBe("09/25/2026");
		// No date_format cached (e.g. an old print_config snapshot) falls
		// back to ISO, matching System Settings' own default.
		expect(renderReceiptXml("{{ format_date('2026-09-25') }}", EMPTY_DOC, {})).toBe(
			"2026-09-25",
		);
	});

	it("format_time honours the site's time_format instead of returning the raw value", () => {
		expect(
			renderReceiptXml("{{ format_time('2026-09-25 14:05:09') }}", EMPTY_DOC, {
				time_format: "HH:mm",
			}),
		).toBe("14:05");
		expect(
			renderReceiptXml("{{ format_time('2026-09-25 14:05:09') }}", EMPTY_DOC, {
				time_format: "HH:mm:ss",
			}),
		).toBe("14:05:09");
	});

	it("format_time honours time_format for a TIME-ONLY value (buildPrintContext's posting_time)", () => {
		// buildPrintContext sets posting_time to a bare "HH:mm:ss" string with
		// no date attached. new Date("11:42:05") is an Invalid Date, so a
		// version of format_time that always routes through Date silently
		// fell back to the raw string here — this is the actual shape
		// format_time receives for every receipt, not the datetime string
		// covered above.
		expect(
			renderReceiptXml("{{ format_time('11:42:05') }}", EMPTY_DOC, { time_format: "HH:mm" }),
		).toBe("11:42");
		expect(
			renderReceiptXml("{{ format_time('11:42:05') }}", EMPTY_DOC, {
				time_format: "HH:mm:ss",
			}),
		).toBe("11:42:05");
		expect(renderReceiptXml("{{ format_time('9:05') }}", EMPTY_DOC, {})).toBe("09:05:00");
	});
});
