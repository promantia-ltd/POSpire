/**
 * Proof of the Step C reconciliation layer.
 *
 * REC-U*  pure comparison logic against synthetic documents (no browser, no
 *         backend): shows each class of defect the ticket cares about (lost
 *         bill, wrong cashier/profile/warehouse/shift, wrong totals, stock
 *         drift) is actually detected, so a green reconcile means something.
 * REC-01  one real UI cash sale by a seeded cashier, reconciled against an
 *         independent manifest: invoice, attribution, shift, items, payment,
 *         stock movement and a balanced GL.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierEmail, cashierPassword } from "./fixtures/topology";
import { listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Manifest, newTxnId, type ExpectedSale } from "./helpers/manifest";
import { completeCashSale } from "./helpers/pos-ui";
import {
	compareInvoice,
	compareStock,
	expectedStockDeltas,
	glCheck,
	reconcile,
	snapshotBins,
	stockKeysOf,
	type InvoiceDoc,
} from "./helpers/reconcile";

const sale = (over: Partial<ExpectedSale> = {}): ExpectedSale => ({
	txnId: "t1",
	runId: "r",
	cashier: cashierEmail(1),
	company: COMPANY,
	posProfile: PROFILES.P1,
	warehouse: WAREHOUSES.A,
	items: [{ item_code: ITEMS.stock, qty: 2, rate: 1000 }],
	payments: [{ mode_of_payment: "Cash", amount: 2000 }],
	expectedGrandTotal: 2000,
	openingShift: "SHIFT-1",
	state: "submitted",
	...over,
});

const goodInvoice = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
	name: "SINV-1",
	docstatus: 1,
	owner: cashierEmail(1),
	company: COMPANY,
	pos_profile: PROFILES.P1,
	posa_pos_opening_shift: "SHIFT-1",
	grand_total: 2000,
	change_amount: 0,
	items: [{ item_code: ITEMS.stock, qty: 2, rate: 1000, warehouse: WAREHOUSES.A }],
	payments: [{ mode_of_payment: "Cash", amount: 2000 }],
	...over,
});

test.describe("Reconciliation — pure comparison logic", () => {
	test("REC-U1 — a correct invoice produces no issues", () => {
		expect(compareInvoice(sale(), goodInvoice())).toEqual([]);
	});

	test("REC-U2 — misattribution is caught: wrong cashier, profile, warehouse and shift", () => {
		const issues = compareInvoice(
			sale(),
			goodInvoice({
				owner: cashierEmail(2),
				pos_profile: PROFILES.P2,
				posa_pos_opening_shift: "SHIFT-2",
				items: [{ item_code: ITEMS.stock, qty: 2, rate: 1000, warehouse: WAREHOUSES.B }],
			}),
		);
		const fields = issues.map((i) => i.field);
		expect(fields).toEqual(
			expect.arrayContaining(["owner (cashier attribution)", "pos_profile", "opening shift"]),
		);
		expect(fields.some((f) => f.startsWith("warehouse of"))).toBe(true);
	});

	test("REC-U3 — wrong quantity, rate, total and payment are caught; rounding within 0.01 is not", () => {
		const bad = compareInvoice(
			sale(),
			goodInvoice({
				grand_total: 1500,
				items: [{ item_code: ITEMS.stock, qty: 1, rate: 750, warehouse: WAREHOUSES.A }],
				payments: [{ mode_of_payment: "Cash", amount: 1500 }],
			}),
		);
		expect(bad.map((i) => i.field)).toEqual(
			expect.arrayContaining([`qty of ${ITEMS.stock}`, `rate of ${ITEMS.stock}`, "grand total", "net paid"]),
		);
		expect(compareInvoice(sale(), goodInvoice({ grand_total: 2000.004 }))).toEqual([]);
	});

	test("REC-U4 — change given is netted out of the paid amount", () => {
		const inv = goodInvoice({
			payments: [{ mode_of_payment: "Cash", amount: 2500 }],
			change_amount: 500,
		});
		expect(compareInvoice(sale(), inv)).toEqual([]);
	});

	test("REC-U5 — a draft or cancelled invoice is not a successful sale", () => {
		expect(compareInvoice(sale(), goodInvoice({ docstatus: 0 })).map((i) => i.field)).toContain("docstatus");
		expect(compareInvoice(sale(), goodInvoice({ docstatus: 2 })).map((i) => i.field)).toContain("docstatus");
	});

	test("REC-U6 — stock drift is caught, and only submitted sales are expected to move stock", () => {
		const sales = [sale(), sale({ txnId: "t2", state: "rejected" })];
		const expected = expectedStockDeltas(sales);
		const k = `${ITEMS.stock}|${WAREHOUSES.A}`;
		expect(expected.get(k)).toBe(-2);

		const before = new Map([[k, 500]]);
		expect(compareStock(before, new Map([[k, 498]]), expected)).toEqual([]);
		expect(compareStock(before, new Map([[k, 497]]), expected)).toHaveLength(1); // oversold
		expect(compareStock(before, new Map([[k, 500]]), expected)).toHaveLength(1); // stock never moved
	});
});

test.describe("Reconciliation — real UI sale (REC-01)", () => {
	test.beforeEach(() => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
	});

	test("REC-01 — a UI cash sale reconciles against the manifest, stock and GL", async ({
		cashiers,
		playwright,
	}) => {
		test.setTimeout(150_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();

		try {
			const c1 = await cashiers.login(1);
			await c1.openShift(PROFILES.P1);
			const [shift] = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			expect(shift.pos_profile).toBe(PROFILES.P1);

			const txn = manifest.add({
				txnId: newTxnId("rec01"),
				cashier: c1.email,
				company: COMPANY,
				posProfile: PROFILES.P1,
				warehouse: WAREHOUSES.A,
				items: [{ item_code: ITEMS.stock, qty: 1, rate: 1000 }],
				payments: [{ mode_of_payment: "Cash", amount: 1000 }],
				expectedGrandTotal: 1000,
				openingShift: shift.name,
			});

			const keys = stockKeysOf(manifest.all());
			const before = await snapshotBins(admin, keys);

			const invoice = await completeCashSale(c1.page, ITEMS.stock);
			manifest.update(txn.txnId, { state: "accepted", invoice });

			const report = await reconcile(admin, manifest);
			manifest.save();

			expect(report.lost).toEqual([]);
			expect(report.duplicates).toEqual([]);
			expect(report.mismatches).toEqual([]);
			expect(report.ok).toBe(true);
			expect(manifest.summary().submitted).toBe(1);

			const after = await snapshotBins(admin, keys);
			expect(compareStock(before, after, expectedStockDeltas(manifest.all()))).toEqual([]);

			const gl = await glCheck(admin, invoice);
			expect(gl.count, "invoice must have GL entries").toBeGreaterThan(0);
			expect(gl.balanced, `GL debit ${gl.debit} vs credit ${gl.credit}`).toBe(true);

			await c1.closeShift();
		} finally {
			await admin.dispose();
		}
	});
});
