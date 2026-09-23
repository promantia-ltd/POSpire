/**
 * Shared loader for the Sales Person list.
 *
 * Invoice and Payments each fetched this independently — Invoice on mount,
 * Payments when the cashier opens the payment screen — and each wrote the
 * result to the same `sales_persons_storage` key. The triggers do not overlap,
 * so in-flight deduplication alone would collapse nothing; the second call is
 * only avoidable by sharing the result.
 *
 * Freshness tradeoff, stated plainly: reuse is bounded by the page session,
 * which beats the unexpiring localStorage entry used as the offline fallback,
 * but it IS less fresh than the second live fetch Payments used to perform.
 * A list that changes mid-shift will not be seen until reload. Reinstating a
 * refresh path means wiring a `sales_persons` flag into
 * `pos_master_data_invalidated`, which is a server-side change.
 *
 * A rejection is never retained: `cached` is assigned only on success and the
 * in-flight promise is released in `finally`, so the next caller re-requests.
 * That is what lets a load which failed while offline at boot succeed later
 * from the payment screen.
 */

import { call } from "@/utils/call";

const METHOD = "pospire.pospire.api.posapp.get_sales_person_names";
const STORAGE_KEY = "sales_persons_storage";

let inFlight = null;
let cached = null;

/**
 * Last list persisted by a previous session, or null. Callers hydrate from
 * this before awaiting so the dropdown is usable offline.
 */
export function readStoredSalesPersons() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		// Quota, privacy mode, or a corrupt entry — treat as absent.
		return null;
	}
}

function persistList(list) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		/* quota / privacy mode — non-fatal */
	}
}

/**
 * Persistence is a property of the CALLER, not of the request that happened to
 * go to the wire. The first loader to run is usually Invoice's, which mounts
 * before `register_pos_profile` lands and therefore does not yet know whether
 * `posa_local_storage` is on. If a later caller that does want persistence
 * were merely handed the shared result, the offline fallback entry would never
 * be refreshed and the next offline reload would hydrate from a stale list —
 * or none at all.
 */
function withPersist(promise, persist) {
	if (!persist) return promise;
	return promise.then((r) => {
		if (r) persistList(r);
		return r;
	});
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.persist] mirror the result to localStorage; driven
 *   by the profile's `posa_local_storage` flag, which is per-component state.
 *
 * There is deliberately no `force` option. Nothing can call it until
 * `pos_master_data_invalidated` carries a sales-person flag, and an unused
 * bypass only creates a publish race between the forced request and a slower
 * one already in flight. Add it back alongside the invalidation hook.
 */
export function loadSalesPersons({ persist = false } = {}) {
	if (cached) return withPersist(Promise.resolve(cached), persist);
	if (inFlight) return withPersist(inFlight, persist);

	const promise = call(METHOD)
		.then((r) => {
			if (r) cached = r;
			return cached;
		})
		.finally(() => {
			// Only if we still own the slot.
			if (inFlight === promise) inFlight = null;
		});

	inFlight = promise;
	return withPersist(promise, persist);
}

/** Test seam: drop the session cache and any in-flight request. */
export function resetSalesPersonsCache() {
	inFlight = null;
	cached = null;
}
