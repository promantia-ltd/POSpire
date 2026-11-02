/**
 * Test-side mirror of the topology seeded by
 * pospire/pospire/tests/perf_seed.py. Keep the two in sync: this file only
 * names things, the seed script is what creates them.
 *
 * Cashier passwords are never stored here. They come from
 * POSPIRE_E2E_PERF_PASSWORD_01 .. _05 in .env.test (see .env.test.example).
 */

export const COMPANY = "Lifestyle Retail Stores";

/** Coupon-triggered POS Offer seeded by perf_seed.py; per-run coupons are attached to it. */
export const COUPON_OFFER = "PERF 10pct Coupon Offer";

export const PROFILES = {
	P1: "PERF-P1", // WH-A, Standard Selling, Cash + Credit Card
	P2: "PERF-P2", // WH-A, PERF Selling,     Cash + Credit Card (shares WH-A with P1)
	P3: "PERF-P3", // WH-B, Standard Selling, Cash only
} as const;

export const WAREHOUSES = {
	A: "PERF-WH-A - LRS",
	B: "PERF-WH-B - LRS",
} as const;

export const ITEMS = {
	stock: "PERF-STOCK", // 500 in each warehouse
	lastUnit: "PERF-LASTUNIT", // 1 in WH-A
	zero: "PERF-ZERO", // no stock
} as const;

/** Cashier number -> profiles they are assigned to (first is their default). */
export const CASHIER_PROFILES: Record<number, string[]> = {
	1: [PROFILES.P1, PROFILES.P2],
	2: [PROFILES.P1],
	3: [PROFILES.P2],
	4: [PROFILES.P3],
	5: [PROFILES.P3],
};

/**
 * Pseudo cashier number for the least-privilege user (perf.lowpriv@...). It
 * holds Sales User + POS User only, NOT Sales Manager, and is assigned to
 * PERF-P1. Use it for authorization negative tests, where a privileged
 * cashier would hide a missing server-side check.
 */
export const LOWPRIV = 99;

/** Burst cashiers (CON-06) are numbered FIRST_BURST_CASHIER..55 (50 of them) and all work on PERF-P1. */
export const FIRST_BURST_CASHIER = 6;
export const MAX_BURST_CASHIER = 55;

/**
 * Burst cashier that also holds Accounts Manager (see perf_seed.py), so a shift can be closed
 * while drafts exist. Tests that race a close against in-flight sales use it, so they measure
 * the race and not the role gap that makes every other cashier's close fail with 403.
 */
export const RACE_CASHIER = 55;

export function cashierEmail(n: number): string {
	if (n === LOWPRIV) return "perf.lowpriv@pospire.test";
	return `perf.cashier${String(n).padStart(2, "0")}@pospire.test`;
}

export function cashierPassword(n: number): string | undefined {
	if (n === LOWPRIV) return process.env.POSPIRE_E2E_PERF_PASSWORD_LOW;
	// Cashiers 6..55 (CON-06 burst) share one password, see perf_seed.py.
	if (n >= FIRST_BURST_CASHIER) return process.env.POSPIRE_E2E_PERF_PASSWORD_BURST;
	return process.env[`POSPIRE_E2E_PERF_PASSWORD_${String(n).padStart(2, "0")}`];
}

/** Multiple of 100: with denominations enabled, opening cash is entered in INR-100 notes. */
export const DEFAULT_OPENING_CASH = "0";
