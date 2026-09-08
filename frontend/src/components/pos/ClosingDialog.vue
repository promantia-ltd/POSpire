<template>
	<v-dialog
		v-model="closingDialog"
		max-width="1300"
		width="95vw"
		persistent
		scrollable
		:fullscreen="isFullscreen"
	>
		<v-card
			:rounded="isFullscreen ? 0 : 'xl'"
			elevation="8"
			class="closing-dialog-card d-flex flex-column"
			:class="{ 'closing-dialog-card--fullscreen': isFullscreen }"
		>
			<v-card-title
				class="d-flex align-center px-4 px-sm-6 py-4 enhanced-modal-header"
			>
				<v-avatar rounded="lg" size="40" color="primary" variant="tonal" class="mr-3 mr-sm-4">
					<v-icon icon="mdi-cash-register" size="22" color="primary" />
				</v-avatar>
				<div class="flex-grow-1 min-width-0">
					<div class="text-h6 font-weight-bold">{{ __("Close POS Shift") }}</div>
					<div class="text-body-2 text-medium-emphasis d-none d-sm-block">
						{{ __("Review payment totals and count closing cash") }}
					</div>
				</div>
				<v-btn icon="mdi-close" variant="text" @click="close_dialog"></v-btn>
			</v-card-title>

			<v-divider></v-divider>

			<v-card-text class="overflow-y-auto pa-4 pa-sm-6 flex-grow-1">
				<!--
					Two wordings, never both. The contribution ledger records
					every sale, online and offline, so its figure is merely
					unconfirmed. The outbox scan (`pospire_source === "scan"`)
					is structurally blind to sales made earlier while online —
					dropping that caveat there would present an incomplete
					figure as a complete one. A stub with no discriminator at
					all gets the cautious wording.
				-->
				<v-alert
					v-if="dialog_data.pospire_offline_stub && dialog_data.pospire_source === 'ledger'"
					type="warning"
					variant="tonal"
					density="compact"
					class="mb-3"
				>
					{{ __("Expected amounts are provisional: computed on this device and not yet confirmed by the server.") }}
				</v-alert>
				<v-alert
					v-else-if="dialog_data.pospire_offline_stub"
					type="warning"
					variant="tonal"
					density="compact"
					class="mb-3"
				>
					{{ __("Expected amounts are provisional: computed on this device and not yet confirmed by the server. Sales made earlier while online are not included.") }}
				</v-alert>
				<v-alert
					v-if="dialog_data.pospire_uncertain_count"
					type="info"
					variant="tonal"
					density="compact"
					class="mb-3"
				>
					{{ __("Some contributions are not yet recorded on the server. Affected invoices:") }}
					{{ dialog_data.pospire_uncertain_count }}
				</v-alert>

				<v-row dense class="mb-2">
					<v-col cols="12" sm="6" md="3">
						<v-text-field
							:model-value="companyDisplay"
							:label="__('Store')"
							readonly
							variant="outlined"
							density="comfortable"
							prepend-inner-icon="mdi-domain"
							hide-details
						/>
					</v-col>
					<v-col cols="12" sm="6" md="3">
						<v-text-field
							:model-value="profileDisplay"
							:label="__('POS Profile')"
							readonly
							variant="outlined"
							density="comfortable"
							prepend-inner-icon="mdi-monitor"
							hide-details
						/>
					</v-col>
					<v-col cols="12" md="6">
						<v-card variant="outlined" rounded="lg" class="pa-3 h-100 d-flex flex-wrap shift-meta-card">
							<div class="shift-meta-item d-flex align-center">
								<v-icon icon="mdi-clock-outline" size="18" class="mr-2 text-medium-emphasis" />
								<div>
									<div class="text-caption text-medium-emphasis">{{ __("Opened At") }}</div>
									<div class="text-body-2 font-weight-bold">{{ openedAtDisplay }}</div>
								</div>
							</div>
							<v-divider vertical class="mx-3" />
							<div class="shift-meta-item d-flex align-center">
								<v-icon icon="mdi-account-outline" size="18" class="mr-2 text-medium-emphasis" />
								<div class="min-width-0">
									<div class="text-caption text-medium-emphasis">{{ __("Opened By") }}</div>
									<div class="text-body-2 font-weight-bold text-truncate">{{ openedByDisplay }}</div>
								</div>
							</div>
							<v-divider vertical class="mx-3" />
							<div class="shift-meta-item d-flex align-center">
								<v-icon icon="mdi-timer-outline" size="18" class="mr-2 text-medium-emphasis" />
								<div>
									<div class="text-caption text-medium-emphasis">{{ __("Shift Duration") }}</div>
									<div class="text-body-2 font-weight-bold">{{ shiftDurationDisplay }}</div>
								</div>
							</div>
						</v-card>
					</v-col>
				</v-row>

				<div class="d-flex align-center mb-1 mt-2">
					<v-icon icon="mdi-clipboard-text-outline" class="mr-2" color="primary" />
					<span class="text-subtitle-1 font-weight-bold">{{ __("Payment Reconciliation") }}</span>
				</div>
				<div class="text-body-2 text-medium-emphasis mb-3">
					{{ __("Enter closing amount for each payment mode") }}
				</div>

				<div class="table-scroll mb-2">
					<v-data-table
						:headers="headers"
						:items="dialog_data.payment_reconciliation"
						item-key="mode_of_payment"
						class="rounded-lg elevation-1"
						:items-per-page="-1"
						:mobile="isNarrow"
						density="comfortable"
						hide-default-footer
					>
						<template v-slot:item.mode_of_payment="{ item }">
							<div class="d-flex align-center">
								<v-icon :icon="paymentModeIcon(item.mode_of_payment)" size="18" class="mr-2" />
								{{ item.mode_of_payment }}
							</div>
						</template>

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
							<span
								class="font-mono text-no-wrap d-inline-flex align-center"
								:style="differenceStyle(item)"
							>
								<v-icon v-if="differenceIcon(item)" :icon="differenceIcon(item)" size="14" class="mr-1" />
								{{ currencySymbol(pos_profile.currency) }}
								{{ formatCurrency(Math.abs(differenceValue(item))) }}
							</span>
						</template>
					</v-data-table>
				</div>
				<div class="d-flex align-center text-caption text-medium-emphasis mb-4">
					<v-icon icon="mdi-information-outline" size="14" class="mr-1" />
					{{ __("Difference is calculated as expected amount minus closing amount.") }}
				</div>

				<!-- Denomination Grid -->
				<v-card v-if="has_denominations && denominations_enabled" variant="outlined" rounded="lg" class="pa-4 mb-4">
					<div class="d-flex align-center mb-1">
						<v-icon icon="mdi-cash" class="mr-2" color="primary" />
						<span class="text-subtitle-1 font-weight-bold">{{ __("Closing Cash (Cash Only)") }}</span>
					</div>
					<div class="text-body-2 text-medium-emphasis mb-4">
						{{ __("Enter quantity for each denomination. Total will be calculated automatically.") }}
					</div>

					<!--
						CSS grid, not v-row/v-col — same reasoning as the payment
						chip grid above: a stepper row (two 44px buttons + the
						qty field) needs ~160px, which cols="6" doesn't reliably
						give at xs (a 360px phone works out closer to 120px per
						card there), squashing the buttons back under the touch
						minimum. auto-fill/minmax sizes off the actual container
						width instead of a viewport breakpoint.
					-->
					<div class="denom-grid">
						<v-card
							v-for="row in dialog_data.denomination_details"
							:key="row.denomination"
							variant="outlined"
							rounded="lg"
							class="pa-3 denom-card"
						>
							<div class="d-flex align-center justify-space-between mb-2">
								<span class="text-body-2 font-weight-bold text-truncate">
									{{ row.denomination_name }}
								</span>
								<v-icon icon="mdi-cash" size="16" color="success" />
							</div>
							<div class="d-flex align-center justify-center mb-2">
								<v-btn
									icon="mdi-minus"
									size="44"
									variant="tonal"
									:disabled="!row.closing_quantity"
									:aria-label="__('Decrease quantity for ') + row.denomination_name"
									class="denom-stepper-btn"
									@click="decrementDenom(row)"
								/>
								<v-text-field
									v-model.number="row.closing_quantity"
									type="number"
									min="0"
									density="compact"
									variant="plain"
									hide-details
									:aria-label="__('Quantity')"
									class="denom-qty-input mx-2"
								/>
								<v-btn
									icon="mdi-plus"
									size="44"
									variant="tonal"
									:aria-label="__('Increase quantity for ') + row.denomination_name"
									class="denom-stepper-btn"
									@click="incrementDenom(row)"
								/>
							</div>
							<div class="text-body-2 text-medium-emphasis text-center">
								{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(row.closing_amount) }}
							</div>
						</v-card>
					</div>

					<v-divider class="my-4" />

					<div class="d-flex align-center denom-summary">
						<v-avatar rounded="lg" color="primary" variant="tonal" size="40" class="mr-3">
							<v-icon icon="mdi-calculator-variant-outline" color="primary" />
						</v-avatar>
						<div>
							<div class="text-caption text-medium-emphasis">{{ __("Counted Cash Total") }}</div>
							<div class="text-h6 font-weight-bold text-primary">
								{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(closing_total) }}
							</div>
						</div>
					</div>
				</v-card>

				<!-- Overall summary -->
				<v-card color="primary" variant="tonal" rounded="lg" class="pa-4">
					<div class="d-flex align-center mb-3">
						<v-icon icon="mdi-scale-balance" class="mr-2" color="primary" />
						<span class="text-subtitle-1 font-weight-bold">{{ __("Shift Overall Summary") }}</span>
					</div>
					<v-row dense>
						<v-col cols="12" sm="4">
							<div class="text-caption text-medium-emphasis">{{ __("Total Expected") }}</div>
							<div class="text-h6 font-weight-bold">
								{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(totalExpected) }}
							</div>
						</v-col>
						<v-col cols="12" sm="4">
							<div class="text-caption text-medium-emphasis">{{ __("Total Closing") }}</div>
							<div class="text-h6 font-weight-bold">
								{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(totalClosing) }}
							</div>
						</v-col>
						<v-col cols="12" sm="4">
							<div class="text-caption text-medium-emphasis">{{ __("Total Difference") }}</div>
							<div
								class="text-h6 font-weight-bold d-flex align-center"
								:style="totalDifferenceStyle"
							>
								<v-icon v-if="totalDifferenceIcon" :icon="totalDifferenceIcon" size="16" class="mr-1" />
								{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(Math.abs(totalDifferenceValue)) }}
							</div>
						</v-col>
					</v-row>
				</v-card>
			</v-card-text>

			<v-divider />
			<v-card-actions
				class="px-4 px-sm-6 py-4"
				:class="isNarrow ? 'flex-column ga-2' : ''"
			>
				<v-btn
					variant="text"
					color="grey-darken-1"
					:block="isNarrow"
					@click="show_reset_confirm = true"
				>
					{{ __("Reset") }}
				</v-btn>
				<v-spacer v-if="!isNarrow" />
				<v-btn
					variant="outlined"
					color="grey-darken-1"
					:block="isNarrow"
					@click="close_dialog"
				>
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					variant="elevated"
					color="primary"
					append-icon="mdi-lock-outline"
					:block="isNarrow"
					@click="submit_dialog"
				>
					{{ __("Close Shift") }}
				</v-btn>
			</v-card-actions>
		</v-card>

		<ResetConfirmDialog
			v-model="show_reset_confirm"
			@confirm="reset_form"
			@cancel="show_reset_confirm = false"
		/>
	</v-dialog>
