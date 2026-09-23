/**
 * Tracked eventBus registration.
 *
 * The bus is `mitt`, whose `off(type)` with no handler argument empties the
 * ENTIRE listener array for that type — not just the caller's. Every
 * `eventBus.off("register_pos_profile")` in a component's beforeUnmount was
 * therefore deleting Navbar's, Invoice's and Customer's listeners too, so
 * navigating POS -> Dashboard -> POS left surviving components deaf to events
 * they had legitimately subscribed to.
 *
 * Register through `this.onBus(event, handler)` instead of
 * `this.eventBus.on(...)`: the pair is remembered and torn down with the exact
 * handler reference on unmount, which mitt splices out individually.
 */
export default {
	beforeCreate() {
		this._busListenersDisposed = false;
	},

	methods: {
		/**
		 * Subscribe for this component's lifetime. Returns the handler so
		 * callers can hold onto it if they need to unsubscribe early.
		 *
		 * Most callers register from inside `created() { this.$nextTick(...) }`,
		 * so a component unmounted in the same tick runs its teardown BEFORE the
		 * deferred callback fires. Without the disposed flag that late `onBus`
		 * would re-seed the array and attach a listener nothing will ever
		 * remove — a leak that survives for the life of the bus.
		 */
		onBus(event, handler) {
			if (this._busListenersDisposed) return handler;
			if (!this._busListeners) this._busListeners = [];
			this._busListeners.push([event, handler]);
			this.eventBus.on(event, handler);
			return handler;
		},
	},

	beforeUnmount() {
		// Flip the flag and detach the list before unsubscribing: a handler
		// invoked during teardown must not be able to register a new listener
		// into an array we are mid-iteration on.
		this._busListenersDisposed = true;
		const listeners = this._busListeners || [];
		this._busListeners = null;

		for (const [event, handler] of listeners) {
			this.eventBus.off(event, handler);
		}
	},
};
