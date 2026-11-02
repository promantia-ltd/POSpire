/**
 * OFF-01 at scale: N devices, each selling B bills offline on ITS OWN shift of one
 * common profile, then reconnecting together (or staggered).
 *
 *   OFF_DEVICES    number of devices (browsers), 1..50, default 2     (cashiers 6..)
 *   OFF_BILLS      bills per device, default 20
 *   OFF_STAGGER_S  seconds between each device's reconnect, default 0 (all together)
 *
 * Stage A: OFF_DEVICES=2  OFF_BILLS=20
 * Stage B: OFF_DEVICES=5  OFF_BILLS=50
 * Stage C: OFF_DEVICES=10 OFF_BILLS=100   (the ticket's 1,000-bill recovery run)
 *
 * Same checks as OFF-01: every accepted sale becomes exactly one submitted invoice on
 * the right cashier's shift (quantities 1..3 repeating, so a lost, duplicated, swapped
 * or merged sale shows up), queues end empty, stock falls by exactly what was sold, the
 * ledger balances. Also recorded: queueing time, per-device and full drain time, and the
 * load machine's CPU and free memory while it ran, because ten browsers on one machine
 * can slow each other down. The ticket's target is 1,000 bills fully submitted and
 * acknowledged within 10 minutes of reconnecting; it is reported, not assumed.
 */

