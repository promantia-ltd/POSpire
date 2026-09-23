/**
 * Sync scheduler.
 *
 * Owns the drain loop that empties the outbox into the server, one entry at
 * a time, in dependency order. Leader-gated across tabs via the Web Locks
 * API with a Dexie-lease fallback for older browsers. Pauses on connectivity
 * transitions, resumes on reconnect, and stops cleanly when `Pos.vue` unmounts.
 *
 * Per-cycle summaries are appended to `metadata.sync_log` (capped at 1,000)
 * and uploaded via `log_batch` on reconnect.
 */

import { connectivity, type ConnectivityState } from "./connectivity";
import { db } from "./db";
import {
	assertOfflineEnabled,
	isOfflineEnabled,
	OfflineDisabledError,
} from "./kill-switch";
import {
	evaluateClosingReadiness,
	evaluateParents,
	getEntry,
	listByStatus,
	markBlocked,
	reconcileBlockedParents,
	markHandedOff,
	markInFlight,
	markIntegrityMismatch,
	markNeedsReview,
	markSynced,
	markVacuumed,
	nextReady,
	onEnqueue,
	resolvePayload,
	scheduleRetry,
	verifyIntegrity,
	MAX_ATTEMPTS,
} from "./outbox";
import { call } from "@/utils/call";
import type {
	LastErrorCategory,
	OutboxEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Web Lock name used for leader election. */
const LEADER_LOCK_NAME = "pospire-sync";
/** BroadcastChannel for cross-tab UI state (queue depth, etc). */
const BROADCAST_CHANNEL_NAME = "pospire-offline";

/** Dexie-lease fallback (D-26) for browsers without Web Locks. */
const LEASE_META_KEY = "scheduler.leader_lease";
const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_EXPIRY_MS = 15_000;

/** Cycle log cap (05-outbox-and-sync.md §8). */
const SYNC_LOG_META_KEY = "sync_log";
const SYNC_LOG_CAP = 1_000;

/** Default wake interval when no entry is due but we have queued work. */
const DEFAULT_WAKE_MS = 1_000;
/** Longer wake when the queue is fully drained. */
const IDLE_WAKE_MS = 30_000;

/**
 * Metadata key for the cashier-set "pause sync" preference. Persisted in
 * Dexie so the choice survives reload, and so a non-leader tab that
 * acquires leadership later starts in the right state.
 */
const PAUSE_META_KEY = "scheduler.user_paused";

/** Queue depth at which the UI surfaces the Pause control. */
export const LARGE_BACKLOG_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Cycle log
// ---------------------------------------------------------------------------

export interface SyncCycleLog {
	cycle_id: string;
	started_at: number;
	finished_at: number;
	queue_depth_start: number;
	drained: number;
	moved_to_needs_review: Record<string, number>;
	longest_latency_ms: number;
	next_wake_ms: number | null;
	leader: boolean;
	/** Rows parked on a dependency 409 (siblings/parent not ready) this cycle. */
	parked?: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class SyncScheduler {
	private running = false;
	private leader = false;
	private loopPromise: Promise<void> | null = null;
	private abort = new AbortController();
	private wakeResolver: (() => void) | null = null;
	/** Set when `kick()` fires before `waitForWake` is armed. */
	private pendingKick = false;
	private connectivityUnsub: (() => void) | null = null;
	private enqueueUnsub: (() => void) | null = null;
	private broadcastChannel: BroadcastChannel | null = null;
	private leaseHeartbeatHandle: ReturnType<typeof setInterval> | null = null;
	private usingLeaseFallback = false;
	private leaseOwnerId = "";
	/** Resolved when the caller's `start()` successfully becomes leader. */
	private leaderAcquired: Promise<void> | null = null;
	/**
	 * Cashier-set pause flag. When true, the drain loop skips the work
	 * step at every cycle and idles. Hydrated from Dexie metadata at
	 * `start()` so the preference survives reload. Mutated only via
	 * `pauseSync()` / `resumeSync()` so persistence + broadcast stay
	 * consistent with the in-memory flag.
	 */
	private userPaused = false;
	/**
	 * One-shot bypass for `userPaused`. Set by `syncNow()`; consumed
	 * (cleared) by the drain loop on the next iteration after one work
	 * cycle has run. Lets a cashier with a paused queue drain a single
	 * entry — e.g. the oldest queued sale before close-shift — without
	 * unsetting Pause. Not persisted: a reload while paused starts in
	 * the normal paused-idle state until the cashier hits Sync now or
	 * Resume again.
	 */
	private forceOneCycle = false;

	/** Start the scheduler. Acquires the leader lock and begins the drain loop. Idempotent. */
	async start(): Promise<void> {
		if (this.running) return this.leaderAcquired ?? Promise.resolve();
		this.running = true;

		// Hydrate the cashier's pause preference from Dexie metadata so a
		// reload doesn't silently resume drain after the cashier paused.
		try {
			const row = await db.metadata.get(PAUSE_META_KEY);
			this.userPaused = !!(row && row.value === true);
		} catch (err) {
			// Metadata read failed — keep default (unpaused). The cashier
			// can re-pause from the UI; we never want a Dexie blip to
			// silently halt sync.
			// eslint-disable-next-line no-console
			console.warn("[scheduler] PAUSE_META_KEY hydration failed", err);
			this.userPaused = false;
		}

		// Crash-recovery: a tab close / browser crash mid-drain leaves
		// rows stuck in `in_flight` forever — `listReady` only picks up
		// `enqueued` and `retry_pending`. Re-arm them as enqueued on startup
		// so the scheduler retries; server idempotency on offline_id makes
		// duplicate POSTs safe (P-5).
		try {
			await this.reviveOrphanedInFlight();
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn("[scheduler] in_flight recovery failed", err);
		}

		this.connectivityUnsub = connectivity.onChange((s) =>
			this.handleConnectivity(s),
		);
		this.enqueueUnsub = onEnqueue(() => this.kick());

		// Leader election — Web Locks preferred; Dexie-lease fallback.
		if (
			typeof navigator !== "undefined" &&
			typeof navigator.locks !== "undefined" &&
			typeof navigator.locks.request === "function"
		) {
			this.leaderAcquired = this.acquireWebLock();
		} else {
			this.leaderAcquired = this.acquireLease();
		}

		if (typeof BroadcastChannel !== "undefined") {
			this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
		}

		return this.leaderAcquired;
	}

	/**
	 * Stop the scheduler. Releases the leader lock, cancels timers, and
	 * aborts the in-flight fetch (if any).
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.leader = false;
		this.abort.abort();
		this.abort = new AbortController();

		this.connectivityUnsub?.();
		this.connectivityUnsub = null;
		this.enqueueUnsub?.();
		this.enqueueUnsub = null;

		if (this.leaseHeartbeatHandle) {
			clearInterval(this.leaseHeartbeatHandle);
			this.leaseHeartbeatHandle = null;
		}
		if (this.usingLeaseFallback) {
			await this.releaseLease().catch(() => {
				/* best-effort */
			});
			this.usingLeaseFallback = false;
		}

		if (this.broadcastChannel) {
			this.broadcastChannel.close();
			this.broadcastChannel = null;
		}

		// Let any waiter on `kick()` resolve and drop out of the loop.
		this.pendingKick = true;
		this.resolveWake();
		// Await loop termination so callers can confidently re-start if
		// they want to.
		if (this.loopPromise) {
			await this.loopPromise.catch(() => {
				/* already handled inside */
			});
			this.loopPromise = null;
		}
	}

	/** Wake the drain loop. Called on connectivity change / new enqueue. */
	kick(): void {
		this.resolveWake();
	}

	/**
	 * Manual cashier control: pause the drain loop until `resumeSync()`
	 * is called. Already-in-flight requests finish gracefully (the cycle
	 * preamble's pause check fires at the START of each iteration, not
	 * mid-cycle). Persisted to Dexie metadata so a reload — or a leader
	 * handoff to another tab — picks up the same paused state.
	 *
	 * Idempotent. No-op when already paused.
	 */
	async pauseSync(): Promise<void> {
		if (this.userPaused) return;
		this.userPaused = true;
		await this.persistPauseState();
		// Wake the loop so it observes the new flag and idles instead of
		// continuing into the work step.
		this.kick();
		this.publishStateToPeers(null, false);
	}

	/**
	 * Resume drain after `pauseSync()`. Idempotent — no-op when already
	 * running. Wakes the loop immediately so any backlog starts draining
	 * without waiting for the next idle wake (~30s).
	 */
	async resumeSync(): Promise<void> {
		if (!this.userPaused) return;
		this.userPaused = false;
		await this.persistPauseState();
		this.kick();
		this.publishStateToPeers(null, false);
	}

	/**
	 * Manual "drain now" — wakes the loop immediately. Useful when the
	 * cashier has paused, taken a few more orders, then wants to drain
	 * before closing shift. Or when the cashier wants to verify that a
	 * just-restored connection is actually working.
	 *
	 * Behaviour while paused: the drain loop normally idles whenever
	 * `userPaused` is true (so a cashier with a heavy backlog can keep
	 * ringing without the sync noise). `syncNow` sets a one-shot
	 * `forceOneCycle` flag that the loop honours ONCE — exactly one
	 * cycle of work runs, then the flag is cleared and the loop goes
	 * back to honouring the paused state. Lets a cashier drain a single
	 * entry (typically the oldest queued sale) without unsetting Pause.
	 *
	 * To fully resume, use `resumeSync()` instead.
	 */
	syncNow(): void {
		// Only arm the one-shot bypass when actually paused. If we set
		// `forceOneCycle = true` unconditionally, an unpaused cashier
		// who clicks Sync Now leaves the flag latched (the unpaused
		// drain doesn't enter the `if (userPaused)` branch that
		// consumes it). Later, when the cashier DOES pause, the next
		// paused cycle would drain one unexpected entry — silent
		// inconsistency vs. the user's intent. Arming only when paused
		// keeps the flag's lifetime tight: set → consumed on the next
		// cycle → cleared. Order matters: set BEFORE kick() since
		// `kick()` resolves the wake promise synchronously.
		if (this.userPaused) {
			this.forceOneCycle = true;
		}
		this.kick();
	}

	/** Whether the cashier has manually paused drain. UI binds to this. */
	isPaused(): boolean {
		return this.userPaused;
	}

	/**
	 * Persist `userPaused` to Dexie metadata. Single-row read-modify-
	 * write inside a transaction so concurrent pause/resume calls don't
	 * leave the metadata row out of sync with the in-memory flag.
	 */
	private async persistPauseState(): Promise<void> {
		try {
			await db.metadata.put({
				key: PAUSE_META_KEY,
				value: this.userPaused,
				updated_at: Date.now(),
			});
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn("[scheduler] persistPauseState failed", err);
		}
	}

	/** Snapshot for the banner / debug UI. */
	status(): { running: boolean; leader: boolean; paused: boolean } {
		return {
			running: this.running,
			leader: this.leader,
			paused: this.userPaused,
		};
	}

	// -------------------------------------------------------------------
	// Leader election
	// -------------------------------------------------------------------

	private async acquireWebLock(): Promise<void> {
		// `navigator.locks.request` resolves when the callback returns; the
		// callback is what holds the lock. We hold the lock for as long as
		// the scheduler is running.
		return new Promise<void>((resolvePromise) => {
			navigator.locks
				.request(
					LEADER_LOCK_NAME,
					{ mode: "exclusive" },
					async () => {
						this.leader = true;
						resolvePromise();
						// Start / continue the drain loop under the lock.
						this.loopPromise = this.drainLoop();
						try {
							await this.loopPromise;
						} finally {
							this.leader = false;
							this.loopPromise = null;
						}
					},
				)
				.catch((err) => {
					// Request rejected — e.g. document is frozen. Fall back to
					// a lease so at least one tab keeps draining.
					console.warn(
						"[sync] Web Lock rejected, falling back to Dexie lease",
						err,
					);
					this.acquireLease().then(resolvePromise).catch(() => {
						resolvePromise();
					});
				});
		});
	}

	private async acquireLease(): Promise<void> {
		this.usingLeaseFallback = true;
		this.leaseOwnerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		const tryAcquire = async (): Promise<boolean> => {
			return db.transaction("rw", db.metadata, async () => {
				const existing = await db.metadata.get(LEASE_META_KEY);
				const now = Date.now();
				const stale =
					!existing ||
					typeof existing.value !== "object" ||
					existing.value === null ||
					(existing.value as { heartbeat_at?: number }).heartbeat_at === undefined ||
					now -
						((existing.value as { heartbeat_at?: number })
							.heartbeat_at ?? 0) >
						LEASE_EXPIRY_MS;
				if (!stale) return false;
				await db.metadata.put({
					key: LEASE_META_KEY,
					value: {
						owner_id: this.leaseOwnerId,
						heartbeat_at: now,
					},
					updated_at: now,
				});
				return true;
			});
		};

		// Poll until we win.
		while (this.running) {
			const won = await tryAcquire();
			if (won) break;
			await sleep(LEASE_HEARTBEAT_MS);
		}
		if (!this.running) return;

		this.leader = true;

		// Heartbeat so other tabs see us as alive.
		this.leaseHeartbeatHandle = setInterval(() => {
			void this.heartbeatLease();
		}, LEASE_HEARTBEAT_MS);

		this.loopPromise = this.drainLoop();
		this.loopPromise
			.catch((err) => {
				console.error("[sync] drain loop crashed", err);
			})
			.finally(() => {
				this.leader = false;
				this.loopPromise = null;
			});
	}

	private async heartbeatLease(): Promise<void> {
		if (!this.running || !this.leader) return;
		await db
			.transaction("rw", db.metadata, async () => {
				const existing = await db.metadata.get(LEASE_META_KEY);
				if (
					!existing ||
					typeof existing.value !== "object" ||
					existing.value === null
				) {
					return;
				}
				const value = existing.value as {
					owner_id?: string;
					heartbeat_at?: number;
				};
				if (value.owner_id !== this.leaseOwnerId) {
					// We were preempted. Surrender leadership.
					this.leader = false;
					this.resolveWake();
					return;
				}
				await db.metadata.put({
					key: LEASE_META_KEY,
					value: {
						owner_id: this.leaseOwnerId,
						heartbeat_at: Date.now(),
					},
					updated_at: Date.now(),
				});
			})
			.catch(() => {
				/* lease write fails are transient; next heartbeat will retry */
			});
	}

	private async releaseLease(): Promise<void> {
		await db.transaction("rw", db.metadata, async () => {
			const existing = await db.metadata.get(LEASE_META_KEY);
			if (
				existing &&
				typeof existing.value === "object" &&
				existing.value !== null &&
				(existing.value as { owner_id?: string }).owner_id ===
					this.leaseOwnerId
			) {
				await db.metadata.delete(LEASE_META_KEY);
			}
		});
	}

	// -------------------------------------------------------------------
	// Drain loop
	// -------------------------------------------------------------------

	private async drainLoop(): Promise<void> {
		while (this.running && this.leader) {
			const cycle = this.beginCycle();

			// Pause while offline or kill-switched.
			if (!connectivity.isOnline()) {
				cycle.next_wake_ms = null;
				await this.finishCycle(cycle);
				await this.waitForOnline();
				continue;
			}

			let killed = false;
			try {
				killed = !(await isOfflineEnabled());
			} catch {
				killed = false;
			}
			if (killed) {
				cycle.next_wake_ms = null;
				await this.finishCycle(cycle);
				await sleep(IDLE_WAKE_MS);
				continue;
			}

			// Cashier-set pause. `forceOneCycle` is the one-shot bypass set by `syncNow()`.
			if (this.userPaused) {
				if (this.forceOneCycle) {
					this.forceOneCycle = false;
					// Fall through into the work step — single cycle
					// honoured. The next iteration of the while-loop
					// will see userPaused=true + forceOneCycle=false
					// and idle as normal.
				} else {
					cycle.next_wake_ms = null;
					await this.finishCycle(cycle);
					await this.waitForWake(IDLE_WAKE_MS);
					continue;
				}
			}

			// Drain needs_review rows not yet handed off; heals after offline windows. Non-throwing.
			try {
				await flushPendingHandoffs();
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] flushPendingHandoffs threw", err);
			}

			// Poll server for resolved/voided tombstones and upgrade local rows. Non-throwing.
			try {
				await vacuumTombstones();
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] vacuumTombstones threw", err);
			}

			// Refresh runtime config then run tombstone GC. Both non-throwing.
			try {
				await refreshRuntimeConfig();
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] refreshRuntimeConfig threw", err);
			}
			try {
				await gcLocalTombstones();
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] gcLocalTombstones threw", err);
			}
			// Repair rows latched on a parent that will never arrive. Must run
			// here rather than in the gate: listReady filters blocked rows out
			// before evaluateParents ever sees them again.
			try {
				const repaired = await reconcileBlockedParents();
				if (repaired > 0) {
					// eslint-disable-next-line no-console
					console.info(`[sync] reconcileBlockedParents repaired ${repaired} row(s)`);
				}
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] reconcileBlockedParents threw", err);
			}

			const entry = await nextReady<Record<string, unknown>>();
			if (!entry) {
				cycle.next_wake_ms = IDLE_WAKE_MS;
				await this.finishCycle(cycle);
				await this.waitForWake(IDLE_WAKE_MS);
				continue;
			}

			// Dependency / closure gating.
			const gate = await this.checkGate(entry);
			if (gate === "waiting") {
				// Nudge next_attempt_at forward so we re-check soon without
				// busy-looping.
				await scheduleRetry(
					entry.offline_id,
					entry.attempt_count,
					"network_error",
					"waiting_for_siblings",
				);
				cycle.next_wake_ms = DEFAULT_WAKE_MS;
				await this.finishCycle(cycle);
				await this.waitForWake(DEFAULT_WAKE_MS);
				continue;
			}
			if (gate === "blocked") {
				await markBlocked(
					entry.offline_id,
					entry.type === "closing_entry"
						? "waiting_for_siblings"
						: "waiting_for_parent",
				);
				cycle.next_wake_ms = DEFAULT_WAKE_MS;
				await this.finishCycle(cycle);
				// Try the next entry immediately — this one is parked until a
				// parent resolves.
				await this.yieldToEventLoop();
				continue;
			}

			// Integrity check before claim.
			const integrity = await verifyIntegrity(entry);
			if (!integrity.ok) {
				await markIntegrityMismatch(entry.offline_id, integrity.detail);
				cycle.drained += 1;
				cycle.moved_to_needs_review["integrity_mismatch"] =
					(cycle.moved_to_needs_review["integrity_mismatch"] ?? 0) + 1;
				await this.finishCycle(cycle);
				await this.yieldToEventLoop();
				continue;
			}

			// Claim (compare-and-swap). If we lose the race (another tab
			// somehow beat us to it), move on.
			const claimed = await markInFlight(entry.offline_id);
			if (!claimed) {
				await this.yieldToEventLoop();
				continue;
			}

			const sendStart = performance.now();
			try {
				const result = await this.sendEntry(entry);
				const latency = performance.now() - sendStart;
				cycle.longest_latency_ms = Math.max(
					cycle.longest_latency_ms,
					latency,
				);
				cycle.drained += 1;

				if (result.kind === "synced") {
					await markSynced(entry.offline_id, result.serverDocName);
					// Any entries blocked on this row are now unblocked; the
					// next drain tick picks them up. We don't explicitly
					// unblock here to avoid a scan on every send — the next
					// `evaluateParents` call will resolve them.
				} else if (result.kind === "retry") {
					await scheduleRetry(
						entry.offline_id,
						entry.attempt_count + 1,
						result.category,
						result.detail,
					);
				} else if (result.kind === "park") {
					// Persist WHAT the row is waiting on, not just that it is
					// waiting — the reconciliation workspace reads
					// `last_error_detail`. Passing only two args would default
					// `detail` to null and wipe any prior error text.
					const waitingOn = result.missingOfflineIds.length
						? ` (waiting on: ${result.missingOfflineIds.join(", ")})`
						: "";
					await markBlocked(
						entry.offline_id,
						result.reason,
						`${result.detail}${waitingOn}`,
					);
					cycle.parked = (cycle.parked ?? 0) + 1;
				} else {
					// Mark needs_review first (stable terminal state) before attempting
					// handoff — the next cycle retries the handoff if it fails.
					await markNeedsReview(
						entry.offline_id,
						result.category,
						result.detail,
					);
					cycle.moved_to_needs_review[result.category] =
						(cycle.moved_to_needs_review[result.category] ?? 0) + 1;
					await attemptHandoff(entry, result.category, result.detail);
				}
			} catch (err) {
				// Unexpected error inside the send pipeline — treat as
				// transient so we don't drop the row.
				const detail = err instanceof Error ? err.message : String(err);
				await scheduleRetry(
					entry.offline_id,
					entry.attempt_count + 1,
					"network_error",
					detail,
				);
			}

			await this.finishCycle(cycle);
			// Yield so the UI thread can paint between entries
			// (05-outbox-and-sync.md §4.2).
			await this.yieldToEventLoop();
		}
	}

	private async checkGate(
		entry: OutboxEntry<unknown>,
	): Promise<"ready" | "waiting" | "blocked"> {
		const parent = await evaluateParents(entry);
		if (parent !== "ready") return parent;
		// Strict closure for closing_entry.
		if (entry.type === "closing_entry") {
			const closure = await evaluateClosingReadiness(entry);
			if (closure !== "ready") return closure;
		}
		return "ready";
	}

	// -------------------------------------------------------------------
	// Send pipeline
	// -------------------------------------------------------------------

	private async sendEntry(
		entry: OutboxEntry<Record<string, unknown>>,
	): Promise<SendResult> {
		const method = methodForEntry(entry);
		if (!method) {
			return {
				kind: "needsReview",
				category: "schema_mismatch",
				detail: `No server method registered for outbox type "${entry.type}"`,
			};
		}

		const resolvedPayload = (await resolvePayload(entry)) as Record<
			string,
			unknown
		>;

		// Defensive: ensure posting_date + owner_user are inside the inner
		// `data` JSON so the server's _apply_payload_metadata accepts the
		// request. The adapter normally puts them there at enqueue time, but
		// (a) older queued rows pre-dating the adapter fix may not have them,
		// and (b) the outbox stores authoritative posting_date / owner_user
		// snapshots at the entry level — we prefer the entry's snapshot over
		// any value left over from cart-time defaults.
		const replayPayload = patchInnerDataMetadata(
			resolvedPayload,
			entry.posting_date,
			entry.owner_user,
		);

		try {
			// Bypass call()'s connectivity gate; the scheduler already verified online and
			// holds a resolved payload — re-entering the normal flow risks re-enqueueing.
			const res = (await call({
				method,
				args: {
					...replayPayload,
					offline_id: entry.offline_id,
					device_id: entry.device_id,
				},
				intent: "write",
				offlineIdempotencyKey: entry.offline_id,
				bypassConnectivityForReplay: true,
			})) as {
				name?: string;
				server_doc_name?: string;
				was_already_submitted?: boolean;
				docstatus?: number;
				is_background_job?: boolean;
			};

			// Refuse "synced" for non-final docstatus — submit_invoice can return
			// docstatus=0 when background submissions are enabled. Retry is safe via idempotency.
			// Customer is non-submittable (docstatus always 0); skip the check for that type.
			const docstatus = typeof res.docstatus === "number" ? res.docstatus : null;
			const isSubmittableType = entry.type !== "customer";
			if (
				isSubmittableType &&
				docstatus !== null &&
				docstatus !== 1 &&
				docstatus !== 2 // 2 = cancelled, also a settled terminal state
			) {
				return {
					kind: "retry",
					category: "server_5xx", // closest transient bucket; backoff applies
					detail: `server returned docstatus=${docstatus}` +
						(res.is_background_job ? " (background_job)" : ""),
				};
			}

			// 2xx with terminal docstatus (or no docstatus reported) → synced.
			const docName =
				res.server_doc_name ?? res.name ?? entry.server_doc_name;
			if (!docName) {
				return {
					kind: "needsReview",
					category: "validation_error",
					detail: "server returned 2xx but no doc name",
				};
			}
			return { kind: "synced", serverDocName: docName };
		} catch (err) {
			if (err instanceof OfflineDisabledError) {
				// Kill switch flipped mid-send. Requeue as retry.
				return {
					kind: "retry",
					category: "network_error",
					detail: "kill switch flipped during send",
				};
			}
			return classifySendError(err, entry.attempt_count, entry);
		}
	}

	// -------------------------------------------------------------------
	// Connectivity integration
	// -------------------------------------------------------------------

	private handleConnectivity(s: ConnectivityState): void {
		if (s.status === "online" || s.status === "degraded") {
			this.kick();
		}
		// We don't cancel mid-send on offline — the inflight fetch either
		// errors out via `TypeError: Failed to fetch` (classified as
		// network_error) or succeeds. Aborting mid-fetch adds more edge
		// cases than it prevents.
	}

	private async waitForOnline(): Promise<void> {
		if (connectivity.isOnline()) return;
		await new Promise<void>((resolve) => {
			const unsub = connectivity.onChange((s) => {
				if (s.status === "online" || s.status === "degraded") {
					unsub();
					resolve();
				}
			});
			// Safety: if scheduler stops while we wait, resolve anyway.
			const stopCheck = setInterval(() => {
				if (!this.running) {
					clearInterval(stopCheck);
					unsub();
					resolve();
				}
			}, 500);
		});
	}

	// -------------------------------------------------------------------
	// Wake primitive — either a timeout or a `kick()` resolves.
	// -------------------------------------------------------------------

	private waitForWake(timeoutMs: number): Promise<void> {
		// If a kick landed between loop iterations, consume it and return
		// immediately so we don't miss the signal.
		if (this.pendingKick) {
			this.pendingKick = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				this.wakeResolver = null;
				clearTimeout(t);
				resolve();
			};
			const t = setTimeout(done, timeoutMs);
			this.wakeResolver = done;
		});
	}

	private resolveWake(): void {
		const r = this.wakeResolver;
		if (r) {
			this.wakeResolver = null;
			r();
		} else {
			// No one is waiting yet; remember the kick so the next
			// `waitForWake` consumes it.
			this.pendingKick = true;
		}
	}

	private yieldToEventLoop(): Promise<void> {
		return new Promise((r) => setTimeout(r, 0));
	}

	// -------------------------------------------------------------------
	// Cycle logging
	// -------------------------------------------------------------------

	private beginCycle(): SyncCycleLog {
		const cycle = {
			cycle_id: cryptoRandomId(),
			started_at: Date.now(),
			finished_at: 0,
			queue_depth_start: 0,
			drained: 0,
			moved_to_needs_review: {},
			longest_latency_ms: 0,
			next_wake_ms: DEFAULT_WAKE_MS,
			leader: this.leader,
		};
		// Broadcast `phase: "draining"` to non-leader tabs at cycle START so
		// their UI can show "syncing…" in real time. Without this, peers only
		// see the phase change at cycle END (when finishCycle publishes), and
		// a long drain looks like "idle" until the very last entry resolves.
		this.publishStateToPeers(null, /* draining */ true);
		return cycle;
	}

	private async finishCycle(cycle: SyncCycleLog): Promise<void> {
		cycle.finished_at = Date.now();
		try {
			cycle.queue_depth_start = await db.outbox
				.where("status")
				.anyOf(["enqueued", "in_flight", "retry_pending"])
				.count();
		} catch {
			cycle.queue_depth_start = -1;
		}
		await appendSyncLog(cycle);
		this.publishStateToPeers(cycle);
	}

	/** Compute the scheduler's current phase for peer broadcast. */
	private currentPhase(draining: boolean): "idle" | "draining" | "paused" {
		if (!this.running) return "idle";
		if (draining) return "draining";
		// Running but no active cycle. We surface "paused" for any state
		// where work is gated off: cashier explicitly paused, non-leader
		// tab, kill-switched, or offline. Leader idling between cycles
		// with no work to do → "idle".
		if (this.userPaused) return "paused";
		if (!this.leader) return "paused";
		return "idle";
	}

	private publishStateToPeers(cycle: SyncCycleLog | null, draining = false): void {
		if (!this.broadcastChannel) return;
		try {
			this.broadcastChannel.postMessage({
				kind: "sync_state",
				phase: this.currentPhase(draining),
				leader: this.leader,
				queue_depth: cycle?.queue_depth_start ?? null,
				drained: cycle?.drained ?? 0,
				needs_review: cycle
					? Object.values(cycle.moved_to_needs_review).reduce((a, b) => a + b, 0)
					: 0,
				at: cycle?.finished_at ?? Date.now(),
			});
		} catch {
			/* channel closed / post failed — not fatal */
		}
	}

	/**
	 * Crash recovery (T11): on scheduler.start(), reset any rows stuck in
	 * `in_flight` from a prior tab/process that exited mid-POST. They go
	 * back to `enqueued` so the next drain picks them up; server idempotency
	 * on `pos_offline_id` ensures the duplicate POST returns the existing
	 * doc (was_already_submitted=true) without inserting a second row.
	 *
	 * Voided rows are skipped — terminal state, never revived.
	 */
	private async reviveOrphanedInFlight(): Promise<void> {
		const stuck = await db.outbox.where("status").equals("in_flight").toArray();
		if (stuck.length === 0) return;
		await db.transaction("rw", db.outbox, async () => {
			for (const row of stuck) {
				// Defensive — voided shouldn't be in_flight, but guard anyway.
				if ((row as { status?: string }).status === "voided") continue;
				await db.outbox.put({
					...row,
					status: "enqueued",
					next_attempt_at: Date.now(),
				});
			}
		});
	}
}

