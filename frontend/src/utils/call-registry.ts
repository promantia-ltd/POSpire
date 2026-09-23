/**
 * Method registry for `@/utils/call`.
 *
 * Every Frappe-whitelisted method the SPA calls MUST be listed here. Calling
 * `call({ method })` with a method not in this registry throws
 * `UnregisteredMethod`. This forces every new network call site to be an
 * explicit policy decision (see 09-api-boundary.md §3).
 *
 * Do NOT introduce a default policy. See §3.1 of the spec for why.
 */

import { currentCashier } from "@/offline/cashier";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MethodIntent = "read" | "write";

export interface ReadMethodConfig {
	intent: "read";
	/** True if the read is served from cache when offline. */
	offline: boolean;
	/** Cache TTL in ms when `offline: true`. Ignored when `offline: false`. */
	cacheTTLMs?: number;
}

/**
 * Result of a registry's `toOfflinePayload` transform. The shape mirrors what
 * the offline server endpoint expects (offline.py:478 etc.) plus optional
 * dependency metadata that the outbox uses for ordering.
 */
export interface OfflinePayloadAdapterResult {
	/** Method to POST when the scheduler drains this entry. Should resolve
	 * to a `pospire.pospire.api.offline.*` endpoint (or another whitelisted
	 * idempotent endpoint). */
	method: string;
	/** Server-shaped payload (typically `{data, offline_id, device_id, ...}`). */
	payload: Record<string, unknown>;
	/** Outbox-side dependency metadata. */
	parentOfflineIds?: string[];
	shiftOfflineId?: string | null;
	postingDate?: string;
	ownerUser?: string;
}

/**
 * Adapter function — transforms the live UI args into the shape the offline
 * endpoint expects. Invoked by `call.ts::enqueueWrite` only when an entry is
 * about to be enqueued (offline OR network_error). The supplied `ctx` carries
 * the generated `offline_id` and the device's `device_id`.
 */
export type ToOfflinePayload = (
	args: Record<string, unknown>,
	ctx: { offlineId: string; deviceId: string | null },
) => OfflinePayloadAdapterResult;

export interface WriteMethodConfig {
	intent: "write";
	/** True if the write is enqueueable in the outbox when offline. */
	offline: boolean;
	/** Outbox type bucket (invoice, material_receipt, …). Required when
	 * `offline: true`; ignored when `offline: false`. */
	outboxType?: string;
	/**
	 * REQUIRED when `offline: true`. Translates the UI's argument shape into
	 * the offline endpoint's `(data, offline_id, device_id, ...)` contract,
	 * AND returns the offline method name to POST during sync. Without this,
	 * the live live-method's payload would be sent to the offline endpoint
	 * and rejected (F5).
	 */
	toOfflinePayload?: ToOfflinePayload;
}

export type MethodConfig = ReadMethodConfig | WriteMethodConfig;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `call()` receives a `method` not present in the registry.
 * Always a developer error — either add an entry, or the call site is wrong.
 */
export class UnregisteredMethod extends Error {
	readonly method: string;
	constructor(method: string) {
		super(
			`Method "${method}" is not registered in @/utils/call-registry. ` +
				"Add an explicit entry with intent + offline policy; do not default.",
		);
		this.name = "UnregisteredMethod";
		this.method = method;
	}
}

/**
 * Thrown when a Sales Return would be enqueued offline.
 *
 * Returns remain live-only in the current rollout because the client does not
 * yet maintain a durable offline index for "return against" lookup across
 * historical invoices.
 */
export class OfflineReturnDeferredError extends Error {
	constructor() {
		super(
			"Sales Return offline enqueue is disabled for this phase. Reconnect and retry the return.",
		);
		this.name = "OfflineReturnDeferredError";
	}
}

// ---------------------------------------------------------------------------
// Helpers used by adapters to satisfy server-side P-5 / P-11 invariants
// (offline.py::_apply_payload_metadata requires posting_date + owner_user
// inside the inner `data` JSON for every queued write).
// ---------------------------------------------------------------------------

/** Today's date in YYYY-MM-DD (local). Server treats it as the queued
 *  posting_date snapshot per P-11. */
