<template>
	<div class="enhanced-items-container pos-panel-container">
		<v-card class="selection pos-scrollable-content" elevation="2" rounded="lg">
			<v-progress-linear
				:active="loading"
				:indeterminate="loading"
				absolute
				:location="top"
				color="info"
			></v-progress-linear>
			<v-row class="items px-3 py-2">
				<v-col class="pb-0 mb-2">
					<div class="enhanced-search-wrapper">
						<v-icon class="enhanced-search-icon" size="20"
							>mdi-magnify</v-icon
						>
						<v-text-field
							density="compact"
							clearable
							autofocus
							variant="outlined"
							color="primary"
							placeholder="Search by name, code, barcode, serial or batch number..."
							bg-color="surface"
							hide-details
							v-model="debounce_search"
							@keydown.esc="esc_event"
							@keydown.enter="search_onchange"
							ref="debounce_search"
							class="enhanced-search-field"
						></v-text-field>
					</div>
				</v-col>
				<v-col cols="3" class="pb-0 mb-2" v-if="pos_profile.posa_input_qty">
					<v-text-field
						density="compact"
						variant="outlined"
						color="primary"
						:label="__('QTY')"
						bg-color="surface"
						hide-details
						v-model.number="qty"
						type="number"
						@keydown.enter="enter_event"
						@keydown.esc="esc_event"
					></v-text-field>
				</v-col>
				<v-col cols="2" class="pb-0 mb-2" v-if="pos_profile.posa_new_line">
					<v-checkbox
						v-model="new_line"
						color="accent"
						value="true"
						label="NLine"
						density="default"
						hide-details
					></v-checkbox>
				</v-col>
				<v-col cols="12" class="pt-0 mt-0">
					<div fluid class="items enhanced-scrollbar" v-if="items_view == 'card'">
						<!-- Empty State for Card View -->
						<div
							v-if="!loading && filtered_items.length === 0"
							class="enhanced-empty-state enhanced-fade-in"
						>
							<v-icon size="64" color="grey-lighten-1"
								>mdi-package-variant-closed</v-icon
							>
							<div class="enhanced-empty-state-title">
								{{
									first_search
										? "No items found for your search"
										: "No items to display"
								}}
							</div>
							<div class="enhanced-empty-state-description">
								{{
									first_search
										? `Try adjusting your search "${first_search}" or select a different category.`
										: "Items will appear here once they are configured in your POS profile and have stock available."
								}}
							</div>
							<button
								v-if="first_search"
								@click="clearSearch"
								class="enhanced-empty-state-action"
							>
								Clear Search
							</button>
						</div>
						<!-- Items Grid -->
						<v-row
							v-else
							density="compact"
							class="overflow-y-auto pa-2 items-grid-scroll"
						>
							<v-col
								v-for="(item, idx) in filtered_items"
								:key="idx"
								xl="3"
								lg="3"
								md="4"
								sm="6"
								cols="6"
								class="pa-2"
							>
								<v-card
									hover
									@click="add_item(item, idx)"
									class="pospire-product-card hover-vibrant ripple-effect"
									:class="{
										'out-of-stock':
											stockContextReliable && item.actual_qty <= 0,
										'item-selected': selectedItemIdx === idx,
									}"
								>
									<!-- 1:1 Square Image Container -->
									<div class="pospire-product-image-wrapper">
										<ItemImage
											:src="item.image"
											:aspect-ratio="1"
											cover
											class="pospire-product-image"
										/>

										<!--
											Stock Badge Overlay. Rendered only when the
											stock numbers came from a recent online fetch
											(stockContextReliable). While offline /
											degraded the displayed actual_qty is whatever
											was last hydrated from cache and would lie
											about every item being OUT, so we drop the
											badge entirely rather than mislead the
											cashier. The card itself is still tappable.
										-->
										<div
											v-if="stockContextReliable"
											class="pospire-stock-badge"
											:class="{
												'badge-success': item.actual_qty > 5,
												'badge-warning animate-pulse':
													item.actual_qty > 0 && item.actual_qty <= 5,
												'badge-error animate-heartbeat':
													item.actual_qty <= 0,
											}"
										>
											{{
												item.actual_qty <= 0
													? "OUT"
													: item.actual_qty <= 5
													? "LOW"
													: "STOCK"
											}}
										</div>
									</div>

									<!-- Product Info -->
									<div class="pospire-product-info">
										<!-- HEADLINE TEXT: 16px Semibold -->
										<div class="pospire-product-name" :title="item.item_name">
											{{ item.item_name }}
										</div>

										<!-- BODY TEXT: 14px Medium -->
										<div class="pospire-product-price">
											{{ currencySymbol(item.currency) || "" }}
											{{ formatCurrency(item.rate) || 0 }}
										</div>

										<!-- SUPPORT TEXT: 12px Regular -->
										<div
											v-if="stockContextReliable"
											class="pospire-product-stock"
										>
											<span
												class="stock-dot"
												:class="{
													'dot-success': item.actual_qty > 5,
													'dot-warning':
														item.actual_qty > 0 &&
														item.actual_qty <= 5,
													'dot-error': item.actual_qty <= 0,
												}"
											></span>
											{{ formatFloat(item.actual_qty) || 0 }}
											{{ item.stock_uom || "" }}
										</div>
									</div>
								</v-card>
							</v-col>
						</v-row>
					</div>
					<div fluid class="items enhanced-scrollbar" v-if="items_view == 'list'">
						<!-- Empty State for List View -->
						<div
							v-if="!loading && filtered_items.length === 0"
							class="enhanced-empty-state enhanced-fade-in"
						>
							<v-icon size="64" color="grey-lighten-1"
								>mdi-format-list-bulleted</v-icon
							>
							<div class="enhanced-empty-state-title">
								{{
									first_search
										? "No items match your search"
										: "No items available"
								}}
							</div>
							<div class="enhanced-empty-state-description">
								{{
									first_search
										? `No results found for "${first_search}". Try different keywords or check your spelling.`
										: "Configure items in your POS profile to see them listed here."
								}}
							</div>
							<button
								v-if="first_search"
								@click="clearSearch"
								class="enhanced-empty-state-action"
							>
								Clear Search
							</button>
						</div>
						<!-- Data Table -->
						<div
							v-else
							class="my-0 py-0 overflow-y-auto enhanced-data-table items-list-scroll"
						>
							<v-data-table
								:headers="getItemsHeaders()"
								:items="filtered_items"
								item-key="item_code"
								item-value="item-"
								class="elevation-1 pospire-items-table"
								:items-per-page="itemsPerPage"
								hide-default-footer
								@click:row="click_item_row"
								:row-props="getRowProps"
							>
								<template v-slot:item.rate="{ item }">
									<span class="item-rate-text font-weight-medium"
										>{{ currencySymbol(item.currency) }}
										{{ formatCurrency(item.rate) }}</span
									>
								</template>
								<template v-slot:item.actual_qty="{ item }">
									<span
										v-if="stockContextReliable"
										class="font-weight-medium"
										:style="getStockColorStyle(item.actual_qty)"
									>
										{{ formatFloat(item.actual_qty) }}
									</span>
									<!--
										Offline / degraded: drop the number entirely
										rather than show a stale 0 next to every item.
										Em-dash matches Frappe's "no value" convention.
									-->
									<span v-else class="text-medium-emphasis">—</span>
								</template>
								<template v-slot:item.item_name="{ item }">
									<div class="d-flex align-center">
										<v-avatar size="32" class="mr-2">
											<ItemImage :src="item.image" compact />
										</v-avatar>
										<div>
											<div class="font-weight-medium">
												{{ item.item_name }}
											</div>
											<div class="text-caption text-grey-darken-1">
												{{ item.item_code }}
											</div>
										</div>
									</div>
								</template>
							</v-data-table>
						</div>
					</div>
				</v-col>
			</v-row>
		</v-card>
		<v-card class="enhanced-controls mb-0 pos-footer-section" elevation="2">
			<v-row no-gutters align="center" justify="center" class="pa-1 mt-2">
				<v-col cols="12" class="mb-2">
					<v-select
						:items="items_group"
						:label="__('Items Group')"
						density="compact"
						variant="outlined"
						hide-details
						v-model="item_group"
						v-on:update:model-value="search_onchange"
						prepend-inner-icon="mdi-tag-outline"
						color="grey-darken-2"
					>
						<template v-slot:selection="{ item }">
							<v-chip size="small" variant="tonal" class="pospire-chip-neutral">
								{{ item.title }}
							</v-chip>
						</template>
					</v-select>
				</v-col>

				<!-- Enhanced Controls Row -->
				<v-col cols="12">
					<v-row
						no-gutters
						align="center"
						class="enhanced-bottom-controls flex-nowrap pr-4"
					>
						<v-col cols="4">
							<div class="pospire-view-toggle">
								<button
									class="btn-toggle"
									:class="{ active: items_view === 'list' }"
									@click="items_view = 'list'"
								>
									<v-icon size="16">mdi-format-list-bulleted</v-icon>
									<span class="enhanced-btn-label">{{ __("List") }}</span>
								</button>
								<button
									class="btn-toggle"
									:class="{ active: items_view === 'card' }"
									@click="items_view = 'card'"
								>
									<v-icon size="16">mdi-view-grid-outline</v-icon>
									<span class="enhanced-btn-label">{{ __("Card") }}</span>
								</button>
							</div>
						</v-col>

						<v-col cols="4">
							<v-btn
								block
								variant="flat"
								@click="show_coupons"
								class="btn-secondary"
								prepend-icon="mdi-ticket-percent-outline"
							>
								<v-badge
									:content="couponsCount"
									color="success"
									:model-value="couponsCount > 0"
									inline
								>
									<span class="enhanced-btn-label">{{ __("Coupons") }}</span>
								</v-badge>
							</v-btn>
						</v-col>

						<v-col cols="4">
							<v-btn
								block
								variant="flat"
								@click="show_offers"
								class="btn-secondary"
								prepend-icon="mdi-sale"
							>
								<v-badge
									:content="`${offersCount}/${appliedOffersCount}`"
									color="success"
									:model-value="offersCount > 0"
									inline
								>
									<span class="enhanced-btn-label">{{ __("Offers") }}</span>
								</v-badge>
							</v-btn>
						</v-col>
					</v-row>
				</v-col>
			</v-row>
		</v-card>
	</div>