// ---------------------------------------------------------------------------
// Send result discriminator
// ---------------------------------------------------------------------------

type SendResult =
	| { kind: "synced"; serverDocName: string }
	| {
			kind: "retry";
			category: NonNullable<LastErrorCategory>;
			detail: string | null;
	  }
	| {
			kind: "needsReview";
			category: NonNullable<LastErrorCategory>;
			detail: string | null;
	  }
	| {
			kind: "park";
			reason: "waiting_for_parent" | "waiting_for_siblings";
			detail: string;
			missingOfflineIds: string[];
	  };

// ---------------------------------------------------------------------------
// Method resolution — maps outbox type → server endpoint.
// ---------------------------------------------------------------------------

/**
 * Hand off a needs_review entry to the server-side review queue, transitioning
 * the local row to `handed_off`. Idempotent on offline_id. Skipped while offline;
 * flushPendingHandoffs retries on the next online cycle. Never throws.
 */
async function attemptHandoff(
	entry: OutboxEntry<unknown>,
	errorCategory: NonNullable<LastErrorCategory>,
	errorDetail: string | null,
): Promise<void> {
	if (!connectivity.isOnline()) {
		// Offline now — `flushPendingHandoffs` (called from the cycle
		// preamble) will pick this up on the next online cycle.
		return;
	}
	try {
		// `entry.payload` is already decrypted at this point (sync.ts
		// resolved the envelope before the send attempt). We pass it
		// straight through; the server canonicalises and hashes.
		//
		// Pin the failed entry's offline_id, not a fresh UUID — recovery.handoff
		// uses the original id to look up the entry server-side.
		const res = (await call({
			method: "pospire.pospire.api.recovery.handoff",
			intent: "write",
			offlineIdempotencyKey: entry.offline_id,
			args: {
				offline_id: entry.offline_id,
				entry_type: entry.type,
				payload: entry.payload,
				error_category: errorCategory,
				error_detail: errorDetail ?? "",
				attempt_count: entry.attempt_count,
				parent_offline_ids: entry.parent_offline_ids,
				shift_offline_id: entry.shift_offline_id,
				posting_date: entry.posting_date,
				device_id: entry.device_id,
				cashier_user: entry.owner_user,
				// `BUILD_HASH` is injected at Vite build time via
				// frappeui-build-config-plugin (see vite.config.ts).
				// Fall back to a sentinel so the field is never missing.
				client_build_hash:
					(globalThis as unknown as { __POSPIRE_BUILD_HASH__?: string })
						.__POSPIRE_BUILD_HASH__ ?? "unknown",
			},
		})) as { name?: string; was_existing?: boolean } | null;
		const recoveryName = res?.name;
		if (!recoveryName) {
			// eslint-disable-next-line no-console
			console.warn(
				"[sync] handoff returned no row name for",
				entry.offline_id,
				res,
			);
			trackHandoffOutcome(entry.offline_id, false);
			return;
		}
		await markHandedOff(entry.offline_id, recoveryName);
		trackHandoffOutcome(entry.offline_id, true);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(
			"[sync] handoff failed; entry stays in needs_review",
			{
				offline_id: entry.offline_id,
				error: err instanceof Error ? err.message : String(err),
			},
		);
		trackHandoffOutcome(entry.offline_id, false);
	}
}

