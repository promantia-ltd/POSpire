/**
 * buildPrintContext() total math — separate from helper parity
 * (print-helper-parity.test.ts), which covers the Jinja/nunjucks helpers
 * themselves. This file covers a business-logic bug the PR review caught:
 * delivery charges were left out of the recomputed offline total.
 *
 * Invoice.vue adds the delivery charge on top of the tax result at
 * checkout (grand = offlineTax.grand_total + delivery) — untaxed, outside
 * the taxable base. buildPrintContext's recomputed branches (taxConfig
 * available, or not) must add it back the same way, or an offline
 * receipt's total (and therefore change_amount) is short by exactly the
 * delivery charge.
 */
import { describe, it, expect } from "vitest";
import { buildPrintContext } from "@/offline/print/context";

const TAX_CONFIG = {
	sales_taxes_and_charges: [
		{ account_head: "GST - TC", charge_type: "On Net Total", rate: 18, description: "GST" },
	],
	item_tax_templates: {},
};

function invoiceWith(overrides = {}) {
	return {
		name: "OFFLINE-INV-test",
		items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1, rate: 1000, amount: 1000 }],
		taxes: [],
		payments: [],
		...overrides,
	};
}

describe("buildPrintContext — delivery charge in recomputed totals", () => {
	it("adds the delivery charge on top of the recomputed tax result (taxConfig branch)", () => {
		const invoice = invoiceWith({ posa_delivery_charges_rate: 50 });
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		// net 1000, exclusive 18% tax = 180, delivery 50 on top, untaxed.
		expect(doc.net_total).toBe(1000);
		expect(doc.total_taxes_and_charges).toBe(180);
		expect(doc.grand_total).toBe(1230);
		expect(doc.rounded_total).toBe(1230);
	});

	it("reads custom_delivery_charge_rate as a fallback for posa_delivery_charges_rate", () => {
		const invoice = invoiceWith({ custom_delivery_charge_rate: 25 });
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.grand_total).toBe(1000 + 180 + 25);
	});

	it("adds the delivery charge in the no-taxConfig fallback too", () => {
		const invoice = invoiceWith({ posa_delivery_charges_rate: 50 });
		const doc = buildPrintContext(invoice, { taxConfig: null, printConfig: {} });

		// No tax config available at all — untaxed subtotal (1000) plus the
		// delivery charge (50), not just the bare subtotal.
		expect(doc.grand_total).toBe(1000);
		expect(doc.rounded_total).toBe(1050);
	});

	it("without a delivery charge, totals are unaffected (control case)", () => {
		const invoice = invoiceWith();
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.grand_total).toBe(1180);
		expect(doc.rounded_total).toBe(1180);
	});
});

// Round 4 review: result.supported was ignored (an unsupported charge type
// or a missing config silently printed a taxless receipt instead of
// degrading visibly), tax rows had no taxable_amount, precision was read
// from a different source than checkout used, and reprint always
// recomputed tax from whatever config happens to be cached NOW instead of
// what was actually charged at sale time.
const UNSUPPORTED_TAX_CONFIG = {
	sales_taxes_and_charges: [
		{ account_head: "Service Charge - TC", charge_type: "Actual", rate: 0 },
	],
	item_tax_templates: {},
};

describe("buildPrintContext — unsupported tax config degrades visibly (result.supported)", () => {
	it("taxConfig branch: unsupported charge type prints untaxed with tax_unavailable set", () => {
		const invoice = invoiceWith({ posa_delivery_charges_rate: 50 });
		const doc = buildPrintContext(invoice, { taxConfig: UNSUPPORTED_TAX_CONFIG, printConfig: {} });

		expect(doc.taxes).toEqual([]);
		expect(doc.total_taxes_and_charges).toBe(0);
		expect(doc.net_total).toBe(1000);
		// Untaxed fallback still adds the delivery charge on top.
		expect(doc.grand_total).toBe(1050);
		expect(doc.rounded_total).toBe(1050);
		expect(doc.tax_unavailable).toBe(true);
	});

	it("a supported taxConfig leaves tax_unavailable false", () => {
		const invoice = invoiceWith();
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });
		expect(doc.tax_unavailable).toBe(false);
	});
});

