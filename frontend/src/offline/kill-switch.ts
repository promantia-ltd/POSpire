/**
 * Global offline kill switch.
 *
 * `POSpire Offline Settings.enabled` (default `true`) gates the entire offline code path.
 * When false: enqueue throws `OfflineDisabledError`; the scheduler pauses.
 * Lookup is cached with a short TTL to avoid a round-trip on every enqueue.
 */

import type { OutboxType } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache key used when the switch is consulted through `@/utils/call`. */
export const KILL_SWITCH_CACHE_KEY = "offline.kill_switch";
/** Field name on the response object — kept for `parseEnabled` shape unwrap. */
const KILL_SWITCH_FIELD = "enabled";
/** TTL for the cached value. 60s keeps ops toggles snappy without spamming. */
export const KILL_SWITCH_CACHE_TTL_MS = 60_000;
const DEFAULT_ENABLED = true;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown by outbox.enqueue when the kill switch is off. Caught by name in the banner/UI. */
export class OfflineDisabledError extends Error {
	readonly outboxType: OutboxType | null;
	constructor(outboxType: OutboxType | null = null) {
		super(
			"Offline mode is disabled by an administrator. Reconnect to continue, or ask an operator to re-enable offline.",
		);
		this.name = "OfflineDisabledError";
		this.outboxType = outboxType;
	}
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface KillSwitchState {
	enabled: boolean;
	checkedAt: number;
}

let cached: KillSwitchState | null = null;

const listeners = new Set<(enabled: boolean) => void>();

export function onKillSwitchChange(
	fn: (enabled: boolean) => void,
): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function notify(enabled: boolean): void {
	for (const fn of listeners) {
		try {
			fn(enabled);
		} catch (err) {
			console.error("[kill-switch] listener threw", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fast synchronous read of the last-known kill-switch value. Returns the
 * default (enabled=true) when we have never looked it up. Prefer
 * `isOfflineEnabled()` on the hot path.
 */
export function isOfflineEnabledSync(): boolean {
	return cached?.enabled ?? DEFAULT_ENABLED;
}

/**
 * Authoritative read with TTL caching. Callers that need an up-to-date value
 * (scheduler drain, enqueue) await this; callers that just want a UI hint
 * can use `isOfflineEnabledSync`.
 *
 * Returns the cached value when fresh. On fetch failure, keeps the last
 * cached value (or the default) rather than flipping the UI into a
 * different state purely because a read failed.
 */
export async function isOfflineEnabled(): Promise<boolean> {
	if (cached && Date.now() - cached.checkedAt < KILL_SWITCH_CACHE_TTL_MS) {
		return cached.enabled;
	}

	const prev = cached?.enabled;
	const fetched = await fetchKillSwitch();

	cached = { enabled: fetched, checkedAt: Date.now() };

	if (prev !== undefined && prev !== fetched) {
		notify(fetched);
	}

	return fetched;
}

/**
 * Throws `OfflineDisabledError` when the switch is off. Used by `enqueue`
 * and by the scheduler before each drain attempt.
 */
export async function assertOfflineEnabled(
	type: OutboxType | null = null,
): Promise<void> {
	const enabled = await isOfflineEnabled();
	if (!enabled) {
		// Diagnostic log: this throw blocks the cashier's submit, so the
		// console MUST capture enough context to root-cause "why is the
		// switch off here?" without re-running the failing request. Cache
		// age tells us whether we're serving a stale reading or a fresh
		// false from the server.
		const ageMs = cached ? Date.now() - cached.checkedAt : null;
		console.warn(
			"[kill-switch] assertOfflineEnabled blocking enqueue",
			{
				outboxType: type,
				cachedEnabled: cached?.enabled,
				cacheAgeMs: ageMs,
				cacheTTLMs: KILL_SWITCH_CACHE_TTL_MS,
			},
		);
		throw new OfflineDisabledError(type);
	}
}

/** Reset for tests / admin-panel forced invalidation. */
export function invalidateKillSwitchCache(): void {
	cached = null;
}

// ---------------------------------------------------------------------------
// Server lookup
// ---------------------------------------------------------------------------

/**
 * Fetch via a dedicated endpoint rather than frappe.client.get_single_value —
 * the doctype is System Manager–only, so cashier sessions would 403 the generic
 * lookup and silently fall back to "enabled", defeating the switch.
 * Errors preserve the last-known value; never treat failure as "disabled".
 */
async function fetchKillSwitch(): Promise<boolean> {
	// Skip fetch while offline — SW fallbacks or captive portals can return
	// a malformed 200 that parseEnabled reads as `false`, blocking enqueues.
	try {
		const { default: connectivity } = await import("./connectivity");
		if (
			!connectivity.isOnline() ||
			(typeof navigator !== "undefined" && !navigator.onLine)
		) {
			return cached?.enabled ?? DEFAULT_ENABLED;
		}
	} catch {
		// connectivity module not available yet (very early boot) — fall
		// through to the network attempt with the existing error guards.
	}

	try {
		// Lazy import to avoid a circular dependency (kill-switch is imported
		// from call()'s offline dependency graph indirectly via outbox.ts).
		const { call } = await import("@/utils/call");
		const res = (await call({
			method: "pospire.pospire.api.offline.is_offline_enabled",
			intent: "read",
			cacheKey: KILL_SWITCH_CACHE_KEY,
			cacheTTLMs: KILL_SWITCH_CACHE_TTL_MS,
		})) as unknown;

		const value = parseEnabled(res);
		if (value !== null) return value;
		// Malformed response — keep last known value or the default.
		return cached?.enabled ?? DEFAULT_ENABLED;
	} catch {
		// Server unreachable — preserve the last known value (or the
		// default). NEVER treat an error as "disabled".
		return cached?.enabled ?? DEFAULT_ENABLED;
	}
}

/**
 * Extract `enabled` from the various shapes `frappe.client.get_value` can
 * return (direct object, stale wrapper from call(), or a raw boolean).
 */
function parseEnabled(res: unknown): boolean | null {
	if (res === null || res === undefined) return null;

	// call()'s StaleReadResult<T> wrapper: { data, stale: true, cachedAt }
	if (
		typeof res === "object" &&
		res !== null &&
		"data" in (res as Record<string, unknown>) &&
		"stale" in (res as Record<string, unknown>)
	) {
		return parseEnabled((res as { data: unknown }).data);
	}

	if (typeof res === "boolean") return res;
	if (typeof res === "number") return res !== 0;
	if (typeof res === "string") {
		if (res === "1" || res.toLowerCase() === "true") return true;
		if (res === "0" || res.toLowerCase() === "false") return false;
		return null;
	}

	if (typeof res === "object") {
		const obj = res as Record<string, unknown>;
		if (KILL_SWITCH_FIELD in obj) {
			return parseEnabled(obj[KILL_SWITCH_FIELD]);
		}
		// `frappe.client.get_value` with a single field returns { fieldname: value }
		// but older shims wrap in `{ message: {...} }`.
		if ("message" in obj) {
			return parseEnabled(obj.message);
		}
	}
	return null;
}
