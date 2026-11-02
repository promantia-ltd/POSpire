/**
 * CON-05 (P0): two tabs of ONE browser (same login, same IndexedDB, same
 * offline outbox) must not interfere with each other.
 *
 * Arrangement: one cashier, one shift. Tab 1 opens the shift. Tab 2 is opened
 * afterwards in the same browser context. Then, with the network off, each tab
 * makes a different sale (tab 1: 1 unit, tab 2: 2 units, so an overwritten or
 * swapped sale shows up in the numbers). The network comes back and both tabs
 * are free to drain the shared outbox.
 *
 * Expected: tab 2 joins the existing shift (no second shift, no second opening
 * dialog); both sales reach the server exactly once, with the right quantities,
 * on the one shift and owned by this cashier; the queue ends empty; stock fell
 * by exactly 3 units and the ledger balances. A second shift, a lost, duplicated
 * or swapped sale, or a queue left needing attention is recorded as a defect.
 *
 * How many replay requests each tab sent is recorded as an observation: if the
 * app lets both tabs send the same queued sale, the server's offline id is the
 * only thing preventing a duplicate, and the evidence says so.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { outboxRows, waitForOutboxDrain } from "./helpers/outbox";
import { gotoPos, prepareCashSale } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

const KEYS = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];
const RATE = 1000;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

test.describe("CON-05 — two tabs, one browser", () => {
	test("CON-05 — both tabs sell offline, the shared queue syncs every sale exactly once", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let completed = false;
		const data: Record<string, unknown> = {};
		let c1: Awaited<ReturnType<typeof cashiers.login>> | undefined;

		try {
			c1 = await cashiers.login(1);
			const left = await closeLeftoverShifts(admin, c1);
			if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);

			// ---- tab 1 opens the shift --------------------------------------------------------
			await c1.openShift(PROFILES.P1, "0");
			const [shift] = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			f.check(Boolean(shift), "no open shift after opening it in tab 1");
			const tab1 = c1.page;

			// ---- tab 2 joins the same browser -------------------------------------------------
			const tab2 = await c1.newTab();
			const state = await gotoPos(tab2).catch((e) => `error: ${String(e).split("\n")[0]}`);
			f.note(`tab 2 opened the POS and saw: ${state}`);
			f.expectSafe(state === "open", `tab 2 did not pick up the shift opened in tab 1 (saw "${state}")`);
			if (state === "dialog") {
				f.note("tab 2 is asking to open a new shift while one is already open");
			}
			const shiftsAfterTab2 = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			f.expectSafe(shiftsAfterTab2.length === 1, `${shiftsAfterTab2.length} open shifts for one cashier after opening a second tab (expected 1)`);
			f.check(state === "open", "tab 2 could not be used for selling, so the offline part cannot run");
			if (state !== "open") throw new Error("tab 2 has no open shift to sell on");

			const before = await snapshotBins(admin, KEYS);

			// ---- watch what each tab sends once the network is back --------------------------
			const replays = { tab1: 0, tab2: 0 };
			tab1.on("request", (r) => {
				if (/api\.offline\.submit_invoice|posapp\.submit_invoice/.test(r.url())) replays.tab1 += 1;
			});
			tab2.on("request", (r) => {
				if (/api\.offline\.submit_invoice|posapp\.submit_invoice/.test(r.url())) replays.tab2 += 1;
			});

			// ---- network off: each tab queues a different sale -------------------------------
			await c1.context.setOffline(true);
			const queued = async (tab: typeof tab1, qty: number, expectRows: number) => {
				await prepareCashSale(tab, ITEMS.stock, qty);
				await tab.getByRole("button", { name: "Submit", exact: true }).click();
				let rows = await outboxRows(tab);
				for (let i = 0; i < 40 && (rows?.length ?? 0) < expectRows; i++) {
					await tab.waitForTimeout(500);
					rows = await outboxRows(tab);
				}
				return rows;
			};
			const afterTab1 = await queued(tab1, 1, 1);
			f.check((afterTab1?.length ?? 0) >= 1, `tab 1's sale was not queued while offline (outbox rows: ${afterTab1?.length ?? "none"})`);
			const afterTab2 = await queued(tab2, 2, 2);
			f.check((afterTab2?.length ?? 0) >= 2, `tab 2's sale was not queued while offline (outbox rows: ${afterTab2?.length ?? "none"})`);
			data.queuedRows = afterTab2?.length ?? 0;
			f.note(`while offline: ${afterTab1?.length ?? 0} queued after tab 1's sale, ${afterTab2?.length ?? 0} after tab 2's (shared outbox)`);

			// ---- network back: both tabs may try to drain the shared queue --------------------
			await c1.context.setOffline(false);
			const drain = await waitForOutboxDrain(tab1, 120_000);
			data.drain = { ms: drain.ms, drained: drain.drained, rows: drain.rows };
			f.note(`shared queue after reconnect: drained=${drain.drained} in ${drain.ms} ms; rows=${JSON.stringify(drain.rows)}`);
			f.check(drain.drained, "the shared queue did not drain within 120 s");
			f.expectSafe(drain.needsAttention.length === 0, `queue ended needing manual attention: ${JSON.stringify(drain.needsAttention)}`);
			const other = await outboxRows(tab2);
			f.note(`tab 2's own view of the queue after the drain: ${JSON.stringify(other)}`);
			data.replays = replays;
			f.note(`submit requests sent after reconnect: tab 1 = ${replays.tab1}, tab 2 = ${replays.tab2} (2 sales queued in total)`);
			if (replays.tab1 + replays.tab2 > 2) {
				f.note("more requests were sent than sales queued: both tabs sent at least one sale, so only the server's offline id prevents a duplicate");
			}

			// ---- what the server ended up with ------------------------------------------------
			let onShift = await invoicesOnShift(admin, shift.name);
			for (let i = 0; i < 20 && onShift.filter((x) => x.docstatus === 1).length < 2; i++) {
				await tab1.waitForTimeout(1_000);
				onShift = await invoicesOnShift(admin, shift.name);
			}
			const submitted = onShift.filter((x) => x.docstatus === 1);
			f.note(`invoices on the shift: ${JSON.stringify(onShift)}`);
			f.expectSafe(submitted.length === 2, `${submitted.length} submitted invoices for 2 sales (lost or duplicated)`);
			f.expectSafe(
				onShift.filter((x) => x.docstatus === 0).length === 0,
				`draft invoice(s) left behind: ${onShift.filter((x) => x.docstatus === 0).map((x) => x.name).join(", ")}`,
			);
			for (const inv of submitted) {
				f.expectSafe(inv.owner === c1.email, `${inv.name} is owned by ${inv.owner}, not ${c1.email}`);
			}
			const offlineIds = submitted.map((x) => x.pos_offline_id).filter(Boolean);
			f.expectSafe(new Set(offlineIds).size === offlineIds.length, `two invoices share an offline id: ${JSON.stringify(offlineIds)}`);

			// Match each invoice to the sale it should be by quantity (1 unit from tab 1, 2 from tab 2).
			const byQty = new Map<number, string[]>();
			for (const inv of submitted) {
				const doc = await getDoc<Record<string, any>>(admin, "Sales Invoice", inv.name);
				const qty = (doc?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				byQty.set(qty, [...(byQty.get(qty) ?? []), inv.name]);
			}
			f.note(`invoices by total quantity: ${JSON.stringify([...byQty.entries()])}`);
			for (const qty of [1, 2]) {
				const names = byQty.get(qty) ?? [];
				f.expectSafe(names.length === 1, `${names.length} invoice(s) with quantity ${qty} (expected exactly 1: a sale was lost, duplicated or swapped)`);
				if (names.length === 1) {
					const s = manifest.add({
						txnId: newTxnId("con05"),
						cashier: c1.email,
						company: COMPANY,
						posProfile: PROFILES.P1,
						warehouse: WAREHOUSES.A,
						items: [{ item_code: ITEMS.stock, qty, rate: RATE }],
						payments: [{ mode_of_payment: "Cash", amount: RATE * qty }],
						expectedGrandTotal: RATE * qty,
						openingShift: shift.name,
						invoice: names[0],
					});
					manifest.update(s.txnId, { state: "accepted" });
				}
			}
			await verifyManifest(admin, manifest, before, KEYS, f);

			const closed = await closeLeftoverShiftsDetailed(admin, c1);
			f.expectSafe(closed.stuck.length === 0, `could not close the shift afterwards: ${JSON.stringify(closed.stuck)}`);
			c1.forgetShift();
			completed = true;
		} finally {
			manifest.save();
			if (c1) await c1.context.setOffline(false).catch(() => {});
			const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
			if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
			recordEvidence({
				id: "CON-05",
				arrangement: "one cashier, two tabs of the same browser, each queuing a different sale offline, both free to sync",
				outcome,
				notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
				data,
			});
			await admin.dispose();
		}
		expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
		expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
	});
});