</template>

<script>
import { call, unwrapStale, MethodPolicyError } from "@/utils/call";
import { UnregisteredMethod } from "@/utils/call-registry";
import { toast } from "vue3-toastify";
import { storeToRefs } from "pinia";
import format from "@/utils/format";
import { playSound } from "@/utils/sounds";
import { useConnectivityStore } from "@/stores/connectivity";
import _ from "lodash";
import onScan from "onscan.js";
import ItemImage from "./ItemImage.vue";
import busListeners from "@/utils/busListeners";
export default {
	mixins: [format, busListeners],
	components: { ItemImage },
	setup() {
		// Expose `connectionQuality` so the template and the customer
		// watcher can gate on it. The stock badges (OUT / LOW / STOCK)
		// only mean something when actual_qty came from a recent online
		// fetch — while offline / degraded the displayed value is
		// whatever localStorage cached, which a previous customer-switch
		// fallback path could have populated as 0 across the board.
		// Customer change is also gated: re-fetching get_items offline
		// throws and used to leave the grid in a worse state than just
		// keeping the last-known catalog.
		const connectivity = useConnectivityStore();
		const { connectionQuality } = storeToRefs(connectivity);
		return { connectionQuality };
	},
	data: () => ({
		pos_profile: "",
		flags: {},
		items_view: "list",
		item_group: "ALL",
		loading: false,
		// True only once get_items_details has filled real quantities. Until
		// then actual_qty is 0 by default, not by observation. Reset whenever a
		// catalog or enrichment request starts, so a hung request cannot leave
		// stale quantities looking authoritative.
		stock_details_fresh: false,
		// Monotonic token: only the newest enrichment response may mark the
		// grid fresh, otherwise a slow earlier reply marks the wrong generation.
		stock_request_seq: 0,
		// Separate token for the catalog fetch itself. Two get_items() calls can
		// resolve out of order, and without this an older response replaces the
		// newer catalog and then launches enrichment for it — marking a stale
		// item list fresh.
		catalog_request_seq: 0,
		items_group: ["ALL"],
		items: [],
		search: "",
		first_search: "",
		// What is physically in the search box right now.
		//
		// It has to be a separate, synchronously-written field. A scanner
		// types straight into the DOM input, and `first_search` only catches
		// up 200ms later via the debounce -- so while a scan is in flight
		// Vuetify's model (which reads the bound value, not the element)
		// believes the box is empty. Clearing then patches null over null,
		// Vue skips the update as a no-op, and the scanner's characters stay
		// in the element and accumulate into the next scan.
		raw_search: "",
		itemsPerPage: 1000,
		offersCount: 0,
		appliedOffersCount: 0,
		couponsCount: 0,
		appliedCouponsCount: 0,
		customer_price_list: null,
		customer: null,
		new_line: false,
		qty: 1,
		selectedItemIdx: null,
		selectedListItemCode: null,
	}),

	watch: {
		filtered_items(new_value, old_value) {
			if (!this.pos_profile.pose_use_limit_search) {
				if (new_value.length != old_value.length) {
					this.update_items_details(new_value);
				}
			}
		},
		customer() {
			// When offline, a customer change can't usefully re-query the
			// catalog: the customer-keyed cache entry will miss, and any
			// fallback we attempted historically risked persisting bad
			// data into localStorage — which then poisons every subsequent
			// get_items hydration even after we reconnect. Skip the
			// refetch in that state and keep the existing items list
			// as-is. The connectionQuality watcher below handles the
			// "customer was switched while offline, now back online"
			// case by re-running get_items the moment we reconnect, so
			// the grid catches up with the right customer-keyed prices
			// and fresh actual_qty values then.
			if (this.connectionQuality !== "online") {
				return;
			}
			this.get_items();
		},
		/**
		 * Refresh the catalog the instant we transition back to online.
		 * The customer watcher's offline early-return means a customer
		 * switch made while offline never triggered a refetch — so the
		 * grid still has the previous customer's prices and possibly
		 * stale actual_qty. Firing get_items() on reconnect closes that
		 * gap: fresh stock numbers populate (and re-enable the OUT /
		 * LOW / STOCK badges via stockContextReliable), and the current
		 * customer's price-list-keyed cache entry is repopulated for
		 * the next offline window.
		 */
		connectionQuality(newVal, oldVal) {
			if (newVal === "online" && oldVal !== "online") {
				this.get_items();
			}
		},
		new_line() {
			this.eventBus.emit("set_new_line", this.new_line);
		},
		/**
		 * Auto-add on any exact barcode/serial/batch match, so a typed or
		 * pasted code works without pressing Enter. This covers input the
		 * hardware-scanner path does not: onScan rejects anything slower than
		 * avgTimeByChar or shorter than minLength, i.e. everything a human
		 * enters. enter_event() no-ops unless it finds an exact match and
		 * clears first_search on a successful add, so this cannot loop or
		 * double-fire on partial input.
		 *
		 * It cannot double-add a scan either: handle_scan() sets first_search
		 * and calls enter_event() synchronously, so by the time this watcher
		 * flushes, first_search is back to null and enter_event() bails.
		 */
		first_search(newValue) {
			if (!newValue) {
				return;
			}
			this.enter_event();
		},
	},

	methods: {
		show_offers() {
			this.eventBus.emit("show_offers", "true");
		},
		show_coupons() {
			this.eventBus.emit("show_coupons", "true");
		},
		get_items() {
			// Invalidate BEFORE the profile guard: an enrichment request started
			// against the previous catalog must not survive this call and mark a
			// newer grid fresh. Bumping the token supersedes any in-flight one.
			this.stock_request_seq += 1;
			this.stock_details_fresh = false;
			// The token above stops a stale response being applied; this frees
			// the connection it is still holding.
			this.abortStockEnrichment();
			const catalogSeq = ++this.catalog_request_seq;
			if (!this.pos_profile) {
				return;
			}
			const vm = this;
			this.loading = true;
			let search = this.get_search(this.first_search);
			let gr = "";
			let sr = "";
			if (search) {
				sr = search;
			}
			if (vm.item_group != "ALL") {
				gr = vm.item_group.toLowerCase();
			}

			// Check for cached items in localStorage
			if (
				vm.pos_profile.posa_local_storage &&
				localStorage.items_storage &&
				!vm.pos_profile.pose_use_limit_search
			) {
				try {
					// Defensive unwrap: a previous build wrote the
					// StaleReadResult wrapper { data, stale, cachedAt } here
					// instead of the bare items array. Strip it on read so
					// devices already on the bad cache shape recover the next
					// time they boot.
					const hydrated = unwrapStale(
						JSON.parse(localStorage.getItem("items_storage")),
					);
					vm.items = Array.isArray(hydrated) ? hydrated : [];
					// Strip zero-stock items from the hydrated cache immediately so they
					// are never shown, even before update_items_details returns.
					if (
						vm.pos_profile.posa_display_items_in_stock &&
						!vm.pos_profile.posa_auto_stock_reconcile
					) {
						vm.items = vm.items.filter((item) => item.actual_qty > 0);
					}
					this.eventBus.emit("set_all_items", vm.items);
					vm.loading = false;

					// Immediately update stock for cached items
					vm.$nextTick(() => {
						// The token can move between queueing this callback and
						// running it — a newer get_items() or an unmount, both of
						// which bump it. Re-check rather than start work for a
						// catalogue that is no longer current.
						if (catalogSeq !== vm.catalog_request_seq) return;
						if (
							!vm.pos_profile.pose_use_limit_search &&
							vm.filtered_items.length > 0
						) {
							vm.update_items_details(vm.filtered_items);
						}
					});
				} catch (e) {
					vm.loading = false;
				}
			}

			// Always fetch fresh data from server
			call("pospire.pospire.api.posapp.get_items", {
				pos_profile: vm.pos_profile,
				price_list: vm.customer_price_list,
				item_group: gr,
				search_value: sr,
				customer: vm.customer,
			}).then((r) => {
				// Superseded by a newer get_items(): dropping this response keeps
				// an older catalog from replacing a newer one and then being
				// enriched under a fresh token.
				if (catalogSeq !== vm.catalog_request_seq) return;
				if (r) {
					// `get_items` is registered as offline:true with a TTL.
					// On a stale-cache hit call() returns a StaleReadResult
					// wrapper. Unwrap once and use the bare array everywhere
					// — including the localStorage write below. Persisting the
					// wrapper object would make subsequent boots set
					// `vm.items = wrapper`, which breaks every downstream
					// `.filter / .find / .forEach` on the items list.
					const items = unwrapStale(r);
					vm.items = Array.isArray(items) ? items : [];
					vm.eventBus.emit("set_all_items", vm.items);
					vm.loading = false;

					// Update localStorage if enabled. Always store the
					// unwrapped array, never the wrapper.
					if (
						vm.pos_profile.posa_local_storage &&
						!vm.pos_profile.pose_use_limit_search
					) {
						try {
							localStorage.setItem("items_storage", JSON.stringify(items));
						} catch (e) {}
					}

					// Immediately update stock quantities
					vm.$nextTick(() => {
						// Same re-check as the cached-hydration path above.
						if (catalogSeq !== vm.catalog_request_seq) return;
						if (
							!vm.pos_profile.pose_use_limit_search &&
							vm.filtered_items.length > 0
						) {
							vm.update_items_details(vm.filtered_items);
						}
					});

					if (vm.pos_profile.pose_use_limit_search) {
						vm.enter_event();
					}
				}
			}).catch(() => {
				// Offline (OfflineReadUnavailable) or transport failure. The
				// localStorage fallback above (if enabled) has already populated
				// the grid; swallow so we don't surface an unhandled rejection.
				vm.loading = false;
			});
		},
		async get_items_groups() {
			if (!this.pos_profile) {
				return;
			}
			// Reset before populating so repeated calls (e.g. mid-shift profile
			// reload) don't accumulate duplicate entries. Derive the reset value
			// from data() rather than hardcoding so the two stay in sync.
			this.items_group = this.$options.data.call(this).items_group;
			if (this.pos_profile.item_groups.length > 0) {
				this.pos_profile.item_groups.forEach((element) => {
					if (element.item_group !== "All Item Groups") {
						this.items_group.push(element.item_group);
					}
				});
			} else {
				const vm = this;
				// `get_items_groups` is offline:true, so on a stale-cache hit
				// call() returns a StaleReadResult wrapper. Unwrap before
				// iterating, and swallow OfflineReadUnavailable on cold cache
				// (cashier sees the empty group filter, which is benign — the
				// fallback path above using pos_profile.item_groups is the
				// preferred source when configured).
				let groups = null;
				try {
					groups = unwrapStale(
						await call("pospire.pospire.api.posapp.get_items_groups", {}),
					);
				} catch {
					return;
				}
				if (Array.isArray(groups)) {
					groups.forEach((element) => {
						vm.items_group.push(element.name);
					});
				}
			}
		},
		getItemsHeaders() {
			const items_headers = [
				{
					title: __("Name"),
					align: "start",
					sortable: true,
					key: "item_name",
				},
				{
					title: __("Code"),
					align: "start",
					sortable: true,
					key: "item_code",
				},
				{ title: __("Rate"), key: "rate", align: "start" },
				{ title: __("Available QTY"), key: "actual_qty", align: "start" },
				{ title: __("UOM"), key: "stock_uom", align: "start" },
			];
			if (!this.pos_profile.posa_display_item_code) {
				items_headers.splice(1, 1);
			}

			return items_headers;
		},
		getRowProps({ item }) {
			return {
				class: this.selectedListItemCode === item.item_code ? "list-item-selected" : "",
			};
		},
		click_item_row(event, { item }) {
			this.selectedListItemCode = item.item_code;
			setTimeout(() => {
				this.selectedListItemCode = null;
			}, 400);
			this.add_item(item, null);
		},
		add_item(item, idx = null) {
			if (idx !== null) {
				this.selectedItemIdx = idx;
				setTimeout(() => {
					this.selectedItemIdx = null;
				}, 400);
			}

			item = { ...item };
			if (item.has_variants) {
				this.eventBus.emit("open_variants_model", [item, this.items]);
			} else {
				if (!item.qty || item.qty === 1) {
					item.qty = Math.abs(this.qty);
				}
				if (
					this.pos_profile.posa_use_delivery_charges &&
					this.pos_profile.posa_auto_set_delivery_charges
				) {
					this.eventBus.emit("auto_set_delivery_charge");
				}

				this.eventBus.emit("add_item", item);
				this.qty = 1;
			}
		},

		/**
		 * Add the item the current search term exactly identifies, if any.
		 *
		 * Returns TRUE when an item was added, so callers (handle_scan in
		 * particular) can tell a real miss from a no-op and report it.
		 *
		 * The comparisons run against a local `term` rather than `this.search`.
		 * `this.search` is assigned as a side effect of evaluating the
		 * `filtered_items` computed, so reading it here made the result depend
		 * on when that computed last re-evaluated.
		 */
		enter_event() {
			let match = false;
			// Read filtered_items first: evaluating it is also what populates
			// this.flags.serial_no / batch_no consulted further down.
			if (!this.filtered_items.length || !this.first_search) {
				return match;
			}
			const term = this.get_search(this.first_search);
			const qty = this.get_item_qty(this.first_search);
			const new_item = { ...this.filtered_items[0] };
			new_item.qty = flt(qty);
			new_item.item_barcode.forEach((element) => {
				if (term == element.barcode) {
					new_item.uom = element.posa_uom;
					match = true;
				}
			});
			if (
				!new_item.to_set_serial_no &&
				new_item.has_serial_no &&
				this.pos_profile.posa_search_serial_no
			) {
				new_item.serial_no_data.forEach((element) => {
					if (term && element.serial_no == term) {
						new_item.to_set_serial_no = this.first_search;
						match = true;
					}
				});
			}
			if (this.flags.serial_no) {
				new_item.to_set_serial_no = this.flags.serial_no;
			}
			if (
				!new_item.to_set_batch_no &&
				new_item.has_batch_no &&
				this.pos_profile.posa_search_batch_no
			) {
				new_item.batch_no_data.forEach((element) => {
					if (term && element.batch_no == term) {
						new_item.to_set_batch_no = this.first_search;
						new_item.batch_no = this.first_search;
						match = true;
					}
				});
			}
			if (this.flags.batch_no) {
				new_item.to_set_batch_no = this.flags.batch_no;
			}
			if (match) {
				this.add_item(new_item);
				// reset_search() cancels the pending debounced write before
				// clearing. The old code assigned `this.debounce_search = null`
				// here, which went back through the 200ms debounce -- so the
				// clear was itself deferred, and the next scan's keystrokes
				// simply re-armed the timer and replaced it. That is why the
				// previous code was still sitting in the box when the second
				// scan arrived.
				this.reset_search();
				this.qty = 1;
				this.$refs.debounce_search?.focus();
			}
			return match;
		},
		/**
		 * Clear the search box now, not in 200ms. Cancelling `_applySearch`
		 * first is the important part: without it a write scheduled from an
		 * earlier keystroke lands after the clear and resurrects the term.
		 */
		reset_search() {
			this._applySearch.cancel();
			this.raw_search = "";
			this.search = null;
			this.first_search = null;
			this.flags.serial_no = null;
			this.flags.batch_no = null;
		},
		search_onchange() {
			// onScan is mid-burst, so this Enter is almost certainly the
			// scanner's suffix key. Let the scan callback finish the job --
			// running the manual path too would add the item twice, once now
			// and once when handle_scan() fires. If the burst turns out to
			// have been fast human typing, onScanError replays it.
			if (this.scan_in_progress()) {
				this._deferred_enter = true;
				return;
			}
			this.run_search();
		},
		run_search() {
			// Enter must act on what is in the box right now. Without the
			// flush this ran against the previous term, because the current
			// one was still sitting in the 200ms debounce.
			this._applySearch.flush();
			if (this.pos_profile.pose_use_limit_search) {
				this.get_items();
			} else {
				this.enter_event();
			}
		},
		/**
		 * TRUE while onScan is accumulating characters -- i.e. between the
		 * first character of a burst and the moment it is validated as a scan
		 * (or rejected as typing). `firstCharTime` is set on the first
		 * accumulated character and zeroed by onScan's own reinitialize.
		 */
		scan_in_progress() {
			return !!document.scannerDetectionData?.vars?.firstCharTime;
		},
		/**
		 * TRUE when `code` is a weighing-scale barcode.
		 *
		 * The emptiness check matters: posa_scale_barcode_start is an Int, so
		 * an unset profile yields 0 (or null), and `"0812...".startsWith(0)`
		 * is TRUE -- which silently truncated such a barcode to 7 characters
		 * in get_search() and derived a nonsense weight from it in
		 * get_item_qty(), so the item could never be matched.
		 */
		is_scale_barcode(code) {
			const prefix = this.pos_profile?.posa_scale_barcode_start;
			// 0 counts as unconfigured: as a prefix it would match every
			// barcode beginning with a zero.
			if (!code || !prefix) {
				return false;
			}
			return code.startsWith(String(prefix));
		},
		get_item_qty(first_search) {
			let scal_qty = Math.abs(this.qty);
			if (this.is_scale_barcode(first_search)) {
				let pesokg1 = first_search.substr(7, 5);
				let pesokg;
				if (pesokg1.startsWith("0000")) {
					pesokg = "0.00" + pesokg1.substr(4);
				} else if (pesokg1.startsWith("000")) {
					pesokg = "0.0" + pesokg1.substr(3);
				} else if (pesokg1.startsWith("00")) {
					pesokg = "0." + pesokg1.substr(2);
				} else if (pesokg1.startsWith("0")) {
					pesokg = pesokg1.substr(1, 1) + "." + pesokg1.substr(2, pesokg1.length);
				} else if (!pesokg1.startsWith("0")) {
					pesokg = pesokg1.substr(0, 2) + "." + pesokg1.substr(2, pesokg1.length);
				}
				scal_qty = pesokg;
			}
			return scal_qty;
		},
		get_search(first_search) {
			let search_term = "";
			if (this.is_scale_barcode(first_search)) {
				search_term = first_search.substr(0, 7);
			} else {
				search_term = first_search;
			}
			return search_term;
		},
		esc_event() {
			this.reset_search();
			this.qty = 1;
			this.$refs.debounce_search?.focus();
		},
		/**
		 * Identity of a stock-enrichment request. Warehouse and profile are in
		 * the key because the server resolves quantities against
		 * `pos_profile.warehouse`, so the same item codes under a different
		 * profile are a genuinely different question.
		 */
		stockEnrichmentKey(itemCodes) {
			return JSON.stringify([
				this.pos_profile?.name ?? "",
				this.pos_profile?.warehouse ?? "",
				itemCodes,
			]);
		},

		/** Cancel the in-flight enrichment, if any. Safe to call unconditionally. */
		abortStockEnrichment() {
			if (!this._stockSlot) return;
			this._stockSlot.controller.abort();
			this._stockSlot = null;
		},

		/**
		 * Single-slot in-flight coordinator for `get_items_details`.
		 *
		 * Deliberately NOT a result cache: stock, serial and batch data are
		 * live-only (the method is `offline: false`), so once a request settles
		 * the next one must go to the wire again. This only collapses requests
		 * that overlap in time — the boot path fires two for the same catalogue
		 * (the `filtered_items` watcher and the explicit post-fetch call), and
		 * both are asking the identical question.
		 *
		 * An identical key joins the in-flight promise. Because a request can
		 * run for seconds, a joiner may receive stock read slightly before it
		 * asked; that is still a live read. An emitter wanting
		 * invalidate-now semantics would need to force a new request rather
		 * than join.
		 */
		requestStockDetails(key, itemCodes) {
			if (this._stockSlot?.key === key) return this._stockSlot.promise;
			// A different question supersedes the old one — free the socket
			// rather than let a doomed response finish.
			this.abortStockEnrichment();

			const controller = new AbortController();
			const slot = { key, controller, promise: null };
			slot.promise = call({
				method: "pospire.pospire.api.posapp.get_items_details",
				// Required on the object form: unlike the positional form, it is
				// NOT inferred from the registry, and validateIntent rejects the
				// call outright when it disagrees.
				intent: "read",
				// Only `item_code` is read server-side; every other field is
				// echoed straight back into the response, so sending whole rows
				// puts the catalogue on the wire in both directions.
				args: {
					pos_profile: this.pos_profile,
					items_data: itemCodes.map((item_code) => ({ item_code })),
				},
				abortSignal: controller.signal,
			}).finally(() => {
				// Only if we still own the slot: a newer request may have
				// replaced it already.
				if (this._stockSlot === slot) this._stockSlot = null;
			});
			this._stockSlot = slot;
			return slot.promise;
		},

		async update_items_details(items) {
			const vm = this;
			// Quantities are unknown from the moment the request starts, not
			// from the moment it fails.
			const seq = ++vm.stock_request_seq;
			vm.stock_details_fresh = false;
			const itemCodes = [...new Set(items.map((i) => i.item_code))].sort();
			if (!itemCodes.length) {
				// An empty grid has no quantity that could be stale. The old
				// code reached the same state via a pointless round trip that
				// returned []; skip the wire, keep the flag. A request for the
				// previous, non-empty grid is now answering a question nobody
				// is asking, so drop it rather than let it run to completion.
				vm.abortStockEnrichment();
				vm.stock_details_fresh = true;
				return;
			}
			let r = null;
			try {
				r = await vm.requestStockDetails(vm.stockEnrichmentKey(itemCodes), itemCodes);
			} catch (err) {
				// AbortError is expected supersession, not a failure — call.ts
				// keeps it out of connectivity accounting. Offline is expected
				// too: get_items_details is live-only, so it throws and
				// get_items leaves actual_qty at 0, meaning the grid must report
				// stock as unknown rather than render a confident "OUT".
				//
				// A policy error is neither. It means this call site disagrees
				// with the registry and NO request was ever made — a bug that
				// silently zeroes enrichment, which this catch would otherwise
				// hide behind an indistinguishable "stock unknown" grid.
				if (err instanceof MethodPolicyError || err instanceof UnregisteredMethod) {
					console.error("[ItemsSelector] stock enrichment misconfigured", err);
				}
				return;
			}
			// Superseded by a newer request — its response owns the flag.
			if (seq !== vm.stock_request_seq) return;
			if (r) {
				vm.stock_details_fresh = true;
				items.forEach((item) => {
					const updated_item = r.find(
						(element) => element.item_code == item.item_code
					);
					// Item physically deleted/missing since get_items ran — evict it.
					// Note: this covers deleted items only.  Disabled items are still
					// returned by get_items_details (it does not filter on Item.disabled);
					// those are handled by the refresh_items invalidation path instead.
					if (!updated_item) {
						vm.items = vm.items.filter((i) => i.item_code !== item.item_code);
						vm.eventBus.emit("set_all_items", vm.items);
						return;
					}
					item.actual_qty = updated_item.actual_qty;
					item.serial_no_data = updated_item.serial_no_data;
					item.batch_no_data = updated_item.batch_no_data;
					item.item_uoms = updated_item.item_uoms;
				});
				// Re-apply the stock filter after live quantities arrive.
				// get_items excludes zero-stock items server-side, but stock can
				// deplete between the get_items call and this get_items_details
				// response, leaving items in the list with actual_qty = 0.
				if (
					vm.pos_profile.posa_display_items_in_stock &&
					!vm.pos_profile.posa_auto_stock_reconcile
				) {
					vm.items = vm.items.filter((item) => item.actual_qty > 0);
					vm.eventBus.emit("set_all_items", vm.items);
				}
			}
		},
		update_cur_items_details() {
			this.update_items_details(this.filtered_items);
		},
		/**
		 * Attach the hardware-scanner listener.
		 *
		 * onScan was previously referenced without ever being imported, so
		 * `onScan.attachTo` threw a ReferenceError that the bare `catch {}`
		 * swallowed -- no listener was attached and no scan was ever framed.
		 * The only thing separating one scan from the next was the 200ms
		 * search debounce, which two scans inside that window simply re-armed,
		 * concatenating both codes into one unmatchable term.
		 *
		 * The old custom keyCodeMapper is gone: it called
		 * stopImmediatePropagation() on every keydown reaching document, which
		 * would have killed keyboard input app-wide had it ever run.
		 */
		attach_scanner() {
			if (onScan.isAttachedTo(document)) {
				onScan.detachFrom(document);
			}
			onScan.attachTo(document, {
				// reactToPaste stays off: a pasted code already reaches
				// first_search through v-model, and the watcher adds it. Also
				// reacting here would add the item twice.
				keyCodeMapper: (oEvent) => {
					const decoded = onScan.decodeKeyEvent(oEvent);
					if (decoded !== "") {
						return decoded;
					}
					// decodeKeyEvent only covers letters, digits and keypad
					// operators; it drops '-', '.', '/' and friends, which
					// appear in Code 39 / Code 128 barcodes. Keep any single
					// printable character so the framed code matches what the
					// scanner actually emitted. Named keys ("Enter", "Shift")
					// are longer than one character and stay filtered out.
					return oEvent.key?.length === 1 ? oEvent.key : "";
				},
				onScan: (sCode) => this.handle_scan(sCode),
				onScanError: () => {
					// The burst was human typing, not a scan. If Enter arrived
					// during it, search_onchange deferred to us -- run it now
					// so manual search and the Enter-to-add shortcut still work.
					if (this._deferred_enter) {
						this._deferred_enter = false;
						this.run_search();
					}
				},
			});
		},
		/**
		 * Handle one framed scan. `sCode` is authoritative.
		 *
		 * The scanner's keystrokes also landed in the focused search box, so a
		 * debounced write of that raw text is pending -- and after two quick
		 * scans that text is both codes concatenated. Cancelling it and
		 * writing sCode ourselves is what makes consecutive scans independent:
		 * onScan reinitializes its accumulator after every scan, so each
		 * callback carries exactly one code and runs to completion (adding the
		 * item and clearing the box) before the next one can fire.
		 */
		handle_scan(sCode) {
			this._deferred_enter = false;
			this._applySearch.cancel();
			if (!this.pos_profile) {
				return;
			}
			// Show the framed code, replacing whatever raw characters the
			// scanner typed into the element.
			this.raw_search = sCode;
			this.first_search = sCode;
			if (this.pos_profile.pose_use_limit_search) {
				// Limit-search profiles keep only the last server result in the
				// grid, so the scanned code is not in filtered_items yet and
				// enter_event() would report a false miss. get_items() re-queries
				// with it and runs enter_event() itself once the response lands.
				this.get_items();
				return;
			}
			if (!this.enter_event()) {
				toast.error(`No Item has this barcode "${sCode}"`);
				playSound("error");
				// Clear anyway. Leaving an unmatched code in the box meant the
				// next scan appended to it and could never match either.
				this.reset_search();
				this.$refs.debounce_search?.focus();
			}
		},
		generateWordCombinations(inputString) {
			const words = inputString.split(" ");
			const wordCount = words.length;
			const combinations = [];

			// Helper function to generate all permutations
			function permute(arr, m = []) {
				if (arr.length === 0) {
					combinations.push(m.join(" "));
				} else {
					for (let i = 0; i < arr.length; i++) {
						const current = arr.slice();
						const next = current.splice(i, 1);
						permute(current.slice(), m.concat(next));
					}
				}
			}

			permute(words);

			return combinations;
		},

		// Enhanced UI helper methods
		clearSearch() {
			this.reset_search();
			this.$refs.debounce_search?.focus();
		},

		getStockColorClass(qty) {
			if (qty <= 0) return "text-red-darken-2";
			if (qty <= 5) return "text-orange-darken-2";
			return "text-green-darken-2";
		},

		// Returns inline style with design system colors
		getStockColorStyle(qty) {
			if (qty <= 0) return { color: "#F44336" }; // Vivid Red - Out of stock
			if (qty <= 5) return { color: "#FF9800" }; // Safety Amber - Low stock
			return { color: "#4CAF50" }; // Grass Green - In stock
		},
	},

	computed: {
		/**
		 * True when the displayed actual_qty on items is from a
		 * recent online fetch and can be trusted enough to render the
		 * OUT / LOW / STOCK badges. False while offline or on degraded
		 * connectivity, when the items array is whatever was last
		 * hydrated from localStorage (or worse, from a stock-agnostic
		 * fallback fetch that ran without warehouse-customer context).
		 * Hiding the badges in those states avoids the cashier seeing
		 * "OUT" on every item just because a customer switch missed
		 * the cache.
		 */
		stockContextReliable() {
			// Online is necessary but not sufficient: get_items always returns
			// actual_qty 0 unless posa_display_items_in_stock is set, and only
			// a successful get_items_details fills it in. Gating on
			// connectivity alone showed "OUT" on every item after a reconnect,
			// before the enrichment call had landed.
			return this.connectionQuality === "online" && this.stock_details_fresh;
		},
		filtered_items() {
			this.search = this.get_search(this.first_search);
			if (!this.pos_profile.pose_use_limit_search) {
				let filtred_list = [];
				let filtred_group_list = [];
				if (this.item_group != "ALL") {
					filtred_group_list = this.items.filter((item) =>
						item.item_group.toLowerCase().includes(this.item_group.toLowerCase())
					);
				} else {
					filtred_group_list = this.items;
				}
				if (!this.search || this.search.length < 3) {
					if (
						this.pos_profile.posa_show_template_items &&
						this.pos_profile.posa_hide_variants_items
					) {
						return (filtred_list = filtred_group_list
							.filter((item) => !item.variant_of)
							.slice(0, 50));
					} else {
						filtred_list = filtred_group_list.slice(0, 50);
						return filtred_list;
					}
				} else if (this.search) {
					filtred_list = filtred_group_list.filter((item) => {
						let found = false;
						for (let element of item.item_barcode) {
							if (element.barcode == this.search) {
								found = true;
								break;
							}
						}
						return found;
					});
					if (filtred_list.length == 0) {
						filtred_list = filtred_group_list.filter((item) =>
							item.item_code.toLowerCase().includes(this.search.toLowerCase())
						);
						if (filtred_list.length == 0) {
							const search_combinations = this.generateWordCombinations(this.search);
							filtred_list = filtred_group_list.filter((item) => {
								let found = false;
								for (let element of search_combinations) {
									element = element.toLowerCase().trim();
									let element_regex = new RegExp(
										`.*${element.split("").join(".*")}.*`
									);
									if (element_regex.test(item.item_name.toLowerCase())) {
										found = true;
										break;
									}
								}
								return found;
							});
						}
						if (filtred_list.length == 0 && this.pos_profile.posa_search_serial_no) {
							filtred_list = filtred_group_list.filter((item) => {
								let found = false;
								for (let element of item.serial_no_data) {
									if (element.serial_no == this.search) {
										found = true;
										this.flags.serial_no = null;
										this.flags.serial_no = this.search;
										break;
									}
								}
								return found;
							});
						}
						if (filtred_list.length == 0 && this.pos_profile.posa_search_batch_no) {
							filtred_list = filtred_group_list.filter((item) => {
								let found = false;
								for (let element of item.batch_no_data) {
									if (element.batch_no == this.search) {
										found = true;
										this.flags.batch_no = null;
										this.flags.batch_no = this.search;
										break;
									}
								}
								return found;
							});
						}
					}
				}
				if (
					this.pos_profile.posa_show_template_items &&
					this.pos_profile.posa_hide_variants_items
				) {
					return filtred_list.filter((item) => !item.variant_of).slice(0, 50);
				} else {
					return filtred_list.slice(0, 50);
				}
			} else {
				return this.items.slice(0, 50);
			}
		},
		/**
		 * Typing latch for the search box. The setter is deliberately NOT a
		 * `_.debounce(...)` literal any more: that built one shared debounced
		 * function at module-evaluation time with no handle to cancel or flush
		 * it, so nothing could stop a pending write from landing. The
		 * per-instance `_applySearch` created in created() gives us
		 * `.cancel()` (used by handle_scan / reset_search to drop a stale
		 * write) and `.flush()` (used by run_search so Enter acts on what is
		 * in the box right now, not on the previous value).
		 */
		debounce_search: {
			get() {
				return this.raw_search;
			},
			set(newValue) {
				// Written through immediately so the bound value always mirrors
				// the element; only the *search* is debounced.
				this.raw_search = newValue ?? "";
				this._applySearch(newValue);
			},
		},
	},

	created: function () {
		this.$nextTick(function () {});
		// Backs the `debounce_search` setter. Per-instance so its pending
		// timer belongs to this component and can be cancelled on unmount.
		this._applySearch = _.debounce((newValue) => {
			this.first_search = newValue;
		}, 200);
		// Set when Enter arrives while onScan is still accumulating a code,
		// so the manual search can be replayed from onScanError if the burst
		// turns out to have been human typing rather than a scan.
		this._deferred_enter = false;
		this.onBus("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
			this.get_items();
			this.get_items_groups();
			this.items_view = this.pos_profile.posa_default_card_view ? "card" : "list";
		});
		this.onBus("update_cur_items_details", () => {
			this.update_cur_items_details();
		});
		this.onBus("update_offers_counters", (data) => {
			this.offersCount = data.offersCount;
			this.appliedOffersCount = data.appliedOffersCount;
		});
		this.onBus("update_coupons_counters", (data) => {
			this.couponsCount = data.couponsCount;
			this.appliedCouponsCount = data.appliedCouponsCount;
		});
		this.onBus("update_customer_price_list", (data) => {
			this.customer_price_list = data;
		});
		this.onBus("update_customer", (data) => {
			this.customer = data;
		});

		// Master-data invalidation: Pos.vue emits refresh_items when a
		// backend change (Item disabled, price updated, etc.) requires the
		// item catalog to be re-fetched.  Behavior respects pose_use_limit_search.
		this.onBus("refresh_items", () => {
			const profile = this.pos_profile;
			if (!profile) return;
			// Clear stale localStorage so hydration does not serve old data.
			if (profile.posa_local_storage) {
				try { localStorage.removeItem("items_storage"); } catch (_e) { /* noop */ }
			}
			if (!profile.pose_use_limit_search) {
				// Resident-catalog mode: force a full re-fetch immediately.
				this.get_items();
			} else if (this.first_search) {
				// Limit-search mode with active query: re-run the current search.
				this.get_items();
			}
			// Limit-search mode, no active query: leave vm.items as-is.
			// localStorage is already cleared; the next user input naturally
			// triggers a fresh get_items() against the now-invalidated cache.
			// Stale rows may remain visible until the cashier types — this is an
			// accepted UX tradeoff to avoid an abrupt empty-state.
		});
	},

	mounted() {
		this.attach_scanner();
	},

	beforeUnmount() {
		// Drop the scanner listener and any pending search write, otherwise
		// both keep firing into a dead component (and a remount would hit
		// onScan's "already initialized" throw).
		if (onScan.isAttachedTo(document)) {
			onScan.detachFrom(document);
		}
		this._applySearch.cancel();

		// Nothing left to apply the response to. Bus listeners are torn down by
		// the busListeners mixin's own hook.
		//
		// Both tokens are bumped, not just the stock one: an in-flight
		// get_items() is unaffected by abortStockEnrichment and would otherwise
		// resolve into a dead component, mutate its state and schedule a fresh
		// enrichment from the .then handler.
		this.catalog_request_seq += 1;
		this.stock_request_seq += 1;
		this.abortStockEnrichment();
	},

};
</script>

