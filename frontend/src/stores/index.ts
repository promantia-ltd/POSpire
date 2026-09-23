/**
 * Pinia stores for POSpire offline UI state.
 *
 * ---------------------------------------------------------------------------
 * Convention: stores are reactive UI state ONLY. They do NOT own durability.
 * IndexedDB (via Dexie) is the single durable store (D-27, P-1).
 *
 * Guardrails (enforced by review / future ESLint no-restricted-imports):
 *   - NO `pinia-plugin-persist` or equivalent. Stores never write to
 *     localStorage. Re-hydrate from Dexie on mount.
 *   - Stores do not call server APIs directly. They call `@/utils/call` or
 *     subscribe to offline modules (connectivity, Dexie `liveQuery`).
 *   - Stores expose read-only state + documented actions. Components never
 *     mutate store state directly.
 *
 * Phase 1 stores: `connectivity`, `outbox`.
 * Phase 2 store: `shift` (NOT implemented here).
 * ---------------------------------------------------------------------------
 *
 * This module re-exports the store composables and exposes a tiny test
 * harness wrapping `createTestingPinia` so Agent 7's unit tests can share one
 * pattern. No test code is written here — this only smooths the ergonomics.
 */

import type { App } from "vue";
import { createPinia, setActivePinia } from "pinia";

export { useConnectivityStore } from "./connectivity";
export { useOutboxStore } from "./outbox";

/**
 * Convenience: plug into the Vue app in `main.js`. Kept thin so it doesn't
 * hide the `createPinia()` call from new readers.
 */
export function installPinia(app: App): void {
	const pinia = createPinia();
	app.use(pinia);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Options forwarded to `@pinia/testing`'s `createTestingPinia`. Kept loose so
 * this file doesn't pull the testing package into the production bundle —
 * Agent 7's tests import from `@pinia/testing` directly and pass the result
 * here (or call `createTestingPinia` themselves). This helper just sets the
 * active pinia synchronously for stores instantiated outside a component.
 *
 * Usage (in a test file):
 *
 *   import { createTestingPinia } from "@pinia/testing";
 *   import { activateTestingPinia, useOutboxStore } from "@/stores";
 *
 *   const pinia = createTestingPinia({ createSpy: vi.fn });
 *   activateTestingPinia(pinia);
 *   const store = useOutboxStore();
 *
 * We do NOT import `@pinia/testing` at module load because it is a devDep;
 * the test file owns that dependency.
 */
export function activateTestingPinia(pinia: unknown): void {
	// `setActivePinia` accepts any object shaped like a Pinia instance; this
	// wrapper just gives tests a stable name to import from.
	setActivePinia(pinia as Parameters<typeof setActivePinia>[0]);
}
