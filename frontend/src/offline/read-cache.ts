/**
 * ReadCache adapters for `@/utils/call`.
 *
 * InMemoryReadCache — Phase 1 baseline. Plain Map, fast, reset on reload.
 *   Still used directly by unit tests.
 *
 * DexieMetadataReadCache — Phase 2 default (registered in App.vue).
 *   Layers a raw in-memory Map over the existing `metadata` Dexie table
 *   (rows prefixed "rc:") so certain cached reads survive page reloads.
 *
 *   Storage boundary: only keys in DURABLE_KEYS are persisted to Dexie.
 *   All other `offline: true` reads remain memory-only so PII-containing
 *   payloads (customer names, mobile_no, email_id from get_customer_names,
 *   and catalogue data from get_items) never reach the unencrypted metadata
 *   table. DURABLE_KEYS must contain only non-PII reference data.
 *
 *   Other design notes:
 *   - Original cachedAt is preserved on Dexie→memory promotion (never
 *     reset to Date.now()) so staleness semantics stay correct.
 *   - Dexie errors are swallowed — in-memory covers the current session.
 *   - `clearAllTables()` in `offline-fixture.ts` deletes all non-`crypto.*`
 *     metadata rows between tests, so rc: rows are isolated per test.
 */

import { db } from "./db";
import type { MetadataRow, ReadCache } from "./types";

/** Extends the minimal ReadCache return type with a staleness flag so callers
 *  can branch without re-checking age themselves. `call.ts` ignores the stale
 *  field (it adds its own stale:true when serving from cache), but components
 *  that read the cache directly benefit from it. */
type CachedRead<T> = { data: T; cachedAt: number; stale: boolean };

interface CacheEntry {
	data: unknown;
	cachedAt: number;
	ttlMs: number | null;
}

// ---------------------------------------------------------------------------
// InMemoryReadCache — Phase 1 baseline, kept for unit tests.
// ---------------------------------------------------------------------------

export class InMemoryReadCache implements ReadCache {
	private readonly store = new Map<string, CacheEntry>();

	async read<T>(cacheKey: string): Promise<CachedRead<T> | null> {
		const entry = this.store.get(cacheKey);
		if (!entry) return null;
		const age = Date.now() - entry.cachedAt;
		const stale = entry.ttlMs !== null && age > entry.ttlMs;
		return { data: entry.data as T, cachedAt: entry.cachedAt, stale };
	}

	async write<T>(cacheKey: string, value: T, ttlMs?: number): Promise<void> {
		this.store.set(cacheKey, {
			data: value,
			cachedAt: Date.now(),
			ttlMs: ttlMs ?? null,
		});
	}

	async invalidate(cacheKey: string): Promise<void> {
		this.store.delete(cacheKey);
	}

	/** Test/diagnostic: drop everything. */
	clear(): void {
		this.store.clear();
	}
}

// ---------------------------------------------------------------------------
// DexieMetadataReadCache — Phase 2 persistent cache.
// ---------------------------------------------------------------------------

const RC_PREFIX = "rc:";

/**
 * Cache keys that may be durably persisted to the Dexie `metadata` table.
 * Every key here MUST be non-PII reference data. Customer/catalogue payloads
 * from endpoints like `get_customer_names` or `get_items` must NOT be added
 * — those belong in their own encrypted domain repos (Dexie `customers` /
 * `items` tables).
 */
const DURABLE_KEYS: ReadonlySet<string> = new Set([
	"dashboard.shift", // shift dashboard cards + graph/table payload
	"offline.customer_form_options", // territory / gender / customer-group lists
	// Opening-dialog reference data: companies, POS profile names, POS Payment
	// Method rows (server explicitly selects only `parent` + `mode_of_payment`
	// — NOT fields=["*"], which would also return `owner`/`modified_by` staff
	// emails, see pospire/pospire/api/posapp.py::get_opening_dialog_data),
	// denomination policy. No PII, no catalogue — qualifies under the
	// allowlist contract above. Durable because the dialog is unusable
	// without it and the cashier often reaches it only after a reload,
	// offline. Do not widen get_opening_dialog_data's response (server OR
	// client side) without re-checking this — a future `fields=["*"]` or an
	// added PII field on the doctype would silently defeat the allowlist.
	"offline.opening_dialog_data",
]);

