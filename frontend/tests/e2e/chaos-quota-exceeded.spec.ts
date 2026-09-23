/**
 * Chaos 8 — IndexedDB quota exceeded mid-enqueue (14-testing-strategy.md §7).
 *
 * Expected flow:
 *   1. Fill Dexie to near the origin's storage quota with dummy payloads.
 *   2. Go offline.
 *   3. Attempt an offline sale.
 *   4. outbox.enqueue throws QuotaExceededError.
 *   5. UI blocks the sale with a clear error (banner + modal).
 *   6. No partial row is persisted (P-14).
 *
 * Playwright supports origin storage quota manipulation via DevTools protocol:
 *     await page.context().grantPermissions([...]);
 *     await page.send('Storage.overrideQuotaForOrigin', {quota: ...});
 *
 * TODO(phase-1-1.14): wire the DevTools protocol setup helper.
 */

import { test } from "@playwright/test";

test.skip("quota exceeded mid-enqueue: UI blocks sale, no partial write", () => {
	// Needs DevTools protocol helper for origin quota override. Phase 1 1.14.
});
