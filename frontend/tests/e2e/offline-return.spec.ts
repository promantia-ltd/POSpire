/**
 * Scenario 3 — Offline return (14-testing-strategy.md §6).
 *
 * Expected flow:
 *   1. Online: cashier fetches an existing invoice for return.
 *   2. Go offline; process the return referencing the existing doc.
 *   3. Return enqueues to outbox with parent = original invoice offline_id
 *      (or server name — depends on final spec for Agent 6 return endpoint).
 *   4. Reconnect: return syncs; server records the reversal against the
 *      original invoice with no duplicates (P-5).
 *
 * TODO(phase-1-1.14): return endpoint (D-30) is shipped in Agent 6's Wave
 * 2 — until then this scenario is blocked on the backend. Currently the
 * client wires it up (outbox type "return") but drain would 404.
 */

import { test } from "@playwright/test";

test.skip("offline return: queues + applies against the original invoice, no duplicate", () => {
	// Blocked on Agent 6's create_return endpoint (D-30, Wave 2). Test body
	// lives here; unblock once 1.14 harness is ready and endpoint ships.
});
