/**
 * Secrets the server issues to this device when it claims a numbered till (claim_terminal).
 * Sent on every call, so only this device can use those tills' invoice numbers. The device id is
 * not proof: it is stored on invoices and the POS Profile. Kept beside the device id in
 * localStorage, so a wiped browser loses both, as a replaced device should.
 */
import { LS_DEVICE_KEYS } from "./constants";

export const DEVICE_KEY_HEADER = "X-Pospire-Device-Key";
// Older keys stay so a re-claimed till can still sync sales numbered under its previous key.
const KEEP_PER_TILL = 5;

function readMap(): Record<string, string[]> {
	try {
		const raw = localStorage.getItem(LS_DEVICE_KEYS);
		const map = raw ? JSON.parse(raw) : {};
		return map && typeof map === "object" ? map : {};
	} catch {
		return {};
	}
}

export function readDeviceKeys(): string[] {
	return Object.values(readMap()).flat();
}

export function saveDeviceKey(profile: string, key: string): void {
	const map = readMap();
	map[profile] = [key, ...(map[profile] ?? []).filter((k) => k !== key)].slice(0, KEEP_PER_TILL);
	try {
		localStorage.setItem(LS_DEVICE_KEYS, JSON.stringify(map));
	} catch {
		/* strict-privacy browsers: the till then cannot prove itself, like a new device */
	}
}
