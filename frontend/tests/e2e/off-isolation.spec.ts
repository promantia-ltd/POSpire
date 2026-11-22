/**
 * OFF-06 (P0): one device keeps selling online while others drain backlogs, and
 * one queued bill is invalid.
 *
 *   A (cashier 1)  online; sells normally the whole time (the interactive device)
 *   B (cashier 2)  offline backlog of 4 bills, ONE of them invalid, then closes its shift
 *                  offline (the closing is a dependant of every bill of the shift)
 *   C (cashier 4)  offline backlog of 4 valid bills, another profile and warehouse
 *
 * B and C reconnect together while A keeps selling. The invalid bill is a real
 * server-side rejection: the request for the bill of quantity 3 is sent with an item
 * code that does not exist, so the server itself refuses it.
 *
 * Expected (ticket): A's billing stays usable (every sale succeeds; response times are
 * recorded and compared with A's own baseline); every VALID backlog bill reaches the
 * server exactly once; the invalid bill never becomes an invoice and stays visible with
 * a way to recover it; B's closing, which depends on it, stays visible and does not
 * pretend the shift is complete. Recovery is then demonstrated with the real recovery
 * API (a manager voids the bad bill) and the closing is watched.
 *
 * "Billing stays usable" threshold (proposed, to be agreed): no failed sale, and A's
 * median sale time during the drain not above 3x its baseline AND over 5 s.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Barrier } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { outboxRows, type OutboxRow } from "./helpers/outbox";
import { closeShift, prepareCashSale, attemptSubmit } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const KEYS = [
	{ item: ITEMS.stock, warehouse: WAREHOUSES.A },
	{ item: ITEMS.stock, warehouse: WAREHOUSES.B },
];
const RATE = 1000;
const REPLAY = /api\.offline\.submit_invoice/;
const RECOVERY = "POSpire Offline Sync Review";
const BACKLOG = [1, 2, 3, 4];
const BAD_QTY = 3;
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1) || !cashierPassword(2) || !cashierPassword(4), "cashier 01/02/04 passwords not set in .env.test");
});

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)] : 0);

async function waitRows(page: Actor["page"], pred: (rows: OutboxRow[]) => boolean, timeoutMs: number) {
	const t0 = Date.now();
	let rows: OutboxRow[] = [];
	while (Date.now() - t0 < timeoutMs) {
		rows = (await outboxRows(page)) ?? [];
		if (pred(rows)) return { ok: true, rows, ms: Date.now() - t0 };
		await page.waitForTimeout(1_000);
	}
	return { ok: false, rows, ms: Date.now() - t0 };
}

test("OFF-06 — one device sells online while others drain; one invalid bill in the queue", async ({ cashiers, playwright }) => {
	test.setTimeout(1_200_000);
	const admin = await newAdminContext(playwright);
	const manifest = new Manifest();
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	const actors: Actor[] = [];
	const reviewsBefore = new Set<string>();

	try {
		const [a, b, c] = await Promise.all([cashiers.login(1), cashiers.login(2), cashiers.login(4)]);
		actors.push(a, b, c);
		for (const x of actors) {
			const left = await closeLeftoverShifts(admin, x);
			if (left.length) f.note(`closed leftover shift(s) for ${x.email}: ${left.join(", ")}`);
		}
		await Promise.all([a.openShift(PROFILES.P1, "0"), b.openShift(PROFILES.P1, "0"), c.openShift(PROFILES.P3, "0")]);
		const shiftOf = async (x: Actor) => (await listOpeningShifts(admin, { user: x.email, status: "Open" }))[0]?.name;
		const [shiftA, shiftB, shiftC] = await Promise.all([shiftOf(a), shiftOf(b), shiftOf(c)]);
		f.check(Boolean(shiftA && shiftB && shiftC), `a shift is missing: ${JSON.stringify({ shiftA, shiftB, shiftC })}`);
		for (const r of await getList<{ name: string }>(admin, RECOVERY, { cashier_user: b.email }, ["name"], 5000)) reviewsBefore.add(r.name);
		const before = await snapshotBins(admin, KEYS);

		// ---- B and C go offline and build their backlogs; B also closes its shift offline ----
		await Promise.all([b.context.setOffline(true), c.context.setOffline(true)]);
		const [depthB, depthC] = await Promise.all([sellOffline(b.page, ITEMS.stock, BACKLOG), sellOffline(c.page, ITEMS.stock, BACKLOG)]);
		f.check(depthB[depthB.length - 1] >= BACKLOG.length, `B queued only ${depthB[depthB.length - 1] ?? 0}/${BACKLOG.length} bills`);
		f.check(depthC[depthC.length - 1] >= BACKLOG.length, `C queued only ${depthC[depthC.length - 1] ?? 0}/${BACKLOG.length} bills`);
		await closeShift(b.page, { offline: true });
		const bRowsQueued = (await outboxRows(b.page)) ?? [];
		f.check(bRowsQueued.some((r) => r.type === "closing_entry"), "B's closing was not queued while offline");
		f.note(`B queued ${bRowsQueued.filter((r) => r.type === "invoice").length} bills and a closing; C queued ${depthC[depthC.length - 1]} bills`);

		// ---- the invalid bill: the request for the quantity-3 bill names an item that does not exist ----
		let invalidRequests = 0;
		const invalidResponses: number[] = [];
		await b.context.route(REPLAY, async (route) => {
			const body = route.request().postData() ?? "";
			if (new RegExp(`qty\\\\?"\\s*:\\s*${BAD_QTY}(\\D|$)`).test(body)) {
				invalidRequests += 1;
				return route.continue({ postData: body.split(ITEMS.stock).join("PERF-NO-SUCH-ITEM") });
			}
			return route.continue();
		});
		b.page.on("response", (r) => REPLAY.test(r.url()) && invalidResponses.push(r.status()));

		// ---- A: baseline sales while nothing is draining ----
		const timing = { baseline: [] as number[], during: [] as number[] };
		const aSales: { invoice?: string; ok: boolean; phase: string; prepareMs: number; submitMs: number }[] = [];
		const sellOnA = async (phase: "baseline" | "during") => {
			const t0 = performance.now();
			await prepareCashSale(a.page, ITEMS.stock, 1);
			const t1 = performance.now();
			const res = await attemptSubmit(a.page, 45_000, aSales.map((x) => x.invoice).filter(Boolean) as string[]);
			const t2 = performance.now();
			aSales.push({ invoice: res.invoice, ok: res.ok, phase, prepareMs: Math.round(t1 - t0), submitMs: Math.round(t2 - t1) });
			timing[phase].push(t2 - t1);
			if (!res.ok) f.expectSafe(false, `A's ${phase} sale failed: ${res.message} (HTTP ${JSON.stringify(res.statuses)})`);
			return res;
		};
		for (let i = 0; i < 3; i++) await sellOnA("baseline");
		f.note(`A's baseline (nothing draining): sale submit median ${Math.round(median(timing.baseline))} ms`);

		// ---- B and C reconnect together; A keeps selling the whole time ----
		const gate = new Barrier(2);
		const reconnectAt = Date.now();
		await Promise.all(
			[b, c].map(async (d) => {
				await gate.wait();
				await d.context.setOffline(false);
			}),
		);
		const settledB = waitRows(b.page, (rows) => {
			const inv = rows.filter((r) => r.type === "invoice");
			return inv.filter((r) => r.status === "synced").length === 3 && inv.filter((r) => ["needs_review", "handed_off"].includes(r.status ?? "")).length === 1;
		}, 300_000);
		const settledC = waitRows(c.page, (rows) => rows.filter((r) => r.type === "invoice").length > 0 && rows.filter((r) => r.type === "invoice").every((r) => r.status === "synced"), 300_000);
		let settled = false;
		const both = Promise.all([settledB, settledC]).then((r) => {
			settled = true;
			return r;
		});
		while (!settled || timing.during.length < 5) {
			await sellOnA("during");
			if (timing.during.length >= 25) break;
		}
		const [rb, rc] = await both;
		data.aSales = aSales;
		data.aTiming = { baseline: { median: Math.round(median(timing.baseline)), p95: Math.round(p95(timing.baseline)), n: timing.baseline.length }, during: { median: Math.round(median(timing.during)), p95: Math.round(p95(timing.during)), n: timing.during.length } };
		data.settleMs = { B: rb.ms, C: rc.ms, sinceReconnect: Date.now() - reconnectAt };
		f.note(`A during the drain: ${timing.during.length} sales, submit median ${Math.round(median(timing.during))} ms, p95 ${Math.round(p95(timing.during))} ms (baseline median ${Math.round(median(timing.baseline))} ms); all succeeded=${aSales.every((s) => s.ok)}`);
		f.expectSafe(
			!(median(timing.during) > 3 * median(timing.baseline) && median(timing.during) > 5_000),
			`A's billing became slow while others drained: median ${Math.round(median(timing.during))} ms vs ${Math.round(median(timing.baseline))} ms before (proposed limit: 3x and 5 s)`,
		);
		f.check(timing.during.length >= 1, "A made no sale while the others were draining");

		f.note(`C settled=${rc.ok} in ${rc.ms} ms; B settled=${rb.ok} in ${rb.ms} ms; B's rows=${JSON.stringify(rb.rows)}`);
		f.check(rc.ok, `C's valid backlog did not fully sync within 300 s: ${JSON.stringify(rc.rows.map((r) => r.status))}`);
		f.note(`the invalid bill was altered on ${invalidRequests} request(s); the server answered the replays with ${JSON.stringify(invalidResponses)}`);
		f.check(invalidRequests > 0, "the invalid bill was never sent (injection did not fire)");
		f.expectSafe(rb.ok, `B did not reach the expected state (3 bills synced, 1 failed bill visible) within 300 s: ${JSON.stringify(rb.rows.map((r) => `${r.type}:${r.status}`))}`);

		// ---- what the server has ----
		const idsOf = async (shift: string, qtys: number[]) => {
			const onShift = (await invoicesOnShift(admin, shift)).filter((x) => x.docstatus === 1);
			const byQty = new Map<number, string[]>();
			for (const inv of onShift) {
				const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
				const q = (d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				byQty.set(q, [...(byQty.get(q) ?? []), inv.name]);
			}
			return { onShift, byQty, expected: qtys };
		};
		const addSale = (cashier: string, profile: string, warehouse: string, shift: string, qty: number, invoice?: string) => {
			const s = manifest.add({ txnId: newTxnId("off06"), cashier, company: COMPANY, posProfile: profile, warehouse, items: [{ item_code: ITEMS.stock, qty, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE * qty }], expectedGrandTotal: RATE * qty, openingShift: shift, invoice });
			manifest.update(s.txnId, invoice ? { state: "accepted" } : { state: "attempted" });
		};

		// A: every successful sale exactly once on A's shift.
		const aOk = aSales.filter((s) => s.ok && s.invoice);
		let aOnShift = (await invoicesOnShift(admin, shiftA!)).filter((x) => x.docstatus === 1);
		for (let i = 0; i < 15 && aOnShift.length < aOk.length; i++) {
			await a.page.waitForTimeout(1_000);
			aOnShift = (await invoicesOnShift(admin, shiftA!)).filter((x) => x.docstatus === 1);
		}
		f.expectSafe(new Set(aOk.map((s) => s.invoice)).size === aOk.length, `two of A's sales were given the same invoice name: ${JSON.stringify(aOk.map((s) => s.invoice))}`);
		f.expectSafe(aOnShift.length === aOk.length, `A's shift has ${aOnShift.length} invoices for ${aOk.length} successful sales`);
		for (const s of aOk) addSale(a.email, PROFILES.P1, WAREHOUSES.A, shiftA!, 1, s.invoice);

		// C: all four exactly once.
		const gc = await idsOf(shiftC!, BACKLOG);
		f.note(`C's shift: ${gc.onShift.length} submitted invoice(s)`);
		f.expectSafe(gc.onShift.length === BACKLOG.length, `C has ${gc.onShift.length} submitted invoices for ${BACKLOG.length} valid bills (a healthy device was disturbed by the failing one)`);
		for (const q of BACKLOG) addSale(c.email, PROFILES.P3, WAREHOUSES.B, shiftC!, q, gc.byQty.get(q)?.shift());

		// B: the 3 valid bills once; the invalid one never an invoice.
		const gb = await idsOf(shiftB!, BACKLOG);
		f.note(`B's shift: invoices by quantity ${JSON.stringify([...gb.byQty.entries()].map(([q, n]) => [q, n.length]))}`);
		for (const q of BACKLOG.filter((x) => x !== BAD_QTY)) {
			f.expectSafe((gb.byQty.get(q) ?? []).length === 1, `B's valid bill of quantity ${q} exists ${(gb.byQty.get(q) ?? []).length} time(s) (expected exactly once)`);
			addSale(b.email, PROFILES.P1, WAREHOUSES.A, shiftB!, q, gb.byQty.get(q)?.shift());
		}
		f.expectSafe((gb.byQty.get(BAD_QTY) ?? []).length === 0, `the invalid bill (quantity ${BAD_QTY}) became an invoice`);
		await verifyManifest(admin, manifest, before, KEYS, f);

		// ---- the failed bill and its dependant must be visible, with a recovery route ----
		const bRows = rb.rows;
		const bad = bRows.filter((r) => r.type === "invoice" && ["needs_review", "handed_off"].includes(r.status ?? ""));
		const closingRow = bRows.find((r) => r.type === "closing_entry");
		f.note(`B's failed bill: ${JSON.stringify(bad)}; B's closing row: ${JSON.stringify(closingRow)}`);
		f.expectSafe(bad.length === 1, `${bad.length} failed bill(s) visible on B (expected exactly 1)`);
		f.expectSafe(Boolean(closingRow) && closingRow!.status !== "synced", "B's closing is missing or already 'synced' even though a bill of its shift failed: the shift would be closed as complete");
		const shiftBStatus = (await listOpeningShifts(admin, { name: shiftB })).find((x) => x.name === shiftB)?.status ?? "(not open)";
		const shiftBDoc = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shiftB!);
		f.note(`B's shift on the server is ${shiftBDoc?.status} while its bad bill is unresolved (list says ${shiftBStatus})`);
		f.expectSafe(shiftBDoc?.status === "Open", `B's shift is "${shiftBDoc?.status}" on the server although one of its bills failed and the closing is blocked`);
		data.messagesOnB = (await b.page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);

		let reviews: { name: string; status: string; entry_type: string }[] = [];
		for (let i = 0; i < 20 && reviews.length === 0; i++) {
			reviews = (await getList<{ name: string; status: string; entry_type: string }>(admin, RECOVERY, { cashier_user: b.email }, ["name", "status", "entry_type"], 5000)).filter((r) => !reviewsBefore.has(r.name));
			if (reviews.length === 0) await b.page.waitForTimeout(2_000);
		}
		f.note(`review row(s) for B's failed bill: ${JSON.stringify(reviews)}`);
		f.expectSafe(reviews.length === 1, `${reviews.length} review row(s) for 1 failed bill (expected exactly 1: it must be visible to a manager)`);

		// ---- recovery: a manager voids the bad bill; does B's closing then complete? ----
		if (reviews[0]) {
			const res = await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: reviews[0].name, reason: "OFF-06 test: invalid bill voided by manager" } });
			f.note(`manager void of ${reviews[0].name}: HTTP ${res.status()}`);
			f.check(res.ok(), `the manager could not void the bad bill: HTTP ${res.status()}`);
			const closingDone = (rows: OutboxRow[]) => rows.find((r) => r.type === "closing_entry")?.status === "synced";
			const describe = (rows: OutboxRow[]) => JSON.stringify(rows.map((r) => `${r.type}:${r.status}${r.blocked_reason ? `(${r.blocked_reason})` : ""}`));
			let after = await waitRows(b.page, closingDone, 120_000);
			f.note(`120 s after the void (device untouched): B's queue=${describe(after.rows)}`);
			let recoveredBy = after.ok ? "by itself" : "";
			if (!after.ok) {
				// What a cashier would do next: reload the POS.
				await b.page.reload();
				await b.page.waitForTimeout(5_000);
				after = await waitRows(b.page, closingDone, 120_000);
				f.note(`120 s after the cashier reloaded the POS: B's queue=${describe(after.rows)}`);
				recoveredBy = after.ok ? "only after the cashier reloaded the POS" : "";
			}
			const closingAfter = after.rows.find((r) => r.type === "closing_entry");
			const shiftAfter = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shiftB!);
			data.afterVoid = { closingStatus: closingAfter?.status, shiftStatus: shiftAfter?.status, recoveredBy: recoveredBy || "not within 4 minutes", rows: after.rows };
			f.note(`after the manager voided the bad bill: B's closing is "${closingAfter?.status}" (${recoveredBy || "not recovered"}); the server shift is "${shiftAfter?.status}"`);
			f.expectSafe(after.ok && shiftAfter?.status === "Closed", `after the manager voided the failed bill, B's blocked closing never completed in 4 minutes, even after a reload (closing "${closingAfter?.status}", shift "${shiftAfter?.status}"): the recovery leaves the shift stuck`);
			if (recoveredBy === "only after the cashier reloaded the POS") f.note("RESTRICTION: the closing only resumed after the cashier reloaded the POS; the manager's void alone did not release it");
		}

		for (const x of actors) {
			const closed = await closeLeftoverShiftsDetailed(admin, x, { visitPos: false });
			f.expectSafe(closed.stuck.length === 0, `${x.email}: could not close the shift at the end: ${JSON.stringify(closed.stuck)}`);
			x.forgetShift();
		}
		completed = true;
	} finally {
		manifest.save();
		for (const x of actors) {
			await x.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await x.context.setOffline(false).catch(() => {});
		}
		const email = actors[1]?.email;
		if (email) {
			const rows = await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: email }, ["name", "status"], 5000).catch(() => []);
			for (const r of rows.filter((x) => !reviewsBefore.has(x.name) && x.status === "Pending Review")) {
				await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: r.name, reason: "test cleanup (OFF-06)" } }).catch(() => {});
				f.note(`test cleanup voided the unresolved review row ${r.name}`);
			}
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({
			id: "OFF-06",
			arrangement: "A sells online throughout; B (offline backlog with one invalid bill, then an offline close) and C (offline backlog) reconnect together and drain",
			outcome,
			notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
			data,
		});
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
});
