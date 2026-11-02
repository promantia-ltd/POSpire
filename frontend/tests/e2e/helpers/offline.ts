/**
 * Shared steps for the offline scenarios (OFF-xx).
 */

import { type Page } from "@playwright/test";
import { outboxRows } from "./outbox";
import { prepareCashSale } from "./pos-ui";

/**
 * Make one cash sale per entry of `qtys` on a page whose network is already off,
 * waiting after each Submit until the sale is in the page's outbox. Returns the
 * queue depth after each sale. Assumes the page's outbox starts empty (every
 * actor has a fresh browser context).
 */
export async function sellOffline(page: Page, item: string, qtys: number[]): Promise<number[]> {
	const depths: number[] = [];
	for (const [j, qty] of qtys.entries()) {
		await prepareCashSale(page, item, qty);
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		let rows = await outboxRows(page);
		for (let i = 0; i < 40 && (rows?.length ?? 0) < j + 1; i++) {
			await page.waitForTimeout(500);
			rows = await outboxRows(page);
		}
		depths.push(rows?.length ?? 0);
	}
	return depths;
}
