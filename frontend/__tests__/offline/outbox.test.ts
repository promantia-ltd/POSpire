/**
 * Outbox unit + integration tests (Agent 3).
 *
 * Spec coverage:
 *   - 05-outbox-and-sync.md §2  (atomic enqueue, P-14)
 *   - 05-outbox-and-sync.md §3  (dependency graph)
 *   - 05-outbox-and-sync.md §4.2 (compare-and-swap claim)
 *   - 05-outbox-and-sync.md §6  (void is a business action; row stays)
 *   - 01-architecture-principles.md P-7 (dependency ordering)
 *   - 01-architecture-principles.md P-8 (strict closure)
 *   - 01-architecture-principles.md P-14 (errors surface)
 *
 * These tests hit a real (fake-indexeddb) Dexie database through the
 * production outbox module so the transaction + encryption paths are
 * exercised end-to-end. One test also mocks the repo layer to prove the
 * enqueue path rethrows persistence failures without swallowing.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	enqueue,
	evaluateClosingReadiness,
	evaluateParents,
	markHandedOff,
	markInFlight,
	markSynced,
	markNeedsReview,
	markVacuumed,
	nextReady,
	onSynced,
	resetForRetry,
	scheduleRetry,
	voidEntry,
	getEntry,
	listByStatus,
	MAX_ATTEMPTS,
} from "@/offline/outbox";
import { db } from "@/offline/db";

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
	vi.restoreAllMocks();
	await teardownOfflineStorage();
});

// ---------------------------------------------------------------------------
// Atomic enqueue (P-14)
// ---------------------------------------------------------------------------

describe("enqueue atomicity", () => {
	it("persists a new outbox row and returns an ack with the offline_id", async () => {
		const ack = await enqueue("invoice", {
			customer: "CUST-1",
			total: 100,
		});

		expect(ack.offline).toBe(true);
		expect(ack.status).toBe("enqueued");
		expect(ack.offline_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(ack.provisional_name).toMatch(/^OFFLINE-INV-/);

		const stored = await db.outbox.get(ack.offline_id);
		expect(stored).toBeDefined();
		expect(stored?.status).toBe("enqueued");
		// next_attempt_at MUST be stamped or listReady won't see the row (Dexie
		// doesn't index null).
		expect(stored?.next_attempt_at).not.toBeNull();
	});

	it("rethrows persistence failures (never silent drop)", async () => {
		// Mock the Dexie transaction method so any write inside enqueue
		// rejects. We must see the rejection escape enqueue().
		const boom = new Error("simulated quota exceeded");
		const spy = vi
			.spyOn(db, "transaction")
			.mockImplementation(() => Promise.reject(boom) as never);

		await expect(
			enqueue("invoice", { customer: "CUST-1", total: 100 }),
		).rejects.toThrow(/simulated quota exceeded/);

		spy.mockRestore();

		// After restoring, the row should NOT exist — enqueue correctly
		// aborted instead of writing something partial.
		const rows = await db.outbox.toArray();
		expect(rows).toHaveLength(0);
	});

	it("rejects invalid outbox types", async () => {
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			enqueue("not_a_type" as any, {}),
		).rejects.toThrow(/invalid outbox type/);
	});
});

// ---------------------------------------------------------------------------
// State transitions: happy path
// ---------------------------------------------------------------------------

describe("state transitions — happy path", () => {
	it("enqueued → in_flight → synced", async () => {
		const ack = await enqueue("invoice", { total: 50 });

		const before = await db.outbox.get(ack.offline_id);
		expect(before?.status).toBe("enqueued");

		const claimed = await markInFlight(ack.offline_id);
		expect(claimed).toBe(true);

		const midway = await db.outbox.get(ack.offline_id);
		expect(midway?.status).toBe("in_flight");

		await markSynced(ack.offline_id, "SI-00001");

		const final = await db.outbox.get(ack.offline_id);
		expect(final?.status).toBe("synced");
		expect(final?.server_doc_name).toBe("SI-00001");
		expect(final?.synced_at).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Retry path → needs_review after MAX_ATTEMPTS (8)
// ---------------------------------------------------------------------------

describe("state transitions — retry path", () => {
	it("moves to needs_review with retry_exhausted after MAX_ATTEMPTS transient failures", async () => {
		const ack = await enqueue("invoice", { total: 10 });

		// Simulate MAX_ATTEMPTS-1 retries: row stays retry_pending.
		for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
			await scheduleRetry(ack.offline_id, i + 1, "network_error", null);
			const row = await db.outbox.get(ack.offline_id);
			expect(row?.status).toBe("retry_pending");
			expect(row?.attempt_count).toBe(i + 1);
		}

		// One more transient failure = attempt reaches MAX_ATTEMPTS → needs_review.
		await scheduleRetry(ack.offline_id, MAX_ATTEMPTS, "network_error", null);

		const final = await db.outbox.get(ack.offline_id);
		expect(final?.status).toBe("needs_review");
		expect(final?.last_error_category).toBe("retry_exhausted");
		// Frozen: next_attempt_at cleared so the scheduler stops picking it up.
		expect(final?.next_attempt_at).toBeNull();
	});

	it("markNeedsReview with a terminal category transitions + freezes retries", async () => {
		const ack = await enqueue("invoice", { total: 10 });
		await markNeedsReview(ack.offline_id, "validation_error", "missing customer");

		const row = await db.outbox.get(ack.offline_id);
		expect(row?.status).toBe("needs_review");
		expect(row?.last_error_category).toBe("validation_error");
		expect(row?.next_attempt_at).toBeNull();
	});

	it("refuses to mark transient categories as needs_review (guard against caller misuse)", async () => {
		const ack = await enqueue("invoice", { total: 10 });
		await expect(
			markNeedsReview(ack.offline_id, "network_error" as never, null),
		).rejects.toThrow(/non-terminal/);
	});
});

// ---------------------------------------------------------------------------
// Dependency blocking (P-7)
// ---------------------------------------------------------------------------

describe("dependency blocking (P-7)", () => {
	it("invoice with parent MR is 'waiting' until MR is synced", async () => {
		const mr = await enqueue("material_receipt", { item: "X", qty: 5 });
		const inv = await enqueue("invoice", { item: "X", qty: 1 }, {
			parentOfflineIds: [mr.offline_id],
		});

		const invEntry = await getEntry(inv.offline_id);
		expect(invEntry).toBeDefined();

		// Parent still enqueued → child is waiting.
		let gate = await evaluateParents(invEntry!);
		expect(gate).toBe("waiting");

		// Move parent through lifecycle.
		await markInFlight(mr.offline_id);
		const invWaiting = await getEntry(inv.offline_id);
		gate = await evaluateParents(invWaiting!);
		expect(gate).toBe("waiting");

		// Synced → child is ready.
		await markSynced(mr.offline_id, "STE-001");
		const invReady = await getEntry(inv.offline_id);
		gate = await evaluateParents(invReady!);
		expect(gate).toBe("ready");
	});

	it("invoice with parent in needs_review is 'blocked' (not 'waiting')", async () => {
		const mr = await enqueue("material_receipt", { item: "X", qty: 5 });
		const inv = await enqueue("invoice", { item: "X", qty: 1 }, {
			parentOfflineIds: [mr.offline_id],
		});

		await markNeedsReview(mr.offline_id, "validation_error", "bad batch");

		const entry = await getEntry(inv.offline_id);
		const gate = await evaluateParents(entry!);
		expect(gate).toBe("blocked");
	});
});

// ---------------------------------------------------------------------------
// Strict closure (P-8)
// ---------------------------------------------------------------------------

describe("strict closure (P-8)", () => {
	it("closing_entry stays blocked while any sibling invoice is unsynced", async () => {
		const shiftId = "SHIFT-A";

		const inv1 = await enqueue("invoice", { i: 1 }, { shiftOfflineId: shiftId });
		const inv2 = await enqueue("invoice", { i: 2 }, { shiftOfflineId: shiftId });
		const close = await enqueue("closing_entry", { total: 999 }, {
			shiftOfflineId: shiftId,
		});

		const closeEntry = await getEntry(close.offline_id);

		// Siblings enqueued → closure waits.
		let gate = await evaluateClosingReadiness(closeEntry!);
		expect(gate).toBe("waiting");

		// First invoice syncs, second still enqueued → still waiting.
		await markSynced(inv1.offline_id, "SI-001");
		gate = await evaluateClosingReadiness(closeEntry!);
		expect(gate).toBe("waiting");

		// Second invoice lands in needs_review → closing is blocked (not waiting)
		// because manager action is required.
		await markNeedsReview(inv2.offline_id, "validation_error", "tax error");
		gate = await evaluateClosingReadiness(closeEntry!);
		expect(gate).toBe("blocked");

		// Manager unblocks inv2 (synced) → closing is ready.
		await markSynced(inv2.offline_id, "SI-002");
		gate = await evaluateClosingReadiness(closeEntry!);
		expect(gate).toBe("ready");
	});

	it("voided sibling invoices do not block closure", async () => {
		const shiftId = "SHIFT-B";
		const inv = await enqueue("invoice", { i: 1 }, { shiftOfflineId: shiftId });
		const close = await enqueue("closing_entry", { total: 0 }, {
			shiftOfflineId: shiftId,
		});

		await voidEntry(inv.offline_id, "customer left");

		const closeEntry = await getEntry(close.offline_id);
		const gate = await evaluateClosingReadiness(closeEntry!);
		expect(gate).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// Compare-and-swap claim (concurrent drain across tabs)
// ---------------------------------------------------------------------------

describe("compare-and-swap claim", () => {
	it("only one of two concurrent markInFlight() calls wins", async () => {
		const ack = await enqueue("invoice", { total: 1 });

		const [a, b] = await Promise.all([
			markInFlight(ack.offline_id),
			markInFlight(ack.offline_id),
		]);

		// Exactly one succeeds. (Dexie transactions serialise, so the second
		// one sees status='in_flight' and returns false.)
		expect([a, b].filter(Boolean)).toHaveLength(1);

		const final = await db.outbox.get(ack.offline_id);
		expect(final?.status).toBe("in_flight");
	});

	it("refuses to claim a needs_review row", async () => {
		const ack = await enqueue("invoice", { total: 1 });
		await markNeedsReview(ack.offline_id, "validation_error", "nope");

		const claimed = await markInFlight(ack.offline_id);
		expect(claimed).toBe(false);
	});

	it("refuses to claim a blocked row", async () => {
		const mr = await enqueue("material_receipt", { i: 1 });
		const inv = await enqueue("invoice", { i: 1 }, {
			parentOfflineIds: [mr.offline_id],
		});

		// Manually mark as blocked (the scheduler would do this via markBlocked).
		const stored = await db.outbox.get(inv.offline_id);
		await db.outbox.put({ ...stored!, blocked_reason: "waiting_for_parent" });

		const claimed = await markInFlight(inv.offline_id);
		expect(claimed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Void — row STAYS (never delete)
// ---------------------------------------------------------------------------

describe("void", () => {
	it("keeps the row with status=voided (never deletes)", async () => {
		const ack = await enqueue("invoice", { total: 42 });

		await voidEntry(ack.offline_id, "cashier cancelled");

		const row = await db.outbox.get(ack.offline_id);
		expect(row).toBeDefined(); // NOT deleted
		expect(row?.status).toBe("voided");
		expect(row?.last_error_detail).toBe("cashier cancelled");

		// listByStatus surfaces it.
		const voided = await listByStatus("voided");
		expect(voided.map((r) => r.offline_id)).toContain(ack.offline_id);
	});

	it("refuses to void an already-synced row (must use a reversal)", async () => {
		const ack = await enqueue("invoice", { total: 10 });
		await markInFlight(ack.offline_id);
		await markSynced(ack.offline_id, "SI-999");

		await expect(voidEntry(ack.offline_id, "oops")).rejects.toThrow(
			/already synced/,
		);
	});

	it("markSynced does NOT overwrite a voided row's status (T4 voided-race)", async () => {
		const ack = await enqueue("invoice", { total: 10 });
		await markInFlight(ack.offline_id);
		await voidEntry(ack.offline_id, "manager cancelled mid-flight");

		// Scheduler tries to mark synced AFTER void won the race.
		await markSynced(ack.offline_id, "SI-1234");

		const row = await db.outbox.get(ack.offline_id);
		expect(row?.status).toBe("voided");
		// Server-doc-name is still recorded for audit trail.
		expect(row?.server_doc_name).toBe("SI-1234");
	});
});

// ---------------------------------------------------------------------------
// Cascade-unblock dependents (T7)
// ---------------------------------------------------------------------------

describe("cascade-unblock dependents", () => {
	it("clears blocked_reason on dependents when their parent is markSynced", async () => {
		const customer = await enqueue("customer", { customer_name: "X" });
		const inv = await enqueue(
			"invoice",
			{ customer: "X" },
			{ parentOfflineIds: [customer.offline_id] },
		);

		// Simulate the scheduler having parked the invoice as blocked.
		const invRow = await db.outbox.get(inv.offline_id);
		await db.outbox.put({
			...invRow!,
			blocked_reason: "waiting_for_parent",
		});

		// Parent succeeds → invoice should be unblocked.
		await markInFlight(customer.offline_id);
		await markSynced(customer.offline_id, "CUST-1");

		const after = await db.outbox.get(inv.offline_id);
		expect(after?.blocked_reason).toBe(null);
	});

	it("clears blocked_reason on dependents when their parent is resetForRetry", async () => {
		const customer = await enqueue("customer", { customer_name: "Y" });
		const inv = await enqueue(
			"invoice",
			{ customer: "Y" },
			{ parentOfflineIds: [customer.offline_id] },
		);

		// Customer hits needs_review (e.g. stock_shortage on a different
		// dependent, or a parent of its own — doesn't matter for this test)
		// then user retries it. Park the invoice as blocked.
		const invRow = await db.outbox.get(inv.offline_id);
		await db.outbox.put({
			...invRow!,
			blocked_reason: "waiting_for_parent",
		});

		await resetForRetry(customer.offline_id);

		const after = await db.outbox.get(inv.offline_id);
		expect(after?.blocked_reason).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// nextReady picks the oldest ready row and skips blocked / future ones
// ---------------------------------------------------------------------------

describe("nextReady", () => {
	it("returns null when the outbox is empty", async () => {
		const entry = await nextReady();
		expect(entry).toBeNull();
	});

	it("returns an enqueued row when one exists", async () => {
		const ack = await enqueue("invoice", { total: 5 });
		const entry = await nextReady();
		expect(entry?.offline_id).toBe(ack.offline_id);
	});

	it("skips rows with next_attempt_at in the future", async () => {
		const ack = await enqueue("invoice", { total: 5 });

		// Push next_attempt_at 1 minute into the future (simulating a
		// backoff-pending row).
		const stored = await db.outbox.get(ack.offline_id);
		await db.outbox.put({
			...stored!,
			status: "retry_pending",
			next_attempt_at: Date.now() + 60_000,
		});

		const entry = await nextReady();
		expect(entry).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// markVacuumed — vacuum tombstone transitions + notifySynced
// ---------------------------------------------------------------------------

describe("markVacuumed", () => {
	it("Resolved: transitions handed_off → synced and stamps synced_at", async () => {
		const ack = await enqueue("customer", { customer_name: "Offline Corp" });
		await markNeedsReview(ack.offline_id, "validation_error", "bad data");
		await markHandedOff(ack.offline_id, "RECOVERY-001");

		await markVacuumed(ack.offline_id, "Resolved", "CUST-42");

		const row = await db.outbox.get(ack.offline_id);
		expect(row?.status).toBe("synced");
		expect(row?.server_doc_name).toBe("CUST-42");
		expect(row?.synced_at).not.toBeNull();
	});

	it("Voided: transitions handed_off → voided and leaves synced_at null", async () => {
		const ack = await enqueue("customer", { customer_name: "Bad Corp" });
		await markNeedsReview(ack.offline_id, "validation_error", "bad data");
		await markHandedOff(ack.offline_id, "RECOVERY-002");

		await markVacuumed(ack.offline_id, "Voided", null);

		const row = await db.outbox.get(ack.offline_id);
		expect(row?.status).toBe("voided");
		expect(row?.synced_at).toBeNull();
	});

	it("Resolved: fires notifySynced so cart listeners rename provisional → server name", async () => {
		const ack = await enqueue("customer", { customer_name: "Notify Corp" });
		await markNeedsReview(ack.offline_id, "validation_error", "bad data");
		await markHandedOff(ack.offline_id, "RECOVERY-003");

		const received: Array<{ offline_id: string; server_doc_name: string }> = [];
		const unsub = onSynced((evt) => received.push(evt));
		try {
			await markVacuumed(ack.offline_id, "Resolved", "CUST-99");
		} finally {
			unsub();
		}

		expect(received).toHaveLength(1);
		expect(received[0].offline_id).toBe(ack.offline_id);
		expect(received[0].server_doc_name).toBe("CUST-99");
		expect(received[0].provisional_name).toMatch(/^OFFLINE-CUST-/);
	});

	it("Voided: does NOT fire notifySynced", async () => {
		const ack = await enqueue("customer", { customer_name: "Silent Corp" });
		await markNeedsReview(ack.offline_id, "validation_error", "bad data");
		await markHandedOff(ack.offline_id, "RECOVERY-004");

		const received: unknown[] = [];
		const unsub = onSynced((evt) => received.push(evt));
		try {
			await markVacuumed(ack.offline_id, "Voided", null);
		} finally {
			unsub();
		}

		expect(received).toHaveLength(0);
	});

	it("Resolved: cascade-unblocks dependent invoice rows", async () => {
		const customer = await enqueue("customer", { customer_name: "Parent Corp" });
		const inv = await enqueue(
			"invoice",
			{ customer: "Parent Corp" },
			{ parentOfflineIds: [customer.offline_id] },
		);

		// Park invoice as blocked on the customer.
		const invRow = await db.outbox.get(inv.offline_id);
		await db.outbox.put({ ...invRow!, blocked_reason: "waiting_for_parent" });

		// Customer escalated to recovery.
		await markNeedsReview(customer.offline_id, "validation_error", "bad payload");
		await markHandedOff(customer.offline_id, "RECOVERY-005");

		// Manager resolves it via recovery UI.
		await markVacuumed(customer.offline_id, "Resolved", "CUST-77");

		const after = await db.outbox.get(inv.offline_id);
		expect(after?.blocked_reason).toBe(null);
	});

	it("Resolved: is idempotent (second call is a no-op)", async () => {
		const ack = await enqueue("customer", { customer_name: "Idempotent Corp" });
		await markNeedsReview(ack.offline_id, "validation_error", "bad data");
		await markHandedOff(ack.offline_id, "RECOVERY-006");

		await markVacuumed(ack.offline_id, "Resolved", "CUST-11");
		// Second call: row is already synced; updateSchedulerFields preserves status.
		await markVacuumed(ack.offline_id, "Resolved", "CUST-11");

		const row = await db.outbox.get(ack.offline_id);
		expect(row?.status).toBe("synced");
	});
});
