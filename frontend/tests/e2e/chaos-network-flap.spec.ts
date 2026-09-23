/**
 * Chaos 4 — Network flap mid-drain (14-testing-strategy.md §7).
 *
 * Expected flow:
 *   1. Enqueue 5 offline invoices.
 *   2. Flip online; drain begins.
 *   3. Mid-drain (after entry 2 succeeds) flip offline for 3s, then online.
 *   4. Scheduler pauses during offline window, resumes cleanly, remaining
 *      entries drain without duplicates.
 *
 * Assertions:
 *   - Final queue depth = 0.
 *   - No outbox row is observed in `in_flight` state for more than 5s.
 *   - Server doc count for the offline_ids = 5 (no duplicates).
 *
 * TODO(phase-1-1.14): harness to observe outbox state + server doc counts.
 */

import { test } from "@playwright/test";

test.skip("network flap mid-drain: pauses + resumes, zero duplicates", () => {
	// Needs live server + Dexie-observer helpers. Phase 1 task 1.14.
});
