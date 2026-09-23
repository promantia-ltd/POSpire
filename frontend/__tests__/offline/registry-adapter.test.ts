/**
 * Registry-adapter tests.
 *
 * Each offline-capable write entry in `call-registry` carries a
 * `toOfflinePayload(args, ctx)` adapter that translates the UI's argument
 * shape into the offline endpoint's `(data, offline_id, device_id, …)`
 * contract. These tests exercise the three Phase 1 adapters directly.
 */

import { describe, expect, it } from "vitest";

import { methodRegistry } from "@/utils/call-registry";
import type { WriteMethodConfig } from "@/utils/call-registry";

const CTX = { offlineId: "11111111-2222-4333-8444-555555555555", deviceId: "DEV-XYZ" };

function getWrite(method: string): WriteMethodConfig {
	const entry = methodRegistry[method];
	if (!entry || entry.intent !== "write") {
		throw new Error(`Expected ${method} to be a write entry`);
	}
	return entry;
}

describe("registry adapter — submit_invoice", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.submit_invoice");

	it("is offline-capable with outboxType=invoice and an adapter", () => {
		expect(cfg.offline).toBe(true);
		expect(cfg.outboxType).toBe("invoice");
		expect(cfg.toOfflinePayload).toBeTypeOf("function");
	});

	it("places payment metadata under posa_submit_data — NOT merged into invoice fields", () => {
		const result = cfg.toOfflinePayload!(
			{
				data: { credit_change: -5, is_cashback: 1, redeemed_customer_credit: 0 },
				invoice: {
					doctype: "Sales Invoice",
					customer: "POS Customer",
					pos_opening_shift_offline_id: "shift-42",
					pos_material_receipt_offline_ids: ["mr-1", "mr-2"],
					posting_date: "2026-04-25",
					owner: "cashier@example.com",
				},
			},
			CTX,
		);

		expect(result.method).toBe("pospire.pospire.api.offline.submit_invoice");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);
		expect(result.payload.opening_entry_offline_id).toBe("shift-42");
		expect(result.payload.material_receipt_offline_ids).toEqual(["mr-1", "mr-2"]);
		expect(result.payload).not.toHaveProperty("invoice");

		// offline.submit_invoice (offline.py:568) extracts payment metadata from
		// payload.posa_submit_data and passes it as the second arg to
		// posapp.submit_invoice. If we merged it into invoice fields it would
		// be lost — that branch in posapp (credit_change / is_cashback / etc.)
		// would never fire.
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.doctype).toBe("Sales Invoice");
		expect(parsed.customer).toBe("POS Customer");
		// Payment metadata lives under posa_submit_data, separately:
		expect(parsed.posa_submit_data).toEqual({
			credit_change: -5,
			is_cashback: 1,
			redeemed_customer_credit: 0,
		});
		// And NOT scattered into the top-level invoice fields:
		expect(parsed).not.toHaveProperty("credit_change");
		expect(parsed).not.toHaveProperty("is_cashback");
		// posting_date / owner_user are inside the inner data so
		// _apply_payload_metadata sees them (P-5, P-11).
		expect(parsed.posting_date).toBe("2026-04-25");
		expect(parsed.owner_user).toBe("cashier@example.com");
	});

	it("defaults posting_date to today and owner_user to the cashier when missing", () => {
		const result = cfg.toOfflinePayload!(
			{ data: {}, invoice: { doctype: "Sales Invoice" } },
			CTX,
		);
		const parsed = JSON.parse(result.payload.data as string);
		// YYYY-MM-DD format from todayIso()
		expect(parsed.posting_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(typeof parsed.owner_user).toBe("string");
		expect(parsed.owner_user.length).toBeGreaterThan(0);
	});

	it("rejects offline adaptation for sales returns (deferred to later phase)", () => {
		expect(() =>
			cfg.toOfflinePayload!(
				{
					data: {},
					invoice: {
						doctype: "Sales Invoice",
						is_return: 1,
						return_against: "SINV-0001",
					},
				},
				CTX,
			),
		).toThrow("Sales Return offline enqueue is disabled");
	});

	it("forwards customer_offline_id into inner data AND adds it to parentOfflineIds", () => {
		// When an invoice references a customer that was created offline in
		// the same shift, the server-side `_resolve_customer_by_offline_id`
		// (offline.py:443) rewrites the customer link to the real name once
		// the customer outbox row syncs — but only if `customer_offline_id`
		// is present in the inner data.
		const customerOffId = "aaaaaaaa-1111-4222-8333-444444444444";
		const result = cfg.toOfflinePayload!(
			{
				data: {},
				invoice: {
					doctype: "Sales Invoice",
					customer: "OFFLINE-CUST-aaaaaaaa",
					customer_offline_id: customerOffId,
				},
			},
			CTX,
		);
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.customer_offline_id).toBe(customerOffId);
		// And added to parentOfflineIds so the scheduler waits for the
		// customer outbox row to sync first (dependency ordering).
		expect(result.parentOfflineIds).toContain(customerOffId);
	});

	it("produces dependency metadata for the outbox (parents + shift + posting + owner)", () => {
		const result = cfg.toOfflinePayload!(
			{
				data: {},
				invoice: {
					pos_opening_shift_offline_id: "shift-42",
					// The opening is a local parent only while it is itself
					// queued; an online-opened shift has an id but no row.
					pos_opening_shift_pending_sync: true,
					pos_material_receipt_offline_ids: ["mr-1"],
					posting_date: "2026-04-25",
					owner: "cashier@example.com",
				},
			},
			CTX,
		);

		expect(result.shiftOfflineId).toBe("shift-42");
		expect(result.parentOfflineIds).toEqual(["mr-1", "shift-42"]);
		expect(result.postingDate).toBe("2026-04-25");
		expect(result.ownerUser).toBe("cashier@example.com");
	});

	it("handles missing dependency fields gracefully and supplies defaults", () => {
		const result = cfg.toOfflinePayload!({ data: {}, invoice: {} }, CTX);
		expect(result.shiftOfflineId).toBeNull();
		expect(result.parentOfflineIds).toEqual([]);
		// posting_date / owner_user are REQUIRED by the server, so the adapter
		// supplies defaults — they are never left undefined.
		expect(result.postingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(typeof result.ownerUser).toBe("string");
		expect(result.ownerUser!.length).toBeGreaterThan(0);
	});
});

