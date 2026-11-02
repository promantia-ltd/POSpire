/**
 * Backend reconciliation: compares the independent manifest (manifest.ts)
 * against what the server actually holds. Read-only.
 *
 * The pure comparison (compareInvoice, compareStock) is separate from the I/O
 * so it can be unit-tested with synthetic documents and reused unchanged by
 * every scenario. Per the ticket, a cleared queue is never evidence of
 * success: only a submitted server document that matches the manifest is.
 */

import { type APIRequestContext } from "@playwright/test";
import { binQty, getDoc, getList } from "./backend";
import { type ExpectedSale, type Manifest, type TxnState } from "./manifest";

const MONEY_TOLERANCE = 0.01; // configured INR currency precision is 2 dp

export function near(a: number, b: number, tol = MONEY_TOLERANCE): boolean {
	return Math.abs(a - b) <= tol;
}

export interface Issue {
	field: string;
	expected: unknown;
	actual: unknown;
}

/** Minimal shape of a Sales Invoice document as returned by frappe.client.get. */
export interface InvoiceDoc {
	name: string;
	docstatus: number;
	owner: string;
	company: string;
	pos_profile?: string;
	customer?: string;
	is_return?: number;
	grand_total?: number;
	rounded_total?: number;
	change_amount?: number;
	posa_pos_opening_shift?: string;
	pos_offline_id?: string;
	items?: { item_code: string; qty: number; rate: number; warehouse?: string }[];
	payments?: { mode_of_payment: string; amount: number }[];
}

/** Pure: every way `inv` differs from what the sale was supposed to produce. */
export function compareInvoice(sale: ExpectedSale, inv: InvoiceDoc): Issue[] {
	const issues: Issue[] = [];
	const check = (field: string, expected: unknown, actual: unknown, ok = expected === actual) => {
		if (!ok) issues.push({ field, expected, actual });
	};

	check("docstatus", 1, inv.docstatus);
	check("is_return", 0, inv.is_return ?? 0);
	check("owner (cashier attribution)", sale.cashier, inv.owner);
	check("company", sale.company, inv.company);
	check("pos_profile", sale.posProfile, inv.pos_profile);
	if (sale.customer) check("customer", sale.customer, inv.customer);
	if (sale.openingShift) {
		check("opening shift", sale.openingShift, inv.posa_pos_opening_shift);
	}

	// Items: compare per item_code (quantities summed, every row at the expected rate).
	const expectedQty = new Map<string, number>();
	for (const l of sale.items) expectedQty.set(l.item_code, (expectedQty.get(l.item_code) ?? 0) + l.qty);
	const actualQty = new Map<string, number>();
	for (const row of inv.items ?? []) {
		actualQty.set(row.item_code, (actualQty.get(row.item_code) ?? 0) + row.qty);
		check(`warehouse of ${row.item_code}`, sale.warehouse, row.warehouse);
		const line = sale.items.find((l) => l.item_code === row.item_code);
		if (line) check(`rate of ${row.item_code}`, line.rate, row.rate, near(line.rate, row.rate));
	}
	for (const code of new Set([...expectedQty.keys(), ...actualQty.keys()])) {
		check(`qty of ${code}`, expectedQty.get(code) ?? 0, actualQty.get(code) ?? 0);
	}

	// Payments: net of change given, and the set of modes used.
	const paid = (inv.payments ?? []).reduce((s, p) => s + p.amount, 0) - (inv.change_amount ?? 0);
	const expectedPaid = sale.payments.reduce((s, p) => s + p.amount, 0);
	check("net paid", expectedPaid, paid, near(expectedPaid, paid));
	const modes = (xs: { mode_of_payment: string }[]) => xs.map((p) => p.mode_of_payment).sort().join(",");
	check("payment modes", modes(sale.payments), modes(inv.payments ?? []));

	if (sale.expectedGrandTotal !== undefined) {
		const total = inv.rounded_total || inv.grand_total || 0;
		check("grand total", sale.expectedGrandTotal, total, near(sale.expectedGrandTotal, total));
	}
	return issues;
}

export interface StockKey {
	item: string;
	warehouse: string;
}
const keyOf = (k: StockKey) => `${k.item}|${k.warehouse}`;

/** Expected on-hand change per item/warehouse from sales that really submitted. */
export function expectedStockDeltas(sales: ExpectedSale[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const s of sales) {
		if (s.state !== "submitted") continue;
		for (const l of s.items) {
			const k = keyOf({ item: l.item_code, warehouse: s.warehouse });
			out.set(k, (out.get(k) ?? 0) - l.qty);
		}
	}
	return out;
}

