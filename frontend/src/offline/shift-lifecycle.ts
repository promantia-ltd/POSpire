/**
 * Shift lifecycle authority.
 *
 * `db.shifts` is the durable answer to "which shift is active, which shifts
 * are closing, and is selling allowed right now". The outbox remains the
 * durable command / audit log and the source for startup reconciliation —
 * the two are not competing stores: one holds state, the other holds intent.
 *
 * Before this module, all three of those facts lived in Vue component memory
 * plus a single-slot `localStorage` snapshot that the close path nulled out.
 * A single slot cannot represent "shift A is closing-pending" and "shift B is
 * active" at the same time, which is the normal state right after an offline
 * close — the cashier is routed to the opening dialog and may open B while
 * A's closing waits to sync.
 *
 * Every shift gets a local lifecycle UUID on open, INCLUDING shifts opened
 * online. Without it there is no stable key to hang state on before a server
 * name exists, and the online-opened case is precisely the one that breaks.
 */

import {
	listClosingEntryStatuses,
	listInvoiceRowsAcrossStatuses,
	readInnerShiftName,
} from "./outbox";
import {
	buildStoredShift,
	countShiftsByStatus,
	getShiftById,
	getShiftByOpeningServerName,
	listPendingClosingShifts,
	putShiftIfAbsent,
	updateShiftStatus,
} from "./repos/shifts";
import type { OutboxStatus, ShiftRow } from "./types";

export interface OpenedShiftInput {
	/**
	 * Server doc name, or null when the shift has no confirmed server
	 * identity yet. NOTE: this is NOT simply "shift opened offline" — a
	 * synced offline shift keeps its (now permanent) `pos_offline_id`
	 * server-side, so callers must key this off a sync-status flag
	 * (e.g. `pospire_pending_sync`), not off `pos_offline_id`'s presence.
	 */
	openingServerName: string | null;
	posProfile: Record<string, unknown>;
	openingCashByMop: Record<string, number>;
	cashierUser: string;
	deviceId: string;
	/**
	 * Durable identity of this shift's row: its outbox `offline_id`
	 * (`pos_offline_id` on an unsynced offline-opened shift) or, once that
	 * has been cleared by the sync handler, the `pospire_lifecycle_id`
	 * stamped back onto the shift object / snapshot.
	 *
	 * Without this, every reload of an unsynced offline shift would
	 * `crypto.randomUUID()` a brand-new row, breaking `getOpenShift()`'s
	 * "at most one open shift per device" invariant.
	 *
	 * Callers SHOULD pass it on the online path too, not just the offline
	 * one: a shift opened offline and synced mid-shift arrives here with a
	 * server name AND a lifecycle id, and the two dedupe keys are checked in
	 * that order (see `putShiftIfAbsent`). Supplying both means the row is
	 * still found even if `opening_server_name` never made it onto the row.
	 */
	lifecycleId?: string;
}

/**
 * Record a newly opened shift and return its local lifecycle UUID.
 *
 * Idempotent on `openingServerName` FIRST and then on `lifecycleId` — both
 * are tried, never one or the other. A shift opened offline and synced
 * mid-shift carries both keys but its row may still be keyed only by the
 * lifecycle id (the row learns its server name from
 * `attachOpeningServerName`, which is best-effort and can be missed if the
 * tab is closed the instant the opening syncs). Checking a single key was
 * enough to miss that row and create a SECOND `open` one, which silently
 * dropped the closing-pending lock. Either way, re-registering an existing
 * shift returns its EXISTING row's id unchanged — it never overwrites,
 * since by the time of a re-registration Task 9's closing flow may already
 * have advanced this row past `open`.
 *
 * The row is encrypted (`buildStoredShift`) BEFORE the transactional
 * dedupe-then-put (`putShiftIfAbsent`), never inside it. `crypto.subtle`
 * returns native, non-Dexie promises; awaiting one inside a Dexie
 * transaction's callback lets IndexedDB auto-commit the transaction out
 * from under it (`PrematureCommitError`), which silently defeats both the
 * dedupe check AND the write on every single call — this was tried in an
 * earlier revision and reproduced against this exact function in review.
 * Encrypting a row that turns out to be a duplicate (the dedupe-hit path)
 * is wasted work, but that's a rare path and a cheap price for the
 * transaction actually working.
 */
