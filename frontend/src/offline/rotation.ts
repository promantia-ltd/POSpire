/**
 * B4 — Encryption re-key automation.
 *
 * Generates a fresh active AES-GCM 256 key, demotes the previous key to the
 * historical keyring (decrypt-only), and re-encrypts every encrypted Dexie
 * row under the new key. Old envelopes still decrypt because they reference
 * the historical key by `key_id`; we walk every encrypted repo (outbox,
 * customers, shifts) and rewrite the envelope with the new key id.
 *
 * Design:
 *   - The CryptoKey is non-extractable (`generateKey({extractable: false})`),
 *     so even the rotation flow cannot leak the key material to JS.
 *   - Historical keys stay in metadata under `crypto.historical_key.<id>` so
 *     a partial rotation crash leaves both old and new keys readable on
 *     restart (`bootstrapEncryptionKey` registers them).
 *   - The rotation report is persisted under `crypto.last_rotation` and
 *     surfaced through `lastRotationReport()` for the admin UI / runbooks.
 *   - Errors do NOT abort the whole rotation — we collect them per-row and
 *     leave their envelopes untouched. The next rotation pass picks them up
 *     under a third key (or the operator can void the row from the
 *     reconciliation workspace).
 *
 * To trigger: `import { rotateActiveKey } from "@/offline/rotation"; await
 * rotateActiveKey()`. There is intentionally no UI button in v1 — rotation
 * is a sensitive operation and the trigger lives in an ops runbook.
 */

import { db, assertWritable, uuidV4 } from "./db";
import {
	META_KEY_ACTIVE_KEY,
	META_KEY_ACTIVE_KEY_ID,
	META_KEY_HISTORICAL_KEY_PREFIX,
	META_KEY_LAST_ROTATION,
} from "./db";
import {
	encrypt,
	decrypt,
	generateKey,
	getActiveKey,
	registerHistoricalKey,
	setActiveKey,
} from "./crypto";
import { _internal as outboxInternal } from "./repos/outbox";
import { _internal as customersInternal } from "./repos/customers";
import { _internal as shiftsInternal } from "./repos/shifts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotationRowError {
	repo: "outbox" | "customers" | "shifts";
	primary_key: string;
	reason: string;
}

