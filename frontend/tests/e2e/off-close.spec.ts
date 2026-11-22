/**
 * OFF-03 (P0): closing a shift while sales are still on their way.
 *
 * What the code does, which these tests check rather than assume:
 *  - the server builds a closing from the invoices SUBMITTED at that moment and
 *    does not know about sales still queued on a device;
 *  - the app only holds a close back for the SAME device's own unsynced sales,
 *    so another device on the shift is invisible to it;
 *  - submit_closing_shift returns the existing closing if the shift already has one.
 *
 *   OFF-03a  Device A closes while device B (same account, same shift) is offline
 *            with unsynced sales; B reconnects afterwards.
 *   OFF-03b  A close races a stream of online sales (one every 150 ms), started at a
 *            different point of the stream each round; request timings prove which
 *            sales were really in flight while the closing was being built.
 *   OFF-03c  2, then 5, close requests for one shift at the same moment; their
 *            overlap is measured.
 *
 * Expected (ticket): no falsely complete reconciliation, no orphaned sales, no
 * duplicate valid closings; late invoices are preserved and accounted for. A sale
 * that ends up neither on the shift nor visibly waiting for review is lost. A
 * submitted invoice that the closing summary does not contain means the shift was
 * closed as "complete" while it was not.
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, RACE_CASHIER, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { callAs, errorText } from "./helpers/as-user";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Barrier, commonOverlapMs } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { waitForOutboxDrain } from "./helpers/outbox";
import { completeCashSale, gotoPos } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

type Admin = Awaited<ReturnType<typeof newAdminContext>>;
const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;
const ROUNDS = Math.max(1, Number(process.env.PERF_RACE_ROUNDS ?? 3));
const MAKE = "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening";
const SUBMIT = "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

function finish(id: string, arrangement: string, f: Findings, completed: boolean, data: Record<string, unknown>) {
	if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
	const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
	recordEvidence({
		id,
		arrangement,
		outcome,
		notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
		data,
	});
}

function assertClean(f: Findings) {
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

/** The submitted closing(s) of a shift, with the invoices each one lists. */
async function closingsOf(admin: Admin, shift: string) {
	const rows = await getList<{ name: string }>(admin, "POS Closing Shift", { pos_opening_shift: shift, docstatus: 1 }, ["name"]);
	const docs = await Promise.all(rows.map((r) => getDoc<Record<string, any>>(admin, "POS Closing Shift", r.name)));
	return docs.filter(Boolean).map((d) => ({
		name: d!.name as string,
		grandTotal: Number(d!.grand_total),
		invoices: new Set<string>((d!.pos_transactions ?? []).map((t: any) => t.sales_invoice)),
	}));
}

