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
 */
const WRAPPER_STYLE = [
	"font-family:'Courier New',monospace",
	"font-size:12px",
	"line-height:1.4",
	"width:336px",
	"max-width:336px",
	"overflow:hidden",
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
			let lineHtml = `<div class="line" style="margin-bottom:2px;white-space:nowrap;overflow:hidden;max-width:336px;${overflowStyle}"${overflowTitle}>`;
			for (const text of textElements) {
				let content = text.textContent || "";
				const align = text.getAttribute("align") || "left";
				const bold = text.getAttribute("bold") === "true" ? "font-weight:bold;" : "";
				const underline =
					text.getAttribute("underline") === "true" ? "text-decoration:underline;" : "";
				const length = parseInt(text.getAttribute("length") || "42", 10);

				if (content.length > length) {
					content = content.slice(0, length - 1) + "…";
				}

				const widthPercent = (length / 42) * 100;
				const style =
					"display:inline-block;" +
					`width:${widthPercent.toFixed(2)}%;` +
					`text-align:${align};` +
					"overflow:hidden;" +
					"text-overflow:ellipsis;" +
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
			html +=
				'<div class="line" style="text-align:center;margin:8px 0;">' +
				`<div style="font-size:10px;">[Barcode: ${escapeHtml(value)}]</div>` +
				"</div>";
		}
	}

	html += "</div>";
	return html;
}
