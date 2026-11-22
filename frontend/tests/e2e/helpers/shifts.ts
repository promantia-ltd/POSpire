/**
 * Shift helpers shared by the concurrency specs.
 */

import { type Actor } from "../fixtures/actors";
import { callAs, errorText } from "./as-user";
import { getDoc, getList, listOpeningShifts } from "./backend";
import { gotoPos } from "./pos-ui";

type Admin = Parameters<typeof getList>[0];

export interface CloseReport {
	closed: string[];
	/** Shifts that could not be closed, and why (the server's answer, not a guess). */
	stuck: { shift: string; step: "build" | "submit"; status: number; detail: string }[];
}

/**
 * Try to close every open shift of this account through the API, as that
 * cashier, and report exactly what happened to each. A close that the server
 * refuses is a result, not an exception.
 */
export async function closeLeftoverShiftsDetailed(
	admin: Admin,
	actor: Pick<Actor, "email" | "page" | "context">,
	opts: { visitPos?: boolean } = {},
): Promise<CloseReport> {
	// Loading the POS gives the page a CSRF token for callAs; a session that already has
	// one (a headless API seat, see api-seat.ts) has no page to load.
	if (opts.visitPos !== false) await gotoPos(actor.page);
	const report: CloseReport = { closed: [], stuck: [] };
	const open = await listOpeningShifts(admin, { user: actor.email, status: "Open" });
	for (const s of open) {
		const doc = await getDoc<Record<string, any>>(admin, "POS Opening Shift", s.name);
		const made = await callAs(actor, "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening", {
			opening_shift: doc,
		});
		if (made.status !== 200 || !made.json?.message) {
			report.stuck.push({ shift: s.name, step: "build", status: made.status, detail: errorText(made) });
			continue;
		}
		const done = await callAs(actor, "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift", {
			closing_shift: made.json.message,
		});
		if (done.status === 200) report.closed.push(s.name);
		else report.stuck.push({ shift: s.name, step: "submit", status: done.status, detail: errorText(done) });
	}
	return report;
}

/**
 * Close every open shift of this account through the API, so a test never
 * starts on (or leaves behind) a stray shift. Returns the shifts it handled.
 */
export async function closeLeftoverShifts(admin: Admin, actor: Actor): Promise<string[]> {
	const r = await closeLeftoverShiftsDetailed(admin, actor);
	return [...r.closed, ...r.stuck.map((s) => s.shift)];
}

export interface ShiftInvoice {
	name: string;
	docstatus: number;
	owner: string;
	pos_offline_id: string | null;
}

/** Every invoice (any docstatus) attached to a shift. */
export function invoicesOnShift(admin: Admin, shift: string): Promise<ShiftInvoice[]> {
	return getList<ShiftInvoice>(admin, "Sales Invoice", { posa_pos_opening_shift: shift }, [
		"name",
		"docstatus",
		"owner",
		"pos_offline_id",
	]);
}
