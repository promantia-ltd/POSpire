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

			<v-card-text class="px-6 py-4">
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
										type="text"
										inputmode="decimal"
										density="compact"
										variant="outlined"
										:rules="amountRules"
										:prefix="currencySymbol(props.item.currency)"
										hide-details
										class="mt-n1"
									/>
								</template>
							</v-data-table>
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
		},
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
					}
				},
			});
		},
		submit_dialog() {
			if (!this.payments_methods.length || !this.company || !this.pos_profile) {
				return;
			}
			const has_invalid_amount = this.payments_methods.some((p) => !isAmountValid(p.amount));
			if (has_invalid_amount) {
				toast.error(__("Please enter valid non-negative amounts."), {
					autoClose: 5000,
				});
				return;
			}
			this.is_loading = true;
			const vm = this;
			const balance_details = this.payments_methods.map((p) => ({
				...p,
				amount:
					p.amount === "" || p.amount === null || p.amount === undefined
						? 0
						: Number(p.amount),
			}));
			return frappe
				.call("pospire.pospire.api.posapp.create_opening_voucher", {
					pos_profile: this.pos_profile,
					company: this.company,
					balance_details,
				})
				.then((r) => {
					if (r.message) {
						vm.eventBus.emit("register_pos_data", r.message);
						vm.eventBus.emit("set_company", r.message.company);
						vm.close_opening_dialog();
						vm.is_loading = false;
					}
				})
				.finally(() => {
					vm.is_loading = false;
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
