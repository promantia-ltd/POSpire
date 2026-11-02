/**
 * CON-04c (P0): can another user cause a cashier's printed draft to be submitted?
 *
 * make_closing_shift_from_opening first submits every draft of the shift that is
 * marked as printed, and it does not look at who is calling. A printed draft is a
 * real state: submit_invoice saves the invoice as printed and, on profiles that
 * submit in a background job, it waits there until the job runs.
 *
 * Arrangement: cashier 1 has an open shift and a draft on it that is marked printed
 * and carries its payment (an admin fixture puts it into that state, exactly as the
 * server would leave it; the fixture is not the thing under test). Then ANOTHER user,
 * on their own real session (never the admin key), asks for cashier 1's closing.
 * The same attempt is made by a Sales Manager cashier and by the least-privilege
 * cashier; the least-privilege one is the real authorization test.
 *
 * Defect: the other user's request submits cashier 1's invoice (docstatus 1), moving
 * stock and the ledger without cashier 1 doing anything. If the request is refused and
 * the draft is untouched, the flow is unsupported safely.
 *
 * Reading a refusal correctly needs a control, so there is a third test:
 *   CON-04e  the OWNER asks for their own closing while holding the same printed draft.
 * If that is refused too, the other users' refusal is only a missing role permission
 * (submit on Sales Invoice), not an ownership check, and a printed draft blocks the
 * cashier's own closing.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, LOWPRIV, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { loginApiSeat, openShiftApi } from "./helpers/api-seat";
import { callAs, errorText } from "./helpers/as-user";
import { binQty, getDoc, getList, newAdminContext } from "./helpers/backend";
import { deleteDrafts } from "./helpers/admin-fixtures";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft } from "./helpers/invoice-api";
import { closeLeftoverShiftsDetailed } from "./helpers/shifts";
import { glCheck } from "./helpers/reconcile";

const RATE = 1000;
const MAKE = "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening";

const ATTACKERS = [
	{ id: "CON-04c", number: 2, label: "Sales Manager cashier" },
	{ id: "CON-04d", number: LOWPRIV, label: "least-privilege cashier" },
] as const;

test.describe("CON-04c — another user and a printed draft", () => {
	test.beforeEach(() => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		test.skip(!cashierPassword(1), "cashier 01 password not set in .env.test");
	});

	for (const attacker of ATTACKERS) {
		test(`${attacker.id} — a ${attacker.label} asking for another user's closing must not submit their printed draft`, async ({ playwright }) => {
			test.skip(!cashierPassword(attacker.number), `password for ${attacker.label} not set in .env.test`);
			test.setTimeout(300_000);
			const admin = await newAdminContext(playwright);
			const f = new Findings();
			const data: Record<string, unknown> = {};
			let completed = false;
			const owner = await loginApiSeat(playwright, 1);
			const other = await loginApiSeat(playwright, attacker.number);
			let draftName: string | undefined;

			try {
				const left = await closeLeftoverShiftsDetailed(admin, owner.actor, { visitPos: false });
				f.check(left.stuck.length === 0, `could not clear the owner's leftover shifts: ${JSON.stringify(left.stuck)}`);

				const opened = await openShiftApi(owner, COMPANY, PROFILES.P1);
				if (!opened.shift) throw new Error(`could not open the owner's shift: ${opened.error}`);
				const shift = opened.shift;
				const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);

				// ---- the owner's printed draft: saved by the owner, marked printed, payment on it ----
				const made = await createDraft(
					owner.actor,
					buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }),
				);
				f.check(Boolean(made.doc?.name), `could not create the owner's draft: HTTP ${made.res.status} ${errorText(made.res)}`);
				draftName = made.doc?.name;
				if (!draftName) throw new Error("no draft to test with");
				const full = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName);
				const saved = await admin.post("/api/method/frappe.client.save", {
					data: { doc: { ...full, posa_is_printed: 1, paid_amount: RATE, base_paid_amount: RATE, payments: [{ doctype: "Sales Invoice Payment", mode_of_payment: "Cash", amount: RATE, base_amount: RATE }] } },
				});
				f.check(saved.ok(), `the fixture could not mark the draft printed: HTTP ${saved.status()} ${(await saved.text()).slice(0, 200)}`);
				const before = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName);
				f.check(before?.docstatus === 0 && before?.posa_is_printed === 1, `the draft is not in the intended state (docstatus ${before?.docstatus}, printed ${before?.posa_is_printed})`);
				const stockBefore = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
				f.note(`owner ${owner.email}: shift ${shift}, draft ${draftName} (docstatus ${before?.docstatus}, printed ${before?.posa_is_printed}, owner ${before?.owner})`);

				// ---- the other user asks for the owner's closing ----
				const opening = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shift);
				const res = await callAs(other.actor, MAKE, { opening_shift: opening });
				f.note(`${other.email} (${attacker.label}) called make_closing_shift_from_opening on ${owner.email}'s shift: HTTP ${res.status}${res.status === 200 ? "" : ` ${errorText(res)}`}`);
				data.attackStatus = res.status;
				f.expectSafe(res.status < 500, `uncontrolled server error (HTTP ${res.status}): ${errorText(res)}`);

				// ---- what happened to the owner's draft ----
				const after = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName);
				const submitted = after?.docstatus === 1;
				const stockAfter = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
				data.afterAttack = { docstatus: after?.docstatus, modifiedBy: after?.modified_by, stockChange: stockAfter - stockBefore };
				f.note(`the owner's invoice after the call: docstatus ${after?.docstatus}, last modified by ${after?.modified_by}, stock change ${stockAfter - stockBefore}`);
				if (submitted) {
					const gl = await glCheck(admin, draftName);
					f.note(`its ledger entries: debit ${gl.debit}, credit ${gl.credit}, balanced=${gl.balanced}`);
					const asked = await getList<{ name: string }>(admin, "POS Closing Shift", { pos_opening_shift: shift, docstatus: 1 }, ["name"]);
					f.note(`closings submitted for the shift by this call: ${asked.length} (the call only builds one; it does not submit it)`);
				}
				if (!submitted && res.status === 403) f.note("NOTE: a 403 here is a missing role permission (submit on Sales Invoice), not proof of an ownership check: see CON-04e for the owner's own request");
				f.expectSafe(
					!submitted,
					`${attacker.label} ${other.email} caused ${owner.email}'s printed draft ${draftName} to be submitted by merely requesting the closing (last modified by ${after?.modified_by}; stock moved by ${stockAfter - stockBefore}); the owner did nothing`,
				);

				completed = true;
			} finally {
				if (draftName) {
					const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName).catch(() => null);
					if (d && d.docstatus === 0) await deleteDrafts(admin, [draftName]).catch(() => {});
				}
				await closeLeftoverShiftsDetailed(admin, owner.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close the owner's shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
				await Promise.all([owner.dispose(), other.dispose()].map((p) => p.catch(() => {})));
				if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
				const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "unsupported_safely";
				recordEvidence({
					id: attacker.id,
					arrangement: `owner's printed draft on an open shift; a ${attacker.label} requests the owner's closing`,
					outcome,
					notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)],
					data,
				});
				await admin.dispose();
			}
			expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
			expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
		});
	}

	test("CON-04e — the owner can close their own shift while it holds a printed draft", async ({ playwright }) => {
		test.setTimeout(300_000);
		const admin = await newAdminContext(playwright);
		const f = new Findings();
		const data: Record<string, unknown> = {};
		let completed = false;
		const owner = await loginApiSeat(playwright, 1);
		let draftName: string | undefined;

		try {
			const left = await closeLeftoverShiftsDetailed(admin, owner.actor, { visitPos: false });
			f.check(left.stuck.length === 0, `could not clear the owner's leftover shifts: ${JSON.stringify(left.stuck)}`);
			const opened = await openShiftApi(owner, COMPANY, PROFILES.P1);
			if (!opened.shift) throw new Error(`could not open the owner's shift: ${opened.error}`);
			const shift = opened.shift;
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const made = await createDraft(owner.actor, buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift, items: [{ item_code: ITEMS.stock, qty: 1, rate: RATE }] }));
			draftName = made.doc?.name;
			f.check(Boolean(draftName), `could not create the owner's draft: HTTP ${made.res.status} ${errorText(made.res)}`);
			if (!draftName) throw new Error("no draft to test with");
			const full = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName);
			const saved = await admin.post("/api/method/frappe.client.save", {
				data: { doc: { ...full, posa_is_printed: 1, paid_amount: RATE, base_paid_amount: RATE, payments: [{ doctype: "Sales Invoice Payment", mode_of_payment: "Cash", amount: RATE, base_amount: RATE }] } },
			});
			f.check(saved.ok(), `the fixture could not mark the draft printed: HTTP ${saved.status()}`);
			const stockBefore = await binQty(admin, ITEMS.stock, WAREHOUSES.A);

			const opening = await getDoc<Record<string, any>>(admin, "POS Opening Shift", shift);
			const res = await callAs(owner.actor, MAKE, { opening_shift: opening });
			const after = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName);
			const stockAfter = await binQty(admin, ITEMS.stock, WAREHOUSES.A);
			data.ownerRequest = { status: res.status, docstatus: after?.docstatus, stockChange: stockAfter - stockBefore };
			f.note(`the owner asked for their own closing with printed draft ${draftName}: HTTP ${res.status}${res.status === 200 ? "" : ` ${errorText(res)}`}; the draft is now docstatus ${after?.docstatus}; stock change ${stockAfter - stockBefore}`);
			f.expectSafe(
				res.status === 200 && after?.docstatus === 1,
				`the owner cannot build their own closing while the shift holds a printed draft (HTTP ${res.status}, draft docstatus ${after?.docstatus}): the closing tries to submit the draft with the cashier's own permissions, which lack submit rights on Sales Invoice, so the shift cannot be closed`,
			);
			completed = true;
		} finally {
			if (draftName) {
				const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", draftName).catch(() => null);
				if (d && d.docstatus === 0) await deleteDrafts(admin, [draftName]).catch(() => {});
			}
			await closeLeftoverShiftsDetailed(admin, owner.actor, { visitPos: false }).then((c) => c.stuck.length && f.note(`could not close the owner's shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			await owner.dispose().catch(() => {});
			if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
			const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
			recordEvidence({
				id: "CON-04e",
				arrangement: "the owner requests their own closing while the shift holds a printed draft",
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

