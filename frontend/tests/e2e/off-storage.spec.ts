/**
 * OFF-07 (P1): the offline queue lives in the browser's IndexedDB. What happens to
 * accepted bills when the page reloads, when another cashier uses the same browser,
 * and when storage is full or unavailable?
 *
 *   OFF-07a  reload the page while offline with bills queued, then reconnect
 *   OFF-07b  cashier A queues bills, replay is held, cashier B logs in on the SAME
 *            browser, then replay is released
 *   OFF-07c  the browser refuses writes to the queue (quota full): the sale must be
 *            blocked clearly, nothing half-queued, and it must work again afterwards
 *   OFF-07d  IndexedDB is unusable: an offline sale must be refused clearly, never
 *            shown as accepted
 *
 * A bill the cashier was told was accepted must reach exactly one invoice owned by
 * the cashier who made it, or end as a visible, recoverable exception. Silent loss,
 * attribution to another user, and a success message for a sale that was not stored
 * are defects.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, cashierEmail, cashierPassword } from "./fixtures/topology";
import { loginApiSeat } from "./helpers/api-seat";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { sellOffline } from "./helpers/offline";
import { outboxRows, waitForOutboxDrain } from "./helpers/outbox";
import { fillOpeningDialog, gotoPos, prepareCashSale } from "./helpers/pos-ui";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";

type Admin = Awaited<ReturnType<typeof newAdminContext>>;
type Cashiers = Parameters<Parameters<typeof test>[2]>[0]["cashiers"];
const RECOVERY = "POSpire Offline Sync Review";
const REPLAY = /api\.offline\.submit_invoice/;
const ALERTS = ".v-snackbar, .toast, [role=alert], .Vue-Toastification__toast";
const A = FIRST_BURST_CASHIER; // 6
const B = FIRST_BURST_CASHIER + 1; // 7

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(A), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

const messages = async (a: Actor) => (await a.page.locator(ALERTS).allTextContents().catch(() => [])).map((t) => t.trim()).filter(Boolean);
/** Every distinct message seen on screen over `ms` (toasts disappear, so sample instead of reading once at the end). */
async function collectMessages(a: Actor, ms: number) {
	const seen = new Set<string>();
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const m of await messages(a)) seen.add(m);
		await a.page.waitForTimeout(200);
	}
	return [...seen];
}
const invoiceQty = async (admin: Admin, name: string) => {
	const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", name);
	return { qty: (d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0), owner: d?.owner as string, docstatus: d?.docstatus as number };
};

