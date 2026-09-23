/**
 * `call()`'s object form does NOT infer `intent` from the registry the way the
 * positional form does -- `normalizeOptions` passes the object through verbatim
 * and `validateIntent` then rejects `undefined !== "read"`. A call site that
 * forgets it throws before any request is made, which a broad catch renders
 * indistinguishable from "offline". That shipped once; this pins it.
 */

import { describe, it, expect, vi } from "vitest";
import { call, MethodPolicyError } from "@/utils/call";

const ARGS = { pos_profile: { name: "P", warehouse: "W" }, items_data: [{ item_code: "X" }] };

describe("object-form get_items_details reaches the wire", () => {
	it("with intent:'read' — fetch is actually invoked", async () => {
		const fetchSpy = vi.fn().mockResolvedValue({
			ok: true, type: "basic", json: async () => ({ message: [] }),
		});
		vi.stubGlobal("fetch", fetchSpy);
		const controller = new AbortController();
		await call({
			method: "pospire.pospire.api.posapp.get_items_details",
			intent: "read",
			args: ARGS,
			abortSignal: controller.signal,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toContain("get_items_details");
	});

	it("without intent — throws before any fetch", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await expect(
			call({ method: "pospire.pospire.api.posapp.get_items_details", args: ARGS } as never),
		).rejects.toBeInstanceOf(MethodPolicyError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
