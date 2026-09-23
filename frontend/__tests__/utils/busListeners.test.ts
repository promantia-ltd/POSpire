/**
 * Guards for the tracked-eventBus mixin.
 *
 * The bug this replaced: components tore down with `eventBus.off(type)` and no
 * handler argument. mitt empties the WHOLE listener array for that type, so one
 * component unmounting deleted every other component's subscription — Navbar
 * went deaf to `register_pos_profile` after the first POS → Dashboard hop.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createApp, h, nextTick } from "vue";
import busPlugin, { eventBus } from "@/utils/bus";
import busListeners from "@/utils/busListeners";

/** Live listener count for an event, straight off mitt's internal map. */
function listenerCount(event: string): number {
	return (eventBus.all.get(event) || []).length;
}

function mount(options: Record<string, unknown>) {
	const app = createApp({ render: () => h("div"), ...options });
	app.use(busPlugin);
	app.mount(document.createElement("div"));
	return app;
}

/** Registers on `created`, the way every converted component does. */
function immediateComponent(event: string, spy: string[], tag: string) {
	return {
		mixins: [busListeners],
		created(this: any) {
			this.onBus(event, () => spy.push(tag));
		},
	};
}

/** Registers from inside `$nextTick`, the deferred shape used by Navbar,
 *  Pay, Customer, Payments, Pos and the offer/coupon components. */
function deferredComponent(event: string, spy: string[], tag: string) {
	return {
		mixins: [busListeners],
		created(this: any) {
			this.$nextTick(() => {
				this.onBus(event, () => spy.push(tag));
			});
		},
	};
}

beforeEach(() => {
	eventBus.all.clear();
});

describe("busListeners mixin", () => {
	it("unmounting one component leaves its siblings subscribed", async () => {
		const seen: string[] = [];
		const navbar = mount(immediateComponent("register_pos_profile", seen, "navbar"));
		const items = mount(immediateComponent("register_pos_profile", seen, "items"));
		expect(listenerCount("register_pos_profile")).toBe(2);

		items.unmount();
		await nextTick();

		// The whole point: exactly the unmounted component's handler is gone.
		expect(listenerCount("register_pos_profile")).toBe(1);
		eventBus.emit("register_pos_profile", {});
		expect(seen).toEqual(["navbar"]);

		navbar.unmount();
	});

	it("does not accumulate handlers across repeated mount/unmount cycles", async () => {
		const seen: string[] = [];

		for (let i = 0; i < 3; i++) {
			const app = mount(immediateComponent("refresh_items", seen, `cycle${i}`));
			expect(listenerCount("refresh_items")).toBe(1);
			app.unmount();
			await nextTick();
			expect(listenerCount("refresh_items")).toBe(0);
		}

		// A leak here would fan one emit out to three handlers — the mechanism
		// that multiplies duplicate API calls after route navigation.
		eventBus.emit("refresh_items", {});
		expect(seen).toEqual([]);
	});

	it("drops a deferred registration whose component unmounted first", async () => {
		const seen: string[] = [];
		const app = mount(deferredComponent("register_pos_profile", seen, "late"));

		// Unmount lands before the queued $nextTick callback runs.
		app.unmount();
		await nextTick();
		await nextTick();

		expect(listenerCount("register_pos_profile")).toBe(0);
		eventBus.emit("register_pos_profile", {});
		expect(seen).toEqual([]);
	});

	it("still cleans up a deferred registration that did land before unmount", async () => {
		const seen: string[] = [];
		const app = mount(deferredComponent("update_customer", seen, "deferred"));

		await nextTick();
		expect(listenerCount("update_customer")).toBe(1);

		app.unmount();
		await nextTick();
		expect(listenerCount("update_customer")).toBe(0);
		eventBus.emit("update_customer", {});
		expect(seen).toEqual([]);
	});
});
