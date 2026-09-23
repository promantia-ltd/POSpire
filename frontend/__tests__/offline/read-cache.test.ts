/**
 * ReadCache tests.
 *
 * InMemoryReadCache — Phase 1 in-memory adapter.
 *
 * DexieMetadataReadCache — Phase 2 persistent adapter with an explicit
 * DURABLE_KEYS allowlist. Tests use the real `db` singleton backed by
 * `fake-indexeddb` (installed globally in setup.ts) and call
 * `setupOfflineStorage()` to get a clean slate between runs.
 *
 * Key invariants under test:
 *   - Allowlisted keys (offline.customer_form_options) are persisted to
 *     Dexie and survive a fresh instance (i.e. a page reload).
 *   - Non-allowlisted keys (e.g. get_customer_names) are memory-only and
 *     never reach the unencrypted metadata table.
 *   - Original cachedAt is preserved when a Dexie row is promoted to memory;
 *     staleness semantics remain correct on both first and subsequent reads.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { DexieMetadataReadCache, InMemoryReadCache } from "@/offline/read-cache";
import {
	clearAllTables,
	hardTeardownOfflineStorage,
	setupOfflineStorage,
} from "../helpers/offline-fixture";
import { db } from "@/offline/db";

// Stable allowlisted key used throughout the DexieMetadataReadCache tests.
const DURABLE_KEY = "offline.customer_form_options";
// A non-allowlisted key that represents a PII-containing endpoint.
const NON_DURABLE_KEY = "pospire.pospire.api.posapp.get_customer_names::{}";

// ---------------------------------------------------------------------------
// InMemoryReadCache
// ---------------------------------------------------------------------------

describe("InMemoryReadCache", () => {
	it("returns null for an unknown key", async () => {
		const cache = new InMemoryReadCache();
		expect(await cache.read("missing")).toBeNull();
	});

	it("round-trips a value with stale=false (no TTL)", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("k", { items: [1, 2, 3] });
		const entry = await cache.read<{ items: number[] }>("k");
		expect(entry).not.toBeNull();
		expect(entry!.data).toEqual({ items: [1, 2, 3] });
		expect(typeof entry!.cachedAt).toBe("number");
		expect(entry!.stale).toBe(false);
	});

	it("marks an entry stale once age > ttlMs", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("k", "v", 1);
		await new Promise((r) => setTimeout(r, 5));
		const entry = await cache.read<string>("k");
		expect(entry!.stale).toBe(true);
		expect(entry!.data).toBe("v");
	});

	it("clear() removes all entries", async () => {
		const cache = new InMemoryReadCache();
		await cache.write("a", 1);
		await cache.write("b", 2);
		cache.clear();
		expect(await cache.read("a")).toBeNull();
		expect(await cache.read("b")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// DexieMetadataReadCache
// ---------------------------------------------------------------------------

describe("DexieMetadataReadCache", () => {
	beforeEach(async () => {
		await setupOfflineStorage();
	});

	afterEach(async () => {
		await clearAllTables();
	});

	afterAll(async () => {
		await hardTeardownOfflineStorage();
	});

	// ---- Allowlist boundary ------------------------------------------------

	it("allowlisted key is persisted to Dexie — fresh instance reads it back (simulates reload)", async () => {
		const data = {
			customer_groups: ["Retail", "Walk-In"],
			territories: ["All Territories"],
			genders: ["Male", "Female", "Other"],
		};
		// Instance A: first online boot — warm the cache.
		await new DexieMetadataReadCache().write(DURABLE_KEY, data, 12 * 60 * 60 * 1000);

		// Instance B: fresh in-memory layer (simulates page reload).
		const entry = await new DexieMetadataReadCache().read<typeof data>(DURABLE_KEY);
		expect(entry).not.toBeNull();
		expect(entry!.data).toEqual(data);
		expect(entry!.stale).toBe(false);
	});

	it("non-allowlisted key is memory-only — NOT written to Dexie", async () => {
		const cache = new DexieMetadataReadCache();
		const piiPayload = [{ customer_name: "John", mobile_no: "9999", email_id: "j@example.com" }];

		await cache.write(NON_DURABLE_KEY, piiPayload);

		// In-memory: readable within this session.
		expect((await cache.read(NON_DURABLE_KEY))?.data).toEqual(piiPayload);

		// NOT in Dexie metadata table.
		const row = await db.metadata.get("rc:" + NON_DURABLE_KEY);
		expect(row).toBeUndefined();

		// A fresh instance (simulating reload) cannot recover it.
		expect(await new DexieMetadataReadCache().read(NON_DURABLE_KEY)).toBeNull();
	});

	it("returns null for a key never written", async () => {
		expect(await new DexieMetadataReadCache().read(DURABLE_KEY)).toBeNull();
	});

	// ---- cachedAt preservation on promotion --------------------------------

	it("preserves original cachedAt on Dexie→memory promotion — stale stays stale on second read", async () => {
		// Write the allowlisted key with a 1ms TTL, then let it expire.
		const cacheA = new DexieMetadataReadCache();
		await cacheA.write(DURABLE_KEY, { customer_groups: [], territories: [], genders: [] }, 1);
		await new Promise((r) => setTimeout(r, 5));

		// Instance B: fresh in-memory layer — Dexie fallback for first read.
		const cacheB = new DexieMetadataReadCache();
		const first = await cacheB.read(DURABLE_KEY);
		expect(first!.stale).toBe(true);

		// Second read: served from in-memory (promoted). Must still be stale —
		// cachedAt must equal the stored value, NOT Date.now() at promotion time.
		const second = await cacheB.read(DURABLE_KEY);
		expect(second!.stale).toBe(true);
		expect(second!.cachedAt).toBe(first!.cachedAt);
	});

	// ---- In-memory fast path -----------------------------------------------

	it("in-memory serves subsequent reads after Dexie row is removed", async () => {
		// Write the durable key so it lands in Dexie.
		const cacheA = new DexieMetadataReadCache();
		await cacheA.write(DURABLE_KEY, { customer_groups: ["A"], territories: [], genders: [] });

		// Instance B: first read promotes from Dexie to memory.
		const cacheB = new DexieMetadataReadCache();
		await cacheB.read(DURABLE_KEY); // promotes
		await db.metadata.delete("rc:" + DURABLE_KEY); // delete from Dexie

		// Second read is served from in-memory (no Dexie row remains).
		const entry = await cacheB.read<{ customer_groups: string[] }>(DURABLE_KEY);
		expect(entry!.data.customer_groups).toEqual(["A"]);
	});

	it("marks stale on in-memory write after TTL expires (no Dexie involved)", async () => {
		const cache = new DexieMetadataReadCache();
		// Non-durable key stays in memory only — still gets stale semantics.
		await cache.write(NON_DURABLE_KEY, "data", 1);
		await new Promise((r) => setTimeout(r, 5));
		const entry = await cache.read<string>(NON_DURABLE_KEY);
		expect(entry!.stale).toBe(true);
	});

	// ---- clear() -----------------------------------------------------------

	it("clear() empties in-memory layer and Dexie rc: rows", async () => {
		const cache = new DexieMetadataReadCache();
		await cache.write(DURABLE_KEY, { customer_groups: [], territories: [], genders: [] });
		cache.clear();
		await new Promise((r) => setTimeout(r, 10)); // settle fire-and-forget delete
		expect(await cache.read(DURABLE_KEY)).toBeNull();
		expect(await new DexieMetadataReadCache().read(DURABLE_KEY)).toBeNull();
	});

	// ---- Resilience --------------------------------------------------------

	it("Dexie write failure does not throw — in-memory still works for current session", async () => {
		const cache = new DexieMetadataReadCache();
		await db.close();
		await expect(
			cache.write(DURABLE_KEY, { customer_groups: [], territories: [], genders: [] }),
		).resolves.toBeUndefined();
		// In-memory layer has the value despite Dexie being closed.
		expect((await cache.read(DURABLE_KEY))?.data).toBeDefined();
		await setupOfflineStorage(); // re-open for remaining tests
	});

	it("does not store anything under localStorage (storage boundary check)", async () => {
		const cache = new DexieMetadataReadCache();
		await cache.write(DURABLE_KEY, { customer_groups: [], territories: [], genders: [] });
		await cache.write(NON_DURABLE_KEY, [{ customer_name: "X" }]);
		const lsKeys = Object.keys(localStorage).filter((k) => k.startsWith("pospire.rc."));
		expect(lsKeys).toHaveLength(0);
	});
});