export async function registerOpenedShift(
	input: OpenedShiftInput,
): Promise<string> {
	const offlineId = input.lifecycleId ?? crypto.randomUUID();
	const row: ShiftRow = {
		offline_id: offlineId,
		device_id: input.deviceId,
		cashier_user: input.cashierUser,
		pos_profile: input.posProfile,
		opening_cash_by_mop: input.openingCashByMop,
		opened_at: Date.now(),
		opening_server_name: input.openingServerName,
		closing_cash_by_mop: null,
		expected_closing_by_mop: null,
		variance_at_close: null,
		variance_at_sync: null,
		closing_notes: null,
		closed_at: null,
		closing_server_name: null,
		pending_closing_offline_id: null,
		status: "open",
		manager_approval_required: false,
	};
	const stored = await buildStoredShift(row);
	return putShiftIfAbsent(stored, {
		openingServerName: input.openingServerName,
		lifecycleId: input.lifecycleId,
	});
}

/**
 * Look a shift up by its server doc name. Null-safe on unsynced shifts.
 * Delegates to the repo's indexed-free `.filter()` lookup so a single
 * corrupt row elsewhere in the table can't take down every registration
 * attempt (as `listAllShifts()` + decrypt-all would).
 */
export async function findShiftByServerName(
	serverName: string,
): Promise<ShiftRow | undefined> {
	if (!serverName) return undefined;
	return getShiftByOpeningServerName(serverName);
}

/**
 * Give an offline-opened shift its durable server identity, once its opening
 * entry has synced.
 *
 * WHY THIS EXISTS: an offline-opened shift's row is created with
 * `opening_server_name: null` and keyed only by its outbox id. When the
 * opening syncs mid-shift, the sync handler clears `pos_offline_id` and
 * `pospire_pending_sync` in memory and in the localStorage snapshot — so on
 * the NEXT reload the shift presents itself as an ordinary server-named
 * shift. Before this function existed, nothing ever wrote
 * `opening_server_name` onto the row, so that reload's dedupe found nothing,
 * created a SECOND `open` row, and the first row's `closed_pending_sync`
 * lock silently stopped applying to the shift the cashier was actually on.
 *
 * The row's CURRENT status is preserved deliberately: by the time an opening
 * syncs, the cashier may already have queued the close, and resetting a
 * `closed_pending_sync` row to `open` here would unlock selling on a shift
 * that is on its way out.
 *
 * Returns whether the row now carries the name. Refuses (returns false) when
 * a DIFFERENT row already claims that server name rather than creating a
 * duplicate claim — `getShiftByOpeningServerName` returns the first match,
 * so two rows sharing a name would make the lookup non-deterministic.
 */
export async function attachOpeningServerName(
	lifecycleId: string,
	openingServerName: string,
): Promise<boolean> {
	if (!lifecycleId || !openingServerName) return false;
	const claimed = await findShiftByServerName(openingServerName);
	if (claimed) return claimed.offline_id === lifecycleId;
	const row = await getShiftById(lifecycleId);
	if (!row) return false;
	await updateShiftStatus(lifecycleId, row.status, {
		opening_server_name: openingServerName,
	});
	return true;
}

/** Re-export so callers never reach past this module into the repo. */
export { getShiftById };

/**
 * Outbox statuses that mean "this command has NOT landed on the server yet".
 * `synced` and `voided` are both terminal and both mean the closing is no
 * longer in flight, so neither keeps a shift locked.
 */
const UNSYNCED_OUTBOX_STATUSES: ReadonlySet<OutboxStatus> = new Set([
	"enqueued",
	"in_flight",
	"retry_pending",
	"needs_review",
	"handed_off",
]);

/**
 * Mark a shift as closing-pending against a queued closing entry.
 *
 * The link is `pending_closing_offline_id` — the closing's own outbox id —
 * and NOT `closing_server_name`, which does not exist until the closing has
 * actually synced.
 */
