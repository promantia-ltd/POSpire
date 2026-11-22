/**
 * Negative/Exception tests — POSpire QA Test Case Workbook, "Negative/
 * Exception" tab (NEG-001–NEG-007).
 *
 * Like functional.spec.ts and smoke.spec.ts, these share one continuous
 * flow/page (open shift -> empty-cart submit -> double-click submit ->
 * network failure -> stock error -> over-return -> payment timeout), run
 * serially. Deliberately reuses "MG Road - POS 2" (functional.spec.ts's
 * profile, not smoke.spec.ts's "MG Road - POS 1") since this file's own
 * NEG-001 case needs to drive the Opening Shift dialog itself rather than
 * just open a shift and move on — running it against a third profile
 * wasn't worth a new POS Profile fixture, and both existing profiles share
 * the same "MG Road Store" customer-group restriction (confirmed via
 * `POS Customer Group` for both, 2026-09-30), so "Sam" (used by
 * smoke.spec.ts) works here too.
 *
 * Root-caused against the actual source (not guessed) before writing any
 * assertion — see the comment on each test for the exact file/line it's
 * pinned to. Three of the seven cases have no way to occur from pure UI
 * interaction against a single live session, so they're simulated via
 * `page.route()` intercepting the one whitelisted method call involved
 * (`pospire.pospire.api.posapp.submit_invoice`) rather than skipped:
 *   - NEG-004 (network failure): `route.abort("failed")` reproduces a bare
 *     `fetch()` rejection, which `call.ts`'s `classifyFetchError()`
 *     classifies as `"network_error"`.
 *   - NEG-005 (stock changed before submit): reproducing the actual race
 *     would need a second live session consuming the last unit between
 *     this test building its cart and clicking Submit. Instead,
 *     `route.fulfill()` returns the exact Frappe-shaped error body the
 *     backend raises for this case (`NegativeStockError` re-thrown as
 *     `frappe.throw(..., title="Insufficient Stock")`, posapp.py's
 *     `submit_invoice()` ~line 1167) — this verifies the frontend's
 *     handling of that error, not the backend's own stock check.
 *   - NEG-007 (payment timeout): confirmed via call.ts/Payments.vue that no
 *     client-enforced timeout exists anywhere in the submit_invoice call
 *     path (no `AbortSignal` is ever passed) — a hanging request has no
 *     ceiling today. `route.abort("timedout")` simulates the only kind of
 *     "timeout" that currently exists (the network/browser layer giving
 *     up), which is a bare `fetch()` rejection indistinguishable from
 *     NEG-004's by the time it reaches `classifyFetchError()` — both are
 *     absorbed into the same offline-outbox path, not a distinct one.
 *
 * NEG-002, NEG-003, and NEG-006's primary assertion (the client-side
 * over-return clamp) all reproduce real, already-implemented validation
 * against the live backend with no mocking needed.
 */

import { expect, test, type Page } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./auth.config";

const SUBMIT_INVOICE_URL = "**/api/method/pospire.pospire.api.posapp.submit_invoice";

const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 2",
	// Same item smoke.spec.ts/functional.spec.ts use for plain search (item_code
	// LSF-002) — 539+ units in "Sales Floor - LRS" as of 2026-09-30, comfortably
	// enough for the one real sale NEG-003 makes.
	itemName: "Women's Ballerina Flats",
	existingCustomerName: "Sam",
	openingCash: "5000",
};

function cartRow(page: Page, itemName: string) {
	return page.locator(".invoice-cart-section").getByRole("row", { name: itemName });
}

