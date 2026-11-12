/**
 * One POSpire tab per browser on a terminal-numbered till: two tabs would draw
 * the same terminal number. The lock is held until the tab closes. Browsers
 * without Web Locks are not blocked.
 */

// Shared by every caller in this tab (Pos.vue and the till claim ask at the same moment); a
// second request from the same tab would find the lock taken and lock this tab out.
let pending: Promise<boolean> | null = null;

export function acquireTillLock(): Promise<boolean> {
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	if (!locks) return Promise.resolve(true);
	if (!pending) {
		const attempt = new Promise<boolean>((resolve) => {
			locks
				.request("pospire-till", { ifAvailable: true }, (lock) => {
					resolve(!!lock);
					return lock ? new Promise<void>(() => {}) : null;
				})
				// A broken Locks API must not leave the till on a blank page.
				.catch(() => resolve(true));
		});
		pending = attempt;
		// Not granted: a later call may try again once the other tab has closed.
		attempt.then((held) => {
			if (!held && pending === attempt) pending = null;
		});
	}
	return pending;
}