function todayIso(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// Cashier-user resolution is shared with the outbox via @/offline/cashier.
// The previous local `currentCashier()` here returned "Guest" whenever the
// /pospire/pos route was open without the Desk shell injecting
// `frappe.session.user`. Adapters pre-stamped that "Guest" into the
// payload via `options.ownerUser`, which short-circuited outbox.ts's safer
// cookie fallback and got every offline write rejected by the server's
// `_apply_payload_metadata` validator. One source of truth closes the gap.

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/** Stable cache key for `get_opening_dialog_data`. Must match DURABLE_KEYS. */
export const OPENING_DIALOG_CACHE_KEY = "offline.opening_dialog_data";

/** Per-profile durable key for the offline tax config. Must match the prefix
 *  allowlisted in read-cache.ts DURABLE_KEY_PREFIXES. Append the POS Profile
 *  name so switching profiles cannot serve the previous profile's rates. */
export const TAX_CONFIG_CACHE_KEY_PREFIX = "offline.tax_config:";

/**
 * The canonical registry. Names are the exact server method paths.
 *
 * Scope: items / customers / shifts / payments / approval / offline endpoints
 * actually reached from the SPA today plus the 6 offline-capable writes the
 * design requires (09-api-boundary.md §3).
 */
export const methodRegistry: Record<string, MethodConfig> = {
	// -----------------------------------------------------------------------
	// Reads — offline-cacheable
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.get_items": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},
	"pospire.pospire.api.posapp.get_items_groups": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},
	"pospire.pospire.api.posapp.get_customer_names": {
		intent: "read",
		offline: true,
		cacheTTLMs: 6 * HOUR,
	},
	"pospire.pospire.api.posapp.get_offers": {
		intent: "read",
		offline: true,
		cacheTTLMs: 2 * HOUR,
	},
	// Tax config for offline estimation. Rarely changes (admin tax setup), so a
	// long window keeps the cart taxable offline for a full shift.
	"pospire.pospire.api.posapp.get_offline_tax_config": {
		intent: "read",
		offline: true,
		cacheTTLMs: 24 * HOUR,
	},
	"pospire.pospire.api.dashboard.get_shift_dashboard": {
		intent: "read",
		offline: true,
	},
	// Dashboard layout config. Static admin configuration that changes rarely,
	// so it caches for a long window to keep the dashboard renderable offline.
	"pospire.pospire.api.dashboard.get_dashboard_layout": {
		intent: "read",
		offline: true,
		cacheTTLMs: 24 * HOUR,
	},
	// Opening-dialog reference data. Durable-cached (see DURABLE_KEYS in
	// offline/read-cache.ts) so it survives a reload — the cashier often
	// reaches this dialog only after an offline close, on a fresh page load.
	// Both call sites MUST pass OPENING_DIALOG_CACHE_KEY as opts.cacheKey; the
	// default arg-hashed key is neither stable nor allowlistable.
	"pospire.pospire.api.posapp.get_opening_dialog_data": {
		intent: "read",
		offline: true,
		cacheTTLMs: 24 * HOUR,
	},

	// -----------------------------------------------------------------------
	// Reads — LIVE ONLY (P-4: server stays authoritative)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.get_items_details": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_item_detail": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_customer_info": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_customer_addresses": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_sales_person_names": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_available_credit": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_applicable_delivery_charges": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.posapp.check_opening_shift": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_draft_invoices": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_orders": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_invoices_for_return": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.search_invoices_with_items": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_pos_coupon": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_active_gift_coupons": { intent: "read", offline: false },
	"pospire.pospire.api.posapp.get_sales_invoice_child_table": {
		intent: "read",
		offline: false,
	},
	// Payment entry reads (pay.vue flow)
	"pospire.pospire.api.payment_entry.get_available_pos_profiles": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.payment_entry.get_outstanding_invoices": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.payment_entry.get_unallocated_payments": {
		intent: "read",
		offline: false,
	},

	// M-pesa reads
	"pospire.pospire.api.m_pesa.get_mpesa_draft_payments": { intent: "read", offline: false },
	"pospire.pospire.api.m_pesa.get_mpesa_mode_of_payment": { intent: "read", offline: false },

	// Approval reads
	"pospire.pospire.api.approval.get_approval_config": { intent: "read", offline: false },
	"pospire.pospire.api.approval.get_approval_request_status": {
		intent: "read",
		offline: false,
	},

	// Hardware manager reads
	"pospire.pospire.api.hardware_manager.get_hardware_manager_setting": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.hardware_manager.hardware_url": { intent: "read", offline: false },
	"pospire.pospire.api.hardware_manager.generate_print_xml": {
		intent: "read",
		offline: false,
	},

	// Generic client reads used by the SPA (address/territory lookups, etc.)
	"frappe.client.get_list": { intent: "read", offline: false },
	"frappe.client.get": { intent: "read", offline: false },
	"frappe.client.get_value": { intent: "read", offline: false },
	"frappe.client.get_single_value": { intent: "read", offline: false },
	"frappe.client.get_doc": { intent: "read", offline: false },

	// Auth
	logout: { intent: "write", offline: false },

	// -----------------------------------------------------------------------
	// Writes — offline-capable (outbox queues when offline; server enforces
	// idempotency on offline_id per P-5)
	// -----------------------------------------------------------------------
	// These `offline.*` entries are scheduler-replay-only. The scheduler always
	// sets `bypassConnectivityForReplay` when calling them, so the connectivity
	// gate AND the registry adapter are both skipped. They're listed here only
	// because call() validates every method against the registry. Mark
	// `offline: false` so a stray non-bypass call (a future caller forgetting
	// the bypass flag) fails loudly with `OfflineWriteUnavailable` when offline,
	// instead of attempting to enqueue without an adapter.
	"pospire.pospire.api.offline.submit_invoice": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.offline.create_material_receipt": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.offline.create_opening_entry": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.offline.create_closing_entry": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.offline.create_customer": {
		intent: "write",
		offline: false,
	},
	// Returns are intentionally deferred from offline enqueue in the current
	// rollout. Keep this live-only so return handling stays explicit until the
	// client ships a durable return-against offline index + adapter path.
	"pospire.pospire.api.offline.create_return": {
		intent: "write",
		offline: false,
	},

	// -----------------------------------------------------------------------
	// Writes — UI-facing methods, offline-routed via toOfflinePayload
	//
	// Components keep calling these `posapp.*` paths. When the call() wrapper
	// decides to enqueue (offline or post-network_error), it invokes
	// `toOfflinePayload` to (a) reshape the UI args to the offline endpoint's
	// (data, offline_id, device_id, ...) contract and (b) provide the
	// `pospire.pospire.api.offline.*` method name for the scheduler to POST.
	// Live online sends still go to the original posapp.* method.
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.submit_invoice": {
		intent: "write",
		offline: true,
		outboxType: "invoice",
		toOfflinePayload: (args, ctx) => {
			// Payments.vue calls with {data: paymentMetadata, invoice: invoiceDoc}.
			// offline.submit_invoice (offline.py:568) extracts the payment
			// metadata from the inner payload as `posa_submit_data` and passes
			// it as the second arg to posapp.submit_invoice — that's the path
			// that handles credit_change / is_cashback / customer credit etc.
			// (posapp.py:882). We must NOT merge the metadata into the invoice
			// doc; it goes under a SEPARATE `posa_submit_data` key.
			const rawInvoice = args.invoice ?? {};
			const invoice = (
				typeof rawInvoice === "string" ? JSON.parse(rawInvoice) : rawInvoice
			) as Record<string, unknown>;
			const rawPayment = args.data ?? {};
			const paymentMeta = (
				typeof rawPayment === "string" ? JSON.parse(rawPayment) : rawPayment
			) as Record<string, unknown>;
			// Returns are intentionally live-only in this phase. Prevent the
			// generic submit_invoice adapter from silently queuing them as
			// `invoice` outbox rows when offline/network_error.
			if (Boolean(invoice.is_return)) {
				throw new OfflineReturnDeferredError();
			}

			// _apply_payload_metadata requires both fields on the invoice doc
			// (P-5, P-11).
			const postingDate = (invoice.posting_date as string) ?? todayIso();
			const ownerUser =
				(invoice.owner_user as string) ??
				(invoice.owner as string) ??
				currentCashier();

			// Customer offline_id: when the cart's customer was offline-created,
			// Invoice.vue sets `invoice.customer_offline_id`. Forward it inside
			// the inner data so server's `_resolve_customer_by_offline_id`
			// (offline.py:506-508) rewrites the link to the real customer name
			// at sync time. Also add to parentOfflineIds so the scheduler waits
			// for the customer outbox row to sync before draining this invoice.
			const customerOfflineId =
				(invoice.customer_offline_id as string | undefined) ?? undefined;

			const innerData: Record<string, unknown> = {
				doctype: "Sales Invoice",
				...invoice,
				posa_submit_data: paymentMeta,
				posting_date: postingDate,
				owner_user: ownerUser,
			};
			// Server pops `customer_offline_id` from the inner data and uses it
			// to resolve the link. Make sure it's there even if `invoice` came
			// in as a JSON string with the field omitted at the top level.
			if (customerOfflineId) {
				innerData.customer_offline_id = customerOfflineId;
			}

			return {
				method: "pospire.pospire.api.offline.submit_invoice",
				payload: {
					data: JSON.stringify(innerData),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
					opening_entry_offline_id:
						(invoice.pos_opening_shift_offline_id as string) ?? null,
					material_receipt_offline_ids:
						(invoice.pos_material_receipt_offline_ids as string[] | string) ??
						null,
				},
				shiftOfflineId: (invoice.pos_opening_shift_offline_id as string) ?? null,
				parentOfflineIds: ([] as string[])
					.concat(
						(invoice.pos_material_receipt_offline_ids as string[]) ?? [],
						// Local dependency ONLY while the opening is still
						// queued. A shift opened online has a pos_offline_id
						// but no outbox row, so naming it here would block the
						// invoice on a row that never arrives. The id still
						// goes to the server above, which resolves it either way.
						invoice.pos_opening_shift_offline_id &&
						invoice.pos_opening_shift_pending_sync
							? [invoice.pos_opening_shift_offline_id as string]
							: [],
						customerOfflineId ? [customerOfflineId] : [],
					)
					.filter(Boolean),
				postingDate,
				ownerUser,
			};
		},
	},
	// Offline shift open (F2). The live posapp.create_opening_voucher returns
	// a fat payload (POS Profile + Company + stock_settings); we can't
	// reconstruct that from server data offline. The strategy is:
	//   1. The cashier's previous online session left a localStorage snapshot
	//      under `pospire.opening_shift_snapshot` (Pos.vue cached it on the
	//      last successful check_opening_shift). That snapshot carries the
	//      full pos_profile + company.
	//   2. When offline, OpeningDialog.vue builds a provisional shift doc and
	//      calls call() — this adapter routes to offline.create_opening_entry,
	//      which enqueues. The component then synthesises the `data` shape
	//      using snapshot.pos_profile + snapshot.company + the provisional
	//      shift (with offline_id). register_pos_data fires as usual.
	//   3. Subsequent invoices stamp `pos_opening_shift_offline_id` on the
	//      queued payload; the server resolves it to the real shift name on
	//      sync via `_resolve_opening_shift`.
	"pospire.pospire.api.posapp.create_opening_voucher": {
		intent: "write",
		offline: true,
		outboxType: "opening_entry",
		toOfflinePayload: (args, ctx) => {
			const user = currentCashier();
			const posProfileName =
				typeof args.pos_profile === "string"
					? args.pos_profile
					: args.pos_profile?.name;
			const company = args.company;
			const balanceDetails =
				typeof args.balance_details === "string"
					? JSON.parse(args.balance_details)
					: args.balance_details ?? [];
			const denominationDetails = args.denomination_details
				? typeof args.denomination_details === "string"
					? JSON.parse(args.denomination_details)
					: args.denomination_details
				: null;

			// Build a POS Opening Shift doc the server can insert as-is. The
			// `period_start_date` and `posting_date` are snapshotted at queue
			// time per P-11 — never recomputed at sync.
			const nowIso = new Date().toISOString();
			const todayIsoDate = nowIso.slice(0, 10);
			const doc: Record<string, unknown> = {
				doctype: "POS Opening Shift",
				period_start_date: nowIso.replace("T", " ").slice(0, 19),
				posting_date: todayIsoDate,
				user,
				pos_profile: posProfileName,
				company,
				docstatus: 1,
				balance_details: balanceDetails,
				owner_user: user,
			};
			if (denominationDetails) {
				doc.denomination_details = denominationDetails;
			}

			return {
				method: "pospire.pospire.api.offline.create_opening_entry",
				payload: {
					data: JSON.stringify(doc),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
				},
				postingDate: todayIsoDate,
				ownerUser: user,
			};
		},
	},
	"pospire.pospire.api.posapp.create_customer": {
		intent: "write",
		offline: true,
		outboxType: "customer",
		toOfflinePayload: (args, ctx) => {
			// posapp.create_customer accepts loose UI args. offline.create_customer
			// requires owner_user and inserts the payload directly as a Customer
			// doc (F2). Mirrors the field set in posapp.create_customer:1340-1395.
			const user = currentCashier();
			const doc: Record<string, unknown> = {
				doctype: "Customer",
				customer_name: args.customer_name,
				customer_type: args.customer_type ?? "Individual",
				customer_group: args.customer_group ?? "All Customer Groups",
				territory: args.territory ?? "All Territories",
				owner_user: user,
				owner: user,
			};
			// Optional fields — only include if the UI supplied them so we don't
			// override doctype defaults with empty strings / null.
			for (const key of [
				"tax_id",
				"mobile_no",
				"email_id",
				"gender",
				"posa_referral_code",
			] as const) {
				const v = args[key];
				if (v !== undefined && v !== null && v !== "") doc[key] = v;
			}
			// Live API stores birthday as `posa_birthday` (posapp.py:1369). Map
			// the UI's `birthday` arg to that field so offline-created customers
			// don't lose it.
			if (args.birthday !== undefined && args.birthday !== null && args.birthday !== "") {
				doc.posa_birthday = args.birthday;
			}
			if (args.referral_code) doc.posa_referral_code = args.referral_code;
			if (args.company) doc.posa_referral_company = args.company;

			return {
				method: "pospire.pospire.api.offline.create_customer",
				payload: {
					data: JSON.stringify(doc),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
				},
				ownerUser: user,
			};
		},
	},
	// -----------------------------------------------------------------------
	// Writes — LIVE ONLY
	// Existing SPA writes that have NOT (yet) been re-implemented behind the
	// offline-capable endpoints above. They fire live; on network_error they
	// propagate to the caller rather than enqueuing. Revisit during Phase 2.
	// -----------------------------------------------------------------------
	"pospire.pospire.api.posapp.update_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.update_invoice_from_order": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.delete_sales_invoice": { intent: "write", offline: false },
	"pospire.pospire.api.posapp.create_sales_invoice_from_order": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.posapp.make_address": { intent: "write", offline: false },
	// TODO: classify once owning team confirms semantics (approval flow + mpesa STK push).
	// These look like live-only server-side integrations (PIN auth, Safaricom).
	"pospire.pospire.api.approval.create_approval_request": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.approval.notify_remote_manager": { intent: "write", offline: false },
	"pospire.pospire.api.approval.verify_pin_and_approve": { intent: "write", offline: false },
	"pospire.pospire.api.approval.cancel_approval_request": { intent: "write", offline: false },
	"pospire.pospire.api.approval.bulk_cancel_approval_requests": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.approval.link_requests_to_invoice": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.m_pesa.submit_mpesa_payment": { intent: "write", offline: false },
	"pospire.pospire.api.payment_entry.process_pos_payment": {
		intent: "write",
		offline: false,
	},
	"pospire.pospire.api.posapp.create_payment_request": { intent: "write", offline: false },

	// Shift close. `make_closing_shift_from_opening` stays live-only — when
	// offline, Pos.vue catches the failure and synthesises a minimal closing
	// shape from the cached opening shift's balance_details (no aggregated
	// expected amounts; the cashier reconciles after sync). The submit path
	// routes through the offline adapter so the queued closing waits on its
	// parents (opening + every invoice in the shift) via parent_offline_ids.
	"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening":
		{ intent: "read", offline: false },
	"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift": {
		intent: "write",
		offline: true,
		outboxType: "closing_entry",
		toOfflinePayload: (args, ctx) => {
			const user = currentCashier();
			const cs =
				typeof args.closing_shift === "string"
					? JSON.parse(args.closing_shift)
					: args.closing_shift;

			// Mixed-mode shift handling.
			// If the shift was opened OFFLINE: `pos_opening_shift.pos_offline_id`
			// is a UUID v4; the server resolves it via _resolve_opening_shift.
			// If the shift was opened ONLINE: there's no offline_id, only the
			// real shift name (e.g. POSA-OS-26-0000030). The server-side
			// resolver now accepts either form, so we send whichever is
			// available.
			const openingOfflineId = cs.pos_opening_shift_offline_id ?? null;
			const openingServerName = cs.pos_opening_shift ?? null;

			// Strict closure on the server requires the full list of invoice
			// offline_ids the cashier rang up under this shift. The component
			// (ClosingDialog → Pos.vue.submit_closing_pos) supplies them via
			// `cs.invoice_offline_ids`. The scheduler holds the closing in
			// `waiting_for_siblings` until every one is synced.
			const invoiceOfflineIds = Array.isArray(cs.invoice_offline_ids)
				? cs.invoice_offline_ids.filter(Boolean)
				: [];

			// Build the POS Closing Shift doc the offline endpoint will insert.
			// Use local time, NOT toISOString() (UTC). Frappe datetimes are
			// site-local; mixing UTC here produces period_end_date < period_start_date
			// on UTC-behind-local timezones (e.g. IST = UTC+5:30).
			const _d = new Date();
			const _p = (n: number) => String(n).padStart(2, "0");
			const nowLocal = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`;
			const todayLocal = nowLocal.slice(0, 10);
			const doc: Record<string, unknown> = {
				doctype: "POS Closing Shift",
				period_start_date: cs.period_start_date ?? nowLocal,
				period_end_date: nowLocal,
				posting_date: cs.posting_date ?? todayLocal,
				user: cs.user ?? user,
				pos_profile: cs.pos_profile,
				company: cs.company,
				docstatus: 1,
				payment_reconciliation: cs.payment_reconciliation ?? [],
				denomination_details: cs.denomination_details ?? [],
				pos_transactions: cs.pos_transactions ?? [],
				taxes: cs.taxes ?? [],
				grand_total: cs.grand_total ?? 0,
				net_total: cs.net_total ?? 0,
				total_quantity: cs.total_quantity ?? 0,
				owner_user: user,
				// Server pops these and uses them for parent resolution + strict
				// closure. They never get persisted onto the doc.
				invoice_offline_ids: invoiceOfflineIds,
			};

			// Anchor the queued closing to its shift.
			//
			// Two client-side consumers read this off the queued row:
			//   - Pos.vue `matchesShift()` (the duplicate-close guard)
			//   - outbox.ts `readInnerShiftName()` (the strict-closure gate)
			// Without it, both silently fail for online-opened shifts and the cashier
			// can enqueue a second closing that the server later rejects.
			//
			// Stamp ONLY when the shift was opened online. For an offline-opened shift
			// `cs.pos_opening_shift` holds the provisional "OFFLINE-OPN-..." name, which
			// is not a server link and must never be written as one — that case is
			// already anchored by `shift_offline_id` on the outbox row.
			//
			// The server overwrites this field at offline.py:1877 regardless, so
			// stamping it changes nothing server-side.
			if (!openingOfflineId && openingServerName) {
				doc.pos_opening_shift = openingServerName;
			}

			// Parents the scheduler waits on before sending: the opening shift
			// (must be synced first so its name resolves) and every invoice in
			// the shift (strict closure).
			// Same split as the invoice adapter: `opening_entry_ref` below still
			// carries the id for the server, but a shift already on the server
			// has no outbox row and must not be named as a local parent.
			const parentOfflineIds = [
				...(openingOfflineId && cs.pos_opening_shift_pending_sync
					? [openingOfflineId]
					: []),
				...invoiceOfflineIds,
			];

			return {
				method: "pospire.pospire.api.offline.create_closing_entry",
				payload: {
					data: JSON.stringify(doc),
					offline_id: ctx.offlineId,
					device_id: ctx.deviceId,
					// Send EITHER the offline_id (UUID v4) OR the real shift
					// name. Server-side `_resolve_opening_shift_flexible`
					// disambiguates.
					opening_entry_ref: openingOfflineId || openingServerName,
				},
				shiftOfflineId: openingOfflineId,
				parentOfflineIds,
				postingDate: doc.posting_date as string,
				ownerUser: user,
			};
		},
	},

	// -----------------------------------------------------------------------
	// Shift helpers — live only (server is authoritative for submitted invoices)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.offline.get_shift_invoice_offline_ids": {
		intent: "read",
		offline: false,
	},

	// -----------------------------------------------------------------------
	// Operational / diagnostic (always fire live)
	// -----------------------------------------------------------------------
	"pospire.pospire.api.offline.ping": { intent: "read", offline: false },
	// Kill switch: cashier-callable boolean lookup. Permission-checked at
	// the framework level (whitelist-only, no Guest), but bypasses the
	// POSpire Offline Settings doctype's role restrictions so cashier
	// sessions can poll the bit without 403.
	"pospire.pospire.api.offline.is_offline_enabled": {
		intent: "read",
		offline: false,
	},
	// Cashier-tunable runtime knobs (Phase 2-D). Cached for 12h because
	// the values are admin-set retention settings — they don't change
	// faster than that. Same offline:false pattern as is_offline_enabled
	// (we don't queue read of config on a known-down link; the client
	// falls back to its bundled defaults when offline).
	"pospire.pospire.api.offline.get_offline_runtime_config": {
		intent: "read",
		offline: false,
	},
	// Reference data for the offline-capable Create / Update Customer
	// dialog (customer groups, territories, genders). Marked offline:true
	// with a long TTL because the lists rarely change, and a stale entry
	// just means a freshly-added Customer Group / Territory may be missing
	// from the dropdown until the next online refresh — no correctness
	// risk. The dialog renders empty without this when offline, blocking
	// walk-in customer creation, so caching matters.
	"pospire.pospire.api.offline.get_customer_form_options": {
		intent: "read",
		offline: true,
		cacheTTLMs: 12 * 60 * 60 * 1000,
	},
	// B5 — observability beacon. Live-only: there's no value in queueing a
	// stale beacon if the device is offline (the next beacon overwrites the
	// dashboard with current state on reconnect anyway).
	"pospire.pospire.api.offline.record_beacon": { intent: "write", offline: false },
	// B6 — observability dashboard payload. Aggregates the latest beacon per
	// device + outlet rollup + 7-day trend.
	"pospire.pospire.api.offline.get_observability_summary": {
		intent: "read",
		offline: false,
	},
	"pospire.pospire.api.offline.log_batch": { intent: "write", offline: false },
	"pospire.pospire.api.offline.submit_recovery_log": { intent: "write", offline: false },
	// Handoff for offline-sync recovery (Phase 1b). Live-only: handing off
	// while the device is offline is a no-op — the scheduler keeps the row
	// in `needs_review`, the next online cycle attempts the handoff, and
	// the entry transitions to `handed_off` (tombstone) on success. The
	// endpoint itself is idempotent on offline_id, so a retry that crosses
	// a transient failure boundary returns the existing recovery row.
	"pospire.pospire.api.recovery.handoff": { intent: "write", offline: false },
	// Vacuum lookup: cashier-side polling for resolution of locally-
	// tombstoned offline_ids. Live-only — when offline, the vacuum is
	// skipped entirely (no point asking the server for state we can't
	// reach). The endpoint server-side filters by cashier_user so a
	// malicious call can't enumerate other cashiers' rows.
	"pospire.pospire.api.recovery.lookup_resolution": { intent: "read", offline: false },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `method` against the registry, throwing `UnregisteredMethod` if
 * absent. Explicit rather than implicit by design (09-api-boundary.md §3.1).
 */
export function getMethodConfig(method: string): MethodConfig {
	const config = methodRegistry[method];
	if (!config) {
		throw new UnregisteredMethod(method);
	}
	return config;
}

/** Narrow type guard for read entries. */
export function isReadConfig(c: MethodConfig): c is ReadMethodConfig {
	return c.intent === "read";
}

/** Narrow type guard for write entries. */
export function isWriteConfig(c: MethodConfig): c is WriteMethodConfig {
	return c.intent === "write";
}
