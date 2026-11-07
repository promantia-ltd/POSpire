/**
 * One-call business verification used by the race scenarios: reconciler, stock
 * movement and ledger balance for every sale the manifest says went through.
 * Defects (duplicates, wrong stock, unbalanced ledger) go to `findings.defects`;
 * inconsistencies that point at the TEST (e.g. wrong expected total) go to
 * `findings.problems`.
 */

import { type APIRequestContext } from "@playwright/test";
import { type Findings } from "./evidence";
import { type Manifest } from "./manifest";
import { compareStock, expectedStockDeltas, glCheck, reconcile, snapshotBins, type StockKey } from "./reconcile";

export async function verifyManifest(
	admin: APIRequestContext,
	manifest: Manifest,
	before: Map<string, number>,
	keys: StockKey[],
	f: Findings,
) {
	const report = await reconcile(admin, manifest);
	f.check(report.lost.length === 0, `lost sales: ${report.lost.join(", ")}`);
	f.expectSafe(report.duplicates.length === 0, `duplicate invoices for one sale: ${JSON.stringify(report.duplicates)}`);
	f.expectSafe(report.collisions.length === 0, `colliding invoices: ${JSON.stringify(report.collisions)}`);
	for (const m of report.mismatches) f.check(false, `${m.txnId} ${m.invoice}: ${JSON.stringify(m.issues)}`);

	const after = await snapshotBins(admin, keys);
	for (const i of compareStock(before, after, expectedStockDeltas(manifest.all()))) {
		f.expectSafe(false, `stock effect wrong: ${JSON.stringify(i)}`);
	}
	for (const s of manifest.all().filter((x) => x.state === "submitted" && x.invoice)) {
		const gl = await glCheck(admin, s.invoice!);
		f.expectSafe(gl.balanced, `ledger for ${s.invoice} missing or unbalanced (debit ${gl.debit}, credit ${gl.credit})`);
	}
	return report;
}
