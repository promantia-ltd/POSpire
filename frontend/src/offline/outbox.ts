/**
 * Outbox state machine.
 *
 * Implements the write-ahead log semantics on top of `repos/outbox.ts`: enqueue,
 * ready-pickup, retry/backoff, error classification, dependency resolution, void.
 * Consumed by sync.ts; no component talks to it directly.
 *
 * Enqueue is atomic — a single Dexie transaction. Persistence failures propagate;
 * never swallowed silently.
 */

import {
	LS_DEVICE_ID,
	OFFLINE_PREFIX_CLOSING_ENTRY,
	OFFLINE_PREFIX_CUSTOMER,
	OFFLINE_PREFIX_INVOICE,
	OFFLINE_PREFIX_MATERIAL_RECEIPT,
	OFFLINE_PREFIX_OPENING_ENTRY,
	OFFLINE_PREFIX_RETURN,
	buildProvisionalName,
} from "./constants";
import { currentCashier } from "./cashier";
import { canonicalIntegrityHash, IntegrityMismatchError } from "./crypto";
import { db, assertWritable, uuidV4 } from "./db";
import {
	assertOfflineEnabled,
	OfflineDisabledError,
	isOfflineEnabledSync,
} from "./kill-switch";
import { registerOutboxEnqueue } from "./runtime";
import { _internal as outboxRepoInternal } from "./repos/outbox";
import * as outboxRepo from "./repos/outbox";
import type {
	LastErrorCategory,
	OutboxBlockedReason,
	OutboxEnqueueAck,
	OutboxEnqueueOptions,
	OutboxEntry,
	OutboxStatus,
	OutboxType,
	StoredOutboxEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches a UUID v4 string (e.g. an offline_id). Used to distinguish a
 * provisional offline shift reference from a real server doc name. */
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The 8 valid outbox types (mirrors `OutboxType`). Runtime-guard for the
 * loosely-typed `call-registry.ts` `outboxType: string` field. */
const VALID_TYPES = new Set<OutboxType>([
	"customer",
	"material_receipt",
	"invoice",
	"return",
	"payment",
	"cash_movement",
	"opening_entry",
	"closing_entry",
]);

/** Terminal error categories. Transient ones (network_error, server_5xx, timeout) must not land here. */
const NEEDS_REVIEW_CATEGORIES = new Set<NonNullable<LastErrorCategory>>([
	"validation_error",
	"permission_error",
	"customer_missing",
	"parent_not_ready",
	"siblings_not_ready",
	"batch_or_serial_conflict",
	"stock_shortage",
	"accounting_period_closed",
	"retry_exhausted",
	"schema_mismatch",
]);

/** Retry / backoff (05-outbox-and-sync.md §4.3). */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 120_000;
export const BACKOFF_JITTER = 0.25;
export const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Enqueue notifier — the scheduler subscribes so a new entry wakes the loop.
// ---------------------------------------------------------------------------

type EnqueueListener = (entry: OutboxEntry<unknown>) => void;
const enqueueListeners = new Set<EnqueueListener>();

/** Scheduler subscribes via this. Returns an unsubscribe. */
export function onEnqueue(fn: EnqueueListener): () => void {
	enqueueListeners.add(fn);
	return () => enqueueListeners.delete(fn);
}

function notifyEnqueued(entry: OutboxEntry<unknown>): void {
	for (const fn of enqueueListeners) {
		try {
			fn(entry);
		} catch (err) {
			console.error("[outbox] enqueue listener threw", err);
		}
	}
}

/**
 * Sync-event payload. Fires once per row that transitions enqueued/in_flight
 * → synced. Consumers (Customer.vue, Invoice.vue) use this to swap any
 * in-memory references to the old offline name for the freshly-assigned
 * server doc name. The event does NOT fire for entries that voided mid-sync
 * (status stays voided in markSynced — see CAS branch).
 */
export interface SyncEvent {
	offline_id: string;
	type: OutboxType;
	server_doc_name: string;
	provisional_name: string | null;
}

type SyncListener = (event: SyncEvent) => void;
const syncListeners = new Set<SyncListener>();

/** Subscribe to sync notifications. Returns an unsubscribe. */
export function onSynced(fn: SyncListener): () => void {
	syncListeners.add(fn);
	return () => syncListeners.delete(fn);
}

function notifySynced(event: SyncEvent): void {
	for (const fn of syncListeners) {
		try {
			fn(event);
		} catch (err) {
			console.error("[outbox] sync listener threw", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Provisional naming
// ---------------------------------------------------------------------------

/**
 * Build the provisional name the component prints on the receipt. Prefix
 * depends on outbox type; returns `null` for types that do not have a
 * user-visible provisional name (payments, cash movements — the owning
 * invoice / shift carries the name).
 */
export function provisionalNameFor(
	type: OutboxType,
	offlineId: string,
): string {
	switch (type) {
		case "customer":
			return buildProvisionalName(OFFLINE_PREFIX_CUSTOMER, offlineId);
		case "invoice":
			return buildProvisionalName(OFFLINE_PREFIX_INVOICE, offlineId);
		case "material_receipt":
			return buildProvisionalName(
				OFFLINE_PREFIX_MATERIAL_RECEIPT,
				offlineId,
			);
		case "opening_entry":
			return buildProvisionalName(OFFLINE_PREFIX_OPENING_ENTRY, offlineId);
		case "closing_entry":
			return buildProvisionalName(OFFLINE_PREFIX_CLOSING_ENTRY, offlineId);
		case "return":
			return buildProvisionalName(OFFLINE_PREFIX_RETURN, offlineId);
		case "payment":
		case "cash_movement":
			// Not user-visible — fall back to a short id for logs/reconciliation.
			return `OFFLINE-${offlineId.slice(0, 8)}`;
	}
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

interface EnqueueExtras {
	/** Method path from call-registry — stashed for the scheduler drain. */
	method?: string;
	/** Parent offline_ids (dependency graph). */
	parentOfflineIds?: string[];
	/** Owning shift (invoice/closing/payment/cash_movement). */
	shiftOfflineId?: string | null;
	/** ISO date; defaults to device `YYYY-MM-DD`. */
	postingDate?: string;
	/** Cashier user; defaults to `frappe.session.user` proxy if available. */
	ownerUser?: string;
}

/**
 * Atomically enqueue an outbox entry. Throws on any failure — P-14 requires
 * we never silently drop. Kill-switch off → throws `OfflineDisabledError`.
 *
 * The returned ack matches `OutboxEnqueueAck` (the shape `call()` expects).
 * Components type-narrow on `offline === true` + `status === 'enqueued'`.
 */
export async function enqueue<T>(
	type: OutboxType,
	payload: T,
	options: EnqueueExtras & { offlineIdempotencyKey?: string } = {},
): Promise<OutboxEnqueueAck> {
	if (!VALID_TYPES.has(type)) {
		throw new TypeError(
			`outbox.enqueue: invalid outbox type "${type}". Must be one of: ${[...VALID_TYPES].join(", ")}.`,
		);
	}
	assertWritable();
	await assertOfflineEnabled(type);

	const offlineId = options.offlineIdempotencyKey ?? uuidV4();
	const provisional = provisionalNameFor(type, offlineId);
	const now = Date.now();
	const postingDate = options.postingDate ?? todayIsoDate();
	const ownerUser = options.ownerUser ?? currentCashier();
	const deviceId = readDeviceId();

	// Payload integrity hash — computed on PLAINTEXT BEFORE encryption. The
	// repo layer re-derives from the envelope and stores it; we compute up
	// front so the value is stable even if a concurrent key rotation happens
	// to re-encrypt the row later.
	const integrityHash = await canonicalIntegrityHash(payload);

	const entry: OutboxEntry<T> = {
		offline_id: offlineId,
		type,
		parent_offline_ids: options.parentOfflineIds ?? [],
		shift_offline_id: options.shiftOfflineId ?? null,
		device_id: deviceId,
		posting_date: postingDate,
		owner_user: ownerUser,
		payload,
		payload_integrity_hash: integrityHash,
		status: "enqueued",
		// IMPORTANT: rows with next_attempt_at === null are invisible to
		// `listReady` (IndexedDB doesn't index null). Stamp `now` so the
		// scheduler picks this up on its next wake.
		next_attempt_at: now,
		attempt_count: 0,
		blocked_reason: null,
		last_error_category: null,
		last_error_detail: null,
		server_doc_name: null,
		// Populated only when the scheduler hands off this row to the
		// server-side `POSpire Offline Sync Review` queue (status
		// transitions to `handed_off` at the same time). null on every
		// fresh enqueue.
		recovery_entry_name: null,
		enqueued_at: now,
		synced_at: null,
	};

	// Prepare the stored row inside the transaction body; encryption happens
	// in `toStored` (repos/outbox.ts internal).
	const stored = await outboxRepoInternal.toStored(entry);

	// Single Dexie transaction. For `closing_entry` we also bump the owning
	// shift's status (closed_pending_sync → syncing is the scheduler's job;
	// here we just mark the closing as queued so the UI stops offering
	// "reopen shift").
	const tables =
		type === "closing_entry" ? [db.outbox, db.shifts] : [db.outbox];

	try {
		await db.transaction("rw", tables, async () => {
			// Idempotency: a scheduler re-send that re-enters `call()` (e.g.
			// connectivity flipped mid-POST) will re-invoke enqueue with the
			// same `offline_id`. We MUST NOT clobber the existing row —
			// attempt_count, status, server_doc_name all need to survive.
			// Only write if the row is new.
			const existing = await db.outbox.get(offlineId);
			if (!existing) {
				await db.outbox.put(stored);
			}

			if (type === "closing_entry" && entry.shift_offline_id) {
				const shift = await db.shifts.get(entry.shift_offline_id);
				if (shift) {
					// Only transition if we're still in `open` or
					// `closed_pending_sync`. Never regress a `syncing`/`synced`
					// shift.
					if (
						shift.status === "open" ||
						shift.status === "closed_pending_sync"
					) {
						await db.shifts.put({
							...shift,
							status: "closed_pending_sync",
							closed_at: shift.closed_at ?? now,
						});
					}
				}
				// If the shift row is missing, we still persist the outbox row
				// (server-side closing handler validates the opening link).
			}
		});
	} catch (err) {
		// Propagate — P-14 demands the caller (usually the sale path) see
		// the failure. QuotaExceededError in particular must block the sale.
		throw err;
	}

	notifyEnqueued(entry as OutboxEntry<unknown>);

	return {
		offline: true,
		offline_id: offlineId,
		provisional_name: provisional,
		status: "enqueued",
	};
}

// ---------------------------------------------------------------------------
// `call()`-compatible wrapper — signature matches `OutboxEnqueueFn`.
// ---------------------------------------------------------------------------

async function enqueueFromCall(
	type: string,
	payload: Record<string, unknown>,
	options: OutboxEnqueueOptions,
): Promise<OutboxEnqueueAck> {
	if (!VALID_TYPES.has(type as OutboxType)) {
		throw new TypeError(
			`outbox.enqueueFromCall: method's outboxType "${type}" is not a valid OutboxType.`,
		);
	}
	// `call()` already injected `offline_id` into the payload. Pull it back
	// out so the outbox column reflects the same id used for server
	// idempotency.
	const keyFromPayload = typeof payload.offline_id === "string" ? payload.offline_id : undefined;
	const idempotencyKey = options.offlineIdempotencyKey ?? keyFromPayload;

	return enqueue(type as OutboxType, payload, {
		offlineIdempotencyKey: idempotencyKey,
		method: options.method,
		parentOfflineIds: options.parentOfflineIds,
		shiftOfflineId: options.shiftOfflineId,
		postingDate: options.postingDate,
		ownerUser: options.ownerUser,
	});
}

// ---------------------------------------------------------------------------
// Ready / pickup
// ---------------------------------------------------------------------------

/**
 * Returns the next ready entry, or `null` if none is eligible. "Ready" =
 * status in {enqueued, retry_pending} AND blocked_reason null AND
 * next_attempt_at <= now. Delegated to the repo.
 *
 * Does NOT claim the entry; the caller must follow up with `markInFlight`
 * (compare-and-swap) to avoid races with other tabs.
 */
export async function nextReady<T = unknown>(
	now = Date.now(),
): Promise<OutboxEntry<T> | null> {
	if (!isOfflineEnabledSync()) {
		// Don't drain while kill switch is off. The scheduler also checks this
		// each loop; belt-and-braces for callers that invoke directly.
		return null;
	}
	const rows = await outboxRepo.listReady<T>(now, 1);
	return rows[0] ?? null;
}

/**
 * Compare-and-swap claim of an entry from `enqueued`/`retry_pending` →
 * `in_flight`. Returns `true` when this caller won the race.
 *
 * Clears `blocked_reason` implicitly (entries with a non-null blocker are
 * filtered out of `listReady` in-memory — the scheduler must NOT call this
 * on a blocked row).
 */
export async function markInFlight(offlineId: string): Promise<boolean> {
	assertWritable();
	return db.transaction("rw", db.outbox, async () => {
		const row = await db.outbox.get(offlineId);
		if (!row) return false;
		if (row.status !== "enqueued" && row.status !== "retry_pending") {
			return false;
		}
		if (row.blocked_reason !== null) return false;
		await db.outbox.put({
			...row,
			status: "in_flight",
			last_error_category: null,
			last_error_detail: null,
		});
		return true;
	});
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

export async function markSynced(
	offlineId: string,
	serverDocName: string,
): Promise<void> {
	assertWritable();
	// Compare-and-swap: if a manager voided the row while the scheduler was
	// mid-POST, leave the `voided` status intact. The server will have an
	// extra doc; idempotency means a future replay returns the same name
	// without inserting a duplicate. The local audit trail (status=voided)
	// stays truthful.
	let cascade = false;
	let syncedEvent: SyncEvent | null = null;
	await db.transaction("rw", db.outbox, async () => {
		const row = await db.outbox.get(offlineId);
		if (!row) return;
		if (row.status === "voided") {
			// Persist the server name so reconciliation can still link the
			// voided local row to the remote doc, but don't change the status.
			await db.outbox.put({
				...row,
				server_doc_name: serverDocName,
			});
			return;
		}
		await db.outbox.put({
			...row,
			status: "synced",
			server_doc_name: serverDocName,
			synced_at: Date.now(),
			last_error_category: null,
			last_error_detail: null,
			blocked_reason: null,
			next_attempt_at: null,
		});
		cascade = true;
		syncedEvent = {
			offline_id: offlineId,
			type: row.type,
			server_doc_name: serverDocName,
			provisional_name: provisionalNameFor(row.type, offlineId),
		};
	});
	// Cascade-unblock any rows that were waiting on this parent (T7). Done
	// outside the synced row's transaction because we want a fresh `rw` txn
	// for the dependent puts and we don't need atomicity across the boundary.
	if (cascade) {
		await clearDependentsBlockedOn(offlineId);
	}
	// Fire after the transaction settles so listeners read durable state.
	// Voided-mid-sync rows (CAS branch above) intentionally do NOT fire —
	// the cart should not switch a voided customer's name to the server doc.
	if (syncedEvent) {
		notifySynced(syncedEvent);
	}
}

export async function markNeedsReview(
	offlineId: string,
	errorCategory: NonNullable<LastErrorCategory>,
	errorDetail: string | null,
): Promise<void> {
	assertWritable();
	if (!NEEDS_REVIEW_CATEGORIES.has(errorCategory)) {
		// `network_error` / `server_5xx` / `timeout` / `idempotent_duplicate`
		// are not terminal — caller used the wrong helper.
		throw new Error(
			`markNeedsReview called with non-terminal category "${errorCategory}"`,
		);
	}
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "needs_review",
		last_error_category: errorCategory,
		last_error_detail: errorDetail,
		// Freeze retries — manager must act.
		next_attempt_at: null,
	});
}

/**
 * Upgrade a `handed_off` tombstone after the server-side review row reaches a terminal state.
 * Resolved → synced (cascade-unblocks dependents + fires notifySynced).
 * Voided → voided (no cascade — descendants must be voided explicitly).
 * Idempotent.
 */
export async function markVacuumed(
	offlineId: string,
	resolution: "Resolved" | "Voided",
	serverDocName: string | null = null,
): Promise<void> {
	assertWritable();
	// Read the row type before updating so we can build a SyncEvent below.
	// Only needed for the Resolved + serverDocName path, so conditional.
	const rowForNotify =
		resolution === "Resolved" && serverDocName ? await db.outbox.get(offlineId) : null;
	const target: OutboxStatus = resolution === "Resolved" ? "synced" : "voided";
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: target,
		server_doc_name: serverDocName,
		next_attempt_at: null,
		// On Resolved, stamp synced_at so the row's chronology is correct.
		// On Voided, leave it null — the row was never synced in the
		// "we got a successful submit" sense.
		synced_at: resolution === "Resolved" ? Date.now() : null,
	});
	if (resolution === "Resolved") {
		// Cascade-unblock dependents (children that listed this offline_id
		// in `parent_offline_ids` and were marked `waiting_for_parent`).
		// Same call markSynced uses — keeps the two paths' semantics aligned.
		await clearDependentsBlockedOn(offlineId);
		// Mirror markSynced: fire the rename event so listeners (Invoice.vue,
		// Customer.vue) swap the provisional name for the real server name.
		// Resolved rows from the recovery pipeline always carry a server doc
		// name; skip only if somehow absent (defensive guard).
		if (rowForNotify && serverDocName) {
			notifySynced({
				offline_id: offlineId,
				type: rowForNotify.type,
				server_doc_name: serverDocName,
				provisional_name: provisionalNameFor(rowForNotify.type, offlineId),
			});
		}
	}
}

/**
 * Transition to `handed_off` tombstone. Row stays in IndexedDB for dependency resolution
 * but is excluded from the drain queue. Idempotent — safe to call multiple times.
 */
export async function markHandedOff(
	offlineId: string,
	recoveryEntryName: string,
): Promise<void> {
	assertWritable();
	if (!recoveryEntryName) {
		throw new Error(
			`markHandedOff called with empty recoveryEntryName for ${offlineId}`,
		);
	}
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "handed_off",
		recovery_entry_name: recoveryEntryName,
		// Tombstones never re-enter the scheduler. Clearing this is a
		// belt-and-braces against a bug in `listReady` ever picking up a
		// `handed_off` row by mistake.
		next_attempt_at: null,
	});
}

/**
 * Specialised transition for integrity-mismatch detection (§8.3). Moves the
 * row to `needs_review` AND flags `blocked_reason=integrity_mismatch` so the
 * reconciliation workspace knows the row should not be retried-as-is even
 * if the manager clicks Retry without editing. Uses `schema_mismatch` as
 * the `last_error_category` (closest terminal fit).
 */
export async function markIntegrityMismatch(
	offlineId: string,
	detail: string | null,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	await db.outbox.put({
		...stored,
		status: "needs_review",
		blocked_reason: "integrity_mismatch",
		last_error_category: "schema_mismatch",
		last_error_detail: detail,
		next_attempt_at: null,
	});
}

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter, capped. Returns the delay (ms) for the
 * given attempt number (1-indexed). Exported so tests can exercise edges
 * without mocking `Date`.
 */
export function computeBackoffMs(attempt: number): number {
	const raw = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(attempt - 1, 0);
	const capped = Math.min(raw, BACKOFF_CAP_MS);
	const jitter = capped * BACKOFF_JITTER;
	// Uniform ±25%.
	const delta = (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.floor(capped + delta));
}

/**
 * Schedule a retry. If `attemptCount >= MAX_ATTEMPTS` we short-circuit to
 * `needs_review` with category `retry_exhausted` (05-outbox-and-sync.md
 * §4.3).
 *
 * `errorCategory` is expected to be a transient one (`network_error`,
 * `server_5xx`, `timeout`). We store it for observability but don't gate
 * on it.
 */
export async function scheduleRetry(
	offlineId: string,
	attemptCount: number,
	errorCategory: LastErrorCategory = "network_error",
	errorDetail: string | null = null,
): Promise<void> {
	assertWritable();
	if (attemptCount >= MAX_ATTEMPTS) {
		await markNeedsReview(offlineId, "retry_exhausted", errorDetail);
		return;
	}

	const nextAt = Date.now() + computeBackoffMs(attemptCount + 1);
	await outboxRepo.updateSchedulerFields(offlineId, {
		status: "retry_pending",
		attempt_count: attemptCount,
		next_attempt_at: nextAt,
		last_error_category: errorCategory,
		last_error_detail: errorDetail,
	});
}

// ---------------------------------------------------------------------------
// Blocking / dependency management
// ---------------------------------------------------------------------------

/**
 * Mark an entry as blocked on a parent/sibling. Entry stays `enqueued` (the
 * scheduler's `listReady` filter drops anything with a non-null
 * `blocked_reason`), so no retry clock is ticking.
 */
export async function markBlocked(
	offlineId: string,
	reason: Exclude<OutboxBlockedReason, null>,
	detail: string | null = null,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	await db.outbox.put({
		...stored,
		blocked_reason: reason,
		last_error_detail: detail,
		// Keep status=enqueued; a manager Retry from the workspace will clear
		// `blocked_reason` and re-stamp `next_attempt_at`.
		status: "enqueued",
		next_attempt_at: Date.now(),
	});
}

/** Clear the block (used when a parent transitions to synced). */
export async function clearBlocked(offlineId: string): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) return;
	if (stored.blocked_reason === null) return;
	if (stored.status === "voided") return; // terminal — don't unblock
	await db.outbox.put({
		...stored,
		blocked_reason: null,
		next_attempt_at: Date.now(),
	});
}

