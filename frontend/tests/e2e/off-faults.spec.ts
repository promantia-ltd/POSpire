/**
 * OFF-05 (P0): sync interrupted by network flaps, an expired session, a timeout
 * and server failure.
 *
 * Every scenario starts the same way: one cashier, one shift, the browser goes
 * offline and queues sales with different quantities (1, 2, 3), then a FAULT is
 * injected on the replay endpoint (api.offline.submit_invoice) and the network
 * comes back. The injection is counted (requests seen, requests failed), because
 * a fault that never fired proves nothing.
 *
 *   OFF-05a  network flaps: the connection drops mid-request, three times
 *   OFF-05b  session expiry: the replay is answered 401, then the fault clears
 *   OFF-05c  timeout AFTER server success: the server finishes, the reply is lost
 *   OFF-05d  server failure: HTTP 500 for the first attempts, then it recovers
 *   OFF-05e  server failure that never recovers: retries must be bounded and the
 *            failed bills must stay visible and recoverable (slow: real backoff)
 *
 * Expected (ticket): durable queues, bounded retries, recovery after re-auth, no
 * duplicates. A bill that cannot sync on its own must end as an explicit,
 * recoverable exception (the app hands it to the server-side review queue, which a
 * manager retries from Desk): here the manager step is performed with the real
 * recovery API, so "recoverable" is demonstrated, not assumed.
 *
 * Not covered here: the "draft exists but is not yet submitted" variant and
 * cancelled documents (OFF-05f).
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { sellOffline } from "./helpers/offline";
import { outboxRows, waitForOutboxDrain } from "./helpers/outbox";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

type Admin = Awaited<ReturnType<typeof newAdminContext>>;
const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;
const REPLAY = /api\.offline\.submit_invoice/;
const RECOVERY = "POSpire Offline Sync Review";
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";
const QTYS = [1, 2, 3];

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

interface Ctx {
	a: Actor;
	shift: string;
	before: Map<string, number>;
	reviewsBefore: Set<string>;
	manifest: Manifest;
	replay: { seen: number; failed: number; statuses: number[] };
}

/** Run one scenario: set up the offline queue, let `fault` run, then verify and clean up. */
async function scenario(
	id: string,
	arrangement: string,
	{ cashiers, playwright }: { cashiers: Parameters<Parameters<typeof test>[2]>[0]["cashiers"]; playwright: Parameters<typeof newAdminContext>[0] },
	qtys: number[],
	body: (ctx: Ctx, f: Findings, data: Record<string, unknown>, admin: Admin) => Promise<void>,
) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	const manifest = new Manifest();
	let completed = false;
	let a: Actor | undefined;
	let reviewsBefore = new Set<string>();

	try {
		a = await cashiers.login(1);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift after opening it");
		reviewsBefore = new Set((await getList<{ name: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name"], 5000)).map((r) => r.name));
		const before = await snapshotBins(admin, KEYS);

		// Count what the app sends to the replay endpoint, and what happens to it.
		const replay = { seen: 0, failed: 0, statuses: [] as number[] };
		a.page.on("request", (r) => REPLAY.test(r.url()) && (replay.seen += 1));
		a.page.on("requestfailed", (r) => REPLAY.test(r.url()) && (replay.failed += 1));
		a.page.on("response", (r) => REPLAY.test(r.url()) && replay.statuses.push(r.status()));

		await a.context.setOffline(true);
		const depth = await sellOffline(a.page, ITEMS.stock, qtys);
		f.check(depth[depth.length - 1] >= qtys.length, `only ${depth[depth.length - 1] ?? 0}/${qtys.length} sales were queued while offline`);
		f.note(`queued ${qtys.length} sale(s) offline (qty ${JSON.stringify(qtys)})`);
		const early = await invoicesOnShift(admin, shift.name);
		f.check(early.length === 0, `the server already has ${early.length} invoice(s) on the shift before any sync`);

		await body({ a, shift: shift.name, before, reviewsBefore, manifest, replay }, f, data, admin);

		data.replayRequests = { seen: replay.seen, failed: replay.failed, statuses: replay.statuses };
		completed = true;
	} finally {
		manifest.save();
		if (a) {
			await a.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await a.context.setOffline(false).catch(() => {});
			// Void any review row this test created and nobody resolved, so nothing is left pending.
			const rows = await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name", "status"], 5000).catch(() => []);
			for (const r of rows.filter((x) => !reviewsBefore.has(x.name) && x.status === "Pending Review")) {
				await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: r.name, reason: `test cleanup (${id})` } }).catch(() => {});
				f.note(`test cleanup voided the unresolved review row ${r.name}`);
			}
			await closeLeftoverShiftsDetailed(admin, a).then((c) => c.stuck.length && f.note(`could not close the shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			a.forgetShift();
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

/** Exactly one invoice per queued sale, with the right quantity, owned by the cashier; stock and ledger right. */
async function expectExactlyOnce(ctx: Ctx, f: Findings, admin: Admin, qtys: number[]) {
	let onShift = await invoicesOnShift(admin, ctx.shift);
	for (let i = 0; i < 20 && onShift.filter((x) => x.docstatus === 1).length < qtys.length; i++) {
		await ctx.a.page.waitForTimeout(1_000);
		onShift = await invoicesOnShift(admin, ctx.shift);
	}
	const submitted = onShift.filter((x) => x.docstatus === 1);
	f.note(`invoices on the shift: ${submitted.length} submitted, ${onShift.length - submitted.length} other`);
	f.expectSafe(submitted.length === qtys.length, `${submitted.length} submitted invoices for ${qtys.length} queued sales (lost or duplicated)`);
	for (const inv of submitted) f.expectSafe(inv.owner === ctx.a.email, `${inv.name} is owned by ${inv.owner}`);
	const pool = new Map<number, string[]>();
	for (const inv of submitted) {
		const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
		const q = (d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
		pool.set(q, [...(pool.get(q) ?? []), inv.name]);
	}
	for (const qty of qtys) {
		const name = pool.get(qty)?.shift();
		const s = ctx.manifest.add({ txnId: newTxnId("off05"), cashier: ctx.a.email, company: COMPANY, posProfile: PROFILES.P1, warehouse: WAREHOUSES.A, items: [{ item_code: ITEMS.stock, qty, rate: RATE }], payments: [{ mode_of_payment: "Cash", amount: RATE * qty }], expectedGrandTotal: RATE * qty, openingShift: ctx.shift, invoice: name });
		ctx.manifest.update(s.txnId, name ? { state: "accepted" } : { state: "attempted" });
	}
	const extra = [...pool.values()].flat();
	f.expectSafe(extra.length === 0, `invoice(s) with no matching sale (duplicate or wrong quantity): ${extra.join(", ")}`);
	await verifyManifest(admin, ctx.manifest, ctx.before, KEYS, f);
}

const screenMessages = async (a: Actor) => (await a.page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);

/** The review rows this test's cashier has created since it started. */
async function newReviews(admin: Admin, ctx: Ctx) {
	const rows = await getList<{ name: string; status: string; entry_type: string; offline_id: string }>(admin, RECOVERY, { cashier_user: ctx.a.email }, ["name", "status", "entry_type", "offline_id"], 5000);
	return rows.filter((r) => !ctx.reviewsBefore.has(r.name));
}

test.describe("OFF-05 — sync interrupted", () => {
	test("OFF-05a — the connection flaps three times mid-sync", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-05a", "3 offline sales; the first 3 replay requests are cut by a dropped connection that stays down for 3 s each time, then it stays up", { cashiers, playwright }, QTYS, async (ctx, f, data, admin) => {
			const { a, replay } = ctx;
			// Deterministic flaps: the first 3 replay requests are cut in the network layer (the app sees a
			// dropped connection), and each time the whole connection stays down for 3 s before returning.
			// (Toggling "offline" after seeing a request start is a race: a fast request has already finished.)
			let flaps = 0;
			await a.context.route(REPLAY, async (route) => {
				if (flaps >= 3) return route.continue();
				flaps += 1;
				await route.abort("internetdisconnected");
				await a.context.setOffline(true);
				setTimeout(() => void a.context.setOffline(false).catch(() => {}), 3_000);
			});
			await a.context.setOffline(false);
			const until = Date.now() + 180_000;
			while (flaps < 3 && Date.now() < until) await a.page.waitForTimeout(1_000);
			f.note(`flaps injected: ${flaps}; requests the app sent: ${replay.seen}; requests that failed: ${replay.failed}`);
			f.check(flaps === 3, `only ${flaps} of 3 planned flaps happened within 180 s`);
			data.flapsInjected = flaps;
			f.check(replay.failed >= 3, `only ${replay.failed} request(s) were interrupted: the flaps did not hit the app's sending, so this proves nothing`);
			await a.context.setOffline(false);
			const drain = await waitForOutboxDrain(a.page, 240_000);
			data.drain = { ms: drain.ms, drained: drain.drained, rows: drain.rows };
			f.note(`after the last flap: drained=${drain.drained} in ${drain.ms} ms; rows=${JSON.stringify(drain.rows)}`);
			f.check(drain.drained, "the queue did not drain within 240 s after the network stayed up");
			f.expectSafe(drain.needsAttention.length === 0, `queue ended needing attention: ${JSON.stringify(drain.needsAttention)}`);
			await expectExactlyOnce(ctx, f, admin, QTYS);
		});
	});

	test("OFF-05b — the session expires mid-sync (HTTP 401)", async ({ cashiers, playwright }) => {
		test.setTimeout(900_000);
		await scenario("OFF-05b", "3 offline sales; every replay is answered 401 (session expired), then the fault clears and a manager recovers", { cashiers, playwright }, QTYS, async (ctx, f, data, admin) => {
			const { a, replay } = ctx;
			let fault = true;
			let injected = 0;
			await a.context.route(REPLAY, async (route) => {
				if (!fault) return route.continue();
				injected += 1;
				await route.fulfill({
					status: 401,
					contentType: "application/json",
					body: JSON.stringify({ exc_type: "AuthenticationError", exception: "frappe.exceptions.AuthenticationError: Session Expired" }),
				});
			});
			await a.context.setOffline(false);
			// Wait until every queued bill has been given up on (needs review or handed off).
			let rows = (await outboxRows(a.page)) ?? [];
			const stop = Date.now() + 120_000;
			while (Date.now() < stop && !rows.every((r) => ["needs_review", "handed_off", "synced"].includes(r.status ?? ""))) {
				await a.page.waitForTimeout(2_000);
				rows = (await outboxRows(a.page)) ?? [];
			}
			data.rowsAfter401 = rows;
			f.note(`after the session expired: injected ${injected} 401 response(s); the app sent ${replay.seen} replay request(s); queue rows=${JSON.stringify(rows)}`);
			f.check(injected > 0, "no replay request was answered 401: the fault never fired");
			f.expectSafe(replay.seen <= QTYS.length * 2, `the app sent ${replay.seen} replay requests for ${QTYS.length} bills after a 401 (an expired session must not be hammered; it burns the retry budget)`);
			f.expectSafe(rows.every((r) => ["needs_review", "handed_off"].includes(r.status ?? "")), `after a 401 the bills are in unexpected states: ${JSON.stringify(rows.map((r) => r.status))} (expected visible needs_review/handed_off, not silently pending or synced)`);
			const msgs = await screenMessages(a);
			f.note(`messages on screen after the 401: ${JSON.stringify(msgs)}`);
			data.messagesAfter401 = msgs;

			// The fault clears (the cashier logs in again). Does anything recover by itself?
			fault = false;
			await a.page.waitForTimeout(45_000);
			rows = (await outboxRows(a.page)) ?? [];
			const early = (await invoicesOnShift(admin, ctx.shift)).filter((x) => x.docstatus === 1).length;
			f.note(`45 s after the fault cleared: queue rows=${JSON.stringify(rows.map((r) => r.status))}; ${early} of ${QTYS.length} invoices exist on the server`);
			data.recoveredByItself = early;

			// Recovery: the app hands failed bills to the server review queue; a manager retries them.
			const reviews = await newReviews(admin, ctx);
			f.note(`review rows for this cashier: ${JSON.stringify(reviews.map((r) => ({ name: r.name, status: r.status, type: r.entry_type })))}`);
			if (early < QTYS.length) {
				f.expectSafe(reviews.length >= QTYS.length - early, `${QTYS.length - early} bill(s) are neither on the server nor in the review queue: the failed bills are not recoverable by a manager`);
				for (const rv of reviews.filter((r) => r.status === "Pending Review")) {
					const res = await admin.post("/api/method/pospire.pospire.api.recovery.retry", { data: { name: rv.name } });
					f.note(`manager retry of ${rv.name}: HTTP ${res.status()}`);
					f.check(res.ok(), `the manager's retry of ${rv.name} failed: HTTP ${res.status()}`);
				}
			}
			await expectExactlyOnce(ctx, f, admin, QTYS);
		});
	});

	test("OFF-05c — the server completes but every reply is lost", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-05c", "3 offline sales; the first 3 replays reach the server and complete, but the replies are dropped", { cashiers, playwright }, QTYS, async (ctx, f, data, admin) => {
			const { a } = ctx;
			let dropped = 0;
			await a.context.route(REPLAY, async (route) => {
				if (dropped >= 3) return route.continue();
				dropped += 1;
				await route.fetch(); // the server finishes the sale...
				await route.abort("connectionreset"); // ...the app never hears about it
			});
			await a.context.setOffline(false);
			const drain = await waitForOutboxDrain(a.page, 300_000);
			data.drain = { ms: drain.ms, drained: drain.drained, rows: drain.rows };
			f.note(`replies dropped for ${dropped} request(s); drained=${drain.drained} in ${drain.ms} ms; rows=${JSON.stringify(drain.rows)}`);
			f.check(dropped >= 1, "no reply was dropped: the fault never fired");
			f.check(drain.drained, "the queue did not drain within 300 s");
			f.expectSafe(drain.needsAttention.length === 0, `queue ended needing attention: ${JSON.stringify(drain.needsAttention)}`);
			await expectExactlyOnce(ctx, f, admin, QTYS);
		});
	});

	test("OFF-05d — the server fails (HTTP 500) for the first attempts, then recovers", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-05d", "3 offline sales; the first 3 replay requests get HTTP 500, later ones succeed", { cashiers, playwright }, QTYS, async (ctx, f, data, admin) => {
			const { a } = ctx;
			let injected = 0;
			await a.context.route(REPLAY, async (route) => {
				if (injected >= 3) return route.continue();
				injected += 1;
				await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ exc_type: "ValidationError", exception: "injected server failure" }) });
			});
			await a.context.setOffline(false);
			const drain = await waitForOutboxDrain(a.page, 300_000);
			data.drain = { ms: drain.ms, drained: drain.drained, rows: drain.rows };
			f.note(`injected ${injected} HTTP 500 response(s); drained=${drain.drained} in ${drain.ms} ms; rows=${JSON.stringify(drain.rows)}`);
			f.check(injected === 3, `${injected} of 3 planned failures were injected`);
			f.check(drain.drained, "the queue did not drain within 300 s");
			f.expectSafe(drain.needsAttention.length === 0, `a brief server failure pushed bills to needs attention: ${JSON.stringify(drain.needsAttention)}`);
			await expectExactlyOnce(ctx, f, admin, QTYS);
		});
	});

	test("OFF-05e — the server never recovers: retries are bounded and the bill stays recoverable", async ({ cashiers, playwright }) => {
		test.setTimeout(1_200_000);
		await scenario("OFF-05e", "1 offline sale; every replay gets HTTP 500 until the retry budget is spent, then the fault clears and a manager recovers", { cashiers, playwright }, [2], async (ctx, f, data, admin) => {
			const { a, replay } = ctx;
			let fault = true;
			let injected = 0;
			await a.context.route(REPLAY, async (route) => {
				if (!fault) return route.continue();
				injected += 1;
				await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ exc_type: "ValidationError", exception: "injected server failure" }) });
			});
			await a.context.setOffline(false);
			const started = Date.now();
			let rows = (await outboxRows(a.page)) ?? [];
			// Backoff is 2, 4, 8 ... capped at 120 s over 8 attempts: allow up to 12 minutes (the app was seen to take ~8).
			while (Date.now() - started < 720_000 && !rows.every((r) => ["needs_review", "handed_off"].includes(r.status ?? ""))) {
				await a.page.waitForTimeout(5_000);
				rows = (await outboxRows(a.page)) ?? [];
			}
			data.rowsAfterRetries = rows;
			data.gaveUpAfterMs = Date.now() - started;
			f.note(`the app gave up after ${Math.round((Date.now() - started) / 1000)} s, ${injected} injected failure(s), ${replay.seen} replay request(s); rows=${JSON.stringify(rows)}`);
			f.check(injected > 0, "no failure was injected");
			f.expectSafe(rows.length === 1 && ["needs_review", "handed_off"].includes(rows[0]?.status ?? ""), `after persistent failure the bill is in state ${JSON.stringify(rows.map((r) => r.status))} (expected visibly needs_review/handed_off)`);
			f.expectSafe(replay.seen <= 8, `${replay.seen} replay attempts for one bill: retries are not bounded by the budget of 8`);

			fault = false;
			const reviews = await newReviews(admin, ctx);
			f.note(`review row(s) for this cashier: ${JSON.stringify(reviews.map((r) => ({ name: r.name, status: r.status })))}`);
			f.expectSafe(reviews.length >= 1, "the bill that exhausted its retries has no row in the server review queue: it is visible only on this device");
			for (const rv of reviews.filter((r) => r.status === "Pending Review")) {
				const res = await admin.post("/api/method/pospire.pospire.api.recovery.retry", { data: { name: rv.name } });
				f.note(`manager retry of ${rv.name}: HTTP ${res.status()}`);
				f.check(res.ok(), `the manager's retry of ${rv.name} failed: HTTP ${res.status()}`);
			}
			await expectExactlyOnce(ctx, f, admin, [2]);
		});
	});
});
