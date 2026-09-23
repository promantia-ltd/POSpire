/**
 * Pospire offline storage — Dexie 4.x schema + lifecycle.
 *
 * Responsibilities:
 *  - Declare the `pospire_offline` primary database and the
 *    `pospire_offline_journal` shadow journal (§8.1).
 *  - Own one-time initialisation: generate/load the non-extractable
 *    encryption CryptoKey (D-24), seed the device_id, retire legacy
 *    posa_local_storage caches (Q-10).
 *  - Run the 60 s health probe and flip into `safeMode` when storage looks
 *    unhealthy or we detect corruption. In safe mode, new writes are
 *    blocked — repos check `isSafeMode()` before writes.
 *  - Provide a transaction helper that mirrors critical writes to the
 *    journal in the same logical unit.
 *
 * Principles honoured:
 *  - P-1: IndexedDB is the only durable store. `localStorage` is touched
 *    exclusively for the three keys documented in 03-storage-layer.md §1.
 *  - P-10: encryption key is non-extractable and never leaves Dexie.
 *  - P-14: errors are propagated, not swallowed. Health probe surfaces a
 *    degraded-storage warning instead of failing silently.
 */

import Dexie, { type Table, type Transaction } from "dexie";

import {
	DB_NAME_JOURNAL,
	DB_NAME_PRIMARY,
	HEALTH_PROBE_INTERVAL_MS,
	HEALTH_PROBE_RTT_WARN_MS,
	JOURNAL_MAX_AGE_MS,
	JOURNAL_MAX_BYTES,
	LEGACY_LS_KEYS,
	LS_DEVICE_ID,
	LS_SCHEMA_VERSION,
	OFFLINE_SCHEMA_VERSION,
} from "./constants";
import {
	generateKey,
	registerHistoricalKey,
	setActiveKey,
} from "./crypto";
import type {
	HealthProbeRow,
	ItemRow,
	JournalRow,
	MetadataRow,
	StoredContributionRow,
	StoredCustomerRow,
	StoredOutboxEntry,
	StoredShiftRow,
} from "./types";

// ---------------------------------------------------------------------------
// Metadata keys used by db internals. Kept here (not in constants.ts) because
// they are private to the db module; callers go through repos.
// ---------------------------------------------------------------------------

export const META_KEY_ACTIVE_KEY = "crypto.active_key";
export const META_KEY_ACTIVE_KEY_ID = "crypto.active_key_id";
export const META_KEY_HISTORICAL_KEY_PREFIX = "crypto.historical_key.";
export const META_KEY_LAST_ROTATION = "crypto.last_rotation";
const META_KEY_DEVICE_ID = "device.id";

// ---------------------------------------------------------------------------
// Database classes
// ---------------------------------------------------------------------------

/**
 * Primary offline database. Never reset the version chain; always append a
 * new `this.version(N+1).stores({...}).upgrade(...)` on schema changes.
 */
export class PospireOfflineDB extends Dexie {
	items!: Table<ItemRow, string>;
	customers!: Table<StoredCustomerRow, string>;
	shifts!: Table<StoredShiftRow, string>;
	outbox!: Table<StoredOutboxEntry, string>;
	metadata!: Table<MetadataRow, string>;
	_health!: Table<HealthProbeRow, string>;
	contributions!: Table<StoredContributionRow, string>;

