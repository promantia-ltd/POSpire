/**
 * OFF-05f (P0): the server already holds a document for a queued bill, in a state
 * the replay did not expect.
 *
 *   OFF-05f-1  a DRAFT with the bill's offline id exists (a replay that inserted but
 *              never submitted): the replay must finish that draft, not duplicate it
 *   OFF-05f-2  that draft was DELETED before the replay: the bill must still end up
 *              as exactly one submitted invoice
 *   OFF-05f-3  the invoice was CANCELLED on the server before the replay: the bill
 *              must not show "synced" with no live invoice behind it; it has to end as
 *              an explicit, visible exception
 *
 * One cashier, one shift, one offline sale (qty 2). The replay request is held at the
 * network layer so the test controls what the server holds when the replay arrives.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, WAREHOUSES, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { buildInvoice, createDraft } from "./helpers/invoice-api";
import { sellOffline } from "./helpers/offline";
import { outboxRows, waitForOutboxDrain } from "./helpers/outbox";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed } from "./helpers/shifts";

const REPLAY = /api\.offline\.submit_invoice/;
const RECOVERY = "POSpire Offline Sync Review";
const QTY = 2;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

/** The offline id the app put on the replay request (body is JSON or form-encoded). */
function offlineIdOf(body: string | null): string | null {
	if (!body) return null;
	try {
		const j = JSON.parse(body);
		if (typeof j?.offline_id === "string") return j.offline_id;
	} catch {
		/* form-encoded */
	}
	return new URLSearchParams(body).get("offline_id");
}

type Mode = "draft" | "deleted-draft" | "cancelled";

