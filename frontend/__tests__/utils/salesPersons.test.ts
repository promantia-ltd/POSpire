/**
 * Contract for the shared Sales Person loader.
 *
 * Invoice loads on mount, Payments when the payment screen opens — triggers
 * that never overlap, so the saving comes from reusing the result, not from
 * in-flight deduplication. The risk that buys is a memoised failure: a load
 * that failed while offline at boot must not leave the dropdown permanently
 * empty once the terminal reconnects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadSalesPersons, resetSalesPersonsCache } from "@/utils/salesPersons";

const LIST = [{ name: "SP-01", sales_person_name: "Asha" }];

function okFetch(payload: unknown) {
	return vi.fn().mockResolvedValue({
		ok: true,
		type: "basic",
		json: async () => ({ message: payload }),
	});
}

beforeEach(() => {
	resetSalesPersonsCache();
	localStorage.clear();
});

describe("loadSalesPersons", () => {
	it("serves a second caller from the session cache — one request total", async () => {
		const fetchSpy = okFetch(LIST);
		vi.stubGlobal("fetch", fetchSpy);

		const first = await loadSalesPersons();
		const second = await loadSalesPersons();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(first).toEqual(LIST);
		expect(second).toEqual(LIST);
	});

	it("joins a request already in flight", async () => {
		const fetchSpy = okFetch(LIST);
		vi.stubGlobal("fetch", fetchSpy);

		const [a, b] = await Promise.all([loadSalesPersons(), loadSalesPersons()]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
	});

	it("does not memoise a rejection — the next caller retries", async () => {
		const fetchSpy = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValue({
				ok: true,
				type: "basic",
				json: async () => ({ message: LIST }),
			});
		vi.stubGlobal("fetch", fetchSpy);

		await expect(loadSalesPersons()).rejects.toBeTruthy();
		// The retry is what a cashier gets by opening the payment screen after
		// reconnecting; a cached rejection would strand the dropdown empty.
		await expect(loadSalesPersons()).resolves.toEqual(LIST);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	// Invoice mounts before `register_pos_profile` lands, so its load usually
	// runs with persist:false. Payments then asks with persist:true. If the
	// shared result is handed over without writing storage, the offline
	// fallback silently rots.
	it("writes storage when a persisting caller reuses a cached result", async () => {
		const fetchSpy = okFetch(LIST);
		vi.stubGlobal("fetch", fetchSpy);

		await loadSalesPersons({ persist: false });
		expect(localStorage.getItem("sales_persons_storage")).toBeNull();

		await loadSalesPersons({ persist: true });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(localStorage.getItem("sales_persons_storage") as string)).toEqual(LIST);
	});

	it("writes storage when a persisting caller joins a request in flight", async () => {
		const fetchSpy = okFetch(LIST);
		vi.stubGlobal("fetch", fetchSpy);

		const [, joined] = await Promise.all([
			loadSalesPersons({ persist: false }),
			loadSalesPersons({ persist: true }),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(joined).toEqual(LIST);
		expect(JSON.parse(localStorage.getItem("sales_persons_storage") as string)).toEqual(LIST);
	});

	it("persists only when asked", async () => {
		vi.stubGlobal("fetch", okFetch(LIST));

		await loadSalesPersons();
		expect(localStorage.getItem("sales_persons_storage")).toBeNull();

		resetSalesPersonsCache();
		await loadSalesPersons({ persist: true });
		expect(JSON.parse(localStorage.getItem("sales_persons_storage") as string)).toEqual(LIST);
	});
});
