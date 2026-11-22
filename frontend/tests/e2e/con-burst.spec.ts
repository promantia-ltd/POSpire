/**
 * CON-06 (P0): a burst of many cashiers on ONE POS Profile, each on their own
 * shift, all selling at the same moment.
 *
 * N cashiers (10, 25, 50; override with PERF_BURST_SIZES="10,25") log in, open
 * a shift each on PERF-P1, create a draft each, then submit one cash sale of one
 * unit each, with every create and every submit released together. Run as
 * headless API sessions (api-seat.ts): each is a real login with its own session
 * and CSRF token sending what the screen sends. 50 browser windows would test
 * the machine running them, not the server.
 *
 * Expected: every sale is accepted exactly once, lands on ITS cashier's shift
 * and is owned by that cashier, stock falls by exactly N units, the ledger
 * balances, and no request fails with a 5xx or times out. The timings (p50/p95/
 * max, wall time, throughput) are recorded per step so the point where latency
 * or failures start is visible.
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { type ApiSeat, loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { errorText, type AsUserResult } from "./helpers/as-user";
import { binQty, getDoc, getList, newAdminContext } from "./helpers/backend";
import { Barrier, commonOverlapMs, type Span } from "./helpers/barrier";
import { ensureStock } from "./helpers/admin-fixtures";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { Manifest, newTxnId } from "./helpers/manifest";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;
const SIZES = (process.env.PERF_BURST_SIZES ?? "10,25,50")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter((n) => n > 0 && n <= 50);

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(FIRST_BURST_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test (seed with burst=50)");
});

interface Timed {
	res: AsUserResult | null;
	error?: string;
	ms: number;
	span: Span;
}

async function timed(fn: () => Promise<AsUserResult>): Promise<Timed> {
	const start = performance.now();
	try {
		const res = await fn();
		const end = performance.now();
		return { res, ms: end - start, span: { start, end } };
	} catch (e) {
		const end = performance.now();
		return { res: null, error: String(e).split("\n")[0], ms: end - start, span: { start, end } };
	}
}

/** Run `fn` over `items`, `size` at a time (setup work that is not part of the burst). */
async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

const pct = (xs: number[], p: number) => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (ts: Timed[]) => ({
	count: ts.length,
	p50_ms: Math.round(pct(ts.map((t) => t.ms), 50)),
	p95_ms: Math.round(pct(ts.map((t) => t.ms), 95)),
	max_ms: Math.round(Math.max(0, ...ts.map((t) => t.ms))),
});
const statusOf = (t: Timed) => (t.res ? t.res.status : 0);
const histogram = (ts: Timed[]) => {
	const h: Record<string, number> = {};
	for (const t of ts) h[String(statusOf(t))] = (h[String(statusOf(t))] ?? 0) + 1;
	return h;
};