/**
 * Drain the `needs_review` backlog by attempting handoff for any rows
 * that haven't yet been moved to `handed_off`. Called from the cycle
 * preamble so a transient offline window (handoff failed, row stuck in
 * needs_review) heals on the next online cycle.
 *
 * Bounded scan: limits at 50 entries per cycle to avoid hogging the
 * leader for a very large backlog. Rows missed in this cycle get
 * picked up on the next one.
 */
async function flushPendingHandoffs(): Promise<void> {
	if (!connectivity.isOnline()) return;
	let entries: OutboxEntry<unknown>[];
	try {
		entries = await listByStatus("needs_review");
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[sync] flushPendingHandoffs: listByStatus failed", err);
		return;
	}
	// Bound per cycle so a large backlog doesn't hog the leader.
	for (const entry of entries.slice(0, 50)) {
		await attemptHandoff(
			entry,
			(entry.last_error_category ??
				"validation_error") as NonNullable<LastErrorCategory>,
			entry.last_error_detail,
		);
	}
}

/**
 * Poll the server for resolution status of `handed_off` tombstones and upgrade
 * local rows: Resolved → synced (unblocks dependents), Voided → voided.
 * Bounded scan, skipped while offline.
 */
async function vacuumTombstones(): Promise<void> {
	if (!connectivity.isOnline()) return;
	let entries: OutboxEntry<unknown>[];
	try {
		entries = await listByStatus("handed_off");
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[sync] vacuumTombstones: listByStatus failed", err);
		return;
	}
	if (entries.length === 0) return;

	// Cap below server's 200-id limit; next cycle picks up remainder.
	const slice = entries.slice(0, 100);
	const offlineIds = slice.map((e) => e.offline_id);
	// Send both ids; server prefers offline_id match, falls back to name match.
	const recoveryEntryNames = slice.map((e) => e.recovery_entry_name ?? "");

	let resolutions: Record<
		string,
		{
			status: string;
			resolved_doctype?: string | null;
			resolved_doc_name?: string | null;
			matched_by?: "offline_id" | "recovery_entry_name";
		}
	>;
	try {
		resolutions = (await call({
			method: "pospire.pospire.api.recovery.lookup_resolution",
			intent: "read",
			args: {
				offline_ids: offlineIds,
				recovery_entry_names: recoveryEntryNames,
			},
		})) as typeof resolutions;
	} catch (err) {
		// Lookup failure is non-fatal — the next cycle will retry.
		// eslint-disable-next-line no-console
		console.warn("[sync] vacuumTombstones lookup failed", err);
		return;
	}

	for (const entry of slice) {
		const remote = resolutions?.[entry.offline_id];
		if (!remote) continue; // Server has no record — leave tombstoned.
		if (remote.matched_by === "recovery_entry_name") {
			// Matched by name fallback — log for visibility.
			console.warn(
				"[sync] vacuum matched tombstone via recovery_entry_name",
				{ local_offline_id: entry.offline_id, recovery_entry_name: entry.recovery_entry_name },
			);
		}
		if (remote.status === "Resolved") {
			try {
				await markVacuumed(
					entry.offline_id,
					"Resolved",
					remote.resolved_doc_name ?? null,
				);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(
					"[sync] vacuumTombstones markVacuumed(Resolved) failed",
					entry.offline_id,
					err,
				);
			}
		} else if (remote.status === "Voided") {
			try {
				await markVacuumed(entry.offline_id, "Voided", null);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(
					"[sync] vacuumTombstones markVacuumed(Voided) failed",
					entry.offline_id,
					err,
				);
			}
		}
		// Pending / Retrying / In Review → no change, we'll poll again
		// next cycle. The `handed_off` tombstone is already correct.
	}
}

