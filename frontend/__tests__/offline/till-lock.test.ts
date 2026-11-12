import { afterEach, describe, expect, it, vi } from "vitest";

// Fake Web Locks: grants "pospire-till" to the first requester only.
function fakeLocks() {
	let taken = false;
	return {
		request: vi.fn(
			async (_name: string, _opts: unknown, cb: (lock: object | null) => unknown) => {
				const lock = taken ? null : {};
				taken = true;
				return cb(lock);
			},
		),
	};
}

async function freshModule() {
	vi.resetModules();
	return import("@/offline/till-lock");
}

afterEach(() => vi.unstubAllGlobals());

describe("acquireTillLock", () => {
	it("allows the till when Web Locks is missing", async () => {
		vi.stubGlobal("navigator", {});
		const { acquireTillLock } = await freshModule();
		expect(await acquireTillLock()).toBe(true);
	});

	it("blocks a second tab and keeps the first one open", async () => {
		const locks = fakeLocks();
		vi.stubGlobal("navigator", { locks });
		const first = await freshModule();
		expect(await first.acquireTillLock()).toBe(true);
		// Same tab asking again (Pos.vue remount) must not lock itself out.
		expect(await first.acquireTillLock()).toBe(true);
		expect(locks.request).toHaveBeenCalledTimes(1);

		const second = await freshModule();
		expect(await second.acquireTillLock()).toBe(false);
	});

	it("answers two callers in one tab with one request", async () => {
		const locks = fakeLocks();
		vi.stubGlobal("navigator", { locks });
		const { acquireTillLock } = await freshModule();
		// Pos.vue and the till claim ask at the same moment, before either answer arrives.
		expect(await Promise.all([acquireTillLock(), acquireTillLock()])).toEqual([true, true]);
		expect(locks.request).toHaveBeenCalledTimes(1);
	});

	it("lets a blocked tab try again later", async () => {
		const locks = fakeLocks();
		vi.stubGlobal("navigator", { locks });
		await (await freshModule()).acquireTillLock(); // another tab holds it
		const { acquireTillLock } = await freshModule();
		expect(await acquireTillLock()).toBe(false);
		await acquireTillLock();
		expect(locks.request).toHaveBeenCalledTimes(3);
	});

	it("lets the till open when the Locks API rejects", async () => {
		vi.stubGlobal("navigator", {
			locks: { request: vi.fn(() => Promise.reject(new Error("SecurityError"))) },
		});
		const { acquireTillLock } = await freshModule();
		expect(await acquireTillLock()).toBe(true);
	});
});
