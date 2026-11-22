/**
 * OFF-02 (P0): two devices queue sales against the SAME opening shift offline,
 * then reconnect.
 *
 * "Where allowed": the shared-shift arrangement that is allowed is the SAME
 * account on two devices (CON-03: the second device picks up the open shift).
 * Two DIFFERENT users on one shift is the CON-04 defect, so it is not repeated
 * here. Device A opens the shift; device B logs in separately and joins it. Both
 * go offline and each queues sales with its own quantities (A: 1 and 2, B: 3 and
 * 4), so a lost, duplicated, merged or swapped sale shows up in the numbers.
 *
 *   OFF-02a  both devices reconnect at the same moment
 *   OFF-02b  A reconnects and drains first, then B
 *   OFF-02c  B reconnects and drains first, then A
 *
 * Expected: every sale becomes exactly one submitted invoice on the one shift,
 * owned by the cashier, with no shared offline ids; stock falls by exactly what
 * was sold; the ledger balances; the shift closes.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Barrier } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { waitForOutboxDrain } from "./helpers/outbox";
import { gotoPos } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const RATE = 1000;
const SALES = Math.max(2, Number(process.env.PERF_OFF_SALES ?? 4));
const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
/** Device A sells 1 and 2 units, device B sells 3 and 4, so each sale is identifiable by quantity. */
const qtysA = Array.from({ length: SALES }, (_, j) => (j % 2) + 1);
const qtysB = Array.from({ length: SALES }, (_, j) => (j % 2) + 3);

type Order = "together" | "A-then-B" | "B-then-A";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

const CASES: { id: string; order: Order; title: string }[] = [
	{ id: "OFF-02a", order: "together", title: "both devices reconnect together" },
	{ id: "OFF-02b", order: "A-then-B", title: "A reconnects first, then B" },
	{ id: "OFF-02c", order: "B-then-A", title: "B reconnects first, then A" },
];

