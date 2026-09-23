/**
 * Shared helpers for offline unit/integration tests.
 *
 * Responsibilities:
 *   - Initialise `@/offline/db` so crypto is bootstrapped and the schema is
 *     open. Tests that only exercise outbox/repos can call
 *     `setupOfflineStorage()` in a `beforeEach` and get a clean slate.
 *   - Re-clear all object stores between tests so state doesn't leak.
 *   - Tear down Dexie between test FILES (vitest's `isolate: true` already
 *     gives us a fresh module graph, but `delete` is explicit insurance).
 */

import {
	db,
	initOfflineStorage,
	exitSafeMode,
	journalDb,
	stopHealthProbe,
} from "@/offline/db";

export async function setupOfflineStorage(): Promise<void> {
	// `initOfflineStorage` is idempotent and handles the crypto-key bootstrap.
	await initOfflineStorage();
	// Stop the interval part of the health probe immediately.
	stopHealthProbe();
	// The one-shot probe that `startHealthProbe` fires synchronously from
	// `initOfflineStorage` is async and may still be in-flight — its
	// read-after-write check can race under happy-dom + fake-indexeddb and
	// trip safe mode. Flush microtasks and a macrotask to let that promise
	// settle, then clear safe mode before the test body runs.
	await new Promise((r) => setTimeout(r, 0));
	exitSafeMode();
	await clearAllTables();
	// Final clear in case clearAllTables ran the probe's write-path and
	// tripped safe mode again inside the transaction.
	exitSafeMode();
}

/** Clears every object store. Does not reset the crypto key (module-level). */
export async function clearAllTables(): Promise<void> {
	try {
		await db.transaction(
			"rw",
			[
				db.items,
				db.customers,
				db.shifts,
				db.outbox,
				db.metadata,
				db._health,
				db.contributions,
			],
			async () => {
				await db.items.clear();
				await db.customers.clear();
				await db.shifts.clear();
				await db.outbox.clear();
				// Added in schema v2. Left out, contribution rows leak between
				// test cases and the first test written against the ledger
				// passes for the wrong reason.
				await db.contributions.clear();
				// Keep the crypto key rows alive — the active key was registered at
				// init; wiping metadata would leave the module with a stale key id.
				// We delete everything else by key.
				const metaRows = await db.metadata.toArray();
				for (const r of metaRows) {
					if (r.key.startsWith("crypto.")) continue;
					await db.metadata.delete(r.key);
				}
				await db._health.clear();
			},
		);
	} catch {
		/* table might not exist yet — first-time setup handles itself */
	}
	try {
		await journalDb.journal.clear();
	} catch {
		/* not always open */
	}
}

/** Per-test teardown — just stop background timers.
 *
 * We intentionally do NOT close `db` or `journalDb` here. Dexie `db` is a
 * module-level singleton; closing it mid-file leaves subsequent `beforeEach`
 * calls unable to reopen against the same module graph, surfacing as
 * `DatabaseClosedError` on every downstream test. Clearing tables in
 * `setupOfflineStorage` gives the same isolation guarantee without tearing
 * down the connection.
 */
export async function teardownOfflineStorage(): Promise<void> {
	try {
		stopHealthProbe();
	} catch {
		/* not running */
	}
}

/** Hard reset — used in `afterAll` when a file truly needs a closed DB. */
export async function hardTeardownOfflineStorage(): Promise<void> {
	try {
		stopHealthProbe();
	} catch {
		/* not running */
	}
	try {
		await db.close();
	} catch {
		/* ignore */
	}
	try {
		await journalDb.close();
	} catch {
		/* ignore */
	}
}
