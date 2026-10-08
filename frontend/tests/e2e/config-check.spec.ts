/**
 * Configuration Check — POSpire internal QA process, "Configuration Check"
 * tab (CFG-010–CFG-015).
 *
 * Runs BEFORE every other suite (smoke/functional/negative/api/integration/
 * security/performance) to catch POS Profile misconfiguration with a clear,
 * specific failure message here, instead of a confusing failure three steps
 * into an unrelated test later (e.g. "Rate cannot be zero" during a checkout
 * test, when the real cause is a missing Item Price three layers upstream).
 *
 * Every check below is a pure read against the live Frappe site via
 * `frappe.client.get` (the standard whitelisted method for fetching a full
 * doc — same pattern api.spec.ts already uses) through the Administrator API
 * key. No browser, no page, no POS shift opened — these are independent
 * reads, so this file intentionally does NOT use test.describe.serial.
 *
 * POS_PROFILE_NAMES below is every POS Profile name referenced by any other
 * spec file's TEST_DATA block (confirmed via grep, 2026-10-05): "MG Road -
 * POS 1" (smoke.spec.ts only) and "MG Road - POS 2" (all the rest). Add any
 * new profile name here the moment another spec file starts using one.
 *
 * Field names and response shape confirmed LIVE against pospire_dev before
 * writing any assertion (not assumed from the doctype schema alone):
 *   - Mode of Payment's "enabled" flag is a Check field named literally
 *     `enabled` (erpnext/accounts/doctype/mode_of_payment/mode_of_payment.json).
 *   - Price List's "enabled" flag is the same: a Check field named `enabled`
 *     (erpnext/stock/doctype/price_list/price_list.json).
 *   - A live `frappe.client.get` for "MG Road - POS 1" confirmed the real
 *     response shape used below (disabled, company, currency, warehouse,
 *     write_off_account, write_off_cost_center, selling_price_list,
 *     item_groups[], custom_assortment, payments[].mode_of_payment) and
 *     surfaced one correction to a prior assumption: "MG Road - POS 1" ALSO
 *     has `custom_assortment = "ASSORTMENT-001"` set (same as POS 2), not
 *     unrestricted — smoke.spec.ts's own header comment only documents the
 *     *customer*-group restriction on that profile, not the item-catalog
 *     one, which is a separate, independent gate (see performance.spec.ts's
 *     header for how that restriction was originally discovered).
 *
 * CFG-015 was added after a live `smoke.spec.ts --headed` run failed at
 * SMK-005 ("Create new customer") with the Create Customer dialog staying
 * open past submit. Root-caused via UpdateCustomer.vue: its submit_dialog()
 * shows a client-side `toast.error("Customer group is required.")` and
 * returns early whenever `this.group` is empty — and that field is
 * populated from `pospire.pospire.api.offline.get_customer_form_options()`,
 * which returns ALL leaf (`is_group=0`) Customer Group/Territory records
 * site-wide (confirmed by reading offline.py — NOT filtered by POS Profile).
 * Live-checked against pospire_dev (2026-10-05): 8 leaf Customer Groups and
 * 14 leaf Territories currently exist, so that specific failure was headed-
 * mode dropdown-render timing, not a real config gap — but if this endpoint
 * ever DID return an empty list, every "create new customer" test would
 * deterministically fail with that exact toast, which is precisely the kind
 * of precondition this file exists to catch early with a clear message.
 */

import { expect, test, type APIRequestContext } from "@playwright/test";
import { API_KEY, API_SECRET, BASE_URL } from "./auth.config";

const POS_PROFILE_NAMES = ["MG Road - POS 1", "MG Road - POS 2"];

type PosProfileDoc = {
	name: string;
	disabled: 0 | 1;
	company?: string;
	currency?: string;
	warehouse?: string;
	write_off_account?: string;
	write_off_cost_center?: string;
	selling_price_list?: string;
	item_groups?: unknown[];
	custom_assortment?: string | null;
	payments?: { mode_of_payment: string }[];
};

type EnabledDoc = { name: string; enabled: 0 | 1 };

type GetDocResult<T> = { found: true; doc: T } | { found: false };

