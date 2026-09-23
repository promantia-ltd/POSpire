/**
 * Contributions repo — one row per invoice, keyed by the invoice's
 * `offline_id` (the same id on the live and queued submit paths).
 *
 * Only `by_mop` is encrypted: it is per-invoice money. Everything else is a
 * plaintext scalar so the ledger can query and transition rows without
 * decrypting anything.
 *
 * ENCRYPTION IS NEVER PERFORMED INSIDE A DEXIE TRANSACTION. Awaiting
 * `crypto.subtle` inside one lets IndexedDB auto-commit early and the call
 * throws `PrematureCommitError` — this silently disabled a whole feature in
 * Phase 1. `buildStoredContribution` encrypts outside; the transactional
 * helpers only ever touch plaintext scalars and pre-built stored rows.
 */

import { assertWritable, db, runInTransaction } from "../db";
import { decrypt, encrypt, getActiveKey } from "../crypto";
import { isOfflineEnabledSync, OfflineDisabledError } from "../kill-switch";
import type {
	ContributionRow,
	EncryptedEnvelope,
	StoredContributionRow,
} from "../types";

function aadForContribution(offlineId: string): string {
	return `contribution:${offlineId}:by_mop`;
}

/** Encrypt a contribution into its stored form. Call OUTSIDE any transaction. */
export async function buildStoredContribution(
	row: ContributionRow,
): Promise<StoredContributionRow> {
	const { key, id } = getActiveKey();
	const envelope: EncryptedEnvelope = await encrypt(
		row.by_mop,
		key,
		id,
		aadForContribution(row.offline_id),
	);
	return {
		offline_id: row.offline_id,
		shift_lifecycle_id: row.shift_lifecycle_id,
		status: row.status,
		by_mop_envelope: envelope,
		created_at: row.created_at,
		confirmed_at: row.confirmed_at,
	};
}

async function fromStored(
	stored: StoredContributionRow,
): Promise<ContributionRow> {
	const by_mop = await decrypt<Record<string, number>>(
		stored.by_mop_envelope,
		aadForContribution(stored.offline_id),
	);
	return {
		offline_id: stored.offline_id,
		shift_lifecycle_id: stored.shift_lifecycle_id,
		status: stored.status,
		by_mop,
		created_at: stored.created_at,
		confirmed_at: stored.confirmed_at,
	};
}

/**
 * Write a pre-encrypted row. Upsert: re-staging the same invoice overwrites.
 *
 * Gated on the offline kill switch as well as safe mode, matching
 * `outbox.enqueue`. With offline admin-disabled the device must not be
 * accumulating encrypted per-invoice money rows on disk: the close dialog will
 * never source from them (the server owns the figure) and nothing would prune
 * them. Throws `OfflineDisabledError`; the sale path treats that like any other
 * staging failure — warn and continue.
 *
 * The SYNCHRONOUS read, deliberately, not `assertOfflineEnabled()`. This runs on
 * the critical path of EVERY sale, and the async path re-fetches from the server
 * whenever its 60s cache is stale — which during normal ONLINE selling is about
 * once a minute, because the drain loop that would otherwise keep the cache warm
 * idles when the outbox is empty. That round trip sits inside the caller's 2s
 * staging deadline: exceed it on a congested link and the contribution is
 * skipped, while the sale itself succeeded online and so leaves no outbox row
 * either — the amount would then be missing from the total, from the gap count
 * and from the uncertainty count, with the banner still claiming "ledger".
 * Silent understatement, which is the exact failure class this ledger exists to
 * remove. The fetch buys nothing here anyway: `fetchKillSwitch` never treats an
 * error or a missing value as "disabled", so a stale-but-true reading and a
 * fresh one differ only in latency.
 */
export async function putContribution(
	stored: StoredContributionRow,
): Promise<void> {
	assertWritable();
	if (!isOfflineEnabledSync()) {
		// `assertOfflineEnabled` logs "blocking enqueue" — wrong noun for a
		// ledger write, and it would report `outboxType: null`. Say what this
		// actually is so the console points at the right subsystem.
		console.warn(
			"[contributions] offline disabled by administrator; refusing contribution write",
			{ offline_id: stored.offline_id },
		);
		throw new OfflineDisabledError("invoice");
	}
	await db.contributions.put(stored);
}

