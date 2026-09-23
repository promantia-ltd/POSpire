/**
 * Pinia store: outbox (reactive facade).
 *
 * Components read aggregate outbox counts (for the banner, the navbar badge,
 * and the reconciliation workspace) from this store. The store does NOT
 * copy outbox rows into Pinia state — it subscribes to Dexie via `liveQuery`
 * and exposes derived counts + a short window of rows for the workspace
 * (`OfflineSyncStatus.vue` reads needs_review + handed_off + pending lists
 * through `storeToRefs(useOutboxStore())`; recovery actions are server-
 * side only, exposed in the Desk form for the `POSpire Offline Sync
 * Review` doctype.
 *
 * Guardrails (D-27, P-1):
 *   - No durability. All source-of-truth state lives in IndexedDB.
 *   - `liveQuery` is the only subscription primitive used here — it already
 *     handles cross-tab updates via Dexie's observable infrastructure.
 *   - No direct network calls. Sync progress (if needed beyond counts) is
 *     observed from a BroadcastChannel — we wire that up here so the store
 *     can render "in flight" without the scheduler pushing Pinia mutations.
 */

import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { liveQuery, type Subscription } from "dexie";

import { db } from "@/offline/db";
import type { OutboxEntry } from "@/offline/types";

/**
 * Status values that count toward `pendingCount`. `in_flight` is counted
 * separately (UI shows "syncing N" vs "N pending"); the banner's "queued"
 * number is pending + in-flight so both contribute to the cashier-visible
 * depth.
 */
type PendingStatus = "enqueued" | "retry_pending";

/**
 * Minimal projection of an outbox row for the cashier-side status view.
 * `needs_review` rows are entries where in-line handoff failed (transient
 * offline window) — they still need to reach the server. `handed_off`
 * rows are tombstones: the server-side `POSpire Offline Sync Review` row
 * exists; the local row stays for dependency-graph integrity until the
 * vacuum upgrades it.
 */
export interface NeedsReviewSummary {
	offline_id: string;
	type: OutboxEntry["type"];
	last_error_category: OutboxEntry["last_error_category"];
	last_error_detail: OutboxEntry["last_error_detail"];
	enqueued_at: number;
	posting_date: OutboxEntry["posting_date"];
	owner_user: OutboxEntry["owner_user"];
	shift_offline_id: OutboxEntry["shift_offline_id"];
	parent_offline_ids: OutboxEntry["parent_offline_ids"];
	attempt_count: number;
	next_attempt_at: number | null;
	server_doc_name: OutboxEntry["server_doc_name"];
	/**
	 * Set on `handed_off` tombstones. Names the server-side recovery row
	 * the cashier can hand the manager when asking for help. `null` for
	 * pre-handoff `needs_review` rows.
	 */
	recovery_entry_name: string | null;
}

/**
 * Read-only projection of in-flight / queued rows for the workspace's
 * "Pending" tab. No actions are exposed for these rows — they're either
 * already being drained or waiting on the scheduler. Surfaced so the cashier
 * tapping the navbar badge always lands somewhere useful, even when nothing
 * has failed yet.
 */
export interface PendingSummary {
	offline_id: string;
	type: OutboxEntry["type"];
	status: OutboxEntry["status"];
	blocked_reason: OutboxEntry["blocked_reason"];
	attempt_count: number;
	enqueued_at: number;
	next_attempt_at: number | null;
}

