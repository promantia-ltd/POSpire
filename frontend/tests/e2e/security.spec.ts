/**
 * Security tests — POSpire QA Test Case Workbook, "Security" tab
 * (SEC-001–006).
 *
 * Root-caused against the actual backend/frontend source before writing any
 * assertion (posapp.py, ERPNext's taxes_and_totals.py/selling_controller.py,
 * frappe's auth/session pipeline, Invoice.vue, UpdateCustomer.vue, call.ts)
 * — see the comment on each test for the exact finding it's pinned to.
 * Three cases assert the CORRECT/expected behavior even though that makes
 * them currently FAIL against the live app — these are genuine gaps, not
 * test-authoring mistakes:
 *   - SEC-001: pospire.py's get_context() (the SPA's page-level gate) checks
 *     the caller's role, but NONE of posapp.py's @frappe.whitelist() methods
 *     re-check it — frappe.is_whitelisted() only checks "not Guest", so any
 *     authenticated user with zero Sales/POS/Accounts/System Manager role
 *     can call the POS API directly even though they'd be bounced from the
 *     page itself.
 *   - SEC-002: Invoice.vue's discount-limit check (posa_max_discount_allowed)
 *     is purely client-side (validate(), ~line 2699). Server-side,
 *     taxes_and_totals.py's calculate_item_rate() trusts a posted
 *     discount_percentage outright (computing discount_amount from it, then
 *     accepting item.rate = rate_with_margin - discount_amount) — no
 *     endpoint anywhere re-checks it against the POS Profile's configured
 *     max.
 *   - SEC-005b: calculate_item_rate() reverse-derives discount/margin to
 *     match whatever `rate` is posted alongside a given price_list_rate,
 *     rather than re-deriving rate from the Item Price — so a tampered low
 *     rate is accepted as-is (just relabeled as a bigger "discount").
 *     selling_controller.py's validate_selling_price() is the only backstop
 *     against this, and it's gated by Selling Settings.validate_selling_price,
 *     confirmed DISABLED (0) on pospire_dev.
 *
 * SEC-001 and SEC-006 need dedicated fixtures beyond the shared
 * Administrator API key/session other spec files use:
 *   - SEC-001 calls the API as security-test-restricted@pospire.test, a
 *     throwaway user created by ../../setup_security_test_user.py with
 *     ZERO roles (see POSPIRE_E2E_RESTRICTED_API_KEY/SECRET in .env.test).
 *   - SEC-006 needs to invalidate a real, live session mid-test without
 *     touching the shared auth.json session every other spec file reuses —
 *     it logs in fresh (its own sid, independent of AUTH_FILE), then shells
 *     out to `bench --site pospire_dev execute frappe.sessions.delete_session`
 *     to kill that exact session server-side, confirmed (frappe/sessions.py
 *     ~line 82-100) to just delete the Sessions row + evict the cache entry,
 *     no permission gate. Session resolution happens in frappe's request
 *     pipeline strictly before any whitelisted method body runs (app.py ->
 *     auth.py's validate_auth() -> sessions.py), so a killed sid falls back
 *     to Guest before submit_invoice ever executes — this is the real
 *     mechanism, not a simulated route-fault.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	API_KEY,
	API_SECRET,
	AUTH_FILE,
	BASE_URL,
	RESTRICTED_API_KEY,
	RESTRICTED_API_SECRET,
} from "./auth.config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e -> frontend -> pospire -> apps -> frappe-bench (bench commands
// must run with the bench root as cwd to find sites/ config).
const BENCH_ROOT = path.resolve(__dirname, "../../../../../");

const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 2",
	// Same item/customer functional.spec.ts/negative.spec.ts use — "Sam" is a
	// pre-existing (not offline-created) customer, which matters for SEC-006:
	// call.ts's runWrite() routes offline-created-customer invoices straight
	// into the offline outbox via forceQueue, BEFORE ever checking
	// connectivity/hitting the network — that would make the live 403 this
	// test depends on unreachable. "Sam" keeps forceQueue/hasOfflineCustomer
	// false so the real network round-trip (and the killed session) is what
	// actually gets exercised.
	existingCustomerName: "Sam",
	itemCode: "LSF-002",
	itemName: "Women's Ballerina Flats",
	itemRate: 1499,
	openingCash: "5000",
};

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}

function validInvoicePayload(overrides: Record<string, unknown> = {}) {
	return {
		doctype: "Sales Invoice",
		is_pos: 1,
		ignore_pricing_rule: 1,
		company: TEST_DATA.companyName,
		pos_profile: TEST_DATA.posProfileName,
		customer: TEST_DATA.existingCustomerName,
		currency: "INR",
		posting_date: todayIso(),
		items: [
			{
				item_code: TEST_DATA.itemCode,
				qty: 1,
				rate: TEST_DATA.itemRate,
				price_list_rate: TEST_DATA.itemRate,
				discount_percentage: 0,
				uom: "Nos",
				conversion_factor: 1,
			},
		],
		payments: [{ mode_of_payment: "Cash", amount: TEST_DATA.itemRate }],
		...overrides,
	};
}

test.describe("Security — API-level access control and input handling (SEC-001, 002, 004, 005)", () => {
	let adminAuthed: APIRequestContext;
	let restrictedAuthed: APIRequestContext;

	test.beforeAll(async ({ playwright }) => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		adminAuthed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});

		test.skip(
			!RESTRICTED_API_KEY || !RESTRICTED_API_SECRET,
			"POSPIRE_E2E_RESTRICTED_API_KEY/SECRET not set — run setup_security_test_user.py first",
		);
		restrictedAuthed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${RESTRICTED_API_KEY}:${RESTRICTED_API_SECRET}`,
				Accept: "application/json",
			},
		});
	});

	test.afterAll(async () => {
		await adminAuthed?.dispose();
		await restrictedAuthed?.dispose();
	});

	test("SEC-001 [KNOWN DEFECT] — a user with zero POS/Sales/Accounts role can still call the POS API directly", async () => {
		// pospire/www/pospire.py's get_context() throws frappe.PermissionError
		// for any session user without one of {"Sales User", "Sales Manager",
		// "System Manager", "Accounts Manager", "Accounts User"} — the SPA page
		// itself is correctly gated. get_items (posapp.py) has no such check;
		// frappe.is_whitelisted() only rejects Guest callers. The restricted
		// fixture user (zero roles) can reach this endpoint the page would
		// never let them load.
		const profileRes = await adminAuthed.post("/api/method/frappe.client.get", {
			data: { doctype: "POS Profile", name: TEST_DATA.posProfileName },
		});
		expect(profileRes.status()).toBe(200);
		const posProfile = (await profileRes.json()).message;

		const res = await restrictedAuthed.post(
			"/api/method/pospire.pospire.api.posapp.get_items",
			{ data: { pos_profile: posProfile, search_value: TEST_DATA.itemCode } },
		);

		// Correct expected behavior: the API should enforce the same role gate
		// the page does. Currently returns 200 with real item data — FAILS,
		// flagging the gap.
		expect(res.status()).toBe(403);
	});

	test("SEC-002 [KNOWN DEFECT] — an item discount above the POS Profile's configured max is rejected server-side", async () => {
		// "MG Road - POS 2" has posa_max_discount_allowed=50 (confirmed via
		// direct DB query). Invoice.vue's own validate() would block a 90%
		// discount client-side — this test bypasses the client entirely and
		// posts it straight to the API. No endpoint re-checks it: taxes_and_
		// totals.py's calculate_item_rate() (line ~191-193) computes
		// discount_amount = rate_with_margin * discount_percentage / 100 and
		// accepts the resulting rate whenever item.rate isn't sent at a
		// conflicting value — it never looks at posa_max_discount_allowed at
		// all, that field is read nowhere outside Invoice.vue.
		// Invoice.vue always sends a `rate` already recomputed to match
		// whatever discount_percentage it's displaying (on_discount_percentage_
		// change() does this client-side before the row is ever posted) — a
		// real tampered request looks like a self-consistent (rate,
		// discount_percentage) pair, not a bare discount_percentage with no
		// rate. Omitting rate entirely instead trips posapp.py's OWN "Rate
		// cannot be zero" guard (line ~960) before the discount logic is ever
		// reached, which would test the wrong thing.
		const discountPercentage = 90;
		const tamperedRate = TEST_DATA.itemRate * (1 - discountPercentage / 100);
		const payload = validInvoicePayload({
			items: [
				{
					item_code: TEST_DATA.itemCode,
					qty: 1,
					price_list_rate: TEST_DATA.itemRate,
					rate: tamperedRate,
					discount_percentage: discountPercentage,
					uom: "Nos",
					conversion_factor: 1,
				},
			],
		});

		const res = await adminAuthed.post(
			"/api/method/pospire.pospire.api.posapp.update_invoice",
			{ data: { data: JSON.stringify(payload) } },
		);

		// Correct expected behavior: a discount exceeding the profile's max
		// should be rejected (417). Currently returns 200 with the 90%
		// discount silently applied — FAILS, flagging the gap.
		expect(res.status()).toBe(417);
		const body = await res.json();
		expect(JSON.stringify(body)).toMatch(/discount/i);
	});

	test("SEC-004 — A SQL-injection-style search_value causes no error and no unfiltered dump", async () => {
		// get_items' search conditions, when they run at all, are built via
		// frappe.db.escape() (posapp.py ~line 295-310,
		// get_seearch_items_conditions ~line 2519), not string concatenation —
		// confirmed safe by reading the actual query-building code.
		//
		// That query-building path is gated behind the POS Profile's
		// pose_use_limit_search flag, confirmed OFF on both seeded profiles —
		// with it off, search_value is never used in a query at all; get_items
		// just returns the full item-group-scoped catalog regardless of what's
		// searched. Tried enabling it on "MG Road - POS 2" to exercise the
		// real escaped-query path, but that surfaced an UNRELATED pre-existing
		// bug: search_serial_or_batch_or_barcode_number() (posapp.py ~line
		// 2493) declares `search_serial_no: str`, but the caller passes
		// pos_profile.get("posa_search_serial_no") — a Check field (confirmed
		// via DB, Python int 0/1) — and frappe's type-validation wrapper
		// throws FrappeTypeError on the mismatch before any query builds. That
		// makes the "limit search" feature a dead code path for EVERY search
		// (benign or hostile) on any profile that enables it, not a security
		// issue specifically — flagged here as a known defect, left unpatched
		// (out of scope for the Security tab), and the flag left OFF.
		//
		// With search_value genuinely inert on this profile, the only
		// meaningful assertion left is that a hostile string causes no error
		// and doesn't somehow widen the result beyond the normal, bounded,
		// item-group-scoped catalog a benign call would also return.
		const profileRes = await adminAuthed.post("/api/method/frappe.client.get", {
			data: { doctype: "POS Profile", name: TEST_DATA.posProfileName },
		});
		const posProfile = (await profileRes.json()).message;

		const baselineRes = await adminAuthed.post(
			"/api/method/pospire.pospire.api.posapp.get_items",
			{ data: { pos_profile: posProfile, search_value: "" } },
		);
		expect(baselineRes.status()).toBe(200);
		const baselineItems = (await baselineRes.json()).message;

		const res = await adminAuthed.post("/api/method/pospire.pospire.api.posapp.get_items", {
			data: { pos_profile: posProfile, search_value: "' OR '1'='1" },
		});

		expect(res.status()).toBe(200);
		const items = (await res.json()).message;
		expect(Array.isArray(items)).toBe(true);
		expect(items.length).toBe(baselineItems.length);
	});

	test("SEC-005a — A tampered grand_total is recalculated server-side, not trusted", async () => {
		// accounts_controller.py's _calculate() always recomputes grand_total
		// from the actual items/taxes (confirmed by reading taxes_and_totals.py
		// lines 80-91) regardless of what the client posts — this is a real,
		// already-working protection.
		const payload = validInvoicePayload({ grand_total: 1, rounded_total: 1, base_grand_total: 1 });

		const res = await adminAuthed.post(
			"/api/method/pospire.pospire.api.posapp.update_invoice",
			{ data: { data: JSON.stringify(payload) } },
		);

		expect(res.status()).toBe(200);
		const invoiceDoc = (await res.json()).message;
		expect(invoiceDoc.grand_total).toBeCloseTo(TEST_DATA.itemRate, 2);
	});

	test("SEC-005b [KNOWN DEFECT] — a tampered item rate below its catalog price is not re-validated", async () => {
		// Real catalog price_list_rate is TEST_DATA.itemRate (1499); posting a
		// drastically lower `rate` alongside it (no discount_percentage field
		// at all) exercises calculate_item_rate()'s "item rate does not match
		// calculated rate" branch (taxes_and_totals.py ~line 207-224): since
		// the tampered rate isn't greater than price_list_rate, it just
		// reverse-derives a cosmetic discount_amount to match it and leaves
		// item.rate untouched — the tampered value flows straight through to
		// item.amount. Selling Settings.validate_selling_price (the only
		// backstop) is confirmed disabled on pospire_dev.
		const tamperedRate = 1;
		const payload = validInvoicePayload({
			items: [
				{
					item_code: TEST_DATA.itemCode,
					qty: 1,
					price_list_rate: TEST_DATA.itemRate,
					rate: tamperedRate,
					uom: "Nos",
					conversion_factor: 1,
				},
			],
		});

		const res = await adminAuthed.post(
			"/api/method/pospire.pospire.api.posapp.update_invoice",
			{ data: { data: JSON.stringify(payload) } },
		);

		// Correct expected behavior: the server should reject or correct a
		// rate this far below the catalog price. Currently returns 200 with
		// item.rate left at the tampered value (1) — FAILS, flagging the gap.
		expect(res.status()).toBe(417);
	});
});

test.describe.serial("Security — browser-level XSS and session handling (SEC-003, SEC-006)", () => {
	let page: Page;

	async function closeShift() {
		await page.locator(".menu-button").click();
		await page.getByText("Close Shift", { exact: true }).click();

		const dialogTitle = page
			.getByText("Close POS Shift", { exact: true })
			.or(page.getByText("Closing Amount"));
		await expect(dialogTitle.first()).toBeVisible();

		const increaseDenom = page.getByRole("button", { name: /Increase quantity for/ }).first();
		for (let i = 0; i < 5; i++) {
			await increaseDenom.click();
		}

		await page.getByRole("button", { name: "Close Shift", exact: true }).click();
		await expect(dialogTitle.first()).toBeHidden();
	}

	// Same race-safe signal/self-heal reasoning as functional.spec.ts's
	// ensureShiftOpen() — see that file's header comment for the full
	// rationale (`.menu-button` is unreliable; the item search field is
	// gated behind Pos.vue's `v-show="!dialog"`).
	async function ensureShiftOpen() {
		const dialogTitle = page.getByText("Create Opening Shift", { exact: true }).first();
		const searchField = page.getByPlaceholder(/Search by name, code, barcode/i).first();
		const shiftAlreadyOpen = await Promise.race([
			dialogTitle.waitFor({ state: "visible", timeout: 15000 }).then(() => false),
			searchField.waitFor({ state: "visible", timeout: 15000 }).then(() => true),
		]).catch(() => {
			throw new Error("Neither the Opening Shift dialog nor the POS main screen appeared within 15s");
		});

		if (shiftAlreadyOpen) {
			await closeShift();
			await page.reload();
			await expect(dialogTitle).toBeVisible();
		}

		await page.getByLabel("Store").click();
		await page
			.locator(".v-overlay--active .v-list-item", { hasText: TEST_DATA.companyName })
			.first()
			.click();

		await page.getByLabel("POS Profile").click();
		await page
			.locator(".v-overlay--active .v-list-item", { hasText: TEST_DATA.posProfileName })
			.first()
			.click();

		const openingAmount = page.getByLabel("Opening Amount");
		if (await openingAmount.isVisible().catch(() => false)) {
			await openingAmount.fill(TEST_DATA.openingCash);
		}

		await page.getByRole("button", { name: "Create Opening Shift" }).click();
		await expect(dialogTitle).toBeHidden();
	}

	test.beforeAll(async ({ browser }, testInfo) => {
		testInfo.setTimeout(60_000);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_FILE });
		page = await context.newPage();

		const shiftCheckSettled = page
			.waitForResponse((res) => res.url().includes("posapp.check_opening_shift"), {
				timeout: 15000,
			})
			.catch(() => null);
		await page.goto("/pospire/pos");
		await page.bringToFront();
		await shiftCheckSettled;
		await ensureShiftOpen();
	});

	test.afterAll(async () => {
		await closeShift();
		await page.context().close();
	});

	test("SEC-003 — A customer name containing a script tag is rejected, never stored or rendered", async ({
		playwright,
	}) => {
		// Originally expected Vue's interpolation (UpdateCustomer.vue/
		// Customer.vue render customer_name purely via `{{ }}`/item-title
		// binding — confirmed no v-html/innerHTML anywhere in this flow) to be
		// the thing standing between this payload and execution. Live testing
		// found a stronger, earlier guard instead: ERPNext's Selling Settings
		// on this site names Customer docs directly from customer_name (not a
		// generic naming series — confirmed live, create_customer() never
		// sets doc.name itself), and frappe.model.naming.validate_name()
		// unconditionally rejects '<'/'>' in any document name. The payload
		// is refused at the naming layer before a row is ever inserted —
		// never stored, so there's nothing to later render unsafely either.
		let dialogFired = false;
		page.on("dialog", (dialog) => {
			dialogFired = true;
			void dialog.dismiss();
		});

		const xssPayload = "<script>alert(1)</script>";

		const adminApi = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});

		await page.locator(".mdi-account-plus").first().click();
		await expect(page.getByText("Create Customer", { exact: true })).toBeVisible();

		// Customer Group/Territory are clearable v-autocompletes — their
		// Vuetify "Clear" icon buttons carry an aria-label containing the same
		// field name ("Clear Customer Group *"), so a plain getByLabel matches
		// both the textbox and the icon (strict-mode violation). Scoping to
		// role "textbox" excludes the icon button.
		await page.getByLabel("Customer Name").fill(xssPayload);
		await page.getByRole("textbox", { name: /Customer Group/ }).click();
		await page
			.locator(".v-overlay--active .v-list-item", { hasText: "Individual" })
			.first()
			.click();
		// Territory has far more entries than Customer Group — "Delhi" isn't
		// in Vuetify's initially-rendered (virtualized) window, so type to
		// filter down to it instead of relying on it already being visible.
		// NOT "India": get_customer_form_options() deliberately filters
		// Territory to is_group=0 (leaf nodes only, confirmed via DB — "India"
		// is a parent group node with "Delhi"/"Gujarat" etc. as its leaf
		// children), so a country-level name never appears in this dropdown
		// at all — by design, not a bug.
		await page.getByRole("textbox", { name: /Territory/ }).fill("Delhi");
		await page
			.locator(".v-overlay--active .v-list-item", { hasText: "Delhi" })
			.first()
			.click();

		try {
			await page.getByRole("button", { name: "Submit", exact: true }).click();

			await expect(page.getByText("Customer Created Successfully.")).toBeHidden();
			await expect(page.getByText(/special characters|cannot contain/i)).toBeVisible();
			expect(dialogFired).toBe(false);

			const countRes = await adminApi.post("/api/method/frappe.client.get_count", {
				data: { doctype: "Customer", filters: JSON.stringify({ customer_name: xssPayload }) },
			});
			expect((await countRes.json()).message).toBe(0);
		} finally {
			await page.getByRole("button", { name: "Close", exact: true }).click();
			await adminApi.dispose();
		}
	});

	test("SEC-006 — Submitting after the server-side session is invalidated mid-flow is rejected cleanly", async ({
		browser,
		playwright,
	}) => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		const username = process.env.POSPIRE_E2E_USERNAME;
		const password = process.env.POSPIRE_E2E_PASSWORD;
		test.skip(!username || !password, "POSPIRE_E2E_USERNAME/PASSWORD not set in .env.test");

		const adminApi = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});

		// A fresh, independent login — deliberately NOT the shared AUTH_FILE
		// session every other spec file reuses. Killing that one would log
		// every other spec out mid-suite; this session is scoped to this test
		// alone and is already dead by the time the test ends either way.
		const freshContext = await browser.newContext({ baseURL: BASE_URL });
		const freshPage = await freshContext.newPage();

		try {
			await freshPage.goto("/login");
			await freshPage.locator("#login_email").fill(username!);
			await freshPage.locator("#login_password").fill(password!);
			await freshPage.getByRole("button", { name: "Continue" }).click();
			await freshPage.waitForURL((url) => !url.pathname.startsWith("/login"));

			// The shift opened in this describe block's beforeAll is keyed on
			// (user, pos_profile), not on any one session — this fresh session,
			// same Administrator user, sees it as already open and skips
			// straight to the main screen.
			const shiftCheckSettled = freshPage
				.waitForResponse((res) => res.url().includes("posapp.check_opening_shift"), {
					timeout: 15000,
				})
				.catch(() => null);
			await freshPage.goto("/pospire/pos");
			await freshPage.bringToFront();
			await shiftCheckSettled;
			await expect(
				freshPage.getByPlaceholder(/Search by name, code, barcode/i).first(),
			).toBeVisible({ timeout: 15000 });

			await freshPage.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
			await freshPage.getByText(TEST_DATA.itemName, { exact: false }).first().click();
			await expect(
				freshPage.locator(".invoice-cart-section").getByRole("row", { name: TEST_DATA.itemName }),
			).toBeVisible();

			await freshPage.locator(".pay-button").click();
			await freshPage.getByRole("button", { name: "Cash", exact: true }).click();
			await expect(freshPage.getByLabel("Cash", { exact: true })).not.toHaveValue("0");

			const sid = (await freshContext.cookies()).find((c) => c.name === "sid")?.value;
			if (!sid) throw new Error("Could not read this fresh session's sid cookie");

			const countBefore = await adminApi.post("/api/method/frappe.client.get_count", {
				data: {
					doctype: "Sales Invoice",
					filters: JSON.stringify({ customer: TEST_DATA.existingCustomerName, docstatus: 1 }),
				},
			});
			const invoiceCountBefore = (await countBefore.json()).message;

			// frappe.sessions.delete_session() (frappe/sessions.py ~line 82-100):
			// deletes the Sessions row for this exact sid and evicts the Redis
			// cache entry — no permission gate, safe under `bench execute`.
			// Session resolution happens in frappe's request pipeline strictly
			// before any whitelisted method body runs, so the very next
			// request on this sid resolves to Guest.
			execFileSync(
				"bench",
				[
					"--site",
					"pospire_dev",
					"execute",
					"frappe.sessions.delete_session",
					"--kwargs",
					JSON.stringify({ sid }),
				],
				{ cwd: BENCH_ROOT, stdio: "pipe" },
			);

			const submitButton = freshPage.getByRole("button", { name: "Submit", exact: true });
			await submitButton.click();

			// Payments.vue's submit_invoice() catch branch (~line 1023-1029)
			// fires toast.error(err.message || "Error submitting invoice") —
			// confirmed via call.ts that a real 403 HTTP response is classified
			// as "http_4xx" and thrown immediately ("Never enqueue"), never
			// silently queued into the offline outbox.
			//
			// buildLiveFetchError() (call.ts) only reads the response's
			// `_error_message` field for the toast text — confirmed live that
			// frappe.is_whitelisted()'s PermissionError response doesn't carry
			// that field at all (it uses `_server_messages` instead, a
			// different shape msgprint()'s own raise_exception path produces),
			// so the actual toast is just `[method, exc_type].join(" ")`:
			// "pospire.pospire.api.posapp.submit_invoice PermissionError" —
			// not a human-friendly sentence.
			const successToast = freshPage.getByText(/Invoice \S+ is Submited/);
			const errorToast = freshPage.getByText(/PermissionError/i);
			await expect(errorToast.first()).toBeVisible();
			await expect(successToast).toBeHidden();

			// Ground truth, same reasoning as negative.spec.ts's NEG-003: trust
			// the actual server record count over the UI alone. No new invoice
			// should exist for a submit that was rejected at the session layer.
			const countAfter = await adminApi.post("/api/method/frappe.client.get_count", {
				data: {
					doctype: "Sales Invoice",
					filters: JSON.stringify({ customer: TEST_DATA.existingCustomerName, docstatus: 1 }),
				},
			});
			expect((await countAfter.json()).message).toBe(invoiceCountBefore);
		} finally {
			await freshContext.close();
			await adminApi.dispose();
		}
	});
});
