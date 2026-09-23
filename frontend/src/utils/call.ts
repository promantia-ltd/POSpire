/**
 * Single API boundary for POSpire's Vue SPA (P-2).
 *
 * Every network call in `frontend/src/` MUST flow through this function.
 * Direct `frappe-ui` imports in components are forbidden (enforced by
 * `no-restricted-imports`). See 09-api-boundary.md for the full contract.
 *
 * Responsibilities:
 *   - Decide online-live vs. offline-cache vs. outbox-enqueue per method.
 *   - Attach `offline_id` (generated if not supplied) for offline-capable writes.
 *   - Report request outcomes back to the connectivity detector.
 *   - Emit one instrumentation event per call.
 *
 * NOT this wrapper's responsibility:
 *   - Retry (outbox owns it for writes; reads fail and the caller decides).
 *   - Auth (frappe-ui session cookie handling).
 *   - Request batching / response transformation.
 */

// liveFetch() below performs its own fetch() rather than importing frappe-ui's
// `call()` — see the function for why (structured server error fields need to
// survive the request). This file no longer needs a frappe-ui import as a
// result, but the `no-restricted-imports` override for it in eslint.config.js
// is left in place: it still legitimately covers the two remaining direct
// importers (src/main.js and src/offline/connectivity.ts), and a future
// change here that needs a frappe-ui helper directly is expected to use it
// rather than re-litigate the boundary.
import {
	getMethodConfig,
	isReadConfig,
	isWriteConfig,
	UnregisteredMethod,
	type MethodConfig,
	type ReadMethodConfig,
	type WriteMethodConfig,
} from "./call-registry";
import { connectivity } from "@/offline/connectivity";
import { getOutboxEnqueue, getReadCache } from "@/offline/runtime";
import type { OutboxEnqueueAck } from "@/offline/types";

// Re-export so consumers don't need to import from the registry module.
export { UnregisteredMethod };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallOptions {
	/** Frappe-whitelisted method path (must be in call-registry). */
	method: string;
	/** Positional/keyword args passed to the server method. */
	args?: Record<string, unknown>;
	/** Determines offline behaviour. Read = cache/live; Write = outbox/live. */
	intent: "read" | "write";
	/** Optional cache hint for reads. Defaults to `method + stable(args)`. */
	cacheKey?: string;
	/** Read TTL in ms. Defaults to the per-method value in the registry. */
	cacheTTLMs?: number;
	/** Writes only. Auto-generated if omitted. Reused across retries. */
	offlineIdempotencyKey?: string;
	/** Cancel the in-flight request. */
	abortSignal?: AbortSignal;
	/**
	 * Internal use by the sync scheduler. When `true`, bypasses the
	 * online/offline gate and the registry's `toOfflinePayload` adapter:
	 * the request goes straight to live fetch with the supplied method+args.
	 * Prevents replay re-entrancy if connectivity flips mid-drain (F7).
	 *
	 * MUST NOT be set by component-level callers; only `@/offline/sync` uses
	 * it. Idempotency on `pos_offline_id` keeps duplicate POSTs safe.
	 */
	bypassConnectivityForReplay?: boolean;
	/**
	 * Force the enqueue path even when connectivity says ONLINE. Used by
	 * components that know their args carry an offline-id reference (e.g.
	 * `customer_offline_id` set on a still-unsynced offline-created customer)
	 * and the live endpoint can't resolve the placeholder. The scheduler
	 * drains immediately when online, so the user perceives ~1s extra latency
	 * but the request goes through the offline endpoint that knows how to
	 * resolve the offline_id reference.
	 */
	forceQueue?: boolean;
}

