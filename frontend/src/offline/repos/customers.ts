/**
 * Customers repo — encrypted-at-rest PII.
 *
 * At rest we persist `StoredCustomerRow`:
 *   - Indexed plaintext columns: `name`, `mobile_no`, `customer_group`,
 *     `offline_created`, `cached_at` (needed for queries without decrypt).
 *   - `envelope`: the full `CustomerRow` encrypted with the active key.
 *
 * This is a pragmatic compromise per 03-storage-layer.md §6: we accept that
 * the indexed fields leak (mobile + group + name) in exchange for being
 * able to search the customer list without streaming every row through
 * AES-GCM. Tax id, email, address, and any loyalty data stay inside the
 * envelope.
 *
 * Encryption is transparent: components receive `CustomerRow` and write
 * `CustomerRow`. They never see `envelope`.
 */

import { assertWritable, db } from "../db";
import { TTL_CUSTOMERS_MS } from "../constants";
import { decrypt, encrypt, getActiveKey } from "../crypto";
import type {
	CustomerRow,
	EncryptedEnvelope,
	StoredCustomerRow,
} from "../types";

// ---------------------------------------------------------------------------
// Encryption boundary helpers (private).
// ---------------------------------------------------------------------------

/**
 * AAD for customer rows is the primary key (`name`). Binding the key into
 * the auth tag means swapping one customer's ciphertext onto another row
 * makes the auth tag fail — a GCM-level defence against integrity attacks
 * at the Dexie layer.
 */
function aadForName(name: string): string {
	return `customer:${name}`;
}

async function toStored(row: CustomerRow): Promise<StoredCustomerRow> {
	const { key, id } = getActiveKey();
	const envelope = await encrypt(row, key, id, aadForName(row.name));
	return {
		name: row.name,
		mobile_no: row.mobile_no,
		customer_group: row.customer_group,
		offline_created: row.offline_created,
		cached_at: row.cached_at,
		envelope,
	};
}

async function fromStored(
	stored: StoredCustomerRow,
): Promise<CustomerRow> {
	return decrypt<CustomerRow>(stored.envelope, aadForName(stored.name));
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function getCustomerByName(
	name: string,
): Promise<CustomerRow | undefined> {
	const stored = await db.customers.get(name);
	if (!stored) return undefined;
	return fromStored(stored);
}

export async function getCustomerByMobile(
	mobileNo: string,
): Promise<CustomerRow | undefined> {
	const stored = await db.customers
		.where("mobile_no")
		.equals(mobileNo)
		.first();
	if (!stored) return undefined;
	return fromStored(stored);
}

/**
 * Paged list for admin / picker use. Streams through decrypt so the caller
 * is expected to cap `limit` to something reasonable (we default to 50).
 */
export async function listCustomers(
	opts: { limit?: number; offset?: number } = {},
): Promise<CustomerRow[]> {
	const { limit = 50, offset = 0 } = opts;
	const stored = await db.customers
		.orderBy("name")
		.offset(offset)
		.limit(limit)
		.toArray();
	return Promise.all(stored.map(fromStored));
}

/**
 * Search by the indexed plaintext columns first (fast), then decrypt only
 * the candidates. This is the hot-path for the customer picker — if the
 * cashier types a mobile number prefix, we can narrow with the index
 * before touching crypto.
 */
export async function searchCustomers(
	query: string,
	limit = 25,
): Promise<CustomerRow[]> {
	if (!query) return listCustomers({ limit });
	// Try mobile-prefix first — fast + specific.
	const byMobile = await db.customers
		.where("mobile_no")
		.startsWith(query)
		.limit(limit)
		.toArray();
	if (byMobile.length > 0) {
		return Promise.all(byMobile.map(fromStored));
	}
	// Fall back to name-prefix.
	const byName = await db.customers
		.where("name")
		.startsWithIgnoreCase(query)
		.limit(limit)
		.toArray();
	return Promise.all(byName.map(fromStored));
}

export async function listOfflineCreated(): Promise<CustomerRow[]> {
	// `offline_created` is stored as boolean; Dexie indexes booleans but
	// querying `equals(true)` is brittle across browsers (IndexedDB spec
	// doesn't technically allow boolean keys). We use filter() which scans
	// — acceptable given the offline-created set is tiny.
	const stored = await db.customers
		.filter((row) => row.offline_created === true)
		.toArray();
	return Promise.all(stored.map(fromStored));
}

export async function countCustomers(): Promise<number> {
	return db.customers.count();
}

// ---------------------------------------------------------------------------
// Write helpers (cache hydration + offline-created).
//
// NOTE: enqueuing a customer-create to the outbox is Agent 3's job. This
// repo just persists the row locally. Agent 3 calls `putCustomer` and the
// outbox enqueue within the SAME `runInTransaction` so both commit atomically.
// ---------------------------------------------------------------------------

export async function putCustomer(row: CustomerRow): Promise<void> {
	assertWritable();
	const stored = await toStored(row);
	await db.customers.put(stored);
}

export async function bulkPutCustomers(rows: CustomerRow[]): Promise<void> {
	assertWritable();
	if (rows.length === 0) return;
	const stored = await Promise.all(rows.map(toStored));
	await db.customers.bulkPut(stored);
}

/**
 * Handles the server-side "customer was deleted" broadcast from D-28. We
 * drop the local row; Agent 3 is responsible for also purging any outbox
 * entries that referenced this customer.
 */
export async function deleteCustomer(name: string): Promise<void> {
	assertWritable();
	await db.customers.delete(name);
}

/**
 * Rename a locally-cached customer when its offline outbox entry syncs.
 *
 * Called from the sync event listener wired in Customer.vue: a customer
 * created offline lives in Dexie under its provisional `OFFLINE-CUST-...`
 * primary key. After sync, the server returns the real customer name (e.g.
 * `CUST-2026-001`). We delete-then-insert because:
 *   - Dexie primary keys are immutable (a put with a new key just creates
 *     a second row).
 *   - The encryption AAD is bound to `name` (`aadForName`); reusing the
 *     ciphertext under a new key would fail the auth tag on read.
 *
 * The whole operation runs in one rw transaction so the rename is atomic
 * — no window where neither row exists.
 */
export async function renameCustomer(
	oldName: string,
	newName: string,
): Promise<void> {
	assertWritable();
	if (oldName === newName) return;
	await db.transaction("rw", db.customers, async () => {
		const stored = await db.customers.get(oldName);
		if (!stored) return;
		const plain = await fromStored(stored);
		await db.customers.delete(oldName);
		const renamed = { ...plain, name: newName };
		const fresh = await toStored(renamed);
		await db.customers.put(fresh);
	});
}

// ---------------------------------------------------------------------------
// Freshness helpers
// ---------------------------------------------------------------------------

export async function isCustomerStale(name: string): Promise<boolean> {
	const row = await db.customers.get(name);
	if (!row) return true;
	return Date.now() - row.cached_at > TTL_CUSTOMERS_MS;
}

// ---------------------------------------------------------------------------
// Internal — exposed for tests only
// ---------------------------------------------------------------------------

/** @internal */
export const _internal = {
	toStored,
	fromStored,
	aadForName,
	// Direct envelope reader for corruption-recovery workflows that want
	// the ciphertext without attempting decrypt.
	getEnvelope: async (name: string): Promise<EncryptedEnvelope | null> => {
		const row = await db.customers.get(name);
		return row ? row.envelope : null;
	},
};
