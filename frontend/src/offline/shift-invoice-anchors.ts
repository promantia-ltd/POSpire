/**
 * Which queued invoices belong to a shift.
 *
 * A shift can be anchored two ways at once. Invoices rung BEFORE the opening
 * synced carry the opening's offline UUID in `shift_offline_id`; once the
 * opening syncs, `pos_offline_id` is cleared on the active shift and later
 * invoices are identifiable only by the server name inside their payload.
 *
 * Matching a single anchor silently drops one set from strict closure, which
 * is how a shift closed with unsynced invoices still outstanding. This is a
 * union of both, extracted from Pos.vue so it can be tested directly rather
 * than mirrored in a test double.
 */

export interface ShiftAnchors {
	/** `pos_offline_id`, else the preserved lifecycle id. */
	localAnchor: string | null;
	/** Server name of the opening, once it exists. */
	serverName: string | null;
}

export interface InvoiceRowLike {
	offline_id: string;
	shift_offline_id?: string | null;
}

/**
 * @param innerOpeningName Resolves the opening reference recorded inside an
 *        invoice's payload. Returns null when it can't be read.
 */
export function selectShiftInvoiceOfflineIds<T extends InvoiceRowLike>(
	anchors: ShiftAnchors,
	invoiceRows: readonly T[],
	innerOpeningName: (row: T) => string | null,
): Set<string> {
	const merged = new Set<string>();
	if (!anchors.localAnchor && !anchors.serverName) return merged;

	if (anchors.localAnchor) {
		for (const row of invoiceRows) {
			if (row.shift_offline_id === anchors.localAnchor) {
				merged.add(row.offline_id);
			}
		}
	}

	if (anchors.serverName) {
		for (const row of invoiceRows) {
			if (merged.has(row.offline_id)) continue;
			if (innerOpeningName(row) === anchors.serverName) {
				merged.add(row.offline_id);
			}
		}
	}

	return merged;
}
