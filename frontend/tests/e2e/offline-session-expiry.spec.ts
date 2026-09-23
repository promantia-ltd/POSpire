/**
 * Chaos 6 — Session expiry mid-sync (14-testing-strategy.md §7).
 *
 * Expected flow:
 *   1. Enqueue two offline invoices.
 *   2. While draining, inject a 401 on one POST.
 *   3. Scheduler pauses; UI prompts re-login.
 *   4. After re-auth, drain resumes from the same row (no duplicate in DB).
 *
 * Requires live Frappe + a 401-injection point. The cleanest approach is
 * Playwright's `page.route(...)` intercept matching
 * `/api/method/pospire.pospire.api.offline.submit_invoice` and returning a
 * one-shot 401 on the first call.
 *
 * TODO(phase-1-1.14): harness + login flow replay.
 */

import { test } from "@playwright/test";

test.skip("session expiry mid-sync: drain pauses, resumes after re-auth, no duplicates", () => {
	// Needs a live Frappe + route-intercept harness. Phase 1 task 1.14.
});
