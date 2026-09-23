/**
 * Metadata repo — small typed key/value helpers over Dexie's `metadata`
 * table.
 *
 * The `metadata` table holds non-PII cache entries (price lists, tax
 * template snapshots, POS Profile pointer, last-sync stats) plus the
 * encryption CryptoKey rows (managed by `db.ts`, never via this repo).
 *
 * Callers must NOT use this repo to persist any PII — encrypted tables
 * (customers, outbox payloads, shift cash/notes) have their own repos so
 * the encryption boundary lives there.
 */

import { assertWritable, db } from "../db";
import type { MetadataRow } from "../types";

/**
 * Keys this repo refuses to read/write — they are internal to db.ts and
 * exposing them here would invite accidental bypass of the encryption
 * bootstrap.
 */
const RESERVED_PREFIXES = ["crypto."];

function assertNotReserved(key: string): void {
	for (const p of RESERVED_PREFIXES) {
		if (key.startsWith(p)) {
			throw new Error(
				`metadata.${key} is reserved for db internals; use the dedicated module`,
			);
		}
	}
}

export async function getMetadata<V = unknown>(
	key: string,
): Promise<V | undefined> {
	assertNotReserved(key);
	const row = await db.metadata.get(key);
	return row ? (row.value as V) : undefined;
}

export async function getMetadataRow<V = unknown>(
	key: string,
): Promise<MetadataRow<V> | undefined> {
	assertNotReserved(key);
	const row = await db.metadata.get(key);
	return row as MetadataRow<V> | undefined;
}

export async function setMetadata<V = unknown>(
	key: string,
	value: V,
): Promise<void> {
	assertWritable();
	assertNotReserved(key);
	await db.metadata.put({
		key,
		value,
		updated_at: Date.now(),
	});
}

export async function bulkSetMetadata(
	entries: Array<{ key: string; value: unknown }>,
): Promise<void> {
	assertWritable();
	for (const e of entries) assertNotReserved(e.key);
	const now = Date.now();
	await db.metadata.bulkPut(
		entries.map((e) => ({ key: e.key, value: e.value, updated_at: now })),
	);
}

export async function deleteMetadata(key: string): Promise<void> {
	assertWritable();
	assertNotReserved(key);
	await db.metadata.delete(key);
}

/**
 * Returns `true` if the cached entry is fresh relative to `ttlMs`. Missing
 * entries are considered stale.
 */
export async function isFresh(key: string, ttlMs: number): Promise<boolean> {
	assertNotReserved(key);
	const row = await db.metadata.get(key);
	if (!row) return false;
	return Date.now() - row.updated_at < ttlMs;
}
