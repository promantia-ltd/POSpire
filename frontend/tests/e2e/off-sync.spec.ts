/**
 * OFF-01 (P0): each device sells offline on ITS OWN open shift; all devices
 * reconnect together.
 *
 * Two cashiers, each in a real browser with their own shift, go offline and make
 * K cash sales each. Every sale has a different quantity (1..5, repeating), so a
 * lost, duplicated, swapped or merged sale shows up in the numbers. Both then
 * reconnect at the same moment and sync from their own outbox.
 *
 *   OFF-01a  both cashiers on one common profile (PERF-P1, warehouse A)
 *   OFF-01b  the cashiers on different profiles and warehouses (P1/A and P3/B)
 *
 * Expected: every accepted sale becomes exactly one submitted invoice (or an
 * explicit, visible exception), on the right cashier's shift, owned by that
 * cashier; the queues end empty; stock falls by exactly what was sold, in the
 * right warehouse; the ledger balances. Sales per cashier: PERF_OFF_SALES
 * (default 5).
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Barrier } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { waitForOutboxDrain } from "./helpers/outbox";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

type Admin = Awaited<ReturnType<typeof newAdminContext>>;
type Cashiers = Parameters<Parameters<typeof test>[2]>[0]["cashiers"];

const RATE = 1000;
const SALES = Math.max(1, Number(process.env.PERF_OFF_SALES ?? 5));
/** Quantities 1..5 repeating: distinct enough to spot a swapped, merged, lost or duplicated sale. */
const qtyOf = (j: number) => (j % 5) + 1;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
});

interface Device {
	n: number;
	profile: string;
	warehouse: string;
}

interface Seat extends Device {
	actor: Actor;
	shift: string;
}