test.describe.serial("Negative/Exception — POS failure handling (NEG-001 to NEG-007)", () => {
	let page: Page;
	// Captured from NEG-003's success toast so NEG-006 can return against that
	// exact invoice, same pattern as smoke.spec.ts's lastInvoiceId.
	let lastInvoiceId = "";

	// Same helper as functional.spec.ts/smoke.spec.ts's closeShift(), duplicated
	// rather than imported for the same reason functional.spec.ts gives: this
	// file intentionally uses its own POS Profile shift state independent of
	// the other two suites.
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

	test.beforeAll(async ({ browser }, testInfo) => {
		// See functional.spec.ts's own beforeAll comment: the default 30s hook
		// timeout is too tight once NEG-001's self-heal race (below) lands on
		// the close-and-reopen branch.
		testInfo.setTimeout(60_000);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_FILE });
		page = await context.newPage();

		// See functional.spec.ts's beforeAll comment: Pos.vue can flash an
		// optimistic cached-snapshot state before its live check_opening_shift
		// round-trip corrects it — wait for that round-trip before NEG-001's
		// race below reads the dialog/main-screen state.
		const shiftCheckSettled = page
			.waitForResponse((res) => res.url().includes("posapp.check_opening_shift"), {
				timeout: 15000,
			})
			.catch(() => null);
		await page.goto("/pospire/pos");
		await page.bringToFront();
		await shiftCheckSettled;
	});

	test.afterAll(async () => {
		await closeShift();
		await page.context().close();
	});

	test("NEG-001 — Negative opening balance is rejected client-side", async () => {
		const dialogTitle = page.getByText("Create Opening Shift", { exact: true }).first();
		// NOT `.menu-button`: it lives in Navbar.vue with no v-if guarding it,
		// so it's "visible" (Playwright's CSS-only definition) from the
		// instant the page loads, even while the Opening dialog's own scrim
		// covers it — racing on it is close to 50/50 against the dialog
		// itself and, when it wins, leaves closeShift() stuck click-retrying
		// a button that's genuinely there but pointer-blocked by that scrim.
		// The item search field sits inside Pos.vue's `v-row v-show="!dialog"`
		// block instead, so it's only really visible once the dialog is gone.
		const searchField = page.getByPlaceholder(/Search by name, code, barcode/i).first();

		// Same race-safe check as functional.spec.ts's ensureShiftOpen(): don't
		// guess "no dialog after N seconds means a shift is already open" —
		// race the dialog against the actual "shift is open" signal instead.
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

		// OpeningDialog.vue's submit_dialog() (~line 916) rejects a negative
		// amount purely client-side via isAmountValid() (utils/validation.js)
		// and returns before ever calling create_opening_voucher() in
		// posapp.py — which does no amount validation of its own at all. So
		// this is a pure client-validation assertion, no backend involved.
		const openingAmount = page.getByLabel("Opening Amount");
		if (await openingAmount.isVisible().catch(() => false)) {
			await openingAmount.fill("-500");
			await page.getByRole("button", { name: "Create Opening Shift" }).click();

			await expect(page.getByText("Please enter valid non-negative amounts.")).toBeVisible();
			// Dialog must still be open — submit_dialog() returned early.
			await expect(dialogTitle).toBeVisible();

			// Recover with a valid amount so the rest of the suite has a real
			// open shift to work with.
			await openingAmount.fill(TEST_DATA.openingCash);
		}

		await page.getByRole("button", { name: "Create Opening Shift" }).click();
		await expect(dialogTitle).toBeHidden();
	});

	test("NEG-002 — Submit with an empty cart is blocked", async () => {
		// Invoice.vue's show_payment() checks `!this.customer` (~line 2556)
		// BEFORE `!this.items.length` (~line 2560) — a customer has to be
		// selected first, or the empty-cart case never gets exercised at all.
		const customerField = page.getByRole("textbox", { name: /Customer/ });
		await customerField.click();
		await customerField.fill(TEST_DATA.existingCustomerName);
		await page
			.getByRole("listbox")
			.getByText(TEST_DATA.existingCustomerName, { exact: true })
			.first()
			.click();
		await expect(customerField).toHaveValue(new RegExp(TEST_DATA.existingCustomerName));

		await page.locator(".pay-button").click();
		await expect(page.getByText("Select items to sell")).toBeVisible();

		// The Payments panel must never have opened.
		await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeHidden();
	});

	test("NEG-003 — Double-click submit creates only one invoice", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await expect(page.getByLabel("Cash", { exact: true })).not.toHaveValue("0");

		// Payments.vue's submit() (~line 818) guards re-entrancy two ways: a
		// `:disabled="vaildatPayment || submittingPayment"` binding on the
		// button, AND a synchronous `if (this.submittingPayment) return;`
		// check that fires before either validation or the network call. The
		// request count is the ground truth for whether that guard actually
		// held, rather than trusting the UI alone.
		let submitRequestCount = 0;
		const countSubmitRequests = (req: import("@playwright/test").Request) => {
			if (req.url().includes("posapp.submit_invoice")) submitRequestCount++;
		};
		page.on("request", countSubmitRequests);

		// NOT Promise.all([submitButton.click(), submitButton.click()]): each
		// .click() does its own actionability wait, and if the first click's
		// submit (and the UI transition away from the payment screen that
		// follows a successful one) lands before the second click finishes
		// ITS wait, the second click spins forever waiting for a "Submit"
		// button that is never coming back — confirmed via trace: exactly
		// one submit_invoice request fired (the guard held), yet the test
		// still hung for the full 30s on the second click. dblclick() does a
		// single actionability check, then fires both click events back to
		// back on that one resolved element — a closer match for an
		// impatient real double-click, and immune to this race.
		const submitButton = page.getByRole("button", { name: "Submit", exact: true });
		await submitButton.dblclick();

		const successToast = page.getByText(/Invoice \S+ is Submited/);
		await expect(successToast).toBeVisible();
		const toastText = await successToast.textContent();
		lastInvoiceId = toastText?.match(/Invoice (\S+) is Submited/)?.[1] ?? "";
		expect(lastInvoiceId).not.toBe("");

		expect(submitRequestCount).toBe(1);
		page.off("request", countSubmitRequests);
	});

	test("NEG-004 — Network failure during submission queues for offline sync", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		await page.route(SUBMIT_INVOICE_URL, (route) => route.abort("failed"));

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await page.getByRole("button", { name: "Submit", exact: true }).click();

		// posapp.submit_invoice is registered offline-capable (call-registry.ts),
		// so classifyFetchError()'s "network_error" verdict gets absorbed into
		// the offline outbox rather than surfaced as a hard failure — this is
		// the actual current behavior (Payments.vue's submit_invoice(), ~line
		// 1071), which is what makes the workbook's "clear recovery/status
		// message" expectation true here.
		await expect(page.getByText(/Queued \S+\. Will sync when online/)).toBeVisible();

		await page.unroute(SUBMIT_INVOICE_URL);
	});

	test("NEG-005 — Stock validation error surfaces to the cashier", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		// Synthesizes the exact Frappe error shape posapp.py's submit_invoice()
		// raises when ERPNext's own negative-stock check fires during save/
		// submit (NegativeStockError re-thrown as frappe.throw(...,
		// title="Insufficient Stock"), ~line 1167) — verifies the frontend
		// surfaces that message, without needing a second session to actually
		// deplete real stock out from under this cart.
		await page.route(SUBMIT_INVOICE_URL, (route) =>
			route.fulfill({
				status: 417,
				contentType: "application/json",
				body: JSON.stringify({
					exc_type: "ValidationError",
					_error_message: `Insufficient Stock: Negative stock error for Item ${TEST_DATA.itemName}`,
				}),
			}),
		);

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await page.getByRole("button", { name: "Submit", exact: true }).click();

		await expect(page.getByText(/Insufficient Stock/)).toBeVisible();

		await page.unroute(SUBMIT_INVOICE_URL);

		// The (fake-)rejected sale never actually completed. Just deleting the
		// line item isn't enough here: update_invoice() had already saved this
		// cart as a real draft Sales Invoice server-side (with a real name and
		// a resolved customer_address) before the mocked failure, and
		// deleting the item leaves that draft's other fields — notably
		// invoice_doc.customer_address — stuck on invoice_doc for the rest of
		// the shared page. That stale address caused NEG-007 to fail for real
		// on this file's first attempt ("Billing Address does not belong to
		// the Sam", from ERPNext's validate_party_address_and_contact())
		// purely because of this leftover state, not anything NEG-007 itself
		// was testing. cancel_invoice() (bound to the "Cancel Sale" flow) is
		// the one path that calls clear_invoice() and genuinely resets
		// invoice_doc, customer, and customer_address back to defaults.
		await page.getByRole("button", { name: "Cancel Payment" }).click();
		await page.getByRole("button", { name: "Cancel Sale", exact: true }).click();
		await expect(page.getByText("Cancel Sale?", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Cancel Sale", exact: true }).last().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toHaveCount(0);
	});

	test("NEG-006 — Return quantity is clamped to what was sold", async () => {
		test.skip(!lastInvoiceId, "No invoice ID captured from NEG-003 — nothing to return against.");

		// Same customer-field-vs-invoice-ID-filter reasoning as smoke.spec.ts's
		// SMK-007: the returns search ANDs Customer.vue's own field on top of
		// the invoice ID, so a stale customer selection can exclude the
		// invoice we actually want. NEG-005's cancel_invoice() cleanup already
		// reset `this.customer` to the POS Profile default, so "Clear
		// Customer" may not even be showing any more — only click it if a
		// customer is actually selected.
		const clearCustomerButton = page.getByRole("button", { name: "Clear Customer" });
		if (await clearCustomerButton.isVisible().catch(() => false)) {
			await clearCustomerButton.click();
		}
		await page.getByRole("button", { name: "Sales Return" }).click();

		await page.getByRole("textbox", { name: /Invoice ID/ }).fill(lastInvoiceId);
		await page.getByRole("button", { name: "Search", exact: true }).click();

		const invoiceRow = page.getByRole("row", { name: lastInvoiceId });
		await expect(invoiceRow).toBeVisible();
		await invoiceRow.getByRole("checkbox").click();
		await page.getByRole("button", { name: "Select Items" }).click();

		// NEG-003 sold qty 1, so remaining_qty here is 1 — any qty above that
		// exercises validateReturnQty()'s over-return clamp (Returns.vue ~line
		// 514): it resets the field back to remaining_qty and shows a warning
		// toast, rather than letting an over-return through.
		// `.return-qty-input` is Vuetify's own class on the wrapping `<div
		// class="v-input">`, not the actual `<input>` — .fill() needs the real
		// form control inside it.
		const returnQtyInput = page.locator(".return-qty-input input").first();
		await returnQtyInput.fill("9999");
		await returnQtyInput.blur();

		// validateReturnQty() (Returns.vue ~line 514) sets the clamped value
		// AND calls toast.warning() in the same synchronous block — they fire
		// at the same instant. But checking them SEQUENTIALLY is still a
		// race: the toast has a fixed ~3s autoClose lifetime starting from
		// that instant, while the value's own DOM re-render can lag behind
		// (confirmed via a temporary debug run: value observed "9999" right
		// after fill() and blur(), only settling to "1" a moment later).
		// Awaiting the value-settle poll FIRST can itself eat into — or
		// under this session's heavy concurrent load, exceed — the toast's
		// remaining lifetime before the toast check ever starts polling.
		// Polling both concurrently (same starting instant, neither wait
		// blocking the other) avoids that budget conflict either direction.
		await Promise.all([
			expect(returnQtyInput).not.toHaveValue("9999"),
			expect(page.getByText(/Cannot return more than/)).toBeVisible(),
		]);

		// This case only tests the rejection — back out without completing a
		// return, so NEG-003's invoice is left untouched for reconciliation.
		await page.getByRole("button", { name: "Back", exact: true }).click();
		await page.getByRole("button", { name: "Close", exact: true }).click();
	});

	test("NEG-007 — Payment timeout is absorbed the same as a network failure", async () => {
		// NEG-006's return flow clicked "Clear Customer" (same as
		// smoke.spec.ts's SMK-007) and never re-selected one — without this,
		// show_payment()'s `!this.customer` check (~line 2556) fires before
		// the payment call is ever reached, and the Payments panel never
		// opens at all.
		const customerField = page.getByRole("textbox", { name: /Customer/ });
		await customerField.click();
		await customerField.fill(TEST_DATA.existingCustomerName);
		await page
			.getByRole("listbox")
			.getByText(TEST_DATA.existingCustomerName, { exact: true })
			.first()
			.click();

		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		// Confirmed via call.ts/Payments.vue: no client-enforced timeout exists
		// anywhere in the submit_invoice call path (no AbortSignal is ever
		// passed, Payments.vue ~line 1015) — a genuinely hanging request has no
		// ceiling today. This simulates the only "timeout" that currently
		// exists in practice (the network/browser layer eventually giving up),
		// which is a bare fetch() rejection indistinguishable from NEG-004's by
		// the time it reaches classifyFetchError() — both land in the same
		// offline-outbox path rather than a dedicated timeout-recovery one.
		await page.route(SUBMIT_INVOICE_URL, (route) => route.abort("timedout"));

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await page.getByRole("button", { name: "Submit", exact: true }).click();

		await expect(page.getByText(/Queued \S+\. Will sync when online/)).toBeVisible();

		await page.unroute(SUBMIT_INVOICE_URL);
	});
});
