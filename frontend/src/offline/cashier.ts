/**
 * Cashier-user resolution.
 *
 * The single source of truth for "who is the cashier on this device right now",
 * used by:
 *   - `outbox.enqueue` to stamp `owner_user` on every queued payload
 *     (P-5: server attributes the write to this user via `_acting_as_user`)
 *   - `@/utils/call-registry` adapters that pre-stamp `owner_user` into the
 *     inner `data` JSON before handing the payload to the outbox
 *
 * This module exists because the lookup MUST be identical at every site —
 * a value of "Guest" reaches the server's `_apply_payload_metadata` and
 * raises `validation_error` (server-side guard), so any divergent
 * fallback path silently breaks every offline write made on the affected
 * device. Two implementations of the same lookup with different fallbacks
 * was the historical bug; one shared module + one fallback ladder closes it.
 *
 * Lookup order:
 *   1. `globalThis.frappe.session.user` — set when the SPA mounts under
 *      /app (Desk shell). For the standalone /pospire/pos route the Desk
 *      shell isn't injected, so this is usually undefined.
 *   2. `document.cookie["user_id"]` — Frappe writes this with httponly=False
 *      on every login (apps/frappe/frappe/auth.py:215), so it's readable
 *      from JS on both /app and /pospire routes. This is the load-bearing
 *      path for the standalone POSpire SPA.
 *   3. `"Guest"` — last-resort sentinel. If we hit this, something is
 *      structurally broken (no session, redirected to login, expired
 *      cookie). Stamping Guest on a queued write means the server replay
 *      will reject it. We log loudly so the dev console flags it.
 */

const COOKIE_RE = /(?:^|;\s*)user_id=([^;]+)/;

export function currentCashier(): string {
	try {
		const g = globalThis as unknown as {
			frappe?: { session?: { user?: string } };
		};
		if (g.frappe?.session?.user && g.frappe.session.user !== "Guest") {
			return g.frappe.session.user;
		}
	} catch {
		/* strict-privacy host without globalThis access — fall through */
	}
	try {
		if (typeof document !== "undefined" && document.cookie) {
			const match = document.cookie.match(COOKIE_RE);
			if (match) {
				const decoded = decodeURIComponent(match[1]);
				if (decoded && decoded !== "Guest") return decoded;
			}
		}
	} catch {
		/* document / cookie API unavailable — fall through */
	}
	// eslint-disable-next-line no-console
	console.error(
		"[cashier] currentCashier() falling back to 'Guest' — owner_user " +
			"will be stamped as Guest on this enqueue, which the server replay " +
			"will reject with a validation_error on submit. Likely cause: the " +
			"session expired or the user_id cookie is missing. Re-authenticate.",
	);
	return "Guest";
}
