<template>
	<v-dialog v-model="isOpen" persistent max-width="600px">
		<v-card rounded="xl" elevation="8">
			<v-card-title
				class="d-flex align-center justify-space-between px-6 py-4 enhanced-modal-header"
			>
				<span class="text-h6 font-weight-bold text-primary">
					{{ __("Create POS Opening Shift") }}
				</span>
				<v-btn icon="mdi-close" variant="text" @click="go_desk"></v-btn>
			</v-card-title>

			<v-card-text class="overflow-y-auto"
  			style="max-height: 65vh;">
				<v-container fluid>
					<v-row dense>
						<v-col cols="12">
							<v-autocomplete
								v-model="company"
								:items="companies"
								:label="frappe._('Company')"
								density="comfortable"
								variant="outlined"
								required
							/>
						</v-col>

						<v-col cols="12">
							<v-autocomplete
								v-model="pos_profile"
								:items="pos_profiles"
								:label="frappe._('POS Profile')"
								density="comfortable"
								variant="outlined"
								required
							/>
						</v-col>

						<v-col cols="12">
							<v-data-table
								:headers="payments_methods_headers"
								:items="payments_methods"
								item-key="mode_of_payment"
								class="rounded-lg elevation-1"
								:items-per-page="itemsPerPage"
								density="comfortable"
								hide-default-footer
							>
								<template v-slot:item.amount="props">
									<v-text-field
										v-model.number="props.item.amount"
										type="number"
										min="0"
										density="compact"
										variant="outlined"
										hide-details
										:prefix="currencySymbol(pos_profile.currency)"
										:readonly="
											denominations_enabled ||
											props.item.mode_of_payment !== (denomination_config[pos_profile]?.cash_mode || 'Cash')
										"
										/>
								</template>
							</v-data-table>
							<v-expand-transition>
								<v-card
									v-if="denominations_enabled"
									class="rounded-lg elevation-1 mt-6"
									style="border-top: none !important;"
								>
									<v-card-title class="text-subtitle-2">
									{{ __("Cash Denomination Breakdown") }}
									</v-card-title>

									<v-data-table
									:headers="[
										{ title: 'Denomination', value: 'denomination_name' },
										{ title: 'Value', value: 'denomination_value' },
										{ title: 'Quantity', value: 'quantity' },
										{ title: 'Amount', value: 'amount' }
									]"
									:items="denomination_rows"
									density="compact"
									hide-default-footer
									>

									<template v-slot:item.denomination_value="{ item }">
										{{ formatCurrency(item.denomination_value) }}
									</template>

									<template v-slot:item.quantity="props">
										<v-text-field
										v-model.number="props.item.quantity"
										type="number"
										min="0"
										density="compact"
										variant="outlined"
										:rules="[v => v >= 0 || 'Quantity must be non-negative']"
										hide-details
										/>
									</template>

									<template v-slot:item.amount="{ item }">
										{{ formatCurrency(item.denomination_value * (item.quantity || 0)) }}
									</template>

									</v-data-table>

									<v-card-text class="text-right font-weight-bold">
									{{ __("Total") }}: {{ formatCurrency(denominationTotal) }}
									</v-card-text>

								</v-card>
								</v-expand-transition>
						</v-col>
					</v-row>
				</v-container>
			</v-card-text>

			<v-divider />
			<v-card-actions class="px-6 py-4 enhanced-modal-header">
				<v-spacer />
				<v-btn variant="text" color="grey-darken-1" @click="go_desk">
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					variant="elevated"
					color="primary"
					:disabled="is_loading"
					@click="submit_dialog"
				>
					{{ __("Submit") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
import format from "../../format";
import { toast } from "vue3-toastify";
import { amountRules, isAmountValid } from "./validation";
export default {
	mixins: [format],
	props: ["dialog"],
	data() {
		return {
			isOpen: this.dialog ? this.dialog : false,
			dialog_data: {},
			is_loading: false,
			companies: [],
			company: "",
			pos_profiles_data: [],
			pos_profiles: [],
			pos_profile: "",
			payments_method_data: [],
			payments_methods: [],
			payments_methods_headers: [
				{
					title: __("Mode of Payment"),
					align: "start",
					sortable: false,
					value: "mode_of_payment",
				},
				{
					title: __("Opening Amount"),
					value: "amount",
					align: "center",
					sortable: false,
				},
			],
			itemsPerPage: 100,
			amountRules,
			pagination: {},
			snack: false, // TODO : need to remove
			snackColor: "", // TODO : need to remove
			snackText: "", // TODO : need to remove
			denomination_config: {},       
			denomination_rows: [],         
			denominations_enabled: false,    
		};
	},
	watch: {
		company(val) {
			this.pos_profiles = [];
			this.pos_profiles_data.forEach((element) => {
				if (element.company === val) {
					this.pos_profiles.push(element.name);
				}
				if (this.pos_profiles.length) {
					this.pos_profile = this.pos_profiles[0];
				} else {
					this.pos_profile = "";
				}
			});
		},
		pos_profile(val) {
			this.payments_methods = [];
			this.payments_method_data.forEach((element) => {
				if (element.parent === val) {
					this.payments_methods.push({
						mode_of_payment: element.mode_of_payment,
						amount: 0,
						currency: element.currency,
					});
				}
			});
			const config = this.denomination_config[val];
			if (config?.denominations?.length) {
				this.denominations_enabled = true;
				this.denomination_rows = config.denominations.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: 0,
					amount: 0,
				}));
			} else {
				this.denominations_enabled = false;
				this.denomination_rows = [];
				if (config) {
					toast.warning(__("Cash denominations are enabled for this profile but no denomination rows are configured."), {
						autoClose: 5000,
					});
				}
			}
		},
		denominationTotal(newVal) {
			if (!this.denominations_enabled) return;

			const config = this.denomination_config[this.pos_profile];
			if (!config) return;

			const cashMode = config.cash_mode;

			const cashRow = this.payments_methods.find(
				(p) => p.mode_of_payment === cashMode
			);

			if (cashRow) {
				cashRow.amount = newVal;
			}
		},
	},
	computed:{
			denominationTotal() {
		if (!this.denomination_rows.length) return 0;

		return this.denomination_rows.reduce((sum, row) => {
			return sum + (row.denomination_value * (row.quantity || 0));
		}, 0);
	}

	},
	methods: {
		close_opening_dialog() {
			this.eventBus.emit("close_opening_dialog");
		},
		get_opening_dialog_data() {
			const vm = this;
			frappe.call({
				method: "pospire.pospire.api.posapp.get_opening_dialog_data",
				args: {},
				callback: function (r) {
					if (r.message) {
						r.message.companies.forEach((element) => {
							vm.companies.push(element.name);
						});
						vm.company = vm.companies[0];
						vm.pos_profiles_data = r.message.pos_profiles_data;
						vm.payments_method_data = r.message.payments_method;
						vm.denomination_config = r.message.denomination_config || {};
					}
				},
			});
		},
		submit_dialog() {
			if (!this.payments_methods.length || !this.company || !this.pos_profile) {
				return;
			}

			if (this.denominations_enabled) {
				const invalidQty = this.denomination_rows.some((row) => {
					const qty = row.quantity === "" || row.quantity === null || row.quantity === undefined
						? 0
						: Number(row.quantity);

					return qty < 0 || !Number.isInteger(qty);
				});

				if (invalidQty) {
					toast.error(__("Quantity must be a non-negative integer."), {
						autoClose: 5000,
					});
					return;
				}
			}

			const has_invalid_amount = this.payments_methods.some((p) => !isAmountValid(p.amount));
			if (has_invalid_amount) {
				toast.error(__("Please enter valid non-negative amounts."), {
					autoClose: 5000,
				});
				return;
			}

			this.is_loading = true;

			const balance_details = this.payments_methods.map((p) => ({
				...p,
				amount:
					p.amount === "" || p.amount === null || p.amount === undefined
						? 0
						: Number(p.amount),
			}));

			let denomination_details = null;

			if (this.denominations_enabled) {
				const rows = this.denomination_rows.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: d.quantity || 0,
					amount: (d.denomination_value || 0) * (d.quantity || 0),
				}));

				denomination_details = JSON.stringify(rows);
			}

			return frappe
				.call("pospire.pospire.api.posapp.create_opening_voucher", {
					pos_profile: this.pos_profile,
					company: this.company,
					balance_details,
					denomination_details,
				})
				.then((r) => {
					if (r.message) {
						this.eventBus.emit("register_pos_data", r.message);
						this.eventBus.emit("set_company", r.message.company);
						this.close_opening_dialog();
					}
				})
				.finally(() => {
					this.is_loading = false;
				});
		},
		go_desk() {
			frappe.set_route("/");
			location.reload();
		},
	},
	created: function () {
		this.$nextTick(function () {
			this.get_opening_dialog_data();
		});
	},
};
</script>