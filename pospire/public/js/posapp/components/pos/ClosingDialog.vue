<template>
	<v-dialog v-model="closingDialog" max-width="900px" width="95vw" persistent>
		<v-card rounded="xl" elevation="8" class="closing-dialog-card">
			<v-card-title
				class="d-flex align-center justify-space-between px-6 py-4 enhanced-modal-header"
			>
				<span class="text-h6 font-weight-bold text-primary">
					{{ __("Closing POS Shift") }}
				</span>
				<v-btn icon="mdi-close" variant="text" @click="close_dialog"></v-btn>
			</v-card-title>

			<v-divider></v-divider>
			<v-card-text class="px-6 py-4 overflow-y-auto" style="max-height:65vh;">
				<v-data-table
					:headers="headers"
					:items="dialog_data.payment_reconciliation"
					item-key="mode_of_payment"
					class="rounded-lg elevation-1"
					:items-per-page="itemsPerPage"
					density="comfortable"
					hide-default-footer
				>
					<template v-slot:item.opening_amount="{ item }">
						<span class="font-mono">
							{{ currencySymbol(pos_profile.currency) }}
							{{ formatCurrency(item.opening_amount) }}
						</span>
					</template>

					<template v-slot:item.expected_amount="{ item }">
						<span class="font-mono">
							{{ currencySymbol(pos_profile.currency) }}
							{{ formatCurrency(item.expected_amount) }}
						</span>
					</template>

					<template v-slot:item.closing_amount="props">
						<v-text-field
							v-model.number="props.item.closing_amount"
							type="number"
							min="0"
							density="compact"
							variant="outlined"
							:rules="amountRules"
							:prefix="currencySymbol(pos_profile.currency)"
							hide-details
							class="mt-n1"
							:readonly="
								has_denominations &&
								denominations_enabled &&
								props.item.mode_of_payment === pos_profile.posa_cash_mode_of_payment
							"
							/>
					</template>

					<template v-slot:item.difference="{ item }">
						<span class="font-mono text-no-wrap" :class="differenceClass(item)">
							{{ currencySymbol(pos_profile.currency) }}
							{{
								formatCurrency(
									numberAmount(item.expected_amount) -
										numberAmount(item.closing_amount)
								)
							}}
						</span>
					</template>
				</v-data-table>
				<!-- Denomination Grid -->
				 <div v-if="has_denominations && denominations_enabled" class="mt-4 ">
					<h4 class="mb-2">{{ __("Denomination Details") }}</h4>
					<v-data-table
						:headers="denomination_headers"
						:items="dialog_data.denomination_details"
						item-key="denomination"
						hide-default-footer
						density="comfortable"
						class="rounded-lg elevation-1"
					>
						<template v-slot:item.closing_quantity="{ item }">
							<v-text-field
								v-model.number="item.closing_quantity"
								type="number"
								min="0"
								density="compact"
								variant="outlined"
								hide-details
							/>
						</template>
						<template v-slot:item.closing_amount="{ item }">
							<span class="font-mono">
								{{ currencySymbol(pos_profile.currency) }}
								{{ formatCurrency(item.closing_amount) }}
							</span>
						</template>
						<template v-slot:body.append>
							<tr class="font-weight-bold">
								<td>Total</td>
								<td></td>
								<td class="text-end">
									{{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(closing_total) }}
								</td>
							</tr>
						</template>
					</v-data-table>
				</div>
			</v-card-text>
			<v-card-actions class="px-6 py-4 enhanced-modal-header">
				<v-spacer />
				<v-btn variant="text" color="grey-darken-1" @click="close_dialog">
					{{ __("Close") }}
				</v-btn>
				<v-btn variant="elevated" color="primary" @click="submit_dialog">
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
	data: () => ({
		closingDialog: false,
		itemsPerPage: 20,
		dialog_data: {},
		pos_profile: "",
		headers: [
			{
				title: __("Mode of Payment"),
				value: "mode_of_payment",
				align: "start",
				sortable: true,
			},
			{
				title: __("Opening Amount"),
				align: "center",
				sortable: true,
				value: "opening_amount",
			},
			{
				title: __("Closing Amount"),
				value: "closing_amount",
				align: "center",
				sortable: true,
			},
		],
		denomination_headers: [
		{ title: __("Denomination"), value: "denomination_name", width: "45%" },
		{ title: __("Closing Qty"), value: "closing_quantity", align: "start", width: "25%" },
		{ title: __("Closing Amount"), value: "closing_amount", align: "end", width: "30%" },
		],
		amountRules,
		pagination: {},
		has_denominations: false,
		denominations_enabled: false,

	}),
	watch: {
			"dialog_data.denomination_details": {
			handler(rows) {
				if (!rows || !this.has_denominations) return;
				let total = 0;
				rows.forEach((row) => {
					const value = Number(row.denomination_value || 0);
					const qty = Number(row.closing_quantity || 0);

					row.closing_amount = value * qty;
					total += row.closing_amount;
				});
				const cash_mode = this.pos_profile.posa_cash_mode_of_payment || "Cash";
				const cash_row = this.dialog_data.payment_reconciliation.find(
					(r) => r.mode_of_payment === cash_mode
				);
				if (cash_row) {
					cash_row.closing_amount = total;
				}
			},
			deep: true,
		},
	},

	methods: {
		close_dialog() {
			this.closingDialog = false;
		},
		numberAmount(val) {
			return Number(val || 0);
		},
		differenceClass(item) {
			const expected = this.numberAmount(item.expected_amount);
			const closing = this.numberAmount(item.closing_amount);
			const diff = expected - closing;
			return Math.abs(diff) < 0.01 ? "text-success" : "text-error";
		},
		submit_dialog() {
			if (this.dialog_data.denomination_details) {
				const invalidQty = this.dialog_data.denomination_details.some((row) => {
					const qty =
						row.closing_quantity === "" ||
						row.closing_quantity === null ||
						row.closing_quantity === undefined
							? 0
							: Number(row.closing_quantity);

					return qty < 0 || !Number.isInteger(qty);
				});

				if (invalidQty) {
					toast.error(__("Closing quantity must be a non-negative integer."), {
						autoClose: 5000,
					});
					return;
				}
			}

			const payments = this.dialog_data.payment_reconciliation || [];
			const has_invalid_amount = payments.some((p) => !isAmountValid(p.closing_amount));

			if (has_invalid_amount) {
				toast.error(__("Please enter valid non-negative amounts."), {
					autoClose: 5000,
				});
				return;
			}

			this.dialog_data.payment_reconciliation = payments.map((p) => ({
				...p,
				closing_amount:
					p.closing_amount === "" ||
					p.closing_amount === null ||
					p.closing_amount === undefined
						? 0
						: Number(p.closing_amount),
			}));

			this.eventBus.emit("submit_closing_pos", this.dialog_data);
			this.closingDialog = false;
		},
	},
	computed: {
		closing_total() {
			if (!this.dialog_data.denomination_details) return 0;
			return this.dialog_data.denomination_details.reduce(
				(sum, d) => sum + (d.closing_amount || 0),
				0
			);
		}
	},

	created: function () {
	this.eventBus.on("open_ClosingDialog", (data) => {
		this.closingDialog = true;
		this.dialog_data = data;
		this.has_denominations =
			data.denomination_details && data.denomination_details.length > 0;
	});

	this.eventBus.on("register_pos_profile", (data) => {
	this.pos_profile = data.pos_profile;
	this.denominations_enabled = this.pos_profile.custom_enable_cash_denominations || false;
	if (!this.pos_profile.hide_expected_amount) {
		this.headers.push({
			title: __("Expected Amount"),
			value: "expected_amount",
			align: "end",
			sortable: false,
		});
		this.headers.push({
			title: __("Difference"),
			value: "difference",
			align: "end",
			sortable: false,
		});
	}
	});
	},
};
</script>

<style scoped>
.text-no-wrap {
	white-space: nowrap;
}

.closing-dialog-card {
	width: min(900px, 95vw);
}
</style>