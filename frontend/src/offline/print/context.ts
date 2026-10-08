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
import { provisionalNameFor } from "@/offline/outbox";

export function buildPrintContext(invoice, opts = {}) {
	const posProfile = opts.posProfile || {};
	const taxConfig = opts.taxConfig || null;
	const printConfig = opts.printConfig || {};
	// Prefer the precision actually used at checkout (stamped onto the
	// invoice by Invoice.vue::get_invoice_doc from bootinfo's
	// sys_defaults) over the print config's own (System Settings, fetched
	// via a different call at a different time) — the two are normally the
	// same value but can drift, and a reprint must match what the cashier
	// and customer already saw, not whatever's cached now.
	const precision = invoice.currency_precision ?? printConfig.currency_precision ?? 2;

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
	// Invoice.vue adds this on top of the tax result at checkout (grand =
	// offlineTax.grand_total + delivery) — untaxed, outside the taxable
	// base, so it must be added back the same way here or the recomputed
	// branches below understate the total by exactly this amount.
	const deliveryCharge = flt(
		invoice.custom_delivery_charge_rate || invoice.posa_delivery_charges_rate || 0,
		precision,
	);

	let taxes = [];
	let net_total = netTotalBase;
	let total_taxes_and_charges = 0;
	let grand_total = netTotalBase;
	// Defaults to the invoice's own value (set at checkout, before this
	// module ever runs) unless a branch below overrides it — see the
	// taxConfig branch, which must not mix a value computed here with one
	// computed by a different code path.
	let rounded_total = flt(invoice.rounded_total || netTotalBase + deliveryCharge, precision);
	// True whenever none of the branches below could produce a real tax
	// breakdown (no cached config at sale time, or a charge type this
	// module doesn't support) — the amount charged is still correct
	// (inclusive pricing already contains the tax; exclusive is blocked at
	// Pay by show_payment's guard), only the printed line-item breakdown
	// is missing. Exposed so a template can flag it instead of silently
	// looking like a tax-free sale.
	let tax_unavailable = false;

	// Untaxed fallback shared by both "couldn't compute" cases below —
	// same numbers show_payment's blocked-Pay case already relies on.
	const applyUntaxedFallback = () => {
		net_total = netTotalBase;
		total_taxes_and_charges = 0;
		grand_total = flt(netTotalBase + deliveryCharge, precision);
		rounded_total = grand_total;
		tax_unavailable = true;
	};

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
			taxable_amount: flt(t.taxable_amount ?? invoice.net_total ?? netTotalBase, precision),
		}));
		total_taxes_and_charges = flt(
			taxes.reduce((sum, t) => sum + t.tax_amount, 0),
			precision,
		);
		net_total = flt(invoice.net_total ?? netTotalBase, precision);
		grand_total = flt(invoice.grand_total ?? netTotalBase + total_taxes_and_charges, precision);
		rounded_total = flt(invoice.rounded_total || grand_total, precision);
	} else if (invoice.pospire_print_tax_snapshot) {
		// Stamped at submit time by Invoice.vue::get_invoice_doc — exactly
		// what compute_offline_taxes() produced when the sale was made.
		// Preferred over a fresh taxConfig recompute below so a reprint
		// can't drift from what was actually charged (e.g. an admin
		// changing a tax rate between the sale and a later reprint).
		const snap = invoice.pospire_print_tax_snapshot;
		if (snap.supported) {
			taxes = (snap.taxes || []).map((t) => ({
				account_head: t.account_head,
				description: t.description || t.account_head,
				rate: flt(t.rate),
				tax_amount: flt(t.tax_amount, precision),
				taxable_amount: flt(t.taxable_amount, precision),
			}));
			net_total = flt(snap.net_total, precision);
			total_taxes_and_charges = flt(snap.total_taxes_and_charges, precision);
			grand_total = flt(snap.grand_total + deliveryCharge, precision);
			rounded_total = grand_total;
		} else {
			applyUntaxedFallback();
		}
	} else if (taxConfig) {
		// No tax rows and no stamped snapshot on the invoice (e.g.
		// reprinting from an outbox payload saved before this snapshot
		// existed) — fall back to estimating from the currently cached tax
		// config rather than printing a receipt with no tax lines at all.
		//
		// grand_total AND rounded_total both come from THIS SAME result
		// (plus deliveryCharge, added back on top exactly like Invoice.vue
		// does at checkout) — never from invoice.rounded_total. Mixing a
		// total computed here with one computed by a different code path
		// (e.g. the cart's own running total at checkout) is exactly how
		// the two numbers on the receipt end up disagreeing.
		const result = computeOfflineTax(taxLines, taxConfig, {
			inclusive,
			netTotal: netTotalBase,
			precision,
		});
		if (result.supported) {
			taxes = result.taxes;
			net_total = result.net_total;
			total_taxes_and_charges = result.total_taxes_and_charges;
			grand_total = flt(result.grand_total + deliveryCharge, precision);
			rounded_total = grand_total;
		} else {
			applyUntaxedFallback();
		}
	} else {
		tax_unavailable = true;
	}

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
		// A reprint's `invoice` is the outbox payload saved BEFORE
		// Payments.vue assigns the provisional name, so invoice.name is
		// stale or empty in that case — opts.offlineId is the signal this
		// is a reprint, and provisionalNameFor() derives the same
		// OFFLINE-INV-... the cashier saw at time of sale.
		name: opts.offlineId ? provisionalNameFor("invoice", opts.offlineId) : invoice.name,
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
		tax_unavailable,
	};
}
