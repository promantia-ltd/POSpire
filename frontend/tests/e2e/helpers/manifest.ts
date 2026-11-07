
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Lifecycle states the ticket requires counting separately. */
export type TxnState =
	| "attempted" // the cashier started the sale
	| "accepted" // the UI acknowledged it (locally or by the server)
	| "submitted" // confirmed as a submitted server invoice
	| "rejected"
	| "retrying"
	| "needs_review"
	| "resolved"; // voided / manually resolved

export interface ExpectedLine {
	item_code: string;
	qty: number;
	rate: number;
}

export interface ExpectedSale {
	txnId: string;
	runId: string;
	cashier: string; // user email the sale must be attributed to
	company: string;
	posProfile: string;
	warehouse: string;
	customer?: string;
	items: ExpectedLine[];
	payments: { mode_of_payment: string; amount: number }[];
	/** Independently computed, not read back from the server. */
	expectedGrandTotal?: number;
	/** Server name of the opening shift this sale must belong to, once known. */
	openingShift?: string;
	/** Filled in once the server document is known. */
	invoice?: string;
	offlineId?: string;
	state: TxnState;
}

export const RUN_ID = process.env.PERF_RUN_ID ?? `run-${Date.now().toString(36)}`;

let counter = 0;
export function newTxnId(prefix = "txn"): string {
	counter += 1;
	return `${RUN_ID}-${prefix}-${String(counter).padStart(4, "0")}`;
}

export class Manifest {
	private sales = new Map<string, ExpectedSale>();

	constructor(readonly runId: string = RUN_ID) {}

	add(sale: Omit<ExpectedSale, "runId" | "state"> & Partial<Pick<ExpectedSale, "state">>): ExpectedSale {
		const full: ExpectedSale = { ...sale, runId: this.runId, state: sale.state ?? "attempted" };
		this.sales.set(full.txnId, full);
		return full;
	}

	update(txnId: string, patch: Partial<ExpectedSale>): ExpectedSale {
		const current = this.sales.get(txnId);
		if (!current) throw new Error(`Unknown txn ${txnId}`);
		const next = { ...current, ...patch };
		this.sales.set(txnId, next);
		return next;
	}

	all(): ExpectedSale[] {
		return [...this.sales.values()];
	}

	/** Counts per lifecycle state, always listing every state so zeros are visible. */
	summary(): Record<TxnState, number> {
		const out: Record<TxnState, number> = {
			attempted: 0,
			accepted: 0,
			submitted: 0,
			rejected: 0,
			retrying: 0,
			needs_review: 0,
			resolved: 0,
		};
		for (const s of this.sales.values()) out[s.state] += 1;
		return out;
	}

	save(dir = path.resolve("perf-results", "manifests")): string {
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${this.runId}.json`);
		writeFileSync(file, JSON.stringify({ runId: this.runId, sales: this.all() }, null, 2));
		return file;
	}
}
