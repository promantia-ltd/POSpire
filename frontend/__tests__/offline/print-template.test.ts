/**
 * Renders the site's actual default POS XML Print Designer template (a
 * point-in-time snapshot of the record on pospire_dev, ref_doctype "Sales
 * Invoice", is_default=1 — see hardware_manager.py::get_offline_print_config)
 * through the offline path for a sale and a return, exactly as
 * hardwareUtils.js::printReceipt does. This is the "renders the default
 * template for a sale and a return" test the PR review asked for — it
 * doesn't byte-diff against the Python renderer (there's no Python runner
 * available from Vitest), but it does prove the real template actually
 * renders to valid, complete XML for both cases with the right heading,
 * amounts and structure — catching a broken helper or a missing doc field
 * that the narrower unit tests elsewhere in this file don't cover.
 */
import { describe, it, expect } from "vitest";
import { buildPrintContext } from "@/offline/print/context";
import { renderReceiptXml } from "@/offline/print/xml";

// Verbatim snapshot of pospire_dev's default template as of 2026-09-30
// (frappe.db.get_value("POS XML Print Designer", {"ref_doctype": "Sales
// Invoice", "is_default": 1}, "xml_template")). Update this fixture if the
// real template's structure changes materially.
const REFERENCE_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<output>
  <ticket>
    <line><text align="center" length="42" bold="true">{{ cut(upper(doc.company), 42) }}</text></line>
    {% for addr in address_lines(doc.company_address_display) %}
    <line><text align="center" length="42" bold="true">{{ cut(addr, 42) }}</text></line>
    {% endfor %}
    <line><text bold="true">{{ separator("=") }}</text></line>

    {% if doc.is_return %}
    <line><text align="center" length="42" bold="true">{{ _("RETURN/REFUND") }}</text></line>
    {% else %}
    <line><text align="center" length="42" bold="true">{{ _("SALES RECEIPT") }}</text></line>
    {% endif %}
    {% if doc.pospire_pending_sync %}
    <line><text align="center" length="42" bold="true">{{ _("PROVISIONAL - PENDING SYNC") }}</text></line>
    {% endif %}
    <line><text bold="true">{{ separator("=") }}</text></line>

    <line><text bold="true">{{ pad_left(_("Invoice"), 12) }}: {{ cut(doc.name, 28) }}</text></line>
    <line><text bold="true">{{ pad_left(_("Date"), 12) }}: {{ format_date(doc.posting_date) }}</text></line>
    <line><text bold="true">{{ pad_left(_("Time"), 12) }}: {{ format_time(doc.posting_time) }}</text></line>
    <line><text bold="true">{{ pad_left(_("Cashier"), 12) }}: {{ cut(doc.owner, 28) }}</text></line>
    <line><text bold="true">{{ separator("-") }}</text></line>

    <line><text bold="true">{{ pad_left(_("Customer"), 12) }}: {{ cut(doc.customer_name, 28) }}</text></line>
    {% if doc.contact_mobile %}
    <line><text bold="true">{{ pad_left(_("Mobile"), 12) }}: {{ doc.contact_mobile }}</text></line>
    {% endif %}
    <line><text bold="true">{{ separator("-") }}</text></line>

    <line>
      <text align="left" length="22" bold="true">{{ _("Item") }}</text>
      <text align="right" length="6" bold="true">{{ _("Qty") }}</text>
      <text align="right" length="14" bold="true">{{ _("Amount") }}</text>
    </line>
    <line><text bold="true">{{ separator("-") }}</text></line>

    {% for item in doc.items %}
    <line><text bold="true">{{ cut(item.item_name, 42) }}</text></line>
    <line>
      <text align="left" length="22" bold="true">  @ {{ format_money(item.rate) }}</text>
      <text align="right" length="6" bold="true">{{ format_qty(item.qty) }}</text>
      <text align="right" length="14" bold="true">{{ format_money(item.amount) }}</text>
    </line>
    {% endfor %}

    <line><text bold="true">{{ separator("=") }}</text></line>

    <line>
      <text align="left" length="28" bold="true">{{ _("Subtotal") }}</text>
      <text align="right" length="14" bold="true">{{ format_money(doc.total) }}</text>
    </line>

    {% if doc.discount_amount %}
    <line>
      <text align="left" length="28" bold="true">{{ _("Discount") }}</text>
      <text align="right" length="14" bold="true">-{{ format_money(abs(doc.discount_amount)) }}</text>
    </line>
    {% endif %}

    {% for tax in doc.taxes %}
    <line>
      <text align="left" length="28" bold="true">{{ cut(tax.description, 28) }}</text>
      <text align="right" length="14" bold="true">{{ format_money(tax.tax_amount) }}</text>
    </line>
    {% endfor %}

    <line><text bold="true">{{ separator("=") }}</text></line>
    <line>
      <text align="left" length="28" bold="true">{{ upper(_("Grand Total")) }}</text>
      <text align="right" length="14" bold="true">{{ format_money(doc.grand_total) }}</text>
    </line>
    <line><text bold="true">{{ separator("=") }}</text></line>

    {% for payment in doc.payments %}
    {% if payment.amount %}
    <line>
      <text align="left" length="28" bold="true">{{ cut(payment.mode_of_payment, 28) }}</text>
      <text align="right" length="14" bold="true">{{ format_money(payment.amount) }}</text>
    </line>
    {% endif %}
    {% endfor %}

    {% if doc.change_amount > 0 %}
    <line>
      <text align="left" length="28" bold="true">{{ _("Change") }}</text>
      <text align="right" length="14" bold="true">{{ format_money(doc.change_amount) }}</text>
    </line>
    {% endif %}

    <line></line>
    <line><text align="center" length="42" bold="true">{{ _("Thank you for your business!") }}</text></line>
    <line><text align="center" length="42" bold="true">{{ _("Please visit again") }}</text></line>
    <line></line>

    {% if doc.pospire_pending_sync %}
    <line><text align="center" length="42">{{ _("Final receipt will be issued after sync") }}</text></line>
    {% else %}
    <line><barcode type="CODE128" position="bottom">{{ doc.name }}</barcode></line>
    {% endif %}
    <line></line>
  </ticket>
