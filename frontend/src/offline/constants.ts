/**
 * Provisional-name prefix convention from 03-storage-layer.md §3.4.1.
 *
 * Offline-created records use these prefixes so their provisional names do
 * not collide across types before sync. The suffix is the first 8 chars of
 * the record's offline_id UUID v4.
 */

export const OFFLINE_PREFIX_CUSTOMER = "OFFLINE-CUST-";
export const OFFLINE_PREFIX_INVOICE = "OFFLINE-INV-";
export const OFFLINE_PREFIX_MATERIAL_RECEIPT = "OFFLINE-MR-";
export const OFFLINE_PREFIX_OPENING_ENTRY = "OFFLINE-OPEN-";
export const OFFLINE_PREFIX_CLOSING_ENTRY = "OFFLINE-CLOSE-";
export const OFFLINE_PREFIX_RETURN = "OFFLINE-RET-";

/** Short-form suffix length used in provisional names (first 8 of UUID). */
export const OFFLINE_SHORT_ID_LENGTH = 8;

/**
 * Builds a provisional name from a prefix constant and a full offline_id
 * UUID v4. Only the first `OFFLINE_SHORT_ID_LENGTH` chars of the UUID are
 * appended (the full UUID is always retrievable from the outbox row).
 */
export function buildProvisionalName(prefix: string, offlineId: string): string {
	return `${prefix}${offlineId.slice(0, OFFLINE_SHORT_ID_LENGTH)}`;
}

// ---------------------------------------------------------------------------
// localStorage keys — per 03-storage-layer.md §1 these are the ONLY keys
// the offline subsystem is allowed to use. If you add a new key here you
// also need to justify it in 18-open-questions.md first.
// ---------------------------------------------------------------------------

export const LS_DEVICE_ID = "pospire.device_id";
export const LS_SCHEMA_VERSION = "pospire.schema_version";
export const LS_LAST_PROFILE_SNAPSHOT_TS = "pospire.last_profile_snapshot_ts";

/**
 * Legacy posa_local_storage keys from the old posapp cache. Q-10 requires
 * these be removed (not shadowed) on first offline-enabled load. See
 * `db.ts` initialisation for the one-time cleanup call.
 */
export const LEGACY_LS_KEYS = [
	"customer_storage",
	"items_storage",
	"sales_persons_storage",
] as const;

// ---------------------------------------------------------------------------
// TTLs (stale-while-revalidate) — 03-storage-layer.md §4.3.
// Values in milliseconds so they slot directly into `Date.now() - cached_at`.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

export const TTL_ITEMS_MS = 2 * HOUR;
export const TTL_CUSTOMERS_MS = 6 * HOUR;
export const TTL_PRICE_LIST_MS = 6 * HOUR;
export const TTL_TAX_TEMPLATES_MS = 24 * HOUR;

/** Threshold beyond which shift-open is allowed to block on hydration. */
export const STALE_HYDRATION_MS = 24 * HOUR;

// ---------------------------------------------------------------------------
// Health probe / corruption recovery.
// ---------------------------------------------------------------------------

export const HEALTH_PROBE_INTERVAL_MS = 60 * 1000;
/** Warn if a probe round-trip exceeds this. */
export const HEALTH_PROBE_RTT_WARN_MS = 500;

/** Journal rolling window — whichever cap is hit first wins. */
export const JOURNAL_MAX_AGE_MS = 30 * 24 * HOUR; // 30 days
export const JOURNAL_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Schema version — bumped whenever Dexie version chain changes.
// Keep in sync with the `this.version(N)` calls in db.ts so the bootstrap
// sanity check in localStorage can detect a mid-deploy mismatch.
// ---------------------------------------------------------------------------

export const OFFLINE_SCHEMA_VERSION = 1;

export const DB_NAME_PRIMARY = "pospire_offline";
export const DB_NAME_JOURNAL = "pospire_offline_journal";
