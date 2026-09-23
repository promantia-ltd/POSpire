/**
 * Multi-outlet observability beacon.
 *
 * Every BEACON_INTERVAL_MS, snapshots offline-pipeline health and POSTs to
 * `record_beacon`. Fires immediately on reconnect and on tab visibility change.
 * Backs off 30 min after 3 consecutive failures.
 */

import { call } from "@/utils/call";
import { db } from "./db";
import connectivity from "./connectivity";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEACON_INTERVAL_MS = 5 * 60 * 1000; // 5 min per docs
const BEACON_BACKOFF_MS = 30 * 60 * 1000; // 30 min pause after 3 failures
const BEACON_FAILURE_THRESHOLD = 3;

// Read these once — they don't change at runtime.
function readDeviceId(): string {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem("pospire.device_id") ?? "unknown-device";
		}
	} catch {
		/* private mode */
	}
	return "unknown-device";
}

function readSwBuildHash(): string {
	// vite-plugin-sw injects this onto the registered SW; we mirror it onto
	// `window.__POSPIRE_SW_BUILD_HASH__` from main.js when registration
	// resolves. If the SW didn't register (DEV mode), fall back to empty.
	try {
		const g = globalThis as unknown as { __POSPIRE_SW_BUILD_HASH__?: string };
		return g.__POSPIRE_SW_BUILD_HASH__ ?? "";
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BeaconState {
	timer: ReturnType<typeof setInterval> | null;
	consecutiveFailures: number;
	pausedUntil: number;
	lastSyncAt: number | null;
	lastSyncOutcome: "success" | "partial" | "failure" | null;
	currentOutlet: string;
	currentShift: string;
	currentUser: string;
	connectivityUnsub: (() => void) | null;
}

const state: BeaconState = {
	timer: null,
	consecutiveFailures: 0,
	pausedUntil: 0,
	lastSyncAt: null,
	lastSyncOutcome: null,
	currentOutlet: "",
	currentShift: "",
	currentUser: "",
	connectivityUnsub: null,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeaconContextHints {
	outlet?: string;
	active_shift?: string;
	user?: string;
}

/**
 * Start the beacon loop. Idempotent — calling start() twice does not
 * double-schedule. Wired from App.vue mounted() after offline storage is
 * initialised.
 */
export function startBeacon(hints: BeaconContextHints = {}): void {
	if (state.timer) return;
	if (hints.outlet) state.currentOutlet = hints.outlet;
	if (hints.active_shift) state.currentShift = hints.active_shift;
	if (hints.user) state.currentUser = hints.user;

	// Fire one immediately so the dashboard sees the device on session start.
	void fireBeacon();

	state.timer = setInterval(() => {
		void fireBeacon();
	}, BEACON_INTERVAL_MS);

	// Visibility change: a manager comes back to the tab after lunch — fire
	// a quick beacon so the dashboard updates without waiting up to 5 min.
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	// Fire immediately on reconnect so "last seen" catches up without waiting the full interval.
	state.connectivityUnsub = connectivity.onChange((cs) => {
		if (cs && cs.status === "online") {
			void fireBeacon();
		}
	});
}

/** Stop the loop + unhook listeners. Safe to call from beforeUnmount. */
export function stopBeacon(): void {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
	if (typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisibilityChange);
	}
	if (typeof state.connectivityUnsub === "function") {
		state.connectivityUnsub();
		state.connectivityUnsub = null;
	}
}

/**
 * Update the pieces of beacon context that the offline store doesn't know
 * about. Call from Pos.vue when the cashier opens a shift / picks an
 * outlet. The next beacon picks up the new values.
 */
export function setBeaconContext(hints: BeaconContextHints): void {
	if (hints.outlet !== undefined) state.currentOutlet = hints.outlet;
	if (hints.active_shift !== undefined) state.currentShift = hints.active_shift;
	if (hints.user !== undefined) state.currentUser = hints.user;
}

/**
 * Hook for sync.ts: report the most recent drain-cycle outcome so the next
 * beacon includes it. We don't push from sync.ts on every cycle (that would
 * defeat the 5-min cadence) — beacon picks up whatever was last set.
 */
export function recordSyncOutcome(
	outcome: "success" | "partial" | "failure",
): void {
	state.lastSyncAt = Date.now();
	state.lastSyncOutcome = outcome;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function onVisibilityChange(): void {
	if (typeof document !== "undefined" && document.visibilityState === "visible") {
		void fireBeacon();
	}
}

async function fireBeacon(): Promise<void> {
	// Honour the back-off window after persistent failures.
	if (Date.now() < state.pausedUntil) return;

	// Skip while offline — server is unreachable, no point burning a request.
	// The connectivity-online subscription above fires one immediately when
	// we come back, so the gap is at most one tick.
	if (!connectivity.isOnline()) return;

	try {
		const payload = await assembleBeacon();
		await call({
			method: "pospire.pospire.api.offline.record_beacon",
			args: { beacon: JSON.stringify(payload) },
			intent: "write",
		});
		state.consecutiveFailures = 0;
	} catch (err) {
		state.consecutiveFailures += 1;
		if (state.consecutiveFailures >= BEACON_FAILURE_THRESHOLD) {
			state.pausedUntil = Date.now() + BEACON_BACKOFF_MS;
			state.consecutiveFailures = 0;
			console.warn(
				`[beacon] ${BEACON_FAILURE_THRESHOLD} consecutive failures; pausing for ${BEACON_BACKOFF_MS / 60_000} min`,
				err,
			);
		}
	}
}

async function assembleBeacon(): Promise<Record<string, unknown>> {
	// Pull counts directly from Dexie. We don't import the Pinia store here
	// because the beacon must run even when no Vue components are mounted
	// (background tab, browser idle).
	const enqueued = await db.outbox
		.where("status")
		.equals("enqueued")
		.count();
	const retryPending = await db.outbox
		.where("status")
		.equals("retry_pending")
		.count();
	const inFlight = await db.outbox
		.where("status")
		.equals("in_flight")
		.count();
	const needsReview = await db.outbox
		.where("status")
		.equals("needs_review")
		.count();
	// Count handed-off tombstones awaiting manager retry/void.
	const handedOff = await db.outbox
		.where("status")
		.equals("handed_off")
		.count();

	// Actual MIN(enqueued_at) — Dexie .first() uses primary-key order, not time.
	const oldest = await minEnqueuedAtForStatuses(["enqueued", "retry_pending"]);
	const oldestMinutes =
		oldest === null ? null : Math.max(0, Math.floor((Date.now() - oldest) / 60_000));

	// Oldest stuck tombstone by original enqueue time — worst-case staleness signal.
	const oldestHandedOff = await minEnqueuedAtForStatuses(["handed_off"]);
	const oldestHandedOffMinutes =
		oldestHandedOff === null
			? null
			: Math.max(0, Math.floor((Date.now() - oldestHandedOff) / 60_000));

	return {
		device_id: readDeviceId(),
		beacon_at: new Date().toISOString().replace("T", " ").slice(0, 19),
		online: connectivity.isOnline() ? 1 : 0,
		outlet: state.currentOutlet,
		active_shift: state.currentShift,
		user: state.currentUser,
		queue_depth: enqueued + retryPending,
		in_flight: inFlight,
		needs_review: needsReview,
		handed_off: handedOff,
		oldest_minutes: oldestMinutes,
		oldest_handed_off_minutes: oldestHandedOffMinutes,
		last_sync_at: state.lastSyncAt
			? new Date(state.lastSyncAt).toISOString().replace("T", " ").slice(0, 19)
			: null,
		last_sync_outcome: state.lastSyncOutcome ?? "",
		sw_build_hash: readSwBuildHash(),
		spa_user_agent:
			typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 240) : "",
	};
}

/** True MIN(enqueued_at) across rows in any given status. Bounded scan — Dexie .first() uses primary-key order, not time. */
async function minEnqueuedAtForStatuses(
	statuses: string[],
	cap = 5000,
): Promise<number | null> {
	let oldest: number | null = null;
	for (const s of statuses) {
		const rows = await db.outbox.where("status").equals(s).limit(cap).toArray();
		for (const r of rows) {
			if (oldest === null || r.enqueued_at < oldest) {
				oldest = r.enqueued_at;
			}
		}
	}
	return oldest;
}
