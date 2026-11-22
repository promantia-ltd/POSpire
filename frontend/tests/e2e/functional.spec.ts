/**
 * Functional tests — POSpire QA Test Case Workbook, "Functional" tab
 * (FUN-001–FUN-012). All 12 workbook cases are implemented below.
 *
 * FUN-006, 007, 010, 011, 012 required extra site data/config that didn't
 * exist on pospire_dev by default (see setup_fun_blocked_cases.py and
 * setup_fun007_coupon_fix.py in the pospire app root, run once against the
 * site on 2026-09-29) — scoped only to "MG Road - POS 2" (this file's own
 * POS Profile) wherever possible:
 *   - FUN-006 (discount): allow_discount_change/posa_allow_user_to_edit_
 *     item_discount enabled, posa_max_discount_allowed=50
 *   - FUN-007 (coupon): a "POS Coupon" (code FUNTEST10) linked to a
 *     coupon-based "POS Offer" (10% off, Grand Total) — NOT the standard
 *     ERPNext "Coupon Code"/"Pricing Rule" doctypes, which this app's own
 *     coupon flow (posapp.py's check_coupon_code()) never reads at all
 *   - FUN-010 (batch item): item ITM-BT2 given 50 real units (a real Batch
 *     + submitted Stock Entry) in "Sales Floor - LRS"
 *   - FUN-011 (serial item): item ITM-SB1 given 5 real Serial Nos
 *     (FUNTEST-ITM-SB1-001..005) in the same warehouse
 *   - FUN-012 (delivery charge): posa_use_delivery_charges enabled, plus a
 *     "Delivery Charges" record ("Functional Test Delivery Charge", ₹100
 *     flat rate) for the company
 * Re-verify if the site's seeded data or profile config changes.
 *
 * All 12 cases share one continuous flow/page (search+scan items -> adjust
 * qty -> remove item -> create customer -> save+resume draft -> discount ->
 * coupon -> batch/serial items -> delivery charge -> split payment), run
 * serially on a single shared page. Deliberately uses a DIFFERENT POS
 * Profile ("MG Road - POS 2") than smoke.spec.ts ("MG Road - POS 1") even
 * though both map to the same Company/warehouse — Playwright's
 * `fullyParallel: true` config can run this file and smoke.spec.ts
 * concurrently in separate workers, and POS Opening/Closing Shift state is
 * shared per (user, profile) on the live backend, so two suites fighting
 * over the same profile's shift would be flaky. Confirmed via bench that
 * "MG Road - POS 2" has identical payment-mode config (Cash, Credit Card
 * w/ default=1) to POS 1.
 *
 * Selectors confirmed by reading ItemsSelector.vue, Invoice.vue,
 * Payments.vue, Drafts.vue and CouponsModal.vue source directly. Notably,
 * several of Invoice.vue's cart-row icon buttons (expand toggle, qty +/-,
 * delete) have NO aria-label even though the delete button shows a
 * "Delete Item" tooltip (Vuetify's v-tooltip only sets aria-describedby,
 * not aria-label) — so those are row-scoped icon-class locators, not
 * getByRole(..., { name }). Several outlined text fields (Payments.vue's
 * Cash/Credit Card, the Coupon Code input, Delivery Charges, Batch/Serial
 * No) render a doubled accessible name (e.g. "Cash Cash") from Vuetify's
 * outlined-field markup — getByLabel is used instead of
 * getByRole("textbox", { name }) everywhere this applies.
 */

import { expect, test, type Page } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./auth.config";