export async function markShiftClosingPending(
	shiftLifecycleId: string,
	closingOfflineId: string,
): Promise<void> {
	await updateShiftStatus(shiftLifecycleId, "closed_pending_sync", {
		closed_at: Date.now(),
		pending_closing_offline_id: closingOfflineId,
	});
}

/**
 * Resolve a synced closing back to its shift.
 *
 * Keys off the CLOSING's own offline_id, never off whatever shift happens to
 * be active — reading the active shift's marker is what let a synced closing
 * for shift A reset shift B, and what made the handler silently no-op after
 * a reload. Returns null when no shift is waiting on this closing, so an
 * unknown id changes nothing.
 */
export async function resolveClosingSynced(
	closingOfflineId: string,
	closingServerName: string | null = null,
): Promise<{ shiftLifecycleId: string; wasActive: boolean } | null> {
	if (!closingOfflineId) return null;
	const pending = await listPendingClosingShifts();
	const match = pending.find(
		(row) => row.pending_closing_offline_id === closingOfflineId,
	);
	if (!match) return null;

	await updateShiftStatus(match.offline_id, "synced", {
		pending_closing_offline_id: null,
		// The server's name for the closing doc. The row would otherwise never
		// learn it — this is the only moment it exists AND we know which shift
		// it belongs to.
		closing_server_name: closingServerName,
	});
	return {
		shiftLifecycleId: match.offline_id,
		// The shift was still awaiting its close (rather than already
		// advanced past it by a reconciliation pass) when this landed.
		wasActive: match.status === "closed_pending_sync",
	};
}

/**
 * Is selling blocked right now?
 *
 * Blocked ONLY when the shift the cashier is actively on is itself closing.
 * A closing-pending shift A must not lock selling on a freshly opened B —
 * chained offline shifts are a supported requirement, and blocking them
 * would halt sales during exactly the outage offline mode exists for.
 */
export async function isSellingBlocked(
	activeShiftLifecycleId: string | null,
): Promise<boolean> {
	if (!activeShiftLifecycleId) return false;
	const row = await getShiftById(activeShiftLifecycleId);
	return row?.status === "closed_pending_sync";
}

/**
 * Rebuild closing-pending state from the outbox after a reload.
 *
 * The outbox is the durable command log and therefore the reconciliation
 * source; `db.shifts` is what the running app reads. Any shift whose queued
 * closing has already left the unsynced set stops being closing-pending here
 * — it landed, or was voided, while the app was closed. Those two outcomes
 * are NOT the same and are reported separately below.
 *
 * Returns three buckets. `released` is not bookkeeping: the caller must
 * invalidate any cached opening snapshot naming a released shift, or an
 * offline boot re-applies that snapshot and rings sales against a shift that
 * is closed server-side.
 *
 * `reopened` is the OPPOSITE case and must NOT be treated like `released`:
 * a VOIDED closing means the shift was never closed at all — server-side it
 * is still Open — so its snapshot has to survive and the row has to become
 * usable again. Voiding a queued closing is an offered recovery action in
 * the reconciliation workspace, and marking the shift terminal on a void
 * turned that recovery into a trap: the cashier landed in the opening dialog
 * and opened a SECOND shift against a first one that was never closed.
 */
