/**
 * Playwright config for the POSpire offline E2E suite.
 *
 * Project wiring (review feedback 2026-10-20):
 *   - "setup" runs auth.setup.ts to produce auth.json. Playwright does not
 *     auto-discover files outside *.spec.ts/*.test.ts, so this project's
 *     explicit testMatch is the only thing that makes it run at all.
 *   - "config-check" runs config-check.spec.ts on its own, with no browser
 *     storageState — it's pure Administrator-API-key reads (see
 *     config-check.spec.ts's own header).
 *   - "chromium" depends on BOTH "setup" and "config-check": a config-check
 *     failure blocks it from running at all, and it reuses the session
 *     "setup" just produced.
 *
 * webkit/ipad-safari are deliberately not defined below for now (see the
 * device matrix note in 14-testing-strategy.md §8) — smoke.spec.ts's
 * self-healing shift logic and TEST_DATA assume a single shared test user,
 * and running the same user across 3 parallel projects let one project's
 * shift-close race another project's still-in-progress run (the original
 * bug this review caught). Re-add them once each project has its own
 * dedicated test user/POS Profile.
 */

import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./auth.config";

export default defineConfig({
	testDir: ".",
	// Shorter timeouts keep CI feedback tight; individual tests can bump.
	timeout: 30_000,
	expect: { timeout: 5_000 },
	fullyParallel: true,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report", open: "never" }],
	],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "setup",
			testMatch: /auth\.setup\.ts/,
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "config-check",
			testMatch: /config-check\.spec\.ts/,
		},
		{
			name: "chromium",
			testMatch: /smoke\.spec\.ts/,
			use: { ...devices["Desktop Chrome"], storageState: AUTH_FILE },
			dependencies: ["setup", "config-check"],
		},
	],
});
