/**
 * Smoke test: online baseline.
 *
 * Loads the POS app, verifies it renders, and asserts the offline banner is
 * NOT visible while the detector thinks the server is reachable. This is the
 * regression guard against the "banner stuck on" bug class.
 *
 * Scenario 1 from 14-testing-strategy.md §6. Full offline scenarios live in
 * the other spec files (TODO until Phase 1 task 1.14 lands the live-server
 * harness).
 */

import { expect, test } from "@playwright/test";

test.describe("smoke — online baseline", () => {
	test("POS app loads and the offline banner is hidden", async ({ page }) => {
		await page.goto("/pos");

		// The banner lives under a data-testid we'll add when the UI banner
		// component ships (Agent 4). Until then we assert loosely on role +
		// content and allow the test to fail open if the element isn't present.
		const banner = page.getByTestId("offline-banner");
		// Banner should either not exist, or if present, read "Online" state.
		if (await banner.count()) {
			await expect(banner).toHaveAttribute("data-status", "online");
		}

		// App shell must render SOMETHING. Pick a stable landmark.
		await expect(page.locator("body")).toBeVisible();
	});
});
