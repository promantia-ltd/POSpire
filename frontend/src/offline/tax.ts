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
}

export interface ItemTaxDetail {
	account_head: string;
	rate: number;
}

export interface OfflineTaxConfig {
	sales_taxes_and_charges: SalesTaxRow[];
	item_tax_templates: Record<string, ItemTaxDetail[]>;
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

/** Tax rate rows that apply to a single line (item override or invoice-level). */
function ratesForLine(line: TaxLine, config: OfflineTaxConfig): ItemTaxDetail[] {
	const template = line.item_tax_template;
	if (template && config.item_tax_templates[template]) {
		return config.item_tax_templates[template];
	}
	return config.sales_taxes_and_charges.map((r) => ({
		account_head: r.account_head,
		rate: r.rate,
	}));
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

	const taxes: OfflineTaxRow[] = [];
	let totalTax = 0;
	for (const [account_head, { rate, tax_amount }] of byAccount) {
		const rounded = round(tax_amount, precision);
		totalTax += rounded;
		taxes.push({
			account_head,
			description: account_head.split(" - ")[0],
			charge_type: SUPPORTED_CHARGE_TYPE,
			rate,
			tax_amount: rounded,
			included_in_print_rate: inclusive ? 1 : 0,
		});
	}
	totalTax = round(totalTax, precision);

	return {
		supported: true,
		taxes,
		total_taxes_and_charges: totalTax,
		// Inclusive: net_total is the price minus embedded tax. Exclusive:
		// net_total is the base and tax adds on top.
		net_total: round(inclusive ? netTotal - totalTax : netTotal, precision),
		grand_total: round(inclusive ? netTotal : netTotal + totalTax, precision),
	};
}