export async function reconcilePendingClosuresFromOutbox(): Promise<{
	stillPending: string[];
	released: string[];
	reopened: string[];
}> {
	const closingStatusById = new Map(
		(await listClosingEntryStatuses()).map((row) => [
			row.offline_id,
			row.status,
		]),
	);

	const stillPending: string[] = [];
	const released: string[] = [];
	const reopened: string[] = [];
	for (const row of await listPendingClosingShifts()) {
		const pendingId = row.pending_closing_offline_id;
		if (!pendingId) continue;
		const closingStatus = closingStatusById.get(pendingId);
		if (closingStatus && UNSYNCED_OUTBOX_STATUSES.has(closingStatus)) {
			stillPending.push(row.offline_id);
			continue;
		}
		if (closingStatus === "voided") {
			// The close was withdrawn, so this shift is genuinely still open —
			// drop the close timestamp along with the pending link.
			//
			// It only goes back to `open` when nothing else is: chained offline
			// shifts are supported, so the cashier may already have opened a
			// successor while this closing sat in the queue. Two `open` rows
			// would break `getOpenShift()`'s "at most one open shift per device"
			// invariant, so the older one lands in `needs_review` instead —
			// honest (a human really does have two open shifts to sort out),
			// non-terminal, and NOT `closed_pending_sync`, so it never blocks
			// selling on the shift the cashier is actually using.
			const anotherIsOpen = (await countShiftsByStatus("open")) > 0;
			await updateShiftStatus(
				row.offline_id,
				anotherIsOpen ? "needs_review" : "open",
				{ pending_closing_offline_id: null, closed_at: null },
			);
			reopened.push(row.offline_id);
			continue;
		}
		// Synced, or an absent row (vacuumed tombstone) that tells us nothing
		// either way — treated as landed, which is the safe direction: it stops
		// the shift being sellable.
		await updateShiftStatus(row.offline_id, "synced", {
			pending_closing_offline_id: null,
		});
		released.push(row.offline_id);
	}
	return { stillPending, released, reopened };
}

// ---------------------------------------------------------------------------
// Task 10 — stopgap expected-amount aggregation for the offline close dialog
// ---------------------------------------------------------------------------

export interface QueuedPaymentSum {
	byMop: Record<string, number>;
	/** Invoices in needs_review / handed_off — included, but flagged. */
	uncertainCount: number;
}

export interface QueuedContributionScan extends QueuedPaymentSum {
	/**
	 * Per-invoice contributions, keyed by the invoice's `offline_id` — the SAME
	 * id the contribution ledger keys on (`call()` passes it as
	 * `offlineIdempotencyKey` and `enqueue` stores it verbatim as the outbox
	 * row's `offline_id`).
	 *
	 * This is what makes a UNION of the two stores exactly computable: the
	 * close dialog can add the outbox rows the ledger never saw without
	 * double-counting the ones it did.
	 */
	byInvoice: Map<string, Record<string, number>>;
}

