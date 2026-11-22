/**
 * CON-08d (P0): customer store credit must not be spent twice.
 *
 * A customer returns one unit and takes STORE CREDIT (not cash back): that makes a
 * credit note worth 1000. Two cashiers (6 and 7), each on their own shift on PERF-P1,
 * then sell one unit (1000) to that customer and pay it ENTIRELY with that credit,
 * at the same moment. Only one sale can be covered.
 *
 *   CON-08d0  control: the two redemptions happen one after the other
 *   CON-08d   the two redemptions are released together at a barrier
 *
 * Defect if: both sales are accepted; an accepted sale is left with an unpaid balance
 * (a free sale); more than 1000 is allocated against the credit note; or the credit
 * note ends with a positive outstanding (over-spent credit). A refusal of the second
 * sale is the correct outcome and must not be a 5xx.
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, FIRST_BURST_CASHIER, cashierPassword } from "./fixtures/topology";
import { type ApiSeat, loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { callAs, errorText } from "./helpers/as-user";
import { ensureStock, deleteDrafts } from "./helpers/admin-fixtures";
import { getDoc, getList, newAdminContext } from "./helpers/backend";
import { Barrier, commonOverlapMs } from "./helpers/barrier";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft, submitDraft } from "./helpers/invoice-api";
import { RUN_ID } from "./helpers/manifest";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";

const RATE = 1000;
const OWNER = FIRST_BURST_CASHIER + 2; // issues the credit
const BUYERS = [FIRST_BURST_CASHIER, FIRST_BURST_CASHIER + 1]; // redeem it

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(FIRST_BURST_CASHIER), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

async function run(id: string, arrangement: string, together: boolean, { playwright }: { playwright: Parameters<typeof newAdminContext>[0] }) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	const seats: ApiSeat[] = [];
	const drafts: string[] = [];
	let completed = false;

	try {
		await ensureStock(admin, { company: COMPANY, item: ITEMS.stock, warehouse: WAREHOUSES.A, qty: 1000, rate: 600 });
		const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
		const base = await getDoc<Record<string, any>>(admin, "Customer", String(profile?.customer));

		for (const n of [OWNER, ...BUYERS]) seats.push(await loginApiSeat(playwright, n));
		const [owner, b1, b2] = seats;
		const shifts = new Map<string, string>();
		for (const s of seats) {
			const stray = await getList<{ name: string }>(admin, "Sales Invoice", { owner: s.email, docstatus: 0 }, ["name"], 200);
			await deleteDrafts(admin, stray.map((d) => d.name));
			const stuck = (await closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false })).stuck;
			f.check(stuck.length === 0, `${s.email}: could not clear a leftover shift: ${JSON.stringify(stuck)}`);
			const r = (await openShiftApi(s, COMPANY, PROFILES.P1)).result;
			const name = r.json?.message?.pos_opening_shift?.name as string | undefined;
			f.check(Boolean(name), `${s.email}: could not open a shift (HTTP ${r.status})`);
			if (name) shifts.set(s.email, name);
		}
		if (shifts.size !== seats.length) throw new Error("not every cashier has a shift");

		// ---- fixture: a customer with exactly 1000 of store credit ----
		const customerName = `PERF CREDIT ${RUN_ID} ${id}`;
		const made = await admin.post("/api/method/frappe.client.insert", {
			data: { doc: { doctype: "Customer", customer_name: customerName, customer_type: "Individual", customer_group: base?.customer_group, territory: base?.territory } },
		});
		f.check(made.ok(), `could not create the customer: HTTP ${made.status()}`);
		const customer = (await made.json())?.message?.name as string;
		data.customer = customer;
		const shiftOf = (s: ApiSeat) => shifts.get(s.email)!;

		const sale = await createDraft(owner.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer, shift: shiftOf(owner), items: [{ item_code: ITEMS.stock, qty: 2, rate: RATE }] }));
		f.check(Boolean(sale.doc), `could not draft the original sale: HTTP ${sale.res.status} ${errorText(sale.res)}`);
		if (!sale.doc) throw new Error("no original sale");
		const paid = await submitDraft(owner.actor, sale.doc, { cashAmount: 2 * RATE });
		f.check(paid.status === 200, `the original sale was refused: HTTP ${paid.status} ${errorText(paid)}`);
		const original = paid.json?.message?.name ?? sale.doc.name;

		const ret = await createDraft(owner.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer, shift: shiftOf(owner), items: [{ item_code: ITEMS.stock, qty: -1, rate: RATE }], returnAgainst: original }));
		f.check(Boolean(ret.doc), `could not draft the return: HTTP ${ret.res.status} ${errorText(ret.res)}`);
		if (!ret.doc) throw new Error("no return draft");
		const storeCredit = await callAs(owner.actor, "pospire.pospire.api.posapp.submit_invoice", {
			invoice: ret.doc,
			data: JSON.stringify({ total_change: 0, paid_change: 0, credit_change: 0, redeemed_customer_credit: 0, customer_credit_dict: [], is_cashback: false }),
			offline_id: randomUUID(),
		});
		f.check(storeCredit.status === 200, `the store-credit return was refused: HTTP ${storeCredit.status} ${errorText(storeCredit)}`);

		const avail = await admin.post("/api/method/pospire.pospire.api.posapp.get_available_credit", { data: { customer, company: COMPANY } });
		const credits = ((await avail.json())?.message ?? []) as { type: string; credit_origin: string; total_credit: number }[];
		data.creditAvailable = credits;
		f.note(`credit available to ${customer} before the redemptions: ${JSON.stringify(credits)}`);
		const note = credits.find((c) => c.type === "Invoice");
		f.check(Boolean(note) && Number(note?.total_credit) === RATE, `expected one credit note of ${RATE}, found ${JSON.stringify(credits)}`);
		if (!note) throw new Error("no credit note to redeem");

		// ---- two sales, each paid entirely with that credit ----
		const redeem = async (s: ApiSeat, draft: Record<string, any>) => {
			const start = performance.now();
			const res = await callAs(s.actor, "pospire.pospire.api.posapp.submit_invoice", {
				invoice: { ...draft, payments: [{ mode_of_payment: "Cash", amount: 0 }] },
				data: JSON.stringify({
					total_change: 0,
					paid_change: 0,
					credit_change: 0,
					is_cashback: true,
					redeemed_customer_credit: RATE,
					customer_credit_dict: [{ type: "Invoice", credit_origin: note.credit_origin, total_credit: RATE, credit_to_redeem: RATE }],
				}),
				offline_id: randomUUID(),
			});
			return { res, span: { start, end: performance.now() } };
		};
		const draftFor = async (s: ApiSeat) => {
			const d = await createDraft(s.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer, shift: shiftOf(s), items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }));
			if (d.doc?.name) drafts.push(d.doc.name);
			f.check(Boolean(d.doc), `${s.email}: could not draft the sale: HTTP ${d.res.status} ${errorText(d.res)}`);
			return d.doc!;
		};
		const [d1, d2] = [await draftFor(b1), await draftFor(b2)];
		if (!d1 || !d2) throw new Error("drafts missing");

		let calls;
		if (together) {
			const gate = new Barrier(2);
			calls = await Promise.all(
				[
					{ s: b1, d: d1 },
					{ s: b2, d: d2 },
				].map(async ({ s, d }) => {
					await gate.wait();
					return redeem(s, d);
				}),
			);
			const overlap = commonOverlapMs(calls.map((c) => c.span));
			data.overlapMs = Math.round(overlap);
			f.check(overlap > 0, `the two redemptions did not overlap (${overlap.toFixed(0)} ms)`);
		} else {
			calls = [await redeem(b1, d1), await redeem(b2, d2)];
		}
		const statuses = calls.map((c) => c.res.status);
		data.statuses = statuses;
		f.note(`two redemptions of one ${RATE} credit (${together ? "simultaneous" : "sequential"}): HTTP ${JSON.stringify(statuses)}`);
		for (const c of calls.filter((x) => x.res.status !== 200)) f.note(`refused: HTTP ${c.res.status} ${errorText(c.res)}`);
		f.expectSafe(statuses.every((s) => s < 500), `uncontrolled server error (5xx) redeeming credit: HTTP ${JSON.stringify(statuses)}`);

		const accepted = calls.filter((c) => c.res.status === 200);
		f.check(accepted.length >= 1, "neither redemption was accepted: the credit was never used");
		f.expectSafe(accepted.length <= 1, `${accepted.length} sales were accepted against ONE credit note of ${RATE}`);

		let allocated = 0;
		for (const c of accepted) {
			const name = c.res.json?.message?.name as string;
			const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", name);
			const out = Number(d?.outstanding_amount ?? 0);
			allocated += Number(d?.grand_total ?? 0) - out;
			f.note(`accepted ${name}: docstatus ${d?.docstatus}, grand_total ${d?.grand_total}, outstanding ${out}`);
			f.expectSafe(Math.abs(out) < 0.01, `${name} was accepted with an unpaid balance of ${out}: the credit did not actually cover it`);
		}
		f.expectSafe(allocated <= RATE + 0.01, `${allocated} of credit was applied to sales but the note only held ${RATE}`);
		const after = await getDoc<Record<string, any>>(admin, "Sales Invoice", note.credit_origin);
		data.noteAfter = { outstanding: after?.outstanding_amount };
		f.note(`credit note ${note.credit_origin} outstanding after: ${after?.outstanding_amount} (0 = fully spent; positive = over-spent)`);
		f.expectSafe(Number(after?.outstanding_amount) <= 0.01, `the credit note ended with outstanding ${after?.outstanding_amount}: more credit was spent than it held`);
		completed = true;
	} finally {
		await deleteDrafts(admin, drafts).catch(() => []);
		for (const s of seats) {
			await closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close ${s.email}'s shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			await s.dispose().catch(() => {});
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("CON-08d — store credit is spent once", () => {
	test("CON-08d0 — control: two redemptions one after the other", async ({ playwright }) => {
		test.setTimeout(300_000);
		await run("CON-08d0", "control: a 1000 store credit is redeemed by two sales one after the other", false, { playwright });
	});

	test("CON-08d — two cashiers redeem the same credit at the same moment", async ({ playwright }) => {
		test.setTimeout(300_000);
		await run("CON-08d", "two cashiers each pay a 1000 sale entirely with the same 1000 store credit, released together", true, { playwright });
	});
});