export const useOutboxStore = defineStore("outbox", () => {
	// ---- reactive state -----------------------------------------------------

	const pendingCount = ref<number>(0);
	const inFlightCount = ref<number>(0);
	const needsReviewCount = ref<number>(0);
	/**
	 * Tombstone count: rows that have been handed off to the server-side
	 * `POSpire Offline Sync Review` queue and are awaiting manager
	 * resolution. The cashier can see how many of their entries are with
	 * managers; they CAN'T act on them from this device.
	 */
	const handedOffCount = ref<number>(0);

	/**
	 * Count of `opening_entry` rows that have not yet synced. Drives the
	 * F5 chained-shifts banner: warn at 2 stacked, block opening a new
	 * shift at 3. Includes statuses {enqueued, in_flight, retry_pending,
	 * needs_review} — anything that isn't `synced` or `voided` blocks the
	 * cashier from chaining further shifts.
	 */
	const unsyncedOpeningCount = ref<number>(0);

	/** Milliseconds (from `Date.now()`) — null when there are no pending rows. */
	const oldestPendingAt = ref<number | null>(null);

	/** Derived list for the workspace. Intentionally small projection. */
	const needsReviewEntries = ref<NeedsReviewSummary[]>([]);

	/**
	 * Tombstoned rows the cashier has uploaded for manager review.
	 * Read-only — actions (Retry / Void) live in the server-side Desk
	 * form for managers only.
	 */
	const handedOffEntries = ref<NeedsReviewSummary[]>([]);

	/** Derived list for the workspace's "Pending" tab — read-only. */
	const pendingEntries = ref<PendingSummary[]>([]);

	// ---- Dexie live subscriptions ------------------------------------------

	// Track subscription handles so tests can tear them down; production code
	// keeps them alive for the app's lifetime (stores are singletons).
	const subscriptions: Subscription[] = [];

	/**
	 * liveQuery for counts + oldest enqueued_at. One query keeps the index
	 * reads consolidated and fires on any row change. The query returns a
	 * plain object so Dexie diffing is straightforward.
	 */
	const countsSub = liveQuery(async () => {
		// Status-equality queries hit the `status` index.
		const [enqueued, retry, inflight, review, handedOff] = await Promise.all([
			db.outbox.where("status").equals("enqueued").count(),
			db.outbox.where("status").equals("retry_pending").count(),
			db.outbox.where("status").equals("in_flight").count(),
			db.outbox.where("status").equals("needs_review").count(),
			db.outbox.where("status").equals("handed_off").count(),
		]);

		// Oldest pending row by `enqueued_at`. We walk only rows in pending
		// statuses — bounded by the queue depth, which stays small in practice.
		// Doing this in the same liveQuery means it recomputes on any outbox
		// change, which is what we want for "oldest pending" staleness.
		let oldest: number | null = null;
		const pendingStatuses: PendingStatus[] = ["enqueued", "retry_pending"];
		for (const s of pendingStatuses) {
			const row = await db.outbox
				.where("status")
				.equals(s)
				.limit(1000)
				.toArray();
			for (const r of row) {
				if (oldest === null || r.enqueued_at < oldest) {
					oldest = r.enqueued_at;
				}
			}
		}

		// Count opening_entry rows that haven't synced (chained-shifts gate).
		// Walk through the unsynced statuses once and count by type — the
		// queue depth stays small so this is O(N) over a bounded N.
		let unsyncedOpenings = 0;
		const blockingStatuses = [
			"enqueued",
			"retry_pending",
			"in_flight",
			"needs_review",
		] as const;
		for (const s of blockingStatuses) {
			const rows = await db.outbox
				.where("status")
				.equals(s)
				.limit(1000)
				.toArray();
			for (const r of rows) {
				if (r.type === "opening_entry") unsyncedOpenings += 1;
			}
		}

		return {
			enqueued,
			retry,
			inflight,
			review,
			handedOff,
			oldest,
			unsyncedOpenings,
		};
	}).subscribe({
		next: (snap) => {
			pendingCount.value = snap.enqueued + snap.retry;
			inFlightCount.value = snap.inflight;
			needsReviewCount.value = snap.review;
			handedOffCount.value = snap.handedOff;
			oldestPendingAt.value = snap.oldest;
			unsyncedOpeningCount.value = snap.unsyncedOpenings;
		},
		error: (err) => {
			// Never mutate durability on failure; log and keep the last-known
			// counts so the UI doesn't flicker to zero on a transient Dexie
			// blip (P-14 — errors surface, but count state is transient).
			console.error("[stores/outbox] counts liveQuery error", err);
		},
	});
	subscriptions.push(countsSub);

	/**
	 * liveQuery for the reconciliation workspace feed. We only surface the
	 * projection fields the list view needs; the workspace loads the full row
	 * when the manager expands an entry.
	 */
	const reviewSub = liveQuery(async () => {
		const rows = await db.outbox
			.where("status")
			.equals("needs_review")
			.toArray();
		// Project all the fields the workspace's expanded detail panel
		// renders (M1 fix). The list of needs_review rows is bounded —
		// thousands of stuck rows would mean the queue is wedged anyway —
		// so the extra projection cost is negligible vs. the previous
		// minimal projection that left half the detail panel blank.
		// Encrypted payload stays on disk; we never project that here.
		return rows.map<NeedsReviewSummary>((r) => ({
			offline_id: r.offline_id,
			type: r.type,
			last_error_category: r.last_error_category,
			last_error_detail: r.last_error_detail,
			enqueued_at: r.enqueued_at,
			posting_date: r.posting_date,
			owner_user: r.owner_user,
			shift_offline_id: r.shift_offline_id,
			parent_offline_ids: r.parent_offline_ids,
			attempt_count: r.attempt_count,
			next_attempt_at: r.next_attempt_at,
			server_doc_name: r.server_doc_name,
			recovery_entry_name: r.recovery_entry_name ?? null,
		}));
	}).subscribe({
		next: (rows) => {
			needsReviewEntries.value = rows;
		},
		error: (err) => {
			console.error("[stores/outbox] review liveQuery error", err);
		},
	});
	subscriptions.push(reviewSub);

	/**
	 * liveQuery for the cashier-side handed-off tracker. These are
	 * tombstoned rows whose server-side recovery row is still in
	 * Pending Review / In Review / Retrying. The cashier sees them so
	 * they know which transactions are with managers; the local row
	 * stays for dependency-graph integrity until the vacuum upgrades it.
	 */
	const handedOffSub = liveQuery(async () => {
		const rows = await db.outbox
			.where("status")
			.equals("handed_off")
			.toArray();
		rows.sort((a, b) => a.enqueued_at - b.enqueued_at);
		return rows.map<NeedsReviewSummary>((r) => ({
			offline_id: r.offline_id,
			type: r.type,
			last_error_category: r.last_error_category,
			last_error_detail: r.last_error_detail,
			enqueued_at: r.enqueued_at,
			posting_date: r.posting_date,
			owner_user: r.owner_user,
			shift_offline_id: r.shift_offline_id,
			parent_offline_ids: r.parent_offline_ids,
			attempt_count: r.attempt_count,
			next_attempt_at: r.next_attempt_at,
			server_doc_name: r.server_doc_name,
			recovery_entry_name: r.recovery_entry_name ?? null,
		}));
	}).subscribe({
		next: (rows) => {
			handedOffEntries.value = rows;
		},
		error: (err) => {
			console.error("[stores/outbox] handed-off liveQuery error", err);
		},
	});
	subscriptions.push(handedOffSub);

	/**
	 * liveQuery for the workspace's "Pending" tab. Surfaces rows the scheduler
	 * is still working on (enqueued / retry_pending / in_flight). Sorted by
	 * enqueued_at ascending so the oldest-stuck row is at the top — that's
	 * what a manager wants to see first when investigating a queue backlog.
	 */
	const pendingSub = liveQuery(async () => {
		const rows = await db.outbox
			.where("status")
			.anyOf(["enqueued", "retry_pending", "in_flight"])
			.toArray();
		rows.sort((a, b) => a.enqueued_at - b.enqueued_at);
		return rows.map<PendingSummary>((r) => ({
			offline_id: r.offline_id,
			type: r.type,
			status: r.status,
			blocked_reason: r.blocked_reason,
			attempt_count: r.attempt_count,
			enqueued_at: r.enqueued_at,
			next_attempt_at: r.next_attempt_at,
		}));
	}).subscribe({
		next: (rows) => {
			pendingEntries.value = rows;
		},
		error: (err) => {
			console.error("[stores/outbox] pending liveQuery error", err);
		},
	});
	subscriptions.push(pendingSub);

	// ---- BroadcastChannel (scheduler status, advisory only) ----------------

	/**
	 * Agent 3's sync scheduler posts progress updates on a BroadcastChannel
	 * so secondary tabs (and this store) can reflect drain progress without
	 * polling. We listen advisory-only — the authoritative state is still
	 * the Dexie rows, observed by `liveQuery` above.
	 */
	const schedulerPhase = ref<"idle" | "draining" | "paused">("idle");
	let channel: BroadcastChannel | null = null;
	try {
		if (typeof BroadcastChannel !== "undefined") {
			// Must match BROADCAST_CHANNEL_NAME in @/offline/sync.ts. Scheduler
			// publishes `{kind:"sync_state", phase, leader, queue_depth, ...}`
			// after each drain cycle and on phase transitions.
			channel = new BroadcastChannel("pospire-offline");
			channel.addEventListener("message", (ev) => {
				const data = ev.data as
					| { kind?: string; phase?: string }
					| undefined;
				if (!data) return;
				// Accept the canonical "sync_state" payload OR a bare {phase}
				// payload (defensive, in case any code path posts the simpler
				// shape).
				const phase =
					data.kind === "sync_state" || !data.kind ? data.phase : undefined;
				if (
					phase === "idle" ||
					phase === "draining" ||
					phase === "paused"
				) {
					schedulerPhase.value = phase;
				}
			});
		}
	} catch (err) {
		// BroadcastChannel is best-effort; tabs without support get a static
		// "idle" value and still render correct counts from liveQuery.
		console.warn("[stores/outbox] BroadcastChannel unavailable", err);
	}

	// ---- derived --------------------------------------------------------

	/**
	 * Convenience: total count shown in the banner's "N queued" sub-label.
	 * Includes pending + in-flight because the cashier cares about depth,
	 * not whether a row is currently being POSTed.
	 */
	const queuedCount = computed<number>(
		() => pendingCount.value + inFlightCount.value,
	);

	/**
	 * Minutes since the oldest pending row was enqueued. `null` when no
	 * pending rows exist. Used by the banner escalation copy ("Offline —
	 * 48 min" when over 30 min).
	 */
	const oldestPendingMinutes = computed<number | null>(() => {
		if (oldestPendingAt.value === null) return null;
		return Math.max(
			0,
			Math.floor((Date.now() - oldestPendingAt.value) / 60_000),
		);
	});

	// ---- teardown (test harness) -------------------------------------------

	/**
	 * Cancel subscriptions. Production code never calls this — the store is a
	 * singleton and lives with the app. Tests call it between cases to avoid
	 * cross-test leakage.
	 */
	function dispose(): void {
		for (const sub of subscriptions) {
			try {
				sub.unsubscribe();
			} catch {
				/* ignore */
			}
		}
		subscriptions.length = 0;
		if (channel) {
			try {
				channel.close();
			} catch {
				/* ignore */
			}
			channel = null;
		}
	}

	return {
		// state
		pendingCount,
		inFlightCount,
		needsReviewCount,
		handedOffCount,
		unsyncedOpeningCount,
		oldestPendingAt,
		needsReviewEntries,
		handedOffEntries,
		pendingEntries,
		schedulerPhase,
		// derived
		queuedCount,
		oldestPendingMinutes,
		// test-only
		dispose,
	};
});