/** Clear blocked_reason on rows that listed parentOfflineId as a parent. Optimistically unblocks; evaluateParents re-gates at drain time. */
export async function clearDependentsBlockedOn(
	parentOfflineId: string,
): Promise<void> {
	assertWritable();
	const all = await db.outbox.toArray();
	const dependents = all.filter(
		(row) =>
			row.parent_offline_ids.includes(parentOfflineId) &&
			(row.blocked_reason === "waiting_for_parent" ||
				row.blocked_reason === "waiting_for_siblings") &&
			row.status !== "voided" &&
			row.status !== "synced",
	);
	if (dependents.length === 0) return;
	await db.transaction("rw", db.outbox, async () => {
		for (const dep of dependents) {
			await db.outbox.put({
				...dep,
				blocked_reason: null,
				next_attempt_at: Date.now(),
			});
		}
	});
}

/**
 * Repair rows latched on a parent that will never arrive.
 *
 * `listReady` drops rows with a non-null `blocked_reason` before the gate
 * runs, so `evaluateParents` can never re-evaluate a row it already blocked.
 * A shift opened online has no outbox row, so any child holding its
 * `pos_offline_id` stays blocked forever without this pass.
 *
 * Drops a parent ONLY when the shifts store proves that shift reached the
 * server. Invoice, customer and material-receipt dependencies are preserved,
 * and `integrity_mismatch` blocks are never touched.
 *
 * Returns the number of rows repaired.
 */
