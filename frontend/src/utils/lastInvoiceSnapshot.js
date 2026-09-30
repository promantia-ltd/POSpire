import { currentCashier } from "@/offline/cashier";

/**
 * sessionStorage mirror of "last invoice", for Navbar.vue's Print Last
 * Invoice across a same-tab reload. Deliberately tiny: only the ids
 * (`name`, `offline_id`, the POS profile) — never the invoice itself.
 * The full invoice, when still needed (an offline sale that hasn't synced
 * yet), is re-read from the outbox's own encrypted store via
 * getOutboxEntry(offline_id) at print time — see Navbar.vue's
 * print_last_invoice. Keeping only ids here means there's a single source
 * of truth for the actual sale data; this can never go stale relative to
 * the outbox the way a duplicated copy could.
 *
 * sessionStorage (not the offline module's Dexie tables) because this is
 * a print convenience, not sync-critical state: fine to vanish on tab
 * close/reload, never needs to sync across devices. It DOES, however,
 * survive a logout in the same tab — so every entry is stamped with the
 * cashier who made the sale, and a read for a DIFFERENT cashier (the next
 * person logged into this till) is treated as absent rather than handed
 * back. Without this, cashier B could reprint cashier A's last receipt
 * right after A logs out.
 */
const KEY = "pospire.last_invoice";

export function saveLastInvoiceIds({ name, offline_id, pos_profile_name }) {
	try {
		sessionStorage.setItem(
			KEY,
			JSON.stringify({
				name,
				offline_id: offline_id ?? null,
				pos_profile_name,
				user: currentCashier(),
			}),
		);
	} catch (e) {
		console.warn("[lastInvoiceSnapshot] could not save", e);
	}
}

export function readLastInvoiceIds() {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return null;
		const stored = JSON.parse(raw);
		if (stored?.user !== currentCashier()) {
			// Belongs to whoever was logged in when it was saved, not the
			// current session — treat it the same as nothing being stored.
			clearLastInvoiceIds();
			return null;
		}
		return stored;
	} catch (e) {
		console.warn("[lastInvoiceSnapshot] could not read", e);
		return null;
	}
}

export function clearLastInvoiceIds() {
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// non-fatal
	}
}
