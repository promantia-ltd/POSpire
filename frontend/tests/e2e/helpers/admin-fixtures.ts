/**
 * Test FIXTURES that use the admin API key to put the site into a known state
 * before a scenario (restock a unit, create a one-use coupon) and to remove the
 * test's own leftover drafts afterwards. They go through ordinary documents
 * (Stock Entry, POS Coupon, Sales Invoice draft delete), never raw ledger
 * edits, and are kept apart from the assertions so the thing under test is
 * never changed by the measuring code.
 */

import { type APIRequestContext } from "@playwright/test";
import { binQty } from "./backend";

async function post(admin: APIRequestContext, method: string, data: Record<string, unknown>) {
	const res = await admin.post(`/api/method/${method}`, { data });
	if (!res.ok()) throw new Error(`${method} failed: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
	return (await res.json()).message;
}

/**
 * Bring an item's on-hand quantity UP to `qty` with a Material Receipt. Returns
 * what was there and what was added. Never reduces stock.
 */
export async function ensureStock(
	admin: APIRequestContext,
	opts: { company: string; item: string; warehouse: string; qty: number; rate: number },
) {
	const before = await binQty(admin, opts.item, opts.warehouse);
	const missing = opts.qty - before;
	if (missing <= 0) return { before, added: 0 };

	const doc = await post(admin, "frappe.client.insert", {
		doc: {
			doctype: "Stock Entry",
			stock_entry_type: "Material Receipt",
			company: opts.company,
			items: [{ item_code: opts.item, t_warehouse: opts.warehouse, qty: missing, basic_rate: opts.rate }],
		},
	});
	await post(admin, "frappe.client.submit", { doc });
	return { before, added: missing };
}

/** A fresh coupon limited to `maximumUse` redemptions, unique per run. Returns its document name. */
export async function createCoupon(
	admin: APIRequestContext,
	opts: { code: string; offer: string; company: string; maximumUse: number },
): Promise<string> {
	const today = new Date();
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	const inAYear = new Date(today.getTime() + 365 * 24 * 3600 * 1000);
	const doc = await post(admin, "frappe.client.insert", {
		doc: {
			doctype: "POS Coupon",
			coupon_name: opts.code,
			coupon_type: "Promotional",
			coupon_code: opts.code,
			pos_offer: opts.offer,
			company: opts.company,
			valid_from: iso(today),
			valid_upto: iso(inAYear),
			maximum_use: opts.maximumUse,
		},
	});
	return doc.name as string;
}

/** Delete draft invoices a test created (a refused submit leaves its draft behind). Submitted ones are never touched. */
export async function deleteDrafts(admin: APIRequestContext, names: string[]): Promise<string[]> {
	const removed: string[] = [];
	for (const name of names) {
		const res = await admin.get("/api/method/frappe.client.get_value", {
			params: { doctype: "Sales Invoice", filters: JSON.stringify({ name }), fieldname: JSON.stringify(["docstatus"]) },
		});
		if (!res.ok()) continue;
		const docstatus = (await res.json()).message?.docstatus;
		if (docstatus !== 0) continue; // only ever delete drafts
		const del = await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name } });
		if (del.ok()) removed.push(name);
	}
	return removed;
}