export interface RotationReport {
	rotation_id: string;
	old_key_id: string;
	new_key_id: string;
	started_at: number;
	completed_at: number;
	duration_ms: number;
	rows: { outbox: number; customers: number; shifts: number };
	row_errors: RotationRowError[];
	success: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rotate the active encryption key. Re-encrypts every encrypted Dexie row
 * under the new key. Returns a structured report (also persisted to
 * metadata) the operator can submit through `submit_recovery_log` or read
 * via `lastRotationReport()`.
 *
 * Idempotent only on success — if the rotation fails partway, the new key
 * is already active but some rows still reference the old key. Re-running
 * from that state will re-rotate the unfinished rows under a third key.
 * The historical keyring keeps both readable in the meantime.
 */
export async function rotateActiveKey(): Promise<RotationReport> {
	assertWritable();
	const startedAt = Date.now();
	const oldActive = getActiveKey();

	// Generate the new key + id BEFORE touching any rows. If anything below
	// throws, the historical key is still active and nothing breaks.
	const newKey = await generateKey();
	const newKeyId = uuidV4();
	const now = Date.now();

	// Persist the new key, demote the old to historical, register both with
	// the in-process keyring. Done in one transaction so a partial commit
	// can't leave a key id pointing at a missing CryptoKey blob.
	await db.transaction("rw", db.metadata, async () => {
		await db.metadata.bulkPut([
			{ key: META_KEY_ACTIVE_KEY, value: newKey, updated_at: now },
			{ key: META_KEY_ACTIVE_KEY_ID, value: newKeyId, updated_at: now },
			{
				key: `${META_KEY_HISTORICAL_KEY_PREFIX}${oldActive.id}`,
				value: oldActive.key,
				updated_at: now,
			},
		]);
	});
	registerHistoricalKey(oldActive.id, oldActive.key);
	setActiveKey(newKeyId, newKey);

	// Walk each encrypted repo. We use the same pattern for all three: read
	// the stored row, decrypt with the AAD that repo uses, re-encrypt under
	// the new active key, put back. Any row that fails to decrypt is logged
	// and skipped — its envelope still references the old key (now in the
	// historical ring) so subsequent reads keep working.
	const counters = { outbox: 0, customers: 0, shifts: 0 };
	const rowErrors: RotationRowError[] = [];

	await rotateRepo<typeof db.outbox>(
		db.outbox,
		"outbox",
		(stored) => stored.offline_id,
		(stored) => `outbox:${stored.offline_id}`,
		(stored) => stored.envelope,
		(stored, envelope) => ({ ...stored, envelope }),
		newKey,
		newKeyId,
		counters,
		rowErrors,
	);
	void outboxInternal; // referenced for future repo-internal usage

	// Customers — uses the AAD pattern `customer:<name>` from the repo.
	await rotateRepo<typeof db.customers>(
		db.customers,
		"customers",
		(stored) => stored.name,
		(stored) => `customer:${stored.name}`,
		(stored) => stored.envelope,
		(stored, envelope) => ({ ...stored, envelope }),
		newKey,
		newKeyId,
		counters,
		rowErrors,
	);
	void customersInternal;

	// Shifts — three encrypted siblings on each row (opening cash, closing
	// cash, closing notes). Re-encrypt each one independently.
	await rotateShiftsTable(newKey, newKeyId, counters, rowErrors);
	void shiftsInternal;

	const completedAt = Date.now();
	const report: RotationReport = {
		rotation_id: uuidV4(),
		old_key_id: oldActive.id,
		new_key_id: newKeyId,
		started_at: startedAt,
		completed_at: completedAt,
		duration_ms: completedAt - startedAt,
		rows: counters,
		row_errors: rowErrors,
		success: rowErrors.length === 0,
	};

	await db.metadata.put({
		key: META_KEY_LAST_ROTATION,
		value: report,
		updated_at: completedAt,
	});

	return report;
}

/** Returns the most recently completed rotation, or null if never rotated. */
export async function lastRotationReport(): Promise<RotationReport | null> {
	const row = await db.metadata.get(META_KEY_LAST_ROTATION);
	if (!row || typeof row.value !== "object" || !row.value) return null;
	return row.value as RotationReport;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Single-table re-encrypt loop. Generic so the three table flavours share a
 * code path — the only differences are AAD computation, envelope read/write,
 * and the primary-key extraction (for error reporting).
 */
async function rotateRepo<T>(
	table: { toArray: () => Promise<unknown[]>; put: (row: unknown) => Promise<unknown> },
	repoName: "outbox" | "customers" | "shifts",
	pkOf: (row: unknown) => string,
	aadFor: (row: unknown) => string,
	envelopeOf: (row: unknown) => unknown,
	withEnvelope: (row: unknown, envelope: unknown) => unknown,
	newKey: CryptoKey,
	newKeyId: string,
	counters: { outbox: number; customers: number; shifts: number },
	rowErrors: RotationRowError[],
): Promise<void> {
	const rows = await table.toArray();
	for (const row of rows) {
		try {
			const env = envelopeOf(row) as Parameters<typeof decrypt>[0];
			const aad = aadFor(row);
			const plaintext = await decrypt(env, aad);
			const newEnvelope = await encrypt(plaintext, newKey, newKeyId, aad);
			await table.put(withEnvelope(row, newEnvelope));
			counters[repoName] += 1;
		} catch (err) {
			rowErrors.push({
				repo: repoName,
				primary_key: pkOf(row),
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/**
 * Shifts have three encrypted siblings instead of one envelope. Walk them
 * separately so a partial failure on (say) closing_notes doesn't leave the
 * opening_cash envelope half-rotated.
 */
async function rotateShiftsTable(
	newKey: CryptoKey,
	newKeyId: string,
	counters: { outbox: number; customers: number; shifts: number },
	rowErrors: RotationRowError[],
): Promise<void> {
	const rows = await db.shifts.toArray();
	for (const row of rows) {
		const errors: string[] = [];
		const updated = { ...row };
		const aad = `shift:${row.offline_id}`;
		const fields = [
			"opening_cash_envelope",
			"closing_cash_envelope",
			"closing_notes_envelope",
		] as const;
		for (const f of fields) {
			const env = (row as Record<string, unknown>)[f];
			if (!env) continue;
			try {
				const plaintext = await decrypt(
					env as Parameters<typeof decrypt>[0],
					aad,
				);
				const newEnv = await encrypt(plaintext, newKey, newKeyId, aad);
				(updated as Record<string, unknown>)[f] = newEnv;
			} catch (err) {
				errors.push(
					`${f}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (errors.length === 0) {
			await db.shifts.put(updated);
			counters.shifts += 1;
		} else {
			rowErrors.push({
				repo: "shifts",
				primary_key: row.offline_id,
				reason: errors.join("; "),
			});
		}
	}
}