test.describe("Configuration Check — POS Profile core fields (CFG-010 to CFG-014)", () => {
	let authed: APIRequestContext;

	test.beforeAll(async ({ playwright }) => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		authed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});
	});

	test.afterAll(async () => {
		await authed?.dispose();
	});

	/**
	 * Fetches a full doc via frappe.client.get. Returns { found: false } on a
	 * 404 (DoesNotExistError) instead of throwing, so callers can turn a
	 * missing record into a specific, named assertion failure rather than an
	 * unhandled exception that would obscure which check actually failed.
	 */
	async function tryGetDoc<T>(doctype: string, name: string): Promise<GetDocResult<T>> {
		const res = await authed.post("/api/method/frappe.client.get", {
			data: { doctype, name },
		});
		if (res.status() === 404) return { found: false };
		expect(res.status(), `Unexpected status fetching ${doctype} '${name}'`).toBe(200);
		const doc = ((await res.json()) as { message: T }).message;
		return { found: true, doc };
	}

	for (const profileName of POS_PROFILE_NAMES) {
		test(`CFG-010 — POS Profile '${profileName}' exists and is enabled`, async () => {
			const result = await tryGetDoc<PosProfileDoc>("POS Profile", profileName);
			expect(result.found, `POS Profile '${profileName}' not found or disabled`).toBe(true);
			if (!result.found) return;
			expect(result.doc.disabled, `POS Profile '${profileName}' not found or disabled`).toBe(0);
		});

		test(`CFG-011 — POS Profile '${profileName}' has all required core fields`, async () => {
			const result = await tryGetDoc<PosProfileDoc>("POS Profile", profileName);
			test.skip(!result.found, `POS Profile '${profileName}' not found — see CFG-010`);
			if (!result.found) return;

			// One expect.soft() per field, not a single combined assertion: if
			// two fields are missing at once, both should surface in this one
			// run instead of fixing one and re-running to discover the next.
			const requiredFields: (keyof PosProfileDoc)[] = [
				"company",
				"currency",
				"warehouse",
				"write_off_account",
				"write_off_cost_center",
			];
			for (const field of requiredFields) {
				expect
					.soft(result.doc[field], `POS Profile '${profileName}' missing required field: ${field}`)
					.toBeTruthy();
			}
		});

		test(`CFG-012 — POS Profile '${profileName}' has a valid payment method configured`, async () => {
			const result = await tryGetDoc<PosProfileDoc>("POS Profile", profileName);
			test.skip(!result.found, `POS Profile '${profileName}' not found — see CFG-010`);
			if (!result.found) return;

			const payments = result.doc.payments ?? [];
			expect(
				payments.length > 0,
				`POS Profile '${profileName}' has no valid payment method configured`,
			).toBe(true);

			// Presence in the child table isn't enough — a renamed/disabled
			// Mode of Payment would still look "configured" here while being
			// dead at runtime. At least one row must resolve to a real,
			// enabled record.
			let hasValidMode = false;
			for (const row of payments) {
				const modeResult = await tryGetDoc<EnabledDoc>("Mode of Payment", row.mode_of_payment);
				if (modeResult.found && modeResult.doc.enabled === 1) {
					hasValidMode = true;
					break;
				}
			}
			expect(hasValidMode, `POS Profile '${profileName}' has no valid payment method configured`).toBe(
				true,
			);
		});

		test(`CFG-013 — POS Profile '${profileName}' has a valid selling price list`, async () => {
			const result = await tryGetDoc<PosProfileDoc>("POS Profile", profileName);
			test.skip(!result.found, `POS Profile '${profileName}' not found — see CFG-010`);
			if (!result.found) return;

			const priceListName = result.doc.selling_price_list;
			expect(priceListName, `POS Profile '${profileName}' has no valid selling price list`).toBeTruthy();
			if (!priceListName) return;

			const priceListResult = await tryGetDoc<EnabledDoc>("Price List", priceListName);
			const isValid = priceListResult.found && priceListResult.doc.enabled === 1;
			expect(isValid, `POS Profile '${profileName}' has no valid selling price list`).toBe(true);
		});

		test(`CFG-014 — POS Profile '${profileName}' does not have both Assortment and Item Group set`, async () => {
			const result = await tryGetDoc<PosProfileDoc>("POS Profile", profileName);
			test.skip(!result.found, `POS Profile '${profileName}' not found — see CFG-010`);
			if (!result.found) return;

			const hasAssortment = Boolean(result.doc.custom_assortment);
			const hasItemGroups = (result.doc.item_groups ?? []).length > 0;
			expect(
				hasAssortment && hasItemGroups,
				`POS Profile '${profileName}' has both Assortment and Item Group set — mutually exclusive`,
			).toBe(false);
		});
	}
});

test.describe("Configuration Check — Create Customer dialog data (CFG-015)", () => {
	let authed: APIRequestContext;

	test.beforeAll(async ({ playwright }) => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		authed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});
	});

	test.afterAll(async () => {
		await authed?.dispose();
	});

	test("CFG-015 — Create Customer dialog has at least one Customer Group and Territory to offer", async () => {
		const res = await authed.post("/api/method/pospire.pospire.api.offline.get_customer_form_options");
		expect(res.status(), "get_customer_form_options() call failed").toBe(200);

		const payload = ((await res.json()) as {
			message: { customer_groups?: string[]; territories?: string[] };
		}).message;

		expect(
			(payload.customer_groups ?? []).length > 0,
			"Create Customer dialog has no selectable Customer Group — every 'create new customer' flow will fail with \"Customer group is required.\"",
		).toBe(true);
		expect(
			(payload.territories ?? []).length > 0,
			"Create Customer dialog has no selectable Territory — every 'create new customer' flow will fail with \"Customer territory is required.\"",
		).toBe(true);
	});
});