test.describe("OFF-02 — two devices, one shift, offline sales", () => {
	for (const c of CASES) {
		test(`${c.id} — ${c.title}`, async ({ cashiers, playwright }) => {
			test.setTimeout(900_000);
			const admin = await newAdminContext(playwright);
			const manifest = new Manifest();
			const f = new Findings();
			const data: Record<string, unknown> = { order: c.order, qtysA, qtysB };
			let completed = false;

			try {
				const a = await cashiers.login(1);
				const left = await closeLeftoverShifts(admin, a);
				if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
				await a.openShift(PROFILES.P1, "0");
				const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
				f.check(Boolean(shift), "no open shift after opening it on device A");

				// Device B: a separate login and a separate browser, same account. It must join the open shift.
				const b = await cashiers.login(1);
				const stateB = await gotoPos(b.page).catch((e) => `error: ${String(e).split("\n")[0]}`);
				f.note(`device B opened the POS and saw: ${stateB}`);
				f.check(stateB === "open", `device B did not pick up the open shift (saw "${stateB}"), so the shared-shift arrangement does not exist`);
				if (stateB !== "open") throw new Error("device B has no shift to sell on");
				const shiftsNow = await listOpeningShifts(admin, { user: a.email, status: "Open" });
				f.expectSafe(shiftsNow.length === 1, `${shiftsNow.length} open shifts for one account with two devices (expected 1)`);

				const before = await snapshotBins(admin, KEYS);

				// ---- both devices go offline and sell ----
				await Promise.all([a.context.setOffline(true), b.context.setOffline(true)]);
				const [depthA, depthB] = await Promise.all([
					sellOffline(a.page, ITEMS.stock, qtysA),
					sellOffline(b.page, ITEMS.stock, qtysB),
				]);
				f.check(depthA[depthA.length - 1] >= SALES, `device A queued only ${depthA[depthA.length - 1] ?? 0}/${SALES} sales`);
				f.check(depthB[depthB.length - 1] >= SALES, `device B queued only ${depthB[depthB.length - 1] ?? 0}/${SALES} sales`);
				f.note(`queue depth after each sale: A=${JSON.stringify(depthA)}, B=${JSON.stringify(depthB)}`);
				const early = await invoicesOnShift(admin, shift.name);
				f.check(early.length === 0, `the server already has ${early.length} invoice(s) on the shift before any reconnect`);

				// ---- reconnect in the requested order ----
				const t0 = Date.now();
				const drain = async (d: typeof a) => {
					await d.context.setOffline(false);
					return waitForOutboxDrain(d.page, 240_000);
				};
				let drainA, drainB;
				if (c.order === "together") {
					const gate = new Barrier(2);
					[drainA, drainB] = await Promise.all(
						[a, b].map(async (d) => {
							await gate.wait();
							return drain(d);
						}),
					);
				} else if (c.order === "A-then-B") {
					drainA = await drain(a);
					f.note(`A drained first after ${drainA.ms} ms; invoices on the shift now: ${(await invoicesOnShift(admin, shift.name)).length}`);
					drainB = await drain(b);
				} else {
					drainB = await drain(b);
					f.note(`B drained first after ${drainB.ms} ms; invoices on the shift now: ${(await invoicesOnShift(admin, shift.name)).length}`);
					drainA = await drain(a);
				}
				data.totalDrainMs = Date.now() - t0;
				data.drain = { A: { ms: drainA.ms, drained: drainA.drained }, B: { ms: drainB.ms, drained: drainB.drained } };
				f.note(`reconnect order "${c.order}": A drained=${drainA.drained} (${drainA.ms} ms), B drained=${drainB.drained} (${drainB.ms} ms), total ${data.totalDrainMs} ms`);
				for (const [name, d] of [["A", drainA], ["B", drainB]] as const) {
					f.check(d.drained, `device ${name}: the queue did not drain within 240 s`);
					f.expectSafe(d.needsAttention.length === 0, `device ${name}: queue ended needing attention: ${JSON.stringify(d.needsAttention)}`);
				}

				// ---- what the shift ended up with ----
				const expected = SALES * 2;
				let onShift = await invoicesOnShift(admin, shift.name);
				for (let i = 0; i < 30 && onShift.filter((x) => x.docstatus === 1).length < expected; i++) {
					await a.page.waitForTimeout(1_000);
					onShift = await invoicesOnShift(admin, shift.name);
				}
				const submitted = onShift.filter((x) => x.docstatus === 1);
				f.note(`on ${shift.name}: ${submitted.length} submitted of ${expected} expected; ${onShift.length - submitted.length} other`);
				f.expectSafe(submitted.length === expected, `${submitted.length} submitted invoices for ${expected} sales (lost or duplicated)`);
				f.expectSafe(onShift.every((x) => x.docstatus === 1), `draft/cancelled invoice(s) left on the shift: ${onShift.filter((x) => x.docstatus !== 1).map((x) => x.name).join(", ")}`);
				for (const inv of submitted) f.expectSafe(inv.owner === a.email, `${inv.name} is owned by ${inv.owner}, not ${a.email}`);
				const ids = submitted.map((x) => x.pos_offline_id).filter(Boolean);
				f.expectSafe(new Set(ids).size === ids.length, `offline id collision between the two devices: ${JSON.stringify(ids)}`);
				f.expectSafe(ids.length === submitted.length, `${submitted.length - ids.length} invoice(s) carry no offline id`);

				// Match each sale to an invoice by its (device-unique) quantity.
				const pool = new Map<number, string[]>();
				for (const inv of submitted) {
					const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
					const qty = (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
					pool.set(qty, [...(pool.get(qty) ?? []), inv.name]);
				}
				f.note(`invoices by quantity: ${JSON.stringify([...pool.entries()].map(([q, n]) => [q, n.length]))}`);
				for (const [device, qtys] of [["A", qtysA], ["B", qtysB]] as const) {
					for (const qty of qtys) {
						const name = pool.get(qty)?.shift();
						const sale = manifest.add({
							txnId: newTxnId(`off02${device}`),
							cashier: a.email,
							company: COMPANY,
							posProfile: PROFILES.P1,
							warehouse: WAREHOUSES.A,
							items: [{ item_code: ITEMS.stock, qty, rate: RATE }],
							payments: [{ mode_of_payment: "Cash", amount: RATE * qty }],
							expectedGrandTotal: RATE * qty,
							openingShift: shift.name,
							invoice: name,
						});
						manifest.update(sale.txnId, name ? { state: "accepted" } : { state: "attempted" });
					}
				}
				const extra = [...pool.values()].flat();
				f.expectSafe(extra.length === 0, `invoice(s) with no matching sale (duplicate, merged or wrong quantity): ${extra.join(", ")}`);
				await verifyManifest(admin, manifest, before, KEYS, f);

				const closed = await closeLeftoverShiftsDetailed(admin, a);
				f.expectSafe(closed.stuck.length === 0, `could not close the shift afterwards: ${JSON.stringify(closed.stuck)}`);
				a.forgetShift();
				completed = true;
			} finally {
				manifest.save();
				if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
				const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
				recordEvidence({
					id: c.id,
					arrangement: `same account on two devices, one shift, ${SALES} offline sales each, reconnect order: ${c.order}`,
					outcome,
					notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
					data,
				});
				await admin.dispose();
			}
			expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
			expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
		});
	}
});
