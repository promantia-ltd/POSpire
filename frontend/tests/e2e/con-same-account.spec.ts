/**
 * CON-03 (P0): ONE account logged in independently on TWO devices, same profile.
 *
 * CON-03a  Both devices open a shift at the same moment.
 *          Records: session policy, whether duplicate opening is allowed, which
 *          shift each device ends up with, and that no sale is silently moved
 *          to a different shift.
 * CON-03b  Resume: device A opens and sells, device B logs in later.
 *          Records: whether B is given A's open shift, that both devices' sales
 *          land on it uncorrupted, that the close counts both, and that a sale
 *          from B AFTER the shift was closed is rejected rather than lost or
 *          misfiled.
 *
 * Each device is a separate browser context with its own server session and its
 * own IndexedDB/localStorage. Facts are recorded to the evidence log; an
 * application defect fails the test, a restriction or block does not.
 */

import { type Page } from "@playwright/test";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { ITEMS, PROFILES, WAREHOUSES, COMPANY, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { callAs, errorText } from "./helpers/as-user";
import { Barrier, releaseTogether } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { completeCashSale, gotoPos, prepareCashSale, submitCashSale } from "./helpers/pos-ui";
import { closeLeftoverShifts } from "./helpers/shifts";
import { compareStock, expectedStockDeltas, reconcile, snapshotBins, stockKeysOf } from "./helpers/reconcile";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

type Admin = Parameters<typeof getList>[0];

/** Remembers the shift name(s) a device was handed by create_opening_voucher. */
function captureOpenedShift(page: Page) {
	const seen: string[] = [];
	page.on("response", async (r) => {
		if (!r.url().includes("create_opening_voucher") || !r.ok()) return;
		try {
			const name = (await r.json())?.message?.pos_opening_shift?.name;
			if (name) seen.push(name);
		} catch {
			/* page closed mid-read */
		}
	});
	return { names: () => [...seen] };
}

const invoicesOf = (admin: Admin, user: string) =>
	getList<{ name: string; docstatus: number; posa_pos_opening_shift: string }>(
		admin,
		"Sales Invoice",
		{ owner: user },
		["name", "docstatus", "posa_pos_opening_shift"],
	);

/** Route reconcile mismatches: a wrong shift is a defect (silent reassignment), anything else a test problem. */
function routeMismatches(f: Findings, report: Awaited<ReturnType<typeof reconcile>>) {
	f.check(report.lost.length === 0, `lost sales: ${report.lost.join(", ")}`);
	f.check(report.duplicates.length === 0, `duplicate invoices: ${JSON.stringify(report.duplicates)}`);
	f.check(report.collisions.length === 0, `colliding invoices: ${JSON.stringify(report.collisions)}`);
	for (const m of report.mismatches) {
		const shiftIssue = m.issues.find((i) => i.field === "opening shift");
		if (shiftIssue) {
			f.expectSafe(false, `silent shift reassignment: ${m.invoice} landed on ${shiftIssue.actual}, device was on ${shiftIssue.expected}`);
		}
		const others = m.issues.filter((i) => i.field !== "opening shift");
		if (others.length) f.check(false, `${m.invoice}: ${JSON.stringify(others)}`);
	}
}

test.describe("CON-03 — one account, two devices", () => {
	test("CON-03a — both devices open a shift simultaneously", async ({ cashiers, playwright }) => {
		test.setTimeout(420_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let forced: Outcome | null = null;
		let completed = false;
		let openCount = 0;

		try {
			const a = await cashiers.login(1);
			const b = await cashiers.login(1);

			const alive = async (x: Actor) => (await x.context.request.get("/api/method/frappe.auth.get_logged_user")).ok();
			const bothAlive = (await alive(a)) && (await alive(b));
			f.note(`session policy: two independent logins of one account both stay valid: ${bothAlive}`);
			if (!bothAlive) {
				forced = "unsupported_safely";
				f.note("the second login invalidated the first session: one account cannot be used on two devices at once");
				return;
			}

			const leftover = await closeLeftoverShifts(admin, a);
			if (leftover.length) f.note(`closed ${leftover.length} leftover shift(s) before starting: ${leftover.join(", ")}`);

			const openedA = captureOpenedShift(a.page);
			const openedB = captureOpenedShift(b.page);
			// Opening is a fast request, so hold both at the network layer and release together.
			const gate = await releaseTogether([a.page, b.page], /create_opening_voucher/);
			const opens = await Promise.allSettled([a, b].map((x) => x.openShift(PROFILES.P1, "0")));
			opens.forEach((o, i) => {
				if (o.status === "rejected") f.check(false, `device ${i ? "B" : "A"} could not open: ${String(o.reason).split("\n")[0]}`);
			});
			const overlap = gate.overlapMs();
			f.check(overlap > 0, `opening requests did not overlap (common overlap ${overlap.toFixed(0)} ms)`);
			f.note(`opening requests were in flight together for ${overlap.toFixed(0)} ms`);

			const open = await listOpeningShifts(admin, { user: a.email, status: "Open" });
			openCount = open.length;
			const nameA = openedA.names()[0];
			const nameB = openedB.names()[0];
			f.note(`open shifts for the one account after both opened: ${open.length} (${open.map((s) => s.name).join(", ")})`);
			f.note(`device A was given ${nameA}; device B was given ${nameB}`);
			f.check(Boolean(nameA && nameB), "could not capture the shift each device was handed");
			if (!nameA || !nameB) return;

			// Each device sells one item; the sale must land on the shift THAT device opened.
			const devices = [
				{ actor: a, shift: nameA },
				{ actor: b, shift: nameB },
			];
			const txns = devices.map((d) =>
				manifest.add({
					txnId: newTxnId("con03a"),
					cashier: a.email,
					company: COMPANY,
					posProfile: PROFILES.P1,
					warehouse: WAREHOUSES.A,
					items: [{ item_code: ITEMS.stock, qty: 1, rate: 1000 }],
					payments: [{ mode_of_payment: "Cash", amount: 1000 }],
					expectedGrandTotal: 1000,
					openingShift: d.shift,
				}),
			);
			const keys = stockKeysOf(manifest.all());
			const before = await snapshotBins(admin, keys);

			await Promise.all(devices.map((d) => prepareCashSale(d.actor.page, ITEMS.stock)));
			const sellBarrier = new Barrier(2);
			const invoices = await Promise.all(
				devices.map(async (d) => {
					await sellBarrier.wait();
					return submitCashSale(d.actor.page);
				}),
			);
			invoices.forEach((inv, i) => manifest.update(txns[i].txnId, { state: "accepted", invoice: inv }));
			f.check(new Set(invoices).size === 2, `invoice names not unique: ${invoices.join(", ")}`);

			routeMismatches(f, await reconcile(admin, manifest));
			for (const i of compareStock(before, await snapshotBins(admin, keys), expectedStockDeltas(manifest.all()))) {
				f.check(false, `stock ${JSON.stringify(i)}`);
			}

			// Close from both devices at once; each shift must end with exactly one closing of its own sale.
			const closes = await Promise.allSettled([a.closeShift(), b.closeShift()]);
			closes.forEach((c, i) => {
				if (c.status === "rejected") f.note(`device ${i ? "B" : "A"} close: ${String(c.reason).split("\n")[0]}`);
			});
			const stillOpen = await listOpeningShifts(admin, { user: a.email, status: "Open" });
			f.expectSafe(stillOpen.length === 0, `closing from both devices left ${stillOpen.length} shift(s) open: ${stillOpen.map((s) => s.name).join(", ")}`);

			for (const shift of new Set([nameA, nameB])) {
				const closings = await getList<{ name: string; grand_total: number }>(
					admin,
					"POS Closing Shift",
					{ pos_opening_shift: shift, docstatus: 1 },
					["name", "grand_total"],
				);
				const expectedTotal = manifest.all().filter((s) => s.openingShift === shift).length * 1000;
				f.expectSafe(closings.length <= 1, `${shift} has ${closings.length} closings`);
				if (closings.length === 1) {
					f.expectSafe(Math.abs(closings[0].grand_total - expectedTotal) < 0.01, `closing ${closings[0].name} total ${closings[0].grand_total}, expected ${expectedTotal}`);
				}
			}
			completed = true;
		} finally {
			manifest.save();
			try {
				const left = await closeLeftoverShifts(admin, (await cashiers.login(1)));
				if (left.length) f.note(`cleanup closed ${left.length} shift(s) through the API: ${left.join(", ")}`);
			} catch (e) {
				f.note(`cleanup could not run: ${String(e).split("\n")[0]}`);
			}
			const outcome: Outcome =
				forced ??
				(!completed ? "observed" : f.defects.length > 0 ? "defect" : openCount > 1 ? "supported_with_restrictions" : "supported");
			if (!completed && !forced) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
			recordEvidence({
				id: "CON-03a",
				arrangement: "same account / two devices / simultaneous shift opening",
				outcome,
				notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
				data: { openShiftsForAccount: openCount, counts: manifest.summary() },
			});
			await admin.dispose();
		}
		expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
		expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
	});

	test("CON-03b — a second device resumes the open shift; a late sale after close is rejected", async ({ cashiers, playwright }) => {
		test.setTimeout(420_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let resumed = false;
		let completed = false;

		try {
			const a = await cashiers.login(1);
			const b = await cashiers.login(1);

			const leftover = await closeLeftoverShifts(admin, a);
			if (leftover.length) f.note(`closed ${leftover.length} leftover shift(s) before starting: ${leftover.join(", ")}`);

			await a.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
			f.check(Boolean(shift), "device A has no open shift after opening");
			const S = shift.name;

			const addSale = (label: string) =>
				manifest.add({
					txnId: newTxnId(label),
					cashier: a.email,
					company: COMPANY,
					posProfile: PROFILES.P1,
					warehouse: WAREHOUSES.A,
					items: [{ item_code: ITEMS.stock, qty: 1, rate: 1000 }],
					payments: [{ mode_of_payment: "Cash", amount: 1000 }],
					expectedGrandTotal: 1000,
					openingShift: S,
				});
			const keys = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
			const before = await snapshotBins(admin, keys);

			const saleA = addSale("con03b-A");
			manifest.update(saleA.txnId, { state: "accepted", invoice: await completeCashSale(a.page, ITEMS.stock) });

			// Device B logs in later with the same account.
			const state = await gotoPos(b.page);
			resumed = state === "open";
			f.note(`device B on load: ${resumed ? `given the existing open shift (${S})` : "offered a NEW Create Opening Shift dialog instead of A's shift"}`);

			if (resumed) {
				const saleB = addSale("con03b-B");
				manifest.update(saleB.txnId, { state: "accepted", invoice: await completeCashSale(b.page, ITEMS.stock) });
			}

			routeMismatches(f, await reconcile(admin, manifest));
			for (const i of compareStock(before, await snapshotBins(admin, keys), expectedStockDeltas(manifest.all()))) {
				f.check(false, `stock ${JSON.stringify(i)}`);
			}

			// Device A closes. The closing must count every sale on the shift, from either device.
			await a.closeShift();
			const closings = await getList<{ name: string; grand_total: number }>(
				admin,
				"POS Closing Shift",
				{ pos_opening_shift: S, docstatus: 1 },
				["name", "grand_total"],
			);
			f.check(closings.length === 1, `expected 1 closing for ${S}, found ${closings.length}`);
			const submittedOnShift = manifest.all().filter((s) => s.state === "submitted").length;
			if (closings[0]) {
				f.expectSafe(
					Math.abs(closings[0].grand_total - submittedOnShift * 1000) < 0.01,
					`closing ${closings[0].name} total ${closings[0].grand_total} omits sales (expected ${submittedOnShift * 1000})`,
				);
				const doc = await getDoc<Record<string, any>>(admin, "POS Closing Shift", closings[0].name);
				const counted = new Set((doc?.pos_transactions ?? []).map((t: { sales_invoice: string }) => t.sales_invoice));
				for (const s of manifest.all().filter((x) => x.state === "submitted")) {
					f.expectSafe(counted.has(s.invoice!), `closing ${closings[0].name} does not list invoice ${s.invoice}`);
				}
			}

			// After A closed the shift: is device B stopped, and does the SERVER refuse a late sale?
			if (resumed) {
				const prior = await invoicesOf(admin, a.email);

				// 1) The screen. Wait for it to notice the shift is gone.
				const dialog = b.page.getByText("Create Opening Shift", { exact: true }).first();
				const uiBlocked = await dialog.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
				f.note(`after A closed the shift, device B's screen ${uiBlocked ? "was moved to the Create Opening Shift dialog (billing blocked)" : "still showed an open POS (no notice within 20 s)"}`);
				if (!uiBlocked) {
					// The screen does not notice by itself; see what it does when B actually tries to bill.
					const reachedPayment = await prepareCashSale(b.page, ITEMS.stock).then(() => true).catch(() => false);
					const dialogNow = await dialog.isVisible().catch(() => false);
					f.note(`device B tried to bill: payment dialog ${reachedPayment ? "reached" : "NOT reached"}; Create Opening Shift dialog now showing: ${dialogNow}`);
					if (reachedPayment) {
						await b.page.getByRole("button", { name: "Submit", exact: true }).click();
						const accepted = await b.page.getByText(/Invoice \S+ is Submited/).waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
						f.expectSafe(!accepted, "device B's screen accepted a sale after the shift was closed");
					}
				}

				// 2) The server. Submit directly, naming the closed shift, as device B's own session.
				const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
				const late = {
					doctype: "Sales Invoice",
					is_pos: 1,
					ignore_pricing_rule: 1,
					company: COMPANY,
					pos_profile: PROFILES.P1,
					customer: profile?.customer,
					currency: "INR",
					posting_date: new Date().toISOString().slice(0, 10),
					posa_pos_opening_shift: S,
					items: [{ item_code: ITEMS.stock, qty: 1, rate: 1000, uom: "Nos", conversion_factor: 1 }],
					payments: [{ mode_of_payment: "Cash", amount: 1000 }],
				};
				const draft = await callAs(b, "pospire.pospire.api.posapp.update_invoice", { data: JSON.stringify(late) });
				const draftDoc = draft.status === 200 ? draft.json?.message : null;
				f.note(`server: late update_invoice naming the closed shift -> HTTP ${draft.status}${draftDoc ? ` (draft ${draftDoc.name})` : ` ${errorText(draft)}`}`);
				if (draftDoc?.name) {
					const submit = await callAs(b, "pospire.pospire.api.posapp.submit_invoice", {
						invoice: draftDoc,
						data: JSON.stringify(draftDoc),
						offline_id: `con03b-late-${Date.now().toString(36)}`,
					});
					f.note(`server: late submit_invoice -> HTTP ${submit.status}${submit.status === 200 ? "" : ` ${errorText(submit)}`}`);
				}

				const priorNames = new Set(prior.map((i) => i.name));
				const created = (await invoicesOf(admin, a.email)).filter((i) => !priorNames.has(i.name));
				// Only invoices that belong to the CLOSED shift (or to no shift) can be a late sale
				// from device B. Anything on another shift is unrelated activity on this account and
				// must not be blamed on this scenario.
				const fresh = created.filter((i) => !i.posa_pos_opening_shift || i.posa_pos_opening_shift === S);
				const unrelated = created.filter((i) => !fresh.includes(i));
				if (unrelated.length) f.note(`ignored ${unrelated.length} new invoice(s) on other shifts (unrelated activity): ${JSON.stringify(unrelated)}`);
				f.note(`invoices created after the close on ${S} or without a shift: ${JSON.stringify(fresh)}`);
				f.expectSafe(
					fresh.every((i) => i.docstatus !== 1),
					`a sale was ACCEPTED after the shift was closed (${fresh.filter((i) => i.docstatus === 1).map((i) => `${i.name} on ${i.posa_pos_opening_shift}`).join(", ")})`,
				);
			}
			completed = true;
		} finally {
			manifest.save();
			try {
				const left = await closeLeftoverShifts(admin, await cashiers.login(1));
				if (left.length) f.note(`cleanup closed ${left.length} shift(s) through the API: ${left.join(", ")}`);
			} catch (e) {
				f.note(`cleanup could not run: ${String(e).split("\n")[0]}`);
			}
			if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
			const outcome: Outcome = !completed
				? "observed"
				: f.defects.length > 0
					? "defect"
					: resumed
						? "supported"
						: "supported_with_restrictions";
			recordEvidence({
				id: "CON-03b",
				arrangement: "same account / two devices / second device resumes an open shift",
				outcome,
				notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
				data: { resumed, counts: manifest.summary() },
			});
			await admin.dispose();
		}
		expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
		expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
	});
});