// ---------------------------------------------------------------------------
// Tombstone GC + stuck handoff escalation
// ---------------------------------------------------------------------------

/**
 * Cached runtime config from the server. Populated by
 * `refreshRuntimeConfig` (called periodically from the cycle preamble);
 * used by `gcLocalTombstones` and `attemptHandoff`. The defaults below
 * are hard-coded fallbacks for the case where the device has never
 * reached the server — same numbers as the server-side doctype defaults.
 */
const RUNTIME_CONFIG_DEFAULTS = {
	client_tombstone_retention_days: 14,
	client_handoff_stuck_threshold_cycles: 10,
};
let runtimeConfig: typeof RUNTIME_CONFIG_DEFAULTS = { ...RUNTIME_CONFIG_DEFAULTS };
let runtimeConfigFetchedAt = 0;
const RUNTIME_CONFIG_TTL_MS = 12 * 60 * 60 * 1000; // 12h

async function refreshRuntimeConfig(): Promise<void> {
	if (
		runtimeConfigFetchedAt > 0 &&
		Date.now() - runtimeConfigFetchedAt < RUNTIME_CONFIG_TTL_MS
	) {
		return;
	}
	if (!connectivity.isOnline()) return;
	try {
		const res = (await call({
			method: "pospire.pospire.api.offline.get_offline_runtime_config",
			intent: "read",
		})) as
			| {
					client_tombstone_retention_days?: number;
					client_handoff_stuck_threshold_cycles?: number;
			  }
			| null;
		if (res && typeof res === "object") {
			runtimeConfig = {
				client_tombstone_retention_days:
					typeof res.client_tombstone_retention_days === "number"
						? res.client_tombstone_retention_days
						: RUNTIME_CONFIG_DEFAULTS.client_tombstone_retention_days,
				client_handoff_stuck_threshold_cycles:
					typeof res.client_handoff_stuck_threshold_cycles === "number"
						? res.client_handoff_stuck_threshold_cycles
						: RUNTIME_CONFIG_DEFAULTS.client_handoff_stuck_threshold_cycles,
			};
			runtimeConfigFetchedAt = Date.now();
		}
	} catch (err) {
		// Non-fatal — keep defaults / last-known values.
		// eslint-disable-next-line no-console
		console.warn("[sync] refreshRuntimeConfig failed", err);
	}
}