const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 2",
	// FUN-001: plain-name search. Same item smoke.spec.ts uses (item_code
	// LSF-002) — the search bar needs >=3 chars to filter at all
	// (ItemsSelector.vue's `filtered_items` short-circuits below that).
	searchItemName: "Women's Ballerina Flats",
	// FUN-002: a distinct item with a real barcode configured (item_code
	// LSH-010), so its cart row is unambiguous from the item above.
	barcodeItemName: "Kitchen Apron & Mitt Set",
	barcode: "8901234500507",
	newCustomerName: `Functional-${Date.now()}`,
	openingCash: "5000",
	// FUN-010: pure batch-controlled item (has_batch_no=1, has_serial_no=0),
	// given 50 real units in "Sales Floor - LRS" via setup_fun_blocked_cases.py.
	batchItemName: "FruitA", // item_code ITM-BT2
	// FUN-011: pure serialized item (has_serial_no=1, has_batch_no=0), given
	// 5 real serials in the same warehouse by the same setup script.
	serialItemName: "Item-Serial-Batch", // item_code ITM-SB1
	// FUN-007: a POS Coupon (not a standard ERPNext Coupon Code — see file
	// header) seeded by setup_fun007_coupon_fix.py.
	couponCode: "FUNTEST10",
	// FUN-012: the Delivery Charges record's own `label` field, seeded by
	// setup_fun_blocked_cases.py.
	deliveryChargeLabel: "Functional Test Delivery Charge",
};

// Both the item-search results table (ItemsSelector.vue) and the cart table
// (Invoice.vue) are real v-data-tables, so an unscoped getByRole("row", {
// name: itemName }) matches BOTH once an item's in the cart while its name
// still matches the search box's filter (confirmed live: a strict-mode
// violation with 2 matching <tr>s). Scope every cart-row lookup through the
// cart's own wrapping class to disambiguate.
function cartRow(page: Page, itemName: string) {
	return page.locator(".invoice-cart-section").getByRole("row", { name: itemName });
}