/**
 * Sum queued invoice payments for a shift, by mode of payment.
 *
 * Every MOP is summed at face value EXCEPT the profile's cash MOP, which is
 * netted of change. Change is NOT read from `inner.change_amount` — that
 * field is computed server-side, at submit time, by ERPNext's
 * `calculate_change_amount()` (erpnext/controllers/taxes_and_totals.py) and
 * does not exist on a queued-but-not-yet-submitted invoice payload.
 *
 * It is also NOT read from `posa_submit_data.total_change` — an earlier
 * revision of this function did, and that turned out to be an unreliable
 * source with two measured failure modes, both reproduced against the real
 * `submit_invoice` adapter:
 *   1. `Payments.vue` computes `total_payments` (and therefore
 *      `total_change`, via `diff_payment`) behind `if (!this.is_cashback)
 *      total = 0`. On a POS Profile with `use_cashback = 0`, `is_cashback`
 *      is false for every sale, so `total_change` comes out as
 *      `-rounded_total`, gets clamped to 0 by the "positive" guard, and NO
 *      change is ever netted for that entire class of profiles — the
 *      original overstatement bug, fully restored.
 *   2. `total_payments` also folds in `redeemed_customer_credit` and
 *      `loyalty_amount`, neither of which the server's `paid_amount`
 *      includes. An invoice with redeemed credit (e.g. grand_total 90,
 *      credit 40, cash 60) nets a PHANTOM change the server never computes
 *      (client sees "paid" 100 vs 90 -> change 10; server sees paid_amount
 *      60 < 90 -> no change) and books cash short.
 * Both failures share a root cause: `total_change` is a PARALLEL client-side
 * calculation with its own gating and inputs that can drift from what the
 * server actually books, rather than being derived from the same two
 * numbers the server uses.
 *
 * Instead, this derives change exactly the way ERPNext's
 * `calculate_paid_amount()` + `calculate_change_amount()` do:
 * `paid_amount = sum(payments[].amount) + (loyalty_amount / conversion_rate
 * if redeem_loyalty_points else 0)`, `change = paid_amount - (rounded_total
 * or grand_total)`, clamped to >= 0. The loyalty term matters: it is a real,
 * measured divergence, not a hypothetical — a customer selected while
 * online (so loyalty points/`conversion_factor` are known) followed by a
 * connectivity drop before submit queues an invoice with
 * `redeem_loyalty_points` + `loyalty_amount` stamped straight onto the doc
 * by `Payments.vue`'s watcher, flowing through the adapter unchanged.
 * Omitting it understated `paid_amount` and overstated cash by exactly the
 * loyalty-funded change (grand_total 100, loyalty 30, cash 100: server nets
 * change 30 and books 70; omitting loyalty here would book the full 100).
 * `conversion_rate` is guarded against 0/missing (`|| 1`) so a bad or absent
 * rate can't divide-by-zero into `NaN` and poison the whole aggregation —
 * `Number(NaN)` is falsy, so a genuinely garbage `loyalty_amount` is also
 * naturally skipped by the `redeem_loyalty_points && Number(loyalty_amount)`
 * guard before it ever reaches a division.
 *
 * `rounded_total` / `grand_total` are read straight off the inner doc; both
 * are reliably PRESENT on a genuinely-offline queued invoice —
 * `Invoice.vue`'s `get_invoice_doc()` (lines ~2226-2241) stamps
 * `rounded_total` client-side with no server round-trip required. The
 * `rounded_total || grand_total` fallback matches Python's `or` exactly
 * (server's `set_rounded_total` sets `rounded_total = 0` outright when
 * rounding is disabled, so the falls-through-to-grand_total behavior here is
 * BY DESIGN, not a guess). What is NOT reproduced: `get_invoice_doc()`
 * stamps `rounded_total = grand_total` VERBATIM, with no currency rounding
 * applied — see the rounding divergence called out below.
 *
 * Guards applied, mirroring `calculate_change_amount`'s conditions:
 *   - not a return (`not self.doc.is_return`) — see the `is_return` check
 *     below; currently unreachable via the real adapter (which throws
 *     `OfflineReturnDeferredError` for `is_return` before any invoice
 *     payload is built — returns cannot reach the outbox as type `invoice`
 *     in this phase), kept as defense-in-depth for a legacy row or future
 *     offline-return support;
 *   - the value is positive (`self.doc.paid_amount > grand_total`) — a
 *     partial-payment invoice (`posa_allow_partial_payment`) can have
 *     paid_amount < total; that must not "net" into a negative-turned-bonus.
 *
 * DELIBERATELY NOT mirrored: `any(d.type == "Cash" for d in payments)`.
 * `type` (`Sales Invoice Payment.type`, fetch_from `mode_of_payment.type`)
 * is populated server-side only when an invoice round-trips through
 * `posapp.py`'s `update_invoice()` (`.save()`) while online — exactly the
 * condition a genuinely offline invoice never meets — so it is unusable
 * client-side.
 *
 * Known, deliberate divergences from the server that remain after the
 * above (measured, not hypothetical — exhaustive as of this writing):
 *   (1) a cash MOP whose underlying `Mode of Payment.type` is not "Cash":
 *       the server's `any(type=="Cash")` guard fails and nets nothing;
 *       this function still nets the change (since it doesn't check
 *       `type` at all — see above).
 *   (2) currency rounding: `get_invoice_doc()` never applies currency
 *       rounding to `rounded_total`, but the server recomputes it on save
 *       via `round_based_on_smallest_currency_fraction` — for currencies
 *       with no smallest-fraction denomination (many do: INR, AED, SAR,
 *       GBP, AUD — USD is a notable exception) this rounds to the nearest
 *       whole unit. Example: grand_total 99.60, cash 100 -> this function
 *       nets change 0.40 (books cash 99.60); the server sees
 *       `rounded_total` snap to 100, `paid_amount(100) > 100` is false, no
 *       change, books the full 100. Drift is bounded (well under 1 unit
 *       per over-tendered cash sale) but accumulates across a shift's
 *       invoices. Not something this stopgap can close without
 *       reimplementing ERPNext's rounding table client-side — the client
 *       figure is arguably the physically correct one anyway, which is
 *       exactly what the dialog's "provisional" label exists to cover.
 * (A zero-amount cash-mode row alongside over-tender elsewhere is NOT a
 * divergence, despite an earlier revision of this comment claiming
 * otherwise: that row still satisfies the server's `any(type=="Cash")`
 * guard, so both sides net the same change against the same row and reach
 * the same number.)
 * `parseInnerDoc` never throws on malformed JSON — a bad payload just
 * yields no change for that invoice, not an aborted scan.
 *
 * This mirrors the server's CLOSING-time aggregation
 * (`_aggregate_closing_from_invoices` in pospire/pospire/api/offline.py),
 * NOT the live opening-to-closing builder — the live builder has a quirk
 * where the first invoice of a MOP absent from `balance_details` never nets
 * change, which `_aggregate_closing_from_invoices` (and this function) does
 * not reproduce. Diverging from `_aggregate_closing_from_invoices` here
 * would show one number at close time and a different one on the record
 * that eventually syncs.
 *
 * One deliberate divergence: the server's summation (`pay_expected[...] +=
 * amount`, a bare `flt` add with no intermediate rounding) applies NO
 * rounding until the field is saved. This function rounds each net payment
 * to `input.precision` before accumulating, and rounds the running total
 * again after each add. That is NOT the server's algorithm — it is a
 * defensive per-payment clamp so a queued payload with excess float noise
 * (e.g. `19.999999999998`) can't drift the display. At 2 decimal places (or
 * whatever `precision` the caller passes — see the site's
 * `currency_precision`, not a hardcoded constant) the difference against the
 * server's unrounded-until-save total is not observable in practice, but a
 * currency with unusual rounding behavior could show a hairline discrepancy.
 *
 * needs_review / handed_off invoices ARE included: the figure estimates what
 * the cashier physically holds, and that money was taken whether or not the
 * record reached the server. Excluding it would manufacture a false shortfall.
 * The count is returned so the UI can say how much of the total is unconfirmed.
 * Invoices whose inner doc fails to parse are NOT counted here — they contribute
 * no money and are a distinct failure mode (unreadable, not merely unconfirmed).
 *
 * This scan sees OFFLINE-QUEUED sales only: sales made earlier in the shift
 * while online leave no trace in the outbox. That is what the Phase 2
 * contribution ledger exists to cover. Neither store is a superset of the
 * other, so the close dialog unions them per invoice — see `byInvoice`.
 */