/** Delete synced/voided outbox rows older than `client_tombstone_retention_days`. Idempotent. */
/** Max tombstones deleted per GC cycle — prevents pathological backlog from blocking a cycle. */
const GC_MAX_DELETIONS_PER_CYCLE = 1000;

export async function gcLocalTombstones(): Promise<void> {
	const retentionDays = runtimeConfig.client_tombstone_retention_days;
	if (!retentionDays || retentionDays <= 0) return;

	const cutoffMs = Date.now() - retentionDays * 86_400_000;

	// Collect ALL candidate tombstones (no slice limit) so the oldest-
	// first ordering below is across the full set, not a status-index
	// window. The status index narrows to {synced, voided} cheaply, and
	// the count is bounded by retention × outlet tx-volume (typical:
	// low thousands, well within an in-memory sort).
	const all: Array<{ offline_id: string; ref_ts: number }> = [];
	for (const status of ["synced", "voided"] as const) {
		const rows = await db.outbox.where("status").equals(status).toArray();
		for (const r of rows) {
			// Use synced_at for synced rows (their actual completion
			// time); fall back to enqueued_at for voided rows that
			// never produced a synced_at (or for synced rows that
			// somehow lack one — defensive).
			const referenceTs = r.synced_at ?? r.enqueued_at;
			if (typeof referenceTs === "number" && referenceTs < cutoffMs) {
				all.push({ offline_id: r.offline_id, ref_ts: referenceTs });
			}
		}
	}

	if (all.length === 0) return;

	// Oldest-first so we always make progress on the genuine backlog,
	// not on whatever the status index happened to surface this cycle.
	all.sort((a, b) => a.ref_ts - b.ref_ts);

	// Single transaction — if it errors, we keep all rows rather than
	// leaving a half-cleaned state. The reference scan runs inside it too, so
	// a child enqueued between scan and delete cannot lose its parent.
	let deleted = 0;
	try {
		await db.transaction("rw", db.outbox, async () => {
			// A parent still referenced by a non-terminal child must survive.
			// Deleting it hard-blocks that child forever: evaluateParents
			// cannot reason about a row that is no longer there.
			const referenced = new Set<string>();
			for (const row of await db.outbox.toArray()) {
				if (row.status === "synced" || row.status === "voided") continue;
				for (const pid of row.parent_offline_ids ?? []) referenced.add(pid);
			}
			const toDelete = all
				.filter((x) => !referenced.has(x.offline_id))
				.slice(0, GC_MAX_DELETIONS_PER_CYCLE);
			for (const { offline_id } of toDelete) {
				await db.outbox.delete(offline_id);
			}
			deleted = toDelete.length;
		});
		// eslint-disable-next-line no-console
		console.info(
			`[sync] gcLocalTombstones reaped ${deleted} tombstones older than ${retentionDays}d` +
				(all.length > deleted
					? ` (${all.length - deleted} still retained or queued for the next cycle)`
					: ""),
		);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[sync] gcLocalTombstones transaction failed", err);
	}
}