export async function reconcileBlockedParents(): Promise<number> {
	assertWritable();

	let repaired = 0;

	// Proof lookup, row read, filter and write all inside ONE transaction. Read
	// outside it and a concurrent void/retry/status transition landing in the
	// gap would be clobbered by a stale full-object put — potentially
	// resurrecting a terminal row.
	await db.transaction("rw", db.outbox, db.shifts, async () => {
		const shiftOnServer = new Map<string, boolean>();
		for (const shift of await db.shifts.toArray()) {
			shiftOnServer.set(shift.offline_id, Boolean(shift.opening_server_name));
		}

		const rows = await db.outbox.toArray();
		const present = new Set(rows.map((r) => r.offline_id));

		for (const row of rows) {
			if (
				row.blocked_reason !== "waiting_for_parent" &&
				row.blocked_reason !== "waiting_for_siblings"
			) {
				continue;
			}
			if (row.status === "synced" || row.status === "voided") continue;

			const parents = row.parent_offline_ids ?? [];
			const keep = parents.filter(
				(pid) => present.has(pid) || !shiftOnServer.get(pid),
			);
			if (keep.length === parents.length) continue;

			const current = await db.outbox.get(row.offline_id);
			if (!current) continue;
			if (
				current.status !== row.status ||
				current.blocked_reason !== row.blocked_reason
			) {
				continue;
			}

			await db.outbox.put({
				...current,
				parent_offline_ids: keep,
				blocked_reason: null,
				next_attempt_at: Date.now(),
			});
			repaired += 1;
		}
	});

	return repaired;
}

