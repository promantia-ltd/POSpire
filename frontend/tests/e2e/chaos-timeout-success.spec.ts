/**
 * Chaos 1 — Timeout-after-server-success (14-testing-strategy.md §7).
 *
 * Expected flow:
 *   1. Enqueue one offline invoice.
 *   2. While draining, let the server receive the POST and commit, then drop
 *      the connection before the response arrives (Playwright route abort
 *      AFTER the request has been read).
 *   3. Scheduler retries with the same offline_id.
 *   4. Server returns `idempotent_duplicate`; outbox marks synced; no
 *      duplicate document in the database.
 *
 * The "no duplicate in server DB" assertion requires a server-side fake
 * that mirrors the real idempotency table, or a direct DB read via a
 * whitelisted helper.
 *
 * TODO(phase-1-1.14): Agent 6's idempotency table + assertion helper.
 */

import { test } from "@playwright/test";

test.skip("timeout-after-server-success: retry with same offline_id → idempotent, no duplicate", () => {
	// Needs a server fake / helper for the "no duplicate on server" assertion.
	// Phase 1 task 1.14.
});