test.describe("CON-06 — burst of cashiers on one profile", () => {
	for (const N of SIZES) {
		test(`CON-06 — ${N} cashiers sell at the same moment`, async ({ playwright }) => {
			test.setTimeout(900_000);
			const admin = await newAdminContext(playwright);
			const manifest = new Manifest();
			const f = new Findings();
			let completed = false;
			const data: Record<string, unknown> = { cashiers: N };
			const seats: ApiSeat[] = [];
			const numbers = Array.from({ length: N }, (_, i) => FIRST_BURST_CASHIER + i);

			try {
				const stock = await ensureStock(admin, { company: COMPANY, item: ITEMS.stock, warehouse: WAREHOUSES.A, qty: 100 + N, rate: 600 });
				f.note(`fixture: ${ITEMS.stock} in ${WAREHOUSES.A} was ${stock.before}, restocked ${stock.added}`);
				const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);

				// ---- setup (not part of the measurement): sessions, clean slate, one shift each ----
				const t0 = performance.now();
				seats.push(...(await inChunks(numbers, 10, (n) => loginApiSeat(playwright, n))));
				data.loginAllMs = Math.round(performance.now() - t0);

				const stuckAtStart = (await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false })))
					.flatMap((r) => r.stuck);
				f.check(stuckAtStart.length === 0, `could not clear leftover shifts: ${JSON.stringify(stuckAtStart)}`);

				const opened = await inChunks(seats, 10, async (s) => ({ s, t: await timed(async () => (await openShiftApi(s, COMPANY, PROFILES.P1)).result) }));
				const shifts = new Map<string, string>();
				for (const { s, t } of opened) {
					const name = t.res?.json?.message?.pos_opening_shift?.name as string | undefined;
					f.check(Boolean(name), `${s.email}: could not open a shift (${t.error ?? `HTTP ${statusOf(t)} ${t.res ? errorText(t.res) : ""}`})`);
					if (name) shifts.set(s.email, name);
				}
				data.openShift = stats(opened.map((o) => o.t));
				f.check(shifts.size === N, `only ${shifts.size}/${N} shifts opened`);
				if (shifts.size !== N) throw new Error("not every cashier has a shift; the burst cannot be run");

				const before = await snapshotBins(admin, KEYS);
				const offlineIds = new Map(seats.map((s) => [s.email, randomUUID()]));
				const sales = new Map(
					seats.map((s) => [
						s.email,
						manifest.add({
							txnId: newTxnId("con06"),
							cashier: s.email,
							company: COMPANY,
							posProfile: PROFILES.P1,
							warehouse: WAREHOUSES.A,
							items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }],
							payments: [{ mode_of_payment: "Cash", amount: RATE }],
							expectedGrandTotal: RATE,
							openingShift: shifts.get(s.email)!,
							offlineId: offlineIds.get(s.email),
						}),
					]),
				);

				// ---- burst 1: every cashier creates its draft at the same moment ----
				const gate1 = new Barrier(N, 120_000);
				const wall1 = performance.now();
				const drafts = await Promise.all(
					seats.map(async (s) => {
						await gate1.wait();
						let doc: Record<string, any> | null = null;
						const t = await timed(async () => {
							const r = await createDraft(
								s.actor,
								buildInvoice({
									company: COMPANY,
									posProfile: PROFILES.P1,
									customer: profile?.customer,
									shift: shifts.get(s.email)!,
									items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }],
								}),
							);
							doc = r.doc;
							return r.res;
						});
						return { s, t, doc: doc as Record<string, any> | null };
					}),
				);
				const draftWallMs = performance.now() - wall1;
				const draftTimes = drafts.map((d) => d.t);
				data.createDraft = { ...stats(draftTimes), wall_ms: Math.round(draftWallMs), statuses: histogram(draftTimes), overlap_ms: Math.round(commonOverlapMs(draftTimes.map((t) => t.span))) };
				f.note(`${N} simultaneous drafts: ${JSON.stringify(data.createDraft)}`);
				f.expectSafe(draftTimes.every((t) => statusOf(t) > 0 && statusOf(t) < 500), `uncontrolled error or timeout creating drafts: ${JSON.stringify(histogram(draftTimes))}`);
				f.expectSafe(drafts.every((d) => d.doc?.name), `${drafts.filter((d) => !d.doc?.name).length} of ${N} drafts could not be created`);

				// ---- burst 2: every cashier submits its sale at the same moment ----
				const ready = drafts.filter((d) => d.doc?.name);
				const gate2 = new Barrier(ready.length, 120_000);
				const wall2 = performance.now();
				const submits = await Promise.all(
					ready.map(async ({ s, doc }) => {
						await gate2.wait();
						const t = await timed(() => submitDraft(s.actor, doc!, { cashAmount: RATE, offlineId: offlineIds.get(s.email) }));
						return { s, t };
					}),
				);
				const submitWallMs = performance.now() - wall2;
				const submitTimes = submits.map((x) => x.t);
				const overlap = commonOverlapMs(submitTimes.map((t) => t.span));
				data.submit = {
					...stats(submitTimes),
					wall_ms: Math.round(submitWallMs),
					throughput_per_s: Number((submits.length / (submitWallMs / 1000)).toFixed(2)),
					statuses: histogram(submitTimes),
					overlap_ms: Math.round(overlap),
				};
				f.note(`${submits.length} simultaneous submits: ${JSON.stringify(data.submit)}`);
				f.check(overlap > 0, `the ${submits.length} submits did not all overlap (common overlap ${overlap.toFixed(0)} ms)`);
				f.expectSafe(submitTimes.every((t) => statusOf(t) > 0 && statusOf(t) < 500), `uncontrolled error or timeout on submit: ${JSON.stringify(histogram(submitTimes))}`);
				for (const { s, t } of submits.filter((x) => statusOf(x.t) !== 200).slice(0, 10)) {
					f.note(`${s.email}: submit failed: ${t.error ?? `HTTP ${statusOf(t)} ${t.res ? errorText(t.res) : ""}`}`);
				}
				f.expectSafe(
					submitTimes.every((t) => statusOf(t) === 200),
					`${submitTimes.filter((t) => statusOf(t) !== 200).length} of ${submits.length} sales were not accepted (every cashier had its own shift and enough stock)`,
				);

				for (const { s, t } of submits) {
					const sale = sales.get(s.email)!;
					const invoice = t.res?.json?.message?.name ?? t.res?.json?.message?.invoice?.name;
					manifest.update(sale.txnId, statusOf(t) === 200 ? { state: "accepted", invoice } : { state: "rejected" });
				}
				for (const { s } of drafts.filter((d) => !d.doc?.name)) manifest.update(sales.get(s.email)!.txnId, { state: "rejected" });

				// ---- every sale on its own cashier's shift, exactly once, books balanced ----
				const accepted = manifest.all().filter((x) => x.state === "accepted").length;
				const names = manifest.all().map((x) => x.invoice).filter(Boolean);
				f.expectSafe(new Set(names).size === names.length, `two cashiers were given the same invoice: ${JSON.stringify(names)}`);
				const byOfflineId = await getList<{ name: string; owner: string; posa_pos_opening_shift: string; docstatus: number; pos_offline_id: string }>(
					admin,
					"Sales Invoice",
					{ pos_offline_id: ["in", [...offlineIds.values()]] },
					["name", "owner", "posa_pos_opening_shift", "docstatus", "pos_offline_id"],
					500,
				);
				f.expectSafe(byOfflineId.length === accepted, `${byOfflineId.length} invoices exist for ${accepted} accepted sales (lost or duplicated)`);
				for (const inv of byOfflineId) {
					const owner = [...offlineIds.entries()].find(([, id]) => id === inv.pos_offline_id)?.[0];
					f.expectSafe(inv.owner === owner, `${inv.name} (cashier ${owner}) is owned by ${inv.owner}`);
					f.expectSafe(inv.posa_pos_opening_shift === shifts.get(owner ?? ""), `${inv.name} is on shift ${inv.posa_pos_opening_shift}, not ${shifts.get(owner ?? "")}`);
				}
				await verifyManifest(admin, manifest, before, KEYS, f);
				f.note(`on hand after the burst: ${await binQty(admin, ITEMS.stock, WAREHOUSES.A)} (was ${before.values().next().value})`);

				// ---- close every shift ----
				const closed = await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }));
				const stuck = closed.flatMap((r) => r.stuck);
				f.expectSafe(stuck.length === 0, `${stuck.length} shift(s) could not be closed: ${JSON.stringify(stuck.slice(0, 5))}`);
				completed = true;
			} finally {
				manifest.save();
				// A failed run must not leave 50 open shifts behind for the next one.
				await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }).catch(() => null));
				await Promise.all(seats.map((s) => s.dispose().catch(() => {})));
				if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
				const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
				recordEvidence({
					id: `CON-06 (${N})`,
					arrangement: `${N} cashiers, one POS Profile, one shift each, drafts then submits released together (headless API sessions)`,
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