/** Tracks per-id consecutive handoff failures; decorates the row with STUCK_HANDOFF when threshold crossed. */
const handoffFailureCounts = new Map<string, number>();

function trackHandoffOutcome(offlineId: string, ok: boolean): void {
	if (ok) {
		handoffFailureCounts.delete(offlineId);
		return;
	}
	const next = (handoffFailureCounts.get(offlineId) ?? 0) + 1;
	handoffFailureCounts.set(offlineId, next);
	const threshold = runtimeConfig.client_handoff_stuck_threshold_cycles;
	if (threshold > 0 && next >= threshold) {
		// Decorate the row's last_error_detail so the beacon picks it
		// up. We append rather than overwrite so the original failure
		// reason remains visible.
		void (async () => {
			try {
				const stored = await db.outbox.get(offlineId);
				if (!stored) return;
				const tag = `[STUCK_HANDOFF count=${next}/${threshold}]`;
				if (stored.last_error_detail?.includes("[STUCK_HANDOFF")) return;
				await db.outbox.put({
					...stored,
					last_error_detail: `${tag} ${stored.last_error_detail ?? ""}`.slice(
						0,
						2000,
					),
				});
				// eslint-disable-next-line no-console
				console.warn(
					`[sync] handoff stuck for offline_id=${offlineId} (${next} consecutive failures)`,
				);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[sync] trackHandoffOutcome decoration failed", err);
			}
		})();
	}
}