/** Pure: compare before/after on-hand quantities with the expected deltas. */
export function compareStock(
	before: Map<string, number>,
	after: Map<string, number>,
	expected: Map<string, number>,
): Issue[] {
	const issues: Issue[] = [];
	for (const k of new Set([...before.keys(), ...after.keys(), ...expected.keys()])) {
		const delta = (after.get(k) ?? 0) - (before.get(k) ?? 0);
		const want = expected.get(k) ?? 0;
		if (!near(delta, want, 0.0001)) issues.push({ field: `stock ${k}`, expected: want, actual: delta });
	}
	return issues;
}

export async function snapshotBins(api: APIRequestContext, keys: StockKey[]): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (const k of keys) out.set(keyOf(k), await binQty(api, k.item, k.warehouse));
	return out;
}

/** Every distinct item/warehouse a manifest touches, to snapshot before a run. */
export function stockKeysOf(sales: ExpectedSale[]): StockKey[] {
	const seen = new Map<string, StockKey>();
	for (const s of sales) {
		for (const l of s.items) {
			const k = { item: l.item_code, warehouse: s.warehouse };
			seen.set(keyOf(k), k);
		}
	}
	return [...seen.values()];
}

/** GL entries for an invoice: present, and debits equal credits. */
export async function glCheck(api: APIRequestContext, invoice: string) {
	const rows = await getList<{ debit: number; credit: number }>(
		api,
		"GL Entry",
		{ voucher_type: "Sales Invoice", voucher_no: invoice, is_cancelled: 0 },
		["debit", "credit"],
	);
	const debit = rows.reduce((s, r) => s + r.debit, 0);
	const credit = rows.reduce((s, r) => s + r.credit, 0);
	return { count: rows.length, debit, credit, balanced: rows.length > 0 && near(debit, credit) };
}

export interface SaleResult {
	txnId: string;
	invoice?: string;
	issues: Issue[];
}

export interface ReconcileReport {
	ok: boolean;
	counts: Record<TxnState, number>;
	/** Accepted by the app but no server invoice found: a lost sale. */
	lost: string[];
	/** More than one server invoice for one logical sale (same offline id). */
	duplicates: { txnId: string; invoices: string[] }[];
	/** Two different sales resolved to the same server invoice. */
	collisions: { invoice: string; txnIds: string[] }[];
	mismatches: SaleResult[];
}

/**
 * Looks up every accepted/submitted sale on the server and compares it with
 * the manifest. Sales verified correct are marked "submitted"; nothing else
 * is changed, and nothing is written to the server.
 */
export async function reconcile(api: APIRequestContext, manifest: Manifest): Promise<ReconcileReport> {
	const lost: string[] = [];
	const duplicates: ReconcileReport["duplicates"] = [];
	const mismatches: SaleResult[] = [];
	const byInvoice = new Map<string, string[]>();

	for (const sale of manifest.all()) {
		if (sale.state !== "accepted" && sale.state !== "submitted") continue;

		let names: string[] = [];
		if (sale.invoice) {
			names = [sale.invoice];
		} else if (sale.offlineId) {
			const rows = await getList<{ name: string }>(
				api,
				"Sales Invoice",
				{ pos_offline_id: sale.offlineId },
				["name"],
			);
			names = rows.map((r) => r.name);
		}

		if (names.length === 0) {
			lost.push(sale.txnId);
			continue;
		}
		if (names.length > 1) {
			duplicates.push({ txnId: sale.txnId, invoices: names });
			continue;
		}

		const invoice = await getDoc<InvoiceDoc>(api, "Sales Invoice", names[0]);
		if (!invoice) {
			lost.push(sale.txnId);
			continue;
		}
		byInvoice.set(invoice.name, [...(byInvoice.get(invoice.name) ?? []), sale.txnId]);

		const issues = compareInvoice(sale, invoice);
		if (issues.length > 0) {
			mismatches.push({ txnId: sale.txnId, invoice: invoice.name, issues });
		} else {
			manifest.update(sale.txnId, { state: "submitted", invoice: invoice.name });
		}
	}

	const collisions = [...byInvoice.entries()]
		.filter(([, ids]) => ids.length > 1)
		.map(([invoice, txnIds]) => ({ invoice, txnIds }));

	return {
		ok: lost.length === 0 && duplicates.length === 0 && collisions.length === 0 && mismatches.length === 0,
		counts: manifest.summary(),
		lost,
		duplicates,
		collisions,
		mismatches,
	};
}
