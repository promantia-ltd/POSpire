/**
 * Client-side diagnostic log shipper.
 *
 * Collects three streams and uploads them to `log_batch` so server-side RCA
 * can see what happened on the device:
 *
 *   1. Uncaught client errors — Vue `errorHandler`, `window.onerror`,
 *      `unhandledrejection`. Persisted to Dexie immediately so a crash +
 *      reload does not lose the evidence.
 *   2. Connectivity transitions — `connectivity.drainLog()` (in-memory).
 *   3. Sync cycle summaries — `drainSyncLog()`. Idle cycles (nothing drained,
 *      parked or moved to review) are dropped; they are noise for RCA and
 *      each shipped entry becomes one Error Log row on the server.
 *
 * Everything funnels through a persisted pending buffer, so an upload that
 * fails (offline, 5xx, rate limit) is retried on the next flush instead of
 * being lost — `drainLog` / `drainSyncLog` clear on read.
 *
 * Flushes on reconnect, on tab visibility, and every FLUSH_INTERVAL_MS.
 */

import { call } from "@/utils/call";
import { db } from "./db";
import connectivity from "./connectivity";
import { drainSyncLog, type SyncCycleLog } from "./sync";
import { LS_DEVICE_ID } from "./constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_META_KEY = "log_shipper.pending";
/** Oldest entries are dropped beyond this; bounds IndexedDB growth offline. */
const PENDING_CAP = 500;
/** Must stay <= server `_LOG_BATCH_MAX_ENTRIES`. */
const BATCH_SIZE = 100;
/** Server allows 10 req/min/user; leave headroom for other tabs. */
const MAX_BATCHES_PER_FLUSH = 3;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Identical errors inside this window are collapsed into one entry. */
const ERROR_DEDUPE_WINDOW_MS = 60 * 1000;
const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClientLogKind = "client_error" | "connectivity" | "sync_cycle";

export interface ClientLogEntry {
	kind: ClientLogKind;
	/** Epoch ms of the event on the device clock. */
	at: number;
	device_id: string;
	build_hash: string;
	route: string;
	[key: string]: unknown;
}

export type ClientErrorSource = "vue" | "window" | "promise";

interface ErrorAppHandle {
	config: {
		errorHandler?: (err: unknown, instance: unknown, info: string) => void;
	};
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
	timer: null as ReturnType<typeof setInterval> | null,
	connectivityUnsub: null as (() => void) | null,
	flushing: null as Promise<number> | null,
	errorCaptureInstalled: false,
	recentErrors: new Map<string, { at: number; count: number }>(),
};

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function readDeviceId(): string {
	try {
		return localStorage.getItem(LS_DEVICE_ID) ?? "unknown-device";
	} catch {
		return "unknown-device";
	}
}

function readBuildHash(): string {
	try {
		const g = globalThis as unknown as { __POSPIRE_SW_BUILD_HASH__?: string };
		return g.__POSPIRE_SW_BUILD_HASH__ ?? "";
	} catch {
		return "";
	}
}

function readRoute(): string {
	try {
		return typeof location !== "undefined" ? location.pathname + location.hash : "";
	} catch {
		return "";
	}
}

function baseEntry(kind: ClientLogKind, at: number): ClientLogEntry {
	return {
		kind,
		at,
		device_id: readDeviceId(),
		build_hash: readBuildHash(),
		route: readRoute(),
	};
}

// ---------------------------------------------------------------------------
// Pending buffer (persisted)
// ---------------------------------------------------------------------------

async function appendPending(entries: ClientLogEntry[]): Promise<void> {
	if (entries.length === 0) return;
	await db.transaction("rw", db.metadata, async () => {
		const row = await db.metadata.get(PENDING_META_KEY);
		const list = Array.isArray(row?.value) ? (row.value as ClientLogEntry[]) : [];
		list.push(...entries);
		if (list.length > PENDING_CAP) list.splice(0, list.length - PENDING_CAP);
		await db.metadata.put({ key: PENDING_META_KEY, value: list, updated_at: Date.now() });
	});
}

async function readPending(): Promise<ClientLogEntry[]> {
	const row = await db.metadata.get(PENDING_META_KEY);
	return Array.isArray(row?.value) ? (row.value as ClientLogEntry[]) : [];
}

/** Remove the first `n` entries — the ones a successful upload just sent. */
async function dropPending(n: number): Promise<void> {
	await db.transaction("rw", db.metadata, async () => {
		const row = await db.metadata.get(PENDING_META_KEY);
		const list = Array.isArray(row?.value) ? (row.value as ClientLogEntry[]) : [];
		await db.metadata.put({
			key: PENDING_META_KEY,
			value: list.slice(n),
			updated_at: Date.now(),
		});
	});
}

/** Test / diagnostics hook. */
export async function getPendingCount(): Promise<number> {
	return (await readPending()).length;
}

// ---------------------------------------------------------------------------
// Error capture
// ---------------------------------------------------------------------------

function errorParts(err: unknown): { name: string; message: string; stack: string } {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: String(err.message ?? ""),
			stack: String(err.stack ?? ""),
		};
	}
	let message: string;
	try {
		message = typeof err === "string" ? err : JSON.stringify(err);
	} catch {
		message = String(err);
	}
	return { name: "NonError", message: message ?? "", stack: "" };
}

/**
 * Record one client error. Exported so call sites that catch-and-swallow
 * (e.g. print, hardware) can still leave evidence for RCA.
 */
