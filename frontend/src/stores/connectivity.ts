/**
 * Pinia store: connectivity.
 *
 * A thin reactive facade over Agent 2's connectivity state machine
 * (`@/offline/connectivity`). The store subscribes via `onChange(...)` on
 * first instantiation and keeps its state in sync. Components consume the
 * store to drive banner copy, the navbar pending-sync indicator, and any
 * other connectivity-aware UI.
 *
 * Guardrails (D-27, P-1):
 *   - No durability. The store does not write to localStorage or IndexedDB.
 *     The connectivity module owns volatile state; reloading the app re-boots
 *     the detector.
 *   - No direct network calls. Only subscribes to the state machine.
 *   - Manual overrides delegate to the connectivity module so one code path
 *     owns the override semantics.
 */

import { computed, ref } from "vue";
import { defineStore } from "pinia";

import connectivityModule, {
	type ConnectivityState,
	type ConnectivityStatus,
} from "@/offline/connectivity";

/**
 * The public surface of the store. Kept narrow on purpose — components pull
 * only what they need and stores stay easy to mock.
 */
export const useConnectivityStore = defineStore("connectivity", () => {
	// ---- reactive state -----------------------------------------------------

	// Start from the current snapshot so the first render doesn't flash the
	// default "online" state before the first listener invocation.
	const initial: ConnectivityState = connectivityModule.state();

	const status = ref<ConnectivityStatus>(initial.status);
	const lastTransitionAt = ref<number>(initial.lastTransitionAt);
	const lastPingAt = ref<number | null>(initial.lastPingAt);
	const lastPingRttMs = ref<number | null>(initial.lastPingRttMs);
	const manualOverride = ref<"online" | "offline" | null>(initial.manualOverride);
	const consecutiveFailures = ref<number>(initial.consecutiveFailures);
	const consecutiveSuccesses = ref<number>(initial.consecutiveSuccesses);

	// ---- subscription -------------------------------------------------------

	// Lazily set up the listener the first time the store is used. Storing
	// the unsubscribe on a module-local (not state) ref avoids triggering
	// reactivity on teardown.
	let unsubscribe: (() => void) | null = null;
	function ensureSubscribed(): void {
		if (unsubscribe) return;
		unsubscribe = connectivityModule.onChange((next) => {
			status.value = next.status;
			lastTransitionAt.value = next.lastTransitionAt;
			lastPingAt.value = next.lastPingAt;
			lastPingRttMs.value = next.lastPingRttMs;
			manualOverride.value = next.manualOverride;
			consecutiveFailures.value = next.consecutiveFailures;
			consecutiveSuccesses.value = next.consecutiveSuccesses;
		});
	}
	ensureSubscribed();

	// ---- derived state ------------------------------------------------------

	/**
	 * `true` when the detector considers the server reachable. Matches
	 * `connectivity.isOnline()` — treats `degraded` as online because live
	 * calls still succeed (the banner uses `connectionQuality` for nuance).
	 */
	const isOnline = computed<boolean>(() => {
		if (manualOverride.value === "offline") return false;
		if (manualOverride.value === "online") return true;
		return status.value === "online" || status.value === "degraded";
	});

	/**
	 * Three-way quality used by the banner. Callers that only need the
	 * boolean should use `isOnline` instead.
	 */
	const connectionQuality = computed<"online" | "degraded" | "offline">(() => {
		if (manualOverride.value) {
			return manualOverride.value === "online" ? "online" : "offline";
		}
		return status.value;
	});

	// ---- actions (thin pass-throughs) --------------------------------------

	/**
	 * Manager override helpers. The banner "force online / offline" controls
	 * call these; storing the override on the detector means a reload drops
	 * the override, which is the documented behaviour (in-memory only, never
	 * persisted).
	 */
	function forceOnline(): void {
		connectivityModule.forceOnline();
	}
	function forceOffline(): void {
		connectivityModule.forceOffline();
	}
	function clearManualOverride(): void {
		connectivityModule.clearManualOverride();
	}

	return {
		// state
		status,
		lastTransitionAt,
		lastPingAt,
		lastPingRttMs,
		manualOverride,
		consecutiveFailures,
		consecutiveSuccesses,
		// derived
		isOnline,
		connectionQuality,
		// actions
		forceOnline,
		forceOffline,
		clearManualOverride,
	};
});
