import { describe, expect, it } from "vitest";

import { computeOfflineTax } from "@/offline/tax";

const LINES = [{ net: 100, item_tax_template: null }];
const OPTS = { inclusive: false, netTotal: 100, precision: 2 };

const CONFIG = {
	sales_taxes_and_charges: [
		{ account_head: "GST - X", charge_type: "On Net Total", rate: 18 },
	],
	item_tax_templates: {},
};

/**
 * A missing config previously reported `supported: true` with zero tax, so the
 * exclusive-tax Pay guard passed and the till collected the untaxed amount.
 * Absent config must be uncomputable, not "no tax".
 */
describe("computeOfflineTax: missing config fails closed", () => {
	it("reports unsupported when there is no config", () => {
		const r = computeOfflineTax(LINES, null, OPTS);
		expect(r.supported).toBe(false);
	});

	it("still computes normally when a config is present", () => {
		const r = computeOfflineTax(LINES, CONFIG as never, OPTS);
		expect(r.supported).toBe(true);
		expect(r.total_taxes_and_charges).toBe(18);
	});

	it("reports unsupported for a charge type it cannot compute", () => {
		const r = computeOfflineTax(
			LINES,
			{
				sales_taxes_and_charges: [
					{ account_head: "X", charge_type: "Actual", rate: 5 },
				],
				item_tax_templates: {},
			} as never,
			OPTS,
		);
		expect(r.supported).toBe(false);
	});
});

/**
 * An Item Tax Template overrides the RATE of an account head the invoice
 * already charges; it never introduces new heads. ERPNext's own
 * `_get_tax_rate` walks `doc.taxes` and only consults the item's map for a
 * head already in that table. Taking the template's rows wholesale printed a
 * GST template's Input / RCM / negative Refund heads onto a customer receipt
 * (fifteen lines against an online invoice that had none) and inflated the
 * estimate by their sum.
 */
describe("computeOfflineTax: item tax template overrides rates, never adds heads", () => {
	const GST_TEMPLATE = {
		"GST 18%": [
			{ account_head: "Output Tax IGST - X", rate: 18 },
			{ account_head: "Input Tax IGST - X", rate: 18 },
			{ account_head: "Output Tax IGST Refund - X", rate: -18 },
		],
	};

	it("charges only the heads on the invoice's tax table", () => {
		const r = computeOfflineTax(
			[{ net: 100, item_tax_template: "GST 18%" }],
			{
				sales_taxes_and_charges: [
					{ account_head: "Output Tax IGST - X", charge_type: "On Net Total", rate: 5 },
				],
				item_tax_templates: GST_TEMPLATE,
			} as never,
			OPTS,
		);
		expect(r.taxes.map((t) => t.account_head)).toEqual(["Output Tax IGST - X"]);
		// 18 from the item template, not the invoice row's own 5.
		expect(r.taxes[0].rate).toBe(18);
		expect(r.total_taxes_and_charges).toBe(18);
	});

	it("charges nothing when the profile has no tax table", () => {
		const r = computeOfflineTax(
			[{ net: 100, item_tax_template: "GST 18%" }],
			{ sales_taxes_and_charges: [], item_tax_templates: GST_TEMPLATE } as never,
			OPTS,
		);
		expect(r.taxes).toEqual([]);
		expect(r.total_taxes_and_charges).toBe(0);
		expect(r.grand_total).toBe(100);
	});

	it("keeps the invoice row's own rate for a head the template doesn't mention", () => {
		const r = computeOfflineTax(
			[{ net: 100, item_tax_template: "GST 18%" }],
			{
				sales_taxes_and_charges: [
					{ account_head: "Cess - X", charge_type: "On Net Total", rate: 2 },
				],
				item_tax_templates: GST_TEMPLATE,
			} as never,
			OPTS,
		);
		expect(r.taxes.map((t) => t.account_head)).toEqual(["Cess - X"]);
		expect(r.total_taxes_and_charges).toBe(2);
	});
	it("adds item-template heads only when the site setting says ERPNext would", () => {
		const base = {
			sales_taxes_and_charges: [
				{ account_head: "Output Tax IGST - X", charge_type: "On Net Total", rate: 18 },
			],
			item_tax_templates: GST_TEMPLATE,
		};
		const off = computeOfflineTax([{ net: 100, item_tax_template: "GST 18%" }], base as never, OPTS);
		expect(off.taxes.map((t) => t.account_head)).toEqual(["Output Tax IGST - X"]);

		const on = computeOfflineTax(
			[{ net: 100, item_tax_template: "GST 18%" }],
			{ ...base, add_taxes_from_item_tax_template: 1 } as never,
			OPTS,
		);
		expect(on.taxes.map((t) => t.account_head)).toEqual([
			"Output Tax IGST - X",
			"Input Tax IGST - X",
			"Output Tax IGST Refund - X",
		]);
	});
});
