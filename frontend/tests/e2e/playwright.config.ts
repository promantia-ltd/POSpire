/**
 * Playwright config for the POSpire offline E2E suite.
 *
 * Device matrix (14-testing-strategy.md §8) — P0 entries are enabled here.
 * iPadOS Safari runs in WebKit + device-emulation mode; Chrome + Edge share
 * the same Chromium project.
 *
 * The full chaos + device suite lands in Phase 1 task 1.14. Until then this
 * config runs the smoke spec only.
 */

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.POSPIRE_E2E_BASE_URL ?? "http://localhost:8000";

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
		// Frappe sites require an authenticated session for the POS page. Set
		// storageState via the auth-setup project in a follow-up; Phase 1 runs
		// the smoke spec against an already-authenticated browser profile that
		// the test runner shares via `POSPIRE_E2E_STORAGE_STATE`.
		storageState: process.env.POSPIRE_E2E_STORAGE_STATE || undefined,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
		},
		{
			name: "ipad-safari",
			use: { ...devices["iPad (gen 7)"] },
		},
	],
});
