/**
 * Shared POS UI helpers, extracted from the per-spec copies in
 * functional/integration/negative/performance.spec.ts. Every helper takes the
 * `page` explicitly so several cashiers can be driven in one test.
 *
 * These only drive the UI. Business assertions live in helpers/backend.ts.
 */

import { expect, type Page } from "@playwright/test";

// Both the item-search table and the cart are v-data-tables, so an unscoped
// row lookup matches both once an item is in the cart. Always scope through
// the cart's wrapping class.
export function cartRow(page: Page, itemName: string) {
	return page.locator(".invoice-cart-section").getByRole("row", { name: itemName });
}

const searchField = (page: Page) => page.getByPlaceholder(/Search by name, code, barcode/i).first();
const openingDialogTitle = (page: Page) => page.getByText("Create Opening Shift", { exact: true }).first();

/**
 * Navigates to the POS and waits until the page has settled into one of its
 * two real states, returning which one:
 *   "open"   - a shift is open (item search field is really visible)
 *   "dialog" - the Create Opening Shift dialog is showing
 *
 * Pos.vue applies a cached "shift open" snapshot synchronously, then a live
 * check_opening_shift round-trip can override it. The item search field is
 * visible BEFORE the app has decided to show the opening dialog, so racing
 * "dialog vs search field" can misread a dialog that is about to appear as an
 * open shift (seen in headed runs, where it made ensureShiftOpen try to close a
 * shift that did not exist). So the SERVER's check_opening_shift answer decides
 * the state, and the UI is only awaited to confirm it. The old visual race is
 * kept as a fallback if no response is seen.
 */
/**
 * Best-effort "make this window active" so background-throttling cannot slow a
 * page. page.bringToFront() has no timeout of its own and can hang indefinitely
 * in headed runs with several windows (the OS may not grant focus), which then
 * consumes the whole test timeout. Bound it and carry on.
 */
