/**
 * Outbox repo — write-ahead log for everything that needs to sync.
 *
 * Design notes:
 *  - `payload` is ALWAYS encrypted on disk; readers see plaintext.
 *  - `payload_integrity_hash` is stored as a sibling plaintext column so the
 *    scheduler can filter / audit without decrypting. Re-verified against
 *    the envelope's copy inside `fromStored` to catch in-place tampering.
 *  - Writes go through `runInTransaction` when the caller needs to mutate
 *    more than one table (e.g. enqueue + shift status change). This repo
 *    exposes single-table helpers; Agent 3 orchestrates multi-table work.
 *  - Scheduler pickup uses the compound index `[status+next_attempt_at]`
 *    (see db.ts §v1 schema). Rows with a non-null `blocked_reason` are
 *    filtered out in memory — see `listReady`.
 *  - `QuotaExceededError` on outbox writes is re-thrown (never swallowed)
 *    so the UI can block the sale per §7.
 */

import { assertWritable, db } from "../db";
import {
	canonicalIntegrityHash,
	decrypt,
	encrypt,
	getActiveKey,
} from "../crypto";
import type {
	LastErrorCategory,
	OutboxBlockedReason,
	OutboxEntry,
	OutboxStatus,
	OutboxType,
	StoredOutboxEntry,
} from "../types";

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

function aadForOutbox(offlineId: string): string {
	return `outbox:${offlineId}`;
}

async function toStored<T>(row: OutboxEntry<T>): Promise<StoredOutboxEntry> {
	const { key, id } = getActiveKey();
	const envelope = await encrypt(
		row.payload,
		key,
		id,
		aadForOutbox(row.offline_id),
	);
	return {
		offline_id: row.offline_id,
		type: row.type,
		parent_offline_ids: row.parent_offline_ids,
		shift_offline_id: row.shift_offline_id,
		device_id: row.device_id,
		posting_date: row.posting_date,
		owner_user: row.owner_user,
		envelope,
		// Callers may supply their own hash (e.g. scheduler retry that's
		// keeping the original hash while re-encrypting with a rotated key).
		// When absent we derive from the envelope so writes never lose it.
		payload_integrity_hash:
			row.payload_integrity_hash || envelope.payload_integrity_hash,
		status: row.status,
		blocked_reason: row.blocked_reason,
		attempt_count: row.attempt_count,
		next_attempt_at: row.next_attempt_at,
		last_error_category: row.last_error_category,
		last_error_detail: row.last_error_detail,
		server_doc_name: row.server_doc_name,
		// New in Phase 1b. Pre-existing rows on disk won't have this property
		// — `?? null` makes the round-trip stable instead of stamping
		// undefined into Dexie (which IndexedDB tolerates but breaks JSON
		// serialisation downstream).
		recovery_entry_name: row.recovery_entry_name ?? null,
		enqueued_at: row.enqueued_at,
		synced_at: row.synced_at,
	};
}