/**
 * Durable key PREFIXES, for datasets that are scoped to something the exact
 * allowlist can't enumerate. `offline.tax_config:<pos profile>` is per
 * profile: one fixed key would serve the previous profile's tax rates after a
 * switch, which undercharges. Same non-PII contract as DURABLE_KEYS above:
 * tax config is account heads and rates, admin configuration only.
 */
const DURABLE_KEY_PREFIXES: readonly string[] = ["offline.tax_config:"];

function isDurableKey(cacheKey: string): boolean {
	return (
		DURABLE_KEYS.has(cacheKey) ||
		DURABLE_KEY_PREFIXES.some((prefix) => cacheKey.startsWith(prefix))
	);
}

export class DexieMetadataReadCache implements ReadCache {
	/** In-memory layer: fast reads within the session, original cachedAt kept. */
	private readonly mem = new Map<string, CacheEntry>();

	async read<T>(cacheKey: string): Promise<CachedRead<T> | null> {
		// Fast path: in-memory hit (no Dexie round-trip).
		const memEntry = this.mem.get(cacheKey);
		if (memEntry) {
			const stale =
				memEntry.ttlMs !== null &&
				Date.now() - memEntry.cachedAt > memEntry.ttlMs;
			return { data: memEntry.data as T, cachedAt: memEntry.cachedAt, stale };
		}

		// Non-durable keys are memory-only — skip the Dexie lookup entirely.
		if (!isDurableKey(cacheKey)) return null;

		// Persistent fallback: Dexie metadata table (survives reload).
		try {
			const row = (await db.metadata.get(RC_PREFIX + cacheKey)) as
				| MetadataRow<CacheEntry>
				| undefined;
			if (!row) return null;
			const v = row.value;
			// Promote with ORIGINAL cachedAt — setting Date.now() here would
			// corrupt staleness semantics on subsequent in-memory reads.
			this.mem.set(cacheKey, v);
			const stale = v.ttlMs !== null && Date.now() - v.cachedAt > v.ttlMs;
			return { data: v.data as T, cachedAt: v.cachedAt, stale };
		} catch {
			return null;
		}
	}

	async write<T>(cacheKey: string, value: T, ttlMs?: number): Promise<void> {
		const cachedAt = Date.now();
		const entry: CacheEntry = { data: value, cachedAt, ttlMs: ttlMs ?? null };
		this.mem.set(cacheKey, entry);
		// Only persist allowlisted non-PII keys to the unencrypted metadata table.
		if (!isDurableKey(cacheKey)) return;
		try {
			await db.metadata.put({
				key: RC_PREFIX + cacheKey,
				value: entry,
				updated_at: cachedAt,
			} as MetadataRow<CacheEntry>);
		} catch {
			// Non-fatal — in-memory still covers this session.
		}
	}

	/** Drop a single cached key from both layers. Used on logout. */
	async invalidate(cacheKey: string): Promise<void> {
		this.mem.delete(cacheKey);
		if (!isDurableKey(cacheKey)) return;
		try {
			await db.metadata.delete(RC_PREFIX + cacheKey);
		} catch {
			/* non-fatal — the memory layer is already cleared */
		}
	}

	/** Diagnostic: clear in-memory layer and all rc: rows from Dexie. */
	clear(): void {
		this.mem.clear();
		db.metadata
			.toArray()
			.then((rows) => {
				const keys = rows
					.filter((r) => r.key.startsWith(RC_PREFIX))
					.map((r) => r.key);
				return db.metadata.bulkDelete(keys);
			})
			.catch(() => {
				/* non-fatal */
			});
	}
}
