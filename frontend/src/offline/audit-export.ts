/**
 * Safe-mode audit-trail export (task 1.18).
 *
 * When Dexie enters safe mode (03-storage-layer.md §8), the primary DB is
 * considered untrustworthy but the shadow journal may still hold
 * reconstructable copies of unsynced outbox rows. We serialise the journal's
 * remaining outbox-related entries and ship them to the server via
 * `pospire.pospire.api.offline.submit_recovery_log` for later
 * reconstruction.
 *
 * The export body shape matches the server endpoint signature in
 * `offline.py::submit_recovery_log`:
 *   { device_id, journal_blob (base64), recovered_at (ISO) }
 *
 * We deliberately do NOT decrypt or redact on the client. The journal row
 * already carries the encrypted envelopes as `snapshot`; the server stores
 * them as-is for ops to decrypt on a recovery tablet.
 */

import { LS_DEVICE_ID } from "./constants";
import { db, getSafeMode, journalDb } from "./db";
import { call } from "@/utils/call";
import type { JournalRow, OutboxStatus } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AuditExportResult {
	/** How many journal rows were included in the blob. */
	rows_exported: number;
	/** Server-issued handle for later lookup. */
	server_name?: string;
	/** Epoch ms at which the export completed. */
	exported_at: number;
	/** Set when the export was skipped because there was nothing to send. */
	skipped?: "no_unsynced" | "safe_mode_inactive";
}

/**
 * Serialise and upload unsynced outbox rows from the shadow journal.
 *
 * Caller typically wires this to an `onSafeModeChange(active → true)`
 * listener registered from `Pos.vue` (or the Phase 2 root component). The
 * function is idempotent and safe to re-invoke; the server endpoint
 * dedupes by `device_id + recovered_at`.
 */
export async function exportAuditTrail(options?: {
	/** When true, bypass the safe-mode gate (manual ops-driven export). */
	force?: boolean;
}): Promise<AuditExportResult> {
	const force = options?.force ?? false;
	const safeMode = getSafeMode();
	if (!force && !safeMode.active) {
		return {
			rows_exported: 0,
			exported_at: Date.now(),
			skipped: "safe_mode_inactive",
		};
	}

	const unsyncedOfflineIds = await collectUnsyncedOfflineIds();
	const journalRows = await collectJournalRows(unsyncedOfflineIds);

	if (journalRows.length === 0) {
		return {
			rows_exported: 0,
			exported_at: Date.now(),
			skipped: "no_unsynced",
		};
	}

	const blob = serialiseJournalRows(journalRows);
	const recoveredAt = new Date().toISOString();

	const res = (await call({
		method: "pospire.pospire.api.offline.submit_recovery_log",
		args: {
			device_id: readDeviceId(),
			journal_blob: blob,
			recovered_at: recoveredAt,
		},
		intent: "write",
	})) as { name?: string } | undefined;

	return {
		rows_exported: journalRows.length,
		server_name: res?.name,
		exported_at: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const UNSYNCED_STATUSES: OutboxStatus[] = [
	"enqueued",
	"in_flight",
	"retry_pending",
	"needs_review",
];

async function collectUnsyncedOfflineIds(): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		const rows = await db.outbox
			.where("status")
			.anyOf(UNSYNCED_STATUSES)
			.toArray();
		for (const r of rows) ids.add(r.offline_id);
	} catch {
		// Primary may be unreadable (why we're exporting at all). Fall back
		// to "everything in the journal" — the server can sort by
		// offline_id server-side.
	}
	return ids;
}

async function collectJournalRows(
	focusIds: Set<string>,
): Promise<JournalRow[]> {
	try {
		const all = await journalDb.journal
			.where("type")
			.anyOf(["outbox_put", "outbox_status_change"])
			.toArray();
		if (focusIds.size === 0) return all;
		return all.filter(
			(r) => r.offline_id !== null && focusIds.has(r.offline_id),
		);
	} catch {
		return [];
	}
}

/**
 * Encode the journal rows as base64 so the wire transport is a simple
 * opaque blob (the server stores it as-is). We deliberately choose
 * base64(JSON) rather than bson/msgpack so ops can grep the blob with
 * standard tooling in the worst case.
 */
function serialiseJournalRows(rows: JournalRow[]): string {
	const json = JSON.stringify(rows, binarySafeReplacer);
	return utf8ToBase64(json);
}

/**
 * Replace `Uint8Array` values with `{ __u8: base64 }` so they survive
 * JSON. The shadow-journal rows mirror encrypted envelopes which contain
 * `Uint8Array` fields for IV / ciphertext.
 */
function binarySafeReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { __u8: bytesToBase64(value) };
	}
	return value;
}

function utf8ToBase64(s: string): string {
	if (typeof TextEncoder !== "undefined" && typeof btoa === "function") {
		const bytes = new TextEncoder().encode(s);
		return bytesToBase64(bytes);
	}
	// Node test environment fallback.
	return Buffer.from(s, "utf-8").toString("base64");
}

function bytesToBase64(bytes: Uint8Array): string {
	if (typeof btoa === "function") {
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]!);
		}
		return btoa(binary);
	}
	return Buffer.from(bytes).toString("base64");
}

function readDeviceId(): string {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem(LS_DEVICE_ID) ?? "unknown-device";
		}
	} catch {
		/* ignore */
	}
	return "unknown-device";
}