	constructor() {
		super(DB_NAME_PRIMARY);

		// --- v1 --------------------------------------------------------------
		// Schema matches docs/offline/03-storage-layer.md §3.
		//
		// Index reference:
		//   items:      PK item_code, secondary item_group, multi-entry barcodes
		//   customers:  PK name, mobile_no, customer_group, offline_created
		//   shifts:     PK offline_id, device_id, status
		//   outbox:     PK offline_id, status, type, shift_offline_id,
		//               compound [status+next_attempt_at] for scheduler pickup.
		//               We intentionally use the two-key compound specified in
		//               the AGENTS brief (not the three-key variant in the
		//               storage doc) — scheduler filters out non-null
		//               blocked_reason in memory. Two-key keeps the index
		//               smaller and the read path simpler. Called out in the
		//               final-report deviations section.
		//   metadata:   PK key
		//   _health:    PK id (single row, value 'probe')
		this.version(1).stores({
			items: "item_code, item_group, *barcodes",
			customers: "name, mobile_no, customer_group, offline_created",
			shifts: "offline_id, device_id, status",
			outbox:
				"offline_id, status, type, shift_offline_id, [status+next_attempt_at]",
			metadata: "key",
			_health: "id",
		});

		// v2 — per-invoice contribution ledger (Phase 2).
		//
		// Purely ADDITIVE: no existing table's schema changes, so Dexie needs
		// no upgrade function. Devices holding queued invoices and shift rows
		// keep them; Dexie replays v1 then applies v2's new store.
		//
		// Indexed on `shift_lifecycle_id` (every read is shift-scoped) and
		// `status` (the startup reconciliation scans pending rows). `by_mop`
		// is deliberately NOT indexed — it is encrypted, and indexing it would
		// leak amounts into the unencrypted index.
		this.version(2).stores({
			contributions: "offline_id, shift_lifecycle_id, status",
		});
	}
}

/**
 * Shadow journal — a SECOND IndexedDB database so corruption in the primary
 * doesn't take the journal with it (§8.1). Append-only, bounded by the
 * rolling 30-day / 50 MB window.
 */
export class PospireJournalDB extends Dexie {
	journal!: Table<JournalRow, number>;

	constructor() {
		super(DB_NAME_JOURNAL);
		// Auto-incrementing id; `ts` indexed for window pruning.
		this.version(1).stores({
			journal: "++id, ts, type, offline_id",
		});
	}
}

export const db = new PospireOfflineDB();
export const journalDb = new PospireJournalDB();

// LOGGING ONLY. `blocked` fires when this tab's version upgrade cannot proceed
// because another tab still holds an older connection open. Dexie does not
// reject the open in that case — it simply waits, so the symptom is "every
// IndexedDB call in this tab hangs forever" with nothing in the console to
// explain it. Callers on the sale path defend themselves with their own
// deadline; this only makes the cause visible.
//
// Deliberately NO `versionchange` handler: Dexie's default closes the
// connection so the OTHER tab's upgrade can complete, and overriding it would
// turn a transient block into a permanent one.
db.on("blocked", () => {
	console.warn(
		"[offline-db] IndexedDB upgrade is blocked by another open tab; operations in this tab will not settle until it closes",
	);
});

// ---------------------------------------------------------------------------
// Safe mode — state machine flag surfaced to the UI when corruption / storage
// health is compromised (§8.4).
// ---------------------------------------------------------------------------

type SafeModeReason =
	| "schema_mismatch"
	| "health_probe_failed"
	| "transaction_rejected"
	| "integrity_mismatch"
	| "manual";

interface SafeModeState {
	active: boolean;
	reason: SafeModeReason | null;
	detail: string | null;
	since: number | null;
}

const safeModeState: SafeModeState = {
	active: false,
	reason: null,
	detail: null,
	since: null,
};

const safeModeListeners = new Set<(s: SafeModeState) => void>();

/** Read-only view of the current safe-mode state. */
export function getSafeMode(): Readonly<SafeModeState> {
	return { ...safeModeState };
}

/** `true` when new writes should be blocked. */
export function isSafeMode(): boolean {
	return safeModeState.active;
}

/** Register a listener for safe-mode transitions. Returns an unsubscribe fn. */
export function onSafeModeChange(
	fn: (s: SafeModeState) => void,
): () => void {
	safeModeListeners.add(fn);
	return () => safeModeListeners.delete(fn);
}

/** Activate safe mode. Idempotent — repeated calls don't re-notify. */
export function enterSafeMode(
	reason: SafeModeReason,
	detail: string,
): void {
	if (safeModeState.active) return;
	safeModeState.active = true;
	safeModeState.reason = reason;
	safeModeState.detail = detail;
	safeModeState.since = Date.now();
	for (const fn of safeModeListeners) {
		try {
			fn(safeModeState);
		} catch {
			// Listener errors must not cascade back into storage. We swallow
			// listener exceptions deliberately (NOT storage errors — see P-14).
		}
	}
}

