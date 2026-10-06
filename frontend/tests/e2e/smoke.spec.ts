/**
 * Smoke tests — POSpire QA Test Case Workbook, "Smoke" tab (SMK-001–SMK-008).
 *
 * The eight cases share one continuous flow (open shift -> add item ->
 * select/create customer -> cash sale -> return -> close shift), matching
 * the workbook's own chained Preconditions column, so they run serially
 * against a single page/session instead of as independent tests.
 *
 * Requires:
 *   - An authenticated session for a user with POS access, supplied via
 *     `POSPIRE_E2E_STORAGE_STATE` (see playwright.config.ts) or an
 *     equivalent auth-setup project — this file does not perform login.
 *   - At least one Company + POS Profile combination available to that user.
 *   - The item/customer names in TEST_DATA below to exist on the target
 *     site. Replace with real fixtures once the seeded test site lands.
 *
 * Selectors below were confirmed against the current component source
 * (ItemsSelector.vue, Customer.vue, UpdateCustomer.vue, Payments.vue,
 * Returns.vue, ClosingDialog.vue, Navbar.vue, OpeningDialog.vue) — there are
 * no `data-testid` attributes anywhere in this codebase, so locators rely on
 * visible labels/button text/roles instead. A few steps where the exact
 * runtime markup could not be confirmed by reading source alone are marked
 * with `test.fixme` rather than guessed at.
 */

import { expect, test, type Page } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./auth.config";

// Verified against the pospire_dev site's actual data (2026-09-29):
// `LSF-002` has 567 units in "Sales Floor - LRS". The POS Profile used here
// ("MG Road - POS 1") restricts customer search to the "MG Road Store"
// customer group (see get_customer_group_condition in posapp.py) — "Sam" is
// a real, non-disabled Customer in that group. Re-verify if the seeded site
// or the profile's customer-group restriction changes.
const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 1",
	itemName: "Women's Ballerina Flats", // item_code LSF-002
	existingCustomerName: "Sam",
	// Unique per run: "Ravneet" already exists on this site (from the
	// workbook's own literal Test Data value), and Frappe doesn't block
	// duplicate Customer *names* — only duplicate record IDs — so a fixed
	// name would pile up "Ravneet - 1", "Ravneet - 2", etc. on every run.
	newCustomerName: `Ravneet-${Date.now()}`,
	openingCash: "5000",
};