export async function scanQueuedContributionsByInvoice(input: {
	openingServerName: string | null;
	shiftOfflineId: string | null;
	cashMode: string;
	precision: number;
}): Promise<QueuedContributionScan> {
	// Without an anchor, `row.shift_offline_id` falsy AND
	// `readInnerShiftName(row.payload) === null` would match EVERY unanchored
	// invoice in the outbox — including other shifts' — because `null ===
	// null`. Refuse to aggregate rather than silently pull in other shifts'
	// money.
	if (!input.shiftOfflineId && !input.openingServerName) {
		return { byMop: {}, uncertainCount: 0, byInvoice: new Map() };
	}

	const buckets: OutboxStatus[] = [
		"enqueued",
		"in_flight",
		"retry_pending",
		"needs_review",
		"handed_off",
		"synced",
	];
	// Uses the corrupt-row-resilient scan rather than composing `listByStatus`
	// calls: `listByStatus` decrypts every row in a bucket via a single
	// `Promise.all` and rejects the WHOLE bucket if any one row fails to
	// decrypt. Composed across six buckets under this function's own
	// aggregation, a single poison invoice anywhere would throw all the way
	// out to Pos.vue's try/catch and silently zero the cashier's entire
	// expected-amount figure — not just the bad invoice's share of it.
	const { rows, corruptCount } = await listInvoiceRowsAcrossStatuses(buckets);
	if (corruptCount > 0) {
		// Not surfaced to the cashier (would require widening the return
		// shape and the dialog's UI beyond this stopgap's scope) but must not
		// vanish silently either — this is the one signal an operator has
		// that the total is short by an unknown, undecryptable invoice.
		console.warn(
			`[shift-lifecycle] scanQueuedContributionsByInvoice: skipped ${corruptCount} outbox row(s) that failed to decrypt`,
		);
	}

	const seen = new Set<string>();
	const byInvoice = new Map<string, Record<string, number>>();
	const byMop: Record<string, number> = {};
	let uncertainCount = 0;

	for (const row of rows) {
		if (row.status === "voided") continue;
		if (seen.has(row.offline_id)) continue;

		// Both anchors are tried, never one or the other. A shift opened
		// offline and synced MID-SHIFT has invoices on both sides of the
		// sync: the earlier ones carry `shift_offline_id`, the later ones
		// carry only the server name on the inner doc. The previous
		// if/else picked the server-name branch as soon as
		// `shiftOfflineId` was absent (which is exactly what the synced
		// shift looks like, since the sync handler clears
		// `pos_offline_id`) and skipped every row carrying a
		// `shift_offline_id` — silently dropping the entire pre-sync half
		// of the shift's takings from the expected amount.
		//
		// Neither clause can widen into another shift's money: the first
		// demands an exact id match, and the second is gated on a non-null
		// `openingServerName` so the `null === null` trap that the guard
		// at the top of this function exists to prevent stays closed.
		const matchesOfflineId =
			!!input.shiftOfflineId &&
			row.shift_offline_id === input.shiftOfflineId;
		const matchesServerName =
			!row.shift_offline_id &&
			!!input.openingServerName &&
			readInnerShiftName(row.payload) === input.openingServerName;
		if (!matchesOfflineId && !matchesServerName) continue;

		seen.add(row.offline_id);

		const inner = parseInnerDoc(row.payload);
		if (!inner) continue; // unparseable: contributes nothing, not "uncertain" money — see doc comment.

		if (row.status === "needs_review" || row.status === "handed_off") {
			uncertainCount += 1;
		}

		const contribution = contributionForInvoice(
			inner,
			input.cashMode,
			input.precision,
		);
		byInvoice.set(row.offline_id, contribution);
		for (const [mop, amount] of Object.entries(contribution)) {
			byMop[mop] = round((byMop[mop] ?? 0) + amount, input.precision);
		}
	}

	return { byMop, uncertainCount, byInvoice };
}

