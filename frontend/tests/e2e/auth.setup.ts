/**
 * Auth setup project — logs into the Frappe site once via the standard
 * `/login` form and saves the resulting session to `auth.json` (gitignored)
 * so every other spec/project can reuse it via `storageState` instead of
 * logging in per test. Wired into playwright.config.ts as the "setup"
 * project that "chromium"/"webkit"/"ipad-safari" depend on.
 *
 * Credentials come from POSPIRE_E2E_USERNAME / POSPIRE_E2E_PASSWORD, loaded
 * from `.env.test` (see `.env.test.example`) — never hardcode them here.
 */

import { test as setup } from "@playwright/test";
import { AUTH_FILE } from "./auth.config";

setup("authenticate", async ({ page }) => {
	const username = process.env.POSPIRE_E2E_USERNAME;
	const password = process.env.POSPIRE_E2E_PASSWORD;

	if (!username || !password) {
		throw new Error(
			"POSPIRE_E2E_USERNAME / POSPIRE_E2E_PASSWORD are not set. Copy " +
				"tests/e2e/.env.test.example to tests/e2e/.env.test and fill in " +
				"a real test user with POS access.",
		);
	}

	await page.goto("/login");
	await page.locator("#login_email").fill(username);
	await page.locator("#login_password").fill(password);
	// This site's /login template also renders a passwordless "Send login
	// link" button sharing the `.btn-login` class, so target by name instead.
	await page.getByRole("button", { name: "Continue" }).click();

	// Standard Frappe login redirects away from /login once authenticated.
	await page.waitForURL((url) => !url.pathname.startsWith("/login"));

	await page.context().storageState({ path: AUTH_FILE });
});
