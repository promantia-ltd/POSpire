/**
 * @vitest-environment jsdom
 *
 * xmlToReceiptHtml() (html.ts) — the browser-receipt renderer, ported from
 * the POS XML Print Designer's admin preview (render_receipt_xml_to_html).
 * That Python preview deliberately truncates cell content and prints a
 * "[Barcode: ...]" placeholder — both are fine for an admin checking column
 * alignment, but wrong on a receipt actually handed to a customer. See the
 * PR review that caught this: an amount longer than its declared column
 * width was having its last digit replaced with an ellipsis.
 *
 * Runs under jsdom, not this suite's default happy-dom: happy-dom's
 * DOMParser doesn't preserve tag-name case for custom XML elements
 * (<line>/<text>/<barcode> come back as 'LINE'/'TEXT'/'BARCODE'), so every
 * assertion here would silently see an empty receipt, not a real failure
 * of the code under test. jsdom parses XML mode correctly, matching a real
 * browser's DOMParser (which is what xmlToReceiptHtml actually runs under).
 */
import { describe, it, expect } from "vitest";
import { xmlToReceiptHtml } from "@/offline/print/html";

function ticketXml(inner: string): string {
	return `<output><ticket>${inner}</ticket></output>`;
}

describe("xmlToReceiptHtml — no data loss on a real receipt", () => {
	it("never truncates an amount longer than its declared column width", () => {
		// A 14-char column ("totals column") holding a value that actually
		// needs more room — the exact scenario from the review.
		const xml = ticketXml(
			'<line><text length="14" align="right">₹ 12,34,567.00</text></line>',
		);
		const html = xmlToReceiptHtml(xml);
		expect(html).toContain("₹ 12,34,567.00");
		expect(html).not.toContain("…");
	});

	it("does not truncate even when the line's total declared width is already at 42", () => {
		const label = "GRAND TOTAL".padEnd(28);
		const xml = ticketXml(
			`<line><text length="28">${label}</text><text length="14" align="right">₹ 1,23,456.78</text></line>`,
		);
		const html = xmlToReceiptHtml(xml);
		expect(html).toContain("₹ 1,23,456.78");
		expect(html).not.toContain("…");
	});

	it("prints the barcode value as plain text, not a '[Barcode: ...]' placeholder", () => {
		const xml = ticketXml("<barcode>SINV-26-00432</barcode>");
		const html = xmlToReceiptHtml(xml);
		expect(html).toContain("SINV-26-00432");
		expect(html).not.toContain("[Barcode:");
	});

	it("still escapes text content (XSS / malformed-XML safety, unchanged by the fix)", () => {
		const xml = ticketXml('<line><text length="20">A &amp; B &lt;script&gt;</text></line>');
		const html = xmlToReceiptHtml(xml);
		expect(html).toContain("A &amp; B &lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
});
