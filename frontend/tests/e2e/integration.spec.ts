/**
 * Integration tests — POSpire QA Test Case Workbook, "Integration" tab
 * (INT-001–INT-005).
 *
 * Unlike the other spec files, these combine a real browser-driven sale
 * (same conventions as functional.spec.ts/negative.spec.ts) with direct,
 * read-only backend verification via an API-key-authenticated `request`
 * context (same pattern as api.spec.ts) — the point of "integration"
 * testing here is confirming the UI action actually produced correct
 * ERPNext-side records (GL, stock ledger), not just a success toast.
 *
 * Uses "MG Road - POS 2" (same profile as functional.spec.ts/negative.spec.ts)
 * — it already has `posa_hardware_manager` enabled, which INT-004 needs; "MG
 * Road - POS 1" (smoke.spec.ts) does not have it enabled (confirmed via DB,
 * 2026-10-01).
 *
 * INT-001/INT-002/INT-003's own Exception Flow columns ("ERP validation
 * error surfaced" / "Insufficient stock prevents invalid posting") already
 * have dedicated coverage elsewhere — API-003's missing-company case and
 * NEG-005's stock-error case respectively — so these three focus on their
 * own primary contribution: verifying the REAL side effects of an actual
 * successful sale (Sales Invoice fields, Stock Ledger Entry, GL Entries),
 * which neither of those two mocked/API-only tests touch. INT-003's own
 * exception case ("no orphan records") IS new here: a failed submission
 * (negative payment, same technique as API-005) is checked for zero GL
 * Entries, not just zero invoices.
 *
 * INT-004 (Hardware Manager / receipt printer) was root-caused against the
 * real, running Hardware Manager service before writing anything: a Java/
 * Jetty app listening on http://localhost:8090 (confirmed via
 * `POS Hardware Manager Setting`'s `hardware_url`/`port` fields, and the one
 * registered API row, "Printer" -> "/printer"). Confirmed live (2026-10-01):
 *   - GET / -> "Hardware Manager home page" (it's genuinely running).
 *   - POST /printer with sample XML -> 200, {"result":"OK","resultData":""}.
 *   - CORS headers echo the caller's Origin, so the browser's own
 *     `fetch()` from the POS app (a different origin/port) to port 8090
 *     works without a proxy.
 * hardwareUtils.js's printReceipt() -> _printThermalOnline() is the whole
 * flow: fetch the registered "Printer" URL from the backend, ask the
 * backend to render the invoice as XML (generate_print_xml), then POST that
 * XML straight to the printer URL via a plain fetch(). There's no
 * client-side retry logic anywhere in that path — "offline printer allows
 * retry" just means a failure is surfaced as a dismissable error (not a
 * stuck/crashed UI) so the cashier can press the button again once the
 * printer's back. The happy path below prints for real, through the real
 * service; the exception path uses page.route() to make just that one
 * fetch() fail, rather than actually stopping the real running service.
 *
 * INT-005 (barcode scanner): there is no "Scanner" row in the Hardware
 * Manager's registered APIs at all (only "Printer") — confirmed via the
 * `POS Hardware API` child table. Barcode scanning isn't routed through the
 * Hardware Manager; a scanner is just a HID keyboard-wedge device typing
 * into the search field far faster than a human (the same mechanism
 * functional.spec.ts's FUN-002 already drives with fill()+Enter). This test
 * simulates "rapid scanning" as several fill()+Enter cycles back-to-back
 * with no artificial delay between them, to exercise ItemsSelector.vue's
 * debounced-search watcher under scanner-speed input instead of human-speed
 * input.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API_KEY, API_SECRET, AUTH_FILE, BASE_URL } from "./auth.config";

const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 2",
	existingCustomerName: "Sam",
	itemName: "Women's Ballerina Flats", // LSF-002
	// Three distinct, already-assortment-allowed items with real barcodes
	// (confirmed via Item Barcode, 2026-10-01), none reused by
	// functional.spec.ts/negative.spec.ts, for INT-005's rapid-scan test.
	rapidScanItems: [
		{ itemName: "Men's Sneakers", barcode: "8901234500316" }, // LSF-001
		{ itemName: "Men's Formal Leather Shoes", barcode: "8901234500330" }, // LSF-003
		{ itemName: "Women's Wedge Heels", barcode: "8901234500347" }, // LSF-004
	],
};

const PRINTER_ORIGIN_PATTERN = "http://localhost:8090/**";

function cartRow(page: Page, itemName: string) {
	return page.locator(".invoice-cart-section").getByRole("row", { name: itemName });
}

test.describe.serial("Integration — real backend side effects (INT-001 to INT-005)", () => {
	let page: Page;
	let authed: APIRequestContext;

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

	async function ensureShiftOpen() {
		const dialogTitle = page.getByText("Create Opening Shift", { exact: true }).first();
		// NOT `.menu-button`: it lives in Navbar.vue with no v-if guarding it,
		// so it's "visible" (Playwright's CSS-only definition) from the
		// instant the page loads, even while the Opening dialog's own scrim
		// covers it — racing on it is close to 50/50 against the dialog
		// itself and, when it wins, leaves closeShift() stuck click-retrying
		// a button that's genuinely there but pointer-blocked by that scrim
		// (confirmed via trace: this is exactly what happened here, against
		// the pre-existing open shift on MG Road - POS 2). The item search
		// field sits inside Pos.vue's `v-row v-show="!dialog"` block instead,
		// so it's only really visible once the dialog is gone.
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
			await openingAmount.fill("5000");
		}

		await page.getByRole("button", { name: "Create Opening Shift" }).click();
		await expect(dialogTitle).toBeHidden();
	}

	async function selectCustomer() {
		const customerField = page.getByRole("textbox", { name: /Customer/ });
		await customerField.click();
		await customerField.fill(TEST_DATA.existingCustomerName);
		await page
			.getByRole("listbox")
			.getByText(TEST_DATA.existingCustomerName, { exact: true })
			.first()
			.click();
		await expect(customerField).toHaveValue(new RegExp(TEST_DATA.existingCustomerName));
	}

	/** Completes a real cash sale for TEST_DATA.itemName, returns the submitted invoice's name. */
	async function completeCashSale(): Promise<string> {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await expect(page.getByLabel("Cash", { exact: true })).not.toHaveValue("0");
		await page.getByRole("button", { name: "Submit", exact: true }).click();

		const successToast = page.getByText(/Invoice \S+ is Submited/);
		await expect(successToast).toBeVisible();
		const toastText = await successToast.textContent();
		const invoiceId = toastText?.match(/Invoice (\S+) is Submited/)?.[1] ?? "";
		expect(invoiceId).not.toBe("");
		return invoiceId;
	}

	test.beforeAll(async ({ browser, playwright }, testInfo) => {
		testInfo.setTimeout(60_000);
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");

		authed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});

		const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_FILE });
		page = await context.newPage();

		// See functional.spec.ts's beforeAll comment: Pos.vue can flash an
		// optimistic cached-snapshot state before its live check_opening_shift
		// round-trip corrects it — wait for that round-trip before
		// ensureShiftOpen()'s race reads the dialog/main-screen state.
		const shiftCheckSettled = page
			.waitForResponse((res) => res.url().includes("posapp.check_opening_shift"), {
				timeout: 15000,
			})
			.catch(() => null);
		await page.goto("/pospire/pos");
		await page.bringToFront();
		await shiftCheckSettled;
		await ensureShiftOpen();
		await selectCustomer();
	});

	test.afterAll(async () => {
		await closeShift();
		await page.context().close();
		await authed?.dispose();
	});

	let int001InvoiceId = "";

	test("INT-001 — A completed POS sale produces a correct, matching Sales Invoice", async () => {
		int001InvoiceId = await completeCashSale();

		const res = await authed.post("/api/method/frappe.client.get", {
			data: { doctype: "Sales Invoice", name: int001InvoiceId },
		});
		expect(res.status()).toBe(200);
		const invoice = (await res.json()).message;

		expect(invoice.docstatus).toBe(1);
		expect(invoice.customer).toBe(TEST_DATA.existingCustomerName);
		expect(invoice.pos_profile).toBe(TEST_DATA.posProfileName);
		expect(invoice.items).toHaveLength(1);
		expect(invoice.items[0].item_code).toBe("LSF-002");
		expect(invoice.items[0].qty).toBe(1);
		// Paid in full by cash — outstanding must be zero, not just "docstatus
		// submitted" (a submitted-but-unreconciled invoice would still pass a
		// weaker check).
		expect(invoice.outstanding_amount).toBe(0);
	});

	test("INT-002 — The same sale produces a correct Stock Ledger Entry", async () => {
		const res = await authed.post("/api/method/frappe.client.get_list", {
			data: {
				doctype: "Stock Ledger Entry",
				filters: JSON.stringify({ voucher_type: "Sales Invoice", voucher_no: int001InvoiceId }),
				fields: JSON.stringify(["item_code", "warehouse", "actual_qty", "qty_after_transaction"]),
			},
		});
		expect(res.status()).toBe(200);
		const entries = (await res.json()).message;

		expect(entries).toHaveLength(1);
		expect(entries[0].item_code).toBe("LSF-002");
		expect(entries[0].warehouse).toBe("Sales Floor - LRS");
		// A sale DECREASES stock — actual_qty is signed, must be negative.
		expect(entries[0].actual_qty).toBe(-1);
	});

	test("INT-003 — The same sale's payment reconciles in the GL, and a failed submit leaves no orphan GL rows", async () => {
		const glRes = await authed.post("/api/method/frappe.client.get_list", {
			data: {
				doctype: "GL Entry",
				filters: JSON.stringify({ voucher_type: "Sales Invoice", voucher_no: int001InvoiceId }),
				fields: JSON.stringify(["account", "debit", "credit"]),
			},
		});
		expect(glRes.status()).toBe(200);
		const glEntries: { account: string; debit: number; credit: number }[] = (
			await glRes.json()
		).message;

		expect(glEntries.length).toBeGreaterThan(0);
		const totalDebit = glEntries.reduce((sum, row) => sum + row.debit, 0);
		const totalCredit = glEntries.reduce((sum, row) => sum + row.credit, 0);
		// A balanced voucher is the fundamental accounting invariant — if this
		// doesn't hold, the sale corrupted the ledger regardless of anything
		// else.
		expect(totalDebit).toBeCloseTo(totalCredit, 2);

		const cashRow = glEntries.find(
			(row) => row.account.toLowerCase().includes("cash") && row.debit > 0,
		);
		expect(cashRow).toBeTruthy();
		expect(cashRow!.debit).toBeCloseTo(1499, 2);

		// Exception flow: a failed submission (negative payment amount, same
		// root cause as API-005) must not leave orphan GL rows behind for an
		// invoice that never actually completed.
		const createRes = await authed.post(
			"/api/method/pospire.pospire.api.posapp.update_invoice",
			{
				data: {
					data: JSON.stringify({
						doctype: "Sales Invoice",
						is_pos: 1,
						ignore_pricing_rule: 1,
						company: TEST_DATA.companyName,
						pos_profile: TEST_DATA.posProfileName,
						customer: TEST_DATA.existingCustomerName,
						currency: "INR",
						posting_date: new Date().toISOString().slice(0, 10),
						items: [
							{ item_code: "LSF-002", qty: 1, rate: 1499, uom: "Nos", conversion_factor: 1 },
						],
					}),
				},
			},
		);
		const draftInvoice = (await createRes.json()).message;
		draftInvoice.payments = [{ mode_of_payment: "Cash", amount: -100 }];

		const failedSubmit = await authed.post(
			"/api/method/pospire.pospire.api.posapp.submit_invoice",
			{
				data: {
					invoice: draftInvoice,
					data: JSON.stringify(draftInvoice),
					offline_id: `int003-orphan-check-${Date.now()}`,
				},
			},
		);
		expect(failedSubmit.status()).toBe(417);

		const orphanGlRes = await authed.post("/api/method/frappe.client.get_count", {
			data: {
				doctype: "GL Entry",
				filters: JSON.stringify({ voucher_type: "Sales Invoice", voucher_no: draftInvoice.name }),
			},
		});
		expect((await orphanGlRes.json()).message).toBe(0);
	});

	test("INT-004 — Receipt prints through the real Hardware Manager", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await page.getByRole("button", { name: "Submit & Print", exact: true }).click();

		// hardwareUtils.js's _printThermalOnline() shows this exact toast only
		// after the printer POST actually succeeds (toast.success(__("Printing...")),
		// placed after `await this.postToPrinter(...)`) — a real round trip to
		// the live Hardware Manager at localhost:8090, not a client-side
		// assumption.
		await expect(page.getByText("Printing...", { exact: true })).toBeVisible();
	});

	test("INT-004 (exception) — Hardware Manager being unreachable surfaces an error, not a stuck UI", async () => {
		await page.getByPlaceholder(/Search by name, code, barcode/i).fill(TEST_DATA.itemName);
		await page.getByText(TEST_DATA.itemName, { exact: false }).first().click();
		await expect(cartRow(page, TEST_DATA.itemName)).toBeVisible();

		// Simulates the printer being offline WITHOUT touching the real,
		// currently-running service — only this page's own fetch() to it is
		// intercepted.
		await page.route(PRINTER_ORIGIN_PATTERN, (route) => route.abort("connectionrefused"));

		await page.locator(".pay-button").click();
		await page.getByRole("button", { name: "Cash", exact: true }).click();
		await page.getByRole("button", { name: "Submit & Print", exact: true }).click();

		// printReceipt()'s catch block: toast.error(err?.userMessage || __("Could
		// not print the receipt. Please try again.")) — postToPrinter() throws
		// a plain Error with no userMessage for a network-level failure, so
		// this is the generic message.
		await expect(page.getByText("Could not print the receipt. Please try again.")).toBeVisible();

		// Payments.vue's submit_invoice() awaits printReceipt() (Submit &
		// Print's print=true branch), but printReceipt() swallows its own
		// error internally (hardwareUtils.js's try/catch) rather than
		// rethrowing — so a print failure does NOT stop the invoice from
		// being treated as submitted. The success toast and the normal
		// post-submit reset (cart clear, back to item selection) still fire
		// right after. The sale already succeeded server-side; only the
		// receipt failed to print.
		// .last(): INT-004's own still-visible success toast (not yet
		// auto-dismissed) can still match the same text at this point.
		await expect(page.getByText(/Invoice \S+ is Submited/).last()).toBeVisible();

		// "Not a stuck UI": back on the main item-selection screen with the
		// cart cleared, ready for the next sale — not stranded mid-payment.
		// There is no "retry on the same screen" here (the invoice already
		// submitted; re-clicking Submit & Print would attempt to submit a
		// second one) — the real retry path is Navbar's "Print Last Invoice"
		// (print_last_invoice(), gated on posa_allow_print_last_invoice,
		// confirmed enabled on "MG Road - POS 2").
		await expect(page.getByPlaceholder(/Search by name, code, barcode/i)).toBeVisible();
		// Not a bare row-count(0): the cart table's "no data" state renders
		// its own single placeholder <tr> (this exact empty state, see
		// INT-005 (exception)'s own baseline-count approach below, which
		// doesn't assume 0 for the same reason) — "No items yet" is the
		// real, unambiguous signal that the cart is actually empty.
		await expect(page.getByText("No items yet", { exact: true })).toBeVisible();

		await page.unroute(PRINTER_ORIGIN_PATTERN);
		// Retry for real, against the actual running service, via the actual
		// retry mechanism — also leaves a clean, printed state instead of an
		// invoice whose receipt never got reprinted for the next test.
		await page.locator(".menu-button").click();
		await page.getByText("Print Last Invoice", { exact: true }).click();
		await expect(page.getByText("Printing...", { exact: true })).toBeVisible();
	});

	test("INT-005 — Rapid sequential scans are all processed, none missed or duplicated", async () => {
		const searchField = page.getByPlaceholder(/Search by name, code, barcode/i);

		// No waits between scans — a real scanner emits a barcode + Enter in a
		// few milliseconds, far faster than ItemsSelector.vue's debounced
		// search watcher's normal human-typing-speed assumption (see
		// FUN-002's comment on pressing Enter to flush that debounce).
		for (const item of TEST_DATA.rapidScanItems) {
			await searchField.fill(item.barcode);
			await searchField.press("Enter");
		}

		for (const item of TEST_DATA.rapidScanItems) {
			await expect(cartRow(page, item.itemName)).toBeVisible();
			await expect(cartRow(page, item.itemName)).toHaveCount(1);
		}
	});

	test("INT-005 (exception) — A malformed/unknown barcode is ignored safely", async () => {
		const searchField = page.getByPlaceholder(/Search by name, code, barcode/i);
		const cartRowCountBefore = await page.locator(".invoice-cart-section tbody tr").count();

		await searchField.fill("NOT-A-REAL-BARCODE-999999");
		await searchField.press("Enter");

		// No crash, no bogus row added — the cart's row count is unchanged,
		// and the app is still usable for the next scan.
		await expect(page.locator(".invoice-cart-section tbody tr")).toHaveCount(cartRowCountBefore);
		await expect(searchField).toBeEnabled();
	});
});
