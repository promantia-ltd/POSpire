/**
 * CON-08e / CON-08f (P0): can the SCREEN be used to return more than was sold?
 *
 * D2 showed the server accepts an over-return when it is called directly. These tests
 * drive the real Sales Return dialog, so they show whether a cashier can actually reach it.
 *
 *   CON-08e  one cashier: sell 3, return 2, then try to return 2 again (only 1 is left),
 *            then return the last one; then the invoice must show as fully returned
 *   CON-08f  two cashiers load the SAME invoice (3 sold) for a full return of 3 and press
 *            Submit at the same moment (released together at the network layer)
 *
 * Defect if the screen lets the second request exceed what remains, if the server ends
 * with more returned than sold, or if stock rises by more than was sold.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, RACE_CASHIER, WAREHOUSES, cashierEmail, cashierPassword } from "./fixtures/topology";
import { callAs, errorText } from "./helpers/as-user";
import { loginApiSeat } from "./helpers/api-seat";
import { binQty, getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { releaseTogether } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { RUN_ID } from "./helpers/manifest";
import { attemptSubmit, gotoPos, selectCustomer, type SubmitOutcome } from "./helpers/pos-ui";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed } from "./helpers/shifts";

const RATE = 1000;
const SOLD = 3;
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1) || !cashierPassword(2) || !cashierPassword(RACE_CASHIER), "cashier 01/02 and burst passwords not set in .env.test");
});

type Admin = Awaited<ReturnType<typeof newAdminContext>>;


const EXTRA_ROLE = "Accounts Manager";

/** Give `email` the role for the duration of one test (returns true if the test added it, so only that is undone). */
async function grantRole(admin: Admin, email: string, role: string): Promise<boolean> {
	const user = await getDoc<Record<string, any>>(admin, "User", email);
	if (!user) throw new Error(`user ${email} not found`);
	if ((user.roles ?? []).some((r: any) => r.role === role)) return false;
	const res = await admin.post("/api/method/frappe.client.save", { data: { doc: { ...user, roles: [...user.roles, { doctype: "Has Role", role }] } } });
	if (!res.ok()) throw new Error(`could not grant ${role} to ${email}: HTTP ${res.status()}`);
	return true;
}

async function revokeRole(admin: Admin, email: string, role: string) {
	const user = await getDoc<Record<string, any>>(admin, "User", email);
	if (!user) return;
	await admin.post("/api/method/frappe.client.save", { data: { doc: { ...user, roles: (user.roles ?? []).filter((r: any) => r.role !== role) } } });
}

const messages = async (a: Actor) => (await a.page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);

/** A customer and a submitted sale of SOLD units to them, made as `seller` straight on the server. */
async function makeSale(admin: Admin, seller: Actor, shift: string, f: Findings, tag: string) {
	const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
	const base = await getDoc<Record<string, any>>(admin, "Customer", String(profile?.customer));
	const made = await admin.post("/api/method/frappe.client.insert", {
		data: { doc: { doctype: "Customer", customer_name: `PERF RETSCR ${RUN_ID} ${tag}`, customer_type: "Individual", customer_group: base?.customer_group, territory: base?.territory } },
	});
	f.check(made.ok(), `could not create the customer: HTTP ${made.status()}`);
	const customer = (await made.json())?.message?.name as string;
	const draft = await createDraft(seller, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer, shift, items: [{ item_code: ITEMS.stock, qty: SOLD, rate: RATE }] }));
	if (!draft.doc) throw new Error(`could not draft the sale: HTTP ${draft.res.status}`);
	const paid = await submitDraft(seller, draft.doc, { cashAmount: SOLD * RATE });
	if (paid.status !== 200) throw new Error(`the sale was refused: HTTP ${paid.status}`);
	return { customer, invoice: (paid.json?.message?.name ?? draft.doc.name) as string };
}

