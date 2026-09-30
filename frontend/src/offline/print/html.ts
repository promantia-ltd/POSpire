/**
 * xmlToReceiptHtml() — browser-side port of
 * pospire.pospire.api.hardware_manager.render_receipt_xml_to_html (the
 * POS XML Print Designer's own preview renderer). Reused here so a
 * non-thermal ("browser") receipt — online with the profile option on, or
 * offline always — looks exactly like the same designer preview an admin
 * already sees when editing the template, instead of a second, hand-built
 * layout that could quietly drift from it. Replaces the old hand-built
 * handleProvisionalPrint receipt.
 *
 * Deliberately mirrors the Python version's structure line for line
 * (including the 42-character-width math) so the two stay easy to compare
 * and keep in sync — see the "XML to receipt page" automated test in the
 * receipt printing plan, which checks alignment/bold/column widths match.
 *
 * Two DELIBERATE departures from the Python preview, both because this
 * renders a receipt actually handed to a customer, not an admin's preview
 * of column alignment:
 *   - No per-cell truncation. The Python version cuts content to `length`
 *     chars (with a trailing "…") so an admin can see column overflow at a
 *     glance; doing that here can cut digits off a real amount. Cells are
 *     allowed to overflow their nominal width instead of being shortened.
 *   - <barcode> renders as its literal text value, not "[Barcode: ...]" —
 *     that label read as a placeholder to an admin previewing a template,
 *     but printed on an actual receipt it looks like a bug, and it can't be
 *     scanned either way (no barcode is actually drawn on this path — a
 *     real barcode only exists in the thermal/ESC-POS printer path).
 */
const WRAPPER_STYLE = [
	"font-family:'Courier New',monospace",
	"font-size:12px",
	"line-height:1.4",
	"width:336px",
	"max-width:336px",
	// No overflow:hidden — an over-long cell (see the per-line style below)
	// must stay visible even if it pushes past the nominal 42-char/336px
	// receipt width, rather than being cut off at the box edge.
	"margin:auto",
	"border:1px dashed #ccc",
	"padding:8px",
	"background:#fff",
	"box-sizing:content-box",
].join(";");

function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * @param {string} xml - rendered receipt XML (already run through renderReceiptXml)
 * @returns {string} HTML markup for a 42-column receipt page, or an error div
 *   on malformed XML — same failure shape as the server's own preview.
 */
export function xmlToReceiptHtml(xml) {
	let doc;
	try {
		const parser = new DOMParser();
		doc = parser.parseFromString(xml, "application/xml");
		const parserError = doc.querySelector("parsererror");
		if (parserError) {
			throw new Error(parserError.textContent || "XML parse error");
		}
	} catch (e) {
		return `<div style="color:red;">Error rendering XML: ${escapeHtml(e.message || e)}</div>`;
	}

	let html = `<div class="xml-preview" style="${WRAPPER_STYLE}">`;

	const tickets = doc.getElementsByTagName("ticket");
	for (const ticket of Array.from(tickets)) {
		const lines = Array.from(ticket.children).filter((el) => el.tagName === "line");
		for (const line of lines) {
			const textElements = Array.from(line.getElementsByTagName("text"));
			const totalWidth = textElements.reduce(
				(sum, t) => sum + parseInt(t.getAttribute("length") || "42", 10),
				0,
			);
			let overflowStyle = "";
			let overflowTitle = "";
			if (totalWidth > 42 && textElements.length > 1) {
				overflowStyle = "border-left:3px solid red;padding-left:3px;";
				overflowTitle = ` title="Line exceeds 42 chars (${totalWidth})"`;
			}
			let lineHtml = `<div class="line" style="margin-bottom:2px;white-space:nowrap;max-width:336px;${overflowStyle}"${overflowTitle}>`;
			for (const text of textElements) {
				let content = text.textContent || "";
				const align = text.getAttribute("align") || "left";
				const bold = text.getAttribute("bold") === "true" ? "font-weight:bold;" : "";
				const underline =
					text.getAttribute("underline") === "true" ? "text-decoration:underline;" : "";
				const length = parseInt(text.getAttribute("length") || "42", 10);

				// No truncation here — see the file header. A cell wider than
				// its nominal `length` overflows visually instead of losing
				// characters (an amount is the one thing on a receipt that
				// must never be shortened).
				const widthPercent = (length / 42) * 100;
				const style =
					"display:inline-block;" +
					`min-width:${widthPercent.toFixed(2)}%;` +
					`text-align:${align};` +
					"white-space:nowrap;" +
					bold +
					underline;

				lineHtml += `<span style="${style}">${escapeHtml(content)}</span>`;
			}
			lineHtml += "</div>";
			html += lineHtml;
		}

		const barcodes = Array.from(ticket.children).filter((el) => el.tagName === "barcode");
		for (const barcode of barcodes) {
			const value = barcode.textContent || "";
			// No barcode is actually drawn here (no library, no canvas) — a
			// real scannable barcode only exists on the thermal/ESC-POS path,
			// which sends a real <barcode> command to the printer. Printing
			// the value as plain text is honest about that; the old
			// "[Barcode: ...]" label read as a template-preview placeholder
			// on an actual customer receipt.
			html +=
				'<div class="line" style="text-align:center;margin:8px 0;font-size:10px;">' +
				escapeHtml(value) +
				"</div>";
		}
	}

	html += "</div>";
	return html;
}