<style scoped>
/* Main container - flex column to stack selection card and controls */
.enhanced-items-container {
	display: flex;
	flex-direction: column;
	height: 100%;
}

/* Main content card - takes remaining space above controls */
.selection {
	flex: 1;
	width: 100%;
	min-height: 0;
	overflow: hidden;
}

/* Footer controls - fixed at bottom */
.enhanced-controls {
	flex-shrink: 0;
}

/*
 * Height is handled by flexbox - DO NOT use viewport calc here!
 */
.items-grid-scroll,
.items-list-scroll {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
}

/* Card grid - align items to top-left */
.items-grid-scroll {
	align-content: flex-start;
}

.enhanced-btn-label {
	display: inline;
}

@media (max-width: 900px) {
	.enhanced-btn-label {
		display: none;
	}
}

.enhanced-items-card {
	background: var(--itemselect-gradient-card);
	border: 1px solid var(--itemselect-color-border);
}

.enhanced-search-wrapper {
	position: relative;
	background: var(--pospire-surface);
	border-radius: var(--pospire-input-border-radius);
}

.enhanced-search-icon {
	position: absolute;
	left: 12px;
	top: 50%;
	transform: translateY(-50%);
	z-index: 2;
	color: var(--pospire-text-muted);
}

.enhanced-search-field :deep(.v-field__input) {
	padding-left: 2.5rem !important;
}

