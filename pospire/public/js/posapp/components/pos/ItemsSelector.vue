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
						<v-icon class="enhanced-search-icon" size="20" color="grey-darken-1"
							>mdi-magnify</v-icon
						>
						<v-text-field
							density="compact"
							clearable
							autofocus
							variant="outlined"
							color="primary"
							placeholder="Search by name, code, barcode, serial or batch number..."
							bg-color="white"
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
						:label="frappe._('QTY')"
						bg-color="white"
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
										'out-of-stock': item.actual_qty <= 0,
										'item-selected': selectedItemIdx === idx,
									}"
								>
									<!-- 1:1 Square Image Container -->
									<div class="pospire-product-image-wrapper">
										<v-img
											:src="
												item.image ||
												'/assets/pospire/js/posapp/components/pos/placeholder-image.png'
											"
											:aspect-ratio="1"
											cover
											class="pospire-product-image"
										>
										</v-img>

										<!-- Stock Badge Overlay -->
										<div
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
										<div class="pospire-product-stock">
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
									<span class="font-weight-medium" style="color: #34495e"
										>{{ currencySymbol(item.currency) }}
										{{ formatCurrency(item.rate) }}</span
									>
								</template>
								<template v-slot:item.actual_qty="{ item }">
									<span
										class="font-weight-medium"
										:style="getStockColorStyle(item.actual_qty)"
									>
										{{ formatFloat(item.actual_qty) }}
									</span>
								</template>
								<template v-slot:item.item_name="{ item }">
									<div class="d-flex align-center">
										<v-avatar size="32" class="mr-2">
											<v-img
												:src="
													item.image ||
													'/assets/pospire/js/posapp/components/pos/placeholder-image.png'
												"
											></v-img>
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
						:label="frappe._('Items Group')"
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
import { toast } from "vue3-toastify";
import format from "../../format";
import _ from "lodash";
export default {
	mixins: [format],
	data: () => ({
		pos_profile: "",
		flags: {},
		items_view: "list",
		item_group: "ALL",
		loading: false,
		items_group: ["ALL"],
		items: [],
		search: "",
		first_search: "",
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
			this.get_items();
		},
		new_line() {
			this.eventBus.emit("set_new_line", this.new_line);
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
					vm.items = JSON.parse(localStorage.getItem("items_storage"));
					this.eventBus.emit("set_all_items", vm.items);
					vm.loading = false;

					// Immediately update stock for cached items
					vm.$nextTick(() => {
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
			frappe.call({
				method: "pospire.pospire.api.posapp.get_items",
				args: {
					pos_profile: vm.pos_profile,
					price_list: vm.customer_price_list,
					item_group: gr,
					search_value: sr,
					customer: vm.customer,
				},
				callback: function (r) {
					if (r.message) {
						vm.items = r.message;
						vm.eventBus.emit("set_all_items", vm.items);
						vm.loading = false;

						// Update localStorage if enabled
						if (
							vm.pos_profile.posa_local_storage &&
							!vm.pos_profile.pose_use_limit_search
						) {
							try {
								localStorage.setItem("items_storage", JSON.stringify(r.message));
							} catch (e) {}
						}

						// Immediately update stock quantities
						vm.$nextTick(() => {
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
				},
			});
		},
		get_items_groups() {
			if (!this.pos_profile) {
				return;
			}
			if (this.pos_profile.item_groups.length > 0) {
				this.pos_profile.item_groups.forEach((element) => {
					if (element.item_group !== "All Item Groups") {
						this.items_group.push(element.item_group);
					}
				});
			} else {
				const vm = this;
				frappe.call({
					method: "pospire.pospire.api.posapp.get_items_groups",
					args: {},
					callback: function (r) {
						if (r.message) {
							r.message.forEach((element) => {
								vm.items_group.push(element.name);
							});
						}
					},
				});
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

		enter_event() {
			let match = false;
			if (!this.filtered_items.length || !this.first_search) {
				return;
			}
			const qty = this.get_item_qty(this.first_search);
			const new_item = { ...this.filtered_items[0] };
			new_item.qty = flt(qty);
			new_item.item_barcode.forEach((element) => {
				if (this.search == element.barcode) {
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
					if (this.search && element.serial_no == this.search) {
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
					if (this.search && element.batch_no == this.search) {
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
				this.search = null;
				this.first_search = null;
				this.debounce_search = null;
				this.flags.serial_no = null;
				this.flags.batch_no = null;
				this.qty = 1;
				this.$refs.debounce_search.focus();
			}
		},
		search_onchange() {
			const vm = this;
			if (vm.pos_profile.pose_use_limit_search) {
				vm.get_items();
			} else {
				vm.enter_event();
			}
		},
		get_item_qty(first_search) {
			let scal_qty = Math.abs(this.qty);
			if (first_search.startsWith(this.pos_profile.posa_scale_barcode_start)) {
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
			if (
				first_search &&
				first_search.startsWith(this.pos_profile.posa_scale_barcode_start)
			) {
				search_term = first_search.substr(0, 7);
			} else {
				search_term = first_search;
			}
			return search_term;
		},
		esc_event() {
			this.search = null;
			this.first_search = null;
			this.qty = 1;
			this.$refs.debounce_search.focus();
		},
		update_items_details(items) {
			// set debugger
			const vm = this;
			frappe.call({
				method: "pospire.pospire.api.posapp.get_items_details",
				args: {
					pos_profile: vm.pos_profile,
					items_data: items,
				},
				callback: function (r) {
					if (r.message) {
						items.forEach((item) => {
							const updated_item = r.message.find(
								(element) => element.item_code == item.item_code
							);
							item.actual_qty = updated_item.actual_qty;
							item.serial_no_data = updated_item.serial_no_data;
							item.batch_no_data = updated_item.batch_no_data;
							item.item_uoms = updated_item.item_uoms;
						});
					}
				},
			});
		},
		update_cur_items_details() {
			this.update_items_details(this.filtered_items);
		},
		scan_barcoud() {
			const vm = this;
			try {
				onScan.attachTo(document, {
					suffixKeyCodes: [],
					keyCodeMapper: function (oEvent) {
						oEvent.stopImmediatePropagation();
						return onScan.decodeKeyEvent(oEvent);
					},
					onScan: function (sCode) {
						setTimeout(() => {
							vm.trigger_onscan(sCode);
						}, 300);
					},
				});
			} catch (error) {}
		},
		trigger_onscan(sCode) {
			if (this.filtered_items.length == 0) {
				toast.error(`No Item has this barcode "${sCode}"`);
				frappe.utils.play_sound("error");
			} else {
				this.enter_event();
				this.debounce_search = null;
				this.search = null;
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
			this.search = null;
			this.first_search = null;
			this.debounce_search = null;
			this.$refs.debounce_search.focus();
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
		debounce_search: {
			get() {
				return this.first_search;
			},
			set: _.debounce(function (newValue) {
				this.first_search = newValue;
			}, 200),
		},
	},

	created: function () {
		this.$nextTick(function () {});
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
			this.get_items();
			this.get_items_groups();
			this.items_view = this.pos_profile.posa_default_card_view ? "card" : "list";
		});
		this.eventBus.on("update_cur_items_details", () => {
			this.update_cur_items_details();
		});
		this.eventBus.on("update_offers_counters", (data) => {
			this.offersCount = data.offersCount;
			this.appliedOffersCount = data.appliedOffersCount;
		});
		this.eventBus.on("update_coupons_counters", (data) => {
			this.couponsCount = data.couponsCount;
			this.appliedCouponsCount = data.appliedCouponsCount;
		});
		this.eventBus.on("update_customer_price_list", (data) => {
			this.customer_price_list = data;
		});
		this.eventBus.on("update_customer", (data) => {
			this.customer = data;
		});
	},

	mounted() {
		this.scan_barcoud();
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
 * Scrollable areas for items list/grid
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
}

.enhanced-search-icon {
	position: absolute;
	left: 12px;
	top: 50%;
	transform: translateY(-50%);
	z-index: 2;
}

.enhanced-search-field :deep(.v-field__input) {
	padding-left: 2.5rem !important;
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
