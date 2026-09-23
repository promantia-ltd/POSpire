/**
 * Scenario 2 — Offline sale, standard item (14-testing-strategy.md §6).
 *
 * Expected flow:
 *   1. Cashier is online; item cache and POS profile snapshot are hydrated.
 *   2. Test switches the browser context to offline (`page.context().setOffline(true)`).
 *   3. Cashier scans a cached item, pays cash, provisional receipt prints.
 *   4. Banner shows "Offline — 1 queued" within 10s.
 *   5. Test switches back online; within the drain window the queue depth
 *      returns to 0, the provisional receipt can be reprinted with the
 *      server-assigned `name`.
 *
 * Requires a live Frappe site with:
 *   - POSpire app installed (Agent 6 endpoints wired).
 *   - A cashier user authenticated via the shared storageState.
 *   - A POS Profile with at least one cacheable item.
 *
 * TODO(phase-1-1.14): wire the harness fixtures and the seeded POS profile.
 */

import { test } from "@playwright/test";

test.skip("offline sale, standard item (Feature 1 outlet): queues, drains, idempotent", () => {
	// Needs a live Frappe site + authenticated session to exercise. Unlocked
	// by Phase 1 task 1.14.
});
