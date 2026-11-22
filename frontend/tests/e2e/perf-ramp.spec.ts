/**
 * PERF-RAMP (P0): N cashiers on one POS Profile, each on their own shift, selling at a
 * steady pace (not a single simultaneous burst) for a fixed time.
 *
 * Each cashier loops: build a cart of 1-3 PERF-LINE items (qty 1-2), save the draft, submit
 * it with exact cash, wait 1-3 s, repeat until the stage time is up. Headless API sessions
 * (api-seat.ts): real logins, own CSRF token, same calls as the screen. One browser window
 * per cashier would measure this machine, not the server.
 *
 *   PERF_RAMP_STAGES   cashiers per stage, one test each   (default "5,10,25,50")
 *   PERF_RAMP_SECONDS  length of a stage in seconds         (default 120)
 *   PERF_RAMP_THINK_MIN_MS / PERF_RAMP_THINK_MAX_MS  pause between a cashier's sales
 *                      (default 1000 / 3000 = saturation; the ticket's realistic cadence of
 *                      about one sale per cashier per minute is 30000 / 90000)
 *
 * Correctness (defects): every accepted sale exists exactly once, on its cashier's shift,
 * owned by that cashier, with the right total, stock moved by exactly the units sold, and a
 * balanced ledger. Targets (recorded, not asserted): p95 of a whole sale (draft + submit)
 * <= 3000 ms and error rate < 1%. A stage that misses a target is reported as
 * "supported with restrictions" with the numbers, so the ramp shows where it starts to bend.
 * Everything runs on ONE machine (server + load), so the numbers show shape, not capacity.
 */