/**
 * Resolve parent status for an entry. Returns:
 *   `ready`   → every parent is synced; entry may ship.
 *   `waiting` → at least one parent is still in-flight/enqueued; defer.
 *   `blocked` → at least one parent is in needs_review; caller marks the
 *               child blocked with `waiting_for_parent`.
 */
export type DependencyGate = "ready" | "waiting" | "blocked";

export async function evaluateParents(
	entry: OutboxEntry<unknown>,
): Promise<DependencyGate> {
	if (entry.parent_offline_ids.length === 0) return "ready";
	let blockedByParent = false;
	for (const parentId of entry.parent_offline_ids) {
		const parent = await db.outbox.get(parentId);
		if (!parent) {
			// A shift opened ONLINE never gets an outbox row, but children
			// still carry its `pos_offline_id` as a parent. The shifts store
			// records the server name once the opening exists server-side, so
			// there is nothing left to wait for. Any other missing parent is
			// still a hard block: we can't reason about its status.
			const shift = await db.shifts.get(parentId);
			if (shift?.opening_server_name) continue;
			blockedByParent = true;
			continue;
		}
		if (parent.status === "synced") continue;
		if (
			parent.status === "needs_review" ||
			parent.status === "voided" ||
			// handed_off means the server-side recovery row is still pending; child must wait.
			parent.status === "handed_off"
		) {
			blockedByParent = true;
			continue;
		}
		// in_flight / retry_pending / enqueued → still waiting
		return "waiting";
	}
	return blockedByParent ? "blocked" : "ready";
}

