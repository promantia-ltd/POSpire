/**
 * Repository tests (Agent 1).
 *
 * Spec coverage:
 *   - 03-storage-layer.md §3  (per-table schema + index shapes)
 *   - 03-storage-layer.md §4.3 (stale-while-revalidate TTLs)
 *   - 05-outbox-and-sync.md §4.2 (nextReady filters)
 *
 * Scope:
 *   - items repo: getById, barcode multi-entry index, stale TTL.
 *   - customers repo: offline_created filter, mobile_no search.
 *   - outbox repo: listReady excludes non-null blocked_reason and rows with
 *     `next_attempt_at` in the future.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/offline/db";
import {
	bulkPutItems,
	getItemByBarcode,
	getItemByCode,
	isStale,
	putItem,
} from "@/offline/repos/items";
import {
	bulkPutCustomers,
	getCustomerByMobile,
	getCustomerByName,
	listOfflineCreated,
	putCustomer,
} from "@/offline/repos/customers";
import { listReady, putOutboxEntry } from "@/offline/repos/outbox";
import { TTL_ITEMS_MS } from "@/offline/constants";
import { canonicalIntegrityHash } from "@/offline/crypto";
import type { ItemRow, CustomerRow, OutboxEntry } from "@/offline/types";

import {
	setupOfflineStorage,
	teardownOfflineStorage,
} from "../helpers/offline-fixture";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

beforeEach(async () => {
	await setupOfflineStorage();
});

afterEach(async () => {
	await teardownOfflineStorage();
});

function makeItem(overrides: Partial<ItemRow> = {}): ItemRow {
	return {
		item_code: "APPLE",
		item_name: "Apple",
		item_group: "Fruits",
		barcodes: ["1234567890123"],
		uom: "Nos",
		standard_rate: 1.5,
		last_known_qty_by_warehouse: { "Main WH": 10 },
		has_batch_no: false,
		has_serial_no: false,
		cached_at: Date.now(),
		price_list_prices: { Standard: 1.5 },
		...overrides,
	};
}

function makeCustomer(overrides: Partial<CustomerRow> = {}): CustomerRow {
	return {
		name: "CUST-001",
		customer_name: "Jane Doe",
		mobile_no: "+14155551234",
		tax_id: null,
		customer_group: "Retail",
		offline_created: false,
		offline_id: null,
		cached_at: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// items repo
// ---------------------------------------------------------------------------

describe("items repo", () => {
	it("getItemByCode returns the stored row", async () => {
		await putItem(makeItem());
		const row = await getItemByCode("APPLE");
		expect(row?.item_name).toBe("Apple");
	});

	it("getItemByBarcode uses the multi-entry index", async () => {
		await bulkPutItems([
			makeItem({ item_code: "A", barcodes: ["111", "222"] }),
			makeItem({ item_code: "B", barcodes: ["333"] }),
		]);
		const a = await getItemByBarcode("222");
		expect(a?.item_code).toBe("A");
		const b = await getItemByBarcode("333");
		expect(b?.item_code).toBe("B");
		const none = await getItemByBarcode("999");
		expect(none).toBeUndefined();
	});

	it("isStale returns true for rows whose cached_at is older than TTL_ITEMS_MS", async () => {
		const stale = makeItem({
			item_code: "OLD",
			cached_at: Date.now() - TTL_ITEMS_MS - 1,
		});
		const fresh = makeItem({ item_code: "NEW", cached_at: Date.now() });
		await bulkPutItems([stale, fresh]);

		expect(await isStale("OLD")).toBe(true);
		expect(await isStale("NEW")).toBe(false);
		// Missing row is treated as stale so the caller hydrates.
		expect(await isStale("MISSING")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// customers repo
// ---------------------------------------------------------------------------

describe("customers repo", () => {
	it("putCustomer + getCustomerByName round-trips through encryption transparently", async () => {
		const c = makeCustomer({ tax_id: "TAX-42" });
		await putCustomer(c);
		const got = await getCustomerByName(c.name);
		expect(got).toEqual(c);
	});

	it("getCustomerByMobile finds by the indexed plaintext column", async () => {
		await bulkPutCustomers([
			makeCustomer({ name: "C1", mobile_no: "+1111" }),
			makeCustomer({ name: "C2", mobile_no: "+2222" }),
		]);

		const r = await getCustomerByMobile("+2222");
		expect(r?.name).toBe("C2");
	});

	it("listOfflineCreated only returns rows with offline_created=true", async () => {
		await bulkPutCustomers([
			makeCustomer({ name: "SERVER-1", offline_created: false }),
			makeCustomer({
				name: "OFFLINE-CUST-abc",
				offline_created: true,
				offline_id: "abc",
			}),
		]);

		const offlineOnes = await listOfflineCreated();
		expect(offlineOnes).toHaveLength(1);
		expect(offlineOnes[0]?.name).toBe("OFFLINE-CUST-abc");
	});
});

// ---------------------------------------------------------------------------
// outbox repo — listReady
// ---------------------------------------------------------------------------

describe("outbox repo — listReady filters", () => {
	async function putEntry(
		overrides: Partial<OutboxEntry<Record<string, unknown>>>,
	): Promise<OutboxEntry<Record<string, unknown>>> {
		const base: OutboxEntry<Record<string, unknown>> = {
			offline_id: overrides.offline_id ?? crypto.randomUUID(),
			type: "invoice",
			parent_offline_ids: [],
			shift_offline_id: null,
			device_id: "d1",
			posting_date: "2026-01-01",
			owner_user: "test@example.com",
			payload: { hi: 1 },
			payload_integrity_hash: await canonicalIntegrityHash({ hi: 1 }),
			status: "enqueued",
			blocked_reason: null,
			attempt_count: 0,
			next_attempt_at: Date.now(),
			last_error_category: null,
			last_error_detail: null,
			server_doc_name: null,
			enqueued_at: Date.now(),
			synced_at: null,
			...overrides,
		};
		await putOutboxEntry(base);
		return base;
	}

	it("excludes rows whose blocked_reason is non-null", async () => {
		const ready = await putEntry({});
		await putEntry({ blocked_reason: "waiting_for_parent" });

		const list = await listReady();
		const ids = list.map((e) => e.offline_id);
		expect(ids).toContain(ready.offline_id);
		expect(ids).toHaveLength(1);
	});

	it("excludes rows whose next_attempt_at is in the future", async () => {
		const ready = await putEntry({ next_attempt_at: Date.now() - 1 });
		await putEntry({
			status: "retry_pending",
			next_attempt_at: Date.now() + 60_000,
		});

		const list = await listReady();
		const ids = list.map((e) => e.offline_id);
		expect(ids).toContain(ready.offline_id);
		expect(ids).toHaveLength(1);
	});

	it("excludes synced / needs_review / voided rows", async () => {
		const ready = await putEntry({});
		await putEntry({ status: "synced" });
		await putEntry({ status: "needs_review" });
		await putEntry({ status: "voided" });

		const list = await listReady();
		expect(list.map((e) => e.offline_id)).toEqual([ready.offline_id]);
	});

	it("includes retry_pending rows that are due", async () => {
		const retrying = await putEntry({
			status: "retry_pending",
			next_attempt_at: Date.now() - 1,
		});

		const list = await listReady();
		expect(list.map((e) => e.offline_id)).toContain(retrying.offline_id);
	});

	it("writes propagate a QuotaExceeded-like error instead of swallowing it (P-14)", async () => {
		// Simulate a Dexie put failure to prove putOutboxEntry re-throws.
		const originalPut = db.outbox.put.bind(db.outbox);
		const boom = new Error("simulated quota");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(db.outbox as any).put = async () => {
			throw boom;
		};
		try {
			await expect(
				putOutboxEntry({
					offline_id: crypto.randomUUID(),
					type: "invoice",
					parent_offline_ids: [],
					shift_offline_id: null,
					device_id: "d1",
					posting_date: "2026-01-01",
					owner_user: "u",
					payload: {},
					payload_integrity_hash: "",
					status: "enqueued",
					blocked_reason: null,
					attempt_count: 0,
					next_attempt_at: Date.now(),
					last_error_category: null,
					last_error_detail: null,
					server_doc_name: null,
					enqueued_at: Date.now(),
					synced_at: null,
				}),
			).rejects.toThrow(/simulated quota/);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(db.outbox as any).put = originalPut;
		}
	});
});
