/**
 * Offline tax estimation for the cart (server-side tax is live-only).
 *
 * Estimates only flat "On Net Total" percentage taxes — the server stays
 * authoritative and re-expands on sync. Other charge types report unsupported
 * so the caller can degrade instead of collecting a wrong amount.
 */

export const SUPPORTED_CHARGE_TYPE = "On Net Total";

export interface SalesTaxRow {
	account_head: string;
	charge_type: string;
	rate: number;
	/** Added alongside pospire.pospire.api.posapp.get_offline_tax_config's
	 *  per-row `description` (S6) — the same label an online tax line
	 *  shows, so an offline receipt's tax lines read the same as online's
	 *  instead of falling back to the bare account head. */
	description?: string;
}

export interface ItemTaxDetail {
	account_head: string;
	rate: number;
}

export interface OfflineTaxConfig {
	sales_taxes_and_charges: SalesTaxRow[];
	item_tax_templates: Record<string, ItemTaxDetail[]>;
	/** Mirrors Accounts Settings' flag of the same name (see
	 *  get_offline_tax_config). When 1, ERPNext adds a tax row for every head
	 *  in an item's tax template; when 0 (the default) a template only
	 *  overrides the rate of a head the invoice already charges. */
	add_taxes_from_item_tax_template?: 0 | 1;
}

/** One cart line reduced to what tax needs: its taxable net and tax template. */
export interface TaxLine {
	/** qty x rate for the line (rate is already net of per-item discount). */
	net: number;
	/** Item's default Item Tax Template name, if any. */
	item_tax_template?: string | null;
}

export interface OfflineTaxRow {
	account_head: string;
	description: string;
	charge_type: string;
	rate: number;
	tax_amount: number;
	/** The base this row's tax was calculated on. Every row shares the same
	 *  value here — the only charge type this module supports is a flat
	 *  percentage "On Net Total", so there is one taxable base for the
	 *  whole invoice, not a per-line split. */
	taxable_amount: number;
	included_in_print_rate: 0 | 1;
}

export interface OfflineTaxResult {
	/** false => a charge type we don't compute offline; caller must degrade. */
	supported: boolean;
	taxes: OfflineTaxRow[];
	total_taxes_and_charges: number;
	net_total: number;
	grand_total: number;
}

