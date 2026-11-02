/**
 * Global setup: make sure the stocked PERF item has plenty on hand before any test runs.
 *
 * The scenarios sell it one unit at a time, run after run. Once a warehouse reaches zero,
 * every sale hits the profile's automatic Stock Reconciliation, which the cashier roles may not
 * perform, and the sale is refused with a raw 403. That would make every later test measure an
 * empty shelf instead of the thing it is about. This tops the item up with an ordinary
 * Material Receipt (never lowers stock, never edits the ledger); tests that need an exact
 * quantity (the last-unit scenario) still set their own.
 */

import { request } from "@playwright/test";
import { API_KEY, API_SECRET, BASE_URL } from "./auth.config";
import { COMPANY, ITEMS, WAREHOUSES } from "./fixtures/topology";
import { ensureStock } from "./helpers/admin-fixtures";

const MIN_ON_HAND = 1000;

export default async function globalSetup() {
	if (!API_KEY || !API_SECRET) return;
	const api = await request.newContext({
		baseURL: BASE_URL,
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: { Authorization: `token ${API_KEY}:${API_SECRET}`, Accept: "application/json" },
	});
	try {
		for (const warehouse of [WAREHOUSES.A, WAREHOUSES.B]) {
			const r = await ensureStock(api, { company: COMPANY, item: ITEMS.stock, warehouse, qty: MIN_ON_HAND, rate: 600 });
			if (r.added > 0) console.log(`[stock] ${ITEMS.stock} in ${warehouse}: was ${r.before}, received ${r.added}`);
		}
	} catch (e) {
		console.warn(`[stock] could not top up ${ITEMS.stock}: ${String(e).split("\n")[0]}`);
	} finally {
		await api.dispose();
	}
}
