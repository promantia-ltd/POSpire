<template>
	<v-dialog v-model="dialog" max-width="800" persistent>
		<v-card class="enhanced-modal-card" elevation="8" rounded="xl">
			<v-card-title class="enhanced-modal-header">
				<div class="d-flex align-center justify-space-between w-100">
					<div class="d-flex align-center">
						<v-icon class="mr-2" size="24" color="primary"
							>mdi-ticket-percent-outline</v-icon
						>
						<span class="text-h6 font-weight-bold">{{ __("Manage Coupons") }}</span>
					</div>
					<v-btn icon variant="text" @click="closeModal">
						<v-icon>mdi-close</v-icon>
					</v-btn>
				</div>
			</v-card-title>

			<v-card-text class="pa-4">
				<!-- Add Coupon Section -->
				<div class="enhanced-add-section mb-4">
					<v-row no-gutters align="center" class="mb-3">
						<v-col cols="8">
							<v-text-field
								density="compact"
								variant="outlined"
								color="primary"
								label="Enter Coupon Code"
								placeholder="Type or scan coupon code..."
								bg-color="white"
								hide-details
								v-model="new_coupon"
								prepend-inner-icon="mdi-ticket-outline"
								@keydown.enter="add_coupon(new_coupon)"
							>
							</v-text-field>
						</v-col>
						<v-col cols="4" class="pl-2">
							<v-btn
								block
								color="success"
								variant="elevated"
								@click="add_coupon(new_coupon)"
								:disabled="!new_coupon"
								class="enhanced-add-btn"
							>
								<v-icon class="mr-1">mdi-plus</v-icon>
								{{ __("Apply Coupon") }}
							</v-btn>
						</v-col>
					</v-row>
				</div>

				<!-- Coupons List -->
				<div class="enhanced-list-section">
					<div v-if="!posa_coupons.length" class="enhanced-empty-state">
						<v-icon size="48" color="grey-lighten-1">mdi-ticket-outline</v-icon>
						<div class="enhanced-empty-state-title">No Coupons Applied</div>
						<div class="enhanced-empty-state-description">
							Add coupon codes above to apply discounts and offers to this
							transaction.
						</div>
					</div>

					<v-data-table
						v-else
						:headers="items_headers"
						:items="posa_coupons"
						:single-expand="singleExpand"
						v-model:expanded="expanded"
						item-key="coupon"
						class="enhanced-coupons-table"
						:items-per-page="itemsPerPage"
						hide-default-footer
					>
						<template v-slot:item.applied="{ item }">
							<v-chip
								:color="item.applied ? 'success' : 'grey'"
								:variant="item.applied ? 'elevated' : 'tonal'"
								size="small"
							>
								{{ item.applied ? "Applied" : "Not Applied" }}
							</v-chip>
						</template>
						<template v-slot:item.coupon="{ item }">
							<div class="d-flex align-center">
								<v-icon class="mr-2" size="20" color="primary">mdi-ticket</v-icon>
								<span class="font-weight-medium">{{ item.coupon }}</span>
							</div>
						</template>
					</v-data-table>
				</div>
			</v-card-text>

			<v-card-actions class="enhanced-modal-actions">
				<v-spacer></v-spacer>
				<v-btn color="grey-darken-1" variant="text" @click="closeModal" class="mr-2">
					Cancel
				</v-btn>
				<v-btn color="primary" variant="elevated" @click="applyCoupons">
					Apply & Close
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
import { toast } from "vue3-toastify";

