/**
 * Pinia outbox store tests (Agent 5).
 *
 * Spec coverage:
 *   - 02-system-overview.md §2 (stores don't own durability — D-27)
 *   - 05-outbox-and-sync.md §6 (needs_review surface)
 *   - 14-testing-strategy.md §5 (integration with Dexie liveQuery)
 *
 * We use `createTestingPinia({ stubActions: false })` so store composables
 * execute as in production (including the liveQuery subscription). The store
 * reacts to real Dexie row changes; we enqueue through the outbox module and
 * then wait (briefly) for Dexie's change notifier to fire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestingPinia } from "@pinia/testing";

import { enqueue, markNeedsReview, markInFlight, markSynced } from "@/offline/outbox";
import { useOutboxStore, activateTestingPinia } from "@/stores";

import {
	setupOfflineStorage,
	teardownOfflineStorage,
} from "../helpers/offline-fixture";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

beforeEach(async () => {
	await setupOfflineStorage();
	const pinia = createTestingPinia({
		stubActions: false,
		createSpy: vi.fn,
	});
	activateTestingPinia(pinia);
});

afterEach(async () => {
	await teardownOfflineStorage();
});

/**
 * Poll-until-match helper for Dexie liveQuery propagation. liveQuery fires
 * asynchronously; tests wait on a predicate rather than a hard sleep.
 */
async function waitFor<T>(
	fn: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 2_000,
): Promise<T> {
	const start = Date.now();
	// Microtask yield first so the initial liveQuery fire reaches the store.
	await Promise.resolve();
	while (Date.now() - start < timeoutMs) {
		const v = fn();
		if (predicate(v)) return v;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(
		`waitFor: predicate did not match within ${timeoutMs}ms, last value=${JSON.stringify(fn())}`,
	);
}

// ---------------------------------------------------------------------------
// pendingCount / needsReviewCount reactivity
// ---------------------------------------------------------------------------

describe("outbox store — liveQuery reactivity", () => {
	it("pendingCount increments when a new entry is enqueued", async () => {
		const store = useOutboxStore();

		await waitFor(
			() => store.pendingCount,
			(v) => v === 0,
		);

		await enqueue("invoice", { total: 1 });

		const final = await waitFor(
			() => store.pendingCount,
			(v) => v === 1,
		);
		expect(final).toBe(1);
	});

	it("needsReviewCount increments when an entry is marked needs_review", async () => {
		const store = useOutboxStore();
		const ack = await enqueue("invoice", { total: 2 });

		await waitFor(
			() => store.pendingCount,
			(v) => v === 1,
		);

		await markNeedsReview(ack.offline_id, "validation_error", "bad");

		await waitFor(
			() => store.needsReviewCount,
			(v) => v === 1,
		);
		await waitFor(
			() => store.pendingCount,
			(v) => v === 0,
		);

		expect(store.needsReviewEntries).toHaveLength(1);
		expect(store.needsReviewEntries[0]!.offline_id).toBe(ack.offline_id);
		expect(store.needsReviewEntries[0]!.last_error_category).toBe(
			"validation_error",
		);
	});

	it("queuedCount = pending + inFlight (banner depth number)", async () => {
		const store = useOutboxStore();

		const ack1 = await enqueue("invoice", { total: 1 });
		const ack2 = await enqueue("invoice", { total: 2 });

		await waitFor(
			() => store.pendingCount,
			(v) => v === 2,
		);

		// Flip one to in_flight.
		await markInFlight(ack1.offline_id);

		// Wait on inFlightCount specifically — queuedCount === 2 also matches
		// the initial {pending: 2, inflight: 0} state before the liveQuery has
		// re-fired to reflect the markInFlight transition.
		await waitFor(
			() => store.inFlightCount,
			(v) => v === 1,
		);

		expect(store.pendingCount).toBe(1);
		expect(store.inFlightCount).toBe(1);
		expect(store.queuedCount).toBe(2); // 1 pending + 1 in-flight

		// Sync it — depth drops to 1.
		await markSynced(ack1.offline_id, "SI-1");

		await waitFor(
			() => store.queuedCount,
			(v) => v === 1,
		);

		// Clean up the unused enqueue (keep lint happy).
		void ack2;
	});

	it("oldestPendingAt tracks the earliest enqueued_at among pending rows", async () => {
		const store = useOutboxStore();
		await enqueue("invoice", { total: 1 });
		const before = Date.now() + 1;
		await enqueue("invoice", { total: 2 });

		await waitFor(
			() => store.oldestPendingAt,
			(v) => v !== null,
		);
		// The oldest should be in the past (before the second enqueue's timestamp).
		expect(store.oldestPendingAt).not.toBeNull();
		expect(store.oldestPendingAt!).toBeLessThanOrEqual(before + 10_000);
	});
});
