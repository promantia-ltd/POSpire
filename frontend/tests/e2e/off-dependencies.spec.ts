/**
 * OFF-04 (P0): a chain of offline actions that depend on each other must sync in
 * dependency order and end up correctly linked.
 *
 * Device A (cashier 1) is taken offline BEFORE any shift is open and then:
 *   1. opens shift 1 offline
 *   2. creates a customer offline
 *   3. sells to that customer (queued; depends on the shift and the customer)
 *   4. tries a Sales Return (the app implements returns as online-only: this must be
 *      refused clearly, not silently dropped)
 *   5. closes shift 1 offline (queued; depends on every sale of that shift)
 *   6. opens shift 2 offline and makes one more sale
 * while device B (cashier 2) queues its own sales on its own shift. Both reconnect at
 * the same moment, so B's sync interleaves with A's chain.
 *
 * Expected (ticket): parents resolve before dependants; every invoice links to the
 * correct shift, customer and original invoice; closing never silently omits a
 * dependent sale. After the sync, a return against the offline-created sale is made
 * online (the permitted path) and must link to the right original invoice, customer
 * and shift.
 *
 * A step that cannot be performed offline is recorded with what the screen said, so
 * "unsupported" is evidence and not a crash; whether it is a safe restriction or a
 * defect is judged from that evidence, not assumed.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { errorText } from "./helpers/as-user";
import { binQty, getDoc, getList, newAdminContext } from "./helpers/backend";
import { Barrier } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { Manifest, RUN_ID, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { outboxRows, waitForOutboxDrain } from "./helpers/outbox";
import { closeShift, createCustomer, fillOpeningDialog, gotoPos, prepareCashSale } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1) || !cashierPassword(2), "cashier 01/02 passwords not set in .env.test");
});

test("OFF-04 — offline shift, customer, sale, return attempt, close, next shift; synced with another device", async ({ cashiers, playwright }) => {
	test.setTimeout(900_000);
	const admin = await newAdminContext(playwright);
	const manifest = new Manifest();
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	const customerName = `PERF OFF04 ${RUN_ID}`;
	const steps: { step: string; ok: boolean; detail?: string }[] = [];
	data.steps = steps;

	try {
		const a = await cashiers.login(1);
		const b = await cashiers.login(2);
		for (const x of [a, b]) {
			const left = await closeLeftoverShifts(admin, x);
			if (left.length) f.note(`closed leftover shift(s) for ${x.email}: ${left.join(", ")}`);
		}

		// The app only opens a shift offline on a device that has had a recent ONLINE session,
		// so A does one ordinary online open + close first, then reloads to the opening dialog.
		await a.openShift(PROFILES.P1, "0");
		await a.closeShift();
		await a.page.reload();
		await gotoPos(a.page);
		await b.openShift(PROFILES.P1, "0");
		const [bShift] = await getList<{ name: string }>(admin, "POS Opening Shift", { user: b.email, status: "Open", docstatus: 1 }, ["name"]);
		f.check(Boolean(bShift), "device B has no open shift");
		const before = await snapshotBins(admin, KEYS);
		const shiftNamesBefore = new Set((await getList<{ name: string }>(admin, "POS Opening Shift", { user: a.email, docstatus: 1 }, ["name"], 5000)).map((x) => x.name));

		const messages = async (page: typeof a.page) =>
			(await page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
		let chain = true;
		const step = async (name: string, fn: () => Promise<void>, { breaksChain = true } = {}) => {
			if (!chain) {
				steps.push({ step: name, ok: false, detail: "skipped: an earlier step failed" });
				return false;
			}
			try {
				await fn();
				steps.push({ step: name, ok: true });
				return true;
			} catch (e) {
				const detail = `${String(e).split("\n")[0]} | on screen: ${JSON.stringify(await messages(a.page))}`;
				steps.push({ step: name, ok: false, detail });
				f.check(false, `step "${name}" could not be performed offline: ${detail}`);
				if (breaksChain) chain = false;
				return false;
			}
		};
		const queueTypes = async () => ((await outboxRows(a.page)) ?? []).map((r) => r.type);

		// ================= device A goes offline with NO shift open =================
		await a.context.setOffline(true);
		await step("open shift 1 offline", async () => {
			await fillOpeningDialog(a.page, { company: COMPANY, posProfile: PROFILES.P1, openingCash: "0" });
			expect(await queueTypes()).toContain("opening_entry");
		});
		await step("create a customer offline", async () => {
			await createCustomer(a.page, customerName);
			await expect.poll(queueTypes, { timeout: 15_000 }).toContain("customer");
		});
		await step("sell to that customer offline", async () => {
			const field = a.page.getByRole("textbox", { name: /Customer/ });
			steps.push({ step: "(info) customer shown in the cart right after creating it", ok: true, detail: await field.inputValue().catch(() => "") });
			// Creating a customer does not select it; pick it from the (offline) customer list.
			await field.click();
			await field.fill(customerName);
			await a.page.getByRole("listbox").getByText(customerName).first().click();
			const picked = await field.inputValue().catch(() => "");
			steps.push({ step: "(info) customer shown in the cart after picking it", ok: true, detail: picked });
			expect(picked, "the new offline customer could not be selected for the sale").toContain(customerName);
			await prepareCashSale(a.page, ITEMS.stock, 2);
			await a.page.getByRole("button", { name: "Submit", exact: true }).click();
			await expect.poll(queueTypes, { timeout: 20_000 }).toContain("invoice");
		});

		// Returns are online-only in this app; offline it must say so, not fail silently.
		await step(
			"attempt a Sales Return offline",
			async () => {
				const btn = a.page.getByRole("button", { name: "Sales Return", exact: true });
				if (!(await btn.isVisible().catch(() => false))) {
					data.returnButtonVisible = false;
					steps.push({ step: "(info) Sales Return button", ok: true, detail: "not shown on this profile" });
					return;
				}
				data.returnButtonVisible = true;
				await btn.click();
				await a.page.waitForTimeout(2_500);
				const msgs = await messages(a.page);
				const dialogOpen = await a.page.getByText(/Return|Invoice/i).first().isVisible().catch(() => false);
				data.returnAttempt = { messages: msgs, dialogOpen };
				f.note(`Sales Return pressed offline: messages=${JSON.stringify(msgs)}; a dialog is showing=${dialogOpen}`);
				f.expectSafe(msgs.length > 0, "a Sales Return pressed offline gave no message at all (the return is online-only, the cashier is not told)");
				// The dialog is persistent: Escape does nothing, its own Close button dismisses it.
				await a.page.getByRole("button", { name: "Close", exact: true }).click();
				await expect(a.page.getByRole("button", { name: "Close", exact: true })).toBeHidden({ timeout: 10_000 });
			},
			{ breaksChain: false },
		);

		await step("close shift 1 offline", async () => {
			await closeShift(a.page, { offline: true });
			await expect.poll(queueTypes, { timeout: 15_000 }).toContain("closing_entry");
		});
		await step("open shift 2 offline", async () => {
			await fillOpeningDialog(a.page, { company: COMPANY, posProfile: PROFILES.P1, openingCash: "0" });
		});
		await step("sell once in shift 2 offline", async () => {
			await prepareCashSale(a.page, ITEMS.stock, 1);
			await a.page.getByRole("button", { name: "Submit", exact: true }).click();
			await expect.poll(async () => (await queueTypes()).filter((t) => t === "invoice").length, { timeout: 20_000 }).toBe(2);
		});
		const order = await queueTypes();
		data.queueOrderOnA = order;
		f.note(`device A's queue in the order it was created: ${JSON.stringify(order)}`);

		// ================= device B queues its own sales meanwhile =================
		await b.context.setOffline(true);
		const bDepths = await sellOffline(b.page, ITEMS.stock, [1, 2, 3]);
		f.check(bDepths[bDepths.length - 1] >= 3, `device B queued only ${bDepths[bDepths.length - 1] ?? 0}/3 sales`);

		// ================= both reconnect at the same moment =================
		const gate = new Barrier(2);
		const t0 = Date.now();
		await Promise.all(
			[a, b].map(async (d) => {
				await gate.wait();
				await d.context.setOffline(false);
			}),
		);
		const [drainA, drainB] = await Promise.all([waitForOutboxDrain(a.page, 300_000), waitForOutboxDrain(b.page, 300_000)]);
		data.drain = { totalMs: Date.now() - t0, A: { ms: drainA.ms, rows: drainA.rows }, B: { ms: drainB.ms, rows: drainB.rows } };
		f.note(`reconnected together; A drained=${drainA.drained} (${drainA.ms} ms), B drained=${drainB.drained} (${drainB.ms} ms); A's rows=${JSON.stringify(drainA.rows)}`);
		f.check(drainA.drained, "device A's queue did not drain within 300 s");
		f.check(drainB.drained, "device B's queue did not drain within 300 s");
		f.expectSafe(drainA.needsAttention.length === 0, `A's queue ended needing attention: ${JSON.stringify(drainA.needsAttention)}`);
		f.expectSafe(drainB.needsAttention.length === 0, `B's queue ended needing attention: ${JSON.stringify(drainB.needsAttention)}`);
		const aMsgs = await messages(a.page);
		f.note(`messages on A after the sync: ${JSON.stringify(aMsgs)}`);

		// ================= what the server ended up with =================
		await a.page.waitForTimeout(3_000);
		const shiftsOfA = (await getList<{ name: string; status: string; creation: string; pos_closing_shift: string | null }>(
			admin,
			"POS Opening Shift",
			{ user: a.email, docstatus: 1 },
			["name", "status", "creation", "pos_closing_shift"],
			5000,
		))
			.filter((x) => !shiftNamesBefore.has(x.name))
			.sort((x, y) => x.name.localeCompare(y.name));
		data.newShiftsOfA = shiftsOfA;
		f.note(`shifts of A created since the offline phase began: ${JSON.stringify(shiftsOfA)}`);
		f.expectSafe(shiftsOfA.length === 2, `expected 2 shifts opened offline for A, found ${shiftsOfA.length}`);
		const [shift1, shift2] = shiftsOfA;

		const customers = await getList<{ name: string }>(admin, "Customer", { customer_name: customerName }, ["name"]);
		f.note(`customers named "${customerName}": ${JSON.stringify(customers)}`);
		f.expectSafe(customers.length === 1, `${customers.length} customers were created for one offline customer creation (expected 1)`);
		const customer = customers[0]?.name;

		let invoice1: string | undefined;
		if (shift1 && shift2) {
			const on1 = (await invoicesOnShift(admin, shift1.name)).filter((x) => x.docstatus === 1);
			const on2 = (await invoicesOnShift(admin, shift2.name)).filter((x) => x.docstatus === 1);
			f.note(`shift 1 ${shift1.name}: ${on1.length} submitted invoice(s), status ${shift1.status}; shift 2 ${shift2.name}: ${on2.length} submitted invoice(s), status ${shift2.status}`);
			f.expectSafe(on1.length === 1, `${on1.length} submitted invoices on shift 1 (expected the 1 offline sale)`);
			f.expectSafe(on2.length === 1, `${on2.length} submitted invoices on shift 2 (expected 1)`);
			f.expectSafe(shift1.status === "Closed", `shift 1 is "${shift1.status}" after its closing synced (expected Closed)`);
			f.expectSafe(shift2.status === "Open", `shift 2 is "${shift2.status}" (expected Open: it was never closed)`);

			if (on1[0]) {
				invoice1 = on1[0].name;
				const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", invoice1);
				const qty = (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				f.expectSafe(doc?.customer === customer, `the sale made to the new customer is on customer "${doc?.customer}", not "${customer}": the customer link was lost or replaced`);
				f.expectSafe(qty === 2, `shift 1's sale has quantity ${qty} (expected 2)`);
				f.expectSafe(doc?.owner === a.email, `shift 1's sale is owned by ${doc?.owner}`);
				const sale = manifest.add({ txnId: newTxnId("off04a1"), cashier: a.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, customer, items: [{ item_code: ITEMS.stock, qty: 2, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE * 2 }], expectedGrandTotal: RATE * 2, openingShift: shift1.name, invoice: invoice1 });
				manifest.update(sale.txnId, { state: "accepted" });
			}
			if (on2[0]) {
				const sale = manifest.add({ txnId: newTxnId("off04a2"), cashier: a.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE }], expectedGrandTotal: RATE, openingShift: shift2.name, invoice: on2[0].name });
				manifest.update(sale.txnId, { state: "accepted" });
			}

			// The closing of shift 1 must contain the dependent sale.
			const closings = await getList<{ name: string }>(admin, "POS Closing Shift", { pos_opening_shift: shift1.name, docstatus: 1 }, ["name"]);
			f.expectSafe(closings.length === 1, `${closings.length} valid closings for shift 1 (expected 1)`);
			if (closings[0]) {
				const cdoc = await getDoc<Record<string, any>>(admin, "POS Closing Shift", closings[0].name);
				const listed = (cdoc?.pos_transactions ?? []).map((t: any) => t.sales_invoice);
				f.note(`closing ${closings[0].name} of shift 1 lists ${JSON.stringify(listed)}`);
				f.expectSafe(invoice1 !== undefined && listed.includes(invoice1), `the closing of shift 1 does not list its own sale ${invoice1}: a dependent sale was silently omitted`);
			}
		}

		// Device B's independent sales must be intact too.
		const bInv = (await invoicesOnShift(admin, bShift.name)).filter((x) => x.docstatus === 1);
		f.expectSafe(bInv.length === 3, `device B has ${bInv.length} submitted invoices on its shift (expected 3): its sync was disturbed by A's chain`);
		for (const [i, qty] of [1, 2, 3].entries()) {
			const s = manifest.add({ txnId: newTxnId(`off04b${i}`), cashier: b.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, items: [{ item_code: ITEMS.stock, qty, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE * qty }], expectedGrandTotal: RATE * qty, openingShift: bShift.name });
			// matched by quantity below
			const match = [];
			for (const inv of bInv) {
				const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
				if ((d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0) === qty) match.push(inv.name);
			}
			manifest.update(s.txnId, match.length === 1 ? { state: "accepted", invoice: match[0] } : { state: "attempted" });
		}
		await verifyManifest(admin, manifest, before, KEYS, f);

		// ================= the permitted return: online, against the offline-created sale =================
		if (invoice1 && shift2 && customer) {
			await gotoPos(a.page);
			const stockBefore = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
			const draft = await createDraft(
				a,
				buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer, shift: shift2.name, items: [{ item_code: ITEMS.stock, qty: -1, rate: RATE }], returnAgainst: invoice1 }),
			);
			f.check(Boolean(draft.doc?.name), `could not create the return draft: HTTP ${draft.res.status} ${errorText(draft.res)}`);
			if (draft.doc) {
				const res = await submitDraft(a, draft.doc, { cashAmount: -RATE });
				f.check(res.status === 200, `the online return was refused: HTTP ${res.status} ${errorText(res)}`);
				const rname = res.json?.message?.name ?? draft.doc.name;
				const ret = await getDoc<Record<string, any>>(admin, "Sales Invoice", rname);
				f.note(`return ${rname}: return_against=${ret?.return_against}, customer=${ret?.customer}, shift=${ret?.posa_pos_opening_shift}, grand_total=${ret?.grand_total}, docstatus=${ret?.docstatus}`);
				f.expectSafe(ret?.return_against === invoice1, `the return links to "${ret?.return_against}", not the original ${invoice1}`);
				f.expectSafe(ret?.customer === customer, `the return is on customer "${ret?.customer}", not "${customer}"`);
				f.expectSafe(ret?.posa_pos_opening_shift === shift2.name, `the return is on shift "${ret?.posa_pos_opening_shift}", not the open shift ${shift2.name}`);
				f.expectSafe(Number(ret?.grand_total) === -RATE, `the return total is ${ret?.grand_total}, expected ${-RATE}`);
				const stockAfter = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
				f.expectSafe(stockAfter - stockBefore === 1, `stock moved by ${stockAfter - stockBefore} for a 1-unit return (expected +1)`);
			}
		} else {
			f.check(false, "the online return step could not run because the offline chain did not produce shift 2, the customer and the first invoice");
		}

		for (const x of [a, b]) {
			const closed = await closeLeftoverShiftsDetailed(admin, x);
			f.expectSafe(closed.stuck.length === 0, `${x.email}: could not close the shift afterwards: ${JSON.stringify(closed.stuck)}`);
			x.forgetShift();
		}
		completed = true;
	} finally {
		manifest.save();
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({
			id: "OFF-04",
			arrangement: "device A opens a shift, creates a customer, sells, tries a return, closes and opens the next shift, all offline; device B syncs its own sales at the same time; then an online return",
			outcome,
			notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
			data,
		});
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
});