const quantityOf = async (admin: Admin, invoice: string) => {
	const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", invoice);
	return (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
};

test.describe("OFF-03 — closing the shift while sales are in flight", () => {
	test("OFF-03a — A closes while B is offline with unsynced sales", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		const data: Record<string, unknown> = {};
		let completed = false;
		const qtysB = [3, 4, 3];

		try {
			const a = await cashiers.login(1);
			const left = await closeLeftoverShifts(admin, a);
			if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
			await a.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
			const b = await cashiers.login(1);
			const stateB = await gotoPos(b.page).catch((e) => `error: ${String(e).split("\n")[0]}`);
			f.check(stateB === "open", `device B did not join the open shift (saw "${stateB}")`);
			if (stateB !== "open") throw new Error("device B has no shift to sell on");
			const before = await snapshotBins(admin, KEYS);

			// A makes one ordinary online sale, so the closing has something in it.
			const onlineInvoice = await completeCashSale(a.page, ITEMS.stock);
			// B goes offline and queues three sales that A knows nothing about.
			await b.context.setOffline(true);
			const depthB = await sellOffline(b.page, ITEMS.stock, qtysB);
			f.check(depthB[depthB.length - 1] >= qtysB.length, `device B queued only ${depthB[depthB.length - 1] ?? 0}/${qtysB.length} sales`);
			f.note(`A sold ${onlineInvoice} online; B queued ${qtysB.length} sales offline (qty ${JSON.stringify(qtysB)})`);

			// A closes the shift through the screen (the app does not know about B's queue).
			let closeError = "";
			await a.closeShift().catch((e) => {
				closeError = String(e).split("\n")[0];
			});
			f.note(closeError ? `A's close was refused or failed: ${closeError}` : "A closed the shift while B still held unsynced sales");
			const closings = await closingsOf(admin, shift.name);
			data.closingBeforeReconnect = closings.map((c) => ({ name: c.name, grandTotal: c.grandTotal, invoices: c.invoices.size }));
			if (closeError) a.forgetShift();
			f.note(`closing(s) on the shift after A's close: ${JSON.stringify(data.closingBeforeReconnect)}`);

			// B reconnects later.
			await b.context.setOffline(false);
			const drain = await waitForOutboxDrain(b.page, 150_000);
			data.drainB = { ms: drain.ms, drained: drain.drained, rows: drain.rows, needsAttention: drain.needsAttention.length };
			f.note(`B reconnected: drained=${drain.drained} after ${drain.ms} ms; queue rows=${JSON.stringify(drain.rows)}`);
			const messages = (await b.page.locator(".v-snackbar, .toast, [role=alert]").allTextContents()).map((t) => t.trim()).filter(Boolean);
			f.note(`messages visible on B after reconnecting: ${JSON.stringify(messages)}`);

			// Where did each of B's sales end up?
			await b.page.waitForTimeout(3_000);
			const onShift = await invoicesOnShift(admin, shift.name);
			const submitted = onShift.filter((x) => x.docstatus === 1);
			const byQty = new Map<number, string[]>();
			for (const inv of submitted) {
				const q = await quantityOf(admin, inv.name);
				byQty.set(q, [...(byQty.get(q) ?? []), inv.name]);
			}
			const bInvoices = qtysB.map((q) => byQty.get(q)?.shift());
			const landed = bInvoices.filter(Boolean) as string[];
			const waiting = drain.rows.filter((r) => ["needs_review", "handed_off", "enqueued", "retry_pending", "in_flight"].includes(r.status ?? "")).length;
			const lost = qtysB.length - landed.length - waiting;
			data.classification = { landedOnClosedShift: landed.length, visiblyWaitingInQueue: waiting, lost };
			f.note(`B's ${qtysB.length} sales: ${landed.length} became invoices on the closed shift, ${waiting} are visibly waiting in B's queue, ${Math.max(0, lost)} unaccounted for`);
			f.expectSafe(lost <= 0, `${lost} of B's sales are neither invoices nor visibly waiting in the queue (silently lost)`);

			const after = await closingsOf(admin, shift.name);
			f.expectSafe(after.length <= 1, `${after.length} valid closings exist for one shift`);
			const closing = after[0];
			if (closing) {
				const late = landed.filter((n) => !closing.invoices.has(n));
				data.lateInvoices = late;
				f.note(`closing ${closing.name} lists ${closing.invoices.size} invoice(s), total ${closing.grandTotal}; late invoice(s) it does not list: ${JSON.stringify(late)}`);
				f.expectSafe(
					late.length === 0,
					`${late.length} invoice(s) were accepted onto the shift AFTER it was closed and are not in the closing ${closing.name}: the shift was closed as complete but is not (${late.join(", ")})`,
				);
			}

			// Stock: every sale that did become an invoice must have moved stock exactly once.
			for (const [name, qty] of [[onlineInvoice, 1] as const, ...landed.map((n, i) => [n, qtysB[i]] as const)]) {
				const s = manifest.add({
					txnId: newTxnId("off03a"),
					cashier: a.email,
					company: COMPANY,
					posProfile: PROFILES.P1,
					warehouse: WAREHOUSES.A,
					items: [{ item_code: ITEMS.stock, qty: qty ?? 1, rate: RATE }],
					payments: [{ mode_of_payment: "Cash", amount: RATE * (qty ?? 1) }],
					expectedGrandTotal: RATE * (qty ?? 1),
					openingShift: shift.name,
					invoice: name,
				});
				manifest.update(s.txnId, { state: "accepted" });
			}
			await verifyManifest(admin, manifest, before, KEYS, f);
			completed = true;
		} finally {
			manifest.save();
			finish("OFF-03a", "device A closes the shift while device B (same account) is offline with unsynced sales; B reconnects afterwards", f, completed, data);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("OFF-03b — a close races sales being submitted online", async ({ playwright }) => {
		test.setTimeout(900_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		const rounds = Math.max(ROUNDS, 5);
		const data: Record<string, unknown> = { rounds };
		let completed = false;
		const SALES = 12;
		const GAP_MS = 150;
		test.skip(!cashierPassword(RACE_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
		const seats = [await loginApiSeat(playwright, RACE_CASHIER), await loginApiSeat(playwright, RACE_CASHIER)];
		const [closer, seller] = seats;

		try {
			const stuck = (await closeLeftoverShiftsDetailed(admin, closer.actor, { visitPos: false })).stuck;
			f.check(stuck.length === 0, `could not clear leftover shifts: ${JSON.stringify(stuck)}`);
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const before = await snapshotBins(admin, KEYS);
			const results: Record<string, unknown>[] = [];
			let racing = 0;

			for (let r = 1; r <= rounds; r++) {
				const opened = await openShiftApi(closer, COMPANY, PROFILES.P1);
				if (!opened.shift) throw new Error(`round ${r}: could not open a shift: ${opened.error}`);
				const shift = opened.shift;
				const opening = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shift);

				// Drafts first: the race is only about the submits and the close.
				const drafts = [];
				for (let i = 0; i < SALES; i++) {
					const d = await createDraft(seller.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }));
					f.check(Boolean(d.doc?.name), `round ${r}: draft ${i} not created: HTTP ${d.res.status} ${errorText(d.res)}`);
					if (d.doc) drafts.push(d.doc);
				}

				// Sales stream in one every GAP_MS; the close starts at a different point of the stream each round.
				const streamMs = drafts.length * GAP_MS;
				const closeAt = Math.round((r / (rounds + 1)) * streamMs);
				const gate = new Barrier(2);
				const [win, subs] = await Promise.all([
					(async () => {
						await gate.wait();
						await new Promise((res) => setTimeout(res, closeAt));
						const makeStart = performance.now();
						const made = await callAs(closer.actor, MAKE, { opening_shift: opening });
						const makeEnd = performance.now();
						if (made.status !== 200) return { makeStart, makeEnd, end: makeEnd, status: made.status, detail: errorText(made), name: undefined as string | undefined };
						const done = await callAs(closer.actor, SUBMIT, { closing_shift: made.json.message });
						return { makeStart, makeEnd, end: performance.now(), status: done.status, detail: errorText(done), name: done.json?.message as string | undefined };
					})(),
					(async () => {
						await gate.wait();
						const t0 = performance.now();
						return Promise.all(
							drafts.map(async (d, i) => {
								await new Promise((res) => setTimeout(res, Math.max(0, i * GAP_MS - (performance.now() - t0))));
								const start = performance.now();
								const res = await submitDraft(seller.actor, d, { cashAmount: RATE, offlineId: randomUUID() });
								return { res, start, end: performance.now(), name: res.json?.message?.name as string | undefined };
							}),
						);
					})(),
				]);

				const statuses = subs.map((s) => s.res.status);
				f.expectSafe(statuses.every((s) => s < 500) && win.status < 500, `round ${r}: uncontrolled server error: close=HTTP ${win.status} ${win.detail}; submits=${JSON.stringify(statuses)}`);
				const inFlight = subs.filter((s) => s.start < win.end && s.end > win.makeStart).length;
				const beforeClose = subs.filter((s) => s.end <= win.makeStart).length;
				const afterClose = subs.filter((s) => s.start >= win.end).length;
				if (inFlight > 0) racing += 1;

				const submitted = (await invoicesOnShift(admin, shift)).filter((x) => x.docstatus === 1);
				const closings = await closingsOf(admin, shift);
				const listed = new Set(closings.flatMap((c) => [...c.invoices]));
				const missing = submitted.filter((x) => !listed.has(x.name));
				const spanOf = new Map(subs.filter((s) => s.name).map((s) => [s.name!, s]));
				const missedWhileClosing = missing.filter((x) => (spanOf.get(x.name)?.start ?? 0) < win.end);
				const acceptedAfterClose = missing.filter((x) => (spanOf.get(x.name)?.start ?? 0) >= win.end);
				const refused = statuses.filter((s) => s !== 200).length;
				results.push({ round: r, closeAtMs: closeAt, closeWindowMs: Math.round(win.end - win.makeStart), submitsBeforeClose: beforeClose, submitsInFlightDuringClose: inFlight, submitsAfterClose: afterClose, closeHttp: win.status, closings: closings.length, submittedOnShift: submitted.length, missedWhileClosing: missedWhileClosing.length, acceptedAfterClose: acceptedAfterClose.length, refused });
				f.note(`round ${r} (${shift}): close started ${closeAt} ms into the stream and took ${Math.round(win.end - win.makeStart)} ms (HTTP ${win.status}); of ${SALES} sales ${beforeClose} finished before it, ${inFlight} were in flight during it, ${afterClose} started after it; ${submitted.length} submitted, ${refused} refused; ${submitted.length - missing.length} are in the closing, ${missedWhileClosing.length} in flight during the close are missing from it, ${acceptedAfterClose.length} accepted after it finished`);
				const firstRefusal = subs.find((s) => s.res.status !== 200);
				if (firstRefusal) f.note(`round ${r}: first refused submit: HTTP ${firstRefusal.res.status} ${errorText(firstRefusal.res)} (started ${Math.round(firstRefusal.start - win.makeStart)} ms after the close started)`);
				f.check(submitted.length > 0, `round ${r}: no sale was submitted at all (${refused} refused), so there was nothing to race the close against`);
				f.expectSafe(closings.length === 1, `round ${r}: ${closings.length} valid closings for one shift`);
				f.expectSafe(missedWhileClosing.length === 0, `round ${r}: ${missedWhileClosing.length} sale(s) submitted while the closing was being built are missing from it (${missedWhileClosing.map((o) => o.name).join(", ")}): the closing is not a complete record of the shift`);
				f.expectSafe(acceptedAfterClose.length === 0, `round ${r}: ${acceptedAfterClose.length} online sale(s) started AFTER the closing finished were accepted onto the closed shift (${acceptedAfterClose.map((o) => o.name).join(", ")})`);
				for (const s of submitted) {
					const sale = manifest.add({ txnId: newTxnId("off03b"), cashier: closer.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE }], expectedGrandTotal: RATE, openingShift: shift, invoice: s.name });
					manifest.update(sale.txnId, { state: "accepted" });
				}
			}
			data.roundResults = results;
			data.roundsWithSalesInFlightDuringClose = racing;
			f.note(`${racing} of ${rounds} rounds had sales genuinely in flight while the close was running`);
			f.check(racing > 0, `the race was never exercised: no sale was in flight while the close ran in any of ${rounds} rounds, so this test says nothing about the race`);
			await verifyManifest(admin, manifest, before, KEYS, f);
			completed = true;
		} finally {
			manifest.save();
			await closeLeftoverShiftsDetailed(admin, closer.actor, { visitPos: false }).catch(() => null);
			await Promise.all(seats.map((s) => s.dispose().catch(() => {})));
			finish("OFF-03b", `a close races ${SALES} online sales streamed one every ${GAP_MS} ms (same account, two sessions), close started at a different point each round`, f, completed, data);
			await admin.dispose();
		}
		assertClean(f);
	});

	for (const requesters of [2, 5]) {
		test(`OFF-03c — ${requesters} close requests at the same moment produce one closing`, async ({ playwright }) => {
			test.setTimeout(900_000);
			const admin = await newAdminContext(playwright);
			const f = new Findings();
			const rounds = Math.max(ROUNDS, 5);
			const data: Record<string, unknown> = { rounds, requesters };
			let completed = false;
			const seats = await Promise.all(Array.from({ length: requesters }, () => loginApiSeat(playwright, 1)));

			try {
				const stuck = (await closeLeftoverShiftsDetailed(admin, seats[0].actor, { visitPos: false })).stuck;
				f.check(stuck.length === 0, `could not clear leftover shifts: ${JSON.stringify(stuck)}`);
				const results: Record<string, unknown>[] = [];
				for (let r = 1; r <= rounds; r++) {
					const opened = await openShiftApi(seats[0], COMPANY, PROFILES.P1);
					if (!opened.shift) throw new Error(`round ${r}: could not open a shift: ${opened.error}`);
					const shift = opened.shift;
					const opening = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shift);

					const gate = new Barrier(requesters);
					const outcomes = await Promise.all(
						seats.map(async (s) => {
							await gate.wait();
							const start = performance.now();
							const made = await callAs(s.actor, MAKE, { opening_shift: opening });
							if (made.status !== 200) return { status: made.status, detail: errorText(made), name: undefined as string | undefined, span: { start, end: performance.now() } };
							const done = await callAs(s.actor, SUBMIT, { closing_shift: made.json.message });
							return { status: done.status, detail: errorText(done), name: done.json?.message as string | undefined, span: { start, end: performance.now() } };
						}),
					);
					const overlap = commonOverlapMs(outcomes.map((o) => o.span));
					const closings = await closingsOf(admin, shift);
					const names = outcomes.map((x) => x.name).filter(Boolean);
					results.push({ round: r, overlapMs: Math.round(overlap), statuses: outcomes.map((x) => x.status), closings: closings.map((c) => c.name) });
					f.note(`round ${r} (${shift}): ${requesters} requests overlapped for ${Math.round(overlap)} ms and got ${JSON.stringify(outcomes.map((x) => ({ status: x.status, name: x.name, detail: x.detail })))}; valid closings: ${JSON.stringify(closings.map((c) => c.name))}`);
					f.check(overlap > 0, `round ${r}: the ${requesters} close requests did not all overlap (${overlap.toFixed(0)} ms), so they were not simultaneous`);
					f.expectSafe(outcomes.every((x) => x.status < 500), `round ${r}: uncontrolled server error: ${JSON.stringify(outcomes.map((x) => `${x.status} ${x.detail}`))}`);
					f.expectSafe(closings.length === 1, `round ${r}: ${closings.length} valid closings for one shift (duplicate closing)`);
					f.expectSafe(new Set(names).size <= 1, `round ${r}: the requests were told different closing names: ${JSON.stringify(names)}`);
					const refreshed = (await listOpeningShifts(admin, { name: shift })).find((x) => x.name === shift);
					f.expectSafe(refreshed?.status === "Closed", `round ${r}: the opening shift is "${refreshed?.status}" after being closed`);
				}
				data.roundResults = results;
				completed = true;
			} finally {
				await closeLeftoverShiftsDetailed(admin, seats[0].actor, { visitPos: false }).catch(() => null);
				await Promise.all(seats.map((s) => s.dispose().catch(() => {})));
				finish(requesters === 2 ? "OFF-03c" : `OFF-03c (${requesters} requests)`, `${requesters} simultaneous close requests for one shift (same account, ${requesters} sessions)`, f, completed, data);
				await admin.dispose();
			}
			assertClean(f);
		});
	}
});