function round(value: number, precision: number): number {
	const f = 10 ** precision;
	return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Tax rate rows that apply to a single line.
 *
 * The invoice's own Sales Taxes and Charges rows decide WHICH account heads
 * are charged; an Item Tax Template only overrides the RATE of a head that is
 * already among them. This mirrors ERPNext exactly — see `_get_tax_rate` in
 * erpnext/controllers/taxes_and_totals.py, which walks `doc.taxes` and falls
 * back to `tax.rate` when the item's map has nothing for that account head.
 *
 * Returning the Item Tax Template's own rows instead (as this did) invents
 * tax lines that the server never produces: a GST template carries Input,
 * RCM and negative Refund heads too, so an offline receipt listed fifteen
 * lines where the online invoice had none, and the estimated tax was wrong by
 * the sum of them. On a tax-exclusive profile that is an overcharge, not just
 * a wrong printout.
 *
 * The one case where ERPNext does add a head from the item's template is when
 * Accounts Settings' `add_taxes_from_item_tax_template` is on
 * (add_taxes_from_tax_template in accounts_controller.py). The server reports
 * that flag on the tax config so this mirrors it rather than guessing.
 */
function ratesForLine(line: TaxLine, config: OfflineTaxConfig): ItemTaxDetail[] {
	const template = line.item_tax_template;
	const itemRows =
		template && config.item_tax_templates[template] ? config.item_tax_templates[template] : [];
	const overrides = new Map<string, number>(itemRows.map((r) => [r.account_head, r.rate]));

	const rows = config.sales_taxes_and_charges.map((r) => ({
		account_head: r.account_head,
		rate: overrides.has(r.account_head) ? (overrides.get(r.account_head) as number) : r.rate,
	}));

	// Only when the site has Accounts Settings' add_taxes_from_item_tax_template
	// on does ERPNext append a row for an item-template head the invoice does
	// not already charge, exactly as below.
	if (config.add_taxes_from_item_tax_template) {
		const charged = new Set(rows.map((r) => r.account_head));
		for (const r of itemRows) {
			if (!charged.has(r.account_head)) {
				rows.push({ account_head: r.account_head, rate: r.rate });
				charged.add(r.account_head);
			}
		}
	}
	return rows;
}

/**
 * Estimate tax for cart lines. `netTotal` is the taxable base (line nets minus
 * invoice-level discount); tax is distributed across lines to reach it.
 */
export function computeOfflineTax(
	lines: TaxLine[],
	config: OfflineTaxConfig | null | undefined,
	opts: { inclusive: boolean; netTotal: number; precision?: number },
): OfflineTaxResult {
	const precision = opts.precision ?? 2;
	const inclusive = opts.inclusive;
	const netTotal = opts.netTotal;

	const empty: OfflineTaxResult = {
		supported: true,
		taxes: [],
		total_taxes_and_charges: 0,
		net_total: round(netTotal, precision),
		grand_total: round(netTotal, precision),
	};

	// Fail closed. Reporting `supported: true` with zero tax let the
	// exclusive-tax Pay guard pass and the till collect the untaxed amount.
	if (!config) return { ...empty, supported: false };

	// Guardrail: we only compute flat "On Net Total" percentage taxes.
	const unsupported = config.sales_taxes_and_charges.some(
		(r) => r.charge_type && r.charge_type !== SUPPORTED_CHARGE_TYPE,
	);
	if (unsupported) return { ...empty, supported: false };

	const sumLineNet = lines.reduce((acc, l) => acc + (l.net || 0), 0);
	if (!sumLineNet) return empty;
	// Distribute any invoice-level discount (netTotal < sumLineNet) across lines.
	const scale = netTotal / sumLineNet;

	const byAccount = new Map<string, { rate: number; tax_amount: number }>();

	for (const line of lines) {
		const taxableNet = (line.net || 0) * scale;
		const rows = ratesForLine(line, config).filter((r) => r.rate);
		if (!rows.length) continue;

		if (inclusive) {
			// Prices include tax: extract the embedded portion, split by rate.
			const totalRate = rows.reduce((acc, r) => acc + r.rate, 0);
			const embedded = (taxableNet * totalRate) / (100 + totalRate);
			for (const r of rows) {
				const share = embedded * (r.rate / totalRate);
				const cur = byAccount.get(r.account_head) || { rate: r.rate, tax_amount: 0 };
				cur.tax_amount += share;
				byAccount.set(r.account_head, cur);
			}
		} else {
			for (const r of rows) {
				const cur = byAccount.get(r.account_head) || { rate: r.rate, tax_amount: 0 };
				cur.tax_amount += (taxableNet * r.rate) / 100;
				byAccount.set(r.account_head, cur);
			}
		}
	}

	const descriptionByAccount = new Map(
		config.sales_taxes_and_charges
			.filter((r) => r.description)
			.map((r) => [r.account_head, r.description as string]),
	);

	let totalTax = 0;
	for (const { tax_amount } of byAccount.values()) {
		totalTax += round(tax_amount, precision);
	}
	totalTax = round(totalTax, precision);
	// Inclusive: net_total is the price minus embedded tax. Exclusive:
	// net_total is the base and tax adds on top. Also every row's taxable
	// base (single flat charge type => one shared base, not a per-line one).
	const netTotal_ = round(inclusive ? netTotal - totalTax : netTotal, precision);

	const taxes: OfflineTaxRow[] = [];
	for (const [account_head, { rate, tax_amount }] of byAccount) {
		taxes.push({
			account_head,
			description: descriptionByAccount.get(account_head) || account_head.split(" - ")[0],
			charge_type: SUPPORTED_CHARGE_TYPE,
			rate,
			tax_amount: round(tax_amount, precision),
			taxable_amount: netTotal_,
			included_in_print_rate: inclusive ? 1 : 0,
		});
	}

	return {
		supported: true,
		taxes,
		total_taxes_and_charges: totalTax,
		net_total: netTotal_,
		grand_total: round(inclusive ? netTotal : netTotal + totalTax, precision),
	};
}