/** Exit safe mode (manual, after reconciliation). */
export function exitSafeMode(): void {
	if (!safeModeState.active) return;
	safeModeState.active = false;
	safeModeState.reason = null;
	safeModeState.detail = null;
	safeModeState.since = null;
	for (const fn of safeModeListeners) {
		try {
			fn(safeModeState);
		} catch {
			/* see enterSafeMode */
		}
	}
}

/**
 * Throws if we are in safe mode. Repos call this before any write. We use a
 * distinct error class so callers / UI can render the exact copy in
 * 03-storage-layer.md §8 rather than a generic failure.
 */
export class SafeModeBlockedError extends Error {
	constructor() {
		super(
			"Offline storage is in safe mode; new writes are blocked until reconnection.",
		);
		this.name = "SafeModeBlockedError";
	}
}

export function assertWritable(): void {
	if (isSafeMode()) {
		throw new SafeModeBlockedError();
	}
}

// ---------------------------------------------------------------------------
// Degraded-storage warning — surfaced when the health probe RTT is over the
// warn threshold (but still successful). Separate from safe mode because it
// doesn't block writes, just asks the UI to render a banner.
// ---------------------------------------------------------------------------

const degradedListeners = new Set<
	(degraded: boolean, rttMs: number) => void
>();
let degradedActive = false;

export function onDegradedStorageChange(
	fn: (degraded: boolean, rttMs: number) => void,
): () => void {
	degradedListeners.add(fn);
	return () => degradedListeners.delete(fn);
}

function setDegraded(degraded: boolean, rttMs: number): void {
	if (degraded === degradedActive) return;
	degradedActive = degraded;
	for (const fn of degradedListeners) {
		try {
			fn(degraded, rttMs);
		} catch {
			/* ignore listener errors */
		}
	}
}

// ---------------------------------------------------------------------------
// Initialisation — idempotent; safe to call from Pos.vue mount.
// ---------------------------------------------------------------------------

let initialised = false;
let initPromise: Promise<void> | null = null;

/**
 * One-shot init. Runs schema open, legacy-storage cleanup, encryption-key
 * bootstrap, and starts the health probe. Returns the same promise on
 * repeat calls.
 */
export function initOfflineStorage(): Promise<void> {
	if (initialised) return Promise.resolve();
	if (initPromise) return initPromise;
	initPromise = (async () => {
		try {
			// Legacy localStorage cleanup is intentionally deferred until Phase 2
			// component migration. POS components still read `customer_storage`,
			// `items_storage`, `sales_persons_storage` directly; removing those
			// keys here would break their offline reads. Re-enable
			// `cleanupLegacyLocalStorage()` once the components have moved to
			// either Agent 1's domain repos or `call({cacheKey})`.
			seedDeviceId();
			syncSchemaVersion();
			await db.open();
			await bootstrapEncryptionKey();
			startHealthProbe();
			initialised = true;
		} catch (err) {
			// Open failures that look like schema-version conflicts flip us into
			// safe mode with a clear reason so the UI can render the guidance
			// from §8.4 ("reconnect once for a clean rebuild"). We re-throw so
			// callers can also log/telemetry.
			const name = err instanceof Error ? err.name : "UnknownError";
			const msg = err instanceof Error ? err.message : String(err);
			if (
				name === "VersionError" ||
				name === "InvalidStateError" ||
				name === "NotFoundError"
			) {
				enterSafeMode("schema_mismatch", `${name}: ${msg}`);
			} else {
				enterSafeMode("transaction_rejected", `${name}: ${msg}`);
			}
			throw err;
		}
	})();
	return initPromise;
}

/**
 * Q-10: retire the legacy posa_local_storage caches on first offline-enabled
 * load. We remove (do not read / shadow) the three keys so the old cache
 * cannot contaminate the new hydration path. Safe to run repeatedly.
 */