</template>

<script>
import format from "@/utils/format";
import { toast } from "vue3-toastify";
import { amountRules, isAmountValid } from "@/utils/validation";
import busListeners from "@/utils/busListeners";
import { paymentModeIcon } from "@/utils/paymentModeIcon";
import { datetime } from "@/utils/datetime";
import ResetConfirmDialog from "@/components/pos/ResetConfirmDialog.vue";
export default {
	components: { ResetConfirmDialog },
	mixins: [format, busListeners],
	data: () => ({
		closingDialog: false,
		show_reset_confirm: false,
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
		paymentModeIcon,
		close_dialog() {
			this.closingDialog = false;
		},
		numberAmount(val) {
			return Number(val || 0);
		},
		/** expected - closing: positive = shortage (counted less), negative = excess (counted more). */
		differenceValue(item) {
			return this.numberAmount(item.expected_amount) - this.numberAmount(item.closing_amount);
		},
		/**
		 * Vuetify's `text-success`/`text-error`/`text-warning` theme fills
		 * measure 2.36:1, 3.19:1, and 2.16:1 against a white card background
		 * — all three fail WCAG AA's 4.5:1 for body text (the "matched" case
		 * was actually the worst of the three). These are cash-variance
		 * figures on a till, meant to be read under bad lighting, so
		 * contrast matters more than reusing the theme palette. `#2E7D32`
		 * (5.13:1), `#C0392B` (5.44:1), and `#A85D00` (4.96:1) all clear AA
		 * on light. The dark-theme branch is defensive only — this app has
		 * no dark theme/toggle wired up yet, so `dark` is never actually
		 * true and those values are untested; swap them for verified ones
		 * before a dark theme ships.
		 */
		varianceColor(diff) {
			const dark = this.$vuetify.theme.global.name.value === "dark";
			if (Math.abs(diff) < 0.01) return dark ? "#81C784" : "#2E7D32"; // matched
			if (diff > 0) return dark ? "#EF5350" : "#C0392B"; // shortage
			return dark ? "#FFB74D" : "#A85D00"; // excess
		},
		differenceStyle(item) {
			return { color: this.varianceColor(this.differenceValue(item)) };
		},
		/** Non-color signal for the same shortage/excess distinction, for colorblind users. */
		differenceIcon(item) {
			const diff = this.differenceValue(item);
			if (Math.abs(diff) < 0.01) return null;
			return diff > 0 ? "mdi-arrow-down-bold" : "mdi-arrow-up-bold";
		},
		incrementDenom(row) {
			row.closing_quantity = (row.closing_quantity || 0) + 1;
		},
		decrementDenom(row) {
			row.closing_quantity = Math.max(0, (row.closing_quantity || 0) - 1);
		},
		/** Clears every entered closing amount/quantity back to 0. */
		reset_form() {
			(this.dialog_data.payment_reconciliation || []).forEach((p) => {
				p.closing_amount = 0;
			});
			(this.dialog_data.denomination_details || []).forEach((row) => {
				row.closing_quantity = 0;
			});
			this.show_reset_confirm = false;
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
		/** Narrow viewport. Drives anything that stacks or reflows for width. */
		isNarrow() {
			return this.$vuetify.display.smAndDown;
		},
		/** Narrow OR short. Drives fullscreen only — a short-but-wide laptop
		 *  window shouldn't lose the two-column layout just to fit vertically. */
		isFullscreen() {
			return this.isNarrow || this.$vuetify.display.height < 700;
		},

		closing_total() {
			if (!this.dialog_data.denomination_details) return 0;
			return this.dialog_data.denomination_details.reduce(
				(sum, d) => sum + (d.closing_amount || 0),
				0
			);
		},

		companyDisplay() {
			return this.dialog_data.company || this.pos_profile.company || "—";
		},
		profileDisplay() {
			return this.dialog_data.pos_profile || this.pos_profile.name || "—";
		},
		openedAtDisplay() {
			if (!this.dialog_data.period_start_date) return "—";
			const d = datetime.str_to_obj(this.dialog_data.period_start_date);
			if (!d || Number.isNaN(d.getTime())) return "—";
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		},
		openedByDisplay() {
			return this.dialog_data.user || "—";
		},
		/**
		 * `period_end_date` comes straight from the server on the online path
		 * (`make_closing_shift_from_opening` stamps it with `frappe.utils.
		 * get_datetime()`). The offline stub built in Pos.vue has no server
		 * round-trip to get a "now" from, so it omits the field entirely —
		 * backfilled once here (see `open_ClosingDialog` handler below) rather
		 * than requiring every reader to fall back individually.
		 */
		shiftDurationDisplay() {
			const start = this.dialog_data.period_start_date;
			const end = this.dialog_data.period_end_date;
			if (!start || !end) return "—";
			const startMs = datetime.str_to_obj(start)?.getTime();
			const endMs = datetime.str_to_obj(end)?.getTime();
			if (!startMs || !endMs || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
				return "—";
			}
			const totalMinutes = Math.floor((endMs - startMs) / 60000);
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
		},

		totalExpected() {
			return (this.dialog_data.payment_reconciliation || []).reduce(
				(sum, p) => sum + this.numberAmount(p.expected_amount),
				0,
			);
		},
		totalClosing() {
			return (this.dialog_data.payment_reconciliation || []).reduce(
				(sum, p) => sum + this.numberAmount(p.closing_amount),
				0,
			);
		},
		totalDifferenceValue() {
			return this.totalExpected - this.totalClosing;
		},
		totalDifferenceStyle() {
			return { color: this.varianceColor(this.totalDifferenceValue) };
		},
		totalDifferenceIcon() {
			if (Math.abs(this.totalDifferenceValue) < 0.01) return null;
			return this.totalDifferenceValue > 0 ? "mdi-arrow-down-bold" : "mdi-arrow-up-bold";
		},
	},

	created: function () {
	this.onBus("open_ClosingDialog", (data) => {
		this.closingDialog = true;
		this.dialog_data = data;
		// Online payloads carry a server-stamped `period_end_date`; the
		// offline stub (Pos.vue's `buildOfflineClosingStub`) has no
		// round-trip to get one from, so backfill "now" here — see
		// `shiftDurationDisplay`.
		if (!this.dialog_data.period_end_date) {
			this.dialog_data.period_end_date = datetime.get_datetime_as_string(new Date());
		}
		this.has_denominations =
			data.denomination_details && data.denomination_details.length > 0;
	});

	this.onBus("register_pos_profile", (data) => {
		this.pos_profile = data.pos_profile;
		this.denominations_enabled = this.pos_profile.custom_enable_cash_denominations || false;
		// Reset to base columns each time — this event fires multiple times
		// (snapshot hydration + opening dialog), and push()ing without a guard
		// duplicates the optional columns on every firing.
		this.headers = [
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
		];
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

.closing-dialog-card--fullscreen {
	width: 100%;
	height: 100%;
}

.min-width-0 {
	min-width: 0;
}

.table-scroll {
	overflow-x: auto;
}

.shift-meta-card {
	gap: 12px;
	align-items: center;
}

.shift-meta-item {
	min-width: 0;
	flex: 1 1 auto;
}

.denom-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
	gap: 8px;
}

.denom-card {
	height: 100%;
}

.denom-stepper-btn {
	flex: 0 0 auto;
}

.denom-qty-input {
	width: 56px;
	flex: 0 0 auto;
}

.denom-qty-input :deep(input) {
	text-align: center;
}

.denom-summary > div {
	min-width: 0;
}

@media (max-width: 599px) {
	.denom-summary {
		gap: 12px;
	}

	/*
	 * pos-enhancements.css forces `.enhanced-modal-header` / `.v-card-actions`
	 * / `.v-card-text` padding with `!important` and no media query, silently
	 * cancelling the `px-4`/`pa-4` mobile-reduced padding classes on the
	 * header, footer, and body below `sm`. These overrides restore that
	 * reduction — same padding value the utility classes were already trying
	 * to set.
	 *
	 * The `.v-card-actions` rule needs `.v-card` in the chain specifically:
	 * the winning global selector is `body:has(.pos-page) .v-dialog .v-card >
	 * .v-card-actions` (pos-enhancements.css), which is 4 classes + 1 element
	 * (body) — a bare `.closing-dialog-card.d-flex .v-card-actions` ties on
	 * classes (4) and loses on the element tiebreak. Adding `.v-card` here
	 * brings it to 5 classes, which wins outright before types are compared.
	 */
	.closing-dialog-card.d-flex .v-card-title.enhanced-modal-header,
	.closing-dialog-card.v-card.d-flex .v-card-actions {
		padding: 16px !important;
	}

	.closing-dialog-card.d-flex .v-card-text {
		padding: 16px !important;
	}
}
</style>
