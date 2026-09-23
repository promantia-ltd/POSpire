/**
 * Items repo — catalog data, NOT encrypted (13-security.md §2).
 *
 * Responsibilities:
 *  - Read helpers: by primary key, by barcode (multi-entry index), by group.
 *  - Write helpers: `put`/`bulkPut` used during shift-open hydration and
 *    stale-while-revalidate refreshes.
 *
 * Out of scope:
 *  - Enqueueing server writes: items are read-only locally, so there's
 *    nothing the outbox ever accepts for this table. Agent 3 does NOT
 *    call this repo.
 *  - Online fetching: hydration code lives in Agent 2 / call-wrapper; it
 *    fetches fresh data and hands it to `bulkPut` here.
 *
 * Stale-while-revalidate:
 *  - `cached_at` is set by the caller at write time. Readers decide whether
 *    to kick off a refresh; the repo never fires a network call itself.
 */

import { assertWritable, db } from "../db";
import { TTL_ITEMS_MS } from "../constants";
import type { ItemRow } from "../types";

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function getItemByCode(
	itemCode: string,
): Promise<ItemRow | undefined> {
	return db.items.get(itemCode);
}

export async function getItemsByCodes(
	itemCodes: string[],
): Promise<ItemRow[]> {
	if (itemCodes.length === 0) return [];
	return db.items.bulkGet(itemCodes).then((rows) =>
		rows.filter((r): r is ItemRow => Boolean(r)),
	);
}

/**
 * Barcode lookup. `*barcodes` is a multi-entry index so a single query
 * matches any row that has `barcode` somewhere in its `barcodes` array.
 */
export async function getItemByBarcode(
	barcode: string,
): Promise<ItemRow | undefined> {
	return db.items.where("barcodes").equals(barcode).first();
}

export async function listItemsByGroup(group: string): Promise<ItemRow[]> {
	return db.items.where("item_group").equals(group).toArray();
}

/**
 * Simple prefix search on item_code. For full-text search over item_name
 * we'd need a different strategy (fts library or server search) — the repo
 * intentionally stays minimal.
 */
export async function searchItemsByCodePrefix(
	prefix: string,
	limit = 50,
): Promise<ItemRow[]> {
	if (!prefix) return [];
	return db.items
		.where("item_code")
		.startsWithIgnoreCase(prefix)
		.limit(limit)
		.toArray();
}

export async function countItems(): Promise<number> {
	return db.items.count();
}

// ---------------------------------------------------------------------------
// Write helpers (cache hydration)
// ---------------------------------------------------------------------------

export async function putItem(row: ItemRow): Promise<void> {
	assertWritable();
	await db.items.put(row);
}

/**
 * Bulk hydrate. Caller is responsible for stamping `cached_at` on each row
 * so downstream stale-while-revalidate checks are consistent with the wall
 * clock at fetch time (not at put time; see SWR rules in §4.3).
 */
export async function bulkPutItems(rows: ItemRow[]): Promise<void> {
	assertWritable();
	if (rows.length === 0) return;
	await db.items.bulkPut(rows);
}

/**
 * Returns `true` when the cached snapshot of `itemCode` is stale per the
 * items TTL. Missing rows are "stale" (the caller should hydrate).
 */
export async function isStale(itemCode: string): Promise<boolean> {
	const row = await db.items.get(itemCode);
	if (!row) return true;
	return Date.now() - row.cached_at > TTL_ITEMS_MS;
}

/**
 * Drop items whose cached_at is older than `olderThanMs`. Used by the
 * quota-pressure purge (§7).
 */
export async function purgeStaleItems(olderThanMs: number): Promise<number> {
	assertWritable();
	const cutoff = Date.now() - olderThanMs;
	return db.items.where("cached_at").below(cutoff).delete();
}
