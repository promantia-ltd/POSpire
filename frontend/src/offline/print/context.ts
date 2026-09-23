/**
 * buildPrintContext() — the offline counterpart to what a real Sales
 * Invoice document gives a Jinja/XML print template online. Builds
 * exactly the `doc` shape the template contract promises (see
 * docs/OFFLINE_RECEIPT_PRINTING_IMPLEMENTATION_PLAN.md §4 and the
 * receipt-printing plan's field table) from whatever's actually available
 * offline: the in-memory cart at submit time, or a decrypted outbox
 * payload when reprinting later.
 *
 * One function, two callers:
 *   - Payments.vue, right after an offline submit (fresh cart).
 *   - Navbar.vue / OfflineReceipts.vue, reprinting a stored offline sale
 *     (cart reconstructed from the outbox row's decrypted payload).
 *
 * Deliberately NOT used for the online path — online, the real Sales
 * Invoice document already has every one of these fields; the server
 * builds it, not this module.
 */
import { computeOfflineTax } from "@/offline/tax";
import { currentCashier } from "@/offline/cashier";
import { datetime } from "@/utils/datetime";
import { flt } from "@/utils/numberFormat";

export function buildPrintContext(invoice, opts = {}) {
	const posProfile = opts.posProfile || {};
	const taxConfig = opts.taxConfig || null;
	const printConfig = opts.printConfig || {};
	const precision = printConfig.currency_precision || 2;

	const items = (invoice.items || []).map((it) => ({
		item_code: it.item_code || "",
		item_name: it.item_name || it.item_code || "",
		qty: flt(it.qty),
		uom: it.uom || "",
		rate: flt(it.rate),
		amount:
			it.amount != null ? flt(it.amount) : flt(flt(it.qty) * flt(it.rate), precision),
	}));

	// Sum of item amounts BEFORE discount — the cart's own `total`/`net_total`
	// fields are already post-discount by the time they're on the invoice
	// object, which is not what the template's "Subtotal" line means.
	const total = flt(
		items.reduce((sum, it) => sum + it.amount, 0),
		precision,
	);
	const discountAmount = flt(invoice.discount_amount || invoice.additional_discount_amount || 0);

	const taxLines = items.map((it, idx) => ({
		net: it.amount,
		item_tax_template: (invoice.items?.[idx] || {}).item_tax_template || null,
	}));
	const inclusive = !!(invoice.inclusive_tax ?? posProfile.posa_tax_inclusive);
	const netTotalBase = flt(total - discountAmount, precision);

	let taxes = [];
	let net_total = netTotalBase;
	let total_taxes_and_charges = 0;
	let grand_total = netTotalBase;

	if (Array.isArray(invoice.taxes) && invoice.taxes.length) {
		// Prefer taxes already computed onto the invoice (checkout already
		// ran computeOfflineTax as the cart was built, live server tax
		// online, or these are the real synced-invoice tax rows) — this is
		// exactly what the cashier and customer already saw on screen, so
		// a reprint must match it rather than recompute and risk drifting
		// from the amount actually charged.
		taxes = invoice.taxes.map((t) => ({
			account_head: t.account_head,
			description: t.description || t.account_head,
			rate: flt(t.rate),
			tax_amount: flt(t.tax_amount, precision),
		}));
		total_taxes_and_charges = flt(
			taxes.reduce((sum, t) => sum + t.tax_amount, 0),
			precision,
		);
		net_total = flt(invoice.net_total ?? netTotalBase, precision);
		grand_total = flt(invoice.grand_total ?? netTotalBase + total_taxes_and_charges, precision);
	} else if (taxConfig) {
		// No tax rows on the invoice yet (e.g. reprinting from a payload
		// saved before checkout finished computing them) — fall back to
		// estimating from the cached tax config rather than printing a
		// receipt with no tax lines at all.
		const result = computeOfflineTax(taxLines, taxConfig, {
			inclusive,
			netTotal: netTotalBase,
			precision,
		});
		taxes = result.taxes;
		net_total = result.net_total;
		total_taxes_and_charges = result.total_taxes_and_charges;
		grand_total = result.grand_total;
	}

	const rounded_total = flt(invoice.rounded_total || grand_total, precision);

	const payments = (invoice.payments || [])
		.filter((p) => flt(p.amount))
		.map((p) => ({ mode_of_payment: p.mode_of_payment, amount: flt(p.amount, precision) }));
	const paidTotal = flt(
		payments.reduce((sum, p) => sum + p.amount, 0),
		precision,
	);
	const change_amount = Math.max(0, flt(paidTotal - rounded_total, precision));

	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");

	return {
		name: invoice.name,
		posting_date: invoice.posting_date || datetime.now_date(),
		// Sale date, print time — deliberately the moment this receipt is
		// actually being rendered, not necessarily the moment of sale (a
		// reprint minutes/hours later should show when it was reprinted).
		posting_time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
		company: invoice.company || posProfile.company || printConfig.company || "",
		tax_id: invoice.tax_id || posProfile.tax_id || "",
		company_address_display: printConfig.company_address_display || "",
		owner: invoice.owner || currentCashier(),
		customer: invoice.customer || "",
		customer_name: invoice.customer_name || invoice.customer || "",
		contact_mobile: invoice.contact_mobile || invoice.customer_mobile || "",
		currency: invoice.currency || posProfile.currency || printConfig.currency || "",
		is_return: !!invoice.is_return,
		select_print_heading: invoice.select_print_heading || posProfile.select_print_heading || "",
		items,
		total,
		discount_amount: discountAmount,
		taxes,
		net_total,
		total_taxes_and_charges,
		grand_total,
		rounded_total,
		payments,
		change_amount,
		pospire_pending_sync: opts.pendingSync !== false,
	};
}