async function bringToFrontBounded(page: Page, ms = 3_000) {
	await Promise.race([page.bringToFront().catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

export async function gotoPos(page: Page): Promise<"open" | "dialog"> {
	const shiftCheckSettled = page
		.waitForResponse((res) => res.url().includes("posapp.check_opening_shift"), { timeout: 20_000 })
		.catch(() => null);
	await page.goto("/pospire/pos");
	await bringToFrontBounded(page);
	const shiftCheck = await shiftCheckSettled;

	let serverSaysOpen: boolean | null = null;
	if (shiftCheck) {
		try {
			// check_opening_shift returns "" when the user has no open shift.
			serverSaysOpen = Boolean((await shiftCheck.json())?.message?.pos_opening_shift);
		} catch {
			/* unreadable body: fall back to the visual race below */
		}
	}
	if (serverSaysOpen !== null) {
		if (serverSaysOpen) {
			await expect(searchField(page)).toBeVisible({ timeout: 20_000 });
			await expect(openingDialogTitle(page)).toBeHidden({ timeout: 20_000 });
			return "open";
		}
		await expect(openingDialogTitle(page)).toBeVisible({ timeout: 20_000 });
		return "dialog";
	}

	return Promise.race([
		openingDialogTitle(page)
			.waitFor({ state: "visible", timeout: 20_000 })
			.then(() => "dialog" as const),
		searchField(page)
			.waitFor({ state: "visible", timeout: 20_000 })
			.then(() => "open" as const),
	]).catch(() => {
		throw new Error("Neither the Opening Shift dialog nor the POS main screen appeared within 20s");
	});
}

/** Waits for the catalogue's loading bar to clear so menu clicks aren't racing hydration. */
async function waitForCatalogueSettled(page: Page) {
	await page
		.getByRole("progressbar")
		.first()
		.waitFor({ state: "hidden", timeout: 15_000 })
		.catch(() => {});
}

/**
 * Closes the open shift through the menu. Online it asserts the server accepted the closing;
 * with `offline: true` there is no response to wait for (the closing is queued), so it only
 * waits for the dialog to go away.
 */
export async function closeShift(page: Page, opts: { offline?: boolean } = {}) {
	// The old per-spec copies clicked the menu while the page was still
	// hydrating, so the Close Shift dialog never appeared within 5s and the
	// afterAll cleanup left a shift open. Settle first, allow the dialog longer.
	await expect(searchField(page)).toBeVisible({ timeout: 15_000 });
	await waitForCatalogueSettled(page);

	await page.locator(".menu-button").click();
	await page.getByText("Close Shift", { exact: true }).click();

	const dialogTitle = page.getByText("Close POS Shift", { exact: true }).or(page.getByText("Closing Amount"));
	await expect(dialogTitle.first()).toBeVisible({ timeout: 15_000 });

	const increaseDenom = page.getByRole("button", { name: /Increase quantity for/ }).first();
	for (let i = 0; i < 5; i++) {
		await increaseDenom.click();
	}

	// The dialog hides even when the server refuses the closing (e.g. a 403 for
	// a role without POS Closing Shift permission), so a hidden dialog is not
	// proof the shift closed. Assert on the real response.
	if (opts.offline) {
		await page.getByRole("button", { name: "Close Shift", exact: true }).click();
		await expect(dialogTitle.first()).toBeHidden({ timeout: 15_000 });
		return;
	}
	const closingResponse = page.waitForResponse(
		(res) => res.url().includes("submit_closing_shift"),
		{ timeout: 15_000 },
	);
	await page.getByRole("button", { name: "Close Shift", exact: true }).click();
	const res = await closingResponse;
	expect(res.status(), `submit_closing_shift returned HTTP ${res.status()}`).toBe(200);
	await expect(dialogTitle.first()).toBeHidden({ timeout: 15_000 });
}

export interface OpenShiftOptions {
	company: string;
	posProfile: string;
	openingCash: string;
	/** Awaited right before "Create Opening Shift" is pressed: lets a test hold several devices at a barrier. */
	beforeCreate?: () => Promise<void>;
}

/**
 * Leaves the page with a shift open on the requested profile, closing any
 * shift already open for this user first (a leftover from an interrupted run
 * must not silently no-op).
 */
export async function ensureShiftOpen(page: Page, opts: OpenShiftOptions) {
	const state = await gotoPos(page);

	if (state === "open") {
		await closeShift(page);
		await page.reload();
		await expect(openingDialogTitle(page)).toBeVisible({ timeout: 20_000 });
	}

	await fillOpeningDialog(page, opts);
}

/**
 * Fills in and submits the Create Opening Shift dialog on a page that is ALREADY showing it.
 * Split from ensureShiftOpen so a test can open a shift on a page that is offline (it cannot
 * navigate there; the dialog is already on screen).
 */
export async function fillOpeningDialog(page: Page, opts: OpenShiftOptions) {
	await page.getByLabel("Store").click();
	await page.locator(".v-overlay--active .v-list-item", { hasText: opts.company }).first().click();

	await page.getByLabel("POS Profile").click();
	await page.locator(".v-overlay--active .v-list-item", { hasText: opts.posProfile }).first().click();

	// Opening cash is entered one of two ways, depending on the profile:
	//   - a plain "Opening Amount" field, or
	//   - when cash denominations are enabled (the seeded PERF profiles clone
	//     this from the base profile) NO such field exists and the amount is
	//     the sum of a denomination grid. Filling a field that is not there
	//     silently leaves opening cash at 0, so wait for whichever appears,
	//     and fail loudly if neither does while cash was requested.
	const amountField = page.getByLabel("Opening Amount");
	// The button's aria-label uses the denomination's display name ("100 INR
	// Note"), not its id ("INR-100").
	const hundredNote = page.getByRole("button", { name: "Increase quantity for 100 INR Note" });
	const entryMode = await Promise.race([
		amountField.waitFor({ state: "visible", timeout: 10_000 }).then(() => "field" as const),
		hundredNote.waitFor({ state: "visible", timeout: 10_000 }).then(() => "grid" as const),
	]).catch(() => null);

	const cash = Number(opts.openingCash);
	if (cash > 0 && entryMode === null) {
		throw new Error(`Could not find an opening cash input (field or denomination grid) to enter ${cash}`);
	}
	if (entryMode === "field") {
		await amountField.fill(opts.openingCash);
	} else if (entryMode === "grid" && cash > 0) {
		if (cash % 100 !== 0) {
			throw new Error(`openingCash ${cash} must be a multiple of 100 when denominations are enabled`);
		}
		for (let i = 0; i < cash / 100; i++) {
			await hundredNote.click();
		}
	}

	if (opts.beforeCreate) await opts.beforeCreate();
	await page.getByRole("button", { name: "Create Opening Shift" }).click();
	await expect(openingDialogTitle(page)).toBeHidden({ timeout: 20_000 });
}

export async function selectCustomer(page: Page, customerName: string) {
	const customerField = page.getByRole("textbox", { name: /Customer/ });
	await customerField.click();
	await customerField.fill(customerName);
	await page.getByRole("listbox").getByText(customerName, { exact: true }).first().click();
	await expect(customerField).toHaveValue(new RegExp(customerName));
}

export async function addItem(page: Page, itemName: string) {
	await searchField(page).fill(itemName);
	await page.getByText(itemName, { exact: false }).first().click();
	await expect(cartRow(page, itemName)).toBeVisible();
}

/**
 * Builds the cart and gets the payment dialog ready with Cash selected, but
 * does NOT submit. Split from submitCashSale so concurrency tests can hold
 * every cashier at a barrier and press Submit together.
 */
export async function prepareCashSale(page: Page, itemName: string, qty = 1) {
	for (let i = 0; i < qty; i++) {
		await addItem(page, itemName);
	}
	await page.locator(".pay-button").click();
	await page.getByRole("button", { name: "Cash", exact: true }).click();
	await expect(page.getByLabel("Cash", { exact: true })).not.toHaveValue("0");
}

/** Presses Submit on a prepared sale and returns the submitted invoice name. */
export async function submitCashSale(page: Page): Promise<string> {
	await page.getByRole("button", { name: "Submit", exact: true }).click();

	const successToast = page.getByText(/Invoice \S+ is Submited/);
	await expect(successToast).toBeVisible({ timeout: 30_000 });
	const toastText = await successToast.textContent();
	const invoiceId = toastText?.match(/Invoice (\S+) is Submited/)?.[1] ?? "";
	expect(invoiceId).not.toBe("");
	return invoiceId;
}

/** Completes a real cash sale for itemName and returns the submitted invoice name. */
export async function completeCashSale(page: Page, itemName: string): Promise<string> {
	await prepareCashSale(page, itemName);
	return submitCashSale(page);
}

export interface SubmitOutcome {
	ok: boolean;
	invoice?: string;
	/** Visible messages (toasts/alerts) when the submit was not confirmed. */
	message: string;
	/** HTTP status of each submit_invoice request the screen made while waiting. */
	statuses: number[];
}

/**
 * Presses Submit on a prepared sale and records what happened WITHOUT assuming
 * success: a refused sale (e.g. the last unit already gone) must come back as a
 * result to assert on, not as a timeout. Returns as soon as either the success
 * toast or an error message appears, or after `timeoutMs`. When selling repeatedly on one page pass
 * `exclude` (the invoices of earlier sales), so a lingering toast is not mistaken for this sale.
 */
export async function attemptSubmit(page: Page, timeoutMs = 30_000, exclude: string[] = []): Promise<SubmitOutcome> {
	const statuses: number[] = [];
	const onResponse = (r: { url(): string; status(): number }) => {
		if (/posapp\.submit_invoice/.test(r.url())) statuses.push(r.status());
	};
	page.on("response", onResponse);
	try {
		await page.getByRole("button", { name: "Submit", exact: true }).click();

		const success = page.getByText(/Invoice \S+ is Submited/);
		const alerts = page.locator(".v-snackbar, .toast, [role=alert]");
		const failureWords = /error|insufficient|stock|not available|failed|invalid|exhausted|already|not open/i;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			// A toast from an EARLIER sale may still be on screen: only a toast naming an invoice that is not in
			// `exclude` counts as this sale's success.
			const toasts = await success.allTextContents().catch(() => [] as string[]);
			const fresh = toasts.map((t) => t.match(/Invoice (\S+) is Submited/)?.[1]).find((n) => n && !exclude.includes(n));
			if (fresh) return { ok: true, invoice: fresh, message: "", statuses };
			const texts = (await alerts.allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
			if (texts.some((t) => failureWords.test(t))) return { ok: false, message: texts.join(" | "), statuses };
			await page.waitForTimeout(250);
		}
		const texts = (await alerts.allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
		return { ok: false, message: texts.join(" | ") || "(no message within the time limit)", statuses };
	} finally {
		page.off("response", onResponse);
	}
}

/**
 * Creates a customer through the "Create Customer" dialog (works offline: it queues the creation).
 * Pass `group` / `territory` to pick those options by name (robust when the option lists load slowly);
 * without them the first option of each list is used.
 */
export async function createCustomer(page: Page, name: string, opts: { group?: string; territory?: string } = {}) {
	await page.locator(".customer-action-icon").last().click();
	await expect(page.getByText("Create Customer", { exact: true })).toBeVisible();
	await page.getByLabel(/Customer Name/).fill(name);
	for (const [field, wanted] of [
		[/Customer Group/, opts.group],
		[/Territory/, opts.territory],
	] as const) {
		const box = page.getByRole("textbox", { name: field });
		await box.click();
		const options = page.locator(".v-overlay--active .v-list-item");
		await expect(options.first()).toBeVisible({ timeout: 20_000 });
		if (wanted) {
			await box.fill(wanted);
			await options.filter({ hasText: wanted }).first().click();
		} else {
			await options.first().click();
		}
		// the menu closes once something is chosen
		await expect(options.first()).toBeHidden({ timeout: 10_000 });
	}
	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Create Customer", { exact: true })).toBeHidden({ timeout: 30_000 });
}

/** The Create Opening Shift dialog title is on screen (a shift is not open). */
export const openingDialogVisible = (page: Page) => openingDialogTitle(page).isVisible().catch(() => false);
