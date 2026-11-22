/**
 * Read-only backend access. Kept separate from the UI helpers so the
 * measurement/reconciliation code never drives, and so cannot change, the
 * application under test. Uses the admin API key (see auth.config.ts).
 *
 * Only GET calls to read endpoints: no ledger or document mutation, per the
 * ticket's "supported read-only reconciliation APIs/queries" rule.
 */

import { type APIRequestContext, type Playwright } from "@playwright/test";
import { API_KEY, API_SECRET, BASE_URL } from "../auth.config";

export async function newAdminContext(playwright: Playwright): Promise<APIRequestContext> {
	return playwright.request.newContext({
		baseURL: BASE_URL,
		// Explicitly empty: an inherited browser session cookie would make POSTs subject to
		// the CSRF check, which the API-key header otherwise bypasses.
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: {
			Authorization: `token ${API_KEY}:${API_SECRET}`,
			Accept: "application/json",
		},
	});
}

type Filters = Record<string, unknown>;

export async function getList<T = Record<string, unknown>>(
	api: APIRequestContext,
	doctype: string,
	filters: Filters,
	fields: string[],
	limit = 1000,
): Promise<T[]> {
	const res = await api.get("/api/method/frappe.client.get_list", {
		params: {
			doctype,
			filters: JSON.stringify(filters),
			fields: JSON.stringify(fields),
			limit_page_length: limit,
		},
	});
	if (!res.ok()) {
		throw new Error(`get_list ${doctype} failed: HTTP ${res.status()}`);
	}
	return (await res.json()).message as T[];
}

export async function getDoc<T = Record<string, any>>(
	api: APIRequestContext,
	doctype: string,
	name: string,
): Promise<T | null> {
	const res = await api.get("/api/method/frappe.client.get", { params: { doctype, name } });
	if (res.status() === 404) return null;
	if (!res.ok()) {
		throw new Error(`get ${doctype} ${name} failed: HTTP ${res.status()}`);
	}
	return (await res.json()).message as T;
}

export interface OpeningShiftRow {
	name: string;
	user: string;
	pos_profile: string;
	status: string;
	company: string;
}

export function listOpeningShifts(api: APIRequestContext, filters: Filters): Promise<OpeningShiftRow[]> {
	return getList<OpeningShiftRow>(
		api,
		"POS Opening Shift",
		{ docstatus: 1, ...filters },
		["name", "user", "pos_profile", "status", "company"],
		100,
	);
}

/** Current on-hand quantity of an item in a warehouse (0 if it has no Bin yet). */
export async function binQty(api: APIRequestContext, itemCode: string, warehouse: string): Promise<number> {
	const rows = await getList<{ actual_qty: number }>(
		api,
		"Bin",
		{ item_code: itemCode, warehouse },
		["actual_qty"],
		1,
	);
	return rows[0]?.actual_qty ?? 0;
}
