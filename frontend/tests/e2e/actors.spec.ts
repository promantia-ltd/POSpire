/**
 * Proof that the Step A seed (perf_seed.py) and the Step B actor fixture work
 * end to end, before any concurrency scenario relies on them.
 *
 * ACTOR-01: a seeded cashier logs in with their own session, opens a shift on
 *           a seeded profile, and the backend records exactly that shift.
 * ACTOR-02: two independent actors hold independent sessions and
 *           independent browser storage.
 */

import { API_KEY, API_SECRET } from "./auth.config";
import { test, expect } from "./fixtures/actors";
import { PROFILES, cashierEmail, cashierPassword } from "./fixtures/topology";
import { listOpeningShifts, newAdminContext } from "./helpers/backend";

test.describe("Actor fixture — seeded cashiers", () => {
	test.beforeEach(() => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		test.skip(!cashierPassword(1), "POSPIRE_E2E_PERF_PASSWORD_01 not set in .env.test");
	});

	test("ACTOR-01 — cashier01 logs in, opens a shift on PERF-P1 and the backend records it", async ({
		cashiers,
		playwright,
	}) => {
		test.setTimeout(120_000);
		const admin = await newAdminContext(playwright);
		try {
			const c1 = await cashiers.login(1);
			await c1.openShift(PROFILES.P1);

			const shifts = await listOpeningShifts(admin, { user: c1.email, status: "Open" });
			expect(shifts).toHaveLength(1);
			expect(shifts[0].pos_profile).toBe(PROFILES.P1);
			expect(shifts[0].user).toBe(cashierEmail(1));

			await c1.closeShift();
			expect(await listOpeningShifts(admin, { user: c1.email, status: "Open" })).toHaveLength(0);
		} finally {
			await admin.dispose();
		}
	});

	test("ACTOR-02 — two actors have independent sessions and storage", async ({ cashiers }) => {
		test.skip(!cashierPassword(2), "POSPIRE_E2E_PERF_PASSWORD_02 not set in .env.test");
		test.setTimeout(120_000);

		const [a, b] = [await cashiers.login(1), await cashiers.login(2)];
		await Promise.all([a.page.goto("/pospire/pos"), b.page.goto("/pospire/pos")]);

		const sid = async (ctx: typeof a.context) =>
			(await ctx.cookies()).find((c) => c.name === "sid")?.value;
		expect(await sid(a.context)).toBeTruthy();
		expect(await sid(a.context)).not.toBe(await sid(b.context));

		// Storage written in one actor must not be visible in the other.
		await a.page.evaluate(() => localStorage.setItem("perf-probe", "a"));
		expect(await b.page.evaluate(() => localStorage.getItem("perf-probe"))).toBeNull();
	});
});
