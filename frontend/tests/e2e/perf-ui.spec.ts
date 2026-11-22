/**
 * PERF-01 .. PERF-04 (P1): how the POS screen behaves with a big catalogue, a big cart,
 * scanner-speed input and a slow or silent backend. Maps to workbook PERF-001, 002, 004
 * and 005. Needs the fixture from pospire/tests/perf_lines.py (PERF-LINE-001..100 with
 * prices and two barcodes) on top of the seeded PERF topology.
 *
 *   PERF-01  catalogue of 1,000+ items: cold and warm readiness, search latency, filter and
 *            price correctness, browser heap
 *   PERF-02  a cart of 100 distinct priced lines: per-add latency, total after each stage,
 *            an edit, and the submitted invoice against the screen
 *   PERF-03  100 scans at scanner cadence (repeat, second code, unknown code)
 *   PERF-04  a slow submit (delayed), a silent submit (never answered), a slow catalogue
 *
 * The ticket's targets (warm catalogue ready p95 <= 3 s; search and cart updates p95 <=
 * 500 ms) are PROPOSED, not agreed, so they are reported next to every measurement and
 * never turned into a pass/fail. Defects here are correctness: a wrong total, a lost or
 * extra scan, a duplicate invoice, a sale reported as done that is not stored.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, cashierPassword } from "./fixtures/topology";
import { loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { outboxRows } from "./helpers/outbox";
import { addItem, attemptSubmit, cartRow, gotoPos } from "./helpers/pos-ui";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";

type Admin = Awaited<ReturnType<typeof newAdminContext>>;
type Cashiers = Parameters<Parameters<typeof test>[2]>[0]["cashiers"];

const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";
const TARGET = { warmReadyP95Ms: 3000, interactionP95Ms: 500 };
const lineCode = (n: number) => `PERF-LINE-${String(n).padStart(3, "0")}`;
const lineRate = (n: number) => 50 + 10 * (n % 37);
const money = (s: string) => Number(s.replace(/[^0-9.\-]/g, ""));
const pct = (xs: number[], p: number) => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(0, ...xs)) });
const log = (m: string) => console.log(`[PERF-UI ${new Date().toISOString().slice(11, 19)}] ${m}`);

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

async function messagesOf(a: Actor) {
	return (await a.page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
}
/** Every distinct message seen over `ms` (toasts come and go). */
async function collectMessages(a: Actor, ms: number) {
	const seen = new Set<string>();
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const m of await messagesOf(a)) seen.add(m);
		await a.page.waitForTimeout(150);
	}
	return [...seen];
}
const cartTotal = async (a: Actor) => money(await a.page.getByLabel("Total", { exact: true }).first().inputValue());
const searchBox = (a: Actor) => a.page.getByPlaceholder(/Search by name, code, barcode/i).first();
const catalogueRows = (a: Actor) => a.page.locator("tbody tr").filter({ hasText: /PERF-/ });

/** Wait until the catalogue is usable: search box visible, progress bar gone, at least one item row. */
async function waitCatalogueReady(a: Actor, timeout = 60_000) {
	await expect(searchBox(a)).toBeVisible({ timeout });
	await a.page.getByRole("progressbar").first().waitFor({ state: "hidden", timeout }).catch(() => {});
	await expect(a.page.locator("tbody tr").first()).toBeVisible({ timeout });
}

