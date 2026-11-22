/**
 * CON-04f / CON-04g (P0): can one cashier create an invoice in another cashier's name
 * through the offline replay endpoint?
 *
 * pospire.pospire.api.offline.submit_invoice takes `owner_user` from the request and the
 * server then acts as that user (offline.py, _acting_as_user). OFF-07b showed that this is
 * what lets a shared browser replay a previous cashier's bills. These tests ask what a
 * logged-in cashier gets when they call the endpoint directly, as themselves, and name
 * someone else as the owner.
 *
 *   CON-04f0  control: cashier 7 posts a bill naming HIMSELF as owner on his own shift
 *   CON-04f   cashier 7 posts a bill naming cashier 6 as owner, on cashier 7's shift
 *   CON-04g   cashier 7 posts a bill naming cashier 6 as owner, on cashier 6's open shift
 *
 * Both 7 and 6 are plain cashier roles (no Accounts/Sales Manager rights). Expected for a
 * safe server: a request that names another user as the owner is refused unless the caller
 * may act for that user. Defect if an invoice owned by cashier 6 is created from cashier 7's
 * session. The control makes sure a refusal is not just a bad payload.
 */

import { randomUUID } from "node:crypto";
import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, FIRST_BURST_CASHIER, ITEMS, PROFILES, cashierEmail, cashierPassword } from "./fixtures/topology";
import { type ApiSeat, loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { callAs, errorText } from "./helpers/as-user";
import { getDoc, getList, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice } from "./helpers/invoice-api";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";

const VICTIM = FIRST_BURST_CASHIER; // 6
const ATTACKER = FIRST_BURST_CASHIER + 1; // 7
const RATE = 1000;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(VICTIM), "POSPIRE_E2E_PERF_PASSWORD_BURST not set in .env.test");
});

async function run(
	id: string,
	arrangement: string,
	opts: { owner: number; onShiftOf: number; expectAccepted: boolean },
	playwright: Parameters<typeof newAdminContext>[0],
) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	const seats: ApiSeat[] = [];
	let completed = false;
	try {
		const [victim, attacker] = [await loginApiSeat(playwright, VICTIM), await loginApiSeat(playwright, ATTACKER)];
		seats.push(victim, attacker);
		const shifts = new Map<number, string>();
		for (const s of seats) {
			const stuck = (await closeLeftoverShiftsDetailed(admin, s.actor, { visitPos: false })).stuck;
			f.check(stuck.length === 0, `${s.email}: could not clear a leftover shift: ${JSON.stringify(stuck)}`);
			const r = (await openShiftApi(s, COMPANY, PROFILES.P1)).result;
			const name = r.json?.message?.pos_opening_shift?.name as string | undefined;
			f.check(Boolean(name), `${s.email}: could not open a shift (HTTP ${r.status})`);
			if (name) shifts.set(s.number, name);
		}
		if (shifts.size !== 2) throw new Error("both cashiers need a shift");
		const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
		const shift = shifts.get(opts.onShiftOf)!;
		const invoice = {
			...buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }),
			payments: [{ mode_of_payment: "Cash", amount: RATE }],
			owner_user: cashierEmail(opts.owner),
		};
		const offlineId = randomUUID();
		const res = await callAs(attacker.actor, "pospire.pospire.api.offline.submit_invoice", {
			data: JSON.stringify(invoice),
			offline_id: offlineId,
			device_id: randomUUID(),
		});
		data.status = res.status;
		// Who is the attacker's own session after that call?
		const who = await attacker.request.get("/api/method/frappe.auth.get_logged_user");
		const whoBody = await who.json().catch(() => ({}));
		data.sessionAfter = { status: who.status(), user: whoBody?.message };
		f.note(`cashier ${ATTACKER}'s own session after the call: HTTP ${who.status()}, user ${whoBody?.message ?? "(none)"}`);
		const name = res.json?.message?.name as string | undefined;
		f.note(`cashier ${ATTACKER} posted a bill naming ${cashierEmail(opts.owner)} as owner, on ${shift} (${cashierEmail(opts.onShiftOf)}'s shift): HTTP ${res.status} ${res.status === 200 ? name : errorText(res)}`);

		const made = await getList<{ name: string; owner: string; docstatus: number; posa_pos_opening_shift: string }>(admin, "Sales Invoice", { pos_offline_id: offlineId }, ["name", "owner", "docstatus", "posa_pos_opening_shift"], 5);
		data.created = made;
		f.note(`invoices created from that request: ${JSON.stringify(made)}`);
		if (opts.expectAccepted) {
			f.check(res.status === 200 && made.length === 1, `the control bill was not accepted (HTTP ${res.status} ${errorText(res)}): the payload is wrong, so the other results mean nothing`);
			f.expectSafe(made[0]?.owner === cashierEmail(opts.owner), `the control invoice is owned by ${made[0]?.owner}`);
		} else {
			f.expectSafe(res.status < 500, `uncontrolled server error (HTTP ${res.status})`);
			f.expectSafe(
				made.length === 0,
				`${made.length} invoice(s) were created from cashier ${ATTACKER}'s session in the name of ${cashierEmail(opts.owner)}: ${JSON.stringify(made.map((m) => ({ name: m.name, owner: m.owner, shift: m.posa_pos_opening_shift, docstatus: m.docstatus })))}`,
			);
		}
		completed = true;
	} finally {
		for (const s of seats) {
			await s.dispose().catch(() => {});
			// a fresh login: the old session may have been damaged by the call under test
			const fresh = await loginApiSeat(playwright, s.number).catch(() => null);
			if (fresh) {
				await closeLeftoverShiftsDetailed(admin, fresh.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close ${s.email}'s shift: ${JSON.stringify(c.stuck)}`)).catch(() => {});
				await fresh.dispose().catch(() => {});
			}
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : opts.expectAccepted ? "supported" : "unsupported_safely";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("CON-04f/g — naming another user as the owner of an offline bill", () => {
	test("CON-04f0 — control: own name, own shift", async ({ playwright }) => {
		test.setTimeout(300_000);
		await run("CON-04f0", "control: cashier 7 posts an offline bill naming himself as owner on his own shift", { owner: ATTACKER, onShiftOf: ATTACKER, expectAccepted: true }, playwright);
	});

	test("CON-04f — another user's name, own shift", async ({ playwright }) => {
		test.setTimeout(300_000);
		await run("CON-04f", "cashier 7 posts an offline bill naming cashier 6 as owner, on cashier 7's own shift", { owner: VICTIM, onShiftOf: ATTACKER, expectAccepted: false }, playwright);
	});

	test("CON-04g — another user's name, on that user's shift", async ({ playwright }) => {
		test.setTimeout(300_000);
		await run("CON-04g", "cashier 7 posts an offline bill naming cashier 6 as owner, on cashier 6's open shift", { owner: VICTIM, onShiftOf: VICTIM, expectAccepted: false }, playwright);
	});
});
