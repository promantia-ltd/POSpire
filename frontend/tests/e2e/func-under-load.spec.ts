/**
 * FUNC-01 (P0): the smoke journeys must still be correct while the store is busy.
 *
 * One cashier (1) works through the screen on PERF-P1 while LOAD_SEATS other
 * cashiers (6..) sell continuously in the background (headless API sessions, each on
 * their own shift, the same profile and warehouse). Every journey step is checked
 * against what the SERVER ended up with, not only against what the screen showed:
 *
 *   1. look up an existing customer           (SMK-004)
 *   2. create a new customer                  (SMK-005)
 *   3. cash sale to that customer, qty 3      (SMK-006)  total, customer, shift, owner, payment
 *   4. item discount 10 % on a qty-2 line               total after discount
 *   5. split payment, Cash + Credit Card                payment rows add up to the total
 *   6. hold a draft, clear the cart, resume it, pay     the SAME document is submitted, no duplicate
 *   7. print last invoice (reprint)                     the print view opens for the right invoice
 *   8. sales return of one unit of the step-3 sale (SMK-007)  link, customer, quantity, stock
 *   9. close the shift (SMK-008)                        every sale of the shift is in the closing
 *
 * Approvals: PERF-P1 has the approval workflow switched off, so approvals are NOT
 * exercised here (recorded as not tested, not as passed).
 * A step the screen cannot complete is recorded with the error and on-screen message,
 * then judged: a step that fails while the background load runs is a defect candidate
 * (the same journey passes with no load in the older functional suite).
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, RACE_CASHIER, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { callAs, errorText } from "./helpers/as-user";
import { type ApiSeat, loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { ensureStock } from "./helpers/admin-fixtures";
import { binQty, getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { RUN_ID } from "./helpers/manifest";
import { attemptSubmit, cartRow, closeShift, createCustomer, selectCustomer, prepareCashSale, addItem } from "./helpers/pos-ui";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";

// The journey runs as RACE_CASHIER (Accounts Manager): the plain cashier roles cannot list drafts or close with drafts
// present (recorded separately below), and that role gap would hide everything after it.
const JOURNEY_CASHIER = Number(process.env.FUNC_JOURNEY_CASHIER ?? RACE_CASHIER);
const LOAD_SEATS = Number(process.env.FUNC_LOAD_SEATS ?? 10);
const RATE = 1000;
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(JOURNEY_CASHIER) || !cashierPassword(FIRST_BURST_CASHIER), "burst/journey cashier passwords not set in .env.test");
});

const log = (m: string) => console.log(`[FUNC-01 ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const qtyOf = (d: Record<string, any> | null) => sum((d?.items ?? []).map((i: any) => Number(i.qty)));

test("FUNC-01 — smoke journeys while ten other cashiers sell", async ({ cashiers, playwright }) => {
	test.setTimeout(900_000);
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = { loadSeats: LOAD_SEATS };
	const steps: { step: string; ok: boolean; detail?: string }[] = [];
	data.steps = steps;
	let completed = false;
	let a: Actor | undefined;
	const seats: ApiSeat[] = [];
	let running = false;
	const load = { sales: 0, refused: 0, serverErrors: 0, statuses: {} as Record<string, number>, latencies: [] as number[] };
	let loops: Promise<void>[] = [];

	try {
		await ensureStock(admin, { company: COMPANY, item: ITEMS.stock, warehouse: WAREHOUSES.A, qty: 1500, rate: 600 });
		a = await cashiers.login(JOURNEY_CASHIER);
		const strayMine = await getList<{ name: string }>(admin, "Sales Invoice", { owner: a.email, docstatus: 0 }, ["name"], 200);
		for (const d of strayMine) await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: d.name } });
		if (strayMine.length) f.note(`removed ${strayMine.length} leftover draft(s) of the journey cashier from an earlier run`);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
		const existingCustomer = String(profile?.customer ?? "");
		const newCustomer = `PERF FUNC01 ${RUN_ID}`;

		// ---------------- background load: LOAD_SEATS cashiers selling in a loop ----------------
		const numbers = Array.from({ length: LOAD_SEATS }, (_, i) => FIRST_BURST_CASHIER + i);
		seats.push(...(await Promise.all(numbers.map((n) => loginApiSeat(playwright, n)))));
		for (const s of seats) {
			const stray = await getList<{ name: string }>(admin, "Sales Invoice", { owner: s.email, docstatus: 0 }, ["name"], 500);
			for (const d of stray) await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: d.name } });
		}
		const stuck = (await Promise.all(seats.map((s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false })))).flatMap((r) => r.stuck);
		f.check(stuck.length === 0, `could not clear leftover shifts of the load cashiers: ${JSON.stringify(stuck)}`);
		const loadShifts = new Map<string, string>();
		for (const s of seats) {
			const r = (await openShiftApi(s, COMPANY, PROFILES.P1)).result;
			const name = r.json?.message?.pos_opening_shift?.name as string | undefined;
			f.check(Boolean(name), `${s.email}: could not open a shift (HTTP ${r.status})`);
			if (name) loadShifts.set(s.email, name);
		}
		// Probe: can a plain cashier list their own drafts ("Load Draft sales")?
		{
			const probe = await callAs(seats[0].actor, "pospire.pospire.api.posapp.get_draft_invoices", { pos_opening_shift: loadShifts.get(seats[0].email) });
			data.cashierDraftListStatus = probe.status;
			f.note(`role check: a plain cashier (${seats[0].email}) calling get_draft_invoices on their own shift gets HTTP ${probe.status}${probe.status === 200 ? "" : " (" + errorText(probe) + ")"}: Load Draft sales ${probe.status === 200 ? "works" : "does not work for this role"}`);
		}
		const loadSold = new Map<string, number>();
		log(`${seats.length} load cashiers have shifts; starting the load`);
		running = true;
		loops = seats.map(async (s) => {
			const shift = loadShifts.get(s.email);
			if (!shift) return;
			while (running) {
				const t0 = performance.now();
				try {
					const d = await createDraft(s.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }));
					if (!d.doc) {
						load.refused += 1;
						load.statuses[String(d.res.status)] = (load.statuses[String(d.res.status)] ?? 0) + 1;
						if (d.res.status >= 500) load.serverErrors += 1;
						await new Promise((r) => setTimeout(r, 1000));
						continue;
					}
					const r = await submitDraft(s.actor, d.doc, { cashAmount: RATE, offlineId: randomUUID() });
					load.latencies.push(performance.now() - t0);
					load.statuses[String(r.status)] = (load.statuses[String(r.status)] ?? 0) + 1;
					if (r.status === 200) {
						load.sales += 1;
						loadSold.set(s.email, (loadSold.get(s.email) ?? 0) + 1);
					} else {
						load.refused += 1;
						if (r.status >= 500) load.serverErrors += 1;
					}
				} catch {
					load.refused += 1;
				}
				await new Promise((r) => setTimeout(r, 400));
			}
		});

		// ---------------- the journey (cashier 1, on screen) ----------------
		log("load running; opening the journey shift");
		await a.page.reload();
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift for the journey cashier");
		const page = a.page;
		page.setDefaultTimeout(30_000);
		const soldInvoices: string[] = [];
		const messages = async () => (await page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
		const saleLatencies: number[] = [];

		const step = async (name: string, fn: () => Promise<void>) => {
			log(`step: ${name} (load so far: ${load.sales} sales, ${load.refused} refused)`);
			try {
				let timer: NodeJS.Timeout | undefined;
				const watchdog = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`step exceeded 150 s (watchdog)`)), 150_000)));
				await Promise.race([fn(), watchdog]).finally(() => clearTimeout(timer));
				steps.push({ step: name, ok: true });
			} catch (e) {
				const detail = `${String(e).split("\n")[0]} | on screen: ${JSON.stringify(await messages())}`;
				steps.push({ step: name, ok: false, detail });
				log(`FAILED ${name}: ${detail}`);
				await page.screenshot({ path: `perf-results/func01-${name.replace(/\W+/g, "_").slice(0, 30)}.png` }).catch(() => {});
				f.expectSafe(false, `journey step "${name}" failed under load: ${detail}`);
				// get the screen back to a usable state for the next step (dialogs here ignore Escape)
				await page.keyboard.press("Escape").catch(() => {});
				const close = page.getByRole("button", { name: "Close", exact: true });
				if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5_000 }).catch(() => {});
			}
		};
		const pay = async (label: string) => {
			const t0 = performance.now();
			const out = await attemptSubmit(page, 45_000, soldInvoices);
			saleLatencies.push(Math.round(performance.now() - t0));
			f.expectSafe(out.ok, `${label}: the sale was not accepted: ${out.message} (HTTP ${JSON.stringify(out.statuses)})`);
			if (!out.ok || !out.invoice) throw new Error(`${label}: not accepted: ${out.message}`);
			soldInvoices.push(out.invoice);
			return out.invoice;
		};
		const server = (name: string) => getDoc<Record<string, any>>(admin, "Sales Invoice", name);

		await step("1 look up an existing customer", async () => {
			const field = page.getByRole("textbox", { name: /Customer/ });
			await field.click();
			await field.fill(existingCustomer.slice(0, Math.max(3, Math.min(6, existingCustomer.length))));
			await expect(page.getByRole("listbox").getByText(existingCustomer, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await page.getByRole("listbox").getByText(existingCustomer, { exact: false }).first().click();
		});

		await step("2 create a new customer", async () => {
			const baseCust = await getDoc<Record<string, any>>(admin, "Customer", existingCustomer);
			await createCustomer(page, newCustomer, { group: baseCust?.customer_group, territory: baseCust?.territory });
			const field = page.getByRole("textbox", { name: /Customer/ });
			await field.click();
			await field.fill(newCustomer);
			await page.getByRole("listbox").getByText(newCustomer).first().click();
			await expect(field).toHaveValue(new RegExp(newCustomer));
			const found = await getList(admin, "Customer", { customer_name: newCustomer }, ["name"]);
			f.expectSafe(found.length === 1, `${found.length} customers named "${newCustomer}" after creating one`);
		});

		let sale3 = "";
		await step("3 cash sale, qty 3, to the new customer", async () => {
			await prepareCashSale(page, ITEMS.stock, 3);
			sale3 = await pay("cash sale");
			const d = await server(sale3);
			f.expectSafe(d?.docstatus === 1, `${sale3} docstatus ${d?.docstatus}`);
			f.expectSafe(qtyOf(d) === 3, `${sale3} quantity ${qtyOf(d)}, expected 3`);
			f.expectSafe(Number(d?.grand_total) === 3 * RATE, `${sale3} grand total ${d?.grand_total}, expected ${3 * RATE}`);
			f.expectSafe(String(d?.customer).includes("FUNC01"), `${sale3} customer "${d?.customer}", expected the new customer`);
			f.expectSafe(d?.posa_pos_opening_shift === shift.name, `${sale3} is on shift ${d?.posa_pos_opening_shift}, not ${shift.name}`);
			f.expectSafe(d?.owner === a!.email, `${sale3} owned by ${d?.owner}`);
			f.expectSafe(d?.pos_profile === PROFILES.P1 && d?.set_warehouse !== undefined ? true : d?.pos_profile === PROFILES.P1, `${sale3} profile ${d?.pos_profile}`);
		});

		await step("4 item discount 10 %", async () => {
			await addItem(page, ITEMS.stock);
			await addItem(page, ITEMS.stock); // qty 2
			const row = cartRow(page, ITEMS.stock);
			await row.locator("button:has(.mdi-chevron-down)").click();
			const pct = page.locator(".invoice-cart-section").getByLabel("Discount Percentage");
			await pct.click();
			await pct.fill("10");
			await pct.blur();
			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const inv = await pay("discounted sale");
			const d = await server(inv);
			f.note(`discounted sale ${inv}: qty ${qtyOf(d)}, grand_total ${d?.grand_total}, discount_amount ${d?.discount_amount}`);
			f.expectSafe(qtyOf(d) === 2, `${inv} quantity ${qtyOf(d)}, expected 2`);
			f.expectSafe(Math.abs(Number(d?.grand_total) - 2 * RATE * 0.9) < 0.01, `${inv} grand total ${d?.grand_total}, expected ${2 * RATE * 0.9} after 10% off`);
		});

		await step("5 split payment, Cash + Credit Card", async () => {
			await addItem(page, ITEMS.stock);
			await addItem(page, ITEMS.stock);
			await page.locator(".pay-button").click();
			const card = page.getByLabel("Credit Card", { exact: true });
			const cash = page.getByLabel("Cash", { exact: true });
			const tPay = Date.now();
			await expect(cash.or(card).first()).toBeVisible({ timeout: 30_000 });
			data.paymentDialogOpenMs = Date.now() - tPay;
			// Whichever mode is pre-filled holds the total.
			const cashV = Number((await cash.inputValue()) || 0);
			const cardV = Number((await card.inputValue()) || 0);
			const total = cashV || cardV;
			f.check(total > 0, "payment dialog opened with no amount");
			const half = Math.floor(total / 2);
			if (cardV >= cashV) {
				await card.fill(String(total - half));
				await cash.click();
				await cash.fill(String(half));
			} else {
				await cash.fill(String(total - half));
				await card.click();
				await card.fill(String(half));
			}
			const inv = await pay("split-payment sale");
			const d = await server(inv);
			const pays = (d?.payments ?? []).filter((p: any) => Number(p.amount) !== 0).map((p: any) => ({ mode: p.mode_of_payment, amount: Number(p.amount) }));
			f.note(`split sale ${inv}: payments ${JSON.stringify(pays)}`);
			f.expectSafe(pays.length === 2, `${inv} has ${pays.length} payment line(s), expected 2 (Cash and Credit Card)`);
			f.expectSafe(Math.abs(sum(pays.map((p: any) => p.amount)) - Number(d?.grand_total)) < 0.01, `${inv} payments total ${sum(pays.map((p: any) => p.amount))} but grand total ${d?.grand_total}`);
		});

		await step("6 hold a draft, clear, resume, pay", async () => {
			await addItem(page, ITEMS.stock);
			await addItem(page, ITEMS.stock);
			await page.getByRole("button", { name: "Save and Clear", exact: true }).click();
			await expect(cartRow(page, ITEMS.stock)).toHaveCount(0, { timeout: 15_000 });
			const drafts = (await invoicesOnShift(admin, shift.name)).filter((x) => x.docstatus === 0);
			f.expectSafe(drafts.length === 1, `${drafts.length} drafts on the shift after "Save and Clear" (expected 1)`);
			const held = drafts[0]?.name;
			await page.getByRole("button", { name: "Load Draft sales", exact: true }).click();
			await expect(page.getByText("Load Sales Invoice", { exact: true })).toBeVisible();
			await page.screenshot({ path: "perf-results/func01-drafts-dialog.png" }).catch(() => {});
			const row = page.getByRole("row", { name: new RegExp(held ?? "SINV") }).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await row.getByRole("checkbox").click();
			await page.getByRole("button", { name: "Load Sale", exact: true }).click();
			await expect(cartRow(page, ITEMS.stock)).toBeVisible();
			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const inv = await pay("resumed draft");
			f.expectSafe(inv === held, `the resumed draft was submitted as ${inv}, not the held document ${held} (a duplicate was created)`);
			const left2 = (await invoicesOnShift(admin, shift.name)).filter((x) => x.docstatus === 0);
			f.expectSafe(left2.length === 0, `${left2.length} draft(s) remain after resuming and paying`);
		});

		await step("7 print last invoice (reprint)", async () => {
			const last = soldInvoices[soldInvoices.length - 1];
			// PERF-P1 has a hardware printer configured, so the app builds the receipt for the printer
			// (hardware_manager.generate_print_xml) instead of opening a browser print window. Accept either path.
			const xmlReq = page.waitForRequest((r) => /hardware_manager\.generate_print_xml/.test(r.url()), { timeout: 20_000 }).then((r) => ({ kind: "printer" as const, body: r.postData() ?? "" }));
			const popupP = page.waitForEvent("popup", { timeout: 20_000 }).then((p) => ({ kind: "window" as const, body: p.url() }));
			await page.locator(".menu-button").click();
			await page.getByText("Print Last Invoice", { exact: true }).click();
			const got = await Promise.any([xmlReq, popupP]).catch(() => null);
			f.expectSafe(got !== null, `"Print Last Invoice" did nothing: no printer request and no print window within 20 s`);
			if (!got) return;
			data.reprintPath = got.kind;
			f.note(`reprint went through the ${got.kind === "printer" ? "hardware printer request" : "browser print window"}`);
			f.expectSafe(got.body.includes(last), `the reprint request refers to "${got.body.slice(0, 200)}", not the last invoice ${last}`);
			// What a printer/print window would render: the server-side print view of that invoice.
			const pv = await admin.get(`/api/method/frappe.www.printview.get_html_and_style?doc=Sales%20Invoice&name=${last}&print_format=${encodeURIComponent(String(profile?.print_format ?? "Standard"))}`);
			const html = JSON.stringify((await pv.json().catch(() => ({})))?.message ?? "") + (pv.ok() ? "" : ` HTTP ${pv.status()}`);
			data.printViewChars = html.length;
			f.expectSafe(html.includes(last), `the print view does not contain the invoice number ${last}`);
		});

		await step("8 sales return of 1 unit of the step-3 sale", async () => {
			const stockBefore = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
			// The Returns dialog lists only the invoices of the customer currently selected in the cart.
			await selectCustomer(page, newCustomer);
			await page.getByRole("button", { name: "Sales Return", exact: true }).click();
			await page.getByLabel("Invoice ID").first().fill(sale3);
			await page.getByRole("button", { name: "Search", exact: true }).click();
			const row = page.getByRole("row", { name: new RegExp(sale3) }).first();
			await expect(row).toBeVisible({ timeout: 20_000 });
			await row.getByRole("checkbox").click();
			await page.getByRole("button", { name: "Select Items", exact: true }).click();
			await expect(page.getByText("Select Items to Return")).toBeVisible();
			const dlg = page.locator(".v-overlay--active").last();
			// The dialog pre-selects every returnable line at its full quantity; only toggle if it is not selected.
			const box = dlg.getByRole("checkbox").first();
			if (!(await box.isChecked())) await box.click();
			const qtyField = page.locator(".return-qty-input input").first();
			await qtyField.fill("1");
			await qtyField.blur();
			const dialogTotal = (await dlg.getByText(/Total return amount/).first().textContent().catch(() => "")) ?? "";
			const dialogQty = await qtyField.inputValue().catch(() => "");
			data.returnDialog = { qtyField: dialogQty, totalText: dialogTotal.trim() };
			f.note(`return dialog after entering 1: quantity field "${dialogQty}", ${dialogTotal.trim()}`);
			f.check(dialogQty === "1", `the return quantity field shows "${dialogQty}" after typing 1 (test could not set the quantity)`);
			await page.getByRole("button", { name: "Load Return", exact: true }).click();
			await expect(cartRow(page, ITEMS.stock)).toBeVisible({ timeout: 15_000 });
			await page.locator(".pay-button").click();
			const cashBtn = page.getByRole("button", { name: "Cash", exact: true });
			if (await cashBtn.isVisible().catch(() => false)) await cashBtn.click();
			const inv = await pay("return");
			const d = await server(inv);
			f.note(`return ${inv}: return_against ${d?.return_against}, qty ${qtyOf(d)}, grand_total ${d?.grand_total}, customer ${d?.customer}`);
			f.expectSafe(d?.return_against === sale3, `the return links to "${d?.return_against}", not ${sale3}`);
			f.expectSafe(qtyOf(d) === -1, `the return quantity is ${qtyOf(d)}, expected -1`);
			f.expectSafe(Number(d?.grand_total) === -RATE, `the return total is ${d?.grand_total}, expected ${-RATE}`);
			f.expectSafe(String(d?.customer).includes("FUNC01"), `the return is on customer "${d?.customer}"`);
			const stockAfter = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
			f.note(`stock moved by ${stockAfter - stockBefore} during the return step (other cashiers are selling, so not asserted exactly)`);
		});

		// ---------------- stop the load, then close ----------------
		running = false;
		await Promise.all(loops);
		data.load = { sales: load.sales, refused: load.refused, serverErrors: load.serverErrors, statuses: load.statuses, p50_ms: Math.round([...load.latencies].sort((x, y) => x - y)[Math.floor(load.latencies.length / 2)] ?? 0), p95_ms: Math.round([...load.latencies].sort((x, y) => x - y)[Math.max(0, Math.ceil(load.latencies.length * 0.95) - 1)] ?? 0) };
		data.foregroundSaleMs = saleLatencies;
		f.note(`background load: ${load.sales} sales accepted, ${load.refused} refused, ${load.serverErrors} server error(s); foreground sales took ${JSON.stringify(saleLatencies)} ms (click Submit to confirmation)`);
		f.expectSafe(load.serverErrors === 0, `${load.serverErrors} background request(s) failed with a 5xx while the journey ran`);
		f.expectSafe(load.sales > 0, "the background load made no sales: the journey ran on an idle server, so this proves nothing about load");
		for (const s of seats) {
			const sold = loadSold.get(s.email) ?? 0;
			const got = (await invoicesOnShift(admin, loadShifts.get(s.email) ?? "")).filter((x) => x.docstatus === 1 && x.owner === s.email).length;
			f.expectSafe(got === sold, `${s.email}: ${sold} sales were accepted but ${got} submitted invoices exist on their shift`);
		}

		await step("9 close the shift", async () => {
			await closeShift(page);
			const closings = await getList<{ name: string }>(admin, "POS Closing Shift", { pos_opening_shift: shift.name, docstatus: 1 }, ["name"]);
			f.expectSafe(closings.length === 1, `${closings.length} closings for the journey shift (expected 1)`);
			if (closings[0]) {
				const c = await getDoc<Record<string, any>>(admin, "POS Closing Shift", closings[0].name);
				const listed = new Set((c?.pos_transactions ?? []).map((t: any) => t.sales_invoice));
				const missing = soldInvoices.filter((n) => !listed.has(n));
				f.note(`closing ${closings[0].name} lists ${listed.size} invoice(s); journey made ${soldInvoices.length}`);
				f.expectSafe(missing.length === 0, `the closing omits the journey's invoice(s): ${missing.join(", ")}`);
			}
		});
		a.forgetShift();
		data.notTested = ["approvals (workflow is off on PERF-P1)", "physical printer output"];
		completed = true;
	} finally {
		running = false;
		await Promise.all(loops).catch(() => {});
		for (const s of seats) {
			// A load request cut off mid-sale leaves a draft; the load cashiers cannot delete it themselves.
			const stray = await getList<{ name: string }>(admin, "Sales Invoice", { owner: s.email, docstatus: 0 }, ["name"], 500).catch(() => []);
			for (const d of stray) await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: d.name } }).catch(() => {});
			await closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close ${s.email}'s shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			await s.dispose().catch(() => {});
		}
		if (a) {
			const mine = await getList<{ name: string }>(admin, "Sales Invoice", { owner: a.email, docstatus: 0 }, ["name"], 200).catch(() => []);
			for (const d of mine) await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: d.name } }).catch(() => {});
			await closeLeftoverShiftsDetailed(admin, a).catch(() => {});
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id: "FUNC-01", arrangement: `cashier 1 runs the smoke journeys on screen (customer, sale, discount, split payment, hold/resume, reprint, return, close) while ${LOAD_SEATS} other cashiers sell continuously on the same profile`, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
});
