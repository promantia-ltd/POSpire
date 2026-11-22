/**
 * A cashier session with NO browser: a real login (own cookie jar, own CSRF
 * token) used to call the server as that cashier. 50 of these are cheap, 50
 * browser windows are not, so the CON-06 burst uses seats for the full-size
 * runs and real windows only for a smaller run.
 *
 * Each seat is shaped like the parts of an Actor that callAs / createDraft /
 * submitDraft / closeLeftoverShiftsDetailed use (email, context.request, and a
 * page that yields the CSRF token), so those helpers work on it unchanged.
 */

import { type APIRequestContext, type Playwright } from "@playwright/test";
import { BASE_URL } from "../auth.config";
import { type Actor } from "../fixtures/actors";
import { cashierEmail, cashierPassword } from "../fixtures/topology";
import { callAs, errorText, type AsUserResult } from "./as-user";

export interface ApiSeat {
	number: number;
	email: string;
	request: APIRequestContext;
	/** Pass this to callAs & co. */
	actor: Actor;
	dispose(): Promise<void>;
}

export async function loginApiSeat(playwright: Playwright, number: number): Promise<ApiSeat> {
	const email = cashierEmail(number);
	const password = cashierPassword(number);
	if (!password) throw new Error(`No password configured for cashier ${number} (${email}); see .env.test`);

	const request = await playwright.request.newContext({ baseURL: BASE_URL });
	const login = await request.post("/api/method/login", { form: { usr: email, pwd: password } });
	if (!login.ok()) {
		const body = (await login.text()).slice(0, 200);
		await request.dispose();
		throw new Error(`Login failed for ${email}: HTTP ${login.status()} ${body}`);
	}
	// The POS page embeds this session's CSRF token, exactly what the screen reads.
	const html = await (await request.get("/pospire/pos")).text();
	const csrf = html.match(/csrf_token"?\]?\s*=\s*"([0-9a-f]+)"/)?.[1];
	if (!csrf) {
		await request.dispose();
		throw new Error(`Could not read the CSRF token for ${email} from the POS page`);
	}

	const actor = {
		number,
		email,
		context: { request },
		page: { evaluate: async () => csrf },
	} as unknown as Actor;
	return { number, email, request, actor, dispose: () => request.dispose() };
}

/** Open a shift on `posProfile` with zero opening cash, as the opening dialog does. */
export async function openShiftApi(
	seat: ApiSeat,
	company: string,
	posProfile: string,
): Promise<{ result: AsUserResult; shift?: string; error?: string }> {
	const result = await callAs(seat.actor, "pospire.pospire.api.posapp.create_opening_voucher", {
		pos_profile: posProfile,
		company,
		balance_details: [{ mode_of_payment: "Cash", amount: 0 }],
	});
	const shift = result.json?.message?.pos_opening_shift?.name as string | undefined;
	return { result, shift, error: shift ? undefined : `HTTP ${result.status} ${errorText(result)}` };
}
