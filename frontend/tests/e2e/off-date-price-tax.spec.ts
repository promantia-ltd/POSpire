/**
 * OFF-08 (P1): what changes between the moment a bill is made offline and the moment it
 * reaches the server?
 *
 *   OFF-08a  the device clock says two days ago when the bill is made: the invoice must
 *            carry that date (the queued posting date), not the day it syncs
 *   OFF-08d  the bill is dated inside an existing Accounting Period: the server refuses it;
 *            the refusal must be a visible exception that can be recovered, not a lost bill
 *   OFF-08b  the item's price changes on the server while the bill waits: the invoice must
 *            still match what the customer was charged (or be a visible exception)
 *   OFF-08c  the profile's tax template changes while the bill waits: the invoice must stay
 *            fully paid, and we record which tax the invoice ended up with
 *
 * Temporary site writes (08b, 08c), both undone in `finally`:
 *   08b  Item Price of PERF-LINE-010 in "Standard Selling": 150 -> 400, then back
 *   08c  a 10% inclusive template "PERF-TAX-10" is created, PERF-P1 is switched to it, then
 *        PERF-P1 is switched back and the template deleted
 * 08a and 08d write nothing but the bill itself.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { COMPANY, ITEMS, PROFILES, cashierPassword } from "./fixtures/topology";
import { getDoc, getList, listOpeningShifts, newAdminContext } from "./helpers/backend";
import { Findings, recordEvidence, type Outcome } from "./helpers/evidence";
import { sellOffline } from "./helpers/offline";
import { waitForOutboxDrain, outboxRows } from "./helpers/outbox";
import { gotoPos } from "./helpers/pos-ui";
import { closeLeftoverShifts, closeLeftoverShiftsDetailed } from "./helpers/shifts";

const RECOVERY = "POSpire Offline Sync Review";
const PRICE_LIST = "Standard Selling";
const PRICE_ITEM = "PERF-LINE-010";
const PRICE_BEFORE = 150;
const PRICE_AFTER = 400;
const TAX_TITLE = "PERF-TAX-10";
const PERIOD_DAY = "2026-08-15"; // inside "May - LRS - LRS" (2026-05-01 .. 2026-09-29)

type Mode = "past-date" | "period" | "price" | "tax";
type Admin = Awaited<ReturnType<typeof newAdminContext>>;

test.beforeEach(() => {
	test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
	test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
});

const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const noon = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);

async function setValue(admin: Admin, doctype: string, name: string, fieldname: string, value: unknown) {
	const res = await admin.post("/api/method/frappe.client.set_value", { data: { doctype, name, fieldname, value } });
	if (!res.ok()) throw new Error(`set_value ${doctype} ${name}.${fieldname} failed: HTTP ${res.status()} ${(await res.text()).slice(0, 300)}`);
}

/** posting_date of every row still in the page's outbox (a plaintext bookkeeping column). */
async function queuedPostingDates(page: Parameters<typeof outboxRows>[0]): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve) => {
				const open = indexedDB.open("pospire_offline");
				open.onerror = () => resolve([]);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains("outbox")) {
						db.close();
						return resolve([]);
					}
					const all = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
					all.onerror = () => {
						db.close();
						resolve([]);
					};
					all.onsuccess = () => {
						db.close();
						resolve((all.result as { posting_date?: string }[]).map((r) => String(r.posting_date)));
					};
				};
			}),
	);
}

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
	let priceName: string | null = null;
	let originalTemplate: string | null = null;
	let tempTemplate: string | null = null;

	try {
		a = await cashiers.login(1);
		const left = await closeLeftoverShifts(admin, a);
		if (left.length) f.note(`closed leftover shift(s) first: ${left.join(", ")}`);
		await a.openShift(PROFILES.P1, "0");
		const [shift] = await listOpeningShifts(admin, { user: a.email, status: "Open" });
		f.check(Boolean(shift), "no open shift after opening it");
		reviewsBefore = new Set((await getList<{ name: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name"], 5000)).map((r) => r.name));

		const item = mode === "price" || mode === "tax" ? PRICE_ITEM : ITEMS.stock;
		const fakeDay = mode === "past-date" ? noon(new Date(Date.now() - 2 * 86_400_000)) : mode === "period" ? new Date(`${PERIOD_DAY}T12:00:00`) : null;
		const expectedDay = fakeDay ? localIso(fakeDay) : localIso(new Date());
		data.expectedDay = expectedDay;

		// Arrangement that must hold BEFORE the bill is made
		if (mode === "price") {
			const rows = await getList<{ name: string; price_list_rate: number }>(admin, "Item Price", { item_code: PRICE_ITEM, price_list: PRICE_LIST }, ["name", "price_list_rate"], 5);
			f.check(rows.length === 1 && Number(rows[0].price_list_rate) === PRICE_BEFORE, `fixture price of ${PRICE_ITEM} is not ${PRICE_BEFORE}: ${JSON.stringify(rows)}`);
			priceName = rows[0]?.name ?? null;
		}
		if (fakeDay) {
			await a.page.clock.install({ time: fakeDay });
			await a.page.reload();
			await gotoPos(a.page);
			f.note(`device clock set to ${fakeDay.toString()}`);
		}

		await a.context.setOffline(true);
		const depth = await sellOffline(a.page, item, [1]);
		f.check((depth[depth.length - 1] ?? 0) >= 1, "the sale was not queued while offline");
		const queued = await queuedPostingDates(a.page);
		data.queuedPostingDates = queued;
		f.note(`posting date the app stamped on the queued bill: ${JSON.stringify(queued)} (expected ${expectedDay})`);
		if (fakeDay) f.expectSafe(queued.length === 1 && queued[0] === expectedDay, `the app stamped ${JSON.stringify(queued)} on the bill made on a ${expectedDay} clock`);

		// Arrangement WHILE the bill waits
		if (mode === "price" && priceName) {
			await setValue(admin, "Item Price", priceName, "price_list_rate", PRICE_AFTER);
			f.note(`Item Price ${priceName} changed ${PRICE_BEFORE} -> ${PRICE_AFTER} while the bill is queued`);
		}
		if (mode === "tax") {
			const profile = await getDoc<Record<string, any>>(admin, "POS Profile", PROFILES.P1);
			originalTemplate = profile?.taxes_and_charges ?? null;
			f.check(Boolean(originalTemplate), "PERF-P1 has no tax template to switch back to");
			const res = await admin.post("/api/method/frappe.client.insert", {
				data: {
					doc: {
						doctype: "Sales Taxes and Charges Template",
						title: TAX_TITLE,
						company: COMPANY,
						taxes: [
							{ charge_type: "On Net Total", account_head: "Output Tax SGST - LRS", description: "SGST", rate: 5, included_in_print_rate: 1 },
							{ charge_type: "On Net Total", account_head: "Output Tax CGST - LRS", description: "CGST", rate: 5, included_in_print_rate: 1 },
						],
					},
				},
			});
			f.check(res.ok(), `could not create the test tax template: HTTP ${res.status()} ${(await res.text()).slice(0, 300)}`);
			tempTemplate = res.ok() ? (await res.json()).message?.name : null;
			if (!tempTemplate) throw new Error("no test template");
			await setValue(admin, "POS Profile", PROFILES.P1, "taxes_and_charges", tempTemplate);
			f.note(`PERF-P1 tax template ${originalTemplate} -> ${tempTemplate} (10% inclusive) while the bill is queued`);
		}

		// Back to real time, back online
		if (fakeDay) await a.page.clock.setSystemTime(new Date());
		await a.context.setOffline(false);
		const drain = await waitForOutboxDrain(a.page, 240_000);
		const rows = (await outboxRows(a.page)) ?? [];
		data.rows = rows;
		data.drain = { ms: drain.ms, drained: drain.drained };
		f.note(`after going online: drained=${drain.drained}; rows=${JSON.stringify(rows)}`);

		const invoices = await getList<{ name: string; docstatus: number; posting_date: string }>(admin, "Sales Invoice", { posa_pos_opening_shift: shift.name }, ["name", "docstatus", "posting_date"], 20);
		data.invoices = invoices;
		f.note(`invoices on this shift: ${JSON.stringify(invoices)}`);
		const live = invoices.filter((x) => x.docstatus === 1);
		const reviews = (await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name", "status"], 5000)).filter((r) => !reviewsBefore.has(r.name));
		data.reviews = reviews;

		if (mode === "period") {
			const periods = await getList<{ name: string; start_date: string; end_date: string }>(admin, "Accounting Period", { company: COMPANY }, ["name", "start_date", "end_date"], 20);
			const inside = periods.filter((p) => p.start_date <= PERIOD_DAY && PERIOD_DAY <= p.end_date);
			f.check(inside.length === 1, `expected ${PERIOD_DAY} to fall in one accounting period, got ${JSON.stringify(periods)}`);
			const period = inside[0] ? await getDoc<Record<string, any>>(admin, "Accounting Period", inside[0].name) : null;
			const closedRows = (period?.closed_documents ?? []) as { document_type: string; closed: number }[];
			const salesInvoiceClosed = closedRows.some((r) => r.document_type === "Sales Invoice" && Number(r.closed) === 1);
			data.period = { name: period?.name, salesInvoiceRow: closedRows.find((r) => r.document_type === "Sales Invoice") ?? null, salesInvoiceClosed };
			f.note(`period ${period?.name}: Sales Invoice closed = ${salesInvoiceClosed} (row ${JSON.stringify(closedRows.find((r) => r.document_type === "Sales Invoice")?.closed)})`);
			const refused = live.length === 0;
			data.refused = refused;
			f.expectSafe(!(refused && !salesInvoiceClosed), "the bill was refused although this accounting period does not close Sales Invoices (the server check ignores the closed flag); the sale cannot be posted and only voiding the review row is left");
			if (refused) {
				f.expectSafe(
					rows.length === 1 && ["needs_review", "handed_off"].includes(rows[0].status ?? "") && reviews.length >= 1,
					`the refused bill is not a visible exception (rows=${JSON.stringify(rows.map((r) => r.status))}, review rows=${reviews.length})`,
				);
			} else {
				f.expectSafe(live.length === 1 && live[0].posting_date === expectedDay, `invoice accepted with posting date ${live[0]?.posting_date}`);
			}
		} else {
			f.check(drain.drained, "the queue did not drain within 240 s");
			f.expectSafe(drain.needsAttention.length === 0 || mode === "price", `queue ended needing attention: ${JSON.stringify(drain.needsAttention)}`);
			if (live.length === 1) {
				const d = await getDoc<Record<string, any>>(admin, "Sales Invoice", live[0].name);
				const total = Number(d?.rounded_total || d?.grand_total);
				const paid = (d?.payments ?? []).reduce((n: number, p: any) => n + Number(p.amount), 0) - Number(d?.change_amount ?? 0);
				const tax = Number(d?.total_taxes_and_charges ?? 0);
				const rate = Number(d?.items?.[0]?.rate);
				data.invoice = { name: d?.name, posting_date: d?.posting_date, rate, total, paid, tax, taxes: d?.taxes };
				f.note(`invoice ${d?.name}: posting_date ${d?.posting_date}, rate ${rate}, total ${total}, paid ${paid}, tax ${tax}, outstanding ${d?.outstanding_amount}`);
				f.expectSafe(Math.abs(total - paid) < 0.01, `invoice total ${total} is not what was paid (${paid})`);
				if (mode === "past-date") {
					f.expectSafe(d?.posting_date === expectedDay, `invoice dated ${d?.posting_date}, the bill was made on ${expectedDay}`);
					const gl = await getList<{ posting_date: string }>(admin, "GL Entry", { voucher_no: live[0].name, is_cancelled: 0 }, ["posting_date"], 50);
					const wrong = gl.filter((g) => g.posting_date !== expectedDay);
					data.glDates = [...new Set(gl.map((g) => g.posting_date))];
					f.expectSafe(gl.length > 0 && wrong.length === 0, `ledger entries dated ${JSON.stringify(data.glDates)}, expected ${expectedDay}`);
				}
				if (mode === "price") f.expectSafe(rate === PRICE_BEFORE, `invoice rate is ${rate}; the customer was charged ${PRICE_BEFORE} when the bill was made`);
				if (mode === "tax") f.note(tax > 0 ? `OBSERVATION: the invoice carries the NEW tax (${tax}); the receipt the customer got offline showed none` : "the invoice kept the old tax (none)");
			} else if (mode === "price") {
				f.expectSafe(
					live.length === 0 && rows.every((r) => ["needs_review", "handed_off"].includes(r.status ?? "")) && reviews.length >= 1,
					`${live.length} live invoice(s) and queue ${JSON.stringify(rows.map((r) => r.status))}: neither a correct invoice nor a visible exception`,
				);
			} else {
				f.expectSafe(false, `${live.length} submitted invoices for one queued sale (expected 1)`);
			}
		}
		completed = true;
	} finally {
		if (a) {
			await a.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
			await a.context.setOffline(false).catch(() => {});
		}
		// undo the temporary site writes first, whatever happened
		if (priceName) {
			await setValue(admin, "Item Price", priceName, "price_list_rate", PRICE_BEFORE).then(() => f.note(`restored Item Price ${priceName} to ${PRICE_BEFORE}`)).catch((e) => f.note(`COULD NOT RESTORE the price: ${e}`));
		}
		if (originalTemplate) {
			await setValue(admin, "POS Profile", PROFILES.P1, "taxes_and_charges", originalTemplate).then(() => f.note(`restored PERF-P1 to ${originalTemplate}`)).catch((e) => f.note(`COULD NOT RESTORE the profile tax template: ${e}`));
		}
		if (tempTemplate) {
			await admin.post("/api/method/frappe.client.delete", { data: { doctype: "Sales Taxes and Charges Template", name: tempTemplate } }).then((r) => f.note(r.ok() ? `deleted test template ${tempTemplate}` : `could not delete ${tempTemplate}: HTTP ${r.status()}`)).catch(() => {});
		}
		if (a) {
			const rows = await getList<{ name: string; status: string }>(admin, RECOVERY, { cashier_user: a.email }, ["name", "status"], 5000).catch(() => []);
			for (const r of rows.filter((x) => !reviewsBefore.has(x.name) && x.status === "Pending Review")) {
				await admin.post("/api/method/pospire.pospire.api.recovery.void_entry", { data: { name: r.name, reason: `test cleanup (${id})` } }).catch(() => {});
				f.note(`test cleanup voided the unresolved review row ${r.name}`);
			}
			await closeLeftoverShiftsDetailed(admin, a).then((c) => c.stuck.length && f.note(`could not close the shift at cleanup: ${JSON.stringify(c.stuck)}`)).catch(() => {});
			a.forgetShift();
		}
		if (!completed) f.note("TEST DID NOT COMPLETE: this outcome is incomplete and must not be read as a verdict");
		const outcome: Outcome = !completed ? "observed" : f.defects.length > 0 ? "defect" : mode === "period" && data.refused ? "unsupported_safely" : mode === "tax" && Number((data.invoice as any)?.tax) > 0 ? "supported_with_restrictions" : "supported";
		recordEvidence({ id, arrangement, outcome, notes: [...f.notes, ...f.problems.map((p) => `TEST PROBLEM: ${p}`), ...f.defects.map((d) => `DEFECT: ${d}`)], data });
		await admin.dispose();
	}
	expect(f.problems, `test could not complete:\n${f.problems.join("\n")}`).toEqual([]);
	expect(f.defects, `application defects found:\n${f.defects.join("\n")}`).toEqual([]);
}

test.describe("OFF-08 — date, accounting period, price and tax between making and syncing a bill", () => {
	test("OFF-08a — bill made on a clock two days in the past", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-08a", "device clock set 2 days back; 1 offline sale; clock restored; bill syncs", "past-date", { cashiers, playwright });
	});

	test("OFF-08d — bill dated inside an existing accounting period", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-08d", `device clock set to ${PERIOD_DAY} (inside accounting period May - LRS - LRS); 1 offline sale; bill syncs`, "period", { cashiers, playwright });
	});

	test("OFF-08b — item price changed while the bill waits", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-08b", `${PRICE_ITEM} sold offline at ${PRICE_BEFORE}; its Item Price becomes ${PRICE_AFTER} before the bill syncs`, "price", { cashiers, playwright });
	});

	test("OFF-08c — profile tax template changed while the bill waits", async ({ cashiers, playwright }) => {
		test.setTimeout(600_000);
		await run("OFF-08c", "1 offline sale; PERF-P1 is switched to a 10% inclusive tax template before the bill syncs", "tax", { cashiers, playwright });
	});
});