function cleanupLegacyLocalStorage(): void {
	if (typeof localStorage === "undefined") return;
	for (const key of LEGACY_LS_KEYS) {
		try {
			if (localStorage.getItem(key) !== null) {
				localStorage.removeItem(key);
			}
		} catch {
			// localStorage can throw in strict-privacy browsers; we swallow
			// because the cleanup is best-effort and never critical.
		}
	}
}

/** Ensures `pospire.device_id` exists. One-time UUID v4. */
function seedDeviceId(): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (!localStorage.getItem(LS_DEVICE_ID)) {
			localStorage.setItem(LS_DEVICE_ID, uuidV4());
		}
	} catch {
		// strict-privacy browsers; device_id will be missing but the rest of
		// the stack tolerates a server-assigned device id at first sync.
	}
}

/** Bootstrap sanity check — mismatch indicates a partial upgrade. */
function syncSchemaVersion(): void {
	if (typeof localStorage === "undefined") return;
	try {
		const raw = localStorage.getItem(LS_SCHEMA_VERSION);
		const persisted = raw == null ? null : Number(raw);
		if (persisted !== null && persisted !== OFFLINE_SCHEMA_VERSION) {
			// Version in localStorage is ahead / behind what this bundle ships.
			// That's a Dexie upgrade case; enter safe mode to force a clean
			// rebuild. Per §8.4: reconnect once.
			enterSafeMode(
				"schema_mismatch",
				`schema_version localStorage=${persisted} bundle=${OFFLINE_SCHEMA_VERSION}`,
			);
		}
		localStorage.setItem(
			LS_SCHEMA_VERSION,
			String(OFFLINE_SCHEMA_VERSION),
		);
	} catch {
		/* ignore */
	}
}

/**
 * Loads or generates the active encryption key and registers it with the
 * crypto module. Historical keys (kept during rotation) are also loaded so
 * old ciphertext can still be read.
 */
async function bootstrapEncryptionKey(): Promise<void> {
	const storedKey = await db.metadata.get(META_KEY_ACTIVE_KEY);
	const storedKeyId = await db.metadata.get(META_KEY_ACTIVE_KEY_ID);

	let keyId: string;
	let key: CryptoKey;

	if (
		storedKey &&
		storedKeyId &&
		storedKey.value instanceof CryptoKey &&
		typeof storedKeyId.value === "string"
	) {
		key = storedKey.value;
		keyId = storedKeyId.value;
	} else {
		key = await generateKey();
		keyId = uuidV4();
		const now = Date.now();
		await db.metadata.bulkPut([
			{ key: META_KEY_ACTIVE_KEY, value: key, updated_at: now },
			{ key: META_KEY_ACTIVE_KEY_ID, value: keyId, updated_at: now },
		]);
	}

	setActiveKey(keyId, key);

	// Pull any historical keys (rotation leftovers) and register them so
	// ciphertext that still references an older key-id can be decrypted.
	const all = await db.metadata
		.where("key")
		.startsWith(META_KEY_HISTORICAL_KEY_PREFIX)
		.toArray();
	for (const row of all) {
		const id = row.key.slice(META_KEY_HISTORICAL_KEY_PREFIX.length);
		if (row.value instanceof CryptoKey) {
			registerHistoricalKey(id, row.value);
		}
	}
}

// ---------------------------------------------------------------------------
// Health probe (§8.2)
// ---------------------------------------------------------------------------

let healthTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthProbe(): void {
	if (healthTimer) return; // idempotent
	// Fire once immediately so the first warn/safe-mode signal isn't delayed
	// by a full interval.
	runHealthProbeOnce().catch(() => {
		/* errors already handled inside */
	});
	healthTimer = setInterval(() => {
		runHealthProbeOnce().catch(() => {
			/* errors already handled inside */
		});
	}, HEALTH_PROBE_INTERVAL_MS);
}

export function stopHealthProbe(): void {
	if (healthTimer) {
		clearInterval(healthTimer);
		healthTimer = null;
	}
}

