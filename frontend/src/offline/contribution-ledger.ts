/**
 * Contribution ledger.
 *
 * One row per invoice, keyed by the invoice's `offline_id`. Written on BOTH
 * submit paths: `call()` injects that same id into the live request args
 * (call.ts) and the live endpoint persists it (posapp.py), so an online sale
 * and an offline one are recorded identically.
 *
 * The shift total is DERIVED by recomputing over unique contributions, never
 * accumulated. A crash between staging and confirming leaves a recoverable
 * `pending` row; a retry overwrites its own row rather than adding a second.
 * That is what makes this safe for a figure a cashier signs off.
 */

import {
	buildStoredContribution,
	deleteContribution,
	deleteContributionsForShift,
	getStoredContribution,
	listContributionsForShift,
	listPendingContributionsForShift,
	markContributionConfirmed,
	putContribution,
} from "./repos/contributions";
import { contributionForInvoice } from "./shift-lifecycle";
import type { ContributionRow } from "./types";

export interface ContributionInput {
	invoiceOfflineId: string;
	shiftLifecycleId: string;
	/** The invoice doc as it will be submitted. */
	invoice: Record<string, unknown>;
	cashMode: string;
	precision: number;
}

/**
 * Record an invoice's contribution as `pending`, BEFORE the submit is
 * attempted. Overwrites any existing row for the same invoice, so a retry is
 * idempotent by construction.
 */
export async function stageContribution(
	input: ContributionInput,
): Promise<void> {
	const byMop = contributionForInvoice(
		input.invoice,
		input.cashMode,
		input.precision,
	);
	// The STORED row, deliberately not decrypted: only the plaintext scalars
	// below are read. Decrypting here would make an unreadable envelope throw
	// on the one path that can repair it — the `put` below overwrites the
	// corrupt row with a fresh, readable one — and because staging happens
	// BEFORE the submit, that throw would hard-block the sale itself.
	const existing = await getStoredContribution(input.invoiceOfflineId);
	const row: ContributionRow = {
		offline_id: input.invoiceOfflineId,
		shift_lifecycle_id: input.shiftLifecycleId,
		// A re-stage of an already-confirmed invoice keeps its confirmed
		// status — the money landed, and demoting it would make the startup
		// reconciliation re-ask the server about a settled sale.
		status: existing?.status === "confirmed" ? "confirmed" : "pending",
		by_mop: byMop,
		created_at: existing?.created_at ?? Date.now(),
		confirmed_at: existing?.confirmed_at ?? null,
	};
	// Encrypt OUTSIDE any transaction. See repos/contributions.ts.
	const stored = await buildStoredContribution(row);
	await putContribution(stored);
}

/** Mark a staged contribution as landed. Safe to call more than once. */
export async function confirmContribution(
	invoiceOfflineId: string,
): Promise<void> {
	await markContributionConfirmed(invoiceOfflineId, Date.now());
}

/**
 * Un-stage a contribution for a sale that never landed. `deriveExpectedByMop`
 * sums pending rows into the shift total (deliberately — cash physically
 * taken counts even before sync), so a row staged ahead of a submit that then
 * failed (4xx validation, a deferred return, any other error exit) would
 * overstate the figure the cashier signs off on forever: reconciliation only
 * ever confirms rows the server has, it never removes ones it doesn't. Call
 * this on every failure exit after `stageContribution` ran. Safe to call on a
 * row that was never staged (or already removed) — deleting a missing key is
 * a no-op.
 */
export async function discardContribution(
	invoiceOfflineId: string,
): Promise<void> {
	await deleteContribution(invoiceOfflineId);
}

export interface DerivedExpected {
	byMop: Record<string, number>;
	/** Contributions still unconfirmed — surfaced so the UI can say so. */
	pendingCount: number;
	/**
	 * Rows whose envelope would not decrypt. Their money is NOT in `byMop`, so
	 * the caller must fold this into whatever uncertainty it shows: otherwise
	 * a corrupt row silently shortens a figure that reads as fact.
	 */
	skippedCount: number;
	/**
	 * The invoice `offline_id` of every row that DID contribute. Lets a caller
	 * union this total with the outbox scan without double-counting: both
	 * stores key on the same id.
	 */
	offlineIds: string[];
}

/**
 * Recompute the shift's contribution total from its rows.
 *
 * Pending rows ARE included: the cash was physically taken whether or not the
 * record reached the server, so excluding it would show the cashier a
 * shortfall that is not in the drawer. `pendingCount` lets the UI qualify it.
 */
export async function deriveExpectedByMop(
	shiftLifecycleId: string,
	precision: number,
): Promise<DerivedExpected> {
	const { rows, skippedCount } =
		await listContributionsForShift(shiftLifecycleId);
	const byMop: Record<string, number> = {};
	const offlineIds: string[] = [];
	let pendingCount = 0;
	const f = 10 ** precision;
	for (const row of rows) {
		offlineIds.push(row.offline_id);
		if (row.status === "pending") pendingCount += 1;
		for (const [mop, amount] of Object.entries(row.by_mop)) {
			const next = (byMop[mop] ?? 0) + (Number(amount) || 0);
			byMop[mop] = Math.round(next * f) / f;
		}
	}
	return { byMop, pendingCount, skippedCount, offlineIds };
}

/**
 * Confirm any pending contribution whose invoice the server reports as
 * submitted. Runs at startup, after a crash between stage and confirm.
 *
 * The oracle is `offline.get_shift_invoice_offline_ids`, which returns
 * `pos_offline_id` for every submitted Sales Invoice on the shift — and both
 * submit paths persist that id, so it covers live and queued sales alike.
 *
 * Both the input and the result are scoped to `shiftLifecycleId`, because the
 * oracle is scoped to one opening: rows from another shift can never appear in
 * its answer, so including them would strand them in `stillPending` at every
 * startup and misreport them as this shift's unconfirmed money.
 */
export async function reconcilePendingContributions(opts: {
	shiftLifecycleId: string;
	openingServerName: string | null;
	openingOfflineId: string | null;
}): Promise<{ confirmed: string[]; stillPending: string[] }> {
	const pending = await listPendingContributionsForShift(opts.shiftLifecycleId);
	if (!pending.length) return { confirmed: [], stillPending: [] };
	if (!opts.openingServerName && !opts.openingOfflineId) {
		return { confirmed: [], stillPending: pending.map((r) => r.offline_id) };
	}

	let submitted: string[] = [];
	try {
		const { call } = await import("@/utils/call");
		const result = await call<string[]>({
			method: "pospire.pospire.api.offline.get_shift_invoice_offline_ids",
			args: {
				opening_shift_name: opts.openingServerName,
				opening_shift_offline_id: opts.openingOfflineId,
			},
			intent: "read",
		});
		if (Array.isArray(result)) submitted = result.filter(Boolean);
	} catch (err) {
		// Offline, or the endpoint is unreachable. Everything stays pending —
		// that is the safe direction: the amounts still count toward the
		// displayed total, they are just flagged unconfirmed.
		console.warn("[contribution-ledger] reconciliation unavailable", err);
		return { confirmed: [], stillPending: pending.map((r) => r.offline_id) };
	}

	const landed = new Set(submitted);
	const confirmed: string[] = [];
	const stillPending: string[] = [];
	for (const row of pending) {
		if (landed.has(row.offline_id)) {
			await confirmContribution(row.offline_id);
			confirmed.push(row.offline_id);
		} else {
			stillPending.push(row.offline_id);
		}
	}
	return { confirmed, stillPending };
}

/** Re-export so callers never reach past this module into the repo. */
export { deleteContributionsForShift };
