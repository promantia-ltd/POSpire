/**
 * Call a whitelisted method AS a particular actor, using that actor's own
 * browser session (cookie + CSRF token). Authorization tests must use this, not
 * the admin API key: the admin token bypasses the very checks being tested.
 */

import { type Actor } from "../fixtures/actors";

export interface AsUserResult {
	status: number;
	json: any;
}

export async function callAs(
	actor: Pick<Actor, "email" | "page" | "context">,
	method: string,
	body: Record<string, unknown>,
): Promise<AsUserResult> {
	const csrf = await actor.page.evaluate(() => (window as unknown as { csrf_token?: string }).csrf_token);
	if (!csrf) throw new Error(`No csrf_token on the page for ${actor.email}; cannot call as that user`);
	const res = await actor.context.request.post(`/api/method/${method}`, {
		headers: { "X-Frappe-CSRF-Token": csrf, Accept: "application/json" },
		data: body,
	});
	let json: any = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON error body */
	}
	return { status: res.status(), json };
}

export const errorText = (r: AsUserResult) =>
	String(r.json?.exception ?? r.json?._server_messages ?? r.json?.message ?? "").slice(0, 160);
