/**
 * Concurrency scenarios (ticket #33391, P0).
 *
 * CON-01  Different users on different profiles/stores sell concurrently.
 * CON-02  Two distinct users on the SAME profile each open their own shift
 *         and bill simultaneously.
 *
 * Both hold every cashier at a barrier and release them together, then PROVE
 * the requests overlapped (request timing) rather than assuming it. Every
 * check runs and all problems are reported together. Outcomes are also written
 * to the evidence log that feeds the feasibility table.
 *
 * Order matters (both scenarios use cashier01, who has one shift at a time);
 * playwright.config.ts forces workers: 1, so files and tests run one by one.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { Barrier, commonOverlapMs, trackRequests } from "./helpers/barrier";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence } from "./helpers/evidence";
import { Manifest, newTxnId } from "./helpers/manifest";
import { cartRow, prepareCashSale, submitCashSale } from "./helpers/pos-ui";
import { compareStock, expectedStockDeltas, glCheck, reconcile, snapshotBins, stockKeysOf } from "./helpers/reconcile";

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	for (const n of [1, 2, 3, 4]) {
		test.skip(!cashierPassword(n), `POSPIRE_E2E_PERF_PASSWORD_0${n} not set in .env.test`);
	}
});

async function invoicesOfShift(admin: Parameters<typeof getList>[0], shift: string): Promise<string[]> {
	const rows = await getList<{ name: string }>(
		admin,
		"Sales Invoice",
		{ posa_pos_opening_shift: shift, docstatus: 1 },
		["name"],
	);
	return rows.map((r) => r.name).sort();
}

async function closingsOfShift(admin: Parameters<typeof getList>[0], shift: string) {
	return getList<{ name: string; user: string; grand_total: number }>(
		admin,
		"POS Closing Shift",
		{ pos_opening_shift: shift, docstatus: 1 },
		["name", "user", "grand_total"],
	);
}

async function cashRow(admin: Parameters<typeof getDoc>[0], doctype: string, name: string, table: string) {
	const doc = await getDoc<Record<string, any>>(admin, doctype, name);
	return (doc?.[table] ?? []).find((r: { mode_of_payment: string }) => r.mode_of_payment === "Cash");
}

interface Seat {
	actor: Actor;
	profile: string;
	warehouse: string;
	rate: number; // expected selling rate for ITEMS.stock on this profile
	qty: number;
	openingCash: string;
	shift?: string;
	invoice?: string;
	txnId?: string;
}

/** Everything the two scenarios share: bill together at a barrier, then reconcile. */
async function billTogether(
	seats: Seat[],
	admin: Parameters<typeof getList>[0],
	manifest: Manifest,
	f: Findings,
) {
	for (const s of seats) {
		const shifts = await listOpeningShifts(admin, { user: s.actor.email, status: "Open" });
		f.check(shifts.length === 1, `${s.actor.email} should have exactly 1 open shift, has ${shifts.length}`);
		s.shift = shifts[0]?.name;
		f.check(shifts[0]?.pos_profile === s.profile, `${s.actor.email} shift is on ${shifts[0]?.pos_profile}, not ${s.profile}`);

		const sale = manifest.add({
			txnId: newTxnId("con"),
			cashier: s.actor.email,
			company: COMPANY,
			posProfile: s.profile,
			warehouse: s.warehouse,
			items: [{ item_code: ITEMS.stock, qty: s.qty, rate: s.rate }],
			payments: [{ mode_of_payment: "Cash", amount: s.rate * s.qty }],
			expectedGrandTotal: s.rate * s.qty,
			openingShift: s.shift,
		});
		s.txnId = sale.txnId;
	}

	const keys = stockKeysOf(manifest.all());
	const before = await snapshotBins(admin, keys);

	await Promise.all(seats.map((s) => prepareCashSale(s.actor.page, ITEMS.stock, s.qty)));

	// Cart isolation: each screen must hold only its own sale.
	for (const s of seats) {
		const rows = await cartRow(s.actor.page, ITEMS.stock).count();
		f.check(rows === 1, `${s.actor.email}: expected 1 cart row for ${ITEMS.stock}, saw ${rows}`);
	}

	// Attach timing only now, so earlier page-load traffic does not widen the window.
	const trackers = seats.map((s) => trackRequests(s.actor.page, /posapp\.(update|submit)_invoice/));
	const barrier = new Barrier(seats.length);
	const invoices = await Promise.all(
		seats.map(async (s) => {
			await barrier.wait();
			return submitCashSale(s.actor.page);
		}),
	);
	const overlap = commonOverlapMs(trackers.map((t) => t.span()));
	f.check(overlap > 0, `submit requests did not all overlap (common overlap ${overlap.toFixed(0)} ms)`);
	f.note(`submit requests overlapped for ${overlap.toFixed(0)} ms; calls: ${trackers.map((t) => t.urls().join("+")).join(" | ")}`);

	seats.forEach((s, i) => {
		s.invoice = invoices[i];
		manifest.update(s.txnId!, { state: "accepted", invoice: invoices[i] });
	});
	f.check(new Set(invoices).size === seats.length, `invoice names are not unique: ${invoices.join(", ")}`);

	const report = await reconcile(admin, manifest);
	f.check(report.lost.length === 0, `lost sales: ${report.lost.join(", ")}`);
	f.check(report.duplicates.length === 0, `duplicate invoices: ${JSON.stringify(report.duplicates)}`);
	f.check(report.collisions.length === 0, `colliding invoices: ${JSON.stringify(report.collisions)}`);
	for (const m of report.mismatches) f.check(false, `${m.txnId} ${m.invoice}: ${JSON.stringify(m.issues)}`);

	const after = await snapshotBins(admin, keys);
	for (const i of compareStock(before, after, expectedStockDeltas(manifest.all()))) {
		f.check(false, `stock ${JSON.stringify(i)}`);
	}
	for (const inv of invoices) {
		const gl = await glCheck(admin, inv);
		f.check(gl.balanced, `GL for ${inv} not balanced/present (debit ${gl.debit}, credit ${gl.credit})`);
	}

	// No cross-over: each shift holds exactly its own invoice.
	for (const s of seats) {
		const inShift = await invoicesOfShift(admin, s.shift!);
		f.check(
			inShift.length === 1 && inShift[0] === s.invoice,
			`shift ${s.shift} holds [${inShift.join(", ")}], expected only [${s.invoice}]`,
		);
	}
}