async function openSeats(cashiers: Cashiers, admin: Admin, devices: Device[], f: Findings): Promise<Seat[]> {
	const actors = await Promise.all(devices.map((d) => cashiers.login(d.n)));
	for (const a of actors) {
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) for ${a.email}: ${left.join(", ")}`);
	}
	await Promise.all(actors.map((a, i) => a.openShift(devices[i].profile, "0")));
	const seats: Seat[] = [];
	for (const [i, a] of actors.entries()) {
		const [s] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(s), `${a.email} has no open shift after opening`);
		seats.push({ ...devices[i], actor: a, shift: s.name });
	}
	return seats;
}

/** Make `SALES` sales on this device while offline; resolves with the queue depth after each. */
const sellOfflineOn = (seat: Seat) =>
	sellOffline(seat.actor.page, ITEMS.stock, Array.from({ length: SALES }, (_, j) => qtyOf(j)));

async function runOff01(
	id: string,
	arrangement: string,
	devices: Device[],
	{ cashiers, playwright }: { cashiers: Cashiers; playwright: Parameters<typeof newAdminContext>[0] },
) {
	const admin = await newAdminContext(playwright);
	const manifest = new Manifest();
	const f = new Findings();
	const data: Record<string, unknown> = { devices: devices.map((d) => d.n), salesPerDevice: SALES };
	let completed = false;
	let seats: Seat[] = [];
	const keys = [...new Map(devices.map((d) => [d.warehouse, { item: ITEMS.stock, warehouse: d.warehouse }])).values()];

	try {
		seats = await openSeats(cashiers, admin, devices, f);
		const before = await snapshotBins(admin, keys);

		// ---- network off on every device; each sells on its own shift ----
		await Promise.all(seats.map((s) => s.actor.context.setOffline(true)));
		const depths = await Promise.all(seats.map((s) => sellOfflineOn(s)));
		seats.forEach((s, i) => {
			f.check(depths[i].length === SALES && depths[i][SALES - 1] >= SALES, `${s.actor.email}: only ${depths[i][SALES - 1] ?? 0}/${SALES} sales were queued while offline`);
		});
		f.note(`queued while offline (queue depth after each sale): ${seats.map((s, i) => `${s.actor.email}=${JSON.stringify(depths[i])}`).join("; ")}`);

		// Proof the sales are really only queued: the server has none of them yet.
		const early = (await Promise.all(seats.map((s) => invoicesOnShift(admin, s.shift)))).flat();
		f.check(early.length === 0, `the server already has ${early.length} invoice(s) on these shifts before reconnecting; the sales were not held offline`);

		// ---- all devices reconnect at the same moment ----
		const gate = new Barrier(seats.length);
		const t0 = Date.now();
		await Promise.all(
			seats.map(async (s) => {
				await gate.wait();
				await s.actor.context.setOffline(false);
			}),
		);
		const drains = await Promise.all(seats.map((s) => waitForOutboxDrain(s.actor.page, 240_000)));
		data.drain = seats.map((s, i) => ({ cashier: s.actor.email, ms: drains[i].ms, drained: drains[i].drained, rows: drains[i].rows.length }));
		data.fullDrainMs = Date.now() - t0;
		f.note(`reconnected together; every queue drained after ${data.fullDrainMs} ms: ${JSON.stringify(data.drain)}`);
		drains.forEach((d, i) => {
			f.check(d.drained, `${seats[i].actor.email}: the queue did not drain within 240 s`);
			f.expectSafe(d.needsAttention.length === 0, `${seats[i].actor.email}: queue ended needing attention: ${JSON.stringify(d.needsAttention)}`);
		});

		// ---- what the server ended up with, per cashier ----
		for (const s of seats) {
			let onShift = await invoicesOnShift(admin, s.shift);
			for (let i = 0; i < 30 && onShift.filter((x) => x.docstatus === 1).length < SALES; i++) {
				await s.actor.page.waitForTimeout(1_000);
				onShift = await invoicesOnShift(admin, s.shift);
			}
			const submitted = onShift.filter((x) => x.docstatus === 1);
			f.note(`${s.actor.email} on ${s.shift}: ${submitted.length} submitted, ${onShift.length - submitted.length} other`);
			f.expectSafe(submitted.length === SALES, `${s.actor.email}: ${submitted.length} submitted invoices for ${SALES} sales (lost or duplicated)`);
			f.expectSafe(onShift.every((x) => x.docstatus === 1), `${s.actor.email}: draft/cancelled invoice(s) left on the shift: ${onShift.filter((x) => x.docstatus !== 1).map((x) => x.name).join(", ")}`);
			for (const inv of submitted) f.expectSafe(inv.owner === s.actor.email, `${inv.name} on ${s.actor.email}'s shift is owned by ${inv.owner}`);
			const ids = submitted.map((x) => x.pos_offline_id).filter(Boolean);
			f.expectSafe(new Set(ids).size === ids.length, `${s.actor.email}: two invoices share an offline id`);

			// Quantities must match what this cashier sold, one for one.
			const pool = new Map<number, string[]>();
			for (const inv of submitted) {
				const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
				const qty = (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				pool.set(qty, [...(pool.get(qty) ?? []), inv.name]);
			}
			for (let j = 0; j < SALES; j++) {
				const qty = qtyOf(j);
				const name = pool.get(qty)?.shift();
				const sale = manifest.add({
					txnId: newTxnId("off01"),
					cashier: s.actor.email,
					company: COMPANY,
					posProfile: s.profile,
					warehouse: s.warehouse,
					items: [{ item_code: ITEMS.stock, qty, rate: RATE }],
					payments: [{ mode_of_payment: "Cash", amount: RATE * qty }],
					expectedGrandTotal: RATE * qty,
					openingShift: s.shift,
					invoice: name,
				});
				manifest.update(sale.txnId, name ? { state: "accepted" } : { state: "attempted" });
			}
			const extra = [...pool.values()].flat();
			f.expectSafe(extra.length === 0, `${s.actor.email}: invoice(s) with no matching sale (duplicate or wrong quantity): ${extra.join(", ")}`);
		}
		await verifyManifest(admin, manifest, before, keys, f);

		// ---- close shifts ----
		for (const s of seats) {
			const closed = await closeLeftoverShiftsDetailed(admin, s.actor);
			f.expectSafe(closed.stuck.length === 0, `${s.actor.email}: could not close the shift afterwards: ${JSON.stringify(closed.stuck)}`);
			s.actor.forgetShift();
		}
		completed = true;
	} finally {
		manifest.save();
		await Promise.all(seats.map((s) => s.actor.context.setOffline(false).catch(() => {})));
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({
			id,
			arrangement,
			outcome,
			notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
			data,
		});
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("OFF-01 — devices sell offline on their own shifts, reconnect together", () => {
	test("OFF-01a — two cashiers, common profile", async ({ cashiers, playwright }) => {
		test.skip(!cashierPassword(1) || !cashierPassword(2), "cashier 01/02 passwords not set in .env.test");
		test.setTimeout(900_000);
		await runOff01(
			"OFF-01a",
			`2 cashiers, one common profile (${PROFILES.P1}), own shift each, ${SALES} offline sales each, reconnect together`,
			[
				{ n: 1, profile: PROFILES.P1, warehouse: WAREHOUSES.A },
				{ n: 2, profile: PROFILES.P1, warehouse: WAREHOUSES.A },
			],
			{ cashiers, playwright },
		);
	});

	test("OFF-01b — two cashiers, different profiles and warehouses", async ({ cashiers, playwright }) => {
		test.skip(!cashierPassword(1) || !cashierPassword(4), "cashier 01/04 passwords not set in .env.test");
		test.setTimeout(900_000);
		await runOff01(
			"OFF-01b",
			`cashier 1 on ${PROFILES.P1} (warehouse A) and cashier 4 on ${PROFILES.P3} (warehouse B), ${SALES} offline sales each, reconnect together`,
			[
				{ n: 1, profile: PROFILES.P1, warehouse: WAREHOUSES.A },
				{ n: 4, profile: PROFILES.P3, warehouse: WAREHOUSES.B },
			],
			{ cashiers, playwright },
		);
	});
});