export async function captureClientError(
	err: unknown,
	source: ClientErrorSource,
	extra: Record<string, unknown> = {},
): Promise<void> {
	try {
		const { name, message, stack } = errorParts(err);
		const firstFrame = stack.split("\n").find((l) => l.trim().startsWith("at ")) ?? "";
		const fingerprint = `${source}|${name}|${message.slice(0, 120)}|${firstFrame.trim()}`;
		const now = Date.now();

		const seen = state.recentErrors.get(fingerprint);
		if (seen && now - seen.at < ERROR_DEDUPE_WINDOW_MS) {
			seen.count += 1;
			return;
		}
		const repeats = seen ? seen.count : 0;
		state.recentErrors.set(fingerprint, { at: now, count: 0 });
		if (state.recentErrors.size > 200) state.recentErrors.clear();

		await appendPending([
			{
				...baseEntry("client_error", now),
				source,
				error_name: name,
				message: message.slice(0, MAX_MESSAGE_CHARS),
				stack: stack.slice(0, MAX_STACK_CHARS),
				fingerprint,
				suppressed_repeats: repeats,
				online: connectivity.isOnline(),
				user_agent:
					typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 240) : "",
				...extra,
			},
		]);
	} catch {
		// Error capture must never throw into the code that failed.
	}
}

/**
 * Install global error hooks. Pass the Vue app to also capture component
 * errors; an existing `errorHandler` is preserved and still called.
 */
export function installErrorCapture(app?: ErrorAppHandle): void {
	if (app) {
		const previous = app.config.errorHandler;
		app.config.errorHandler = (err, instance, info) => {
			const component =
				(instance as { $options?: { name?: string; __name?: string } } | null)?.$options;
			void captureClientError(err, "vue", {
				vue_info: info,
				component: component?.name ?? component?.__name ?? "",
			});
			if (previous) {
				previous(err, instance, info);
			} else {
				// Keep the default console visibility Vue gives without a handler.
				// eslint-disable-next-line no-console
				console.error(err);
			}
		};
	}

	if (state.errorCaptureInstalled || typeof window === "undefined") return;
	state.errorCaptureInstalled = true;

	window.addEventListener("error", (event: ErrorEvent) => {
		void captureClientError(event.error ?? event.message, "window", {
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
		});
	});
	window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
		void captureClientError(event.reason, "promise");
	});
}

// ---------------------------------------------------------------------------
// Collect + flush
// ---------------------------------------------------------------------------

function isNotableCycle(c: SyncCycleLog): boolean {
	return (
		c.drained > 0 ||
		(c.parked ?? 0) > 0 ||
		(c.retried ?? 0) > 0 ||
		Object.keys(c.moved_to_needs_review ?? {}).length > 0
	);
}

/** Move connectivity + sync logs into the persisted pending buffer. */
async function collectSources(): Promise<void> {
	const entries: ClientLogEntry[] = [];

	for (const t of connectivity.drainLog()) {
		entries.push({
			...baseEntry("connectivity", t.at),
			from: t.from,
			to: t.to,
			reason: t.reason,
			rtt_ms: t.rttMs,
		});
	}

	try {
		for (const c of await drainSyncLog()) {
			if (!isNotableCycle(c)) continue;
			entries.push({ ...baseEntry("sync_cycle", c.finished_at || c.started_at), ...c });
		}
	} catch {
		// Dexie unavailable / safe mode — connectivity entries still ship.
	}

	await appendPending(entries);
}

/**
 * Upload pending entries. Returns how many were accepted. Concurrent calls
 * share one in-flight flush.
 */
export function flushLogs(): Promise<number> {
	if (state.flushing) return state.flushing;
	state.flushing = doFlush().finally(() => {
		state.flushing = null;
	});
	return state.flushing;
}

async function doFlush(): Promise<number> {
	try {
		await collectSources();
	} catch {
		/* fall through and try to send whatever is already pending */
	}
	if (!connectivity.isOnline()) return 0;

	let sent = 0;
	for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
		let batch: ClientLogEntry[];
		try {
			batch = (await readPending()).slice(0, BATCH_SIZE);
		} catch {
			return sent;
		}
		if (batch.length === 0) break;
		try {
			await call({
				method: "pospire.pospire.api.offline.log_batch",
				args: { entries: JSON.stringify(batch) },
				intent: "write",
			});
		} catch {
			// Keep the entries; next flush retries.
			break;
		}
		await dropPending(batch.length);
		sent += batch.length;
	}
	return sent;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function onVisibilityChange(): void {
	if (typeof document !== "undefined" && document.visibilityState === "visible") {
		void flushLogs();
	}
}

/** Start periodic + reconnect flushing. Idempotent. */
export function startLogShipper(): void {
	if (state.timer) return;
	state.timer = setInterval(() => void flushLogs(), FLUSH_INTERVAL_MS);
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}
	state.connectivityUnsub = connectivity.onChange((cs) => {
		if (cs && cs.status === "online") void flushLogs();
	});
	// Ship anything left over from the previous session (e.g. a crash).
	void flushLogs();
}

/** Stop flushing. Error hooks stay installed — they are cheap and global. */
export function stopLogShipper(): void {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
	if (typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisibilityChange);
	}
	if (state.connectivityUnsub) {
		state.connectivityUnsub();
		state.connectivityUnsub = null;
	}
}