describe("registry adapter — create_opening_voucher (F2 — offline-capable)", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.create_opening_voucher");

	it("is offline-capable and routes to offline.create_opening_entry", () => {
		expect(cfg.offline).toBe(true);
		expect(cfg.outboxType).toBe("opening_entry");
	});

	it("builds a POS Opening Shift doc with snapshotted balance + denominations", () => {
		const result = cfg.toOfflinePayload!(
			{
				pos_profile: "Retail Store Profile 1",
				company: "YT Company",
				balance_details: [
					{ mode_of_payment: "Cash", amount: 100, currency: "BND" },
				],
				denomination_details: JSON.stringify([
					{ denomination: "100", quantity: 1, denomination_value: 100 },
				]),
			},
			CTX,
		);
		expect(result.method).toBe(
			"pospire.pospire.api.offline.create_opening_entry",
		);
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);

		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.doctype).toBe("POS Opening Shift");
		expect(parsed.pos_profile).toBe("Retail Store Profile 1");
		expect(parsed.company).toBe("YT Company");
		// P-5 attribution
		expect(parsed.owner_user).toBeDefined();
		// P-11 posting_date snapshot
		expect(parsed.posting_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(Array.isArray(parsed.balance_details)).toBe(true);
		expect(Array.isArray(parsed.denomination_details)).toBe(true);
	});
});