.enhanced-search-field :deep(.v-field) {
	background: var(--pospire-surface) !important;
	overflow: hidden;
}

.enhanced-empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 3rem 2rem;
	text-align: center;
	color: var(--itemselect-color-text-muted);
	background: var(--itemselect-gradient-empty);
	border-radius: 12px;
	border: 2px dashed var(--itemselect-color-border);
	margin: 2rem 0;
	min-height: 300px;
}

.enhanced-empty-state-title {
	font-size: 1.25rem;
	font-weight: 600;
	color: var(--itemselect-color-text-main);
	margin: 1rem 0 0.5rem 0;
}

.enhanced-empty-state-description {
	font-size: 0.95rem;
	color: var(--itemselect-color-text-muted);
	margin-bottom: 1.5rem;
	max-width: 400px;
	line-height: 1.5;
}

.enhanced-empty-state-action {
	background: var(--itemselect-gradient-action-btn);
	color: white;
	padding: 0.75rem 1.5rem;
	border-radius: 8px;
	text-decoration: none;
	font-weight: 500;
	transition: all 0.3s ease;
	border: none;
	cursor: pointer;
}

.enhanced-empty-state-action:hover {
	transform: translateY(-2px);
	box-shadow: 0 8px 25px rgba(59, 130, 246, 0.25);
}

