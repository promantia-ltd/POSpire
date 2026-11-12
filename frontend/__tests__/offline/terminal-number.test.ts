import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	TerminalDateError,
	TerminalNotReadyError,
	applyClaim,
	consumeNumber,
	currentNumber,
	formatTerminalNumber,
	isCurrentNumber,
	parseTerminalNumber,
} from "@/offline/terminal-number";
import { readDeviceKeys, saveDeviceKey } from "@/offline/device-keys";

import { setupOfflineStorage, teardownOfflineStorage } from "../helpers/offline-fixture";

const P = "Main";
const fy26 = { code: "26", start: "2026-04-01", end: "2027-03-31" };
const fy27 = { code: "27", start: "2027-04-01", end: "2028-03-31" };
const claim = (last = 77, fys = [fy26]) => ({ prefix: "T01", fiscal_years: fys, last: { "26": last } });

beforeEach(setupOfflineStorage);
afterEach(teardownOfflineStorage);

describe("terminal-number", () => {
	it("keeps the device key a claim issues, a few per till, newest first", async () => {
		localStorage.clear();
		await applyClaim(P, { ...claim(), device_key: "k1" });
		await applyClaim(P, claim()); // a later claim without a new key keeps it
		expect(readDeviceKeys()).toEqual(["k1"]);
		for (const k of ["k2", "k3", "k4", "k5", "k6", "k2"]) saveDeviceKey(P, k);
		saveDeviceKey("Other Till", "o1");
		expect(readDeviceKeys()).toEqual(["k2", "k6", "k5", "k4", "k3", "o1"]);
		localStorage.clear();
	});

	it("formats and parses strictly", () => {
		const s = formatTerminalNumber("T01", "26", 123);
		expect(s).toBe("T01/26/000123");
		expect(parseTerminalNumber(s)).toEqual({ prefix: "T01", fy: "26", n: 123 });
		expect(parseTerminalNumber("T01/26/000123-1")).toBeNull();
		expect(parseTerminalNumber("T01/26/000123\n")).toBeNull();
		expect(parseTerminalNumber(null)).toBeNull();
	});

	it("throws when the till has no row", async () => {
		const err = await currentNumber(P, "2026-05-01").catch((e) => e);
		expect(err).toBeInstanceOf(TerminalNotReadyError);
		expect(err).not.toBeInstanceOf(TerminalDateError);
	});

	it("reuses an unconsumed number", async () => {
		await applyClaim(P, claim());
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000078");
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000078");
	});

	it("advances on consume and never moves back", async () => {
		await applyClaim(P, claim());
		await consumeNumber(P, "T01/26/000078");
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000079");
		await applyClaim(P, claim(77));
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000079");
	});

	it("tells the unused Pay slot apart from a used number", async () => {
		await applyClaim(P, claim());
		expect(await isCurrentNumber(P, "T01/26/000078")).toBe(true); // Pay slot: Hold keeps it local
		await consumeNumber(P, "T01/26/000078"); // e.g. a payment request used it
		expect(await isCurrentNumber(P, "T01/26/000078")).toBe(false);
		expect(await isCurrentNumber(P, "T02/26/000079")).toBe(false);
		expect(await isCurrentNumber(P, "ACC-SINV-2026-00001")).toBe(false);
	});

	it("ignores numbers with another prefix", async () => {
		await applyClaim(P, claim());
		await consumeNumber(P, "T02/26/000090");
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000078");
	});

	it("needs the fiscal year for the posting date", async () => {
		await applyClaim(P, claim());
		await expect(currentNumber(P, "2027-04-02")).rejects.toBeInstanceOf(TerminalDateError);
		await applyClaim(P, claim(77, [fy26, fy27]));
		expect(await currentNumber(P, "2027-04-02")).toBe("T01/27/000001");
	});

	it("a null prefix wipes the row", async () => {
		await applyClaim(P, claim());
		await applyClaim(P, { prefix: null, fiscal_years: [], last: {} });
		await expect(currentNumber(P, "2026-05-01")).rejects.toBeInstanceOf(TerminalNotReadyError);
	});
});
