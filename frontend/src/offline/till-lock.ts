/**
 * One POSpire tab per browser: two tabs would draw the same terminal number.
 * The lock is held until the tab closes. Browsers without Web Locks are not blocked.
 */

let held = false;

export async function acquireTillLock(): Promise<boolean> {
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	if (held || !locks) return true;
	held = await new Promise<boolean>((resolve) => {
		void locks.request("pospire-till", { ifAvailable: true }, (lock) => {
			resolve(!!lock);
			return lock ? new Promise<void>(() => {}) : null;
		});
	});
	return held;
}
