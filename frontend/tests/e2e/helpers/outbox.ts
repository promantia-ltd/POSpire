/**
 * Read-only view of the browser's offline outbox (IndexedDB "pospire_offline",
 * table "outbox"). Payloads are encrypted, but the bookkeeping columns used
 * here (type, status, attempt_count, last_error_category) are plaintext. The
 * app exposes no window hook for queue state, so a test reads the database
 * directly. Nothing is written.
 */

import { type Page } from "@playwright/test";

export interface OutboxRow {
	type?: string;
	status?: string;
	attempt_count?: number;
	last_error_category?: string | null;
	/** Why a row is waiting on another ("waiting_for_siblings" ...), or null. */
	blocked_reason?: string | null;
	/** Name of the server-side review row a failed bill was handed to, once handed off. */
	recovery_entry_name?: string | null;
}

/** Rows currently in the page's outbox, or null if the database/table is not there. */
export async function outboxRows(page: Page): Promise<OutboxRow[] | null> {
	return page.evaluate(
		() =>
			new Promise<OutboxRow[] | null>((resolve) => {
				const open = indexedDB.open("pospire_offline");
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains("outbox")) {
						db.close();
						return resolve(null);
					}
					const all = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
					all.onerror = () => {
						db.close();
						resolve(null);
					};
					all.onsuccess = () => {
						db.close();
						resolve(
							(all.result as Record<string, unknown>[]).map((r) => ({
								type: r.type as string | undefined,
								status: r.status as string | undefined,
								attempt_count: r.attempt_count as number | undefined,
								last_error_category: (r.last_error_category as string | null | undefined) ?? null,
								blocked_reason: (r.blocked_reason as string | null | undefined) ?? null,
								recovery_entry_name: (r.recovery_entry_name as string | null | undefined) ?? null,
							})),
						);
					};
				};
			}),
	);
}

const PENDING = new Set(["enqueued", "in_flight", "retry_pending"]);

/**
 * Waits until nothing is waiting to be sent. Returns how long it took, the rows
 * at the end, and whether anything ended up needing review or handed off.
 */
export async function waitForOutboxDrain(page: Page, timeoutMs = 90_000, pollMs = 1_000) {
	const started = Date.now();
	let rows: OutboxRow[] | null = null;
	let sawEntry = false;
	while (Date.now() - started < timeoutMs) {
		rows = await outboxRows(page);
		if (rows && rows.length > 0) sawEntry = true;
		if (rows && rows.every((r) => !PENDING.has(r.status ?? ""))) {
			return {
				drained: sawEntry,
				sawEntry,
				ms: Date.now() - started,
				rows,
				needsAttention: rows.filter((r) => r.status === "needs_review" || r.status === "handed_off"),
			};
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return { drained: false, sawEntry, ms: Date.now() - started, rows: rows ?? [], needsAttention: [] as OutboxRow[] };
}
