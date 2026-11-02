/**
 * CON-07 (P0): one logical sale must produce ONE invoice and ONE set of
 * business effects (stock, ledger), however the submission is repeated.
 *
 * CON-07a  Double-click Submit on the screen.
 * CON-07b  The same sale sent several times AT ONCE with the same offline id
 *          (a retry storm), straight at the server.
 * CON-07c  The server completes the sale but the reply is lost before the page
 *          sees it. The app should retry under the same id, end with one
 *          invoice and an empty queue.
 * CON-07d  The exact replay request from 07c is re-sent concurrently (and
 *          again after the sale exists): still one invoice.
 *
 * The screen's own double-click guard says nothing about the server, so 07b/07d
 * go straight at the server's idempotency. Each scenario checks, with the
 * reconciler, that the invoice is right, stock fell by exactly one unit and the
 * ledger entries balance. Unexpected 5xx responses and duplicate invoices are
 * recorded as defects.
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { callAs, errorText } from "./helpers/as-user";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { commonOverlapMs } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { waitForOutboxDrain } from "./helpers/outbox";
import { prepareCashSale } from "./helpers/pos-ui";
import { compareStock, expectedStockDeltas, glCheck, reconcile, snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, invoicesOnShift } from "./helpers/shifts";

type Admin = Parameters<typeof getList>[0];
const STOCK_KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

function expectedSale(cashier: string, shift: string, extra: { offlineId?: string; invoice?: string } = {}) {
	return {
		txnId: newTxnId("con07"),
		cashier,
		company: COMPANY,
		posProfile: PROFILES.P1,
		warehouse: WAREHOUSES.A,
		items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }],
		payments: [{ mode_of_payment: "Cash", amount: RATE }],
		expectedGrandTotal: RATE,
		openingShift: shift,
		...extra,
	};
}

/** Checks shared by every scenario: reconciler, stock and ledger. */
async function verifyOneSale(admin: Admin, manifest: Manifest, before: Map<string, number>, f: Findings) {
	const report = await reconcile(admin, manifest);
	f.check(report.lost.length === 0, `lost sales: ${report.lost.join(", ")}`);
	f.expectSafe(report.duplicates.length === 0, `duplicate invoices for one sale: ${JSON.stringify(report.duplicates)}`);
	f.expectSafe(report.collisions.length === 0, `colliding invoices: ${JSON.stringify(report.collisions)}`);
	for (const m of report.mismatches) f.check(false, `${m.txnId} ${m.invoice}: ${JSON.stringify(m.issues)}`);

	const after = await snapshotBins(admin, STOCK_KEYS);
	for (const i of compareStock(before, after, expectedStockDeltas(manifest.all()))) {
		f.expectSafe(false, `stock effect wrong: ${JSON.stringify(i)}`);
	}
	for (const s of manifest.all().filter((x) => x.state === "submitted" && x.invoice)) {
		const gl = await glCheck(admin, s.invoice!);
		f.expectSafe(gl.balanced, `ledger for ${s.invoice} missing or unbalanced (debit ${gl.debit}, credit ${gl.credit})`);
	}
}

function finish(id: string, arrangement: string, f: Findings, completed: boolean, extra: Record<string, unknown> = {}) {
	if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
	const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
	recordEvidence({
		id,
		arrangement,
		outcome,
		notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
		data: extra,
	});
}