/**
 * The scan's shift total, without the per-invoice breakdown.
 *
 * Thin wrapper so the per-invoice arithmetic has exactly one implementation:
 * callers that only need "what do the queued sales add up to" (the no-lifecycle
 * -id fallback branch of the close dialog) keep the old shape.
 */
export async function sumQueuedPaymentsByMop(input: {
	openingServerName: string | null;
	shiftOfflineId: string | null;
	cashMode: string;
	precision: number;
}): Promise<QueuedPaymentSum> {
	const { byMop, uncertainCount } =
		await scanQueuedContributionsByInvoice(input);
	return { byMop, uncertainCount };
}

/**
 * Net contribution of ONE invoice, by mode of payment.
 *
 * The single source of the per-invoice arithmetic. `sumQueuedPaymentsByMop`
 * (the Phase 1 outbox-scanning stopgap) and the Phase 2 contribution ledger
 * both call this, so the two paths cannot drift: cash net of derived change,
 * every other MOP at face value, each net rounded to the site's precision
 * before it is accumulated.
 *
 * `inner` is the invoice doc itself (already unwrapped from any outbox
 * payload envelope), so this works identically for a queued sale and for one
 * being submitted live.
 *
 * Every rule here — including the guards, the loyalty term, the
 * `rounded_total || grand_total` fallback and the clamp at zero — is
 * documented in full in the doc comments on `sumQueuedPaymentsByMop` and
 * `resolveChangeAmount`. Read those before changing anything in this
 * function; it is verified against the server's
 * `_aggregate_closing_from_invoices`.
 */