/** The server's returns against an invoice: names and total returned quantity. */
async function returnsOf(admin: Admin, invoice: string) {
	const rows = await getList<{ name: string }>(admin, "Sales Invoice", { return_against: invoice, docstatus: 1 }, ["name"], 100);
	let qty = 0;
	for (const r of rows) {
		const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", r.name);
		qty += (d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
	}
	return { names: rows.map((r) => r.name), qty: -qty };
}

/**
 * Through the screen: select the customer, open Sales Return, find the invoice and load a return of `qty`.
 * Returns what the dialog said: the quantity left in the field after typing `qty`, the available text
 * and any toast. Leaves the return in the cart.
 */
async function loadReturnInner(a: Actor, customer: string, invoice: string, qty: number) {
	const page = a.page;
	await selectCustomer(page, customer);
	await page.getByRole("button", { name: "Sales Return", exact: true }).click();
	await page.getByLabel("Invoice ID").first().fill(invoice);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const row = page.getByRole("row", { name: new RegExp(invoice) }).first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	const rowText = ((await row.textContent()) ?? "").replace(/\s+/g, " ").trim();
	await row.getByRole("checkbox").click();
	await page.getByRole("button", { name: "Select Items", exact: true }).click();
	await expect(page.getByText("Select Items to Return")).toBeVisible();
	const dlg = page.locator(".v-overlay--active").last();
	const box = dlg.getByRole("checkbox").first();
	if (!(await box.isChecked())) await box.click();
	const field = page.locator(".return-qty-input input").first();
	await field.fill(String(qty));
	await field.blur();
	await page.waitForTimeout(500);
	const fieldAfter = await field.inputValue();
	const toasts = await messages(a);
	const available = ((await dlg.getByText(/\d+\s*\/\s*\d+/).first().textContent().catch(() => "")) ?? "").trim();
	await page.getByRole("button", { name: "Load Return", exact: true }).click();
	await expect(page.locator(".invoice-cart-section").getByRole("row", { name: ITEMS.stock })).toBeVisible({ timeout: 15_000 });
	return { rowText, fieldAfter, toasts, available };
}

/** Open the payment dialog for the loaded return, with Cash chosen if offered. */
async function readyToPayInner(a: Actor) {
	await a.page.locator(".pay-button").click();
	const cash = a.page.getByRole("button", { name: "Cash", exact: true });
	if (await cash.isVisible({ timeout: 10_000 }).catch(() => false)) await cash.click();
	await expect(a.page.getByRole("button", { name: "Submit", exact: true })).toBeVisible({ timeout: 30_000 });
}


const log = (m: string) => console.log(`[RETSCR ${new Date().toISOString().slice(11, 19)}] ${m}`);

/** Run a screen step with a hard time limit; on a stall take a screenshot and fail instead of hanging. */
async function bounded<T>(name: string, a: Actor, fn: () => Promise<T>, ms = 120_000): Promise<T> {
	log(`${a.email}: ${name}`);
	let timer: NodeJS.Timeout | undefined;
	const watchdog = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${name} exceeded ${ms / 1000} s (watchdog)`)), ms)));
	try {
		return await Promise.race([fn(), watchdog]);
	} catch (e) {
		log(`FAILED ${name}: ${String(e).split("\n")[0]} | on screen: ${JSON.stringify(await messages(a))}`);
		await a.page.screenshot({ path: `perf-results/retscr-${name.replace(/\W+/g, "_")}-${a.email.slice(0, 14)}.png` }).catch(() => {});
		throw e;
	} finally {
		clearTimeout(timer);
	}
}
const loadReturn = (a: Actor, customer: string, invoice: string, qty: number) => bounded(`loadReturn(${qty})`, a, () => loadReturnInner(a, customer, invoice, qty));
const readyToPay = (a: Actor) => bounded("readyToPay", a, () => readyToPayInner(a));

async function finish(id: string, arrangement: string, f: Findings, data: Record<string, unknown>, completed: boolean) {
	if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
	const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
	recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
}
const assertClean = (f: Findings) => {
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
};

test("CON-08e — the Sales Return screen: sell 3, return 2, try 2 again, return the last", async ({ cashiers, playwright }) => {
	test.setTimeout(600_000);
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	let a: Actor | undefined;
	try {
		a = await cashiers.login(RACE_CASHIER);
		a.page.setDefaultTimeout(30_000);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift");
		const { customer, invoice } = await makeSale(admin, a, shift.name, f, "e");
		data.invoice = invoice;
		f.note(`fixture: ${invoice} sold ${SOLD} units to ${customer}`);
		// Role probe: can a plain cashier find this invoice through the Sales Return search?
		{
			const plain = await loginApiSeat(playwright, FIRST_BURST_CASHIER);
			const res = await callAs(plain.actor, "pospire.pospire.api.posapp.search_invoices_for_return", { invoice_name: invoice, company: COMPANY, customer });
			const found = Array.isArray(res.json?.message) ? res.json.message.length : -1;
			data.plainCashierReturnSearch = { status: res.status, found };
			f.note(`role check: a plain cashier (${plain.email}) searching the Sales Return list for ${invoice} gets HTTP ${res.status}, ${found} invoice(s)${res.status === 200 ? "" : " (" + errorText(res) + ")"}`);
			await plain.dispose();
		}
		// The screen loads its customer list when the page loads: reload so the new customer is in it.
		await a.page.reload();
		await gotoPos(a.page);
		const stock0 = await binQty(admin, ITEMS.stock, WAREHOUSES.A);

		// ---- return 1 of 2 ----
		const first = await loadReturn(a, customer, invoice, 2);
		data.first = first;
		f.note(`first return: invoice row "${first.rowText.slice(0, 120)}"; quantity field after typing 2 = "${first.fieldAfter}"`);
		f.expectSafe(first.fieldAfter === "2", `typing 2 for a first return left "${first.fieldAfter}" in the field`);
		await readyToPay(a);
		const out1 = await attemptSubmit(a.page, 45_000);
		f.check(out1.ok, `the first return was not accepted: ${out1.message}`);
		let r = await returnsOf(admin, invoice);
		f.note(`after the first return: ${JSON.stringify(r)}`);
		f.expectSafe(r.qty === 2, `after returning 2 the server shows ${r.qty} returned`);

		// ---- try to return 2 more (only 1 remains) ----
		const second = await loadReturn(a, customer, invoice, 2);
		data.second = second;
		f.note(`second attempt for 2 (1 remains): row "${second.rowText.slice(0, 120)}"; available "${second.available}"; field after typing 2 = "${second.fieldAfter}"; messages ${JSON.stringify(second.toasts)}`);
		const asked = Number(second.fieldAfter);
		f.expectSafe(asked <= 1, `the screen allowed a return of ${asked} when only 1 unit remained`);
		await readyToPay(a);
		const out2 = await attemptSubmit(a.page, 45_000, out1.invoice ? [out1.invoice] : []);
		data.secondOutcome = out2;
		r = await returnsOf(admin, invoice);
		f.note(`after the second attempt: ${JSON.stringify(r)}; screen outcome ok=${out2.ok} ${out2.message}`);
		f.expectSafe(r.qty <= SOLD, `${r.qty} units are recorded as returned for an invoice of ${SOLD}`);

		// ---- the invoice is now fully returned (or must be after the last unit) ----
		if (r.qty < SOLD) {
			const last = await loadReturn(a, customer, invoice, 1);
			await readyToPay(a);
			const out3 = await attemptSubmit(a.page, 45_000, [out1.invoice, out2.invoice].filter(Boolean) as string[]);
			f.check(out3.ok, `the last unit could not be returned: ${out3.message}`);
			f.note(`last unit: field "${last.fieldAfter}"`);
			r = await returnsOf(admin, invoice);
		}
		f.expectSafe(r.qty === SOLD, `the server shows ${r.qty} of ${SOLD} returned after returning everything`);

		await selectCustomer(a.page, customer); // the cart goes back to the default customer after each sale
		await a.page.getByRole("button", { name: "Sales Return", exact: true }).click();
		await a.page.getByLabel("Invoice ID").first().fill(invoice);
		await a.page.getByRole("button", { name: "Search", exact: true }).click();
		const row = a.page.getByRole("row", { name: new RegExp(invoice) }).first();
		await expect(row).toBeVisible({ timeout: 30_000 });
		const text = ((await row.textContent()) ?? "").replace(/\s+/g, " ");
		data.fullyReturnedRow = text;
		f.expectSafe(/Fully Returned/i.test(text), `the invoice is not shown as fully returned after ${r.qty} of ${SOLD} were returned: "${text.slice(0, 140)}"`);
		await a.page.getByRole("button", { name: "Close", exact: true }).click();

		const stock1 = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
		f.note(`stock moved by ${stock1 - stock0} for ${r.qty} returned`);
		f.expectSafe(stock1 - stock0 === r.qty, `stock moved by ${stock1 - stock0} but ${r.qty} units were returned`);
		completed = true;
	} finally {
		if (a) {
			await a.page.keyboard.press("Escape").catch(() => {});
			await closeLeftoverShiftsDetailed(admin, a).then((c) => c.stuck.length && f.note(`could not close the shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			a.forgetShift();
		}
		await finish("CON-08e", "one cashier uses the Sales Return screen: sell 3, return 2, try 2 more with 1 left, return the last", f, data, completed);
		await admin.dispose();
	}
	assertClean(f);
});

