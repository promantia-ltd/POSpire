/**
 * FUNC-02 (D9): a sale that contains an item which is not inventory (a service, a fee).
 *
 * PERF-NOSTOCK-001 is a non-stock sales item (pospire/tests/perf_lines.py). A cashier sells
 * one of it, with and without a normal stock item, as the screen would submit it. Expected:
 * the sale is accepted, no Stock Reconciliation is created for it, and no stock ledger
 * entry exists for it. A refusal is a defect: shops sell non-stock items (delivery, repair,
 * gift wrap) every day. The control sells a stock item only, to prove the payload is valid.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, cashierPassword, FIRST_BURST_CASHIER } from "./fixtures/topology";
import { loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { errorText } from "./helpers/as-user";
import { deleteDrafts } from "./helpers/admin-fixtures";
import { getDoc, getList, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";

const NOSTOCK = "PERF-NOSTOCK-001";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(FIRST_BURST_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

test("FUNC-02 — a sale containing a non-stock item", async ({ playwright }) => {
	test.setTimeout(300_000);
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	const drafts: string[] = [];
	let completed = false;
	const seat = await loginApiSeat(playwright, FIRST_BURST_CASHIER);
	try {
		const stuck = (await closeLeftoverShiftsDetailed(admin, seat.actor, { visitPos: false })).stuck;
		f.check(stuck.length === 0, `could not clear a leftover shift: ${JSON.stringify(stuck)}`);
		const shift = (await openShiftApi(seat, COMPANY, PROFILES.P1)).result.json?.message?.pos_opening_shift?.name as string;
		f.check(Boolean(shift), "could not open a shift");
		const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
		f.note(`profile ${PROFILES.P1}: posa_auto_stock_reconcile = ${profile?.posa_auto_stock_reconcile}`);
		const sell = async (label: string, items: { item_code: string; qty: number; rate: number }[]) => {
			const d = await createDraft(seat.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items }));
			if (d.doc?.name) drafts.push(d.doc.name);
			f.check(Boolean(d.doc), `${label}: could not draft: HTTP ${d.res.status} ${errorText(d.res)}`);
			if (!d.doc) return null;
			const total = items.reduce((a, i) => a + i.qty * i.rate, 0);
			const r = await submitDraft(seat.actor, d.doc, { cashAmount: total });
			data[label] = { status: r.status, error: r.status === 200 ? null : errorText(r).slice(0, 300) };
			f.note(`${label}: HTTP ${r.status}${r.status === 200 ? "" : " " + errorText(r).slice(0, 220)}`);
			return r;
		};
		const control = await sell("control (stock item only)", [{ item_code: ITEMS.stock, qty: 1, rate: 1000 }]);
		f.check(control?.status === 200, "the control sale was refused, so the payload is wrong and the result means nothing");
		const only = await sell("non-stock item only", [{ item_code: NOSTOCK, qty: 1, rate: 100 }]);
		f.expectSafe(only?.status === 200, `a sale of a non-stock item was refused (HTTP ${only?.status}): ${only ? errorText(only).slice(0, 200) : ""}`);
		const mixed = await sell("stock item plus non-stock item", [
			{ item_code: ITEMS.stock, qty: 1, rate: 1000 },
			{ item_code: NOSTOCK, qty: 1, rate: 100 },
		]);
		f.expectSafe(mixed?.status === 200, `a sale mixing a stock and a non-stock item was refused (HTTP ${mixed?.status}): ${mixed ? errorText(mixed).slice(0, 200) : ""}`);
		const sle = await getList(admin, "Stock Ledger Entry", { item_code: NOSTOCK }, ["name"], 5);
		const recon = await getList(admin, "Stock Reconciliation Item", { item_code: NOSTOCK }, ["name"], 5);
		f.expectSafe(sle.length === 0 && recon.length === 0, `stock records exist for a non-stock item: ${sle.length} ledger entries, ${recon.length} reconciliation rows`);
		completed = true;
	} finally {
		await deleteDrafts(admin, drafts).catch(() => []);
		await closeLeftoverShiftsDetailed(admin, seat.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close the shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
		await seat.dispose();
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id: "FUNC-02", arrangement: "a cashier submits a sale of a non-stock item alone and mixed with a stock item, on a profile with automatic stock reconciliation", outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
});