/**
 * Gate a `closing_entry` until every invoice in the same shift is synced.
 * Uses `shift_offline_id` index for offline-opened shifts; falls back to
 * scanning invoice inner docs when the shift was opened online (shift_offline_id is null).
 */
export async function evaluateClosingReadiness(
	entry: OutboxEntry<unknown>,
): Promise<DependencyGate> {
	if (entry.type !== "closing_entry") return "ready";

	let siblings: typeof entry[] = [];
	if (entry.shift_offline_id) {
		// Fast path — index seek.
		siblings = (await db.outbox
			.where("shift_offline_id")
			.equals(entry.shift_offline_id)
			.toArray()) as unknown as typeof entry[];
	} else {
		// Slow path — derive the shift's real name from the closing's own
		// inner doc, then scan invoice rows by their inner shift reference.
		const closingShiftName = readInnerShiftName(entry.payload);
		if (!closingShiftName) return "ready"; // can't gate without an anchor
		const allInvoices = (await db.outbox
			.where("type")
			.equals("invoice")
			.toArray()) as unknown as typeof entry[];
		siblings = allInvoices.filter((row) => {
			if (row.shift_offline_id) return false; // different (offline) shift
			const inner = readInnerShiftName(row.payload);
			return inner === closingShiftName;
		});
	}

	let blockedBySibling = false;
	for (const s of siblings) {
		// Closing entry itself, voided entries, and non-invoice types do not
		// gate closure.
		if (s.offline_id === entry.offline_id) continue;
		if (s.status === "voided") continue;
		if (s.type !== "invoice") continue;
		if (s.status === "synced") continue;
		if (s.status === "needs_review" || s.status === "handed_off") {
			// `handed_off` mirrors `needs_review` for closure-readiness:
			// the sibling's work hasn't completed server-side, so the
			// strict-closure invariant ("every invoice on this shift is
			// submitted") doesn't hold. Block the closing until the
			// recovery row resolves and the local vacuum upgrades this
			// sibling's tombstone to `synced`.
			blockedBySibling = true;
			continue;
		}
		return "waiting";
	}
	return blockedBySibling ? "blocked" : "ready";
}