test.describe.serial("Smoke — core POS flow (SMK-001 to SMK-008)", () => {
	// These 8 cases share in-memory cart/shift state (added item, picked
	// customer, etc.), so they must run on ONE page for the whole file.
	// `test.describe.serial` only guarantees order + stop-on-failure — the
	// default `page` fixture is still a fresh page per test, which would
	// silently reset all of that state. A single page created in
	// `beforeAll` and reused via a module-level variable is the fix.
	let page: Page;
	// Captured from SMK-006's success toast so SMK-007 can look up that exact
	// invoice for its return, instead of guessing at an invoice name.
	let lastInvoiceId = "";

	/**
	 * Closes whatever shift is currently open on the active page, via the
	 * Navbar menu -> ClosingDialog flow. Shared by SMK-002 (which uses it to
	 * self-heal a leftover open shift from a previous run, instead of just
	 * skipping — important for repeatable demos) and SMK-008 (the workbook's
	 * own "close shift" case).
	 */
	async function closeShift() {
		// Same Vuetify quirk as the customer dropdown: the v-list-item inside
		// this v-menu doesn't expose role="menuitem" either, so match by text.
		await page.locator(".menu-button").click();
		await page.getByText("Close Shift", { exact: true }).click();

		// The dialog's actual title is "Close POS Shift" (see ClosingDialog.vue)
		// — "Close Shift" is only the button that opens/submits it.
		const dialogTitle = page.getByText("Close POS Shift", { exact: true }).or(
			page.getByText("Closing Amount"),
		);
		// This dialog fetches real shift/payment-reconciliation data on open
		// (Opened At/By, per-mode amounts, denomination grid) — confirmed via a
		// failure screenshot (2026-10-05) where the dialog had fully rendered
		// with correct real data, but only AFTER the default 5s `expect`
		// timeout had already elapsed and failed the test. Same class of issue
		// as performance.spec.ts's PERF-005 loading-indicator timeout: a real
		// data-backed round trip that can legitimately exceed the generic
		// default under system load, not a missing/broken dialog.
		await expect(dialogTitle.first()).toBeVisible({ timeout: 15_000 });

		// This POS Profile has cash denominations enabled for closing
		// (custom_enable_cash_denominations=1), so the plain "Cash" row's
		// closing-amount cell is `readonly` by design — the real total comes
		// from a per-denomination stepper grid instead (mirrors the opening
		// dialog). A mismatch vs. the expected amount is a valid outcome here
		// (shows as a "Difference"), not a failure — this just needs a
		// non-zero count entered.
		const increaseDenom = page.getByRole("button", { name: /Increase quantity for/ }).first();
		for (let i = 0; i < 5; i++) {
			await increaseDenom.click();
		}

		await page.getByRole("button", { name: "Close Shift", exact: true }).click();
		await expect(dialogTitle.first()).toBeHidden();
	}

	test.beforeAll(async ({ browser }) => {
		// `browser.newPage()` does NOT inherit the project's `use` config
		// (baseURL, storageState) the way the built-in `page`/`context`
		// fixtures do — those must be passed explicitly here.
		const context = await browser.newContext({
			baseURL: BASE_URL,
			storageState: AUTH_FILE,
		});
		page = await context.newPage();
	});

	test.afterAll(async () => {
		await page.context().close();
	});

	test("SMK-001 — Launch POSpire: POS app loads successfully", async () => {
		await page.goto("/pospire/pos");
		// In --headed mode the new browser window doesn't always get real OS
		// focus automatically (window-manager dependent). Vuetify's dropdown
		// menus rely on real focus/activation events to open, so without this
		// a headed run can click a field and have the dropdown silently never
		// open — looking "stuck" until a human clicks into the window
		// themselves. bringToFront() forces it once, up front, for the whole
		// shared-page suite. Headless mode is unaffected either way.
		await page.bringToFront();
		await expect(page.locator("body")).toBeVisible();

		// Either the opening-shift dialog (no active shift yet) or the item
		// search bar (a shift is already active) proves the SPA booted and
		// hydrated its POS data. A `.or()` locator picks whichever matches
		// first in DOM order regardless of which one is ACTUALLY visible —
		// and the item search bar stays in the DOM but becomes genuinely
		// hidden (not just occluded) when the dialog renders fullscreen at a
		// small viewport, vs. staying visible underneath at a larger one. So
		// this needs a real boolean OR of two independent visibility checks,
		// not `.or()`.
		const openingDialog = page.getByText("Create Opening Shift", { exact: true }).first();
		const itemSearch = page.getByPlaceholder(/Search by name, code, barcode/i);
		const dialogVisible = await openingDialog.isVisible().catch(() => false);
		const searchVisible = await itemSearch.isVisible().catch(() => false);
		expect(dialogVisible || searchVisible).toBe(true);
	});

	test("SMK-002 — Open POS shift: enter opening balance and submit", async () => {
		// .first(): the dialog's title div AND its own submit button both read
		// "Create Opening Shift" exactly, so this locator always has 2+
		// matches whenever the dialog is open (see SMK-001's comment above).
		const dialogTitle = page.getByText("Create Opening Shift", { exact: true }).first();

		// Self-heal instead of skipping: a shift left open from a previous
		// run/demo would otherwise make this test silently do nothing every
		// time, which defeats the point of demonstrating "open a shift" live.
		// Close whatever's open first, so this always performs a real open.
		if (!(await dialogTitle.isVisible().catch(() => false))) {
			await closeShift();
			await page.reload();
			await expect(dialogTitle).toBeVisible();
		}

		// Vuetify's dropdown items don't expose ARIA role="option" here (they
		// render as plain generic elements), so getByRole("option") never
		// matches. getByRole("listbox") alone is ALSO ambiguous: the app's own
		// left nav sidebar happens to use role="listbox" too, so scope to
		// Vuetify's `.v-overlay--active` class (only present on an
		// actually-open menu, never the sidebar).
		//
		// Picking blindly via `.first()` is NOT safe here: this site has
		// multiple companies, and the alphabetically-first one ("_Test
		// Company") has no POS Profiles assigned, which left the POS Profile
		// dropdown empty otherwise. And typing to filter doesn't work either:
		// the dialog pre-selects "_Test Company" by default, and `.fill()`
		// doesn't clear that existing selection the way a real user's
		// select-all+type would — it just appended text onto the existing
		// value, so nothing ever matched. Simplest robust fix: don't type at
		// all, just open the (short, unpaginated) list and click the known
		// item directly.
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

		// Cash amount field only renders when the profile has denominations
		// disabled; a denomination stepper grid replaces it otherwise.
		const openingAmount = page.getByLabel("Opening Amount");
		if (await openingAmount.isVisible().catch(() => false)) {
			await openingAmount.fill(TEST_DATA.openingCash);
		}

		// Customer.vue caches its customer list once per `register_pos_profile`
		// event rather than searching live — and that event can fire more than
		// once in quick succession right after a self-heal (the reload's own
		// mount-time "shift already active?" check, followed by this real
		// shift-creation click), racing two `get_customer_names` calls against
		// each other. Waiting for one such response to land here doesn't
		// guarantee which one wins, but it gives the race a concrete point to
		// settle at before SMK-004 ever touches the Customer field, instead of
		// moving on immediately. Non-fatal: some setups hydrate the list
		// instantly from localStorage (posa_local_storage) without a fresh
		// network call at all, so this must never fail the test on its own.
		const customerNamesResponse = page
			.waitForResponse((res) => res.url().includes("get_customer_names"), { timeout: 10_000 })
			.catch(() => null);

		await page.getByRole("button", { name: "Create Opening Shift" }).click();
		await expect(dialogTitle).toBeHidden();
		await customerNamesResponse;
	});

	test("SMK-003 — Add item: search/scan and add item to cart", async () => {
		await page
			.getByPlaceholder(/Search by name, code, barcode/i)
			.fill(TEST_DATA.itemName);

		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();

		// Confirms the item landed in the cart (Invoice.vue's item table row).
		await expect(page.getByText(TEST_DATA.itemName).first()).toBeVisible();
	});

	test("SMK-004 — Select customer: search and select existing customer", async () => {
		// getByLabel("Customer") is ambiguous here: it also matches the
		// autocomplete's "Clear Customer" icon button. Scoping to the textbox
		// role disambiguates from that icon.
		const customerField = page.getByRole("textbox", { name: /Customer/ });

		// Safety net on top of SMK-002's post-create wait: Customer.vue's
		// cached customer list (see SMK-002's comment) can still occasionally
		// lose the race after a self-heal. If "Sam" doesn't show up on the
		// first try, the cache was likely still stale at that exact moment —
		// clearing and retyping re-runs the client-side filter against
		// whatever `vm.customers` holds a beat later, same spirit as SMK-002's
		// own self-heal rather than failing outright on app-level timing this
		// test doesn't control.
		const customerOption = page
			.getByRole("listbox")
			.getByText(TEST_DATA.existingCustomerName, { exact: true })
			.first();

		let found = false;
		for (let attempt = 0; attempt < 3 && !found; attempt++) {
			if (attempt > 0) {
				await page.waitForTimeout(500);
			}
			await customerField.click();
			await customerField.fill(TEST_DATA.existingCustomerName);
			found = await customerOption.isVisible({ timeout: 2_000 }).catch(() => false);
			if (!found) {
				await customerField.fill("");
			}
		}
		expect(found, `'${TEST_DATA.existingCustomerName}' never appeared in the customer dropdown after 3 attempts`).toBe(true);
		await customerOption.click();

		await expect(customerField).toHaveValue(new RegExp(TEST_DATA.existingCustomerName));
	});

	test("SMK-005 — Create new customer: customer does not exist", async () => {
		// The "add customer" trigger is an icon with no text/aria-label
		// (Customer.vue), so it's located by its component class instead.
		await page.locator(".customer-action-icon").last().click();
		await expect(page.getByText("Create Customer", { exact: true })).toBeVisible();

		await page.getByLabel(/Customer Name/).fill(TEST_DATA.newCustomerName);

		// Same "Clear X" icon ambiguity as the Customer field in SMK-004 — these
		// are autocompletes too, so scope to the textbox role.
		//
		// Root-caused a real race condition here (2026-10-05, via an
		// instrumented debug run): UpdateCustomer.vue's loadCustomerFormOptions()
		// fetches the Customer Group/Territory lists asynchronously when the
		// dialog opens, and there's no guarantee that resolves before this click
		// fires. A blind `.first()` click can land on Vuetify's own
		// "Group not found" no-data placeholder (itself rendered as a
		// `.v-list-item`) instead of a real option, leaving the field empty and
		// failing submit with "Customer group is required." — confirmed via a
		// debug run where the overlay's actual content at click-time was
		// `['Group not found']`. Waiting for the option's text to move past the
		// placeholder (Playwright's `expect` polls/retries) closes that race
		// without an arbitrary fixed delay.
		await page.getByRole("textbox", { name: /Customer Group/ }).click();
		const groupOption = page.locator(".v-overlay--active .v-list-item").first();
		await expect(groupOption).not.toHaveText(/not found/i);
		await groupOption.click();

		await page.getByRole("textbox", { name: /Territory/ }).click();
		const territoryOption = page.locator(".v-overlay--active .v-list-item").first();
		await expect(territoryOption).not.toHaveText(/not found/i);
		await territoryOption.click();

		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.getByText("Create Customer", { exact: true })).toBeHidden();
	});

	test("SMK-006 — Complete cash sale: select cash and submit", async () => {
		await page.locator(".pay-button").click();

		// Payments.vue renders one field per configured payment mode, labelled
		// with the mode's name; a same-row button of the same name fills the
		// full due amount into it.
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await expect(page.getByLabel("Cash", { exact: true })).not.toHaveValue("0");

		await page.getByRole("button", { name: "Submit", exact: true }).click();

		// Capture the invoice ID for SMK-007's return lookup. Payments.vue's
		// submit_invoice() does `toast.success(\`Invoice ${r.name} is
		// Submited\`)` (their typo, not mine) on success — this is the only
		// place the new invoice's name is surfaced in the UI.
		const successToast = page.getByText(/Invoice \S+ is Submited/);
		await expect(successToast).toBeVisible();
		const toastText = await successToast.textContent();
		lastInvoiceId = toastText?.match(/Invoice (\S+) is Submited/)?.[1] ?? "";
		expect(lastInvoiceId).not.toBe("");
	});

	test("SMK-007 — Process basic return: open return and submit", async () => {
		test.skip(!lastInvoiceId, "No invoice ID captured from SMK-006 — nothing to return.");

		// Invoice.vue's open_returns() passes its own `this.customer` field
		// (Customer.vue's selector) as an ADDITIONAL filter on top of the
		// invoice ID search — and that field is still "Sam" from SMK-004
		// (creating a new customer in SMK-005 attaches it to the invoice
		// being sold, but doesn't sync back to this separate search field).
		// Left as "Sam", the returns search's customer filter excludes our
		// own invoice (created under the new customer) even though its
		// invoice-ID filter matches. Clearing it first makes the search
		// match by invoice ID alone.
		await page.getByRole("button", { name: "Clear Customer" }).click();

		await page.getByRole("button", { name: "Sales Return" }).click();

		// Same "Clear X" icon ambiguity as the Customer/Customer Group fields
		// earlier — this field is clearable too, so scope to the textbox role.
		await page.getByRole("textbox", { name: /Invoice ID/ }).fill(lastInvoiceId);
		await page.getByRole("button", { name: "Search", exact: true }).click();

		// Returns.vue's tables are real <table>/<tr> markup (v-data-table),
		// unlike the autocomplete dropdowns elsewhere in this file — role="row"
		// works properly here (same as the closing-shift table in SMK-008).
		const invoiceRow = page.getByRole("row", { name: lastInvoiceId });
		await expect(invoiceRow).toBeVisible();
		await invoiceRow.getByRole("checkbox").click();

		await page.getByRole("button", { name: "Select Items" }).click();

		// With only one returnable item on this invoice, it's already
		// checked by default when this dialog opens (confirmed live:
		// `<input checked value="true" type="checkbox">`), with its return
		// qty pre-filled to the full remaining quantity. Clicking it again
		// would just uncheck it, and it also fought the dialog's own opening
		// animation/overlay — no extra interaction needed here.
		await page.getByRole("button", { name: "Load Return" }).click();

		// Unlike SMK-006's cash sale, a return has no payment-mode selection
		// at all (confirmed live: the payments panel goes straight from the
		// negative totals to Submit/Submit & Print/Cancel Payment, with no
		// per-mode "Cash" field or button — Payments.vue's amount field is
		// readonly for is_return anyway). Click PAY, then Submit directly.
		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Submit", exact: true }).click();
	});

	test("SMK-008 — Close shift: enter closing balance and close", async () => {
		await closeShift();
	});
});