import os from "node:os";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { ensureStock } from "./helpers/admin-fixtures";
import { getDoc, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { waitForOutboxDrain } from "./helpers/outbox";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const DEVICES = Math.min(50, Math.max(1, Number(process.env.OFF_DEVICES ?? 2)));
const BILLS = Math.max(1, Number(process.env.OFF_BILLS ?? 20));
const STAGGER_S = Math.max(0, Number(process.env.OFF_STAGGER_S ?? 0));
const RATE = 1000;
const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const qtyOf = (j: number) => (j % 3) + 1;
const UNITS_PER_DEVICE = Array.from({ length: BILLS }, (_, j) => qtyOf(j)).reduce((a, b) => a + b, 0);

const log = (m: string) => console.log(`[OFF-SCALE ${new Date().toISOString().slice(11, 19)}] ${m}`);
const pct = (xs: number[], p: number) => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(FIRST_BURST_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

test(`OFF-SCALE-${DEVICES}x${BILLS}${STAGGER_S ? `-stagger${STAGGER_S}` : ""} — ${DEVICES} devices x ${BILLS} offline bills`, async ({ cashiers, playwright }) => {
	const id = `OFF-SCALE-${DEVICES}x${BILLS}${STAGGER_S ? `-stagger${STAGGER_S}` : ""}`;
	// queueing on screen + a drain of roughly 8 s per bill per device + checking
	test.setTimeout(Math.max(900_000, (BILLS * 12 + BILLS * 10 + 300) * 1000));
	const admin = await newAdminContext(playwright);
	const manifest = new Manifest();
	const f = new Findings();
	const data: Record<string, unknown> = { devices: DEVICES, billsPerDevice: BILLS, totalBills: DEVICES * BILLS, staggerSeconds: STAGGER_S };
	let completed = false;
	let actors: Actor[] = [];
	const shifts = new Map<string, string>();
	const sampler: { maxLoad1: number; minFreeMb: number; timer?: NodeJS.Timeout } = { maxLoad1: 0, minFreeMb: Infinity };
	const sample = () => {
		sampler.maxLoad1 = Math.max(sampler.maxLoad1, os.loadavg()[0]);
		sampler.minFreeMb = Math.min(sampler.minFreeMb, os.freemem() / 1048576);
	};

	try {
		const need = DEVICES * UNITS_PER_DEVICE;
		const stock = await ensureStock(admin, { company: COMPANY, item: ITEMS.stock, warehouse: WAREHOUSES.A, qty: need + 500, rate: 600 });
		f.note(`fixture: ${ITEMS.stock} in ${WAREHOUSES.A} was ${stock.before}, restocked ${stock.added} (this run sells ${need} units)`);

		const numbers = Array.from({ length: DEVICES }, (_, i) => FIRST_BURST_CASHIER + i);
		actors = await inChunks(numbers, 5, (n) => cashiers.login(n));
		for (const a of actors) a.page.setDefaultTimeout(30_000);
		for (const a of actors) {
			const left = await closeLeftoverShifts(admin, a);
			if (left.length) f.note(`closed leftover shift(s) for ${a.email}: ${left.join(", ")}`);
		}
		await inChunks(actors, 5, (a) => a.openShift(PROFILES.P1, "0"));
		for (const a of actors) {
			const [s] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
			f.check(Boolean(s), `${a.email} has no open shift after opening`);
			if (s) shifts.set(a.email, s.name);
		}
		if (shifts.size !== actors.length) throw new Error("not every device has a shift");
		const before = await snapshotBins(admin, KEYS);
		log(`${DEVICES} devices have shifts; going offline and queueing ${BILLS} bills each`);

		// ---- offline: every device queues its bills (devices work in parallel) ----
		await Promise.all(actors.map((a) => a.context.setOffline(true)));
		sampler.timer = setInterval(sample, 5_000);
		const tQueue = Date.now();
		const depths = await Promise.all(actors.map((a) => sellOffline(a.page, ITEMS.stock, Array.from({ length: BILLS }, (_, j) => qtyOf(j)))));
		data.queueingMs = Date.now() - tQueue;
		let queuedTotal = 0;
		actors.forEach((a, i) => {
			const q = depths[i][BILLS - 1] ?? 0;
			queuedTotal += q;
			f.check(q >= BILLS, `${a.email}: only ${q}/${BILLS} bills were queued while offline`);
		});
		data.queuedTotal = queuedTotal;
		f.note(`queued ${queuedTotal}/${DEVICES * BILLS} bills in ${Math.round((data.queueingMs as number) / 1000)} s`);
		const early = (await Promise.all(actors.map((a) => invoicesOnShift(admin, shifts.get(a.email)!)))).flat();
		f.check(early.length === 0, `the server already has ${early.length} invoice(s) before reconnecting; the bills were not held offline`);

		// ---- reconnect (together, or staggered) ----
		log(`reconnecting${STAGGER_S ? ` ${STAGGER_S} s apart` : " all at once"}`);
		const t0 = Date.now();
		await Promise.all(
			actors.map(async (a, i) => {
				if (STAGGER_S) await new Promise((r) => setTimeout(r, i * STAGGER_S * 1000));
				await a.context.setOffline(false);
			}),
		);
		const drainLimit = Math.max(240_000, BILLS * 20_000);
		const drains = await Promise.all(actors.map((a) => waitForOutboxDrain(a.page, drainLimit, 2_000)));
		const fullMs = Date.now() - t0;
		sample();
		clearInterval(sampler.timer);
		data.fullDrainMs = fullMs;
		data.drain = actors.map((a, i) => ({ cashier: a.email, ms: drains[i].ms, drained: drains[i].drained, rows: drains[i].rows.length }));
		data.generator = { maxLoad1: Math.round(sampler.maxLoad1 * 100) / 100, minFreeMemMb: Math.round(sampler.minFreeMb), cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576) };
		const per = drains.map((d) => d.ms);
		f.note(`every queue drained ${Math.round(fullMs / 1000)} s after the first reconnect (per device: min ${Math.round(Math.min(...per) / 1000)} s, p50 ${Math.round(pct(per, 50) / 1000)} s, max ${Math.round(Math.max(...per) / 1000)} s)`);
		f.note(`load machine while running: peak 1-minute load ${(data.generator as any).maxLoad1} on ${(data.generator as any).cpus} CPUs; lowest free memory ${(data.generator as any).minFreeMemMb} MB of ${(data.generator as any).totalMemMb} MB`);
		const target = 600_000;
		f.note(`the ticket's target for 1,000 bills is a full drain within 600 s of reconnecting: this run took ${Math.round(fullMs / 1000)} s for ${DEVICES * BILLS} bills`);
		data.meetsTenMinuteTarget = fullMs <= target;
		drains.forEach((d, i) => {
			f.check(d.drained, `${actors[i].email}: the queue did not drain within ${Math.round(drainLimit / 1000)} s`);
			f.expectSafe(d.needsAttention.length === 0, `${actors[i].email}: queue ended needing attention: ${JSON.stringify(d.needsAttention.slice(0, 3))}`);
		});

		// ---- what the server ended up with, per device ----
		log("checking the server");
		for (const a of actors) {
			const shift = shifts.get(a.email)!;
			let onShift = await invoicesOnShift(admin, shift);
			for (let i = 0; i < 60 && onShift.filter((x) => x.docstatus === 1).length < BILLS; i++) {
				await a.page.waitForTimeout(1_000);
				onShift = await invoicesOnShift(admin, shift);
			}
			const submitted = onShift.filter((x) => x.docstatus === 1);
			f.expectSafe(submitted.length === BILLS, `${a.email}: ${submitted.length} submitted invoices for ${BILLS} bills (lost or duplicated)`);
			f.expectSafe(onShift.every((x) => x.docstatus === 1), `${a.email}: draft/cancelled invoice(s) left on the shift: ${onShift.filter((x) => x.docstatus !== 1).slice(0, 5).map((x) => x.name).join(", ")}`);
			for (const inv of submitted) f.expectSafe(inv.owner === a.email, `${inv.name} on ${a.email}'s shift is owned by ${inv.owner}`);
			const ids = submitted.map((x) => x.pos_offline_id).filter(Boolean);
			f.expectSafe(new Set(ids).size === ids.length, `${a.email}: two invoices share an offline id`);

			const pool = new Map<number, string[]>();
			for (const inv of submitted) {
				const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
				const qty = (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				pool.set(qty, [...(pool.get(qty) ?? []), inv.name]);
			}
			for (let j = 0; j < BILLS; j++) {
				const qty = qtyOf(j);
				const name = pool.get(qty)?.shift();
				const sale = manifest.add({ txnId: newTxnId("offscale"), cashier: a.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, items: [{ item_code: ITEMS.stock, qty, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE * qty }], expectedGrandTotal: RATE * qty, openingShift: shift, invoice: name });
				manifest.update(sale.txnId, name ? { state: "accepted" } : { state: "attempted" });
			}
			const extra = [...pool.values()].flat();
			f.expectSafe(extra.length === 0, `${a.email}: invoice(s) with no matching bill (duplicate or wrong quantity): ${extra.slice(0, 5).join(", ")}`);
		}
		await verifyManifest(admin, manifest, before, KEYS, f);

		// ---- close shifts ----
		for (const a of actors) {
			const closed = await closeLeftoverShiftsDetailed(admin, a);
			f.expectSafe(closed.stuck.length === 0, `${a.email}: could not close the shift afterwards: ${JSON.stringify(closed.stuck)}`);
			a.forgetShift();
		}
		completed = true;
	} finally {
		if (sampler.timer) clearInterval(sampler.timer);
		manifest.save();
		await Promise.all(actors.map((a) => a.context.setOffline(false).catch(() => {})));
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({
			id,
			arrangement: `${DEVICES} devices (cashiers ${FIRST_BURST_CASHIER}..${FIRST_BURST_CASHIER + DEVICES - 1}), one common profile (${PROFILES.P1}), own shift each, ${BILLS} offline bills each, reconnect ${STAGGER_S ? `${STAGGER_S} s apart` : "together"}`,
			outcome,
			notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
			data,
		});
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
});