/**
 * Best-effort extraction of the inner doc's `posa_pos_opening_shift` from
 * an outbox payload. Outbox payloads for offline-capable writes use the
 * wrapper shape `{ data: "<JSON inner doc>", … }`; for non-wrapper shapes
 * (legacy entries) we read the field directly. Falls back to the wrapper's
 * `opening_entry_ref` (excluding UUIDs, which anchor offline-opened shifts
 * via `shift_offline_id` instead) for rows queued before the inner doc
 * carried the shift name. Returns `null` if nothing usable is found.
 *
 * Exported: Task 10 imports this by name from `@/offline/outbox`.
 */
export function readInnerShiftName(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (typeof p.data === "string") {
		try {
			const inner = JSON.parse(p.data) as Record<string, unknown>;
			const name =
				(inner.posa_pos_opening_shift as string | undefined) ??
				(inner.pos_opening_shift as string | undefined);
			if (typeof name === "string" && name.length > 0) return name;
		} catch {
			/* fall through to the wrapper */
		}
	} else {
		const direct =
			(p.posa_pos_opening_shift as string | undefined) ??
			(p.pos_opening_shift as string | undefined);
		if (typeof direct === "string" && direct.length > 0) return direct;
	}

	// Back-compat: rows queued before the stamp landed carry the shift
	// reference only on the wrapper. A UUID there means an OFFLINE-opened
	// shift, which is anchored by `shift_offline_id` instead — returning it
	// here would compare a UUID against a server name and never match.
	const ref = p.opening_entry_ref;
	if (typeof ref === "string" && ref.length > 0 && !UUID_V4_PATTERN.test(ref)) {
		return ref;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Payload resolution (offline_id → server_doc_name)
// ---------------------------------------------------------------------------

/**
 * Pass payload through unchanged. The server is the authoritative resolver of
 * offline UUIDs to real doc names — front-end pre-resolution would corrupt
 * wrapper protocol fields (`opening_entry_offline_id` etc.) that the server
 * expects as UUIDs.
 */
export async function resolvePayload<T>(
	entry: OutboxEntry<T>,
): Promise<T> {
	return entry.payload;
}

// ---------------------------------------------------------------------------
// Void (business action — row stays, never deleted)
// ---------------------------------------------------------------------------

/**
 * Void an outbox entry. Business action: row remains for audit with
 * `status=voided`; `last_error_detail` stores the reason. Never deletes.
 */
export async function voidEntry(
	offlineId: string,
	reason: string,
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "synced") {
		throw new Error(
			`Cannot void ${offlineId}: already synced as ${stored.server_doc_name}. Use a reversal, not a void.`,
		);
	}
	await db.outbox.put({
		...stored,
		status: "voided",
		last_error_category: stored.last_error_category,
		last_error_detail: reason,
		next_attempt_at: null,
	});
}

// ---------------------------------------------------------------------------
// Integrity verification (called by scheduler before POST)
// ---------------------------------------------------------------------------

/**
 * Re-decrypt + re-hash the payload and confirm the integrity hash matches
 * what was stored at enqueue. Mismatch / decrypt failure → the row is marked
 * needs_review with category `integrity_mismatch` and the caller must skip
 * sending. Returns the plaintext payload on success (saves the scheduler a
 * second decrypt).
 */
export async function verifyIntegrity<T>(
	entry: OutboxEntry<T>,
): Promise<{ ok: true; payload: T } | { ok: false; detail: string }> {
	try {
		// The repo's `fromStored` already verifies via the envelope's own
		// hash (IntegrityMismatchError in crypto.ts). We also confirm the
		// sibling column `payload_integrity_hash` agrees — if it's been
		// tampered with in-place the values will diverge.
		const recomputed = await canonicalIntegrityHash(entry.payload);
		if (recomputed !== entry.payload_integrity_hash) {
			return {
				ok: false,
				detail: `stored_hash=${entry.payload_integrity_hash} recomputed=${recomputed}`,
			};
		}
		return { ok: true, payload: entry.payload };
	} catch (err) {
		if (err instanceof IntegrityMismatchError) {
			return { ok: false, detail: err.message };
		}
		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// Light read helpers re-exposed (scheduler, UI badge)
// ---------------------------------------------------------------------------

export async function getEntry<T = unknown>(
	offlineId: string,
): Promise<OutboxEntry<T> | undefined> {
	return outboxRepo.getOutboxEntry<T>(offlineId);
}

export async function listByStatus<T = unknown>(
	status: OutboxStatus,
): Promise<OutboxEntry<T>[]> {
	return outboxRepo.listByStatus<T>(status);
}

/**
 * Invoice rows across several statuses, resilient to a single corrupt row —
 * see `repos/outbox.listInvoiceRowsAcrossStatuses` for why this exists
 * instead of composing `listByStatus` calls.
 */
export async function listInvoiceRowsAcrossStatuses(
	statuses: OutboxStatus[],
): ReturnType<typeof outboxRepo.listInvoiceRowsAcrossStatuses> {
	return outboxRepo.listInvoiceRowsAcrossStatuses(statuses);
}

export async function countPending(): Promise<number> {
	return outboxRepo.countPending();
}

/**
 * Sync-state of every queued closing entry, read off plaintext columns only.
 * See `repos/outbox.listClosingEntryStatuses` for why this is not a set of
 * `listByStatus()` sweeps.
 */
export async function listClosingEntryStatuses(): ReturnType<
	typeof outboxRepo.listClosingEntryStatuses
> {
	return outboxRepo.listClosingEntryStatuses();
}

/**
 * Edit & Retry: mutate the queued payload, re-encrypt, recompute integrity hash,
 * reset status to enqueued, and wake the scheduler. Refuses on voided/synced rows.
 */
export async function patchPayloadAndReset(
	offlineId: string,
	patchedPayload: unknown,
	indexedOverrides: {
		posting_date?: string;
		parent_offline_ids?: string[];
	} = {},
): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "voided") {
		throw new Error(
			`Cannot edit ${offlineId}: row is voided. Re-create the entry instead.`,
		);
	}
	if (stored.status === "synced") {
		throw new Error(
			`Cannot edit ${offlineId}: already synced as ${stored.server_doc_name}. Use a reversal, not an edit.`,
		);
	}

	// Re-encrypt + re-hash the patched payload. Keep the existing top-level
	// fields the caller didn't override (device_id, owner_user, type, etc.) —
	// those are bound to the original write context and changing them would
	// change attribution.
	const integrityHash = await canonicalIntegrityHash(patchedPayload);
	const newEntry: OutboxEntry<unknown> = {
		// Decrypt the existing entry so we have the full plain shape, then
		// override the mutable bits. Avoids the caller having to re-supply
		// fields they don't intend to touch.
		...(await outboxRepoInternal.fromStored(stored)),
		payload: patchedPayload,
		payload_integrity_hash: integrityHash,
		// Reset the lifecycle so the scheduler picks it back up.
		status: "enqueued",
		blocked_reason: null,
		attempt_count: 0,
		next_attempt_at: Date.now(),
		last_error_category: null,
		last_error_detail: null,
	};
	if (indexedOverrides.posting_date !== undefined) {
		newEntry.posting_date = indexedOverrides.posting_date;
	}
	if (indexedOverrides.parent_offline_ids !== undefined) {
		newEntry.parent_offline_ids = indexedOverrides.parent_offline_ids;
	}

	const newStored = await outboxRepoInternal.toStored(newEntry);
	await db.outbox.put(newStored);

	// Wake the scheduler. Pass the in-memory entry so listeners don't need
	// to decrypt again.
	notifyEnqueued(newEntry);

	// Cascade-unblock dependents (mirrors resetForRetry — same reason).
	await clearDependentsBlockedOn(offlineId);
}

/** Manager "Retry" action — clears needs_review/blocked and re-queues. */
export async function resetForRetry(offlineId: string): Promise<void> {
	assertWritable();
	const stored = await db.outbox.get(offlineId);
	if (!stored) throw new Error(`outbox ${offlineId} not found`);
	if (stored.status === "voided") return; // terminal — refuse to revive

	// Notify with post-update shape so subscribers see current status immediately.
	const updatedStored = {
		...stored,
		status: "enqueued" as const,
		blocked_reason: null,
		attempt_count: 0,
		next_attempt_at: Date.now(),
		last_error_category: null,
		last_error_detail: null,
	};
	await db.outbox.put(updatedStored);
	// Wake the scheduler with the fresh state, not the stale snapshot.
	notifyEnqueued(await outboxRepoInternal.fromStored(updatedStored));
	// Cascade-unblock dependents that were parked on this parent (T7).
	// They'll re-evaluate parents on the next drain — if this one is now
	// in retry_pending/in_flight, they'll move to "waiting" not "blocked",
	// keeping them out of the workspace's manual-action queue.
	await clearDependentsBlockedOn(offlineId);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Exported so `shift-lifecycle.ts` (and any other module that needs to
 * stamp a device id outside the outbox's own enqueue path) reuses this
 * exact fallback logic instead of growing a second copy. `audit-export.ts`
 * still carries its own pre-existing duplicate; not touched here.
 */
export function readDeviceId(): string {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem(LS_DEVICE_ID) ?? "unknown-device";
		}
	} catch {
		/* strict-privacy browsers */
	}
	return "unknown-device";
}

function todayIsoDate(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Runtime registration — wires `@/utils/call` to this module. Executed at
// module-init time so any component that imports from `@/offline/outbox`
// also triggers the registration.
// ---------------------------------------------------------------------------

registerOutboxEnqueue(enqueueFromCall);

// Re-export the error type so callers (UI banner) can catch by type without
// knowing about the kill-switch module.
export { OfflineDisabledError };

// Re-export the raw stored row type for the audit-export module.
export type { StoredOutboxEntry };