/**
 * A cached read response when the cache hit was stale. Callers MUST type-narrow:
 *
 * ```ts
 * const r = await call<Item[]>({ method: "...", intent: "read", cacheKey: "items" });
 * if (r && typeof r === "object" && "stale" in r) {
 *   useStaleData(r.data);    // optionally show a "syncing" indicator
 * } else if (r && typeof r === "object" && "offline" in r) {
 *   handleEnqueueAck(r);     // (writes only, won't appear here)
 * } else {
 *   useFreshData(r);
 * }
 * ```
 *
 * Forgetting to unwrap `r.data` and assigning `r` directly to a list/object
 * binding will surface as `[object Object]` or undefined fields. There is no
 * runtime warning because the response is structurally valid — TypeScript's
 * union narrows the wrapper away only when consumers branch on `'stale' in r`.
 *
 * Phase 2 component migration (read paths consuming `cacheKey`) MUST audit
 * each call site for this unwrap. Tracked in
 * docs/offline/phase-0/phase-2-followups.md.
 */
export interface StaleReadResult<T = unknown> {
	data: T;
	stale: true;
	cachedAt: number;
}

export type CallResult<T = unknown> = T | StaleReadResult<T> | OutboxEnqueueAck;

/**
 * Type guard for the stale-read wrapper. Components that don't care about the
 * stale flag should funnel every cached-read response through `unwrapStale`
 * to avoid the wrapper leaking into list bindings, localStorage caches, and
 * downstream array operations.
 */
export function isStaleReadResult<T>(
	value: unknown,
): value is StaleReadResult<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		"stale" in (value as Record<string, unknown>) &&
		"data" in (value as Record<string, unknown>)
	);
}

/**
 * Strip the stale-read wrapper if present and return the underlying value.
 * No-op when the value is already the bare type (or null/undefined).
 *
 * Use this in every component path that bridges `await call(...)` with a
 * downstream consumer that expects the bare value:
 *
 *   const items = unwrapStale(await call({ ..., cacheKey: 'items' }));
 *   localStorage.setItem("items", JSON.stringify(items));
 *   eventBus.emit("set_items", items);
 *
 * The previous inline `r && typeof r === "object" && "stale" in r ? r.data : r`
 * pattern was correct but easy to forget at a single call site, which had
 * shipped wrapper objects into both localStorage and the eventBus. This
 * helper is the canonical fix.
 */
export function unwrapStale<T>(value: T | StaleReadResult<T> | null | undefined): T | null {
	if (value === null || value === undefined) return null;
	if (isStaleReadResult<T>(value)) return value.data;
	return value as T;
}

// ---------------------------------------------------------------------------
// Error surfaces (09-api-boundary.md §7)
// ---------------------------------------------------------------------------

/** Why an offline read could not be served. These are different faults: a
 *  `policy` read is never cacheable at all, so warming the cache is pointless,
 *  while `cache_miss` means the same call would have worked with a warm cache. */
export type OfflineReadUnavailableReason =
	| "policy"
	| "no_cache_adapter"
	| "cache_miss";

function offlineReadDetail(
	method: string,
	cacheKey: string,
	reason: OfflineReadUnavailableReason,
): string {
	const prefix = `Offline read for "${method}" is unavailable`;
	if (reason === "policy") {
		return `${prefix}: the method is registered offline:false, so it is never cached. Warming the cache cannot help.`;
	}
	if (reason === "no_cache_adapter") {
		return `${prefix}: no read-cache adapter is registered.`;
	}
	return `${prefix}: no cache entry for ${cacheKey}.`;
}

export class OfflineReadUnavailable extends Error {
	readonly method: string;
	readonly cacheKey: string;
	readonly reason: OfflineReadUnavailableReason;
	constructor(
		method: string,
		cacheKey: string,
		reason: OfflineReadUnavailableReason = "cache_miss",
	) {
		super(offlineReadDetail(method, cacheKey, reason));
		this.name = "OfflineReadUnavailable";
		this.method = method;
		this.cacheKey = cacheKey;
		this.reason = reason;
	}
}

export class OfflineWriteUnavailable extends Error {
	readonly method: string;
	constructor(method: string) {
		super(
			`Offline write for "${method}" is unavailable: outbox is not registered. ` +
				"Integration gap — Agent 3's outbox must call registerOutboxEnqueue.",
		);
		this.name = "OfflineWriteUnavailable";
		this.method = method;
	}
}