/**
 * Boot-time flush: attempt handoff for any needs_review rows already in the local outbox.
 * Idempotent — rows already handed off are skipped. Returns attempted count.
 */
export async function migrateLegacyNeedsReviewEntries(): Promise<{
	attempted: number;
	online: boolean;
}> {
	if (!connectivity.isOnline()) {
		return { attempted: 0, online: false };
	}
	let entries: OutboxEntry<unknown>[] = [];
	try {
		entries = await listByStatus("needs_review");
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(
			"[sync] migrateLegacyNeedsReviewEntries: listByStatus failed",
			err,
		);
		return { attempted: 0, online: true };
	}
	const slice = entries.slice(0, 50);
	for (const entry of slice) {
		await attemptHandoff(
			entry,
			(entry.last_error_category ??
				"validation_error") as NonNullable<LastErrorCategory>,
			entry.last_error_detail,
		);
	}
	return { attempted: slice.length, online: true };
}

function methodForEntry(entry: OutboxEntry<unknown>): string | null {
	switch (entry.type) {
		case "customer":
			return "pospire.pospire.api.offline.create_customer";
		case "material_receipt":
			return "pospire.pospire.api.offline.create_material_receipt";
		case "invoice":
			return "pospire.pospire.api.offline.submit_invoice";
		case "opening_entry":
			return "pospire.pospire.api.offline.create_opening_entry";
		case "closing_entry":
			return "pospire.pospire.api.offline.create_closing_entry";
		case "return":
			// Live-only; unmapped so stray rows surface to needs_review.
			return null;
		case "payment":
			// Not wired for offline; goes through the online payment pipeline.
			return null;
		case "cash_movement":
			return null;
	}
}

// ---------------------------------------------------------------------------
// Error classification — maps thrown errors to SendResult categories.
// ---------------------------------------------------------------------------

function classifySendError(
	err: unknown,
	attemptCount: number,
	entry?: { server_doc_name: string | null },
): SendResult {
	// frappe-ui rejections + our own wrappers all end up here. We pull
	// `status`, `error_code`, and a few common shapes.
	const detail = err instanceof Error ? err.message : String(err);
	const status = extractStatus(err);
	const errorCode = extractErrorCode(err);

	// Idempotent duplicate — the server already accepted this offline_id on a
	// prior attempt. Mark synced (not retry): semantically this IS success
	// (P-5). Use the doc name from the error envelope, or the one we stored
	// from a prior attempt. If neither is available, fall through to retry
	// so a fresh POST gets us a 2xx with the canonical name.
	if (errorCode === "was_already_submitted") {
		const docName = extractServerDocName(err) ?? entry?.server_doc_name ?? null;
		if (docName) {
			return { kind: "synced", serverDocName: docName };
		}
		return {
			kind: "retry",
			category: "idempotent_duplicate",
			detail: "was_already_submitted but no doc name in envelope",
		};
	}

	if (typeof status === "number") {
		if (status === 426) {
			return {
				kind: "needsReview",
				category: "schema_mismatch",
				detail,
			};
		}
		if (status === 400) {
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "validation_error"),
				detail,
			};
		}
		if (status === 417) {
			// Server's _HTTP_STATUS_BY_CODE maps 417 to accounting_period_closed
			// exclusively. Fall back to that category if error_code is missing.
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "accounting_period_closed"),
				detail,
			};
		}
		if (status === 401) {
			// Session expired mid-drain. Returning `retry` would burn through
			// 8 attempts in seconds (each one fails the same way). Mark as
			// needs_review so the cashier can re-authenticate and replay from
			// the workspace. We also signal the connectivity detector so the
			// UI flips to a not-online state and the drain pauses.
			connectivity.reportRequestOutcome("network_error");
			return {
				kind: "needsReview",
				category: "permission_error",
				detail: `session expired (401): ${detail}`,
			};
		}
		if (status === 403) {
			return { kind: "needsReview", category: "permission_error", detail };
		}
		if (status === 404) {
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "customer_missing"),
				detail,
			};
		}
		if (status === 409) {
			// 409 is the dependency / conflict bucket: parent_not_ready,
			// siblings_not_ready, stock_shortage, batch_or_serial_conflict.
			//
			// The two dependency codes PARK. MAX_ATTEMPTS was sized for
			// transient transport failures; a closing waiting on its invoices
			// may legitimately wait far longer, and every attempt is a wasted
			// round-trip that burns the budget until the row lands in
			// needs_review anyway — the very state parking exists to avoid.
			// The outbox already has the machinery and the pre-send gate
			// already uses it, so route into that rather than inventing a
			// second path. Parking does NOT consume an attempt.
			//
			// A generic 409 with no error_code is NOT assumed transient — the
			// old `parent_not_ready` default was a guess and must not become
			// an automatic park.
			if (errorCode === "siblings_not_ready" || errorCode === "parent_not_ready") {
				return {
					kind: "park",
					reason:
						errorCode === "siblings_not_ready"
							? "waiting_for_siblings"
							: "waiting_for_parent",
					detail,
					missingOfflineIds: extractMissingOfflineIds(err),
				};
			}
			return {
				kind: "needsReview",
				category: errorCodeToCategory(errorCode, "validation_error"),
				detail,
			};
		}
		if (status >= 500 && status < 600) {
			if (attemptCount + 1 >= MAX_ATTEMPTS) {
				return { kind: "needsReview", category: "retry_exhausted", detail };
			}
			return { kind: "retry", category: "server_5xx", detail };
		}
		if (status >= 400 && status < 500) {
			return { kind: "needsReview", category: "validation_error", detail };
		}
	}

	// Treat unclassifiable / network-shaped errors as retryable.
	if (attemptCount + 1 >= MAX_ATTEMPTS) {
		return { kind: "needsReview", category: "retry_exhausted", detail };
	}
	if (isTimeoutLike(err)) {
		return { kind: "retry", category: "timeout", detail };
	}
	return { kind: "retry", category: "network_error", detail };
}