import os from "node:os";
import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { type ApiSeat, loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { deleteDrafts } from "./helpers/admin-fixtures";
import { errorText, type AsUserResult } from "./helpers/as-user";
import { getDoc, getList, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { Manifest, newTxnId } from "./helpers/manifest";
import { snapshotBins, type StockKey } from "./helpers/reconcile";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const STAGES = (process.env.PERF_RAMP_STAGES ?? "5,10,25,50")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter((n) => n > 0 && n <= 50);
const SECONDS = Number(process.env.PERF_RAMP_SECONDS ?? 120);
const THINK_MIN = Number(process.env.PERF_RAMP_THINK_MIN_MS ?? 1000);
const THINK_MAX = Number(process.env.PERF_RAMP_THINK_MAX_MS ?? 3000);
const P95_TARGET_MS = 3000;
const ERROR_TARGET = 0.01;
const ITEM_COUNT = 100;
const KEYS: StockKey[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ item: `PERF-LINE-${String(i + 1).padStart(3, "0")}`, warehouse: WAREHOUSES.A }));

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(FIRST_BURST_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

const rateOf = (n: number) => 50 + 10 * (n % 37);
const pct = (xs: number[], p: number) => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

interface Sale {
	email: string;
	txnId: string;
	draftMs: number;
	submitMs: number;
	totalMs: number;
	at: number; // seconds into the stage
	status: number; // 200 = accepted
	step: "draft" | "submit";
	error?: string;
	invoice?: string;
	draftName?: string;
}

test.describe("PERF-RAMP — steady load on one profile", () => {
	for (const N of STAGES) {
		test(`PERF-RAMP — ${N} cashiers for ${SECONDS} s`, async ({ playwright }) => {
			test.setTimeout(SECONDS * 1000 + 600_000);
			const admin = await newAdminContext(playwright);
			const manifest = new Manifest();
			const f = new Findings();
			const data: Record<string, unknown> = { cashiers: N, seconds: SECONDS, thinkMs: [THINK_MIN, THINK_MAX] };
			const seats: ApiSeat[] = [];
			const numbers = Array.from({ length: N }, (_, i) => FIRST_BURST_CASHIER + i);
			const strayDrafts: string[] = [];
			let completed = false;

			try {
				const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
				const before = await snapshotBins(admin, KEYS);
				f.check([...before.values()].every((q) => q >= 300), `fixture stock is low: min ${Math.min(...before.values())}`);

				seats.push(...(await inChunks(numbers, 10, (n) => loginApiSeat(playwright, n))));
				const stuck = (await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }))).flatMap((r) => r.stuck);
				f.check(stuck.length === 0, `could not clear leftover shifts: ${JSON.stringify(stuck)}`);
				const shifts = new Map<string, string>();
				for (const s of seats) {
					const r = await openShiftApi(s, COMPANY, PROFILES.P1);
					if (r.shift) shifts.set(s.email, r.shift);
					else f.check(false, `${s.email}: could not open a shift: ${r.error}`);
				}
				if (shifts.size !== N) throw new Error(`only ${shifts.size}/${N} shifts opened`);

				// ---- the stage ----
				const sales: Sale[] = [];
				const loads: number[] = [];
				const sampler = setInterval(() => loads.push(os.loadavg()[0]), 5_000);
				const startedAt = performance.now();
				data.startedAtMs = Date.now();
				const deadline = startedAt + SECONDS * 1000;
				data.loadavgStart = os.loadavg();
				await Promise.all(
					seats.map(async (s) => {
						await sleep(rnd(0, Math.max(2000, THINK_MAX))); // do not start in lockstep
						while (performance.now() < deadline) {
							const lines = Array.from(new Set(Array.from({ length: rnd(1, 3) }, () => rnd(1, ITEM_COUNT)))).map((n) => ({
								n,
								item_code: `PERF-LINE-${String(n).padStart(3, "0")}`,
								qty: rnd(1, 2),
								rate: rateOf(n),
							}));
							const total = lines.reduce((t, l) => t + l.qty * l.rate, 0);
							const offlineId = randomUUID();
							const sale = manifest.add({
								txnId: newTxnId("ramp"),
								cashier: s.email,
								company: COMPANY,
								posProfile: PROFILES.P1,
								warehouse: WAREHOUSES.A,
								customer: profile?.customer,
								items: lines.map(({ item_code, qty, rate }) => ({ item_code, qty, rate })),
								payments: [{ mode_of_payment: "Cash", amount: total }],
								expectedGrandTotal: total,
								openingShift: shifts.get(s.email)!,
								offlineId,
							});
							const rec: Sale = { email: s.email, txnId: sale.txnId, draftMs: 0, submitMs: 0, totalMs: 0, at: Math.round((performance.now() - startedAt) / 1000), status: 0, step: "draft" };
							const t0 = performance.now();
							let draft: Record<string, any> | null = null;
							try {
								const d = await createDraft(
									s.actor,
									buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift: shifts.get(s.email)!, items: lines.map(({ item_code, qty, rate }) => ({ item_code, qty, rate })) }),
								);
								rec.draftMs = performance.now() - t0;
								rec.status = d.res.status;
								if (d.doc?.name) draft = d.doc;
								else rec.error = `draft HTTP ${d.res.status} ${errorText(d.res)}`.slice(0, 200);
							} catch (e) {
								rec.draftMs = performance.now() - t0;
								rec.error = `draft ${String(e).split("\n")[0]}`.slice(0, 200);
							}
							if (draft) {
								rec.step = "submit";
								rec.draftName = draft.name;
								const t1 = performance.now();
								let res: AsUserResult | null = null;
								try {
									res = await submitDraft(s.actor, draft, { cashAmount: total, offlineId });
									rec.status = res.status;
									if (res.status === 200) rec.invoice = res.json?.message?.name ?? res.json?.message?.invoice?.name;
									else rec.error = `submit HTTP ${res.status} ${errorText(res)}`.slice(0, 200);
								} catch (e) {
									rec.error = `submit ${String(e).split("\n")[0]}`.slice(0, 200);
								}
								rec.submitMs = performance.now() - t1;
							}
							rec.totalMs = performance.now() - t0;
							const ok = rec.status === 200 && Boolean(rec.invoice);
							manifest.update(sale.txnId, ok ? { state: "accepted", invoice: rec.invoice } : { state: "rejected" });
							if (!ok && rec.draftName) strayDrafts.push(rec.draftName);
							sales.push(rec);
							await sleep(rnd(THINK_MIN, THINK_MAX)); // think time
						}
					}),
				);
				clearInterval(sampler);
				const wallS = (performance.now() - startedAt) / 1000;
				data.endedAtMs = Date.now();
				data.loadavgEnd = os.loadavg();
				data.maxLoad1m = Number(Math.max(0, ...loads).toFixed(2));
				data.freeMemMB = Math.round(os.freemem() / 1e6);

				// ---- numbers ----
				const ok = sales.filter((x) => x.status === 200 && x.invoice);
				const failed = sales.filter((x) => !(x.status === 200 && x.invoice));
				const totals = ok.map((x) => x.totalMs);
				const subs = ok.map((x) => x.submitMs);
				const errorRate = sales.length ? failed.length / sales.length : 0;
				const stat = (xs: number[]) => ({ p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), p99: Math.round(pct(xs, 99)), max: Math.round(Math.max(0, ...xs)) });
				const thirds = [0, 1, 2].map((i) => ok.filter((x) => x.at >= (i * SECONDS) / 3 && x.at < ((i + 1) * SECONDS) / 3).map((x) => x.totalMs));
				data.attempted = sales.length;
				data.accepted = ok.length;
				data.failed = failed.length;
				data.errorRate = Number(errorRate.toFixed(4));
				data.saleMs = stat(totals);
				data.submitMs = stat(subs);
				data.draftMs = stat(ok.map((x) => x.draftMs));
				data.p95ByThirdMs = thirds.map((t) => Math.round(pct(t, 95)));
				data.throughputPerS = Number((ok.length / wallS).toFixed(2));
				data.wallS = Math.round(wallS);
				data.failureSamples = failed.slice(0, 8).map((x) => `${x.email}@${x.at}s ${x.error}`);
				f.note(`${N} cashiers, ${SECONDS} s: ${sales.length} sales attempted, ${ok.length} accepted, ${failed.length} failed (${(errorRate * 100).toFixed(2)}%); whole sale p50/p95/p99 ${JSON.stringify(data.saleMs)} ms; throughput ${data.throughputPerS}/s; load avg max ${data.maxLoad1m}`);
				f.note(`p95 by thirds of the stage (ms): ${JSON.stringify(data.p95ByThirdMs)}`);
				for (const s of data.failureSamples as string[]) f.note(`failure: ${s}`);
				const p95 = pct(totals, 95);
				data.targets = { p95Ms: P95_TARGET_MS, errorRate: ERROR_TARGET, p95Met: p95 <= P95_TARGET_MS, errorsMet: errorRate < ERROR_TARGET };
				f.note(`targets: p95 ${Math.round(p95)} ms vs ${P95_TARGET_MS} -> ${p95 <= P95_TARGET_MS ? "met" : "MISSED"}; errors ${(errorRate * 100).toFixed(2)}% vs ${ERROR_TARGET * 100}% -> ${errorRate < ERROR_TARGET ? "met" : "MISSED"}`);

				// ---- correctness ----
				f.check(sales.length > 0, "no sale was attempted");
				f.expectSafe(failed.every((x) => x.status > 0 && x.status < 500), `server errors (5xx) or timeouts: ${JSON.stringify(failed.filter((x) => x.status === 0 || x.status >= 500).slice(0, 5).map((x) => x.error))}`);
				const names = ok.map((x) => x.invoice);
				f.expectSafe(new Set(names).size === names.length, "two sales were given the same invoice");
				const offlineIds = manifest.all().filter((x) => x.state === "accepted").map((x) => x.offlineId!);
				const stored: { name: string; owner: string; posa_pos_opening_shift: string; docstatus: number; pos_offline_id: string }[] = [];
				for (let i = 0; i < offlineIds.length; i += 40) {
					stored.push(...(await getList(admin, "Sales Invoice", { pos_offline_id: ["in", offlineIds.slice(i, i + 40)] }, ["name", "owner", "posa_pos_opening_shift", "docstatus", "pos_offline_id"], 500)));
				}
				f.expectSafe(stored.length === ok.length, `${stored.length} invoices exist for ${ok.length} accepted sales (lost or duplicated)`);
				const byId = new Map(manifest.all().map((x) => [x.offlineId, x]));
				for (const inv of stored) {
					const sale = byId.get(inv.pos_offline_id);
					f.expectSafe(inv.owner === sale?.cashier, `${inv.name} (cashier ${sale?.cashier}) is owned by ${inv.owner}`);
					f.expectSafe(inv.posa_pos_opening_shift === sale?.openingShift, `${inv.name} is on shift ${inv.posa_pos_opening_shift}, not ${sale?.openingShift}`);
				}
				await verifyManifest(admin, manifest, before, KEYS, f);

				// ---- tidy: drafts left by failed sales, then close every shift ----
				if (strayDrafts.length) {
					const left = await deleteDrafts(admin, strayDrafts);
					f.note(`deleted ${strayDrafts.length} draft(s) left by failed sales (${left.length} could not be deleted)`);
				}
				const closed = await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }));
				const stillOpen = closed.flatMap((r) => r.stuck);
				f.expectSafe(stillOpen.length === 0, `${stillOpen.length} shift(s) could not be closed: ${JSON.stringify(stillOpen.slice(0, 3))}`);
				completed = true;
			} finally {
				manifest.save();
				if (strayDrafts.length) await deleteDrafts(admin, strayDrafts).catch(() => {});
				await inChunks(seats, 10, (s) => closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }).catch(() => null));
				await Promise.all(seats.map((s) => s.dispose().catch(() => {})));
				if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
				const t = data.targets as { p95Met: boolean; errorsMet: boolean } | undefined;
				const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : t && t.p95Met && t.errorsMet ? "supported" : "supported_with_restrictions";
				recordEvidence({
					id: `PERF-RAMP (${N})`,
					arrangement: `${N} cashiers, one POS Profile, one shift each, paced sales (${THINK_MIN / 1000}-${THINK_MAX / 1000} s think time) for ${SECONDS} s, headless API sessions on the same machine as the server`,
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