/* Product Card */
.pospire-product-card {
	background: var(--pospire-clean-white);
	border: 1px solid var(--pospire-border-gray);
	border-radius: var(--pospire-radius-lg);
	cursor: pointer;
	transition: all 0.2s ease;
	overflow: hidden;
}

.pospire-product-card:hover {
	transform: translateY(-2px);
	box-shadow: var(--pospire-shadow-md);
	border-color: var(--pospire-vibrant-teal);
}

.pospire-product-card.out-of-stock {
	opacity: 0.6;
	cursor: not-allowed;
}

/* Product Image */
.pospire-product-image-wrapper {
	position: relative;
	width: 100%;
	aspect-ratio: 1;
	background: var(--pospire-light-gray);
}

.pospire-product-image {
	width: 100%;
	height: 100%;
}

/* Stock Badge */
.pospire-stock-badge {
	position: absolute;
	top: 8px;
	right: 8px;
	padding: 4px 10px;
	border-radius: 12px;
	font: var(--pospire-font-support);
	font-weight: 700;
	color: var(--pospire-clean-white);
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.badge-success {
	background: var(--pospire-grass-green) !important;
}

.badge-warning {
	background: var(--pospire-safety-amber) !important;
}

.badge-error {
	background: var(--pospire-vivid-red) !important;
}

/* Product Info */
.pospire-product-info {
	padding: var(--pospire-spacing-md);
	display: flex;
	flex-direction: column;
	gap: 6px;
}

/* Product Name */
.pospire-product-name {
	font: var(--pospire-font-headline);
	color: var(--pospire-deep-slate);
	line-height: 1.3;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	min-height: 41px; /* 2 lines */
}

/* Product Price */
.pospire-product-price {
	font: var(--pospire-font-body-medium);
	color: var(--pospire-vibrant-teal);
}

.item-rate-text {
	color: var(--pospire-text-primary);
}

/* Product Stock */
.pospire-product-stock {
	font: var(--pospire-font-support);
	color: var(--pospire-text-secondary);
	display: flex;
	align-items: center;
	gap: 6px;
}

.stock-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	flex-shrink: 0;
}