async function run(
	id: string,
	arrangement: string,
	mode: Mode,
	{ cashiers, playwright }: { cashiers: Parameters<Parameters<typeof test>[2]>[0]["cashiers"]; playwright: Parameters<typeof newAdminContext>[0] },
) {
	const admin = await newAdminContext(playwright);
	const f = new Findings();
	const data: Record<string, unknown> = {};
	let completed = false;
	let a: Awaited<ReturnType<typeof cashiers.login>> | undefined;
	let reviewsBefore = new Set<string>();

	try {
		a = await cashiers.login(1);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift after opening it");
		reviewsBefore = new Set((await getList<{ name: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name"], 5000)).map((r) => r.name));

		await a.context.setOffline(true);
		const depth = await sellOffline(a.page, ITEMS.stock, [QTY]);
		f.check((depth[depth.length - 1] ?? 0) >= 1, "the sale was not queued while offline");

		// Hold the first replay request: learn the offline id, then arrange the server state.
		let offlineId: string | null = null;
		let arranged: () => void = () => {};
		const ready = new Promise<void>((r) => (arranged = r));
		let seen = 0;
		let cancelledName: string | null = null;
		let released = false;
		await a.context.route(REPLAY, async (route) => {
			seen += 1;
			if (seen > 1) return released ? route.continue() : route.abort("connectionreset");
			offlineId = offlineIdOf(route.request().postData());
			if (mode === "cancelled") {
				await route.fetch(); // the server completes the sale...
				await route.abort("connectionreset"); // ...the app never hears
			} else {
				await route.abort("connectionreset");
			}
			arranged();
		});
		await a.context.setOffline(false);
		await Promise.race([ready, a.page.waitForTimeout(120_000)]);
		f.check(Boolean(offlineId), "could not read the offline id from the replay request");
		if (!offlineId) throw new Error("no offline id");
		data.offlineId = offlineId;

		const find = async () => getList<{ name: string; docstatus: number }>(admin, "Sales Invoice", { pos_offline_id: offlineId! }, ["name", "docstatus"], 50);

		if (mode === "cancelled") {
			let inv = await find();
			for (let i = 0; i < 15 && !inv.some((x) => x.docstatus === 1); i++) {
				await a.page.waitForTimeout(1_000);
				inv = await find();
			}
			f.check(inv.length === 1 && inv[0].docstatus === 1, `expected one submitted invoice before cancelling, found ${JSON.stringify(inv)}`);
			cancelledName = inv[0]?.name ?? null;
			if (cancelledName) {
				const res = await admin.post("/api/method/frappe.client.cancel", { data: { doctype: "Sales Invoice", name: cancelledName } });
				f.check(res.ok(), `could not cancel ${cancelledName}: HTTP ${res.status()}`);
			}
		} else {
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			const inv = { ...buildInvoice({ company: COMPANY, posProfile: PROFILES.P1, customer: profile?.customer, shift: shift.name, items: [{ item_code: ITEMS.stock, qty: QTY, rate: 1000 }] }), pos_offline_id: offlineId };
			const made = await createDraft(a, inv);
			f.check(made.res.status === 200, `could not create the draft: HTTP ${made.res.status}`);
			const found = await find();
			f.check(found.length === 1 && found[0].docstatus === 0, `draft with the offline id not found as a draft: ${JSON.stringify(found)}`);
			data.draft = found[0]?.name;
			if (mode === "deleted-draft" && found[0]) {
				const res = await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Invoice", name: found[0].name } });
				f.check(res.ok(), `could not delete the draft: HTTP ${res.status()}`);
			}
		}

		// Let the app retry for real now.
		released = true;
		await a.context.unrouteAll({ behavior: "ignoreErrors" });
		const drain = await waitForOutboxDrain(a.page, 240_000);
		const rows = (await outboxRows(a.page)) ?? [];
		data.rows = rows;
		data.drain = { ms: drain.ms, drained: drain.drained };
		f.note(`after the retry: drained=${drain.drained}; rows=${JSON.stringify(rows)}`);

		const after = await find();
		data.invoicesAfter = after;
		f.note(`server documents for this bill: ${JSON.stringify(after)}`);
		const live = after.filter((x) => x.docstatus === 1);

		if (mode === "cancelled") {
			const reviews = (await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name", "status"], 5000)).filter((r) => !reviewsBefore.has(r.name));
			data.reviews = reviews;
			const synced = rows.some((r) => r.status === "synced") || (drain.drained && drain.needsAttention.length === 0);
			f.expectSafe(live.length === 0, `a cancelled bill was re-submitted: ${JSON.stringify(live)}`);
			f.expectSafe(!synced, "the bill shows as synced but its only invoice is cancelled: the sale has no live invoice and nothing flags it");
			f.expectSafe(rows.every((r) => ["needs_review", "handed_off"].includes(r.status ?? "")) && reviews.length >= 1, `the cancelled bill did not become a visible exception (rows=${JSON.stringify(rows.map((r) => r.status))}, review rows=${reviews.length})`);
		} else {
			f.check(drain.drained, "the queue did not drain within 240 s");
			f.expectSafe(drain.needsAttention.length === 0, `queue ended needing attention: ${JSON.stringify(drain.needsAttention)}`);
			f.expectSafe(live.length === 1, `${live.length} submitted invoices for one queued sale (expected exactly 1)`);
			f.expectSafe(after.length === 1, `${after.length} documents with the same offline id (expected 1): ${JSON.stringify(after)}`);
			if (live[0]) {
				const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", live[0].name);
				const qty = (d?.items ?? []).reduce((n: number, it: any) => n + Number(it.qty), 0);
				f.expectSafe(qty === QTY, `invoice quantity ${qty}, expected ${QTY}`);
				f.expectSafe(d?.owner === a.email, `invoice owned by ${d?.owner}, expected ${a.email}`);
			}
		}
		completed = true;
	} finally {
		if (a) {
			await a.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await a.context.setOffline(false).catch(() => {});
			const rows = await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name", "status"], 5000).catch(() => []);
			for (const r of rows.filter((x) => !reviewsBefore.has(x.name) && x.status === "Pending Review")) {
				await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: r.name, reason: `test cleanup (${id})` } }).catch(() => {});
				f.note(`test cleanup voided the unresolved review row ${r.name}`);
			}
			await closeLeftoverShiftsDetailed(admin, a).then((c) => c.stuck.length && f.note(`could not close the shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			a.forgetShift();
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : "supported";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("OFF-05f — the server already holds a document for the queued bill", () => {
	test("OFF-05f-1 — a draft with the bill's offline id exists", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-05f-1", "1 offline sale; before the replay arrives a draft with the same offline id exists on the server", "draft", { cashiers, playwright });
	});

	test("OFF-05f-2 — that draft was deleted before the replay", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-05f-2", "1 offline sale; a draft with the same offline id was created and then deleted before the replay", "deleted-draft", { cashiers, playwright });
	});

	test("OFF-05f-3 — the invoice was cancelled before the replay", async ({ cashiers, playwright }) => {
		test.setTimeout(900_000);
		await run("OFF-05f-3", "1 offline sale; the server completes it, the reply is lost, a manager cancels the invoice, the app retries", "cancelled", { cashiers, playwright });
	});
});
