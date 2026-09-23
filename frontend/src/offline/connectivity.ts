/**
 * Connectivity detector — single source of truth for "is the server reachable."
 * Feeds call(), the sync scheduler, and the UI banner.
 *
 * Three signals drive one state machine: navigator.onLine, heartbeat ping, and
 * observed fetch outcomes. Asymmetric thresholds: 2 failures → OFFLINE,
 * 3 successes → ONLINE. stop() must be called on Pos.vue unmount.
 */

import { frappeRequest } from "frappe-ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectivityStatus = "online" | "offline" | "degraded";

export interface ConnectivityState {
	status: ConnectivityStatus;
	lastTransitionAt: number;
	lastPingAt: number | null;
	lastPingRttMs: number | null;
	manualOverride: "online" | "offline" | null;
	consecutiveFailures: number;
	consecutiveSuccesses: number;
}

export type ConnectivityListener = (state: ConnectivityState) => void;

/** Fetch-outcome classifications reported back by `@/utils/call`. */
export type RequestOutcome =
	| "success" // 2xx
	| "network_error" // offline / DNS / etc.
	| "http_5xx" // server sick
	| "http_4xx"; // request bad — no detector effect

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PING_METHOD = "pospire.pospire.api.offline.ping";

const THRESHOLD_OFFLINE = 2; // consecutive failures
const THRESHOLD_ONLINE = 3; // consecutive successes

const CADENCE_ONLINE_MS = 30_000;
const CADENCE_OFFLINE_START_MS = 5_000;
const CADENCE_OFFLINE_MAX_MS = 120_000;
const BACKGROUND_MULTIPLIER = 2; // document.hidden → 2× cadence
const RECENT_SUCCESS_SKIP_MS = 30_000; // skip ping if real call succeeded within

const DEBOUNCE_DEFAULT_MS = 10_000;
const DEBOUNCE_ESCALATED_MS = 30_000;
const FLAP_WINDOW_MS = 5 * 60 * 1000;
const FLAP_THRESHOLD_COUNT = 3;

const CONNECTIVITY_LOG_CAP = 500; // metadata.connectivity_log cap

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let state: ConnectivityState = {
	status: "online",
	lastTransitionAt: Date.now(),
	lastPingAt: null,
	lastPingRttMs: null,
	manualOverride: null,
	consecutiveFailures: 0,
	consecutiveSuccesses: 0,
};

const listeners = new Set<ConnectivityListener>();
let timerHandle: ReturnType<typeof setTimeout> | null = null;
let started = false;
let lastRealSuccessAt = 0;
let lastKnownServerVersion: string | null = null;

/** Transition timestamps inside the rolling FLAP_WINDOW_MS for D-31. */
const recentTransitions: number[] = [];

/**
 * In-memory connectivity log, capped at CONNECTIVITY_LOG_CAP and flushed to
 * the server via `pospire.pospire.api.offline.log_batch` on reconnect.
 */