.dot-success {
	background: var(--pospire-grass-green) !important;
}

.dot-warning {
	background: var(--pospire-safety-amber) !important;
}

.dot-error {
	background: var(--pospire-vivid-red) !important;
}

.enhanced-controls {
	background: var(--itemselect-color-bg-card);
	border-radius: 12px;
	border: 1px solid var(--itemselect-color-bg-empty);
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

/* View Toggle */
.pospire-view-toggle {
	display: flex;
	background: var(--pospire-light-gray);
	border-radius: var(--pospire-radius-sm);
	padding: 4px;
	width: 100%;
	gap: 4px;
}

.enhanced-action-btn {
	font-weight: 500 !important;
	text-transform: none !important;
}

.enhanced-data-table {
	border-radius: 12px;
	overflow: hidden;
}

.enhanced-scrollbar::-webkit-scrollbar {
	width: 8px;
}

.enhanced-scrollbar::-webkit-scrollbar-track {
	background: var(--itemselect-color-bg-empty);
	border-radius: 4px;
}

.enhanced-scrollbar::-webkit-scrollbar-thumb {
	background: var(--itemselect-color-border);
	border-radius: 4px;
}

.enhanced-scrollbar::-webkit-scrollbar-thumb:hover {
	background: #94a3b8;
}

.enhanced-fade-in {
	animation: enhanced-fadeIn 0.3s ease-in-out;
}

@keyframes enhanced-fadeIn {
	from {
		opacity: 0;
		transform: translateY(20px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

.enhanced-bottom-controls {
	gap: 0.5rem;
}
</style>
