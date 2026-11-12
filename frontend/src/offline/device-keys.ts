/**
 * This device's secret for numbered tills. The device creates and stores it before its first
 * claim_terminal and sends it on every call; the server keeps only its hash for the tills it links.
 * Created here rather than by the server, so two claims in flight on boot, or a claim whose response
 * is lost, still prove the same device. The device id is not proof: it is stored on invoices and the
 * POS Profile. Kept beside the device id in localStorage, so a wiped browser loses both, as a
 * replaced device should.
 */
import { LS_DEVICE_KEY } from "./constants";

export const DEVICE_KEY_HEADER = "X-Pospire-Device-Key";

export function readDeviceKey(): string | null {
	try {
		return localStorage.getItem(LS_DEVICE_KEY);
	} catch {
		return null;
	}
}

/** The stored secret, created on first use. Null when this browser cannot keep it. */
export function ensureDeviceKey(): string | null {
	const existing = readDeviceKey();
	if (existing) return existing;
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	try {
		localStorage.setItem(LS_DEVICE_KEY, key);
	} catch {
		return null;
	}
	// Only a key that is really stored may be sent: the server would link the till to it.
	return readDeviceKey() === key ? key : null;
}