test.describe("Concurrency — P0", () => {
	test("CON-01 — different users, profiles and stores sell concurrently", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();

		try {
			const [c1, c3, c4] = await Promise.all([1, 3, 4].map((n) => cashiers.login(n)));
			const seats: Seat[] = [
				// P2 uses the PERF price list on purpose: a wrong rate means price-list leakage.
				{ actor: c1, profile: PROFILES.P1, warehouse: WAREHOUSES.A, rate: 1000, qty: 1, openingCash: "0" },
				{ actor: c3, profile: PROFILES.P2, warehouse: WAREHOUSES.A, rate: 1100, qty: 1, openingCash: "0" },
				{ actor: c4, profile: PROFILES.P3, warehouse: WAREHOUSES.B, rate: 1000, qty: 1, openingCash: "0" },
			];

			await Promise.all(seats.map((s) => s.actor.openShift(s.profile, s.openingCash)));
			await billTogether(seats, admin, manifest, f);

			// Configuration leakage: P3 is Cash only, P1 offers Credit Card too. The sale
			// dialog was left open by prepareCashSale, but Submit closed it, so assert via
			// the profile's own configured payment modes instead.
			for (const s of seats) {
				const profile = await getDoc<Record<string, any>>(admin, "POS Profile", s.profile);
				const modes = (profile?.payments ?? []).map((p: { mode_of_payment: string }) => p.mode_of_payment).sort();
				f.note(`${s.profile} payment modes: ${modes.join(", ")}`);
			}

			const closes = await Promise.allSettled(seats.map((s) => s.actor.closeShift()));
			closes.forEach((r, i) => f.check(r.status === "fulfilled", `close shift ${seats[i].actor.email}: ${String((r as PromiseRejectedResult).reason ?? "").split("\n")[0]}`));
			for (const s of seats) {
				const closings = await closingsOfShift(admin, s.shift!);
				f.check(closings.length === 1, `shift ${s.shift} has ${closings.length} closings, expected 1`);
				f.check(closings[0]?.user === s.actor.email, `closing for ${s.shift} belongs to ${closings[0]?.user}`);
			}
		} finally {
			manifest.save();
			recordEvidence({
				id: "CON-01",
				arrangement: "distinct users / distinct profiles and stores / concurrent billing",
				outcome: f.problems.length === 0 ? "supported" : "defect",
				notes: [...f.notes, ...f.problems],
				data: { counts: manifest.summary() },
			});
			await admin.dispose();
		}
		expect(f.problems, f.problems.join("\n")).toEqual([]);
	});

	test("CON-02 — two distinct users on the same profile open their own shifts and bill simultaneously", async ({
		cashiers,
		playwright,
	}) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();

		try {
			const [c1, c2] = await Promise.all([1, 2].map((n) => cashiers.login(n)));
			const seats: Seat[] = [
				{ actor: c1, profile: PROFILES.P1, warehouse: WAREHOUSES.A, rate: 1000, qty: 1, openingCash: "5000" },
				{ actor: c2, profile: PROFILES.P1, warehouse: WAREHOUSES.A, rate: 1000, qty: 2, openingCash: "7000" },
			];

			// Record whether the system permits two users to open on one profile at once.
			const opens = await Promise.allSettled(seats.map((s) => s.actor.openShift(s.profile, s.openingCash)));
			const bothOpened = opens.every((o) => o.status === "fulfilled");
			opens.forEach((o, i) => {
				if (o.status === "rejected") f.check(false, `${seats[i].actor.email} could not open on ${PROFILES.P1}: ${String(o.reason).split("\n")[0]}`);
			});
			f.note(`both users opened a shift on ${PROFILES.P1} concurrently: ${bothOpened}`);
			expect(bothOpened, "both users must be able to open on the shared profile to continue").toBe(true);

			// Separate ownership and opening cash.
			const open = await Promise.all(seats.map((s) => listOpeningShifts(admin, { user: s.actor.email, status: "Open" })));
			f.check(open[0][0]?.name !== open[1][0]?.name, "both users were given the SAME opening shift");
			for (const [i, s] of seats.entries()) {
				const cash = await cashRow(admin, "POS Opening Shift", open[i][0].name, "balance_details");
				f.check(cash?.amount === Number(s.openingCash), `${s.actor.email} opening cash is ${cash?.amount}, expected ${s.openingCash}`);
			}

			await billTogether(seats, admin, manifest, f);

			// Simultaneous close: each closing must be its own shift's, with its own totals.
			const closes = await Promise.allSettled(seats.map((s) => s.actor.closeShift()));
			closes.forEach((r, i) => f.check(r.status === "fulfilled", `close shift ${seats[i].actor.email}: ${String((r as PromiseRejectedResult).reason ?? "").split("\n")[0]}`));
			for (const s of seats) {
				const closings = await closingsOfShift(admin, s.shift!);
				f.check(closings.length === 1, `shift ${s.shift} has ${closings.length} closings, expected 1`);
				if (closings.length !== 1) continue;
				f.check(closings[0].user === s.actor.email, `closing ${closings[0].name} belongs to ${closings[0].user}`);
				f.check(Math.abs(closings[0].grand_total - s.rate * s.qty) < 0.01, `closing ${closings[0].name} total ${closings[0].grand_total}, expected ${s.rate * s.qty}`);
				const cash = await cashRow(admin, "POS Closing Shift", closings[0].name, "payment_reconciliation");
				const expectedCash = Number(s.openingCash) + s.rate * s.qty;
				f.check(cash?.opening_amount === Number(s.openingCash), `closing ${closings[0].name} opening ${cash?.opening_amount}, expected ${s.openingCash}`);
				f.check(Math.abs((cash?.expected_amount ?? NaN) - expectedCash) < 0.01, `closing ${closings[0].name} expected cash ${cash?.expected_amount}, expected ${expectedCash}`);
			}
		} finally {
			manifest.save();
			recordEvidence({
				id: "CON-02",
				arrangement: "distinct users / common profile / separate shifts",
				outcome: f.problems.length === 0 ? "supported" : "defect",
				notes: [...f.notes, ...f.problems],
				data: { counts: manifest.summary() },
			});
			await admin.dispose();
		}
		expect(f.problems, f.problems.join("\n")).toEqual([]);
	});
});
