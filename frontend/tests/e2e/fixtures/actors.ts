/**
 * Multi-cashier fixture: every `cashiers.login(n)` call produces an
 * independent actor with its OWN server session (a fresh /api/method/login,
 * not a copied cookie) and its OWN browser context, so IndexedDB, localStorage
 * and the offline outbox are isolated per actor, like a separate device.
 *
 * Calling login() twice with the same number gives two independent
 * same-account "devices" (CON-03). To model two tabs sharing one browser's
 * storage (CON-05), call actor.newTab() instead.
 *
 * Teardown closes any shift an actor opened through actor.openShift() and then
 * disposes the context, so a failed test does not leave shifts open for the
 * next run.
 */

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "../auth.config";
import { closeShift, ensureShiftOpen } from "../helpers/pos-ui";
import { COMPANY, DEFAULT_OPENING_CASH, cashierEmail, cashierPassword } from "./topology";

export interface Actor {
	number: number;
	email: string;
	context: BrowserContext;
	page: Page;
	/** Open a shift on `posProfile` (closing any leftover one first). */
	openShift(posProfile: string, openingCash?: string, beforeCreate?: () => Promise<void>): Promise<void>;
	/** Close this actor's shift now; teardown skips it afterwards. */
	closeShift(): Promise<void>;
	/** The shift was closed by someone else; stop teardown trying to close it. */
	forgetShift(): void;
	/** Another tab in the SAME browser context (shared storage). */
	newTab(): Promise<Page>;
}

export interface CashierFactory {
	login(number: number): Promise<Actor>;
}

export const test = base.extend<{ cashiers: CashierFactory }>({
	cashiers: async ({ browser, playwright }, use) => {
		const actors: { actor: Actor; shiftOpen: () => boolean }[] = [];

		const factory: CashierFactory = {
			async login(number) {
				const password = cashierPassword(number);
				if (!password) {
					throw new Error(
						`POSPIRE_E2E_PERF_PASSWORD_${String(number).padStart(2, "0")} is not set in tests/e2e/.env.test`,
					);
				}
				const email = cashierEmail(number);

				// Log in over HTTP: fast enough for 50 actors, and each call is a
				// genuinely new session.
				const api = await playwright.request.newContext({ baseURL: BASE_URL });
				const res = await api.post("/api/method/login", { form: { usr: email, pwd: password } });
				if (!res.ok()) {
					const body = await res.text();
					await api.dispose();
					throw new Error(`Login failed for ${email}: HTTP ${res.status()} ${body.slice(0, 200)}`);
				}
				const storageState = await api.storageState();
				await api.dispose();

				const context = await browser.newContext({ baseURL: BASE_URL, storageState });
				const page = await context.newPage();

				let shiftOpen = false;
				const actor: Actor = {
					number,
					email,
					context,
					page,
					async openShift(posProfile, openingCash = DEFAULT_OPENING_CASH, beforeCreate) {
						await ensureShiftOpen(page, { company: COMPANY, posProfile, openingCash, beforeCreate });
						shiftOpen = true;
					},
					async closeShift() {
						await closeShift(page);
						shiftOpen = false;
					},
					forgetShift() {
						shiftOpen = false;
					},
					newTab: () => context.newPage(),
				};
				actors.push({ actor, shiftOpen: () => shiftOpen });
				return actor;
			},
		};

		await use(factory);

		// Best-effort cleanup; never mask the test's own failure. But do not
		// hide a failed cleanup either: a shift left open breaks the next run,
		// so say which actor's shift was left behind.
		for (const { actor, shiftOpen } of actors) {
			if (shiftOpen()) {
				await closeShift(actor.page).catch((err) => {
					console.warn(
						`[actors] teardown could not close the shift for ${actor.email}; it is still open: ${String(err).split("\n")[0]}`,
					);
				});
			}
			await actor.context.close().catch(() => {});
		}
	},
});

export { expect };
