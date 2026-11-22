/**
 * CON-04 (P0): two distinct users try to use ONE opening shift on the same
 * profile.
 *
 * Part 1 (UI)  What does a second cashier's screen offer while someone else's
 *              shift is open on the same profile?
 * Part 2 (API) Controlled attempts as the SECOND user's real session (never the
 *              admin key, which would bypass the checks being tested):
 *                a. read the first user's open shift,
 *                b. attach an invoice to the first user's shift,
 *                c. what the first user's closing then contains,
 *                d. close the first user's shift.
 *
 * Classification follows the ticket: a prohibited flow that is rejected with no
 * side effects is "unsupported safely" and is NOT counted as "supported". If
 * the server lets a request through that the UI never offers, that is an
 * authorization gap and is recorded as a DEFECT; sharing is never labelled
 * supported on that basis.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, LOWPRIV, PROFILES, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence } from "./helpers/evidence";
import { callAs, errorText } from "./helpers/as-user";
import { gotoPos } from "./helpers/pos-ui";

const SALE_RATE = 1000;
const PROBE_TAG = `con04-${Date.now().toString(36)}`;

/**
 * The same attempts are made by two kinds of second user. The least-privilege
 * one is the real authorization test: a Sales Manager can do things by role
 * that an ordinary cashier cannot, which would hide a missing ownership check.
 */
const ATTACKERS = [
	{ id: "CON-04", number: 2, label: "Sales Manager cashier" },
	{ id: "CON-04b", number: LOWPRIV, label: "least-privilege cashier" },
] as const;