interface ConnectivityLogEntry {
	at: number;
	from: ConnectivityStatus;
	to: ConnectivityStatus;
	reason: string;
	rttMs: number | null;
}
const connectivityLog: ConnectivityLogEntry[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return a snapshot of the current state. Safe to read from anywhere. */
export function getState(): ConnectivityState {
	return { ...state };
}

/** Alias for getState(). */
export function snapshot(): ConnectivityState {
	return getState();
}

/** Convenience: true iff the detector considers the server reachable. */
export function isOnline(): boolean {
	if (state.manualOverride === "offline") return false;
	if (state.manualOverride === "online") return true;
	return state.status === "online" || state.status === "degraded";
}

/**
 * Subscribe to state transitions. Returns an unsubscribe function. Listeners
 * are only invoked AFTER the debounce window expires (D-31) to avoid
 * flapping the UI banner.
 */
export function onChange(fn: ConnectivityListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Report outcome of a real request; drives transitions faster than pings alone. */
export function reportRequestOutcome(outcome: RequestOutcome): void {
	switch (outcome) {
		case "success":
			lastRealSuccessAt = Date.now();
			recordSuccess("real_request");
			break;
		case "network_error":
		case "http_5xx":
			recordFailure(outcome);
			break;
		case "http_4xx":
			// No detector effect — server is fine, request is bad.
			break;
	}
}

/** Manager-only: force ONLINE. Persists in memory only; reload reverts. */
export function forceOnline(): void {
	state.manualOverride = "online";
	transition("online", "manual_override_online");
}

/** Manager-only: force OFFLINE. Persists in memory only; reload reverts. */
export function forceOffline(): void {
	state.manualOverride = "offline";
	transition("offline", "manual_override_offline");
}

/** Clear any manual override and resume auto-detection. */
export function clearManualOverride(): void {
	state.manualOverride = null;
	notify();
}

/** Start the detector. Idempotent. Called from Pos.vue onMounted. */
export function start(): void {
	if (started) return;
	started = true;

	if (typeof window !== "undefined") {
		window.addEventListener("online", handleBrowserOnline);
		window.addEventListener("offline", handleBrowserOffline);
		window.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("pagehide", stop);
	}

	schedulePing(0); // kick an initial ping immediately
}

/** Stop the detector. MUST be called on `Pos.vue` unmount. */
export function stop(): void {
	if (!started) return;
	started = false;
	if (timerHandle !== null) {
		clearTimeout(timerHandle);
		timerHandle = null;
	}
	if (typeof window !== "undefined") {
		window.removeEventListener("online", handleBrowserOnline);
		window.removeEventListener("offline", handleBrowserOffline);
		window.removeEventListener("visibilitychange", handleVisibilityChange);
		window.removeEventListener("pagehide", stop);
	}
}

/**
 * Drain and return the in-memory connectivity log. Intended for the reconnect
 * batched log endpoint; clears the in-memory buffer on read.
 */
export function drainLog(): ConnectivityLogEntry[] {
	const out = connectivityLog.splice(0, connectivityLog.length);
	return out;
}

/**
 * User-initiated ping. Bypasses the 3-success threshold and debounce on success
 * so the banner clears immediately. On failure, increments consecutiveFailures normally.
 * Returns whether the ping succeeded (not whether state changed).
 */
export async function forcePingNow(): Promise<boolean> {
	const startedAt = Date.now();
	try {
		const res = (await frappeRequest({
			url: `/api/method/${PING_METHOD}`,
			method: "POST",
		})) as { ok?: boolean; server_time?: string; server_version?: string };

		state.lastPingAt = Date.now();
		state.lastPingRttMs = Date.now() - startedAt;

		const ok =
			res &&
			res.ok === true &&
			typeof res.server_time === "string" &&
			!Number.isNaN(Date.parse(res.server_time)) &&
			typeof res.server_version === "string";

		if (!ok) {
			recordFailure("force_ping_malformed_response");
			return false;
		}

		if (typeof res.server_version === "string") {
			lastKnownServerVersion = res.server_version;
		}

		state.consecutiveFailures = 0;
		state.consecutiveSuccesses = THRESHOLD_ONLINE;
		if (!isStateOnline(state.status)) {
			transition("online", "force_ping_success");
			// Bypass the debounce — explicit cashier tap should clear the banner immediately.
			notify();
		}
		return true;
	} catch {
		state.lastPingAt = Date.now();
		state.lastPingRttMs = null;
		recordFailure("force_ping_network_error");
		return false;
	}
}

// ---------------------------------------------------------------------------
// Ping scheduling
// ---------------------------------------------------------------------------

function schedulePing(delayMs: number): void {
	if (!started) return;
	if (timerHandle !== null) clearTimeout(timerHandle);
	timerHandle = setTimeout(() => {
		void runPing();
	}, delayMs);
}

function nextCadence(): number {
	// Online-path passive skip (§4): if a real call succeeded within the
	// last 30s, push the next ping out by that margin instead.
	const hidden = typeof document !== "undefined" && document.hidden;
	const multiplier = hidden ? BACKGROUND_MULTIPLIER : 1;

	if (isStateOnline(state.status)) {
		// Pending-offline fast path: first failure recorded but threshold not
		// yet reached. Use the offline start cadence (5s) so the confirmation
		// ping arrives quickly instead of waiting the full 30s online interval.
		if (state.consecutiveFailures > 0) {
			return CADENCE_OFFLINE_START_MS * multiplier;
		}
		const elapsed = Date.now() - lastRealSuccessAt;
		if (elapsed < RECENT_SUCCESS_SKIP_MS) {
			return Math.max(CADENCE_ONLINE_MS - elapsed, 1000) * multiplier;
		}
		return CADENCE_ONLINE_MS * multiplier;
	}

	// OFFLINE: exponential backoff, capped.
	const failures = Math.max(state.consecutiveFailures, 1);
	const backoff = Math.min(
		CADENCE_OFFLINE_START_MS * 2 ** (failures - 1),
		CADENCE_OFFLINE_MAX_MS,
	);
	return backoff * multiplier;
}

async function runPing(): Promise<void> {
	if (!started) return;

	const startedAt = Date.now();
	try {
		const res = (await frappeRequest({
			url: `/api/method/${PING_METHOD}`,
			method: "POST",
		})) as { ok?: boolean; server_time?: string; server_version?: string };

		const rttMs = Date.now() - startedAt;
		state.lastPingAt = Date.now();
		state.lastPingRttMs = rttMs;

		if (
			res &&
			res.ok === true &&
			typeof res.server_time === "string" &&
			!Number.isNaN(Date.parse(res.server_time)) &&
			typeof res.server_version === "string"
		) {
			if (lastKnownServerVersion && lastKnownServerVersion !== res.server_version) {
				// Non-blocking notice — reload hint is emitted via the log.
				logConnectivity(
					state.status,
					state.status,
					`server_version_changed:${lastKnownServerVersion}->${res.server_version}`,
					rttMs,
				);
			}
			lastKnownServerVersion = res.server_version;
			recordSuccess("ping");
		} else {
			recordFailure("ping_malformed_response");
		}
	} catch {
		state.lastPingAt = Date.now();
		state.lastPingRttMs = null;
		recordFailure("ping_network_error");
	} finally {
		schedulePing(nextCadence());
	}
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function recordSuccess(reason: string): void {
	state.consecutiveSuccesses += 1;
	state.consecutiveFailures = 0;
	if (!isStateOnline(state.status) && state.consecutiveSuccesses >= THRESHOLD_ONLINE) {
		transition("online", reason);
	}
}

function recordFailure(reason: string): void {
	state.consecutiveFailures += 1;
	state.consecutiveSuccesses = 0;
	if (isStateOnline(state.status) && state.consecutiveFailures >= THRESHOLD_OFFLINE) {
		transition("offline", reason);
	}
}

function transition(next: ConnectivityStatus, reason: string): void {
	if (state.status === next && state.manualOverride === null) return;

	const prev = state.status;
	const now = Date.now();

	state.status = next;
	state.lastTransitionAt = now;

	// D-31 flap bookkeeping.
	recentTransitions.push(now);
	while (recentTransitions.length > 0 && now - recentTransitions[0]! > FLAP_WINDOW_MS) {
		recentTransitions.shift();
	}
	const debounced =
		recentTransitions.length >= FLAP_THRESHOLD_COUNT
			? DEBOUNCE_ESCALATED_MS
			: DEBOUNCE_DEFAULT_MS;

	logConnectivity(prev, next, reason, state.lastPingRttMs);

	// Debounced notify — consumers see the final settled state after the
	// window, not every flip.
	setTimeout(() => {
		if (state.status === next) notify();
	}, debounced);
}

function notify(): void {
	const snap = { ...state };
	for (const fn of listeners) {
		try {
			fn(snap);
		} catch (err) {
			console.error("[connectivity] listener threw", err);
		}
	}
}

function isStateOnline(s: ConnectivityStatus): boolean {
	return s === "online" || s === "degraded";
}

// ---------------------------------------------------------------------------
// Browser event handlers
// ---------------------------------------------------------------------------

function handleBrowserOnline(): void {
	// Hint only — trigger an immediate ping rather than flipping blindly.
	schedulePing(0);
}

function handleBrowserOffline(): void {
	schedulePing(0);
}

function handleVisibilityChange(): void {
	// Recompute cadence to pick up the background multiplier immediately.
	schedulePing(nextCadence());
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logConnectivity(
	from: ConnectivityStatus,
	to: ConnectivityStatus,
	reason: string,
	rttMs: number | null,
): void {
	connectivityLog.push({ at: Date.now(), from, to, reason, rttMs });
	while (connectivityLog.length > CONNECTIVITY_LOG_CAP) {
		connectivityLog.shift();
	}
}

// ---------------------------------------------------------------------------
// Named export
// ---------------------------------------------------------------------------

export const connectivity = {
	state: getState,
	onChange,
	isOnline,
	forceOnline,
	forceOffline,
	clearManualOverride,
	start,
	stop,
	reportRequestOutcome,
	drainLog,
	forcePingNow,
};

export default connectivity;