async function scenario(
	id: string,
	arrangement: string,
	{ cashiers, playwright }: { cashiers: Cashiers; playwright: Parameters<typeof newAdminContext>[0] },
	body: (a: Actor, f: Findings, data: Record<string, unknown>, admin: Admin, shift: () => Promise<string>) => Promise<void>,
	opts: { openViaApi?: boolean } = {},
) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = { targets: TARGET };
	let completed = false;
	let a: Actor | undefined;
	try {
		a = await cashiers.login(1);
		a.page.setDefaultTimeout(30_000);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		if (opts.openViaApi) {
			const seat = await loginApiSeat(playwright, 1);
			const r = (await openShiftApi(seat, COMPANY, PROFILES.P1)).result;
			f.check(r.status === 200, `could not open the shift through the API: HTTP ${r.status}`);
			await seat.dispose();
		} else {
			await a.openShift(PROFILES.P1, "0");
		}
		const shift = async () => {
			const [s] = await listOpeningShifts(admin, { user: a!.email, status: "Open" });
			if (!s) throw new Error("no open shift");
			return s.name;
		};
		await body(a, f, data, admin, shift);
		completed = true;
	} finally {
		if (a) {
			await a.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await a.context.setOffline(false).catch(() => {});
			// a draft the test itself left behind (the cashier role cannot delete it) must not block the close
			const strays = await getList<{ name: string }>(admin, "Sales Invoice", { owner: a.email, docstatus: 0 }, ["name"], 200).catch(() => []);
			for (const d of strays) await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: d.name } }).catch(() => {});
			await closeLeftoverShiftsDetailed(admin, a, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close the shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
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

test.describe("PERF-01..04 — the POS screen under size, speed and a slow backend", () => {
	test("PERF-01 — catalogue of 1,000+ items: readiness, search, correctness", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("PERF-01", "catalogue of PERF-P1 (1,000+ items): first load in a fresh browser, 5 warm reloads, 20 searches", { cashiers, playwright }, async (a, f, data, admin) => {
			const page = a.page;
			// Catalogue size as the server sends it.
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const res = await admin.post("/api/method/pospire.pospire.api.posapp.get_items", { data: { pos_profile: profile } });
			const items = ((await res.json())?.message ?? []) as { item_code: string; rate?: number }[];
			data.catalogueItems = items.length;
			f.note(`the server returns ${items.length} items for ${PROFILES.P1}`);
			f.check(items.length >= 1000, `the catalogue has only ${items.length} items, below the 1,000 the scenario needs`);

			// Cold: this browser has never loaded the POS (the shift was opened through the API).
			const t0 = Date.now();
			await page.goto("/pospire/pos");
			await waitCatalogueReady(a, 90_000);
			const coldMs = Date.now() - t0;
			data.coldReadyMs = coldMs;
			f.note(`cold start (first POS load in a fresh browser) ready in ${coldMs} ms; proposed warm target ${TARGET.warmReadyP95Ms} ms (cold is reported separately)`);

			// Warm: reload with the browser's cache populated.
			const warm: number[] = [];
			for (let i = 0; i < 5; i++) {
				const t = Date.now();
				await page.reload();
				await waitCatalogueReady(a, 60_000);
				warm.push(Date.now() - t);
			}
			data.warmReadyMs = warm;
			f.note(`warm reloads ready in ${JSON.stringify(warm)} ms (p95 ${stat(warm).p95} ms vs proposed ${TARGET.warmReadyP95Ms} ms: ${stat(warm).p95 <= TARGET.warmReadyP95Ms ? "met" : "NOT met"})`);

			// Search latency, filter correctness, price correctness.
			const lat: number[] = [];
			const wrong: string[] = [];
			const pick = Array.from({ length: 20 }, (_, i) => 5 + i * 4); // PERF-LINE-005, 009, ...
			for (const n of pick) {
				const code = lineCode(n);
				const t = Date.now();
				await searchBox(a).fill(code);
				const row = catalogueRows(a).filter({ hasText: code }).first();
				await row.waitFor({ state: "visible", timeout: 10_000 });
				lat.push(Date.now() - t);
				const rows = await catalogueRows(a).allTextContents();
				const stray = rows.filter((r) => !r.includes(code));
				if (stray.length) wrong.push(`${code}: ${stray.length} unrelated row(s) shown`);
				const text = (await row.textContent()) ?? "";
				if (!new RegExp(`\\b${lineRate(n)}(\\.00)?\\b`).test(text.replace(/,/g, ""))) wrong.push(`${code}: expected rate ${lineRate(n)} not in "${text.replace(/\s+/g, " ").slice(0, 80)}"`);
			}
			data.searchMs = stat(lat);
			f.note(`search (20 lookups): ${JSON.stringify(stat(lat))} ms; proposed p95 target ${TARGET.interactionP95Ms} ms: ${stat(lat).p95 <= TARGET.interactionP95Ms ? "met" : "NOT met"}`);
			f.expectSafe(wrong.length === 0, `search results wrong: ${wrong.slice(0, 5).join(" | ")}`);

			const cdp = await a.context.newCDPSession(page);
			await cdp.send("Performance.enable");
			const metrics = (await cdp.send("Performance.getMetrics")).metrics as { name: string; value: number }[];
			const heap = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
			data.jsHeapMb = Math.round(heap / 1048576);
			f.note(`browser JS heap after the run: ${data.jsHeapMb} MB`);
		}, { openViaApi: true });
	});

	test("PERF-02 — a cart of 100 distinct lines: totals and responsiveness", async ({ cashiers, playwright }) => {
		test.setTimeout(900_000);
		await scenario("PERF-02", "100 distinct priced lines added through search, one quantity edited, then paid", { cashiers, playwright }, async (a, f, data, admin, shiftName) => {
			const page = a.page;
			const addMs: number[] = [];
			let expected = 0;
			for (let n = 1; n <= 100; n++) {
				const t = Date.now();
				await addItem(page, lineCode(n));
				addMs.push(Date.now() - t);
				expected += lineRate(n);
			}
			data.addMs = stat(addMs);
			data.addFirst10 = stat(addMs.slice(0, 10));
			data.addLast10 = stat(addMs.slice(-10));
			f.note(`adding 100 lines (search, click, row shown): ${JSON.stringify(stat(addMs))} ms; first 10 ${JSON.stringify(stat(addMs.slice(0, 10)))}, last 10 ${JSON.stringify(stat(addMs.slice(-10)))}; proposed p95 ${TARGET.interactionP95Ms} ms: ${stat(addMs).p95 <= TARGET.interactionP95Ms ? "met" : "NOT met"}`);
			const rows = await page.locator(".invoice-cart-section tbody tr").filter({ hasText: /PERF-LINE-/ }).count();
			f.expectSafe(rows === 100, `the cart shows ${rows} line(s) after 100 adds (dropped or merged)`);
			const total1 = await cartTotal(a);
			f.note(`cart total after 100 lines: ${total1} (expected ${expected})`);
			f.expectSafe(Math.abs(total1 - expected) < 0.01, `cart total ${total1} differs from the sum of rates ${expected}`);

			// Edit: line 50 to quantity 3.
			const row = cartRow(page, lineCode(50));
			const qty = row.getByRole("textbox").first();
			const t = Date.now();
			await qty.fill("3");
			await qty.blur();
			expected += 2 * lineRate(50);
			await expect.poll(async () => cartTotal(a), { timeout: 15_000 }).toBeCloseTo(expected, 1);
			data.editMs = Date.now() - t;
			f.note(`editing one line's quantity updated the total in ${data.editMs} ms; proposed ${TARGET.interactionP95Ms} ms`);

			// Pay and submit; compare the invoice with the screen.
			const screenTotal = await cartTotal(a);
			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const out = await attemptSubmit(page, 90_000);
			f.check(out.ok, `the 100-line sale was not accepted: ${out.message}`);
			if (out.invoice) {
				const inv = await getDoc<Record<string, any>>(admin, "Sales Invoice", out.invoice);
				const codes = (inv?.items ?? []).map((i: any) => i.item_code);
				const sumQty = (inv?.items ?? []).reduce((s: number, i: any) => s + Number(i.qty), 0);
				data.invoice = out.invoice;
				f.note(`invoice ${out.invoice}: ${codes.length} rows, ${new Set(codes).size} distinct items, total quantity ${sumQty}, grand total ${inv?.grand_total}`);
				f.expectSafe(codes.length === 100 && new Set(codes).size === 100, `the invoice has ${codes.length} rows / ${new Set(codes).size} distinct items, expected 100`);
				f.expectSafe(sumQty === 102, `the invoice quantity is ${sumQty}, expected 102`);
				f.expectSafe(Math.abs(Number(inv?.grand_total) - expected) < 0.01, `the invoice total ${inv?.grand_total} differs from the expected ${expected}`);
				f.expectSafe(Math.abs(Number(inv?.grand_total) - screenTotal) < 0.01, `the invoice total ${inv?.grand_total} differs from the screen total ${screenTotal}`);
			}
			const onShift = (await invoicesOnShift(admin, await shiftName())).filter((x) => x.docstatus === 1);
			f.expectSafe(onShift.length === 1, `${onShift.length} invoices on the shift, expected exactly 1`);
		});
	});

	test("PERF-03 — 100 scans at scanner cadence", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("PERF-03", "60 scans of one barcode, 30 of another and 10 unknown codes, typed 10 ms per character with 60 ms between scans", { cashiers, playwright }, async (a, f, data, admin, shiftName) => {
			const page = a.page;
			const A = "PERF-BC-0001"; // PERF-LINE-001
			const B = "PERF-BC-0002"; // PERF-LINE-002
			const U = "NOPE-0000"; // unknown
			const plan = [...Array(60).fill(A), ...Array(30).fill(B), ...Array(10).fill(U)];
			// deterministic shuffle
			let seed = 12345;
			for (let i = plan.length - 1; i > 0; i--) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				const j = seed % (i + 1);
				[plan[i], plan[j]] = [plan[j], plan[i]];
			}
			const seen = new Set<string>();
			const watch = { stop: false };
			const watcher = (async () => {
				const stopAt = Date.now() + 120_000;
				while (!watch.stop && Date.now() < stopAt) {
					for (const m of await messagesOf(a)) seen.add(m);
					await page.waitForTimeout(100);
				}
			})();
			const box = searchBox(a);
			const t0 = Date.now();
			for (const code of plan) {
				await box.fill("");
				await box.pressSequentially(code, { delay: 10 });
				await box.press("Enter");
				await page.waitForTimeout(60);
			}
			const scanMs = Date.now() - t0;
			await page.waitForTimeout(1500);
			watch.stop = true;
			await watcher;
			data.scanMs = scanMs;
			data.messages = [...seen];
			f.note(`100 scans took ${scanMs} ms; messages seen: ${JSON.stringify([...seen])}`);

			const qtyOf = async (code: string) => {
				const r = cartRow(page, code);
				if ((await r.count()) === 0) return 0;
				return money(await r.getByRole("textbox").first().inputValue());
			};
			const [qa, qb] = [await qtyOf(lineCode(1)), await qtyOf(lineCode(2))];
			data.cart = { A: qa, B: qb };
			f.note(`cart after the scans: ${lineCode(1)} x ${qa}, ${lineCode(2)} x ${qb}`);
			f.expectSafe(qa === 60, `${lineCode(1)} scanned 60 times but the cart holds ${qa} (lost or extra scans)`);
			f.expectSafe(qb === 30, `${lineCode(2)} scanned 30 times but the cart holds ${qb} (lost or extra scans)`);
			const lines = await page.locator(".invoice-cart-section tbody tr").filter({ hasText: /PERF-|NOPE/ }).count();
			f.expectSafe(lines === 2, `the cart has ${lines} line(s); unknown codes must not add any (expected 2)`);
			f.expectSafe([...seen].some((m) => /not found|no item|invalid|unknown|barcode/i.test(m)), `the 10 unknown scans produced no message the cashier could see: ${JSON.stringify([...seen])}`);
			const expected = 60 * lineRate(1) + 30 * lineRate(2);
			const total = await cartTotal(a);
			f.expectSafe(Math.abs(total - expected) < 0.01, `cart total ${total}, expected ${expected}`);

			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const out = await attemptSubmit(page, 60_000);
			f.check(out.ok, `the scanned sale was not accepted: ${out.message}`);
			if (out.invoice) {
				const inv = await getDoc<Record<string, any>>(admin, "Sales Invoice", out.invoice);
				const byItem = new Map<string, number>((inv?.items ?? []).map((i: any) => [i.item_code, Number(i.qty)]));
				f.expectSafe(byItem.get(lineCode(1)) === 60 && byItem.get(lineCode(2)) === 30 && byItem.size === 2, `the invoice holds ${JSON.stringify([...byItem])}`);
			}
			const onShift = (await invoicesOnShift(admin, await shiftName())).filter((x) => x.docstatus === 1);
			f.expectSafe(onShift.length === 1, `${onShift.length} invoices on the shift, expected exactly 1`);
		});
	});

	test("PERF-04a — a slow submit (12 s) must not duplicate or lose the sale", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("PERF-04a", "submit_invoice is held for 12 s before it reaches the server; Submit is pressed twice while waiting", { cashiers, playwright }, async (a, f, data, admin, shiftName) => {
			const page = a.page;
			let requests = 0;
			await page.route(/posapp\.submit_invoice/, async (route) => {
				requests += 1;
				await new Promise((r) => setTimeout(r, 12_000));
				await route.continue();
			});
			await addItem(page, lineCode(7));
			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const submit = page.getByRole("button", { name: "Submit", exact: true });
			await submit.click();
			await page.waitForTimeout(1_500);
			const state = { visible: await submit.isVisible().catch(() => false), disabled: await submit.isDisabled().catch(() => null) };
			data.submitButtonWhileWaiting = state;
			f.note(`3 s into a 12 s wait the Submit button is ${state.visible ? (state.disabled ? "visible but disabled" : "visible and ENABLED") : "hidden"}`);
			if (state.visible && !state.disabled) await submit.click({ timeout: 3_000 }).catch(() => {});
			const msgs = await collectMessages(a, 22_000);
			data.messages = msgs;
			data.requests = requests;
			f.note(`submit requests seen by the network layer: ${requests}; messages: ${JSON.stringify(msgs)}`);
			f.expectSafe(requests === 1, `${requests} submit requests were sent for one sale (a slow reply caused a retry or a second press went through)`);
			const onShift = (await invoicesOnShift(admin, await shiftName())).filter((x) => x.docstatus === 1);
			f.expectSafe(onShift.length === 1, `${onShift.length} invoices exist for one sale, expected exactly 1`);
			f.expectSafe(msgs.some((m) => /is Submited/i.test(m)), "no confirmation reached the cashier after the slow reply");
		});
	});

	test("PERF-04b — a submit that is never answered", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("PERF-04b", "submit_invoice is accepted by the network layer and never answered for 60 s, then the connection is dropped", { cashiers, playwright }, async (a, f, data, admin, shiftName) => {
			const page = a.page;
			let requests = 0;
			let release: () => void = () => {};
			const gate = new Promise<void>((r) => (release = r));
			await page.route(/posapp\.submit_invoice/, async (route) => {
				requests += 1;
				await gate;
				await route.abort("connectionreset");
			});
			await addItem(page, lineCode(8));
			await page.locator(".pay-button").click();
			await page.getByRole("button", { name: "Cash", exact: true }).click();
			const submit = page.getByRole("button", { name: "Submit", exact: true });
			await submit.click();
			const marks: Record<string, unknown>[] = [];
			for (const sec of [10, 30, 60]) {
				await page.waitForTimeout((sec - (marks.length ? [10, 30, 60][marks.length - 1] : 0)) * 1000);
				marks.push({ afterSeconds: sec, submitVisible: await submit.isVisible().catch(() => false), submitDisabled: await submit.isDisabled().catch(() => null), messages: await messagesOf(a), spinner: await page.getByRole("progressbar").count() });
			}
			data.whileSilent = marks;
			f.note(`while the server was silent: ${JSON.stringify(marks)}`);
			release();
			const after = await collectMessages(a, 15_000);
			const rows = (await outboxRows(page)) ?? [];
			const cart = await page.locator(".invoice-cart-section tbody tr").filter({ hasText: /PERF-LINE-/ }).count();
			data.afterDrop = { messages: after, queued: rows.length, cartRows: cart, requests };
			f.note(`after the connection dropped: messages ${JSON.stringify(after)}; bills queued ${rows.length}; item still in cart ${cart > 0}; submit requests ${requests}`);
			f.expectSafe(requests <= 1, `${requests} submit requests for one sale while the server was silent (the app retried into a silent server)`);
			const onShift = (await invoicesOnShift(admin, await shiftName())).filter((x) => x.docstatus === 1);
			f.note(`invoices on the shift after the drop: ${onShift.length}`);
			// give the queued bill time to sync, then look for what the dropped request left behind
			await page.waitForTimeout(8_000);
			const finalInvoices = await getList<{ name: string; docstatus: number }>(admin, "Sales Invoice", { posa_pos_opening_shift: await shiftName(), owner: a.email }, ["name", "docstatus"], 50);
			const orphanDrafts = finalInvoices.filter((x) => x.docstatus === 0);
			data.finalInvoices = finalInvoices;
			f.note(`documents on the shift for this one sale: ${JSON.stringify(finalInvoices)}`);
			f.expectSafe(orphanDrafts.length === 0, `the dropped request left ${orphanDrafts.length} orphan draft(s) (${orphanDrafts.map((d) => d.name).join(", ")}) next to the invoice the queue created: it blocks closing the shift and could be resumed and sold twice`);
			f.expectSafe(!after.some((m) => /is Submited/i.test(m)) || onShift.length === 1 || rows.length === 1, "the screen reports the sale as submitted but it is neither on the server nor in the queue");
			f.expectSafe(rows.length + onShift.length >= 1 || cart > 0, "the sale is nowhere: not on the server, not queued, not in the cart (lost)");
		});
	});

	test("PERF-04c — a slow catalogue load", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("PERF-04c", "get_items is held for 8 s while the POS page loads", { cashiers, playwright }, async (a, f, data) => {
			const page = a.page;
			await page.route(/posapp\.get_items/, async (route) => {
				await new Promise((r) => setTimeout(r, 8_000));
				await route.continue();
			});
			const t0 = Date.now();
			await page.reload();
			await expect(searchBox(a)).toBeVisible({ timeout: 30_000 });
			const searchAfter = Date.now() - t0;
			const bar = await page.getByRole("progressbar").count();
			await waitCatalogueReady(a, 60_000);
			const readyAfter = Date.now() - t0;
			data.searchBoxMs = searchAfter;
			data.readyMs = readyAfter;
			f.note(`with get_items held 8 s: search box usable after ${searchAfter} ms (progress bar showing: ${bar > 0}), catalogue ready after ${readyAfter} ms`);
			f.expectSafe(readyAfter >= 7_000 ? bar > 0 || searchAfter < 7_000 : true, "the screen shows no loading indicator while the catalogue is slow");
			await searchBox(a).fill(lineCode(12));
			await expect(catalogueRows(a).filter({ hasText: lineCode(12) }).first()).toBeVisible({ timeout: 10_000 });
		});
	});
});