test.describe("CON-04 — distinct users, one shared shift", () => {
	test.beforeEach(() => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		test.skip(!cashierPassword(1), "cashier 01 password not set in .env.test");
	});

	for (const attacker of ATTACKERS)
		test(`${attacker.id} — a ${attacker.label} cannot read, bill into, or close another user's shift`, async ({
			cashiers,
			playwright,
		}) => {
		test.skip(!cashierPassword(attacker.number), `password for ${attacker.label} not set in .env.test`);
		test.setTimeout(300_000);
		const probe = `${PROBE_TAG}-${attacker.id}`;
		const admin = await newAdminContext(playwright);
		const f = new Findings();
		let shiftClosedByOther = false;

		try {
			const [owner, other] = await Promise.all([cashiers.login(1), cashiers.login(attacker.number)]);
			await owner.openShift(PROFILES.P1, "5000");
			const [ownerShift] = await listOpeningShifts(admin, { user: owner.email, status: "Open" });
			expect(ownerShift?.pos_profile).toBe(PROFILES.P1);
			const shiftName = ownerShift.name;
			const ownerShiftDoc = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shiftName);

			// ---- Part 1: what the second user's screen offers ------------------------------
			const screen = await gotoPos(other.page);
			f.note(`second user's POS screen on load: ${screen === "dialog" ? "Create Opening Shift dialog (own shift)" : "an already-open shift"}`);
			f.check(screen === "dialog", `second user was shown state "${screen}" instead of the Create Opening Shift dialog`);
			f.expectSafe(
				screen === "dialog",
				"the UI placed the second user into an existing shift instead of asking them to open their own",
			);

			// ---- Part 2a: read another user's shift -----------------------------------------
			const read = await callAs(other, "pospire.pospire.api.posapp.check_opening_shift", { user: owner.email });
			const leaked = read.status === 200 && read.json?.message?.pos_opening_shift?.name === shiftName;
			f.note(`2a check_opening_shift(user=<owner>) as second user -> HTTP ${read.status}, returned owner's shift: ${leaked}`);
			f.expectSafe(
				!leaked,
				"check_opening_shift returns another user's open shift (and full POS Profile) to any logged-in user",
			);

			// ---- Part 2b: attach an invoice to the owner's shift ------------------------------
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const payload = {
				doctype: "Sales Invoice",
				is_pos: 1,
				ignore_pricing_rule: 1,
				company: COMPANY,
				pos_profile: PROFILES.P1,
				customer: profile?.customer,
				currency: "INR",
				posting_date: new Date().toISOString().slice(0, 10),
				posa_pos_opening_shift: shiftName,
				posa_notes: probe,
				items: [{ item_code: ITEMS.stock, qty: 1, rate: SALE_RATE, uom: "Nos", conversion_factor: 1 }],
				payments: [{ mode_of_payment: "Cash", amount: SALE_RATE }],
			};
			const draft = await callAs(other, "pospire.pospire.api.posapp.update_invoice", { data: JSON.stringify(payload) });
			const draftDoc = draft.status === 200 ? draft.json?.message : null;
			f.note(`2b update_invoice naming the owner's shift as second user -> HTTP ${draft.status}${draftDoc ? ` (draft ${draftDoc.name})` : ` ${errorText(draft)}`}`);

			let submittedInvoice: string | null = null;
			if (draftDoc?.name) {
				const submit = await callAs(other, "pospire.pospire.api.posapp.submit_invoice", {
					invoice: draftDoc,
					data: JSON.stringify(draftDoc),
					offline_id: `${probe}-inv`,
				});
				f.note(`2b submit_invoice -> HTTP ${submit.status}${submit.status === 200 ? "" : ` ${errorText(submit)}`}`);
				if (submit.status === 200) submittedInvoice = submit.json?.message?.name ?? draftDoc.name;
			}

			const onShift = await getList<{ name: string; owner: string; docstatus: number }>(
				admin,
				"Sales Invoice",
				{ posa_pos_opening_shift: shiftName, posa_notes: probe },
				["name", "owner", "docstatus"],
			);
			f.note(`2b invoices now on the owner's shift carrying this probe: ${JSON.stringify(onShift)}`);
			f.expectSafe(
				onShift.length === 0,
				`an invoice by ${other.email} was accepted onto ${owner.email}'s shift (${onShift.map((i) => `${i.name} docstatus ${i.docstatus}`).join(", ")})`,
			);

			// ---- Part 2d: close the owner's shift as the second user -------------------------
			const made = await callAs(other, "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening", {
				opening_shift: ownerShiftDoc,
			});
			f.note(`2d make_closing_shift_from_opening(owner's shift) as second user -> HTTP ${made.status}`);
			if (made.status === 200 && made.json?.message) {
				const closed = await callAs(other, "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift", {
					closing_shift: made.json.message,
				});
				f.note(`2d submit_closing_shift -> HTTP ${closed.status}${closed.status === 200 ? "" : ` ${errorText(closed)}`}`);
			}
			const after = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shiftName);
			shiftClosedByOther = after?.status !== "Open";
			f.expectSafe(
				!shiftClosedByOther,
				`${other.email} closed ${owner.email}'s shift ${shiftName} (status now ${after?.status})`,
			);

			// ---- Part 2c: what the owner's closing contains ---------------------------------
			if (shiftClosedByOther) {
				owner.forgetShift();
			} else {
				await owner.closeShift();
			}
			const closings = await getList<{ name: string; user: string; owner: string; grand_total: number }>(
				admin,
				"POS Closing Shift",
				{ pos_opening_shift: shiftName, docstatus: 1 },
				["name", "user", "owner", "grand_total"],
			);
			f.check(closings.length === 1, `expected exactly 1 closing for ${shiftName}, found ${closings.length}`);
			if (closings[0]) {
				f.note(`2c closing ${closings[0].name}: user=${closings[0].user}, submitted by=${closings[0].owner}, grand_total=${closings[0].grand_total}`);
				const closingDoc = await getDoc<Record<string, any>>(admin, "POS Closing Shift", closings[0].name);
				const included = (closingDoc?.pos_transactions ?? []).map((t: { sales_invoice: string }) => t.sales_invoice);
				if (submittedInvoice) {
					const inClosing = included.includes(submittedInvoice);
					f.note(`2c second user's invoice ${submittedInvoice} counted in ${owner.email}'s closing: ${inClosing}`);
					f.expectSafe(
						!inClosing,
						`${other.email}'s sale ${submittedInvoice} was counted in ${owner.email}'s closing totals (cash reconciled to the wrong person)`,
					);
				}
				f.expectSafe(
					closings[0].owner === owner.email,
					`closing ${closings[0].name} for ${owner.email}'s shift was submitted by ${closings[0].owner}`,
				);
			}
		} finally {
			const outcome = f.defects.length > 0 ? "defect" : "unsupported_safely";
			recordEvidence({
				id: attacker.id,
				arrangement: `distinct users / shared opening shift (second user = ${attacker.label}, via UI and API)`,
				outcome,
				notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
				data: { defects: f.defects.length, closedByOther: shiftClosedByOther },
			});
			await admin.dispose();
		}

		expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
		expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
	});
});