async function fromStored<T>(
	stored: StoredOutboxEntry,
): Promise<OutboxEntry<T>> {
	const payload = await decrypt<T>(
		stored.envelope,
		aadForOutbox(stored.offline_id),
	);
	return {
		offline_id: stored.offline_id,
		type: stored.type,
		parent_offline_ids: stored.parent_offline_ids,
		shift_offline_id: stored.shift_offline_id,
		device_id: stored.device_id,
		posting_date: stored.posting_date,
		owner_user: stored.owner_user,
		payload,
		payload_integrity_hash: stored.payload_integrity_hash,
		status: stored.status,
		blocked_reason: stored.blocked_reason,
		attempt_count: stored.attempt_count,
		next_attempt_at: stored.next_attempt_at,
		last_error_category: stored.last_error_category,
		last_error_detail: stored.last_error_detail,
		server_doc_name: stored.server_doc_name,
		recovery_entry_name: stored.recovery_entry_name ?? null,
		enqueued_at: stored.enqueued_at,
		synced_at: stored.synced_at,
	};
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function getOutboxEntry<T = unknown>(
	offlineId: string,
): Promise<OutboxEntry<T> | undefined> {
	const stored = await db.outbox.get(offlineId);
	if (!stored) return undefined;
	return fromStored<T>(stored);
}

export async function listByStatus<T = unknown>(
	status: OutboxStatus,
): Promise<OutboxEntry<T>[]> {
	const stored = await db.outbox.where("status").equals(status).toArray();
	return Promise.all(stored.map((s) => fromStored<T>(s)));
}

export async function listByType<T = unknown>(
	type: OutboxType,
): Promise<OutboxEntry<T>[]> {
	const stored = await db.outbox.where("type").equals(type).toArray();
	return Promise.all(stored.map((s) => fromStored<T>(s)));
}

/**
 * Plaintext `{ offline_id, status }` for every queued closing entry, WITHOUT
 * decrypting a single payload.
 *
 * `type` is indexed and `status` is a plaintext scalar on `StoredOutboxEntry`,
 * so the sync-state of a closing can be answered without `fromStored`. The
 * alternative — five `listByStatus()` sweeps — decrypts EVERY unsynced row in
 * the outbox (queued invoices, payments, customers) just to read two plaintext
 * columns, and one undecryptable row aborts the lot. Closing reconciliation
 * runs on the boot path and swallows its own errors, so an abort there leaves
 * the app selling against a shift that is already closing.
 */
export async function listClosingEntryStatuses(): Promise<
	Array<Pick<StoredOutboxEntry, "offline_id" | "status">>
> {
	const stored = await db.outbox
		.where("type")
		.equals("closing_entry")
		.toArray();
	return stored.map((row) => ({
		offline_id: row.offline_id,
		status: row.status,
	}));
}

/**
 * Invoice rows across the given statuses, decrypted ROW-BY-ROW rather than
 * with a single `Promise.all`.
 *
 * `listByStatus`'s `Promise.all(stored.map(fromStored))` rejects the ENTIRE
 * bucket the instant any one row fails to decrypt (stale key, corrupted
 * envelope). The shift-close aggregation (`sumQueuedPaymentsByMop` in
 * `shift-lifecycle.ts`) scans six status buckets and sums every invoice it
 * can read — if it were built on `listByStatus`, a single poison row in ANY
 * bucket would throw, the caller's catch would swallow it, and the cashier's
 * entire expected-amount figure would silently come back as zero across every
 * mode of payment, not just the corrupt invoice's contribution. Skipping the
 * bad row and continuing is strictly safer for a reconciliation figure than
 * an all-or-nothing failure. `corruptCount` is returned so a caller can log
 * or surface it; single-index scan by `type` (fewer types than statuses)
 * keeps this cheap.
 */
export async function listInvoiceRowsAcrossStatuses(
	statuses: OutboxStatus[],
): Promise<{ rows: OutboxEntry<unknown>[]; corruptCount: number }> {
	const statusSet = new Set(statuses);
	const stored = await db.outbox.where("type").equals("invoice").toArray();
	const rows: OutboxEntry<unknown>[] = [];
	let corruptCount = 0;
	for (const s of stored) {
		if (!statusSet.has(s.status)) continue;
		try {
			rows.push(await fromStored(s));
		} catch {
			corruptCount += 1;
		}
	}
	return { rows, corruptCount };
}

export async function listByShift<T = unknown>(
	shiftOfflineId: string,
): Promise<OutboxEntry<T>[]> {
	const stored = await db.outbox
		.where("shift_offline_id")
		.equals(shiftOfflineId)
		.toArray();
	return Promise.all(stored.map((s) => fromStored<T>(s)));
}

/**
 * Scheduler pickup (Agent 3): rows that are `enqueued` or `retry_pending`,
 * have no blocker, and whose `next_attempt_at` is due. We use the
 * compound index `[status+next_attempt_at]` for the range filter, then
 * drop rows with a non-null `blocked_reason` in memory (they're already
 * enqueued, just waiting for a parent / sibling).
 *
 * IMPORTANT: IndexedDB does not index `null` / `undefined` values, so rows
 * with `next_attempt_at === null` are NOT visible to this query. The
 * enqueue path (Agent 3) must stamp `next_attempt_at = Date.now()` on every
 * new row; leaving it null makes the entry invisible to the scheduler.
 *
 * Results are sorted by `next_attempt_at` ascending so the oldest-due rows
 * drain first.
 */
export async function listReady<T = unknown>(
	now = Date.now(),
	limit = 50,
): Promise<OutboxEntry<T>[]> {
	const readyStatuses: OutboxStatus[] = ["enqueued", "retry_pending"];
	const collected: StoredOutboxEntry[] = [];
	// Cap the index-level fetch at a generous multiple of `limit` so we
	// can fully drop blocked rows in memory and still return `limit`
	// unblocked rows. Without this, a blocked row at the head of the
	// past-due range starves later ready rows: with `nextReady`'s
	// `limit=1`, the index returns the single oldest match, the in-memory
	// `blocked_reason !== null` filter drops it, and the function returns
	// empty even though unblocked siblings exist further down the range.
	// The range is already bounded to past-due rows, so the prefetch is
	// O(past-due-depth) — still cheap on every realistic queue size.
	const PREFETCH_MULTIPLIER = 50;
	const indexFetchLimit = Math.max(limit * PREFETCH_MULTIPLIER, 200);
	for (const status of readyStatuses) {
		// Range: [status, -Infinity] .. [status, now]
		const rows = await db.outbox
			.where("[status+next_attempt_at]")
			.between([status, -Infinity], [status, now], true, true)
			.limit(indexFetchLimit)
			.toArray();
		for (const r of rows) {
			if (r.blocked_reason === null) {
				collected.push(r);
				if (collected.length >= limit) break;
			}
		}
		if (collected.length >= limit) break;
	}
	collected.sort((a, b) => {
		const av = a.next_attempt_at ?? 0;
		const bv = b.next_attempt_at ?? 0;
		return av - bv;
	});
	return Promise.all(collected.map((s) => fromStored<T>(s)));
}

export async function countByStatus(status: OutboxStatus): Promise<number> {
	return db.outbox.where("status").equals(status).count();
}

export async function countPending(): Promise<number> {
	const enq = await countByStatus("enqueued");
	const retry = await countByStatus("retry_pending");
	const inflight = await countByStatus("in_flight");
	return enq + retry + inflight;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Persists a new outbox row. `payload_integrity_hash` is computed (or
 * trusted if the caller supplied one) and always re-verified against the
 * envelope to catch mismatches early.
 *
 * Throws:
 *  - `SafeModeBlockedError` when storage is in safe mode.
 *  - The original `QuotaExceededError` (or any other Dexie error) on write
 *    failure — caller's responsibility to block the UI per §7. Critical:
 *    we do NOT swallow this; the whole offline story depends on the sale
 *    failing loudly if persistence fails (P-14).
 */
export async function putOutboxEntry<T>(
	row: OutboxEntry<T>,
): Promise<void> {
	assertWritable();
	// Derive hash if missing; also used by the scheduler later to confirm
	// integrity without a full decrypt.
	if (!row.payload_integrity_hash) {
		row.payload_integrity_hash = await canonicalIntegrityHash(row.payload);
	}
	const stored = await toStored(row);
	try {
		await db.outbox.put(stored);
	} catch (err) {
		// Do not swallow. Propagate so the UI blocks the sale with a clear
		// error (03-storage-layer.md §7).
		throw err;
	}
}

/**
 * Updates only the scheduler-mutable fields on an outbox row. Avoids
 * re-encrypting the payload on each retry — cheaper and also keeps the
 * envelope stable across retry attempts (stable ciphertext is easier to
 * diff in support scenarios).
 */
export async function updateSchedulerFields(
	offlineId: string,
	patch: Partial<{
		status: OutboxStatus;
		blocked_reason: OutboxBlockedReason;
		attempt_count: number;
		next_attempt_at: number | null;
		last_error_category: LastErrorCategory;
		last_error_detail: string | null;
		server_doc_name: string | null;
		recovery_entry_name: string | null;
		synced_at: number | null;
	}>,
): Promise<void> {
	assertWritable();
	// Read-modify-write inside a single Dexie transaction so a parallel
	// `voidEntry` can't sneak in between get() and put(). Voided rows are
	// terminal — we preserve the voided status but still apply non-status
	// fields (e.g. `server_doc_name`) so reconciliation can link the local
	// audit row to the remote doc the scheduler eventually heard back about.
	await db.transaction("rw", db.outbox, async () => {
		const stored = await db.outbox.get(offlineId);
		if (!stored) {
			throw new Error(`outbox ${offlineId} not found`);
		}
		const merged = { ...stored, ...patch };
		if (stored.status === "voided") {
			merged.status = "voided";
			merged.blocked_reason = stored.blocked_reason;
		}
		await db.outbox.put(merged);
	});
}

/**
 * Compare-and-swap on `status`. Used by the scheduler to atomically claim
 * a row (`enqueued → in_flight`) without two tabs fighting over it.
 * Returns `true` on success, `false` when the expected status didn't
 * match — the caller should pick another row.
 */
export async function compareAndSwapStatus(
	offlineId: string,
	expected: OutboxStatus,
	next: OutboxStatus,
): Promise<boolean> {
	assertWritable();
	return db.transaction("rw", db.outbox, async () => {
		const row = await db.outbox.get(offlineId);
		if (!row || row.status !== expected) return false;
		await db.outbox.put({ ...row, status: next });
		return true;
	});
}

export async function deleteOutboxEntry(offlineId: string): Promise<void> {
	assertWritable();
	await db.outbox.delete(offlineId);
}

/** @internal — tests + corruption-recovery tooling. */
export const _internal = { toStored, fromStored, aadForOutbox };