export default {
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
	},

	data: () => ({
		loading: false,
		pos_profile: "",
		customer: "",
		posa_coupons: [],
		new_coupon: null,
		itemsPerPage: 1000,
		singleExpand: true,
		expanded: [],
		items_headers: [
			{ title: "Coupon", key: "coupon_code", align: "start" },
			{ title: "Type", key: "type", align: "start" },
			{ title: "Offer", key: "pos_offer", align: "start" },
			{ title: "Applied", key: "applied", align: "center" },
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
		couponsCount() {
			return this.posa_coupons.length;
		},
		appliedCouponsCount() {
			return this.posa_coupons.filter((el) => !!el.applied).length;
		},
	},

	methods: {
		closeModal() {
			this.dialog = false;
		},
		applyCoupons() {
			this.closeModal();
		},
		add_coupon(new_coupon) {
			if (!this.customer || !new_coupon) {
				toast.error(__("Select a customer to use coupon"));
				return;
			}
			const exist = this.posa_coupons.find((el) => el.coupon_code == new_coupon);
			if (exist) {
				toast.error(__("This coupon already used !"));
				return;
			}
			const vm = this;
			frappe.call({
				method: "pospire.pospire.api.posapp.get_pos_coupon",
				args: {
					coupon: new_coupon,
					customer: vm.customer,
					company: vm.pos_profile.company,
				},
				callback: function (r) {
					if (r.message) {
						const res = r.message;
						if (res.msg != "Apply" || !res.coupon) {
							toast.error(res.msg);
						} else {
							vm.new_coupon = null;
							const coupon = res.coupon;
							vm.posa_coupons.push({
								coupon: coupon.name,
								coupon_code: coupon.coupon_code,
								type: coupon.coupon_type,
								applied: 0,
								pos_offer: coupon.pos_offer,
								customer: coupon.customer || vm.customer,
							});
						}
					}
				},
			});
		},
		setActiveGiftCoupons() {
			if (!this.customer) return;
			const vm = this;
			frappe.call({
				method: "pospire.pospire.api.posapp.get_active_gift_coupons",
				args: {
					customer: vm.customer,
					company: vm.pos_profile.company,
				},
				callback: function (r) {
					if (r.message) {
						const coupons = r.message;
						coupons.forEach((coupon_code) => {
							vm.add_coupon(coupon_code);
						});
					}
				},
			});
		},

		updatePosCoupons(offers) {
			this.posa_coupons.forEach((coupon) => {
				const offer = offers.find((el) => el.offer_applied && el.coupon == coupon.coupon);
				if (offer) {
					coupon.applied = 1;
				} else {
					coupon.applied = 0;
				}
			});
		},

		removeCoupon(reomove_list) {
			this.posa_coupons = this.posa_coupons.filter(
				(coupon) => !reomove_list.includes(coupon.coupon)
			);
		},
		updateInvoice() {
			this.eventBus.emit("update_invoice_coupons", this.posa_coupons);
		},
		updateCounters() {
			this.eventBus.emit("update_coupons_counters", {
				couponsCount: this.couponsCount,
				appliedCouponsCount: this.appliedCouponsCount,
			});
		},
	},

	watch: {
		posa_coupons: {
			deep: true,
			handler() {
				this.updateInvoice();
				this.updateCounters();
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
				const to_remove = [];
				this.posa_coupons.forEach((el) => {
					if (el.type == "Promotional") {
						el.customer = customer;
					} else {
						to_remove.push(el.coupon);
					}
				});
				this.customer = customer;
				if (to_remove.length) {
					this.removeCoupon(to_remove);
				}
			}
			this.setActiveGiftCoupons();
		});
		this.eventBus.on("update_pos_coupons", (data) => {
			this.updatePosCoupons(data);
		});
		this.eventBus.on("set_pos_coupons", (data) => {
			this.posa_coupons = data;
		});
	},
};
</script>

<style scoped>
.enhanced-modal-card {
	border-radius: var(--modal-radius);
	overflow: hidden;
}

.enhanced-add-section {
	background: var(--add-section-bg);
	border-radius: var(--add-section-radius);
	padding: 1rem;
	border: var(--add-section-border);
}

.enhanced-add-btn {
	text-transform: var(--btn-text-transform) !important;
	font-weight: var(--btn-font-weight);
}

.enhanced-list-section {
	min-height: 300px;
}

.enhanced-coupons-table {
	border-radius: var(--table-radius);
	overflow: hidden;
}

.enhanced-modal-actions {
	background: var(--modal-bg);
	border-top: var(--modal-border);
	padding: 1rem 1.5rem;
}

.enhanced-empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 3rem 2rem;
	text-align: center;
	color: var(--coupons-empty-text-color);
}

.enhanced-empty-state-title {
	font-size: var(--coupons-empty-title-size);
	font-weight: 600;
	color: var(--coupons-empty-title-color);
	margin: 1rem 0 0.5rem 0;
}

.enhanced-empty-state-description {
	font-size: var(--coupons-empty-desc-size);
	color: var(--coupons-empty-text-color);
	max-width: 300px;
	line-height: 1.5;
}
</style>