describe("registry adapter — create_customer", () => {
	const cfg = getWrite("pospire.pospire.api.posapp.create_customer");

	it("constructs a Customer doc with required owner_user and only-supplied optional fields", () => {
		const result = cfg.toOfflinePayload!(
			{
				customer_name: "Alice",
				mobile_no: "555-0100",
				method: "create",
				company: "POSpire",
				email_id: "",
			},
			CTX,
		);
		expect(result.method).toBe("pospire.pospire.api.offline.create_customer");
		expect(result.payload.offline_id).toBe(CTX.offlineId);
		expect(result.payload.device_id).toBe(CTX.deviceId);

		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.doctype).toBe("Customer");
		expect(parsed.customer_name).toBe("Alice");
		expect(parsed.mobile_no).toBe("555-0100");
		expect(parsed.posa_referral_company).toBe("POSpire");
		// owner_user required by offline.create_customer (P-5).
		expect(typeof parsed.owner_user).toBe("string");
		expect(parsed.owner_user.length).toBeGreaterThan(0);
		// Empty-string optional fields are NOT serialised (don't override
		// doctype defaults with "").
		expect(parsed).not.toHaveProperty("email_id");

		expect(result.ownerUser).toBe(parsed.owner_user);
	});

	it("maps UI `birthday` to the live API's `posa_birthday` field", () => {
		// posapp.create_customer stores the field as posa_birthday (posapp.py:1369);
		// without the rename, offline-created customers would lose the field.
		const result = cfg.toOfflinePayload!(
			{ customer_name: "Bob", birthday: "1990-04-25" },
			CTX,
		);
		const parsed = JSON.parse(result.payload.data as string);
		expect(parsed.posa_birthday).toBe("1990-04-25");
		expect(parsed).not.toHaveProperty("birthday");
	});
});

describe("registry adapter — submit_closing_shift (F3 + H1)", () => {
	const cfg = getWrite(
		"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift",
	);

	it("is offline-capable and routes to offline.create_closing_entry", () => {
		expect(cfg.offline).toBe(true);
		expect(cfg.outboxType).toBe("closing_entry");
	});

	it("H1 — sends opening_entry_ref (UUID for offline-opened shift)", () => {
		const result = cfg.toOfflinePayload!(
			{
				closing_shift: {
					pos_opening_shift: "OFFLINE-OPN-abcdefgh",
					pos_opening_shift_offline_id: "5d31a9f4-6da6-4a99-9b3e-5c5f4a4f5c84",
					invoice_offline_ids: [
						"d7f2c842-1234-4abc-9def-0123456789ab",
					],
					pos_profile: "Retail Store Profile 1",
					company: "YT Company",
					payment_reconciliation: [],
					denomination_details: [],
					pos_transactions: [],
				},
			},
			CTX,
		);
		expect(result.method).toBe(
			"pospire.pospire.api.offline.create_closing_entry",
		);
		// H1 — single flexible param replaces opening_entry_offline_id.
		expect(result.payload.opening_entry_ref).toBe(
			"5d31a9f4-6da6-4a99-9b3e-5c5f4a4f5c84",
		);
	});

	it("H1 — sends real shift name when opened online (no offline_id)", () => {
		const result = cfg.toOfflinePayload!(
			{
				closing_shift: {
					pos_opening_shift: "POSA-OS-26-0000030",
					// No pos_opening_shift_offline_id — shift was opened online.
					invoice_offline_ids: [],
					pos_profile: "Retail Store Profile 1",
					company: "YT Company",
					payment_reconciliation: [],
					denomination_details: [],
					pos_transactions: [],
				},
			},
			CTX,
		);
		// Falls back to the real shift name; server's
		// _resolve_opening_shift_flexible disambiguates.
		expect(result.payload.opening_entry_ref).toBe("POSA-OS-26-0000030");
	});
});

describe("registry — kill switch", () => {
	it("is_offline_enabled is registered for cashier-callable polling (H1 fix)", () => {
		const cfg =
			methodRegistry["pospire.pospire.api.offline.is_offline_enabled"];
		expect(cfg).toBeDefined();
		expect(cfg!.intent).toBe("read");
		expect(cfg!.offline).toBe(false);
	});
});

describe("registry hygiene", () => {
	it("every offline-capable write has an outboxType AND a toOfflinePayload adapter", () => {
		// `offline.*` entries are scheduler-replay-only and registered as
		// `offline: false` so a stray non-bypass call fails fast (T5). The
		// loop's `if (!cfg.offline) continue` already skips them; no name-based
		// exception needed.
		for (const [name, cfg] of Object.entries(methodRegistry)) {
			if (cfg.intent !== "write") continue;
			if (!cfg.offline) continue;
			expect(cfg.outboxType, `${name} missing outboxType`).toBeTruthy();
			expect(
				cfg.toOfflinePayload,
				`${name} missing toOfflinePayload`,
			).toBeTypeOf("function");
		}
	});
});