test.describe.serial("Functional — core POS interactions (FUN-001 to FUN-012)", () => {
	let page: Page;

	// Same helper as smoke.spec.ts's closeShift(), duplicated rather than
	// imported: keeps this file runnable independently of smoke.spec.ts, and
	// the two suites intentionally don't share a module since they also
	// intentionally don't share a POS Profile (see file header).
	async function closeShift() {
		await page.locator(".menu-button").click();
		await page.getByText("Close Shift", { exact: true }).click();

		const dialogTitle = page.getByText("Close POS Shift", { exact: true }).or(
			page.getByText("Closing Amount"),
		);
		await expect(dialogTitle.first()).toBeVisible();

		const increaseDenom = page.getByRole("button", { name: /Increase quantity for/ }).first();
		for (let i = 0; i < 5; i++) {
			await increaseDenom.click();
		}

		await page.getByRole("button", { name: "Close Shift", exact: true }).click();
		await expect(dialogTitle.first()).toBeHidden();
	}

	// Opens a shift on TEST_DATA.posProfileName, self-healing (closing)
	// whatever's currently open first if needed — same self-heal reasoning
	// as smoke.spec.ts's SMK-002 (a leftover open shift from an interrupted
	// run shouldn't make every subsequent run silently no-op).
	async function ensureShiftOpen() {
		const dialogTitle = page.getByText("Create Opening Shift", { exact: true }).first();

		// A plain "wait N seconds, then assume timeout = shift already open"
		// check is itself a race: if the dialog is just slow to render (cold
		// page load) rather than never appearing, this misreads it as an
		// already-open shift and calls closeShift(), which then hangs waiting
		// for a "Close POS Shift" dialog that will never come, eating the
		// full hook timeout. Racing against a real "shift is open" signal
		// instead of a timeout removes the guess entirely.
		//
		// That signal is NOT `.menu-button`: it lives in Navbar.vue with no
		// v-if guarding it, so it's already in the DOM and "visible" (per
		// Playwright's CSS-only definition) the instant the page loads —
		// including while the Opening dialog's own scrim is covering it.
		// Racing on it is close to 50/50 against the dialog's own appearance
		// and, when it wins, leaves closeShift() trying to click a button
		// that's genuinely there but pointer-blocked by the dialog's scrim,
		// hanging in an endless click-retry loop instead of failing fast.
		// The item search field, by contrast, sits inside Pos.vue's
		// `v-row v-show="!dialog"` block — it is only really visible once
		// the Opening dialog is gone, making it the correct signal.
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
		// The default 30s hook timeout is too tight once ensureShiftOpen()'s
		// own 15s race (see its comment) lands on the self-heal branch —
		// closeShift() plus the follow-up reload/wait can push the total
		// past 30s even in the legitimate, non-deadlocked case.
		testInfo.setTimeout(60_000);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_FILE });
		page = await context.newPage();

		// Pos.vue's mounted() hook applies a cached localStorage snapshot
		// synchronously on load (an optimistic "shift already open" flash —
		// see applyOpeningSnapshot()/readCachedOpeningSnapshot() in Pos.vue),
		// then awaits a live check_opening_shift round-trip that can
		// override it and switch to the Create Opening Shift dialog instead.
		// ensureShiftOpen()'s race below reads whichever of those is showing
		// the instant it starts polling — if that's still the pre-
		// reconciliation flash, it misreads the state and self-heals against
		// a dialog that hasn't rendered yet. Waiting for that round-trip to
		// land before racing removes the ambiguity.
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
		// Leave no shift open behind for the next run/demo, same as
		// smoke.spec.ts's SMK-008.
		await closeShift();
		await page.context().close();
	});

	test("FUN-001 — Search by item name", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.searchItemName);
		await page.getByText(TEST_DATA.searchItemName, { exact: false }).first().click();

		// Confirms the item landed in the cart (Invoice.vue's item table row).
		await expect(cartRow(page, TEST_DATA.searchItemName)).toBeVisible();
	});

	test("FUN-002 — Scan valid barcode", async () => {
		// ItemsSelector.vue auto-adds on an exact barcode match via a watcher
		// on the debounced search value, but pressing Enter flushes that
		// debounce immediately instead of waiting ~200ms for it — more
		// deterministic for a test than waiting on the debounce timer.
		const searchField = page.getByPlaceholder(/Search by name, code, barcode/i);
		await searchField.fill(TEST_DATA.barcode);
		await searchField.press("Enter");

		await expect(cartRow(page, TEST_DATA.barcodeItemName)).toBeVisible();
	});

	test("FUN-003 — Increase quantity of a cart item", async () => {
		// The always-visible qty `v-text-field` in the cart row has an empty
		// `:label`, so it has no accessible name — scope by row instead.
		// Needs a real blur (not just fill's input event) to fire Invoice.vue's
		// @change handler that actually applies the new qty.
		const qtyField = cartRow(page, TEST_DATA.searchItemName).getByRole("textbox").first();

		await qtyField.fill("3");
		await qtyField.blur();

		// The field re-renders through Invoice.vue's formatFloat() after blur,
		// which always shows 2 decimal places, not the raw typed value.
		await expect(qtyField).toHaveValue("3.00");
	});

	test("FUN-004 — Remove item from cart", async () => {
		// The delete icon button has no aria-label (its tooltip only sets
		// aria-describedby, confirmed against Vuetify's v-tooltip source), so
		// it's located by its row + icon class instead of an accessible name.
		await cartRow(page, TEST_DATA.barcodeItemName).locator("button:has(.mdi-delete)").click();

		await expect(cartRow(page, TEST_DATA.barcodeItemName)).toHaveCount(0);
	});

	test("FUN-005 — Create customer", async () => {
		// Same flow as smoke.spec.ts's SMK-005 — see that file for the
		// "Clear X" icon ambiguity reasoning behind the textbox-role scoping.
		await page.locator(".customer-action-icon").last().click();
		await expect(page.getByText("Create Customer", { exact: true })).toBeVisible();

		await page.getByLabel(/Customer Name/).fill(TEST_DATA.newCustomerName);

		await page.getByRole("textbox", { name: /Customer Group/ }).click();
		await page.locator(".v-overlay--active .v-list-item").first().click();

		await page.getByRole("textbox", { name: /Territory/ }).click();
		await page.locator(".v-overlay--active .v-list-item").first().click();

		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.getByText("Create Customer", { exact: true })).toBeHidden();
	});

	test("FUN-009 — Save and resume a draft invoice", async () => {
		// Nothing in the UI literally says "draft" — the save button reads
		// "Save and Clear" (Invoice.vue), and it clears the cart on success.
		await page.getByRole("button", { name: "Save and Clear", exact: true }).click();
		await expect(cartRow(page, TEST_DATA.searchItemName)).toHaveCount(0);

		// The resume button reads "Load Draft sales" (lowercase "sales" is the
		// actual copy, not a typo introduced here) and opens Drafts.vue, whose
		// dialog title is "Load Sales Invoice" — a third, different string.
		await page.getByRole("button", { name: "Load Draft sales", exact: true }).click();
		await expect(page.getByText("Load Sales Invoice", { exact: true })).toBeVisible();

		// Drafts.vue's list is a real v-data-table (role="row" works, unlike
		// the autocomplete dropdowns elsewhere in this file).
		const draftRow = page.getByRole("row", { name: TEST_DATA.newCustomerName });
		await expect(draftRow).toBeVisible();
		await draftRow.getByRole("checkbox").click();

		await page.getByRole("button", { name: "Load Sale", exact: true }).click();

		// Confirms the draft's cart contents were restored.
		await expect(cartRow(page, TEST_DATA.searchItemName)).toBeVisible();
		await expect(page.getByText("Load Sales Invoice", { exact: true })).toBeHidden();
	});

	test("FUN-006 — Apply item discount", async () => {
		// Rate/Amount cells render comma-grouped ("1,499.00"), which Number()
		// parses as NaN unless stripped first.
		const parseCurrency = (value: string) => Number(value.replace(/,/g, ""));

		const row = cartRow(page, TEST_DATA.searchItemName);
		// Cart columns are Name/QTY/UOM/Rate/Amount/Offer?/Actions
		// (items_headers order), so Rate is the row's 2nd textbox.
		const rateField = row.getByRole("textbox").nth(1);
		const originalRate = parseCurrency(await rateField.inputValue());

		// Discount % / Amount fields live in the expanded-row content — a
		// SEPARATE <tr> with no item-name text in it, so they aren't
		// reachable via cartRow(...); scope through the section wrapper
		// instead. Same no-aria-label expand toggle as this file's other
		// cart-row icon buttons (confirmed against Vuetify's
		// VDataTableRow.mjs source: the default expand button has no
		// accessible name at all).
		await row.locator("button:has(.mdi-chevron-down)").click();

		const discountPercentage = page
			.locator(".invoice-cart-section")
			.getByLabel("Discount Percentage");
		await discountPercentage.click();
		await discountPercentage.fill("10");
		await discountPercentage.blur();

		// Live-data fact, not a code guarantee: this profile's approval
		// workflow is ON (posa_enable_approval_workflow=1), but has no
		// "Edit Item Discount" POS Approval Action configured, so
		// approvalGuard() resolves immediately with no dialog. If that
		// action gets configured later, an ApprovalDialog would pop up here
		// and this test would need a dialog-handling step added.
		await expect
			.poll(async () => parseCurrency(await rateField.inputValue()))
			.toBeLessThan(originalRate);
	});

	test("FUN-007 — Apply valid coupon", async () => {
		// No "Coupons" affordance exists on Invoice.vue itself — the button
		// lives in ItemsSelector.vue instead.
		await page.getByRole("button", { name: /Coupons/ }).click();
		await expect(page.getByText("Manage Coupons", { exact: true })).toBeVisible();

		const couponField = page.getByLabel("Enter Coupon Code");
		await couponField.click();
		await couponField.fill(TEST_DATA.couponCode);
		await page.getByRole("button", { name: "Apply Coupon" }).click();

		// add_coupon() shows no success toast (only toast.error on failure)
		// — the only confirmation is the coupon appearing, Applied, in its
		// own results table (scoped by its own wrapper class to disambiguate
		// from the cart/search tables elsewhere in this file). Applying is
		// a reactive chain (posa_coupons watcher -> handelOffers() ->
		// checkOfferCoupon() -> flips the row's `applied` flag), so this
		// polls rather than asserting instantly.
		const couponRow = page
			.locator(".enhanced-coupons-table")
			.getByRole("row", { name: TEST_DATA.couponCode });
		await expect(couponRow).toBeVisible();
		await expect(couponRow.getByText("Applied", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Apply & Close" }).click();
		await expect(page.getByText("Manage Coupons", { exact: true })).toBeHidden();
	});

	test("FUN-010 — Sell batch-controlled item", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.batchItemName);
		await page.getByText(TEST_DATA.batchItemName, { exact: false }).first().click();

		const row = cartRow(page, TEST_DATA.batchItemName);
		await expect(row).toBeVisible();

		// Unlike serialized items (FUN-011), a batch item's row does NOT
		// auto-expand under this profile's posa_auto_set_batch=1 config —
		// confirmed by reading Invoice.vue's makeInvoiceItem(): the
		// auto-expand condition for batch items is gated on
		// `!posa_auto_set_batch`, but has_serial_no has no such gate. The
		// toggle must be clicked manually here to reveal the Batch No field.
		await row.locator("button:has(.mdi-chevron-down)").click();

		// exact:true: "Batch No" is a substring of the adjacent readonly
		// "Batch No. Available QTY" and "Batch No Expiry Date" fields in the
		// same expanded row, so an unscoped getByLabel matches all three.
		const batchField = page
			.locator(".invoice-cart-section")
			.getByLabel("Batch No", { exact: true });
		await batchField.click();
		// Multiple batches exist for this item now (stale zero-qty leftovers
		// alongside the one setup_fun_blocked_cases.py keeps topped up), and
		// a blind `.first()` picked an exhausted one (confirmed via DB: a
		// zero-qty batch sorts first) — leaving "Batch No" empty since
		// selecting a batch with no stock is rejected. Each option's
		// subtitle renders "Available Qty: N - Expiry Date: ..." (see
		// Invoice.vue's v-list-item template), so pick one that actually has
		// stock instead of assuming position or a single entry.
		await page
			.locator(".v-overlay--active .v-list-item")
			.filter({ hasNotText: "Available Qty: 0" })
			.first()
			.click();

		await expect(batchField).not.toHaveValue("");
	});

	test("FUN-011 — Sell serialized item", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.serialItemName);
		await page.getByText(TEST_DATA.serialItemName, { exact: false }).first().click();

		const row = cartRow(page, TEST_DATA.serialItemName);
		await expect(row).toBeVisible();

		// Unlike batch items (FUN-010), a serialized item's row DOES
		// auto-expand unconditionally the moment it lands in the cart — its
		// has_serial_no OR-clause in makeInvoiceItem() has no profile-flag
		// gate — so no manual expand click is needed here.
		// exact:true: same substring-ambiguity reasoning as FUN-010's Batch No
		// field — "Serial No" is a substring of the adjacent readonly
		// "Serial No QTY" field in the same expanded row.
		const serialField = page
			.locator(".invoice-cart-section")
			.getByLabel("Serial No", { exact: true });
		await serialField.click();

		// Don't pin a specific serial: each successful FUN-008 run downstream
		// delivers (consumes) whichever serial gets picked here, so a
		// hardcoded serial only survives one full suite run before the
		// dropdown simply won't offer it any more. Pick whichever is first
		// available instead, and assert against that captured value.
		const firstSerialOption = page.locator(".v-overlay--active .v-list-item").first();
		const pickedSerialNo = (await firstSerialOption.textContent())?.trim();
		expect(pickedSerialNo).toBeTruthy();
		await firstSerialOption.click();
		await page.keyboard.press("Escape");

		// This is a multi-select v-combobox that renders picks as chips, not
		// as the input's own value — assert the chip text instead of
		// toHaveValue(). Submit-time validation for serialized items is
		// strict (unlike batch, which is lenient under
		// posa_auto_stock_reconcile=1): the number of selected serials must
		// exactly equal the item's cart qty (default 1 here), or payment
		// submission hard-fails with a toast.
		await expect(
			page.locator(".invoice-cart-section").getByText(pickedSerialNo!),
		).toBeVisible();
	});

	test("FUN-012 — Apply delivery charge", async () => {
		// "Delivery Charges" is a prefix of the adjacent readonly "Delivery
		// Charges Rate" field's label — exact:true avoids getByLabel
		// matching both.
		const deliveryField = page.getByLabel("Delivery Charges", { exact: true });
		await deliveryField.click();
		await page
			.locator(".v-overlay--active .v-list-item", { hasText: TEST_DATA.deliveryChargeLabel })
			.first()
			.click();

		// update_delivery_charges() sets delivery_charges_rate synchronously
		// from the selected option's own `rate` — reflected immediately in
		// this adjacent readonly field. The record was seeded with a flat
		// ₹100 rate (setup_fun_blocked_cases.py).
		await expect(page.getByLabel("Delivery Charges Rate", { exact: true })).toHaveValue("100.00");
	});

	test("FUN-008 — Split payment across two configured modes", async () => {
		await page.locator(".pay-button").click();

		// Payments.vue's outlined v-text-field renders its label twice in the
		// DOM (the floating label plus a duplicate for the notch spacing),
		// which Vuetify/Chromium compute into a DOUBLED accessible name
		// ("Cash Cash", "Credit Card Credit Card") — confirmed live via an
		// ARIA snapshot dump. getByRole("textbox", { name }) never matches
		// against the plain mode name because of that; getByLabel matches
		// the actual <label> element's text instead and isn't affected
		// (same reasoning as smoke.spec.ts's SMK-006 cash field).
		const creditCardField = page.getByLabel("Credit Card", { exact: true });
		const cashField = page.getByLabel("Cash", { exact: true });

		// This POS Profile flags Credit Card as its `default: 1` payment mode,
		// so Payments.vue pre-fills IT (not Cash) with the full grand total on
		// open — confirmed via bench against MG Road - POS 2's POS Payment
		// Method rows.
		const total = Number(await creditCardField.inputValue());
		expect(total).toBeGreaterThan(0);
		const half = Math.floor(total / 2);

		// Order matters: each mode's per-row "fill full amount" button zeroes
		// every OTHER mode's amount, so those buttons can't be used for a
		// split at all — must `.fill()` both fields directly instead. And an
		// untouched (amount===0) field's @focus handler auto-refills itself
		// from the still-full Credit Card field, so reducing Credit Card
		// FIRST (before touching Cash) avoids fighting that side effect.
		//
		// Confirmed live: even with that ordering, a bare .fill() on Cash
		// raced with its own @focus handler and produced a DOUBLED value
		// ("22482248" instead of "2248") — Vue's reactive auto-fill and
		// Playwright's select-all-then-type landed in the wrong order.
		// Splitting into a separate .click() (let the focus side effect
		// settle first) then .fill() (a clean, separate action afterward)
		// removes that race.
		await creditCardField.fill(String(total - half));
		await cashField.click();
		await cashField.fill(String(half));

		await expect(creditCardField).toHaveValue(String(total - half));
		await expect(cashField).toHaveValue(String(half));

		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(page.getByText(/Invoice \S+ is Submited/)).toBeVisible();
	});
});