async function scenario(
	id: string,
	arrangement: string,
	{ cashiers, playwright }: { cashiers: Cashiers; playwright: Parameters<typeof newAdminContext>[0] },
	body: (a: Actor, shift: string, f: Findings, data: Record<string, unknown>, admin: Admin) => Promise<void>,
	extraCleanup?: (admin: Admin) => Promise<void>,
) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	let a: Actor | undefined;
	let reviewsBefore = new Set<string>();
	try {
		a = await cashiers.login(A);
		a.page.setDefaultTimeout(30_000);
		for (const n of [A, B]) {
			const seat = await loginApiSeat(playwright, n);
			const left = await closeLeftoverShiftsDetailed(admin, seat.actor, { visitPos: false });
			if (left.closed.length) f.note(`closed leftover shift(s) for cashier ${n}: ${left.closed.join(", ")}`);
			await seat.dispose();
		}
		await a.page.reload();
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift after opening it");
		reviewsBefore = new Set((await getList<{ name: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name"], 5000)).map((r) => r.name));
		await body(a, shift.name, f, data, admin);
		completed = true;
	} finally {
		if (a) {
			await a.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await a.context.setOffline(false).catch(() => {});
			for (const n of [A, B]) {
				const rows = await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: cashierEmail(n) }, ["name", "status"], 5000).catch(() => []);
				for (const r of rows.filter((x) => !(n === A && reviewsBefore.has(x.name)) && x.status === "Pending Review" && x.name > ([...reviewsBefore].sort().pop() ?? ""))) {
					await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: r.name, reason: `test cleanup (${id})` } }).catch(() => {});
					f.note(`test cleanup voided the unresolved review row ${r.name}`);
				}
				const seat = await loginApiSeat(playwright, n).catch(() => null);
				if (seat) {
					await closeLeftoverShiftsDetailed(admin, seat.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close cashier ${n}'s shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
					await seat.dispose();
				}
			}
			a.forgetShift();
		}
		await extraCleanup?.(admin).catch(() => {});
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("OFF-07 — the offline queue and the browser's storage", () => {
	test("OFF-07a — reload while offline with bills queued", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-07a", "3 bills queued offline; the page is reloaded while still offline; then the network returns", { cashiers, playwright }, async (a, shift, f, data, admin) => {
			const qtys = [1, 2, 3];
			await a.context.setOffline(true);
			const depth = await sellOffline(a.page, ITEMS.stock, qtys);
			f.check((depth[depth.length - 1] ?? 0) >= qtys.length, `only ${depth[depth.length - 1] ?? 0}/${qtys.length} bills were queued`);
			let reloaded = true;
			try {
				await a.page.reload({ timeout: 30_000 });
				await expect(a.page.getByRole("textbox", { name: /Search/ }).or(a.page.locator(".pay-button")).first()).toBeVisible({ timeout: 30_000 });
			} catch (e) {
				reloaded = false;
				f.note(`the page could not be reloaded while offline: ${String(e).split("\n")[0]}`);
			}
			data.reloadedOffline = reloaded;
			f.expectSafe(reloaded, "the POS screen cannot be reloaded while offline (a cashier who refreshes the page loses the screen until the network returns)");
			if (reloaded) {
				const rows = (await outboxRows(a.page)) ?? [];
				f.note(`after the reload: ${rows.length} bill(s) in the queue`);
				f.expectSafe(rows.length === qtys.length, `the queue holds ${rows.length} bill(s) after a reload, expected ${qtys.length}: accepted bills were lost`);
			}
			await a.context.setOffline(false);
			if (!reloaded) await a.page.reload();
			const drain = await waitForOutboxDrain(a.page, 240_000);
			data.drain = { ms: drain.ms, drained: drain.drained };
			f.check(drain.drained, "the queue did not drain within 240 s");
			f.expectSafe(drain.needsAttention.length === 0, `queue ended needing attention: ${JSON.stringify(drain.needsAttention)}`);
			const submitted = (await invoicesOnShift(admin, shift)).filter((x) => x.docstatus === 1);
			const qs: number[] = [];
			for (const s of submitted) qs.push((await invoiceQty(admin, s.name)).qty);
			f.note(`invoices on the shift: ${submitted.length} with quantities ${JSON.stringify(qs.sort())}`);
			f.expectSafe(submitted.length === qtys.length, `${submitted.length} invoices for ${qtys.length} queued bills`);
			f.expectSafe(JSON.stringify(qs.sort()) === JSON.stringify([...qtys].sort()), `invoice quantities ${JSON.stringify(qs)} differ from the bills made ${JSON.stringify(qtys)}`);
		});
	});

	test("OFF-07b — another cashier logs in on the same browser while A's bills are queued", async ({ cashiers, playwright }) => {
		test.setTimeout(900_000);
		await scenario("OFF-07b", "cashier 6 queues 2 bills offline; replay is held; cashier 7 logs in on the same browser and opens a shift; replay is released", { cashiers, playwright }, async (a, shiftA, f, data, admin) => {
			const qtys = [4, 5];
			// Hold every replay so the bills stay in the browser while the user changes.
			await a.context.route(REPLAY, (route) => route.abort("internetdisconnected"));
			await a.context.setOffline(true);
			const depth = await sellOffline(a.page, ITEMS.stock, qtys);
			f.check((depth[depth.length - 1] ?? 0) >= qtys.length, `only ${depth[depth.length - 1] ?? 0}/${qtys.length} bills were queued`);
			await a.context.setOffline(false);

			// Cashier A signs out; cashier B signs in on the same browser profile.
			// (a real sign-out needs the page's CSRF token; dropping the session cookies has the same effect on the browser)
			await a.context.clearCookies();
			const inRes = await a.context.request.post("/api/method/login", { form: { usr: cashierEmail(B), pwd: cashierPassword(B) ?? "" } });
			f.check(inRes.ok(), `could not log ${cashierEmail(B)} in on the same browser: HTTP ${inRes.status()}`);
			const who = await (await a.context.request.get("/api/method/frappe.auth.get_logged_user")).json().catch(() => ({}));
			f.note(`session user on this browser now: ${who?.message}`);
			f.check(who?.message === cashierEmail(B), `the browser is signed in as ${who?.message}, not ${cashierEmail(B)}`);
			const state = await gotoPos(a.page);
			f.note(`after cashier ${B} logged in on the same browser: screen is "${state}"`);
			const rowsAfterSwitch = (await outboxRows(a.page)) ?? [];
			data.rowsAfterSwitch = rowsAfterSwitch.map((r) => ({ type: r.type, status: r.status }));
			f.note(`bills still in this browser's queue after the switch: ${rowsAfterSwitch.length}`);
			f.expectSafe(rowsAfterSwitch.length >= qtys.length, `the queue holds ${rowsAfterSwitch.length} bill(s) after another cashier signed in, expected ${qtys.length}: cashier A's accepted bills were purged`);

			if (state === "dialog") await fillOpeningDialog(a.page, { company: COMPANY, posProfile: PROFILES.P1, openingCash: "0" });
			const [shiftB] = await listOpeningShifts(admin, { user: cashierEmail(B), status: "Open" });
			f.check(Boolean(shiftB), `cashier ${B} has no open shift`);

			// Release the replay, recording what the server answers to each replay request.
			const replies: { status: number; body: string }[] = [];
			a.page.on("response", async (r) => {
				if (REPLAY.test(r.url())) replies.push({ status: r.status(), body: (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300) });
			});
			await a.context.unrouteAll({ behavior: "ignoreErrors" });
			const drain = await waitForOutboxDrain(a.page, 300_000);
			const rows = (await outboxRows(a.page)) ?? [];
			data.drain = { ms: drain.ms, drained: drain.drained, rows };
			f.note(`after release: drained=${drain.drained}; rows=${JSON.stringify(rows.map((r) => ({ type: r.type, status: r.status, err: r.last_error_category })))}`);

			data.replayReplies = replies;
			f.note(`server answers to the replay requests: ${JSON.stringify(replies)}`);
			const onA = (await invoicesOnShift(admin, shiftA)).filter((x) => x.docstatus === 1);
			const onB = shiftB ? (await invoicesOnShift(admin, shiftB.name)).filter((x) => x.docstatus === 1) : [];
			const detailsA = await Promise.all(onA.map((x) => invoiceQty(admin, x.name)));
			const detailsB = await Promise.all(onB.map((x) => invoiceQty(admin, x.name)));
			data.invoicesOnA = detailsA;
			data.invoicesOnB = detailsB;
			f.note(`A's shift: ${JSON.stringify(detailsA)}; B's shift: ${JSON.stringify(detailsB)}`);
			const reviews = (await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: cashierEmail(A) }, ["name", "status"], 5000)).length;
			f.expectSafe(detailsB.length === 0, `${detailsB.length} invoice(s) of A's bills landed on cashier B's shift: ${JSON.stringify(detailsB)}`);
			f.expectSafe(detailsA.every((d) => d.owner === cashierEmail(A)), `A's bills were attributed to ${JSON.stringify(detailsA.map((d) => d.owner))}`);
			const visibleException = rows.some((r) => ["needs_review", "handed_off"].includes(r.status ?? ""));
			f.expectSafe(
				detailsA.length === qtys.length || visibleException,
				`only ${detailsA.length}/${qtys.length} of A's bills became invoices and none is flagged: rows=${JSON.stringify(rows.map((r) => r.status))}, review rows for A=${reviews}`,
			);
		}, async (admin) => {
			// make sure B's shift does not linger
			const left = await getList<{ name: string }>(admin, "POS Opening Shift", { user: cashierEmail(B), status: "Open" }, ["name"]);
			void left;
		});
	});

	test("OFF-07c — storage refuses writes to the queue (quota full)", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-07c", "the browser throws QuotaExceededError on writes to the offline queue while offline; one sale is attempted, then storage recovers and it is retried", { cashiers, playwright }, async (a, shift, f, data, admin) => {
			await a.context.addInitScript(() => {
				const orig = IDBObjectStore.prototype;
				for (const m of ["add", "put"] as const) {
					const real = orig[m];
					orig[m] = function (this: IDBObjectStore, ...args: any[]) {
						if ((window as any).__quota && this.name === "outbox") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
						return (real as any).apply(this, args);
					} as any;
				}
			});
			await a.page.reload();
			await gotoPos(a.page);
			await a.context.setOffline(true);
			await a.page.evaluate(() => ((window as any).__quota = true));

			await prepareCashSale(a.page, ITEMS.stock, 2);
			await a.page.getByRole("button", { name: "Submit", exact: true }).click();
			const msgs = await collectMessages(a, 8_000);
			const success = msgs.some((m) => /is Submited/i.test(m));
			const rows = (await outboxRows(a.page)) ?? [];
			const cartHas = await a.page.locator(".invoice-cart-section").getByRole("row", { name: ITEMS.stock }).count();
			data.blocked = { messages: msgs, queued: rows.length, cartRows: cartHas };
			f.note(`with storage full: messages=${JSON.stringify(msgs)}; bills queued=${rows.length}; item still in the cart=${cartHas > 0}`);
			f.expectSafe(!success, "the screen said the sale was submitted although storage refused to queue it");
			f.expectSafe(rows.length === 0, `${rows.length} bill(s) were half-queued while storage refused writes`);
			f.expectSafe(msgs.length > 0, "the sale was refused with no message at all: the cashier is not told why");
			f.expectSafe(cartHas > 0, "the cart was cleared although the bill was not stored: the cashier cannot retry without re-entering the sale");

			// Storage recovers: the same sale must go through.
			await a.page.evaluate(() => ((window as any).__quota = false));
			if (cartHas > 0 && (await a.page.getByRole("button", { name: "Submit", exact: true }).count()) === 0) await prepareCashSale(a.page, ITEMS.stock, 0);
			if ((await a.page.getByRole("button", { name: "Submit", exact: true }).count()) === 0) {
				await a.page.locator(".pay-button").click();
				await a.page.getByRole("button", { name: "Cash", exact: true }).click();
			}
			await a.page.getByRole("button", { name: "Submit", exact: true }).click();
			let after = (await outboxRows(a.page)) ?? [];
			for (let i = 0; i < 30 && after.length < 1; i++) {
				await a.page.waitForTimeout(500);
				after = (await outboxRows(a.page)) ?? [];
			}
			f.note(`after storage recovered and Submit pressed again: ${after.length} bill(s) queued`);
			f.expectSafe(after.length === 1, `after storage recovered the sale was not queued (${after.length} bill(s))`);
			await a.context.setOffline(false);
			const drain = await waitForOutboxDrain(a.page, 240_000);
			f.check(drain.drained, "the recovered bill did not sync");
			const onShift = (await invoicesOnShift(admin, shift)).filter((x) => x.docstatus === 1);
			f.expectSafe(onShift.length === 1, `${onShift.length} invoices on the shift, expected exactly 1`);
		});
	});

	test("OFF-07d — IndexedDB is unavailable", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await scenario("OFF-07d", "indexedDB.open is made to fail in the browser, then the network is cut and one sale is attempted", { cashiers, playwright }, async (a, shift, f, data, admin) => {
			await a.context.addInitScript(() => {
				const real = indexedDB.open.bind(indexedDB);
				indexedDB.open = ((...args: any[]) => {
					if (localStorage.getItem("__noIdb") === "1") {
						const req: any = { onerror: null, onsuccess: null, onupgradeneeded: null, error: new DOMException("blocked", "SecurityError"), result: undefined, readyState: "done" };
						setTimeout(() => {
							req.onerror?.({ target: req, type: "error", preventDefault() {}, stopPropagation() {} });
							req.dispatchEvent?.(new Event("error"));
						}, 0);
						return req;
					}
					return (real as any)(...args);
				}) as any;
			});
			await a.page.evaluate(() => localStorage.setItem("__noIdb", "1"));
			await a.page.reload();
			const usable = await gotoPos(a.page).catch((e) => `error: ${String(e).split("\n")[0]}`);
			data.screenWithoutStorage = usable;
			f.note(`POS screen with IndexedDB unavailable (online): ${usable}`);
			await a.context.setOffline(true);
			let attempted = true;
			try {
				await prepareCashSale(a.page, ITEMS.stock, 1);
				await a.page.getByRole("button", { name: "Submit", exact: true }).click();
			} catch (e) {
				attempted = false;
				f.note(`the offline sale could not even be prepared: ${String(e).split("\n")[0]}`);
			}
			const msgs = await collectMessages(a, 8_000);
			const success = msgs.some((m) => /is Submited/i.test(m));
			data.offlineAttempt = { attempted, messages: msgs };
			f.note(`offline sale attempt with no storage: messages=${JSON.stringify(msgs)}`);
			f.expectSafe(!success, "the screen said the sale was submitted although there was no storage and no network");
			if (attempted) f.expectSafe(msgs.length > 0, "the sale was neither accepted nor explained: the cashier is not told why");
			await a.context.setOffline(false);
			await a.page.evaluate(() => localStorage.removeItem("__noIdb"));
			const onShift = (await invoicesOnShift(admin, shift)).filter((x) => x.docstatus === 1);
			f.expectSafe(onShift.length === 0, `${onShift.length} invoice(s) exist on the shift although no sale was accepted`);
		});
	});
});
