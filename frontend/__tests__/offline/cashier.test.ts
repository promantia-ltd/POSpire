/**
 * `currentCashier()` resolver — cookie-path regression.
 *
 * The Guest fallback was a P1 bug: standalone /pospire/pos doesn't get the
 * Desk shell's `frappe.session.user` global, so the resolver MUST fall
 * back to Frappe's `user_id` cookie (set httponly=False on every login)
 * before stamping "Guest" on a queued write — server replay rejects
 * Guest-stamped payloads.
 *
 * The shared resolver lives in @/offline/cashier and is the single source
 * of truth for both outbox.ts and call-registry.ts. These tests pin the
 * cookie-path behaviour so a future refactor that drops the cookie read
 * (or breaks the cookie regex) can't silently regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lazy-import inside each test so we observe the real environment (cookie
// + globalThis.frappe) at lookup time. The resolver itself is stateless
// (no module-level cache), but doing this keeps the boundary explicit.
async function importCurrentCashier() {
	const mod = await import("@/offline/cashier");
	return mod.currentCashier;
}

function clearCookies() {
	if (typeof document === "undefined") return;
	for (const c of document.cookie.split(";")) {
		const name = c.split("=")[0]?.trim();
		if (name) {
			// Expire it. Path=/ matters because the cookie was set without one
			// (so default-domain default-path); jsdom's cookie store accepts
			// either form for clearing.
			document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
		}
	}
}

function clearFrappeGlobal() {
	const g = globalThis as unknown as { frappe?: unknown };
	delete g.frappe;
}

describe("currentCashier — cookie path", () => {
	beforeEach(() => {
		clearCookies();
		clearFrappeGlobal();
	});

	afterEach(() => {
		clearCookies();
		clearFrappeGlobal();
		vi.restoreAllMocks();
	});

	it("returns the user_id cookie value when no Desk shell is present", async () => {
		document.cookie = "user_id=cashier%40example.com; path=/";
		const currentCashier = await importCurrentCashier();
		// The cookie stored the URL-encoded form; the resolver must decode.
		expect(currentCashier()).toBe("cashier@example.com");
	});

	it("prefers globalThis.frappe.session.user when both are set", async () => {
		document.cookie = "user_id=cookie%40example.com; path=/";
		(globalThis as unknown as {
			frappe: { session: { user: string } };
		}).frappe = { session: { user: "global@example.com" } };
		const currentCashier = await importCurrentCashier();
		expect(currentCashier()).toBe("global@example.com");
	});

	it("ignores a 'Guest' user_id cookie and falls through", async () => {
		document.cookie = "user_id=Guest; path=/";
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const currentCashier = await importCurrentCashier();
		// Guest is the explicit sentinel — neither the global nor the cookie
		// should ever be honoured if they hold "Guest".
		expect(currentCashier()).toBe("Guest");
		// The fallback path logs an error so the dev console flags it.
		expect(warn).toHaveBeenCalled();
	});

	it("does not match user_id as a substring of another cookie key", async () => {
		// Regex must be anchored — otherwise `last_user_id=...` would match.
		document.cookie = "last_user_id=imposter%40example.com; path=/";
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const currentCashier = await importCurrentCashier();
		expect(currentCashier()).toBe("Guest");
		expect(warn).toHaveBeenCalled();
	});

	it("returns 'Guest' (with loud warn) when neither global nor cookie carries a user", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const currentCashier = await importCurrentCashier();
		expect(currentCashier()).toBe("Guest");
		expect(warn).toHaveBeenCalled();
	});

	it("decodes URL-encoded characters in the cookie", async () => {
		// Real Frappe cookie value for an email contains the literal '@'
		// percent-encoded as %40.
		document.cookie = "user_id=manager%2Bsales%40example.com; path=/";
		const currentCashier = await importCurrentCashier();
		expect(currentCashier()).toBe("manager+sales@example.com");
	});
});