test("CON-08f — two cashiers return the same 3 units through the screen at the same moment", async ({ cashiers, playwright }) => {
	test.setTimeout(600_000);
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	const actors: Actor[] = [];
	// The second screen needs a cashier who may use the Sales Return screen: cashier 54 gets Accounts Manager for this test only.
	const SECOND = RACE_CASHIER - 1;
	let granted = false;
	try {
		granted = await grantRole(admin, cashierEmail(SECOND), EXTRA_ROLE);
		f.note(`cashier ${SECOND} ${granted ? `was given ${EXTRA_ROLE} for this test (removed afterwards)` : `already held ${EXTRA_ROLE}`}`);
		for (const n of [RACE_CASHIER, SECOND]) actors.push(await cashiers.login(n));
		for (const x of actors) x.page.setDefaultTimeout(30_000);
		for (const x of actors) {
			const left = await closeLeftoverShifts(admin, x);
			if (left.length) f.note(`closed leftover shift(s) for ${x.email}: ${left.join(", ")}`);
		}
		await Promise.all(actors.map((x) => x.openShift(PROFILES.P1, "0")));
		const shifts: string[] = [];
		for (const x of actors) {
			const [s] = await listOpeningShifts(admin, { user: x.email, status: "Open" });
			f.check(Boolean(s), `${x.email} has no open shift`);
			shifts.push(s.name);
		}
		const { customer, invoice } = await makeSale(admin, actors[0], shifts[0], f, "f");
		data.invoice = invoice;
		f.note(`fixture: ${invoice} sold ${SOLD} units to ${customer}`);
		for (const x of actors) {
			await x.page.reload();
			await gotoPos(x.page);
		}
		const stock0 = await binQty(admin, ITEMS.stock, WAREHOUSES.A);

		// Both screens get to "Submit" for a return of all 3, one after the other.
		for (const x of actors) {
			const got = await loadReturn(x, customer, invoice, SOLD);
			f.check(got.fieldAfter === String(SOLD), `${x.email}: could not enter a return of ${SOLD} (field "${got.fieldAfter}")`);
			await readyToPay(x);
		}

		// Release both Submit presses together at the network layer.
		const gate = await releaseTogether(actors.map((x) => x.page), /posapp\.submit_invoice/);
		const outcomes: SubmitOutcome[] = await Promise.all(actors.map((x) => attemptSubmit(x.page, 60_000)));
		const overlap = gate.overlapMs();
		data.overlapMs = Math.round(overlap);
		data.outcomes = outcomes.map((o) => ({ ok: o.ok, invoice: o.invoice, message: o.message, statuses: o.statuses }));
		f.note(`two simultaneous returns of ${SOLD}: ${JSON.stringify(data.outcomes)}; overlap ${overlap.toFixed(0)} ms`);
		f.check(overlap > 0, `the two submissions did not overlap (${overlap.toFixed(0)} ms)`);
		f.expectSafe(outcomes.every((o) => o.statuses.every((s) => s < 500)), `uncontrolled server error (5xx): ${JSON.stringify(outcomes.map((o) => o.statuses))}`);
		f.check(outcomes.some((o) => o.ok), "neither return was accepted, so nothing was tested");

		const r = await returnsOf(admin, invoice);
		const stock1 = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
		data.returns = r;
		f.note(`server: ${JSON.stringify(r)}; stock moved by ${stock1 - stock0}`);
		f.expectSafe(r.qty <= SOLD, `${r.qty} units were returned against an invoice of ${SOLD}: the same units were returned twice`);
		f.expectSafe(stock1 - stock0 <= SOLD, `stock rose by ${stock1 - stock0} for an invoice of ${SOLD}`);
		completed = true;
	} finally {
		for (const x of actors) {
			await x.page.keyboard.press("Escape").catch(() => {});
			await x.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await closeLeftoverShiftsDetailed(admin, x).then((c) => c.stuck.length && f.note(`could not close ${x.email}'s shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			x.forgetShift();
		}
		if (granted) {
			await revokeRole(admin, cashierEmail(SECOND), EXTRA_ROLE).then(() => f.note(`removed ${EXTRA_ROLE} from cashier ${SECOND} again`)).catch((e) => f.note(`COULD NOT REMOVE ${EXTRA_ROLE} from cashier ${SECOND}: ${e}`));
		}
		await finish("CON-08f", "two cashiers load the same invoice for a full return through the screen and press Submit together", f, data, completed);
		await admin.dispose();
	}
	assertClean(f);
});