/**
 * The stored row, WITHOUT decrypting `by_mop`.
 *
 * For callers that only need the plaintext scalars (`status`, `created_at`,
 * `confirmed_at`). Decrypting where the plaintext is never read is not merely
 * wasteful — it converts a corrupt envelope into a thrown error on a path that
 * had no business touching the ciphertext. `stageContribution` is exactly that
 * case: it reads only the scalars, and it must be able to overwrite a corrupt
 * row with a fresh one rather than being blocked by it. The shift-scoped list
 * helpers below are the only readers that decrypt `by_mop`.
 */
export async function getStoredContribution(
	offlineId: string,
): Promise<StoredContributionRow | undefined> {
	return db.contributions.get(offlineId);
}

export interface ContributionListing {
	rows: ContributionRow[];
	/**
	 * Rows whose envelope would not decrypt. Their money is MISSING from
	 * `rows`, so callers must surface this rather than presenting the sum as
	 * fact — a shift with a good 10 and a corrupt 99 derives 10, and a clean
	 * -looking short number is exactly what a cashier signs off on by mistake.
	 */
	skippedCount: number;
}

/**
 * All contributions for a shift, decrypted row-by-row.
 *
 * A row whose envelope will not decrypt is SKIPPED and logged, not thrown.
 * One corrupt row must cost only its own contribution — an all-or-nothing
 * failure here would silently zero the cashier's expected amount — but it is
 * counted so the total can be labelled uncertain.
 */
export async function listContributionsForShift(
	shiftLifecycleId: string,
): Promise<ContributionListing> {
	const stored = await db.contributions
		.where("shift_lifecycle_id")
		.equals(shiftLifecycleId)
		.toArray();
	const rows: ContributionRow[] = [];
	let skippedCount = 0;
	for (const row of stored) {
		try {
			rows.push(await fromStored(row));
		} catch (err) {
			skippedCount += 1;
			console.warn(
				`[contributions] skipping undecryptable row ${row.offline_id}`,
				err,
			);
		}
	}
	return { rows, skippedCount };
}

/**
 * Pending rows for ONE shift — the startup reconciliation's input.
 *
 * Scoped to a shift rather than global because the oracle it feeds
 * (`get_shift_invoice_offline_ids`) is itself scoped to one opening: a pending
 * row belonging to an earlier shift could never appear in that answer, so a
 * global query would re-ask about it at every startup forever and report it as
 * this shift's unconfirmed money.
 *
 * Queried on the `shift_lifecycle_id` index and filtered on `status` in memory
 * — the schema has no compound index, and a shift's row count is small.
 */
export async function listPendingContributionsForShift(
	shiftLifecycleId: string,
): Promise<ContributionRow[]> {
	const stored = (
		await db.contributions
			.where("shift_lifecycle_id")
			.equals(shiftLifecycleId)
			.toArray()
	).filter((row) => row.status === "pending");
	const out: ContributionRow[] = [];
	for (const row of stored) {
		try {
			out.push(await fromStored(row));
		} catch (err) {
			console.warn(
				`[contributions] skipping undecryptable pending row ${row.offline_id}`,
				err,
			);
		}
	}
	return out;
}

/**
 * Flip a row to confirmed. Touches plaintext scalars only — the envelope is
 * carried across untouched, so no crypto runs and the transaction is safe.
 */
export async function markContributionConfirmed(
	offlineId: string,
	confirmedAt: number,
): Promise<void> {
	assertWritable();
	await runInTransaction("rw", [db.contributions], async () => {
		const existing = await db.contributions.get(offlineId);
		if (!existing) return;
		await db.contributions.put({
			...existing,
			status: "confirmed",
			confirmed_at: confirmedAt,
		});
	});
}

/**
 * Drop a single staged contribution. For un-staging a sale that never landed
 * (a 4xx validation error, a deferred return, or any other failure exit after
 * `stageContribution` ran) — the row must not survive to be summed by
 * `deriveExpectedByMop`. Bare delete: no crypto, no transaction, since the
 * row (envelope and all) is simply gone afterward.
 */
export async function deleteContribution(offlineId: string): Promise<void> {
	assertWritable();
	await db.contributions.delete(offlineId);
}

/** Drop a shift's contributions once they are no longer needed. */
export async function deleteContributionsForShift(
	shiftLifecycleId: string,
): Promise<number> {
	assertWritable();
	return db.contributions
		.where("shift_lifecycle_id")
		.equals(shiftLifecycleId)
		.delete();
}
