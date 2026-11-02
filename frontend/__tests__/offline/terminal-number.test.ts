import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	TerminalNotReadyError,
	applyClaim,
	consumeNumber,
	currentNumber,
	formatTerminalNumber,
	parseTerminalNumber,
} from "@/offline/terminal-number";

import { setupOfflineStorage, teardownOfflineStorage } from "../helpers/offline-fixture";

const P = "Main";
const fy26 = { code: "26", start: "2026-04-01", end: "2027-03-31" };
const fy27 = { code: "27", start: "2027-04-01", end: "2028-03-31" };
const claim = (last = 77, fys = [fy26]) => ({ prefix: "T01", fiscal_years: fys, last: { "26": last } });

beforeEach(setupOfflineStorage);
afterEach(teardownOfflineStorage);

describe("terminal-number", () => {
	it("formats and parses strictly", () => {
		const s = formatTerminalNumber("T01", "26", 123);
		expect(s).toBe("T01/26/000123");
		expect(parseTerminalNumber(s)).toEqual({ prefix: "T01", fy: "26", n: 123 });
		expect(parseTerminalNumber("T01/26/000123-1")).toBeNull();
		expect(parseTerminalNumber("T01/26/000123\n")).toBeNull();
		expect(parseTerminalNumber(null)).toBeNull();
	});

	it("throws when the till has no row", async () => {
		await expect(currentNumber(P, "2026-05-01")).rejects.toBeInstanceOf(TerminalNotReadyError);
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

	it("ignores numbers with another prefix", async () => {
		await applyClaim(P, claim());
		await consumeNumber(P, "T02/26/000090");
		expect(await currentNumber(P, "2026-05-01")).toBe("T01/26/000078");
	});

	it("needs the fiscal year for the posting date", async () => {
		await applyClaim(P, claim());
		await expect(currentNumber(P, "2027-04-02")).rejects.toBeInstanceOf(TerminalNotReadyError);
		await applyClaim(P, claim(77, [fy26, fy27]));
		expect(await currentNumber(P, "2027-04-02")).toBe("T01/27/000001");
	});

	it("a null prefix wipes the row", async () => {
		await applyClaim(P, claim());
		await applyClaim(P, { prefix: null, fiscal_years: [], last: {} });
		await expect(currentNumber(P, "2026-05-01")).rejects.toBeInstanceOf(TerminalNotReadyError);
	});
});
