/**
 * Log shipper tests.
 *
 * Covers: error capture persists + dedupes, idle sync cycles are dropped,
 * a failed upload keeps entries for the next flush, and batches respect
 * the server's per-request entry cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callMock = vi.fn();
vi.mock("@/utils/call", () => ({ call: (...args: unknown[]) => callMock(...args) }));

import { db } from "@/offline/db";
import connectivity from "@/offline/connectivity";
import {
	captureClientError,
	flushLogs,
	getPendingCount,
	installErrorCapture,
} from "@/offline/log-shipper";

import {
	setupOfflineStorage,
	teardownOfflineStorage,
} from "../helpers/offline-fixture";

beforeEach(async () => {
	await setupOfflineStorage();
	callMock.mockReset();
	callMock.mockResolvedValue({ ok: true });
	vi.spyOn(connectivity, "isOnline").mockReturnValue(true);
	vi.spyOn(connectivity, "drainLog").mockReturnValue([]);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await teardownOfflineStorage();
});

function sentEntries(): Record<string, unknown>[] {
	return callMock.mock.calls.flatMap(([opts]) =>
		JSON.parse((opts as { args: { entries: string } }).args.entries),
	);
}

describe("captureClientError", () => {
	it("persists an entry with error details and context", async () => {
		await captureClientError(new TypeError("boom"), "promise");
		expect(await getPendingCount()).toBe(1);

		await flushLogs();
		const [entry] = sentEntries();
		expect(entry.kind).toBe("client_error");
		expect(entry.source).toBe("promise");
		expect(entry.error_name).toBe("TypeError");
		expect(entry.message).toBe("boom");
		expect(typeof entry.device_id).toBe("string");
	});

	it("collapses identical errors inside the dedupe window", async () => {
		const err = new Error("same");
		await captureClientError(err, "window");
		await captureClientError(err, "window");
		await captureClientError(err, "window");
		expect(await getPendingCount()).toBe(1);
	});

	it("wraps the Vue errorHandler and still calls the previous one", async () => {
		const previous = vi.fn();
		const app = { config: { errorHandler: previous } };
		installErrorCapture(app);
		app.config.errorHandler(new Error("render"), null, "render function");
		expect(previous).toHaveBeenCalledOnce();
		await vi.waitFor(async () => expect(await getPendingCount()).toBe(1));
	});
});

describe("flushLogs", () => {
	it("ships notable sync cycles and drops idle ones", async () => {
		const base = {
			started_at: 1,
			finished_at: 2,
			queue_depth_start: 0,
			moved_to_needs_review: {},
			longest_latency_ms: 0,
			next_wake_ms: null,
			leader: true,
		};
		await db.metadata.put({
			key: "sync_log",
			value: [
				{ ...base, cycle_id: "idle", drained: 0 },
				{ ...base, cycle_id: "busy", drained: 3 },
				{ ...base, cycle_id: "review", drained: 0, moved_to_needs_review: { stock_shortage: 1 } },
			],
			updated_at: Date.now(),
		});

		await flushLogs();
		const ids = sentEntries().map((e) => e.cycle_id);
		expect(ids).toEqual(["busy", "review"]);
	});

	it("keeps entries when the upload fails", async () => {
		await captureClientError(new Error("a"), "vue");
		callMock.mockRejectedValueOnce(new Error("offline"));

		expect(await flushLogs()).toBe(0);
		expect(await getPendingCount()).toBe(1);

		expect(await flushLogs()).toBe(1);
		expect(await getPendingCount()).toBe(0);
	});

	it("does not call the server while offline", async () => {
		vi.mocked(connectivity.isOnline).mockReturnValue(false);
		await captureClientError(new Error("a"), "vue");
		await flushLogs();
		expect(callMock).not.toHaveBeenCalled();
		expect(await getPendingCount()).toBe(1);
	});

	it("splits into batches of at most 100 entries", async () => {
		const transitions = Array.from({ length: 150 }, (_, i) => ({
			at: i,
			from: "online" as const,
			to: "offline" as const,
			reason: "test",
			rttMs: null,
		}));
		vi.mocked(connectivity.drainLog).mockReturnValueOnce(transitions);

		expect(await flushLogs()).toBe(150);
		const sizes = callMock.mock.calls.map(
			([opts]) => JSON.parse((opts as { args: { entries: string } }).args.entries).length,
		);
		expect(sizes).toEqual([100, 50]);
	});
});