function assertClean(f: Findings) {
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("CON-07 — one sale, one invoice", () => {
	test("CON-07a — double-clicking Submit produces one invoice", async ({ cashiers, playwright }) => {
		test.setTimeout(240_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let completed = false;
		const data: Record<string, unknown> = {};

		try {
			const c1 = await cashiers.login(1);
			const left = await closeLeftoverShifts(admin, c1);
			if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
			await c1.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			const before = await snapshotBins(admin, STOCK_KEYS);

			let submitRequests = 0;
			c1.page.on("request", (r) => {
				if (/posapp\.submit_invoice/.test(r.url())) submitRequests += 1;
			});
			await prepareCashSale(c1.page, ITEMS.stock);
			await c1.page.getByRole("button", { name: "Submit", exact: true }).dblclick();

			const toast = c1.page.getByText(/Invoice \S+ is Submited/);
			await expect(toast).toBeVisible({ timeout: 30_000 });
			const invoice = (await toast.textContent())?.match(/Invoice (\S+) is Submited/)?.[1] ?? "";
			await new Promise((r) => setTimeout(r, 4_000)); // let any second request land

			const onShift = await invoicesOnShift(admin, shift.name);
			data.submitRequests = submitRequests;
			f.note(`submit_invoice requests the screen sent: ${submitRequests}; invoices on the shift: ${JSON.stringify(onShift)}`);
			f.expectSafe(
				onShift.filter((i) => i.docstatus === 1).length === 1,
				`a double-click produced ${onShift.filter((i) => i.docstatus === 1).length} submitted invoices`,
			);

			const sale = manifest.add(expectedSale(c1.email, shift.name));
			manifest.update(sale.txnId, { state: "accepted", invoice });
			await verifyOneSale(admin, manifest, before, f);
			await c1.closeShift();
			completed = true;
		} finally {
			manifest.save();
			finish("CON-07a", "double-click on Submit (screen guard)", f, completed, data);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("CON-07b — the same sale sent five times at once is applied once", async ({ cashiers, playwright }) => {
		test.setTimeout(240_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let completed = false;
		const data: Record<string, unknown> = {};

		try {
			const c1 = await cashiers.login(1);
			const left = await closeLeftoverShifts(admin, c1);
			if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
			await c1.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);

			// One draft, as the screen would create before submitting.
			const payload = {
				doctype: "Sales Invoice",
				is_pos: 1,
				ignore_pricing_rule: 1,
				company: COMPANY,
				pos_profile: PROFILES.P1,
				customer: profile?.customer,
				currency: "INR",
				posting_date: new Date().toISOString().slice(0, 10),
				posa_pos_opening_shift: shift.name,
				items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE, uom: "Nos", conversion_factor: 1 }],
				payments: [{ mode_of_payment: "Cash", amount: RATE }],
			};
			const draft = await callAs(c1, "pospire.pospire.api.posapp.update_invoice", { data: JSON.stringify(payload) });
			f.check(draft.status === 200 && Boolean(draft.json?.message?.name), `could not create the draft: HTTP ${draft.status} ${errorText(draft)}`);
			const draftDoc = draft.json?.message;
			if (!draftDoc) throw new Error("no draft invoice to submit");
			// The screen puts the tendered payment on the invoice it sends and passes
			// change details separately; a bare draft has no payment rows.
			draftDoc.payments = [{ mode_of_payment: "Cash", amount: RATE }];
			const submitData = { total_change: 0, paid_change: 0, credit_change: 0, redeemed_customer_credit: 0, customer_credit_dict: [], is_cashback: true };
			const offlineId = randomUUID();
			const before = await snapshotBins(admin, STOCK_KEYS);

			// Five identical submissions, as a retry storm would send them.
			const N = 5;
			const calls = await Promise.all(
				Array.from({ length: N }, async () => {
					const start = performance.now();
					const res = await callAs(c1, "pospire.pospire.api.posapp.submit_invoice", {
						invoice: draftDoc,
						data: JSON.stringify(submitData),
						offline_id: offlineId,
					});
					return { res, span: { start, end: performance.now() } };
				}),
			);
			const overlap = commonOverlapMs(calls.map((c) => c.span));
			const statuses = calls.map((c) => c.res.status);
			data.statuses = statuses;
			f.note(`${N} concurrent submit_invoice calls (same offline id): HTTP ${JSON.stringify(statuses)}; common overlap ${overlap.toFixed(0)} ms`);
			for (const c of calls.filter((x) => x.res.status !== 200)) {
				f.note(`non-200 response: HTTP ${c.res.status} ${errorText(c.res)}`);
			}
			f.check(overlap > 0, `the ${N} calls did not overlap (common overlap ${overlap.toFixed(0)} ms)`);
			f.expectSafe(
				statuses.every((s) => s < 500),
				`uncontrolled server error (5xx) during the retry storm: HTTP ${JSON.stringify(statuses)}`,
			);
			f.check(statuses.some((s) => s === 200), "no call succeeded, so the sale was never made");

			const byId = await getList<{ name: string; docstatus: number }>(
				admin,
				"Sales Invoice",
				{ pos_offline_id: offlineId },
				["name", "docstatus"],
			);
			f.note(`invoices carrying that offline id: ${JSON.stringify(byId)}`);
			f.expectSafe(byId.length === 1, `${byId.length} invoices carry one offline id (expected exactly 1)`);

			const sale = manifest.add(expectedSale(c1.email, shift.name, { offlineId }));
			manifest.update(sale.txnId, { state: "accepted" });
			await verifyOneSale(admin, manifest, before, f);
			await c1.closeShift();
			completed = true;
		} finally {
			manifest.save();
			finish("CON-07b", "same sale submitted concurrently with one offline id (server idempotency)", f, completed, data);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("CON-07c/d — a lost reply is retried under the same id; replays are harmless", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let completed = false;
		const data: Record<string, unknown> = {};
		const f07d = new Findings();
		let replayChecked = false;

		try {
			const c1 = await cashiers.login(1);
			const left = await closeLeftoverShifts(admin, c1);
			if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
			await c1.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			const before = await snapshotBins(admin, STOCK_KEYS);

			// Let the live submit reach the server and complete, then drop the reply.
			let dropped = 0;
			await c1.page.route(/posapp\.submit_invoice/, async (route) => {
				if (dropped > 0) return route.continue();
				dropped += 1;
				await route.fetch(); // the server finishes the sale...
				await route.abort("connectionreset"); // ...but the page never hears about it
			});
			const replays: string[] = [];
			c1.page.on("request", (r) => {
				if (/api\.offline\.submit_invoice/.test(r.url())) replays.push(r.postData() ?? "");
			});

			await prepareCashSale(c1.page, ITEMS.stock);
			await c1.page.getByRole("button", { name: "Submit", exact: true }).click();

			// The server must have completed despite the dropped reply.
			let made: { name: string; docstatus: number }[] = [];
			for (let i = 0; i < 30 && made.filter((m) => m.docstatus === 1).length === 0; i++) {
				await new Promise((r) => setTimeout(r, 1_000));
				made = await invoicesOnShift(admin, shift.name);
			}
			f.check(dropped === 1, `the reply was not dropped (interceptions: ${dropped}); the fault was not injected`);
			f.check(made.some((m) => m.docstatus === 1), "the server never completed the sale before the reply was dropped");
			f.note(`reply dropped after the server completed; invoices on the shift at that point: ${JSON.stringify(made)}`);

			// The app should retry under the same id and clear its queue.
			const drain = await waitForOutboxDrain(c1.page, 90_000);
			data.outbox = { ms: drain.ms, sawEntry: drain.sawEntry, rows: drain.rows };
			f.note(`retry queue: saw an entry=${drain.sawEntry}; drained=${drain.drained} after ${drain.ms} ms; rows=${JSON.stringify(drain.rows)}`);
			f.check(drain.drained || !drain.sawEntry, "the retry queue did not drain within 90 s");
			f.expectSafe(drain.needsAttention.length === 0, `retry ended needing manual attention: ${JSON.stringify(drain.needsAttention)}`);
			f.note(`offline replay requests the app sent: ${replays.length}`);

			const toasts = (await c1.page.locator(".v-snackbar, .toast, [role=alert]").allTextContents()).map((t) => t.trim()).filter(Boolean);
			f.note(`messages visible on the screen after the retry: ${JSON.stringify(toasts)}`);

			const final = (await invoicesOnShift(admin, shift.name)).filter((i) => i.docstatus === 1);
			f.expectSafe(final.length === 1, `${final.length} submitted invoices for one sale after the lost reply (expected 1)`);
			if (final[0]) {
				const sale = manifest.add(expectedSale(c1.email, shift.name, { invoice: final[0].name }));
				manifest.update(sale.txnId, { state: "accepted" });
			}
			await verifyOneSale(admin, manifest, before, f);

			// ---- CON-07d: replay the app's own replay request, concurrently ----------------
			const body = replays.find(Boolean);
			if (!body) {
				f07d.note("no offline replay request was observed (the app resolved the lost reply another way), so the replay storm could not be built");
			} else {
				replayChecked = true;
				let parsed: Record<string, unknown> | null = null;
				try {
					parsed = JSON.parse(body);
				} catch {
					parsed = Object.fromEntries(new URLSearchParams(body));
				}
				const afterFirst = await snapshotBins(admin, STOCK_KEYS);
				const results = await Promise.all(
					Array.from({ length: 3 }, () => callAs(c1, "pospire.pospire.api.offline.submit_invoice", parsed!)),
				);
				const st = results.map((r) => r.status);
				f07d.note(`3 concurrent re-sends of the replay request after the sale exists: HTTP ${JSON.stringify(st)}`);
				for (const r of results.filter((x) => x.status !== 200)) f07d.note(`non-200: HTTP ${r.status} ${errorText(r)}`);
				f07d.expectSafe(st.every((s) => s < 500), `uncontrolled server error (5xx) on replays: HTTP ${JSON.stringify(st)}`);

				const again = (await invoicesOnShift(admin, shift.name)).filter((i) => i.docstatus === 1);
				f07d.expectSafe(again.length === 1, `${again.length} submitted invoices after replaying (expected 1)`);
				const afterReplays = await snapshotBins(admin, STOCK_KEYS);
				for (const i of compareStock(afterFirst, afterReplays, new Map())) {
					f07d.expectSafe(false, `replays changed stock: ${JSON.stringify(i)}`);
				}
			}

			await c1.closeShift();
			completed = true;
		} finally {
			manifest.save();
			finish("CON-07c", "reply lost after server success; app retries under the same offline id", f, completed, data);
			const outcome07d: Outcome = !completed || !replayChecked ? "observed" : f07d.defects.length > 0 ? "defect" : "supported";
			recordEvidence({
				id: "CON-07d",
				arrangement: "the app's replay request re-sent concurrently after the sale exists",
				outcome: outcome07d,
				notes: [...f07d.notes, ...f07d.defects.map((d) => `DEFECT: ${d}`)],
			});
			await admin.dispose();
		}
		assertClean(f);
		expect(f07d.defects, `application defects found (07d):\n${f07d.defects.join("\n")}`).toEqual([]);
	});
});
