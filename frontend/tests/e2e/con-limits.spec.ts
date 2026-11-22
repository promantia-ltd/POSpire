/**
 * CON-08 (P0): limited resources must stay limited under concurrency.
 *
 * CON-08a  Two cashiers sell the LAST unit at the same moment.
 * CON-08b  Two cashiers return the SAME original quantity at the same moment.
 * CON-08c  Two cashiers redeem the SAME one-use coupon at the same moment.
 *
 * Expected, per the configured policy (negative stock is off, returns are
 * capped by the original invoice, a coupon has a maximum use): the limit holds,
 * the loser is refused deterministically and with a controlled error, and no
 * stock, return or redemption exceeds its limit. Excess redemption, stock below
 * zero, an over-return or an uncontrolled 5xx is recorded as a defect.
 *
 * 08a drives the real screen. 08b/08c go straight to the server as each
 * cashier's own session, with the payload the screen sends, because they need
 * exact, repeatable control of two simultaneous submissions.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect, type Actor } from "./fixtures/actors";
import { COMPANY, COUPON_OFFER, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { errorText } from "./helpers/as-user";
import { binQty, getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Barrier, commonOverlapMs } from "./helpers/barrier";
import { createCoupon, deleteDrafts, ensureStock } from "./helpers/admin-fixtures";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { Manifest, RUN_ID, newTxnId } from "./helpers/manifest";
import { attemptSubmit, prepareCashSale } from "./helpers/pos-ui";
import { snapshotBins } from "./helpers/reconcile";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed, invoicesOnShift } from "./helpers/shifts";
import { verifyManifest } from "./helpers/verify";

type Admin = Parameters<typeof getList>[0];
type Cashiers = Parameters<Parameters<typeof test>[2]>[0]["cashiers"];

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1) || !cashierPassword(2), "cashier 01/02 passwords not set in .env.test");
});

interface Seat {
	actor: Actor;
	shift: string;
}

/** Log in cashiers 1 and 2, clear stray shifts, open one shift each on PERF-P1 (simultaneously). */
async function openSeats(cashiers: Cashiers, admin: Admin, f: Findings): Promise<Seat[]> {
	const actors = [await cashiers.login(1), await cashiers.login(2)];
	for (const a of actors) {
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) for ${a.email}: ${left.join(", ")}`);
	}
	await Promise.all(actors.map((a) => a.openShift(PROFILES.P1, "0")));
	const seats: Seat[] = [];
	for (const a of actors) {
		const [s] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(s), `${a.email} has no open shift after opening`);
		seats.push({ actor: a, shift: s.name });
	}
	return seats;
}

/** Close shifts through the API (a screen left on an error dialog cannot use the menu). */
async function closeSeats(admin: Admin, seats: Seat[]) {
	for (const s of seats) {
		await closeLeftoverShifts(admin, s.actor).catch(() => []);
		s.actor.forgetShift();
	}
}

function finish(id: string, arrangement: string, f: Findings, completed: boolean, data: Record<string, unknown> = {}) {
	if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
	const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
	recordEvidence({
		id,
		arrangement,
		outcome,
		notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
		data,
	});
}

function assertClean(f: Findings) {
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("CON-08 — limits hold under concurrency", () => {
	test("CON-08a — the last unit is sold once; the second cashier is refused", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const manifest = new Manifest();
		const f = new Findings();
		let completed = false;
		let seats: Seat[] = [];
		const keys = [{ item: ITEMS.lastUnit, warehouse: WAREHOUSES.A }];

		try {
			const stock = await ensureStock(admin, { company: COMPANY, item: ITEMS.lastUnit, warehouse: WAREHOUSES.A, qty: 1, rate: 300 });
			f.note(`fixture: ${ITEMS.lastUnit} in ${WAREHOUSES.A} was ${stock.before}, restocked ${stock.added}`);
			f.check((await binQty(admin, ITEMS.lastUnit, WAREHOUSES.A)) === 1, "the scenario needs exactly 1 unit on hand");

			seats = await openSeats(cashiers, admin, f);
			const sales = seats.map((s) =>
				manifest.add({
					txnId: newTxnId("con08a"),
					cashier: s.actor.email,
					company: COMPANY,
					posProfile: PROFILES.P1,
					warehouse: WAREHOUSES.A,
					items: [{ item_code: ITEMS.lastUnit, qty: 1, rate: 500 }],
					payments: [{ mode_of_payment: "Cash", amount: 500 }],
					expectedGrandTotal: 500,
					openingShift: s.shift,
				}),
			);
			const before = await snapshotBins(admin, keys);

			await Promise.all(seats.map((s) => prepareCashSale(s.actor.page, ITEMS.lastUnit)));
			const barrier = new Barrier(seats.length);
			const outcomes = await Promise.all(
				seats.map(async (s) => {
					await barrier.wait();
					return attemptSubmit(s.actor.page);
				}),
			);

			const winners = outcomes.filter((o) => o.ok);
			f.note(`screen results: ${outcomes.map((o, i) => `cashier${i + 1}=${o.ok ? `sold ${o.invoice}` : `refused "${o.message.slice(0, 120)}"`} (HTTP ${JSON.stringify(o.statuses)})`).join("; ")}`);
			f.expectSafe(winners.length <= 1, `${winners.length} sales succeeded for ONE unit of stock (oversold)`);
			f.check(winners.length === 1, `expected exactly one sale to succeed, ${winners.length} did`);
			f.expectSafe(outcomes.every((o) => o.statuses.every((s) => s < 500)), `uncontrolled server error (5xx): ${JSON.stringify(outcomes.map((o) => o.statuses))}`);
			for (const [i, o] of outcomes.entries()) {
				if (!o.ok) f.note(`cashier${i + 1} was told: ${o.message || "nothing visible"}`);
			}

			outcomes.forEach((o, i) => manifest.update(sales[i].txnId, o.ok ? { state: "accepted", invoice: o.invoice } : { state: "rejected" }));

			const submitted = (await Promise.all(seats.map((s) => invoicesOnShift(admin, s.shift)))).flat();
			f.expectSafe(
				submitted.filter((i) => i.docstatus === 1).length <= 1,
				`${submitted.filter((i) => i.docstatus === 1).length} submitted invoices contain the last unit`,
			);
			const onHand = await binQty(admin, ITEMS.lastUnit, WAREHOUSES.A);
			f.note(`on hand after the race: ${onHand}`);
			f.expectSafe(onHand >= 0, `stock went below zero (${onHand})`);

			await verifyManifest(admin, manifest, before, keys, f);

			const drafts = submitted.filter((i) => i.docstatus === 0).map((i) => i.name);
			f.note(`the refused sale left draft invoice(s): ${drafts.join(", ") || "none"}`);

			// Side effect of the refusal: can each cashier still close their shift with that
			// draft left behind? (Closing deletes the shift's unprinted drafts, which needs
			// delete rights on Sales Invoice.)
			const attempts = await Promise.all(seats.map((s) => closeLeftoverShiftsDetailed(admin, s.actor)));
			const stuck = attempts.flatMap((a) => a.stuck);
			f.note(`closing both shifts with the draft still present: closed=${JSON.stringify(attempts.flatMap((a) => a.closed))}; refused=${JSON.stringify(stuck)}`);
			f.expectSafe(
				stuck.length === 0,
				`a refused sale leaves a draft that stops the cashier closing their shift (${stuck.map((x) => `${x.shift}: HTTP ${x.status} at ${x.step}`).join("; ")})`,
			);
			if (drafts.length) {
				const removed = await deleteDrafts(admin, drafts);
				f.note(`test cleanup removed the draft(s): ${removed.join(", ") || "none"}`);
			}
			completed = true;
		} finally {
			manifest.save();
			await closeSeats(admin, seats);
			finish("CON-08a", "two cashiers sell the last unit at the same moment", f, completed);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("CON-08b — the same original quantity cannot be returned twice", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const f = new Findings();
		let completed = false;
		let seats: Seat[] = [];
		const drafts: string[] = [];
		const keys = [{ item: ITEMS.stock, warehouse: WAREHOUSES.A }];

		try {
			seats = await openSeats(cashiers, admin, f);
			const [a, b] = seats;
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const base = { company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer as string };

			// The original sale: 2 units, by cashier01.
			const original = await createDraft(a.actor, buildInvoice({ ...base, shift: a.shift, items: [{ item_code: ITEMS.stock, qty: 2, rate: 1000 }] }));
			if (original.doc?.name) drafts.push(original.doc.name);
			f.check(Boolean(original.doc), `could not create the original sale: HTTP ${original.res.status} ${errorText(original.res)}`);
			const sold = await submitDraft(a.actor, original.doc!, { cashAmount: 2000 });
			f.check(sold.status === 200, `could not submit the original sale: HTTP ${sold.status} ${errorText(sold)}`);
			const originalName = (sold.json?.message?.name ?? original.doc?.name) as string;
			f.note(`original sale ${originalName}: 2 x ${ITEMS.stock}`);

			const before = await snapshotBins(admin, keys);

			// Two cashiers prepare a return of ALL 2 units against that invoice.
			const returnFor = (s: Seat) =>
				createDraft(s.actor, buildInvoice({ ...base, shift: s.shift, returnAgainst: originalName, items: [{ item_code: ITEMS.stock, qty: -2, rate: 1000 }] }));
			const [ra, rb] = [await returnFor(a), await returnFor(b)];
			for (const r of [ra, rb]) if (r.doc?.name) drafts.push(r.doc.name);
			f.check(Boolean(ra.doc && rb.doc), `could not create both return drafts: HTTP ${ra.res.status}/${rb.res.status} ${errorText(ra.res)} ${errorText(rb.res)}`);

			const barrier = new Barrier(2);
			const calls = await Promise.all(
				[
					{ seat: a, draft: ra.doc! },
					{ seat: b, draft: rb.doc! },
				].map(async ({ seat, draft }) => {
					await barrier.wait();
					const start = performance.now();
					const res = await submitDraft(seat.actor, draft);
					return { res, span: { start, end: performance.now() } };
				}),
			);
			const statuses = calls.map((c) => c.res.status);
			const overlap = commonOverlapMs(calls.map((c) => c.span));
			f.note(`two simultaneous returns of the same 2 units: HTTP ${JSON.stringify(statuses)}; overlap ${overlap.toFixed(0)} ms`);
			for (const c of calls.filter((x) => x.res.status !== 200)) f.note(`refused: HTTP ${c.res.status} ${errorText(c.res)}`);
			f.check(overlap > 0, `the two returns did not overlap (${overlap.toFixed(0)} ms)`);
			f.expectSafe(statuses.every((s) => s < 500), `uncontrolled server error (5xx) on a return: HTTP ${JSON.stringify(statuses)}`);

			const accepted = statuses.filter((s) => s === 200).length;
			f.expectSafe(accepted <= 1, `${accepted} returns of the same original quantity were accepted (over-return)`);
			f.check(accepted >= 1, "neither return was accepted, so the scenario did not exercise the limit");

			const returns = await getList<{ name: string; docstatus: number }>(admin, "Sales Invoice", { return_against: originalName, docstatus: 1 }, ["name", "docstatus"]);
			f.note(`submitted returns against ${originalName}: ${JSON.stringify(returns)}`);
			f.expectSafe(returns.length <= 1, `${returns.length} submitted returns exist against one invoice of 2 units`);

			const delta = (await binQty(admin, ITEMS.stock, WAREHOUSES.A)) - (before.get(`${ITEMS.stock}|${WAREHOUSES.A}`) ?? 0);
			f.note(`stock change from the returns: +${delta} (at most +2 is correct)`);
			f.expectSafe(delta <= 2, `stock rose by ${delta} for a 2-unit sale (returned more than was sold)`);

			const removed = await deleteDrafts(admin, drafts);
			if (removed.length) f.note(`removed leftover draft(s): ${removed.join(", ")}`);
			completed = true;
		} finally {
			await closeSeats(admin, seats);
			finish("CON-08b", "two cashiers return the same original quantity at the same moment", f, completed);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("CON-08b0 — control: a second return made AFTER a full return is refused", async ({ cashiers, playwright }) => {
		// Baseline for 08b. If this is accepted, over-returning is a plain bug and not a race;
		// if it is refused, the simultaneous case in 08b is specifically a concurrency defect.
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const f = new Findings();
		let completed = false;
		let seats: Seat[] = [];
		const drafts: string[] = [];

		try {
			seats = await openSeats(cashiers, admin, f);
			const [a, b] = seats;
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const base = { company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer as string };

			const original = await createDraft(a.actor, buildInvoice({ ...base, shift: a.shift, items: [{ item_code: ITEMS.stock, qty: 2, rate: 1000 }] }));
			if (original.doc?.name) drafts.push(original.doc.name);
			f.check(Boolean(original.doc), `could not create the original sale: HTTP ${original.res.status} ${errorText(original.res)}`);
			const sold = await submitDraft(a.actor, original.doc!, { cashAmount: 2000 });
			f.check(sold.status === 200, `could not submit the original sale: HTTP ${sold.status} ${errorText(sold)}`);
			const originalName = (sold.json?.message?.name ?? original.doc?.name) as string;
			f.note(`original sale ${originalName}: 2 x ${ITEMS.stock}`);

			const returnFor = (s: Seat) =>
				createDraft(s.actor, buildInvoice({ ...base, shift: s.shift, returnAgainst: originalName, items: [{ item_code: ITEMS.stock, qty: -2, rate: 1000 }] }));
			const first = await returnFor(a);
			if (first.doc?.name) drafts.push(first.doc.name);
			const second = await returnFor(b); // drafted while nothing has been returned yet, like 08b
			if (second.doc?.name) drafts.push(second.doc.name);
			f.check(Boolean(first.doc && second.doc), "could not create both return drafts");

			const r1 = await submitDraft(a.actor, first.doc!);
			f.note(`first return (all 2 units): HTTP ${r1.status}`);
			f.check(r1.status === 200, `the first, valid return was not accepted: HTTP ${r1.status} ${errorText(r1)}`);
			const r2 = await submitDraft(b.actor, second.doc!); // strictly after the first completed
			f.note(`second return of the same 2 units, one after the other: HTTP ${r2.status}${r2.status === 200 ? "" : ` ${errorText(r2)}`}`);
			f.expectSafe(r2.status !== 200, "a second full return was accepted even when made AFTER the first (over-return without any concurrency)");
			f.expectSafe(r2.status < 500, `uncontrolled server error (5xx) on the second return: HTTP ${r2.status}`);

			// Probe (not a verdict): is a BRAND-NEW return draft refused once the original is fully returned?
			// If so the quantity check exists but is only applied when the draft is created, so a draft made
			// earlier can still be submitted later.
			const fresh = await returnFor(a);
			if (fresh.doc?.name) drafts.push(fresh.doc.name);
			f.note(`creating a NEW return draft after the original was already returned: HTTP ${fresh.res.status}${fresh.doc ? ` (draft ${fresh.doc.name} created)` : ` ${errorText(fresh.res)}`}`);

			const removed = await deleteDrafts(admin, drafts);
			if (removed.length) f.note(`removed leftover draft(s): ${removed.join(", ")}`);
			completed = true;
		} finally {
			await closeSeats(admin, seats);
			finish("CON-08b0", "control: sequential second return of the same quantity", f, completed);
			await admin.dispose();
		}
		assertClean(f);
	});

	test("CON-08c — a one-use coupon is redeemed once", async ({ cashiers, playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const f = new Findings();
		let completed = false;
		let seats: Seat[] = [];
		const drafts: string[] = [];

		try {
			const code = `PERF-${RUN_ID}`.slice(0, 40);
			const couponName = await createCoupon(admin, { code, offer: COUPON_OFFER, company: COMPANY, maximumUse: 1 });
			f.note(`fixture: coupon ${couponName} (code ${code}) with maximum use 1`);

			seats = await openSeats(cashiers, admin, f);
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const customer = profile?.customer as string;
			const draftFor = async (s: Seat) => {
				const d = await createDraft(
					s.actor,
					buildInvoice({
						company: COMPANY,
						posProfile: PROFILES.P1,
						customer,
						shift: s.shift,
						items: [{ item_code: ITEMS.stock, qty: 1, rate: 1000 }],
						coupons: [{ coupon: couponName, coupon_code: code, pos_offer: COUPON_OFFER, customer }],
					}),
				);
				if (d.doc?.name) drafts.push(d.doc.name);
				return d;
			};
			const [da, db] = [await draftFor(seats[0]), await draftFor(seats[1])];
			f.check(Boolean(da.doc && db.doc), `could not create both drafts: HTTP ${da.res.status}/${db.res.status} ${errorText(da.res)} ${errorText(db.res)}`);

			const barrier = new Barrier(2);
			const calls = await Promise.all(
				[
					{ seat: seats[0], draft: da.doc! },
					{ seat: seats[1], draft: db.doc! },
				].map(async ({ seat, draft }) => {
					await barrier.wait();
					const start = performance.now();
					const res = await submitDraft(seat.actor, draft, { cashAmount: 1000 });
					return { res, span: { start, end: performance.now() } };
				}),
			);
			const statuses = calls.map((c) => c.res.status);
			const overlap = commonOverlapMs(calls.map((c) => c.span));
			f.note(`two simultaneous redemptions of a one-use coupon: HTTP ${JSON.stringify(statuses)}; overlap ${overlap.toFixed(0)} ms`);
			for (const c of calls.filter((x) => x.res.status !== 200)) f.note(`refused: HTTP ${c.res.status} ${errorText(c.res)}`);
			f.check(overlap > 0, `the two submissions did not overlap (${overlap.toFixed(0)} ms)`);
			f.expectSafe(statuses.every((s) => s < 500), `uncontrolled server error (5xx) redeeming a coupon: HTTP ${JSON.stringify(statuses)}`);

			const accepted = statuses.filter((s) => s === 200).length;
			f.expectSafe(accepted <= 1, `a one-use coupon was redeemed on ${accepted} accepted sales`);
			f.check(accepted >= 1, "neither sale was accepted, so the coupon was never redeemed");

			const coupon = await getDoc<Record<string, any>>(admin, "POS Coupon", couponName);
			f.note(`coupon after the race: used=${coupon?.used}, maximum_use=${coupon?.maximum_use}`);
			f.expectSafe(Number(coupon?.used) <= Number(coupon?.maximum_use), `coupon used ${coupon?.used} times, limit ${coupon?.maximum_use}`);
			f.expectSafe(
				Number(coupon?.used) === accepted,
				`${accepted} sales were accepted with the coupon but it records used=${coupon?.used} (redemptions not counted correctly)`,
			);

			const removed = await deleteDrafts(admin, drafts);
			if (removed.length) f.note(`removed leftover draft(s): ${removed.join(", ")}`);
			completed = true;
		} finally {
			await closeSeats(admin, seats);
			finish("CON-08c", "two cashiers redeem the same one-use coupon at the same moment", f, completed);
			await admin.dispose();
		}
		assertClean(f);
	});
});
