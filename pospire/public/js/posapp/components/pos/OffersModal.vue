<template>
	<v-dialog v-model="dialog" max-width="900" persistent>
		<v-card class="enhanced-modal-card" elevation="8" rounded="xl">
			<v-card-title class="enhanced-modal-header">
				<div class="d-flex align-center justify-space-between w-100">
					<div class="d-flex align-center">
						<v-icon class="mr-2" size="24" color="primary">mdi-sale</v-icon>
						<span class="text-h6 font-weight-bold">{{ __("Available Offers") }}</span>
					</div>
					<v-btn icon variant="text" @click="closeModal">
						<v-icon>mdi-close</v-icon>
					</v-btn>
				</div>
			</v-card-title>

			<v-card-text class="pa-4">
				<!-- Offers List -->
				<div class="enhanced-list-section">
					<div v-if="!pos_offers.length" class="enhanced-empty-state">
						<v-icon size="48" color="grey-lighten-1">mdi-sale</v-icon>
						<div class="enhanced-empty-state-title">No Offers Available</div>
						<div class="enhanced-empty-state-description">
							No promotional offers are currently available for this transaction.
						</div>
					</div>

					<v-data-table
						v-else
						:headers="items_headers"
						:items="pos_offers"
						:single-expand="singleExpand"
						v-model:expanded="expanded"
						show-expand
						item-key="row_id"
						class="enhanced-offers-table"
						:items-per-page="itemsPerPage"
						hide-default-footer
					>
						<template v-slot:item.offer_applied="{ item }">
							<v-checkbox
								v-model="item.offer_applied"
								color="primary"
								hide-details
								:disabled="
									(item.offer == 'Give Product' &&
										!item.give_item &&
										(!offer.replace_cheapest_item || !offer.replace_item)) ||
									(item.offer == 'Grand Total' &&
										discount_percentage_offer_name &&
										discount_percentage_offer_name != item.name)
								"
								@change="forceUpdateItem"
							>
							</v-checkbox>
						</template>

						<template v-slot:item.name="{ item }">
							<div class="d-flex align-center">
								<v-icon class="mr-2" size="20" color="primary">mdi-tag</v-icon>
								<div>
									<div class="font-weight-medium">{{ item.name }}</div>
									<div
										class="text-caption text-grey-darken-1"
										v-if="item.offer_type"
									>
										{{ item.offer_type }}
									</div>
								</div>
							</div>
						</template>

						<template v-slot:expanded-item="{ headers, item }">
							<td :colspan="headers.length" class="enhanced-expanded-row">
								<v-card variant="tonal" class="ma-2">
									<v-card-text>
										<v-row>
											<v-col v-if="item.description" cols="12" md="8">
												<div
													class="text-body-2 mb-2 font-weight-medium text-primary"
												>
													Description:
												</div>
												<div
													class="text-body-2"
													v-html="handleNewLine(item.description)"
												></div>
											</v-col>
											<v-col
												v-if="item.offer == 'Give Product'"
												cols="12"
												md="4"
											>
												<v-autocomplete
													v-model="item.give_item"
													:items="get_give_items(item)"
													item-title="item_code"
													variant="outlined"
													density="compact"
													color="primary"
													label="Select Gift Item"
													:disabled="
														item.apply_type != 'Item Group' ||
														item.replace_item ||
														item.replace_cheapest_item
													"
												>
												</v-autocomplete>
											</v-col>
										</v-row>
									</v-card-text>
								</v-card>
							</td>
						</template>
					</v-data-table>
				</div>
			</v-card-text>

			<v-card-actions class="enhanced-modal-actions">
				<v-spacer></v-spacer>
				<v-btn color="grey-darken-1" variant="text" @click="closeModal" class="mr-2">
					Cancel
				</v-btn>
				<v-btn color="primary" variant="elevated" @click="applyOffers">
					Apply & Close
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
import { toast } from "vue3-toastify";
import format from "../../format";
export default {
	mixins: [format],
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
	},
	data: () => ({
		loading: false,
		pos_profile: "",
		pos_offers: [],
		allItems: [],
		discount_percentage_offer_name: null,
		itemsPerPage: 1000,
		expanded: [],
		singleExpand: true,
		items_headers: [
			{ title: "Offer Name", key: "name", align: "start" },
			{ title: "Offer Type", key: "offer_type", align: "start" },
			{ title: "Conditions", key: "conditions", align: "start" },
			{ title: "Apply", key: "offer_applied", align: "center" },
		],
	}),
	computed: {
		dialog: {
			get() {
				return this.modelValue;
			},
			set(value) {
				this.$emit("update:modelValue", value);
			},
		},
		offersCount() {
			return this.pos_offers.length;
		},
		appliedOffersCount() {
			return this.pos_offers.filter((el) => !!el.offer_applied).length;
		},
	},
	methods: {
		closeModal() {
			this.dialog = false;
		},
		applyOffers() {
			this.eventBus.emit("apply_offers", this.pos_offers);
			this.closeModal();
		},
		forceUpdateItem() {
			let list_offers = [];
			list_offers = [...this.pos_offers];
			this.pos_offers = list_offers;
		},
		makeid(length) {
			let result = "";
			const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
			const charactersLength = characters.length;
			for (var i = 0; i < length; i++) {
				result += characters.charAt(Math.floor(Math.random() * charactersLength));
			}
			return result;
		},
		updatePosOffers(offers) {
			const toRemove = [];
			let new_offer_added = false;
			this.pos_offers.forEach((pos_offer) => {
				const offer = offers.find((offer) => offer.name === pos_offer.name);
				if (!offer) {
					toRemove.push(pos_offer.row_id);
				}
			});
			this.removeOffers(toRemove);
			offers.forEach((offer) => {
				const pos_offer = this.pos_offers.find(
					(pos_offer) => offer.name === pos_offer.name
				);
				if (pos_offer) {
					pos_offer.items = offer.items;
					if (
						pos_offer.offer === "Grand Total" &&
						!this.discount_percentage_offer_name
					) {
						pos_offer.offer_applied = !!pos_offer.auto;
					}
					if (
						offer.apply_on == "Item Group" &&
						offer.apply_type == "Item Group" &&
						offer.replace_cheapest_item
					) {
						pos_offer.give_item = offer.give_item;
						pos_offer.apply_item_code = offer.apply_item_code;
					}
				} else {
					const newOffer = { ...offer };
					if (!offer.row_id) {
						newOffer.row_id = this.makeid(20);
					}
					if (offer.apply_type == "Item Code") {
						newOffer.give_item = offer.apply_item_code || "Nothing";
					}
					if (offer.offer_applied) {
						newOffer.offer_applied == !!offer.offer_applied;
					} else {
						if (
							offer.apply_type == "Item Group" &&
							offer.offer == "Give Product" &&
							!offer.replace_cheapest_item &&
							!offer.replace_item
						) {
							newOffer.offer_applied = false;
						} else if (
							offer.offer === "Grand Total" &&
							this.discount_percentage_offer_name
						) {
							newOffer.offer_applied = false;
						} else {
							newOffer.offer_applied = !!offer.auto;
						}
					}
					if (newOffer.offer == "Give Product" && !newOffer.give_item) {
						newOffer.give_item = this.get_give_items(newOffer)[0].item_code;
					}
					this.pos_offers.push(newOffer);
					// this.eventBus.emit('show_message', {
					//   title: __('New Offer Available'),
					//   color: 'warning',
					// });
					// toast.warn('New Offer Available');
					new_offer_added = true;
				}
			});
			if (new_offer_added) {
				toast.warn("New Offer Available");
			}
		},
		removeOffers(offers_id_list) {
			this.pos_offers = this.pos_offers.filter(
				(offer) => !offers_id_list.includes(offer.row_id)
			);
		},
		handelOffers() {
			const applyedOffers = this.pos_offers.filter((offer) => offer.offer_applied);
			this.eventBus.emit("update_invoice_offers", applyedOffers);
		},
		handleNewLine(str) {
			if (str) {
				return str.replace(/(?:\r\n|\r|\n)/g, "<br />");
			} else {
				return "";
			}
		},
		get_give_items(offer) {
			if (offer.apply_type == "Item Code") {
				return [offer.apply_item_code];
			} else if (offer.apply_type == "Item Group") {
				const items = this.allItems;
				let filterd_items = [];
				const filterd_items_1 = items.filter(
					(item) => item.item_group == offer.apply_item_group
				);
				if (offer.less_then > 0) {
					filterd_items = filterd_items_1.filter((item) => item.rate < offer.less_then);
				} else {
					filterd_items = filterd_items_1;
				}
				return filterd_items;
			} else {
				return [];
			}
		},
		updateCounters() {
			this.eventBus.emit("update_offers_counters", {
				offersCount: this.offersCount,
				appliedOffersCount: this.appliedOffersCount,
			});
		},
		updatePosCoupuns() {
			const applyedOffers = this.pos_offers.filter(
				(offer) => offer.offer_applied && offer.coupon_based
			);
			this.eventBus.emit("update_pos_coupons", applyedOffers);
		},
	},
	watch: {
		pos_offers: {
			deep: true,
			handler(pos_offers) {
				this.handelOffers();
				this.updateCounters();
				this.updatePosCoupuns();
			},
		},
	},
	created: function () {
		this.$nextTick(function () {
			this.eventBus.on("register_pos_profile", (data) => {
				this.pos_profile = data.pos_profile;
			});
		});
		this.eventBus.on("update_customer", (customer) => {
			if (this.customer != customer) {
				this.offers = [];
			}
		});
		this.eventBus.on("update_pos_offers", (data) => {
			this.updatePosOffers(data);
		});
		this.eventBus.on("update_discount_percentage_offer_name", (data) => {
			this.discount_percentage_offer_name = data.value;
		});
		this.eventBus.on("set_all_items", (data) => {
			this.allItems = data;
		});
	},
};
</script>

<style scoped>
.enhanced-modal-card {
	border-radius: var(--offersmodal-radius-card);
	overflow: hidden;
}

.enhanced-list-section {
	min-height: 400px;
}

.enhanced-offers-table {
	border-radius: var(--offersmodal-radius-table);
	overflow: hidden;
}

.enhanced-expanded-row {
	background: var(--offersmodal-color-bg) !important;
	padding: 0 !important;
}

.enhanced-modal-actions {
	background: var(--offersmodal-color-bg);
	border-top: 1px solid var(--offersmodal-color-border);
	padding: 1rem 1.5rem;
}

.enhanced-empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: var(--offersmodal-empty-padding);
	text-align: center;
	color: var(--offersmodal-color-text-muted);
}

.enhanced-empty-state-title {
	font-size: 1.1rem;
	font-weight: 600;
	color: var(--offersmodal-color-text-main);
	margin: 1rem 0 0.5rem 0;
}

.enhanced-empty-state-description {
	font-size: 0.9rem;
	color: var(--offersmodal-color-text-muted);
	max-width: var(--offersmodal-empty-max-width);
	line-height: 1.5;
}
</style>