export class MethodPolicyError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "MethodPolicyError";
	}
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

export interface CallInstrumentation {
	method: string;
	intent: "read" | "write";
	offline: boolean;
	cacheHit?: boolean;
	durationMs: number;
	outcome: "ok" | "error" | "enqueued";
	attempt: number;
}

type InstrumentationSink = (event: CallInstrumentation) => void;

const instrumentationSinks = new Set<InstrumentationSink>();

/** Subscribe to instrumentation events. Used by the reconciliation workspace. */
export function onInstrumentation(fn: InstrumentationSink): () => void {
	instrumentationSinks.add(fn);
	return () => instrumentationSinks.delete(fn);
}

function emit(event: CallInstrumentation): void {
	for (const sink of instrumentationSinks) {
		try {
			sink(event);
		} catch (err) {
			console.error("[call] instrumentation sink threw", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point. Two calling shapes are supported:
 *
 *   // Canonical (TS):
 *   await call<T>({ method, args, intent: 'read' })
 *
 *   // Legacy positional (accepted during migration; throws if intent can't
 *   // be inferred from the registry):
 *   await call<T>(method, args?)
 *
 * The legacy shape exists so partially-migrated JS/Vue files can keep
 * working during Phase 1. New code MUST use the options object.
 */
export async function call<T = unknown>(opts: CallOptions): Promise<CallResult<T>>;
export async function call<T = unknown>(
	method: string,
	args?: Record<string, unknown>,
): Promise<CallResult<T>>;
export async function call<T = unknown>(
	optsOrMethod: CallOptions | string,
	maybeArgs?: Record<string, unknown>,
): Promise<CallResult<T>> {
	const opts = normalizeOptions(optsOrMethod, maybeArgs);
	const config = getMethodConfig(opts.method); // throws UnregisteredMethod
	validateIntent(opts, config);

	if (isReadConfig(config)) {
		return (await runRead<T>(opts, config)) as CallResult<T>;
	}
	if (isWriteConfig(config)) {
		return (await runWrite<T>(opts, config)) as CallResult<T>;
	}
	// Unreachable — narrowed by the two guards above.
	throw new MethodPolicyError(`Unknown method config shape for ${opts.method}`);
}

function normalizeOptions(
	optsOrMethod: CallOptions | string,
	maybeArgs?: Record<string, unknown>,
): CallOptions {
	if (typeof optsOrMethod === "string") {
		// Legacy positional shape. Intent is inferred from the registry; we
		// set a placeholder here and `validateIntent` enforces agreement.
		const cfg = getMethodConfig(optsOrMethod);
		return {
			method: optsOrMethod,
			args: maybeArgs,
			intent: cfg.intent,
		};
	}
	return optsOrMethod;
}

function validateIntent(opts: CallOptions, config: MethodConfig): void {
	if (opts.intent !== config.intent) {
		throw new MethodPolicyError(
			`Method "${opts.method}" is registered as intent "${config.intent}" ` +
				`but was called with intent "${opts.intent}". Update one or the other.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

async function runRead<T>(opts: CallOptions, config: ReadMethodConfig): Promise<CallResult<T>> {
	const startedAt = nowMs();
	const attempt = 1;
	const cacheKey = opts.cacheKey ?? defaultCacheKey(opts.method, opts.args);
	const ttlMs = opts.cacheTTLMs ?? config.cacheTTLMs;
	const cache = config.offline ? getReadCache() : null;

	if (connectivity.isOnline()) {
		try {
			const result = await liveFetch<T>(opts);
			if (cache) {
				try {
					await cache.write(cacheKey, result, ttlMs);
				} catch (err) {
					// Cache write failures must not fail the read (P-14 allows
					// graceful degradation for non-critical-path writes).
					console.warn("[call] cache write failed", err);
				}
			}
			emit({
				method: opts.method,
				intent: "read",
				offline: false,
				cacheHit: false,
				durationMs: nowMs() - startedAt,
				outcome: "ok",
				attempt,
			});
			return result;
		} catch (err) {
			const classified = classifyFetchError(err);
			connectivity.reportRequestOutcome(classified);

			if (
				classified === "http_4xx" &&
				!(config.offline && typeof navigator !== "undefined" && navigator.onLine === false)
			) {
				emit({
					method: opts.method,
					intent: "read",
					offline: false,
					cacheHit: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}
			// network_error or 5xx → fall through to cache on read path
			if (cache) {
				const cached = await safeCacheRead<T>(cache, cacheKey);
				if (cached) {
					emit({
						method: opts.method,
						intent: "read",
						offline: false,
						cacheHit: true,
						durationMs: nowMs() - startedAt,
						outcome: "ok",
						attempt,
					});
					return { data: cached.data, stale: true, cachedAt: cached.cachedAt };
				}
			}
			emit({
				method: opts.method,
				intent: "read",
				offline: false,
				cacheHit: false,
				durationMs: nowMs() - startedAt,
				outcome: "error",
				attempt,
			});
			throw err;
		}
	}

	// Offline path
	if (!config.offline) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey, "policy");
	}
	if (!cache) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey, "no_cache_adapter");
	}
	const cached = await safeCacheRead<T>(cache, cacheKey);
	if (!cached) {
		emit({
			method: opts.method,
			intent: "read",
			offline: true,
			cacheHit: false,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineReadUnavailable(opts.method, cacheKey, "cache_miss");
	}
	emit({
		method: opts.method,
		intent: "read",
		offline: true,
		cacheHit: true,
		durationMs: nowMs() - startedAt,
		outcome: "ok",
		attempt,
	});
	return { data: cached.data, stale: true, cachedAt: cached.cachedAt };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

async function runWrite<T>(opts: CallOptions, config: WriteMethodConfig): Promise<CallResult<T>> {
	const startedAt = nowMs();
	const attempt = 1;

	// Sync scheduler replay path (F7): bypass the connectivity gate AND the
	// registry adapter — the scheduler already has the offline.* method and
	// the server-shaped payload from the outbox row. Going through the gate
	// risks re-enqueueing if connectivity flaps mid-drain (idempotency makes
	// duplicate POSTs safe, but state-machine churn is fragile).
	if (opts.bypassConnectivityForReplay) {
		const result = await liveFetch<T>(opts);
		emit({
			method: opts.method,
			intent: "write",
			offline: false,
			durationMs: nowMs() - startedAt,
			outcome: "ok",
			attempt,
		});
		return result;
	}

	// Generate idempotency key once — SAME id is used on an online-path
	// network_error retry (P-5). Writes that aren't offline-capable still
	// get a key so observability / server-side dedup works if the method
	// later opts in.
	const offlineId = opts.offlineIdempotencyKey ?? generateOfflineId();
	const argsWithKey: Record<string, unknown> = {
		...(opts.args ?? {}),
		offline_id: offlineId,
	};

	// forceQueue (T10): caller knows args reference an offline-id placeholder
	// (e.g. customer_offline_id pointing at a still-unsynced offline customer)
	// that the live endpoint can't resolve. Skip the online live path; let the
	// scheduler drain via the offline endpoint that handles the resolution.
	if (opts.forceQueue && config.offline) {
		const ack = await enqueueWrite(opts, config, argsWithKey, offlineId);
		emit({
			method: opts.method,
			intent: "write",
			offline: true,
			durationMs: nowMs() - startedAt,
			outcome: "enqueued",
			attempt,
		});
		return ack as CallResult<T>;
	}

	if (connectivity.isOnline()) {
		try {
			const result = await liveFetch<T>({ ...opts, args: argsWithKey });
			emit({
				method: opts.method,
				intent: "write",
				offline: false,
				durationMs: nowMs() - startedAt,
				outcome: "ok",
				attempt,
			});
			return result;
		} catch (err) {
			const classified = classifyFetchError(err);
			connectivity.reportRequestOutcome(classified);

			if (classified === "http_4xx") {
				// Validation error — caller must fix the payload. Never enqueue.
				emit({
					method: opts.method,
					intent: "write",
					offline: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}

			// network_error or 5xx — enqueue IF the method is offline-capable.
			// The server enforces idempotency on `offline_id`, so the eventual
			// retry is safe even if the original landed server-side (P-5).
			if (!config.offline) {
				emit({
					method: opts.method,
					intent: "write",
					offline: false,
					durationMs: nowMs() - startedAt,
					outcome: "error",
					attempt,
				});
				throw err;
			}
			const ack = await enqueueWrite(opts, config, argsWithKey, offlineId);
			emit({
				method: opts.method,
				intent: "write",
				offline: false,
				durationMs: nowMs() - startedAt,
				outcome: "enqueued",
				attempt,
			});
			return ack as CallResult<T>;
		}
	}

	// Offline path
	if (!config.offline) {
		emit({
			method: opts.method,
			intent: "write",
			offline: true,
			durationMs: nowMs() - startedAt,
			outcome: "error",
			attempt,
		});
		throw new OfflineWriteUnavailable(opts.method);
	}
	const ack = await enqueueWrite(opts, config, argsWithKey, offlineId);
	emit({
		method: opts.method,
		intent: "write",
		offline: true,
		durationMs: nowMs() - startedAt,
		outcome: "enqueued",
		attempt,
	});
	return ack as CallResult<T>;
}

async function enqueueWrite(
	opts: CallOptions,
	config: WriteMethodConfig,
	payload: Record<string, unknown>,
	offlineId: string,
): Promise<OutboxEnqueueAck> {
	const enqueue = getOutboxEnqueue();
	if (!enqueue) {
		throw new OfflineWriteUnavailable(opts.method);
	}
	if (!config.outboxType) {
		throw new MethodPolicyError(
			`Method "${opts.method}" is registered offline-capable but has no outboxType. ` +
				"Fix the registry entry.",
		);
	}

	// Resolve the offline shape via the registry's adapter. Without an
	// adapter, the live UI payload would be enqueued and later rejected by
	// the offline endpoint whose signature is (data, offline_id, device_id, …).
	let methodToPost = opts.method;
	let payloadToEnqueue = payload;
	let parentOfflineIds: string[] = [];
	let shiftOfflineId: string | null = null;
	let postingDate: string | undefined;
	let ownerUser: string | undefined;

	if (config.toOfflinePayload) {
		const adapted = config.toOfflinePayload(opts.args ?? {}, {
			offlineId,
			deviceId: getDeviceId(),
		});
		methodToPost = adapted.method;
		payloadToEnqueue = adapted.payload;
		parentOfflineIds = adapted.parentOfflineIds ?? [];
		shiftOfflineId = adapted.shiftOfflineId ?? null;
		postingDate = adapted.postingDate;
		ownerUser = adapted.ownerUser;
	} else {
		// Belt-and-braces: an offline-capable write without an adapter can't
		// produce a server-shaped payload. Fail loud rather than enqueue
		// garbage that the scheduler will only discover at drain time.
		throw new MethodPolicyError(
			`Method "${opts.method}" is offline-capable but missing toOfflinePayload. ` +
				"Add the adapter to the registry entry.",
		);
	}

	return enqueue(config.outboxType, payloadToEnqueue, {
		offlineIdempotencyKey: offlineId,
		method: methodToPost,
		outboxType: config.outboxType,
		parentOfflineIds,
		shiftOfflineId,
		postingDate,
		ownerUser,
	});
}

/**
 * Resolve the device's UUID. Stored at `pospire.device_id` by
 * `seedDeviceId()` inside `initOfflineStorage`. May be `null` if init never
 * ran (offline-disabled mode).
 */
function getDeviceId(): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem("pospire.device_id");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// frappe-ui glue
// ---------------------------------------------------------------------------

/**
 * Perform the live HTTP request. Mirrors frappe-ui's `call.js` request shape
 * (path, method, headers, body, CSRF header gating) exactly, so session auth
 * keeps working — but does its OWN fetch instead of delegating to frappe-ui.
 *
 * Why: frappe-ui's `call()` reads the error body with `.text()`, parses out
 * only `exc_type`/`exc`/`messages`/`status`, and discards the parsed object —
 * the body can't be re-read afterwards. The server's `error_code`, `details`,
 * and `http_status_code` (set by `_throw` in offline.py) never survive that
 * trip, which left every `error_code`-based branch in `sync.ts`'s replay
 * router permanently dead (see task-11 brief). Owning the fetch here lets us
 * attach the structured fields to the thrown Error while keeping frappe-ui's
 * exact success/error message semantics for everything else.
 *
 * On success, marks the connectivity detector with a recent-success. On
 * failure, throws and does NOT report an outcome — callers (runRead/runWrite)
 * classify the error and report failure themselves; reporting here too would
 * double-count it.
 */
async function liveFetch<T>(opts: CallOptions): Promise<T> {
	const path = opts.method.startsWith("/") ? opts.method : `/api/method/${opts.method}`;

	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json; charset=utf-8",
		"X-Frappe-Site-Name": window.location.hostname,
	};
	// window.csrf_token isn't declared on lib.dom's Window type; frappe-ui
	// itself reads it the same untyped way (it ships as plain JS).
	const csrfToken = (window as Window & { csrf_token?: string }).csrf_token;
	if (csrfToken && csrfToken !== "{{ csrf_token }}") {
		headers["X-Frappe-CSRF-Token"] = csrfToken;
	}

	const response = await fetch(path, {
		method: "POST",
		headers,
		body: JSON.stringify(opts.args ?? {}),
		signal: opts.abortSignal,
	});

	if (response.ok) {
		const data = (await response.json()) as { message?: T };
		connectivity.reportRequestOutcome("success");
		return data.message as T;
	}

	throw await buildLiveFetchError(opts.method, response);
}

/**
 * Build the Error thrown for a non-2xx response. Reproduces frappe-ui's
 * `call.js` message/`messages` construction (around its lines 53-84) so
 * downstream consumers reading `e.messages` see the same shape as before,
 * then attaches the structured fields frappe-ui dropped.
 *
 * The body is read via `.text()` exactly once — a `Response` body stream can
 * only be consumed a single time, so `.json()` and `.text()` can never both
 * be called on it. A non-JSON body (e.g. an HTML 502 from a proxy) is a
 * `JSON.parse` failure we catch, not a crash: `parsed` stays `undefined` and
 * every field sourced from it is correctly `undefined` rather than throwing.
 */
async function buildLiveFetchError(
	method: string,
	response: Response,
): Promise<Error & Record<string, unknown>> {
	const raw = await response.text();
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// Non-JSON error body (proxy HTML, gateway timeout page). The structured
		// fields simply won't be there; everything else must still work.
	}

	const excType = parsed?.exc_type as string | undefined;
	const errorMessage = parsed?._error_message as string | undefined;
	const e = new Error([method, excType, errorMessage].filter(Boolean).join(" ")) as Error &
		Record<string, unknown>;

	e.exc_type = excType;

	// frappe-ui: `exc` is JSON-parsed and its first element taken — but only
	// when it actually parses to an array. A stray parse failure (or a body
	// that JSON-parses to something else) must not escape as a thrown error.
	let exc: unknown = parsed?.exc;
	if (typeof exc === "string") {
		try {
			const parsedExc: unknown = JSON.parse(exc);
			exc = Array.isArray(parsedExc) ? parsedExc[0] : parsedExc;
		} catch {
			// Leave `exc` as the raw (unparsed) string, same as frappe-ui.
		}
	}
	e.exc = exc;

	e.status = response.status;
	e.response = response;

	let messages: unknown[] = [];
	if (typeof parsed?._server_messages === "string") {
		try {
			messages = JSON.parse(parsed._server_messages) as unknown[];
		} catch {
			messages = [];
		}
	}
	// `_server_messages` is server-controlled and only ever JSON-encodes to an
	// array in practice, but JSON.parse doesn't guarantee that shape (e.g.
	// `"{}"` parses to a plain object). Without this guard, `.concat`/`.map`
	// below would throw a TypeError that escapes uncaught and gets
	// misclassified as network_error — which would enqueue a 4xx write.
	if (!Array.isArray(messages)) messages = [];
	messages = messages.concat(parsed?.message as unknown);
	messages = messages
		.map((m) => {
			if (typeof m !== "string") return m;
			try {
				return (JSON.parse(m) as { message?: unknown })?.message;
			} catch {
				return m;
			}
		})
		.filter(Boolean);
	if (!messages.length) {
		messages = errorMessage ? [errorMessage] : ["Internal Server Error"];
	}
	e.messages = messages;

	// New: fields `_throw` (pospire/api/offline.py) sets on the response that
	// frappe-ui's call() parsed out of the body and then dropped. `sync.ts`'s
	// replay router reads these to decide retry/park/fail — see task-11 brief.
	e.error_code = parsed?.error_code;
	e.details = parsed?.details;
	e.http_status_code = (parsed?.http_status_code as number | undefined) ?? response.status;

	return e;
}

/**
 * Classify an error thrown by `liveFetch`/`buildLiveFetchError` above.
 *
 * `status`/`response` are now set by code in THIS module (not frappe-ui's
 * `frappeRequest.js`), so both are reliable: `status` is always the real
 * numeric HTTP status, and `response.status` is the same value read off the
 * actual `Response`. The `response` check is kept first regardless, since it
 * is the more direct source of truth when both are present.
 */
function classifyFetchError(err: unknown): "network_error" | "http_4xx" | "http_5xx" {
	// An AbortError is the caller cancelling, not the server being
	// unreachable. Classifying it as network_error would count a user
	// cancel toward the offline transition, serve stale cache instead of
	// rejecting, and — worst — enqueue the very write that was cancelled.
	// Rethrow here (not return a fourth classification) so both call sites
	// propagate the abort unclassified and skip reportRequestOutcome entirely.
	if (err instanceof Error && err.name === "AbortError") throw err;
	// Defensive parsing — a rejected fetch() (e.g. `TypeError: Failed to
	// fetch`) won't have any of these fields.
	if (!err || typeof err !== "object") return "network_error";
	const e = err as Record<string, unknown>;
	const response = e.response as { status?: unknown } | undefined;
	const statusCandidates = [response?.status, e.status, e.statusCode, e.httpStatus];
	for (const s of statusCandidates) {
		if (typeof s === "number") {
			if (s >= 500 && s < 600) return "http_5xx";
			if (s >= 400 && s < 500) return "http_4xx";
		}
	}
	// `TypeError: Failed to fetch` etc. fall through to network_error.
	return "network_error";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeCacheRead<T>(
	cache: ReturnType<typeof getReadCache>,
	key: string,
): Promise<{ data: T; cachedAt: number } | null> {
	if (!cache) return null;
	try {
		const entry = await cache.read<T>(key);
		if (!entry) return null;
		return { data: entry.data, cachedAt: entry.cachedAt };
	} catch (err) {
		console.warn("[call] cache read failed", err);
		return null;
	}
}

function defaultCacheKey(method: string, args: Record<string, unknown> | undefined): string {
	if (!args) return method;
	try {
		return `${method}::${stableStringify(args)}`;
	} catch {
		return method;
	}
}

/** Stable-key stringify. Deterministic for plain JSON-like inputs. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

/** UUID v4 — browser-native when available, JS fallback otherwise. */
function generateOfflineId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// RFC-4122 v4 fallback.
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default call;
