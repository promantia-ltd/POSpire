/**
 * Builds and sends invoices straight to the server AS a cashier (their own
 * session), mirroring what the POS screen sends: update_invoice to create the
 * draft, then submit_invoice with the tendered payment on the invoice and the
 * change details in `data`. Used where a scenario needs exact, repeatable
 * control (races on returns and coupons) that clicking through the screen
 * cannot give.
 */

import { randomUUID } from "node:crypto";
import { type Actor } from "../fixtures/actors";
import { callAs, type AsUserResult } from "./as-user";

export interface InvoiceOptions {
	company: string;
	posProfile: string;
	customer?: string;
	shift: string;
	items: { item_code: string; qty: number; rate: number }[];
	/** Set for a return: the original invoice name. Item quantities must then be negative. */
	returnAgainst?: string;
	/** Coupon rows exactly as the screen attaches them (applied: 1 is what counts as a redemption). */
	coupons?: { coupon: string; coupon_code: string; pos_offer: string; customer?: string }[];
}

export function buildInvoice(o: InvoiceOptions): Record<string, unknown> {
	return {
		doctype: "Sales Invoice",
		is_pos: 1,
		ignore_pricing_rule: 1,
		company: o.company,
		pos_profile: o.posProfile,
		customer: o.customer,
		currency: "INR",
		posting_date: new Date().toISOString().slice(0, 10),
		posa_pos_opening_shift: o.shift,
		is_return: o.returnAgainst ? 1 : 0,
		return_against: o.returnAgainst,
		items: o.items.map((i) => ({ ...i, uom: "Nos", conversion_factor: 1 })),
		posa_coupons: (o.coupons ?? []).map((c) => ({ ...c, type: "Promotional", applied: 1 })),
	};
}

export async function createDraft(actor: Actor, invoice: Record<string, unknown>) {
	const res = await callAs(actor, "pospire.pospire.api.posapp.update_invoice", { data: JSON.stringify(invoice) });
	return { res, doc: res.status === 200 ? (res.json?.message as Record<string, any>) : null };
}

const CHANGE_DATA = {
	total_change: 0,
	paid_change: 0,
	credit_change: 0,
	redeemed_customer_credit: 0,
	customer_credit_dict: [],
	is_cashback: true,
};

/** Submit a draft with a cash payment of `cashAmount` (negative for a return, or omit to let the server fill a return's payment). */
export function submitDraft(
	actor: Actor,
	draft: Record<string, any>,
	opts: { cashAmount?: number; offlineId?: string } = {},
): Promise<AsUserResult> {
	const invoice = { ...draft };
	if (opts.cashAmount !== undefined) invoice.payments = [{ mode_of_payment: "Cash", amount: opts.cashAmount }];
	return callAs(actor, "pospire.pospire.api.posapp.submit_invoice", {
		invoice,
		data: JSON.stringify(CHANGE_DATA),
		offline_id: opts.offlineId ?? randomUUID(),
	});
}