describe("buildPrintContext — taxable_amount on tax rows", () => {
	it("recomputed (taxConfig) rows carry taxable_amount", () => {
		const invoice = invoiceWith();
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.taxes).toHaveLength(1);
		expect(doc.taxes[0].taxable_amount).toBe(1000);
	});

	it("real invoice.taxes rows fall back to invoice.net_total when taxable_amount is absent", () => {
		const invoice = invoiceWith({
			taxes: [{ account_head: "GST - TC", rate: 18, tax_amount: 180 }],
			net_total: 1000,
			grand_total: 1180,
		});
		const doc = buildPrintContext(invoice, { taxConfig: null, printConfig: {} });

		expect(doc.taxes[0].taxable_amount).toBe(1000);
	});
});

describe("buildPrintContext — precision source preference", () => {
	it("prefers invoice.currency_precision (checkout-time) over printConfig.currency_precision", () => {
		const invoice = invoiceWith({
			items: [{ item_code: "I1", item_name: "I1", qty: 1, rate: 1000.126, amount: 1000.126 }],
			currency_precision: 3,
		});
		const doc = buildPrintContext(invoice, { taxConfig: null, printConfig: { currency_precision: 2 } });

		expect(doc.total).toBe(1000.126);
	});

	it("falls back to printConfig.currency_precision when the invoice has none", () => {
		const invoice = invoiceWith({
			items: [{ item_code: "I1", item_name: "I1", qty: 1, rate: 1000.126, amount: 1000.126 }],
		});
		const doc = buildPrintContext(invoice, { taxConfig: null, printConfig: { currency_precision: 2 } });

		expect(doc.total).toBe(1000.13);
	});
});

describe("buildPrintContext — reprint prefers the stamped tax snapshot", () => {
	it("uses pospire_print_tax_snapshot instead of recomputing from a (changed) taxConfig", () => {
		const invoice = invoiceWith({
			posa_delivery_charges_rate: 50,
			pospire_print_tax_snapshot: {
				supported: true,
				taxes: [
					{
						account_head: "GST - TC",
						description: "GST",
						rate: 18,
						tax_amount: 180,
						taxable_amount: 1000,
					},
				],
				net_total: 1000,
				total_taxes_and_charges: 180,
				grand_total: 1180,
			},
		});
		// A tax rate change since the sale (24% now, was 18% at sale time) —
		// the snapshot must win, not this config.
		const changedConfig = {
			sales_taxes_and_charges: [
				{ account_head: "GST - TC", charge_type: "On Net Total", rate: 24, description: "GST" },
			],
			item_tax_templates: {},
		};
		const doc = buildPrintContext(invoice, { taxConfig: changedConfig, printConfig: {} });

		expect(doc.total_taxes_and_charges).toBe(180);
		expect(doc.taxes[0].rate).toBe(18);
		// Snapshot's grand_total (1180) + delivery (50), same as the live path.
		expect(doc.grand_total).toBe(1230);
		expect(doc.tax_unavailable).toBe(false);
	});

	it("an unsupported snapshot degrades visibly instead of recomputing from taxConfig", () => {
		const invoice = invoiceWith({
			pospire_print_tax_snapshot: { supported: false, taxes: [], net_total: 1000, total_taxes_and_charges: 0, grand_total: 1000 },
		});
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.taxes).toEqual([]);
		expect(doc.tax_unavailable).toBe(true);
		expect(doc.grand_total).toBe(1000);
	});

	it("falls back to recomputing from taxConfig when no snapshot is present (legacy outbox rows)", () => {
		const invoice = invoiceWith();
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.taxes).toHaveLength(1);
		expect(doc.total_taxes_and_charges).toBe(180);
	});
});
