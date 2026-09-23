/**
 * Shifts repo — partial encryption.
 *
 * Only the three sensitive fields are encrypted (per spec §6):
 *   - opening_cash_by_mop
 *   - closing_cash_by_mop
 *   - closing_notes
 *
 * Everything else — status, variance, pos_profile snapshot, timestamps —
 * is plaintext because it's either non-sensitive or needs to be indexed
 * (status) / compared (variance) without decrypt.
 *
 * The caller-facing shape is `ShiftRow` (all fields in plaintext). The
 * stored shape is `StoredShiftRow` (three envelopes + the plaintext
 * scalars). Repo is the only place that knows about the transform.
 *
 * Outbox enqueue on shift open/close is Agent 3's responsibility. Callers
 * wrap the repo write and outbox enqueue in a single `runInTransaction`
 * (see db.ts) so both commit atomically — the repo itself stays single-
 * table.
 */

import { assertWritable, db, runInTransaction } from "../db";
import { decrypt, encrypt, getActiveKey } from "../crypto";
import type {
	EncryptedEnvelope,
	ShiftRow,
	ShiftStatus,
	StoredShiftRow,
} from "../types";

function aadForShift(offlineId: string, field: string): string {
	return `shift:${offlineId}:${field}`;
}

async function encryptField(
	value: unknown,
	offlineId: string,
	field: string,
): Promise<EncryptedEnvelope> {
	const { key, id } = getActiveKey();
	return encrypt(value, key, id, aadForShift(offlineId, field));
}

async function toStored(row: ShiftRow): Promise<StoredShiftRow> {
	// Opening cash is mandatory at shift-open (type-wise non-null). We still
	// guard defensively so a future refactor that introduces a placeholder
	// shift can't slip a null past the encryption boundary unnoticed.
	if (row.opening_cash_by_mop === null || row.opening_cash_by_mop === undefined) {
		throw new Error(
			`shift ${row.offline_id} cannot be persisted without opening_cash_by_mop`,
		);
	}
	const opening = await encryptField(
		row.opening_cash_by_mop,
		row.offline_id,
		"opening_cash",
	);
	const closing =
		row.closing_cash_by_mop === null
			? null
			: await encryptField(
					row.closing_cash_by_mop,
					row.offline_id,
					"closing_cash",
				);
	const notes =
		row.closing_notes === null
			? null
			: await encryptField(
					row.closing_notes,
					row.offline_id,
					"closing_notes",
				);
	return {
		offline_id: row.offline_id,
		device_id: row.device_id,
		cashier_user: row.cashier_user,
		pos_profile: row.pos_profile,
		opened_at: row.opened_at,
		opening_server_name: row.opening_server_name,
		expected_closing_by_mop: row.expected_closing_by_mop,
		variance_at_close: row.variance_at_close,
		variance_at_sync: row.variance_at_sync,
		closed_at: row.closed_at,
		closing_server_name: row.closing_server_name,
		pending_closing_offline_id: row.pending_closing_offline_id,
		status: row.status,
		manager_approval_required: row.manager_approval_required,
		opening_cash_envelope: opening,
		closing_cash_envelope: closing,
		closing_notes_envelope: notes,
	};
}

