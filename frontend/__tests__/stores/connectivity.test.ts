/**
 * Pinia connectivity store tests (Agent 5).
 *
 * Spec coverage:
 *   - 02-system-overview.md §2 (store is a thin reactive facade, no durability)
 *   - 04-connectivity-detection.md §9 (reactive store state mirrors detector)
 *
 * We don't re-test the underlying state machine here (see
 * `__tests__/offline/connectivity.test.ts`). This suite asserts the store:
 *   - initialises from a snapshot of the module state,
 *   - updates reactively when the detector emits onChange,
 *   - exposes force* / clear actions that delegate to the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestingPinia } from "@pinia/testing";

// NOTE: intentionally NOT statically importing `useConnectivityStore` or
// `@/offline/connectivity`. Both are loaded dynamically inside each test via
// `loadFresh()` below — this ensures that after `vi.resetModules()` in the
// beforeEach, the store and the module that the test inspects are from the
// SAME fresh module graph. A static import would capture a pre-reset reference
// and leak the original module instance across tests, causing
// `manualOverride === null` races after `store.forceOnline()`.

type Loaded = {
	connectivity: typeof import("@/offline/connectivity").default;
	useConnectivityStore: typeof import("@/stores/connectivity").useConnectivityStore;
};

async function loadFresh(): Promise<Loaded> {
	const connectivity = (await import("@/offline/connectivity")).default;
	const { useConnectivityStore } = await import("@/stores/connectivity");
	return { connectivity, useConnectivityStore };
}

beforeEach(async () => {
	// Fresh module graph per test so the store's module-level `unsubscribe`
	// guard (stores/connectivity.ts) doesn't short-circuit re-subscription
	// when a new Pinia is activated.
	vi.resetModules();
	vi.useFakeTimers();
	// `activateTestingPinia` has to be re-imported too since `@/stores` was
	// reset; use a dynamic import here, mirrored in every test.
	const { activateTestingPinia } = await import("@/stores");
	const pinia = createTestingPinia({
		stubActions: false,
		createSpy: vi.fn,
	});
	activateTestingPinia(pinia);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("connectivity store", () => {
	it("initialises from the current detector snapshot", async () => {
		const { useConnectivityStore } = await loadFresh();
		const store = useConnectivityStore();
		expect(["online", "offline", "degraded"]).toContain(store.status);
		// isOnline is a computed over status + manualOverride.
		expect(typeof store.isOnline).toBe("boolean");
	});

	it("reflects forceOffline() from the module into store.isOnline after the debounce window", async () => {
		const { connectivity, useConnectivityStore } = await loadFresh();
		const store = useConnectivityStore();

		connectivity.forceOffline();
		// D-31 debounce — the listener is invoked via setTimeout(_, 10_000).
		// Advance the fake timer so the listener fires and Pinia refs update.
		await vi.advanceTimersByTimeAsync(11_000);

		expect(store.manualOverride).toBe("offline");
		expect(store.isOnline).toBe(false);

		connectivity.clearManualOverride();
		// clearManualOverride calls notify() synchronously — no debounce here.
		expect(store.manualOverride).toBe(null);
	});

	it("store.forceOnline() / forceOffline() delegate to the module (module state updates synchronously)", async () => {
		const { connectivity, useConnectivityStore } = await loadFresh();
		const store = useConnectivityStore();

		// Module's own state snapshot updates synchronously, even though the
		// store's ref (which flows through the debounced listener) lags.
		store.forceOnline();
		expect(connectivity.state().manualOverride).toBe("online");

		store.forceOffline();
		expect(connectivity.state().manualOverride).toBe("offline");

		store.clearManualOverride();
		expect(connectivity.state().manualOverride).toBe(null);
	});

	it("connectionQuality reflects manual override after the debounce fires", async () => {
		const { useConnectivityStore } = await loadFresh();
		const store = useConnectivityStore();

		store.forceOffline();
		await vi.advanceTimersByTimeAsync(11_000);
		expect(store.connectionQuality).toBe("offline");

		store.forceOnline();
		await vi.advanceTimersByTimeAsync(11_000);
		expect(store.connectionQuality).toBe("online");

		store.clearManualOverride();
		// clearManualOverride notifies synchronously, no timer needed.
		expect(["online", "degraded", "offline"]).toContain(store.connectionQuality);
	});
});