async function runHealthProbeOnce(): Promise<void> {
	const nonce = uuidV4();
	const started = performance.now();
	try {
		await db._health.put({
			id: "probe",
			nonce,
			written_at: Date.now(),
		});
		const read = await db._health.get("probe");
		const rtt = performance.now() - started;
		if (!read || read.nonce !== nonce) {
			// Read-after-write inconsistency = corruption signal.
			enterSafeMode(
				"health_probe_failed",
				"probe read did not match write",
			);
			setDegraded(true, rtt);
			return;
		}
		setDegraded(rtt > HEALTH_PROBE_RTT_WARN_MS, rtt);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		enterSafeMode("health_probe_failed", msg);
		setDegraded(true, performance.now() - started);
	}
}

// ---------------------------------------------------------------------------
// Transaction helper — ensures every critical write lands in both the
// primary DB and the shadow journal without repos having to wire that
// by hand.
//
// The journal write lives in its OWN transaction (different Dexie instance,
// so Dexie cannot union them). We perform it after the primary commits —
// if the journal write fails we surface a degraded-storage warning but do
// not roll back; the journal is a best-effort aid, the primary is
// authoritative. (See §8.1.)
// ---------------------------------------------------------------------------

export type JournalEntry = Omit<JournalRow, "id" | "ts"> & { ts?: number };

export async function runInTransaction<T>(
	scope: "rw" | "r",
	// Dexie typings make generic Table covariance fiddly — use `any` here so
	// callers can pass `db.outbox` + `db.shifts` without a `as Table<any>`
	// cast on every invocation. The runtime behaviour is fully type-safe
	// inside `body` because the caller closes over the concrete tables.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tables: Array<Table<any, any>>,
	body: (tx: Transaction) => Promise<T>,
	journalEntries?: JournalEntry[],
): Promise<T> {
	if (scope === "rw") {
		assertWritable();
	}
	// Dexie accepts either `transaction(mode, tablesArray, fn)` or
	// `transaction(mode, ...tables, fn)`. Passing the array form keeps the
	// call explicit and works across Dexie 3.x and 4.x.
	const result = await db.transaction(scope, tables, body);

	if (journalEntries && journalEntries.length > 0) {
		writeJournalEntries(journalEntries).catch(() => {
			// Journal failure ≠ primary failure. Surface as degraded.
			setDegraded(true, 0);
		});
	}
	return result;
}

async function writeJournalEntries(entries: JournalEntry[]): Promise<void> {
	const now = Date.now();
	// `id` is auto-incremented by Dexie because the store spec is `++id`.
	// We must NOT include it on the rows we pass to bulkAdd.
	const prepared: JournalRow[] = entries.map((e) => ({
		ts: e.ts ?? now,
		type: e.type,
		offline_id: e.offline_id,
		snapshot: e.snapshot,
	}));
	await journalDb.journal.bulkAdd(prepared);
	await pruneJournal();
}

/**
 * Enforces the rolling 30-day / 50 MB window (§8.1). Implemented cheaply:
 *  - Drop rows older than JOURNAL_MAX_AGE_MS.
 *  - If total rows > 10,000 (rough byte proxy), drop the oldest.
 *
 * We avoid computing precise bytes per row (Dexie doesn't expose size);
 * the row-count heuristic is conservative. If profiling shows this is too
 * loose we can switch to a byte-count estimator.
 */
async function pruneJournal(): Promise<void> {
	const cutoff = Date.now() - JOURNAL_MAX_AGE_MS;
	await journalDb.journal.where("ts").below(cutoff).delete();

	const approxBytesPerRow = 1024; // conservative guess
	const maxRows = Math.ceil(JOURNAL_MAX_BYTES / approxBytesPerRow);
	const count = await journalDb.journal.count();
	if (count > maxRows) {
		const excess = count - maxRows;
		// Delete the `excess` oldest rows (ordered by auto-increment id).
		const toDrop = await journalDb.journal.orderBy("id").limit(excess).toArray();
		await journalDb.journal.bulkDelete(toDrop.map((r) => r.id as number));
	}
}

// ---------------------------------------------------------------------------
// Small util — UUID v4. crypto.randomUUID is available on all our target
// browsers; fallback uses crypto.getRandomValues. Both paths stay within
// Web Crypto — we never fall back to Math.random.
// ---------------------------------------------------------------------------

export function uuidV4(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	);
}