</output>
`;

const SETTINGS = {
	number_format: "#,##,###.##",
	date_format: "dd-mm-yyyy",
	time_format: "HH:mm:ss",
	currency_precision: 2,
	currency_symbol: "₹",
};

const PRINT_CONFIG = {
	...SETTINGS,
	company: "Lifestyle Retail Stores",
	company_address_display: "Divyashree Tech Park<br>Yamlur<br>Bengaluru",
};

function assertWellFormedXml(xml: string) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, "application/xml");
	const parserError = doc.querySelector("parsererror");
	expect(parserError, parserError?.textContent || "").toBeNull();
}

describe("default reference template — sale and return render correctly", () => {
	it("renders a sale: SALES RECEIPT heading, correct grand total, no leftover Jinja syntax", () => {
		const invoice = {
			name: "SINV-26-00432",
			owner: "cashier@example.com",
			customer_name: "Walk-in Customer",
			posting_date: "2026-09-30",
			items: [
				{ item_code: "TOWEL-01", item_name: "Bath Towel Set", qty: 2, rate: 799, amount: 1598 },
			],
			taxes: [
				{ account_head: "SGST - LRS", description: "SGST", rate: 9, tax_amount: 143.82 },
				{ account_head: "CGST - LRS", description: "CGST", rate: 9, tax_amount: 143.82 },
			],
			net_total: 1598,
			grand_total: 1885.64,
			rounded_total: 1885.64,
			payments: [{ mode_of_payment: "Cash", amount: 1885.64 }],
			is_return: false,
		};
		const doc = buildPrintContext(invoice, { printConfig: PRINT_CONFIG, pendingSync: false });
		const xml = renderReceiptXml(REFERENCE_TEMPLATE, doc, SETTINGS);

		assertWellFormedXml(xml);
		expect(xml).toContain("SALES RECEIPT");
		expect(xml).not.toContain("RETURN/REFUND");
		expect(xml).toContain("SINV-26-00432");
		expect(xml).toContain("₹ 1,885.64");
		expect(xml).not.toMatch(/\{\{|\{%/); // no unresolved template syntax
	});

	it("renders a return: RETURN/REFUND heading, negative amounts, matching negative grand total", () => {
		const invoice = {
			name: "SINV-26-00432",
			owner: "Administrator",
			customer_name: "MG Road Store POS Customer",
			posting_date: "2026-09-25",
			items: [
				{ item_code: "TOWEL-01", item_name: "Bath Towel Set", qty: -1, rate: 799, amount: -799 },
			],
			taxes: [
				{ account_head: "SGST - LRS", description: "SGST", rate: 9, tax_amount: -60.94 },
				{ account_head: "CGST - LRS", description: "CGST", rate: 9, tax_amount: -60.94 },
			],
			net_total: -677.12,
			grand_total: -799,
			rounded_total: -799,
			payments: [],
			is_return: true,
		};
		const doc = buildPrintContext(invoice, { printConfig: PRINT_CONFIG, pendingSync: false });
		const xml = renderReceiptXml(REFERENCE_TEMPLATE, doc, SETTINGS);

		assertWellFormedXml(xml);
		expect(xml).toContain("RETURN/REFUND");
		expect(xml).not.toContain("SALES RECEIPT");
		expect(xml).toContain("₹ -799.00");
		expect(xml).not.toMatch(/\{\{|\{%/);
	});

	it("marks a still-pending offline sale distinctly and omits the real barcode", () => {
		const invoice = {
			name: "",
			owner: "cashier@example.com",
			customer_name: "Walk-in Customer",
			items: [{ item_code: "ITEM-1", item_name: "Item", qty: 1, rate: 100, amount: 100 }],
			taxes: [],
			payments: [{ mode_of_payment: "Cash", amount: 100 }],
			is_return: false,
		};
		const doc = buildPrintContext(invoice, {
			printConfig: PRINT_CONFIG,
			offlineId: "abc123",
			pendingSync: true,
		});
		const xml = renderReceiptXml(REFERENCE_TEMPLATE, doc, SETTINGS);

		assertWellFormedXml(xml);
		expect(xml).toContain("PROVISIONAL - PENDING SYNC");
		expect(xml).toContain("Final receipt will be issued after sync");
		expect(xml).not.toContain("<barcode");
	});
});