export function contributionForInvoice(
	inner: Record<string, unknown>,
	cashMode: string,
	precision: number,
): Record<string, number> {
	const payments = (inner.payments as Array<Record<string, unknown>>) || [];
	const change = resolveChangeAmount(inner, payments);
	const byMop: Record<string, number> = {};
	for (const p of payments) {
		const mop = String(p.mode_of_payment ?? "");
		if (!mop) continue;
		const raw = Number(p.amount) || 0;
		const net = mop === cashMode ? raw - change : raw;
		byMop[mop] = round((byMop[mop] ?? 0) + round(net, precision), precision);
	}
	return byMop;
}

/**
 * Client-side stand-in for ERPNext's `calculate_paid_amount()` +
 * `calculate_change_amount()`. Derives change from `payments[].amount`
 * (plus loyalty redemption, converted the same way the server does) and
 * `rounded_total`/`grand_total` — the same quantities the server computes it
 * from — rather than from `posa_submit_data`, a parallel client calculation
 * that measurably drifts from the server's numbers (see the doc comment
 * above `sumQueuedPaymentsByMop` for the reproduced failure modes, the
 * `payments[].type` guard this deliberately does NOT attempt to mirror, and
 * the divergences that remain). Returns 0 — meaning "net nothing" —
 * whenever a guard fails, exactly like the server leaving `change_amount`
 * at its `0.0` default.
 */
function resolveChangeAmount(
	inner: Record<string, unknown>,
	payments: Array<Record<string, unknown>>,
): number {
	// `not self.doc.is_return`. Currently unreachable via the real adapter,
	// which throws `OfflineReturnDeferredError` for returns before any
	// invoice payload is built (call-registry.ts) — kept as defense-in-depth
	// so a future reader does not need to infer this from the adapter's
	// behavior alone, and so it still holds if a legacy row or later offline-
	// return support ever reaches this function.
	if (inner.is_return) return 0;

	let paidAmount = payments.reduce(
		(sum, p) => sum + (Number(p.amount) || 0),
		0,
	);
	// `if self.doc.redeem_loyalty_points and self.doc.loyalty_amount:
	//      paid_amount += self.doc.loyalty_amount / flt(self.doc.conversion_rate)`
	// (calculate_paid_amount, taxes_and_totals.py). Both fields are stamped
	// straight onto invoice_doc by Payments.vue's loyalty_amount watcher and
	// flow through the adapter unchanged — see the doc comment above
	// sumQueuedPaymentsByMop for why this is a real, measured gap and not a
	// defensive nicety. `Number(inner.loyalty_amount)` being falsy (0,
	// missing, or NaN from a garbage value) short-circuits before any
	// division, and `|| 1` on conversion_rate guards the division itself —
	// a 0 or missing rate must not divide-by-zero into a NaN that would
	// poison every payment in this invoice's contribution.
	if (inner.redeem_loyalty_points && Number(inner.loyalty_amount)) {
		const conversionRate = Number(inner.conversion_rate) || 1;
		paidAmount += Number(inner.loyalty_amount) / conversionRate;
	}
	// `self.doc.rounded_total or self.doc.grand_total`. Both fields are
	// reliably present on the client's own queued doc — see the doc comment
	// above `sumQueuedPaymentsByMop`. The `||` chain matches Python's `or`
	// (a falsy 0/absent value falls through) rather than `??`, defensively,
	// in case a differently-shaped payload ever omits `rounded_total`.
	const total = Number(inner.rounded_total) || Number(inner.grand_total) || 0;

	const change = paidAmount - total;
	// `self.doc.paid_amount > grand_total` — a partial-payment invoice can
	// have paid_amount < total; that must not "net" into a negative-turned-
	// bonus.
	return change > 0 ? change : 0;
}

function parseInnerDoc(payload: unknown): Record<string, unknown> | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (typeof p.data !== "string") return p;
	try {
		return JSON.parse(p.data) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function round(value: number, precision: number): number {
	const f = 10 ** precision;
	return Math.round(value * f) / f;
}