/**
 * Pull `missing_offline_ids` off a server dependency error so the
 * reconciliation workspace can show the cashier exactly which invoices a
 * close is waiting on.
 *
 * `_throw` (offline.py) puts structured fields under `details`, so that is
 * where this normally lives; the top-level read is a cheap fallback for any
 * build that flattens the payload. Same two-shape handling as
 * `extractServerDocName` above.
 */
function extractMissingOfflineIds(err: unknown): string[] {
	if (!err || typeof err !== "object") return [];
	const e = err as Record<string, unknown>;
	const fromTop = e.missing_offline_ids;
	if (Array.isArray(fromTop)) {
		return fromTop.filter((v): v is string => typeof v === "string" && v.length > 0);
	}
	const details = e.details as Record<string, unknown> | undefined;
	const fromDetails = details?.missing_offline_ids;
	if (Array.isArray(fromDetails)) {
		return fromDetails.filter((v): v is string => typeof v === "string" && v.length > 0);
	}
	return [];
}

/**
 * Patches posting_date + owner_user into the inner `data` JSON if missing,
 * so the server's `_apply_payload_metadata` always has them.
 */
function patchInnerDataMetadata(
	payload: Record<string, unknown>,
	postingDate: string | null | undefined,
	ownerUser: string | null | undefined,
): Record<string, unknown> {
	const dataField = payload.data;
	if (typeof dataField !== "string") return payload;
	let inner: Record<string, unknown>;
	try {
		const parsed = JSON.parse(dataField);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return payload;
		}
		inner = parsed as Record<string, unknown>;
	} catch {
		return payload; // not JSON — leave alone
	}
	let mutated = false;
	if (!inner.posting_date && postingDate) {
		inner.posting_date = postingDate;
		mutated = true;
	}
	if (!inner.owner_user && !inner.owner && ownerUser) {
		inner.owner_user = ownerUser;
		mutated = true;
	}
	if (!mutated) return payload;
	return { ...payload, data: JSON.stringify(inner) };
}

/**
 * Pulls a server doc name out of an error envelope, if present. Frappe's
 * error shapes vary; we probe the common locations.
 */
function extractServerDocName(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["server_doc_name", "name", "doc_name"]) {
		const v = e[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const details = e["details"] as Record<string, unknown> | undefined;
	if (details) {
		for (const k of ["server_doc_name", "name", "doc_name"]) {
			const v = details[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	return undefined;
}

function extractStatus(err: unknown): number | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["status", "statusCode", "httpStatus"]) {
		const v = e[k];
		if (typeof v === "number") return v;
	}
	return undefined;
}

function extractErrorCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	for (const k of ["error_code", "code", "exc_type"]) {
		const v = e[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	// Frappe commonly wraps in `messages[0].error_code` (frappe-ui's parsed
	// shape) or `_server_messages` (raw JSON-encoded list of message dicts).
	const msgs = e["messages"];
	if (Array.isArray(msgs) && msgs.length > 0) {
		const first = msgs[0] as Record<string, unknown>;
		if (typeof first?.error_code === "string" && first.error_code) {
			return first.error_code as string;
		}
	}
	const serverMsgs = e["_server_messages"];
	if (typeof serverMsgs === "string" && serverMsgs.length > 0) {
		try {
			// _server_messages is a JSON-stringified ARRAY of JSON-stringified
			// dicts. Parse twice.
			const outer = JSON.parse(serverMsgs);
			if (Array.isArray(outer) && outer.length > 0) {
				const first = typeof outer[0] === "string"
					? (JSON.parse(outer[0]) as Record<string, unknown>)
					: (outer[0] as Record<string, unknown>);
				if (typeof first?.error_code === "string" && first.error_code) {
					return first.error_code as string;
				}
			}
		} catch {
			/* malformed _server_messages — fall through */
		}
	}
	// Frappe also surfaces top-level `details.error_code` when the server
	// uses `frappe.local.response["error_code"]` (our `_throw` path).
	const details = e["details"] as Record<string, unknown> | undefined;
	if (details && typeof details.error_code === "string") {
		return details.error_code;
	}
	return undefined;
}

function errorCodeToCategory(
	errorCode: string | undefined,
	fallback: NonNullable<LastErrorCategory>,
): NonNullable<LastErrorCategory> {
	if (!errorCode) return fallback;
	switch (errorCode) {
		case "parent_not_ready":
			return "parent_not_ready";
		case "siblings_not_ready":
			return "siblings_not_ready";
		case "customer_missing":
			return "customer_missing";
		case "batch_conflict":
		case "serial_conflict":
		case "batch_or_serial_conflict":
			return "batch_or_serial_conflict";
		case "stock_shortage":
			return "stock_shortage";
		case "accounting_period_closed":
			return "accounting_period_closed";
		case "schema_mismatch":
			return "schema_mismatch";
		case "validation_error":
			return "validation_error";
		case "permission_error":
			return "permission_error";
		default:
			return fallback;
	}
}

function isTimeoutLike(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as Record<string, unknown>;
	const name = typeof e.name === "string" ? e.name : "";
	return name === "AbortError" || name === "TimeoutError";
}

// ---------------------------------------------------------------------------
// metadata.sync_log — cycle log persistence
// ---------------------------------------------------------------------------

async function appendSyncLog(entry: SyncCycleLog): Promise<void> {
	try {
		await db.transaction("rw", db.metadata, async () => {
			const row = await db.metadata.get(SYNC_LOG_META_KEY);
			const list = Array.isArray(row?.value)
				? (row.value as SyncCycleLog[])
				: [];
			list.push(entry);
			while (list.length > SYNC_LOG_CAP) list.shift();
			await db.metadata.put({
				key: SYNC_LOG_META_KEY,
				value: list,
				updated_at: Date.now(),
			});
		});
	} catch {
		// Logging must never take down the drain. Swallow here (NOT on the
		// send path).
	}
}

/** Drain the sync log for upload via `log_batch`. Clears on read. */
export async function drainSyncLog(): Promise<SyncCycleLog[]> {
	return db.transaction("rw", db.metadata, async () => {
		const row = await db.metadata.get(SYNC_LOG_META_KEY);
		const list = Array.isArray(row?.value)
			? (row.value as SyncCycleLog[])
			: [];
		await db.metadata.put({
			key: SYNC_LOG_META_KEY,
			value: [],
			updated_at: Date.now(),
		});
		return list;
	});
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function cryptoRandomId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Re-export helper for the peek UI (optional).
// ---------------------------------------------------------------------------

export async function getEntryByOfflineId(
	offlineId: string,
): Promise<OutboxEntry<unknown> | undefined> {
	return getEntry(offlineId);
}

// ---------------------------------------------------------------------------
// Singleton — ONE scheduler per device. Not auto-started on import so tests
// can import without spinning up a drain loop. Pos.vue owns start()/stop().
// ---------------------------------------------------------------------------

export const scheduler = new SyncScheduler();

export default scheduler;

// Re-export error for banner convenience.
export { OfflineDisabledError };

/**
 * Trigger assertion at module init so the kill-switch module gets a chance
 * to cache an initial value before the first enqueue. Fire-and-forget — any
 * failure is tolerated by the kill-switch module's own defaults.
 */
void assertOfflineEnabled().catch(() => {
	/* default is enabled; nothing to do */
});
