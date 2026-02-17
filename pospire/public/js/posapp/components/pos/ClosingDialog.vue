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
			<v-card-text class="px-6 py-4">
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
							type="text"
							inputmode="decimal"
							density="compact"
							variant="outlined"
							:rules="amountRules"
							:prefix="currencySymbol(pos_profile.currency)"
							hide-details
							class="mt-n1"
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
			</v-card-text>

			<v-divider></v-divider>
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
		amountRules,
		pagination: {},
	}),
	watch: {},

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

	created: function () {
		this.eventBus.on("open_ClosingDialog", (data) => {
			this.closingDialog = true;
			this.dialog_data = data;
		});
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
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