async function fromStored(stored: StoredShiftRow): Promise<ShiftRow> {
	// A shift row always has opening cash (it's captured at open time). If
	// the envelope is missing here we surface it as a corruption signal so
	// the caller can enter safe mode; silently defaulting to {} would hide
	// real data loss.
	if (!stored.opening_cash_envelope) {
		throw new Error(
			`shift ${stored.offline_id} is missing opening_cash_envelope — possible corruption`,
		);
	}
	const opening = await decrypt<Record<string, number>>(
		stored.opening_cash_envelope,
		aadForShift(stored.offline_id, "opening_cash"),
	);
	const closing = stored.closing_cash_envelope
		? await decrypt<Record<string, number>>(
				stored.closing_cash_envelope,
				aadForShift(stored.offline_id, "closing_cash"),
			)
		: null;
	const notes = stored.closing_notes_envelope
		? await decrypt<string>(
				stored.closing_notes_envelope,
				aadForShift(stored.offline_id, "closing_notes"),
			)
		: null;
	return {
		offline_id: stored.offline_id,
		device_id: stored.device_id,
		cashier_user: stored.cashier_user,
		pos_profile: stored.pos_profile,
		opening_cash_by_mop: opening,
		opened_at: stored.opened_at,
		opening_server_name: stored.opening_server_name,
		closing_cash_by_mop: closing,
		expected_closing_by_mop: stored.expected_closing_by_mop,
		variance_at_close: stored.variance_at_close,
		variance_at_sync: stored.variance_at_sync,
		closing_notes: notes,
		closed_at: stored.closed_at,
		closing_server_name: stored.closing_server_name,
		pending_closing_offline_id: stored.pending_closing_offline_id,
		status: stored.status,
		manager_approval_required: stored.manager_approval_required,
	};
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function getShiftById(
	offlineId: string,
): Promise<ShiftRow | undefined> {
	const stored = await db.shifts.get(offlineId);
	if (!stored) return undefined;
	return fromStored(stored);
}

export async function getOpenShift(): Promise<ShiftRow | undefined> {
	// There should be AT MOST one open shift per device (D-6: single
	// cashier offline). If we find more than one, that's a data-integrity
	// bug — surface the first but let callers detect with countByStatus.
	const stored = await db.shifts.where("status").equals("open").first();
	if (!stored) return undefined;
	return fromStored(stored);
}

export async function listShiftsByStatus(
	status: ShiftStatus,
): Promise<ShiftRow[]> {
	const stored = await db.shifts.where("status").equals(status).toArray();
	return Promise.all(stored.map(fromStored));
}

export async function countShiftsByStatus(
	status: ShiftStatus,
): Promise<number> {
	return db.shifts.where("status").equals(status).count();
}

export async function listAllShifts(): Promise<ShiftRow[]> {
	const stored = await db.shifts.toArray();
	return Promise.all(stored.map(fromStored));
}

/**
 * Look a shift up by its server doc name without decrypting the whole
 * table. `opening_server_name` is a plaintext scalar on `StoredShiftRow`
 * but is NOT part of the v1 Dexie index (`"offline_id, device_id,
 * status"`), so this is a linear `.filter()`, not a `.where()` — still far
 * cheaper than `listAllShifts()`, which does `Promise.all(rows.map(fromStored))`
 * and both decrypts every row in the table on every call AND throws the
 * whole lookup if any unrelated row is missing its opening-cash envelope
 * (corruption). Here `fromStored` only ever runs on the single matched row.
 */
export async function getShiftByOpeningServerName(
	serverName: string,
): Promise<ShiftRow | undefined> {
	const stored = await db.shifts
		.filter((row) => row.opening_server_name === serverName)
		.first();
	if (!stored) return undefined;
	return fromStored(stored);
}

/**
 * Plaintext scalars of every shift currently waiting on a queued closing.
 *
 * `pending_closing_offline_id`, `offline_id` and `status` are all plaintext
 * on `StoredShiftRow`, so this deliberately skips `fromStored` — same
 * reasoning as `getShiftByOpeningServerName` above: `listAllShifts()`
 * decrypts every row in the table and throws the WHOLE lookup if any single
 * unrelated row is corrupt or missing its opening-cash envelope. The two
 * callers of this (startup reconciliation and closing-sync resolution) fail
 * silently by design — a throw there would leave the app selling against a
 * shift that is already closing, which is the exact bug this state exists
 * to prevent — so they must not depend on the health of unrelated rows.
 */
export async function listPendingClosingShifts(): Promise<
	Array<
		Pick<StoredShiftRow, "offline_id" | "pending_closing_offline_id" | "status">
	>
> {
	const stored = await db.shifts
		.filter((row) => !!row.pending_closing_offline_id)
		.toArray();
	return stored.map((row) => ({
		offline_id: row.offline_id,
		pending_closing_offline_id: row.pending_closing_offline_id,
		status: row.status,
	}));
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export async function putShift(row: ShiftRow): Promise<void> {
	assertWritable();
	const stored = await toStored(row);
	await db.shifts.put(stored);
}

/**
 * Encrypt a candidate `ShiftRow` into its on-disk shape WITHOUT persisting
 * it. Exported directly (not via `_internal`, which is documented as
 * test/tooling-only) because `registerOpenedShift` (shift-lifecycle.ts)
 * needs to encrypt a row BEFORE opening a Dexie transaction: `toStored`
 * awaits `crypto.subtle`, a native, non-Dexie promise, and IndexedDB
 * auto-commits a transaction the instant one of those is awaited inside
 * its scope (PrematureCommitError — reproduced against this exact function
 * in review). Encrypting up front and only conditionally `put`-ing inside
 * `putShiftIfAbsent` keeps the transaction body 100% Dexie-native.
 */
export { toStored as buildStoredShift };

/**
 * Atomically register a PRE-ENCRYPTED stored row, deduping on the server
 * name AND then on a caller-supplied durable id (`lifecycleId`) — without
 * decrypting anything. `stored` must already be the output of
 * `buildStoredShift`, produced OUTSIDE any transaction.
 *
 * BOTH keys are tried, in that order, rather than one or the other. A shift
 * opened offline and synced mid-shift presents both: a server name (which
 * its row may or may not have learned yet — `attachOpeningServerName` is
 * best-effort) and its original outbox id. Checking only the server name
 * missed that row and inserted a duplicate `open` one, which quietly
 * detached the shift from its own `closed_pending_sync` state.
 *
 * Both dedupe checks compare plaintext scalars already present on
 * `StoredShiftRow` (`opening_server_name`, the `offline_id` primary key),
 * so the whole callback below is pure Dexie operations — `.filter().first()`,
 * `.get()`, `.put()` — none of which is a non-Dexie promise, so the
 * transaction can't prematurely commit the way a decrypt/encrypt call
 * inside it would.
 */
export async function putShiftIfAbsent(
	stored: StoredShiftRow,
	dedupe: { openingServerName: string | null; lifecycleId?: string },
): Promise<string> {
	assertWritable();
	return runInTransaction("rw", [db.shifts], async () => {
		if (dedupe.openingServerName) {
			const existing = await db.shifts
				.filter((row) => row.opening_server_name === dedupe.openingServerName)
				.first();
			if (existing) return existing.offline_id;
		}
		if (dedupe.lifecycleId) {
			const existing = await db.shifts.get(dedupe.lifecycleId);
			if (existing) return existing.offline_id;
		}
		await db.shifts.put(stored);
		return stored.offline_id;
	});
}

/**
 * Small helper for status-only transitions (open → closed_pending_sync,
 * syncing → synced, etc). Keeps callers from re-encrypting unchanged cash
 * fields when they only want to bump status.
 */
export async function updateShiftStatus(
	offlineId: string,
	status: ShiftStatus,
	extra: Partial<
		Pick<
			StoredShiftRow,
			| "closed_at"
			| "closing_server_name"
			| "opening_server_name"
			| "pending_closing_offline_id"
			| "variance_at_sync"
			| "manager_approval_required"
		>
	> = {},
): Promise<void> {
	assertWritable();
	const existing = await db.shifts.get(offlineId);
	if (!existing) {
		throw new Error(`shift ${offlineId} not found`);
	}
	await db.shifts.put({ ...existing, ...extra, status });
}

/** @internal — for tests and corruption-recovery tooling. */
export const _internal = { toStored, fromStored, aadForShift };
