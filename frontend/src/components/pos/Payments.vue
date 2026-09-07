<template>
	<div class="pos-panel-container">
		<v-card elevation="2" rounded="lg" class="selection pos-scrollable-content">
			<v-progress-linear
				:active="loading"
				:indeterminate="loading"
				absolute
				:location="top"
				color="info"
			></v-progress-linear>
			<div class="overflow-y-auto pa-4">
				<!-- Payment Status Section -->
				<div class="mb-4 blue-grey-lighten-5" v-if="invoice_doc">
					<v-card variant="flat" class="mb-3 section-header">
						<v-card-title class="section-header-title font-weight-bold">
							<v-icon start size="20" color="primary">mdi-cash-multiple</v-icon>
							<span class="section-title-text">Payment Summary</span>
						</v-card-title>
					</v-card>
					<v-row class="mb-2">
						<v-col cols="7">
							<v-text-field
								variant="outlined"
								color="primary"
								:label="__('Paid Amount')"
								bg-color="surface"
								hide-details
								:model-value="formatCurrency(total_payments)"
								readonly
								:prefix="currencySymbol(invoice_doc.currency)"
								density="compact"
							></v-text-field>
						</v-col>
						<v-col cols="5">
							<v-text-field
								variant="outlined"
								color="primary"
								:label="__(diff_lable)"
								bg-color="surface"
								hide-details
								:model-value="formatCurrency(diff_payment)"
								readonly
								:prefix="currencySymbol(invoice_doc.currency)"
								density="compact"
							></v-text-field>
						</v-col>
					</v-row>
				</div>

				<!-- Change Details Section -->
				<div class="mb-4" v-if="diff_payment < 0 && !invoice_doc.is_return">
					<v-card variant="flat" class="mb-3 section-header">
						<v-card-title class="section-header-title font-weight-bold">
							<v-icon start size="20" color="primary">mdi-cash-refund</v-icon>
							<span class="section-title-text">Change Details</span>
						</v-card-title>
					</v-card>
					<v-row>
						<v-col cols="7">
							<v-text-field
								variant="outlined"
								color="primary"
								:label="__('Paid Change')"
								bg-color="surface"
								v-model="paid_change"
								@update:model-value="set_paid_change()"
								:prefix="currencySymbol(invoice_doc.currency)"
								:rules="paid_change_rules"
								density="compact"
								readonly
								type="number"
							></v-text-field>
						</v-col>

						<v-col cols="5" v-if="diff_payment < 0 && !invoice_doc.is_return">
							<v-text-field
								variant="outlined"
								color="primary"
								:label="__('Credit Change')"
								bg-color="surface"
								hide-details
								:model-value="formatCurrency(credit_change)"
								readonly
								:prefix="currencySymbol(invoice_doc.currency)"
								density="compact"
							></v-text-field>
						</v-col>
					</v-row>
				</div>

				<v-divider class="my-4"></v-divider>

				<!-- Payment Methods Section -->
				<div class="mb-4" v-if="show_payment_methods">
					<v-card variant="flat" class="mb-3 section-header">
						<v-card-title class="section-header-title font-weight-bold">
							<v-icon start size="20" color="primary">mdi-credit-card</v-icon>
							<span class="section-title-text">Payment Methods</span>
						</v-card-title>
					</v-card>
					<v-row
						class="pyments mb-2"
						v-for="payment in invoice_doc.payments"
						:key="payment.name"
					>
						<v-col cols="6" v-if="!is_mpesa_c2b_payment(payment)">
							<v-text-field
								density="compact"
								variant="outlined"
								color="primary"
								:label="__(payment.mode_of_payment)"
								bg-color="surface"
								hide-details
								v-model="payment.amount"
								:rules="[isNumber]"
								:prefix="currencySymbol(invoice_doc.currency)"
								placeholder="0"
								persistent-placeholder
								@focus="set_rest_amount(payment.idx)"
								:readonly="invoice_doc.is_return ? true : false"
							></v-text-field>
						</v-col>
						<v-col
							v-if="!is_mpesa_c2b_payment(payment)"
							:cols="
								6
									? (payment.type != 'Phone' ||
											payment.amount == 0 ||
											!request_payment_field) &&
									  !is_mpesa_c2b_payment(payment)
									: 3
							"
						>
							<v-btn
								block
								variant="outlined"
								size="large"
								rounded="md"
								class="payment-method-btn"
								@click="set_full_amount(payment.idx)"
							>
								<v-icon start size="20" color="primary">mdi-cash</v-icon>
								{{ payment.mode_of_payment }}
							</v-btn>
						</v-col>
						<v-col v-if="is_mpesa_c2b_payment(payment)" :cols="12" class="pl-3">
							<v-btn
								block
								variant="elevated"
								color="success"
								size="large"
								rounded="lg"
								elevation="3"
								class="payment-method-btn"
								@click="mpesa_c2b_dialg(payment)"
							>
								<v-icon start size="20">mdi-phone</v-icon>
								{{ __(`Get Payments ${payment.mode_of_payment}`) }}
							</v-btn>
						</v-col>
						<v-col
							v-if="
								payment.type == 'Phone' &&
								payment.amount > 0 &&
								request_payment_field
							"
							:cols="3"
							class="pl-1"
						>
							<v-btn
								block
								variant="elevated"
								color="success"
								size="large"
								rounded="lg"
								elevation="3"
								class="payment-method-btn"
								:disabled="payment.amount == 0"
								@click="
									(phone_dialog = true),
										(payment.amount = flt(payment.amount, 0))
								"
							>
								<v-icon start size="20">mdi-send</v-icon>
								{{ __("Request") }}
							</v-btn>
						</v-col>
					</v-row>
				</div>

				<v-row
					class="pyments loyalty-redemption-row px-1"
					v-if="invoice_doc && available_pioints_amount > 0 && !invoice_doc.is_return"
				>
					<v-col cols="12" sm="7" class="py-1">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Redeem Loyalty Points')"
							bg-color="surface"
							hide-details
							v-model="loyalty_amount"
							type="number"
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col cols="12" sm="5" class="py-1">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('You can redeem upto')"
							bg-color="surface"
							hide-details
							:model-value="formatFloat(available_pioints_amount)"
							:prefix="currencySymbol(invoice_doc.currency)"
							disabled
						></v-text-field>
					</v-col>
				</v-row>

				<v-row
					class="pyments px-1 py-0"
					v-if="
						invoice_doc &&
						available_customer_credit > 0 &&
						!invoice_doc.is_return &&
						redeem_customer_credit
					"
				>
					<v-col cols="7">
						<v-text-field
							density="compact"
							variant="outlined"
							disabled
							color="primary"
							:label="__('Redeemed Customer Credit')"
							bg-color="surface"
							hide-details
							v-model="redeemed_customer_credit"
							type="number"
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col cols="5">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('You can redeem credit upto')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(available_customer_credit)"
							:prefix="currencySymbol(invoice_doc.currency)"
							disabled
						></v-text-field>
					</v-col>
				</v-row>
				<v-divider></v-divider>

				<v-row class="px-1 py-0">
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Net Total')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.net_total)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Tax and Charges')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.total_taxes_and_charges)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Total Amount')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.total)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Discount Amount')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.discount_amount)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>

					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Delivery Charge')"
							bg-color="surface"
							hide-details
							:model-value="
								formatCurrency(invoice_doc.custom_delivery_charge_rate || 0)
							"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>

					<v-col cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Grand Total')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.grand_total)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col v-if="invoice_doc.rounded_total" cols="6">
						<v-text-field
							density="compact"
							variant="outlined"
							color="primary"
							:label="__('Rounded Total')"
							bg-color="surface"
							hide-details
							:model-value="formatCurrency(invoice_doc.rounded_total)"
							readonly
							:prefix="currencySymbol(invoice_doc.currency)"
						></v-text-field>
					</v-col>
					<v-col
						cols="6"
						v-if="pos_profile.posa_allow_sales_order && invoiceType == 'Order'"
					>
						<v-menu
							ref="order_delivery_date"
							v-model="order_delivery_date"
							:close-on-content-click="false"
							transition="scale-transition"
							density="default"
						>
							<template v-slot:activator="{ props }">
								<v-text-field
									v-model="invoice_doc.posa_delivery_date"
									:label="__('Delivery Date')"
									readonly
									variant="outlined"
									density="compact"
									bg-color="surface"
									clearable
									color="primary"
									hide-details
									v-bind="props"
								></v-text-field>
							</template>
							<v-date-picker
								:v-model="new Date(invoice_doc.posa_delivery_date)"
								no-title
								scrollable
								color="primary"
								:min="datetime.now_date()"
								@input="order_delivery_date = false"
							>
							</v-date-picker>
						</v-menu>
					</v-col>
					<v-col cols="12" v-if="invoice_doc.posa_delivery_date">
						<v-autocomplete
							density="compact"
							clearable
							auto-select-first
							variant="outlined"
							color="primary"
							:label="__('Address')"
							v-model="invoice_doc.shipping_address_name"
							:items="addresses"
							item-title="address_title"
							item-value="name"
							bg-color="surface"
							no-data-text="Address not found"
							hide-details
							:customFilter="addressFilter"
							append-icon="mdi-plus"
							@click:append="new_address"
						>
							<template v-slot:item="{ props, item }">
								<v-list-item v-bind="props">
									<v-list-item-title class="text-primary text-subtitle-1">
										<div>{{ item.raw.address_title }}</div>
									</v-list-item-title>
									<v-list-item-title>
										<div>{{ item.raw.address_line1 }}</div>
									</v-list-item-title>
									<v-list-item-subtitle
										v-if="item.raw.custoaddress_line2mer_name"
									>
										<div>{{ item.raw.address_line2 }}</div>
									</v-list-item-subtitle>
									<v-list-item-subtitle v-if="item.raw.city">
										<div>{{ item.raw.city }}</div>
									</v-list-item-subtitle>
									<v-list-item-subtitle v-if="item.raw.state">
										<div>{{ item.raw.state }}</div>
									</v-list-item-subtitle>
									<v-list-item-subtitle v-if="item.raw.country">
										<div>{{ item.raw.mobile_no }}</div>
									</v-list-item-subtitle>
									<v-list-item-subtitle v-if="item.raw.address_type">
										<div>{{ item.raw.address_type }}</div>
									</v-list-item-subtitle>
								</v-list-item>
							</template>
						</v-autocomplete>
					</v-col>
					<v-col cols="12" v-if="pos_profile.posa_display_additional_notes">
						<v-textarea
							class="pa-0"
							variant="outlined"
							density="compact"
							bg-color="surface"
							clearable
							color="primary"
							auto-grow
							rows="2"
							:label="__('Additional Notes')"
							v-model="invoice_doc.posa_notes"
							:model-value="invoice_doc.posa_notes"
						></v-textarea>
					</v-col>
				</v-row>

				<div v-if="pos_profile.posa_allow_customer_purchase_order">
					<v-divider></v-divider>
					<v-row class="px-1 py-0" justify="center" align="start">
						<v-col cols="6">
							<v-text-field
								v-model="invoice_doc.po_no"
								:label="__('Purchase Order')"
								variant="outlined"
								density="compact"
								bg-color="surface"
								clearable
								color="primary"
								hide-details
							></v-text-field>
						</v-col>
						<v-col cols="6">
							<v-menu
								ref="po_date_menu"
								v-model="po_date_menu"
								:close-on-content-click="false"
								transition="scale-transition"
							>
								<template v-slot:activator="{ props }">
									<v-text-field
										v-model="invoice_doc.po_date"
										:label="__('Purchase Order Date')"
										readonly
										variant="outlined"
										density="compact"
										hide-details
										v-bind="props"
										color="primary"
									></v-text-field>
								</template>
								<v-date-picker
									v-model="invoice_doc.po_date"
									no-title
									scrollable
									color="primary"
									@input="po_date_menu = false"
								>
								</v-date-picker>
							</v-menu>
						</v-col>
					</v-row>
				</div>
				<v-divider></v-divider>
				<v-row class="px-1 py-0" align="start" no-gutters>
					<v-col
						cols="6"
						v-if="
							pos_profile.posa_allow_write_off_change &&
							diff_payment > 0 &&
							!invoice_doc.is_return
						"
					>
						<v-switch
							v-model="is_write_off_change"
							:color="is_write_off_change ? 'primary' : 'grey'"
							:base-color="is_write_off_change ? 'primary' : 'grey'"
							inset
							dense
							hide-details
							class="small-switch mt-n2 items-start"
						>
							<template #label>
								<span class="text-body-2 font-weight-regular">
									{{ __("Write Off Difference Amount") }}
								</span>
							</template>
						</v-switch>
					</v-col>
					<v-col
						cols="6"
						v-if="pos_profile.posa_allow_credit_sale && !invoice_doc.is_return"
					>
						<v-switch
							v-model="is_credit_sale"
							:color="is_credit_sale ? 'primary' : 'grey'"
							:base-color="is_credit_sale ? 'primary' : 'grey'"
							inset
							dense
							hide-details
							class="small-switch mt-n2 items-start"
						>
							<template #label>
								<span class="text-body-2 font-weight-regular">
									{{ __("Credit Sale") }}
								</span>
							</template>
						</v-switch>
					</v-col>
					<v-col cols="6" v-if="invoice_doc.is_return && pos_profile.use_cashback">
						<v-switch
							v-model="is_cashback"
							:color="is_cashback ? 'primary' : 'grey'"
							:base-color="is_cashback ? 'primary' : 'grey'"
							inset
							dense
							hide-details
							class="small-switch mt-n2 items-start"
						>
							<template #label>
								<span class="text-body-2 font-weight-regular">
									{{ __("Cashback?") }}
								</span>
							</template>
						</v-switch>
					</v-col>
					<v-col cols="6" v-if="is_credit_sale">
						<v-text-field
							v-model="invoice_doc.due_date"
							:label="__('Due Date')"
							variant="outlined"
							density="compact"
							hide-details
							color="primary"
							type="date"
							:min="today_date"
							@blur="validate_due_date"
							@update:model-value="normalize_due_date_input"
						></v-text-field>
					</v-col>
					<v-col
						cols="6"
						v-if="!invoice_doc.is_return && pos_profile.use_customer_credit"
					>
						<v-switch
							v-model="redeem_customer_credit"
							:color="redeem_customer_credit ? 'primary' : 'grey'"
							:base-color="redeem_customer_credit ? 'primary' : 'grey'"
							inset
							dense
							hide-details
							class="small-switch mt-n2 items-start"
							@update:model-value="get_available_credit($event)"
						>
							<template #label>
								<span class="text-body-2 font-weight-regular">
									{{ __("Use Customer Credit") }}
								</span>
							</template>
						</v-switch>
					</v-col>
				</v-row>
				<div
					v-if="
						invoice_doc &&
						available_customer_credit > 0 &&
						!invoice_doc.is_return &&
						redeem_customer_credit
					"
				>
					<v-row v-for="(row, idx) in customer_credit_dict" :key="idx">
						<v-col cols="4">
							<div class="pa-2 py-3">{{ row.credit_origin }}</div>
						</v-col>
						<v-col cols="4">
							<v-text-field
								density="compact"
								variant="outlined"
								color="primary"
								:label="__('Available Credit')"
								bg-color="surface"
								hide-details
								:model-value="formatCurrency(row.total_credit)"
								disabled
								:prefix="currencySymbol(invoice_doc.currency)"
							></v-text-field>
						</v-col>
						<v-col cols="4">
							<v-text-field
								density="compact"
								variant="outlined"
								color="primary"
								:label="__('Redeem Credit')"
								bg-color="surface"
								hide-details
								type="number"
								v-model="row.credit_to_redeem"
								:prefix="currencySymbol(invoice_doc.currency)"
							></v-text-field>
						</v-col>
					</v-row>
				</div>
				<v-divider></v-divider>
			</div>
		</v-card>

		<!-- Action Buttons -->
		<v-card elevation="2" rounded="lg" class="pos-footer-section">
			<v-card-text class="pa-4">
				<v-row align="center" justify="space-between" no-gutters class="flex-wrap">
					<v-col cols="12" md="6" class="pa-1">
						<v-btn
							block
							class="btn-primary-action gradient-teal-animate hover-glow ripple-effect"
							@click="submit"
							:loading="submittingPayment"
							:disabled="vaildatPayment || submittingPayment"
						>
							<v-icon start size="18">mdi-check-circle</v-icon>
							{{ __("Submit") }}
						</v-btn>
					</v-col>

					<v-col cols="12" md="6" class="pa-1">
						<v-btn
							block
							class="btn-primary-action gradient-teal-animate hover-glow ripple-effect"
							@click="submit(undefined, false, true)"
							:loading="submittingPayment"
							:disabled="vaildatPayment || submittingPayment"
						>
							<v-icon start size="18">mdi-printer</v-icon>
							{{ __("Submit & Print") }}
						</v-btn>
					</v-col>

					<v-col cols="12" md="6" class="pa-1">
						<v-btn block class="btn-danger click-squish" @click="back_to_invoice">
							<v-icon start size="18">mdi-cancel</v-icon>
							{{ __("Cancel Payment") }}
						</v-btn>
					</v-col>
				</v-row>
			</v-card-text>
		</v-card>
		<div>
			<v-dialog v-model="phone_dialog" max-width="400px" persistent>
				<v-card elevation="8" rounded="xl">
					<v-card-title>
						<span class="text-h5 text-primary">{{ __("Confirm Mobile Number") }}</span>
					</v-card-title>
					<v-card-text class="pa-0">
						<v-container>
							<v-text-field
								density="compact"
								variant="outlined"
								color="primary"
								:label="__('Mobile Number')"
								bg-color="surface"
								hide-details
								v-model="invoice_doc.contact_mobile"
								type="number"
							></v-text-field>
						</v-container>
					</v-card-text>
					<v-card-actions>
						<v-spacer></v-spacer>
						<v-btn color="error" theme="dark" @click="phone_dialog = false">{{
							__("Close")
						}}</v-btn>
						<v-btn color="primary" theme="dark" @click="request_payment">{{
							__("Request")
						}}</v-btn>
					</v-card-actions>
				</v-card>
			</v-dialog>
		</div>
	</div>
</template>

<script>
import { call } from "@/utils/call";
import { OfflineReturnDeferredError } from "@/utils/call-registry";
import { uuidV4 } from "@/offline/db";
import format from "@/utils/format";
import hardwareUtils from "@/utils/hardwareUtils";
import { toast } from "vue3-toastify"; // <-- make sure this is imported
import { datetime } from "@/utils/datetime";
import { playSound } from "@/utils/sounds";

import busListeners from "@/utils/busListeners";
import { loadSalesPersons, readStoredSalesPersons } from "@/utils/salesPersons";
export default {
	mixins: [format, hardwareUtils, busListeners],
	data: () => ({
		loading: false,
		submittingPayment: false,
		pos_profile: "",
		pos_opening_shift: "",
		invoice_doc: "",
		loyalty_amount: 0,
		today_date: datetime.now_date(),
		is_credit_sale: 0,
		is_write_off_change: 0,
		po_date_menu: false,
		addresses: [],
		sales_persons: [],
		sales_person: "",
		paid_change: 0,
		order_delivery_date: false,
		paid_change_rules: [],
		is_return: false,
		is_cashback: true,
		redeem_customer_credit: false,
		customer_credit_dict: [],
		phone_dialog: false,
		invoiceType: "Invoice",
		pos_settings: "",
		customer_info: "",
		mpesa_modes: [],
	}),

		methods: {
			// Run a contribution-ledger operation with a hard deadline.
			//
			// Every sale now touches IndexedDB on its critical path, which an
			// ONLINE sale never did before the ledger existed. Dexie queues
			// every operation behind `db.open()`, and an open can block
			// INDEFINITELY rather than fail: a second POS tab still holding the
			// previous schema version blocks the `version(2)` upgrade until it
			// closes, and iOS/Safari stall IndexedDB on their own. A promise
			// that never settles cannot be caught — the awaiting sale would
			// simply stop, `submittingPayment` would never reset in a `finally`
			// that never runs, and the Pay button would be dead until reload.
			// The till must not freeze on a healthy network because of a
			// bookkeeping write, so a timeout is treated exactly like any other
			// ledger failure: warn, skip the contribution, sell.
			async runLedgerOp(label, run) {
				let timer = null;
				const TIMEOUT = Symbol("ledger-timeout");
				try {
					const outcome = await Promise.race([
						run(),
						new Promise((resolve) => {
							timer = setTimeout(() => resolve(TIMEOUT), 2000);
						}),
					]);
					if (outcome === TIMEOUT) {
						console.warn(
							`[Payments] ${label} timed out; contribution skipped`,
						);
						return false;
					}
					return true;
				} catch (err) {
					console.warn(`[Payments] ${label} failed`, err);
					return false;
				} finally {
					if (timer !== null) clearTimeout(timer);
				}
			},
			parseSubmitData(raw) {
				if (!raw) return {};
				if (typeof raw === "object") return raw;
				if (typeof raw !== "string") return {};
				try {
					return JSON.parse(raw);
				} catch {
					return {};
				}
			},
			back_to_invoice() {
				this.eventBus.emit("show_payment", "false");
				this.eventBus.emit("set_customer_readonly", false);
			},
		submit(event, payment_received = false, print = false) {
			if (this.submittingPayment) return;
			if (!this.invoice_doc.is_return && this.total_payments < 0) {
				toast.error(`Payments not correct`);
				playSound("error");
				return;
			}
			// validate phone payment
			let phone_payment_is_valid = true;
			if (!payment_received) {
				this.invoice_doc.payments.forEach((payment) => {
					if (
						payment.type == "Phone" &&
						![0, "0", "", null, undefined].includes(payment.amount)
					) {
						phone_payment_is_valid = false;
					}
				});
				if (!phone_payment_is_valid) {
					toast.error(__("Please request phone payment or use other payment method"));
					playSound("error");
					return;
				}
			}

			if (
				!this.is_credit_sale &&
				!this.pos_profile.posa_allow_partial_payment &&
				this.total_payments <
					(this.invoice_doc.rounded_total || this.invoice_doc.grand_total)
			) {
				toast.error(`The amount paid is not complete`);
				playSound("error");
				return;
			}

			if (
				this.pos_profile.posa_allow_partial_payment &&
				!this.pos_profile.posa_allow_credit_sale &&
				this.total_payments == 0
			) {
				toast.error(`Please enter the amount paid`);
				playSound("error");
				return;
			}

			if (!this.paid_change) this.paid_change = 0;

			if (this.paid_change > -this.diff_payment) {
				toast.error(`Paid change can not be greater than total change!`);
				playSound("error");
				return;
			}

			let total_change = this.flt(
				this.flt(this.paid_change) + this.flt(-this.credit_change)
			);

			if (this.show_payment_methods && total_change != -this.diff_payment) {
				toast.error(`Error in change calculations!`);
				playSound("error");
				return;
			}

			let credit_calc_check = this.customer_credit_dict.filter((row) => {
				if (flt(row.credit_to_redeem))
					return flt(row.credit_to_redeem) > flt(row.total_credit);
				else return false;
			});

			if (credit_calc_check.length > 0) {
				toast.error(`redeamed credit can not greater than its total.`);
				playSound("error");
				return;
			}

			if (
				!this.invoice_doc.is_return &&
				this.redeemed_customer_credit >
					(this.invoice_doc.rounded_total || this.invoice_doc.grand_total)
			) {
				toast.error(`can not redeam customer credit more than invoice total`);
				playSound("error");
				return;
			}

			this.submittingPayment = true;
			this.submit_invoice(print).finally(() => {
				this.submittingPayment = false;
			});
		},
		async submit_invoice(print) {
			let totalPayedAmount = 0;
			this.invoice_doc.payments.forEach((payment) => {
				payment.amount = flt(payment.amount);
				totalPayedAmount += payment.amount;
			});
			if (this.customer_credit_dict.length) {
				this.customer_credit_dict.forEach((row) => {
					row.credit_to_redeem = flt(row.credit_to_redeem);
				});
			}
			let data = {};
			data["total_change"] = !this.invoice_doc.is_return ? -this.diff_payment : 0;
			data["paid_change"] = !this.invoice_doc.is_return ? this.paid_change : 0;
			data["credit_change"] = -this.credit_change;
			data["redeemed_customer_credit"] = this.redeemed_customer_credit;
			data["customer_credit_dict"] = this.customer_credit_dict;
			data["is_cashback"] = this.is_cashback;

			const vm = this;
			// forceQueue (T10): if the cart's customer was offline-created,
			// the live posapp.submit_invoice can't resolve "OFFLINE-CUST-..."
			// to a real customer link. Route through the offline endpoint
			// instead — it pops customer_offline_id, looks up the synced
			// customer, and substitutes the real name. forceQueue is a no-op
			// when the registry entry isn't offline-capable.
			const hasOfflineCustomer = !!this.invoice_doc?.customer_offline_id;

			// One id for the whole sale. `call()` would generate this itself,
			// but the ledger needs it BEFORE the request so the contribution
			// can be staged first. Passing it as offlineIdempotencyKey makes
			// the outbox row, the server's pos_offline_id, and the ledger key
			// all the same value on both the live and queued paths.
			const invoiceOfflineId = uuidV4();

			// Stage the contribution before submitting. If the app dies between
			// here and the confirm, the row survives as `pending` and the
			// startup reconciliation resolves it against the server.
			// Never let a ledger failure block the sale.
			//
			// Resolved at sale time rather than trusted off whichever
			// `pos_opening_shift` object this component currently holds:
			// `register_pos_profile` has emitters beyond Pos.vue's own stamped
			// snapshot — its `pos_profile_updated` / `pendingProfileData`
			// replays — that hand out a live `check_opening_shift` response the server
			// never echoes `pospire_lifecycle_id` on and that never passes
			// through `registerShiftLifecycle`. On a common warm-boot ordering
			// one of those fires last, leaving `pospire_lifecycle_id` undefined
			// on the object this component ends up holding even though a
			// stamped durable row exists. `pos_offline_id` is the same id
			// pre-sync, so it covers an offline-opened shift whose stamp just
			// hasn't landed on this object; failing that, look the durable row
			// up by server name — that goes straight to Dexie and is correct
			// regardless of which transient object is in memory here.
			let shiftLifecycleId =
				this.pos_opening_shift?.pospire_lifecycle_id ||
				this.pos_opening_shift?.pos_offline_id ||
				null;
			if (!shiftLifecycleId && this.pos_opening_shift?.name) {
				// Also deadline-bounded: this is a Dexie read on the same
				// critical path, with the same never-settles failure mode as
				// the staging write below.
				await this.runLedgerOp("findShiftByServerName", async () => {
					const { findShiftByServerName } = await import("@/offline/shift-lifecycle");
					const row = await findShiftByServerName(this.pos_opening_shift.name);
					shiftLifecycleId = row?.offline_id || null;
				});
			}
			if (!shiftLifecycleId) {
				// No lifecycle id resolvable by any route. Skip rather than
				// writing a row keyed to no shift: it would count toward
				// nothing and could never be pruned. The close dialog falls
				// back to the Phase 1 outbox scan for this shift.
				console.warn(
					"[Payments] no shift lifecycle id; skipping contribution staging",
				);
			} else {
				await this.runLedgerOp("stageContribution", async () => {
					const { stageContribution } = await import("@/offline/contribution-ledger");
					await stageContribution({
						invoiceOfflineId,
						shiftLifecycleId,
						invoice: this.invoice_doc,
						cashMode:
							(this.pos_profile && this.pos_profile.posa_cash_mode_of_payment) ||
							"Cash",
						precision: Number(window.sys_defaults?.currency_precision || 2),
					});
				});
			}

			// Un-stage on any failure exit below. `deriveExpectedByMop` sums
			// pending rows into the shift total, so a row staged ahead of a
			// submit that never landed would overstate the cashier's expected
			// figure forever — reconciliation only ever confirms rows the
			// server has, it never removes ones it doesn't. Safe to call even
			// when staging was skipped or never ran: deleting a missing key is
			// a no-op.
			const discardStagedContribution = async () => {
				await this.runLedgerOp("discardContribution", async () => {
					const { discardContribution } = await import("@/offline/contribution-ledger");
					await discardContribution(invoiceOfflineId);
				});
			};

			let r = null;
			try {
				r = await call({
					method: "pospire.pospire.api.posapp.submit_invoice",
					args: {
						data: data,
						invoice: this.invoice_doc,
					},
					intent: "write",
					forceQueue: hasOfflineCustomer,
					offlineIdempotencyKey: invoiceOfflineId,
				});
			} catch (err) {
				await discardStagedContribution();
				if (err instanceof OfflineReturnDeferredError) {
					toast.warning(
						__("Sales Return requires an online connection in this phase."),
					);
					return;
				}
				toast.error(err && err.message ? err.message : "Error submitting invoice");
				return;
			}
			if (!r) {
				await discardStagedContribution();
				toast.error("Error submitting invoice");
				return;
			}

			// Offline-enqueue ack (see @/offline/types: OutboxEnqueueAck).
			// Shape: { offline: true, offline_id, provisional_name, status: 'enqueued' }.
			// This is NOT a failure — the server is unreachable and the outbox
			// took custody of the write. We print a provisional receipt with the
			// PENDING SYNC watermark and clear the cart so the cashier can ring
			// the next sale.
			if (r && r.offline === true && r.status === "enqueued") {
				const provisionalName = r.provisional_name;
				// Tag the invoice object in-memory so any consumer that fires
				// off `set_last_invoice` / print paths can render the pending
				// sync state. The server-side `name` is null until sync.
				vm.invoice_doc.name = provisionalName;
				vm.invoice_doc.pospire_pending_sync = true;
				vm.invoice_doc.pospire_offline_id = r.offline_id;

				await vm.runLedgerOp("confirmContribution", async () => {
					const { confirmContribution } = await import("@/offline/contribution-ledger");
					await confirmContribution(invoiceOfflineId);
				});

				if (print) {
					vm.handleProvisionalPrint(vm.invoice_doc);
				}
				vm.customer_credit_dict = [];
				vm.redeem_customer_credit = false;
				vm.is_cashback =
					vm.pos_profile && vm.pos_profile.use_cashback == 1 ? true : false;
				vm.sales_person = "";
				vm.eventBus.emit("set_last_invoice", provisionalName);
				toast.info(`Queued ${provisionalName}. Will sync when online`);
				playSound("submit");
				vm.addresses = [];
				vm.invoice_doc = "";
				vm.eventBus.emit("clear_invoice", { submitted: true });
				vm.back_to_invoice();
				return;
			}

			await vm.runLedgerOp("confirmContribution", async () => {
				const { confirmContribution } = await import("@/offline/contribution-ledger");
				await confirmContribution(invoiceOfflineId);
			});

			if (print) {
				vm.handlePrint(vm.invoice_doc.name);
			}
			vm.customer_credit_dict = [];
			vm.redeem_customer_credit = false;
			// Reset is_cashback based on POS Profile setting
			vm.is_cashback =
				vm.pos_profile && vm.pos_profile.use_cashback == 1 ? true : false;
			vm.sales_person = "";

			vm.eventBus.emit("set_last_invoice", vm.invoice_doc.name);
			toast.success(`Invoice ${r.name} is Submited`);
			//s
			playSound("submit");
			vm.addresses = [];

			// Backfill invoice reference on all approval requests, then signal
			// clear_invoice with submitted=true so Pending cancellation is skipped.
			const saved_data = this.parseSubmitData(vm.invoice_doc.posa_submit_data);
			const approved_names = saved_data.approved_requests || [];
			if (approved_names.length) {
				call("pospire.pospire.api.approval.link_requests_to_invoice", {
					request_names: JSON.stringify(approved_names),
					invoice: r.name,
				}).catch(() => {});
			}

			vm.invoice_doc = "";
			vm.eventBus.emit("clear_invoice", { submitted: true });
			vm.back_to_invoice();
			return;
		},
		async handlePrint(invoice_name) {
			try {
				await this.hardwareConfiguration(this.pos_profile.name).then((res) => {
					if (res === true) {
						this.custom_print(invoice_name);
					} else {
						this.load_print_page(invoice_name);
					}
				});
			} catch (err) {
				console.error("Hardware config check failed:", err);
				this.load_print_page(invoice_name); // fallback
			}
		},
		/**
		 * Provisional-receipt printer for offline-enqueued sales. The server
		 * has not assigned a real invoice name yet, so printing via the
		 * printview URL (which does a server lookup) would 404. Instead we
		 * open a minimal HTML document rendered from the in-memory invoice
		 * payload with an OFFLINE-<short_id> header and a "PENDING SYNC"
		 * watermark. On reconnect, the reprint action in the receipt history
		 * will print the final server-named receipt.
		 *
		 * See docs/offline/11-ui-ux.md §6 for the design contract.
		 */
		handleProvisionalPrint(invoice) {
			try {
				const win = window.open("", "ProvisionalReceipt");
				if (!win) {
					toast.warning("Pop-up blocked; provisional receipt not printed.");
					return;
				}
				const lines = (invoice.items || [])
					.map((it) => {
						const name = it.item_name || it.item_code || "";
						const qty = it.qty || 0;
						const rate = it.rate || 0;
						const amount = it.amount || qty * rate;
						return (
							'<tr>' +
							'<td>' + String(name).replace(/</g, "&lt;") + '</td>' +
							'<td style="text-align:right">' + qty + '</td>' +
							'<td style="text-align:right">' + Number(rate).toFixed(2) + '</td>' +
							'<td style="text-align:right">' + Number(amount).toFixed(2) + '</td>' +
							'</tr>'
						);
					})
					.join("");
				const total = invoice.rounded_total || invoice.grand_total || 0;
				const header = invoice.name || "OFFLINE-PENDING";
				const html =
					'<!doctype html><html><head><meta charset="utf-8">' +
					'<title>' + header + '</title>' +
					'<style>' +
					'body{font-family:monospace;padding:12px;position:relative;}' +
					'.wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:48px;color:rgba(200,0,0,0.15);transform:rotate(-25deg);pointer-events:none;font-weight:700;letter-spacing:4px;}' +
					'.hdr{font-weight:700;font-size:14px;border-bottom:2px dashed #333;padding-bottom:6px;margin-bottom:8px;}' +
					'table{width:100%;border-collapse:collapse;font-size:12px;}' +
					'th,td{padding:2px 4px;}' +
					'.tot{border-top:1px dashed #333;margin-top:6px;padding-top:6px;font-weight:700;font-size:13px;display:flex;justify-content:space-between;}' +
					'.note{margin-top:12px;font-size:10px;color:#666;}' +
					'</style></head><body>' +
					'<div class="wm">PENDING SYNC</div>' +
					'<div class="hdr">' + header + '</div>' +
					'<table><thead><tr><th style="text-align:left">Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>' +
					'<tbody>' + lines + '</tbody></table>' +
					'<div class="tot"><span>Total</span><span>' + Number(total).toFixed(2) + '</span></div>' +
					'<div class="note">This receipt will be replaced by the final receipt once synced.</div>' +
					'</body></html>';
				win.document.open();
				win.document.write(html);
				win.document.close();
				// Give the browser a moment to lay out before triggering print.
				win.addEventListener(
					"load",
					() => {
						try {
							win.print();
						} catch (e) {
							console.error("Provisional print trigger failed:", e);
						}
					},
					true,
				);
			} catch (err) {
				console.error("Provisional print failed:", err);
				toast.error("Could not print provisional receipt.");
			}
		},
		set_full_amount(idx) {
			this.invoice_doc.payments.forEach((payment) => {
				payment.amount =
					payment.idx == idx
						? this.invoice_doc.rounded_total || this.invoice_doc.grand_total
						: 0;
			});
		},
		set_rest_amount(idx) {
			const payment = this.invoice_doc.payments.find((row) => row.idx == idx);
			if (!payment || payment.amount != 0) {
				return;
			}

			if (!this.invoice_doc.name && this.diff_payment <= 0) {
				this.set_full_amount(idx);
				return;
			}

			this.invoice_doc.payments.forEach((payment) => {
				if (payment.idx == idx && payment.amount == 0 && this.diff_payment > 0) {
					payment.amount = this.diff_payment;
				}
			});
		},
		clear_all_amounts() {
			this.invoice_doc.payments.forEach((payment) => {
				payment.amount = 0;
			});
		},
		load_print_page(invoice_name) {
			const name = invoice_name || this.invoice_doc?.name;
			const print_format =
				this.pos_profile.print_format_for_online || this.pos_profile.print_format;
			const letter_head = this.pos_profile.letter_head || 0;
			const url =
				window.location.origin +
				"/printview?doctype=Sales%20Invoice&name=" +
				name +
				"&trigger_print=1" +
				"&format=" +
				print_format +
				"&no_letterhead=" +
				letter_head;
			const printWindow = window.open(url, "Print");
			printWindow.addEventListener(
				"load",
				function () {
					printWindow.print();
					// printWindow.close();
					// NOTE : uncomoent this to auto closing printing window
				},
				true
			);
		},
		validate_due_date() {
			const today = datetime.now_date();
			const parse_today = Date.parse(today);
			const new_date = Date.parse(this.invoice_doc.due_date);
			if (new_date < parse_today) {
				setTimeout(() => {
					this.invoice_doc.due_date = today;
				}, 0);
			}
		},
		normalize_due_date_input(value) {
			if (!value) {
				this.invoice_doc.due_date = this.today_date;
				return;
			}
			this.invoice_doc.due_date = String(value).slice(0, 10);
			this.validate_due_date();
		},
		shortPay(e) {
			if (e.key === "x" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.submit();
			}
		},
		set_paid_change() {
			if (!this.paid_change) this.paid_change = 0;

			this.paid_change_rules = [];
			let change = -this.diff_payment;
			if (this.paid_change > change) {
				this.paid_change_rules = ["Paid change can not be greater than total change!"];
				this.credit_change = 0;
			}
		},
		async get_available_credit(e) {
			this.clear_all_amounts();
			if (e) {
				const data = await call("pospire.pospire.api.posapp.get_available_credit", {
					customer: this.invoice_doc.customer,
					company: this.pos_profile.company,
				});
				if (data && data.length) {
					const amount =
						this.invoice_doc.rounded_total || this.invoice_doc.grand_total;
					let remainAmount = amount;

					data.forEach((row) => {
						if (remainAmount > 0) {
							if (remainAmount >= row.total_credit) {
								row.credit_to_redeem = row.total_credit;
								remainAmount = remainAmount - row.total_credit;
							} else {
								row.credit_to_redeem = remainAmount;
								remainAmount = 0;
							}
						} else {
							row.credit_to_redeem = 0;
						}
					});

					this.customer_credit_dict = data;
				} else {
					this.customer_credit_dict = [];
				}
			} else {
				this.customer_credit_dict = [];
			}
		},
		async get_addresses() {
			const vm = this;
			if (!vm.invoice_doc) {
				return;
			}
			let r = null;
			try {
				r = await call("pospire.pospire.api.posapp.get_customer_addresses", {
					customer: vm.invoice_doc.customer,
				});
			} catch {
				// Offline: leave previously-loaded addresses in place; new
				// address fetches resume on reconnect.
				return;
			}
			if (r) {
				vm.addresses = r;
			} else {
				vm.addresses = [];
			}
		},
		addressFilter(item, queryText, itemText) {
			const textOne = item.address_title ? item.address_title.toLowerCase() : "";
			const textTwo = item.address_line1 ? item.address_line1.toLowerCase() : "";
			const textThree = item.address_line2 ? item.address_line2.toLowerCase() : "";
			const textFour = item.city ? item.city.toLowerCase() : "";
			const textFifth = item.name.toLowerCase();
			const searchText = queryText.toLowerCase();
			return (
				textOne.indexOf(searchText) > -1 ||
				textTwo.indexOf(searchText) > -1 ||
				textThree.indexOf(searchText) > -1 ||
				textFour.indexOf(searchText) > -1 ||
				textFifth.indexOf(searchText) > -1
			);
		},
		new_address() {
			this.eventBus.emit("open_new_address", this.invoice_doc.customer);
		},
		async get_sales_person_names() {
			const vm = this;
			const persist = !!vm.pos_profile.posa_local_storage;
			if (persist) {
				const stored = readStoredSalesPersons();
				if (stored) vm.sales_persons = stored;
			}
			let r = null;
			try {
				r = await loadSalesPersons({ persist });
			} catch {
				// Offline: localStorage hydration above (if enabled) leaves a
				// usable list. Otherwise the dropdown is empty until reconnect.
				return;
			}
			if (r) vm.sales_persons = r;
		},
		salesPersonFilter(itemText, queryText, itemRow) {
			const item = itemRow.raw;
			const textOne = item.sales_person_name ? item.sales_person_name.toLowerCase() : "";
			const textTwo = item.name.toLowerCase();
			const searchText = queryText.toLowerCase();

			return textOne.indexOf(searchText) > -1 || textTwo.indexOf(searchText) > -1;
		},
		async request_payment() {
			this.phone_dialog = false;
			const vm = this;
			if (!this.invoice_doc.contact_mobile) {
				toast.error(__(`Pleas Set Customer Mobile Number`));
				this.eventBus.emit("open_edit_customer");
				this.back_to_invoice();
				return;
			}
			this.eventBus.emit("freeze", {
				title: __(`Waiting for payment... `),
			});
			this.invoice_doc.payments.forEach((payment) => {
				payment.amount = flt(payment.amount);
			});
			let formData = { ...this.invoice_doc };
			formData["total_change"] = -this.diff_payment;
			formData["paid_change"] = this.paid_change;
			formData["credit_change"] = -this.credit_change;
			formData["redeemed_customer_credit"] = this.redeemed_customer_credit;
			formData["customer_credit_dict"] = this.customer_credit_dict;
			formData["is_cashback"] = this.is_cashback;

			const updateResult = await call("pospire.pospire.api.posapp.update_invoice", {
				data: formData,
			});
			if (updateResult) {
				vm.invoice_doc = updateResult;
			}

			let payment_request_name;
			try {
				const prResult = await call("pospire.pospire.api.posapp.create_payment_request", {
					doc: vm.invoice_doc,
				});
				payment_request_name = prResult.name;
			} catch {
				this.eventBus.emit("unfreeze");
				toast.error(__(`Payment request failed`));
				return;
			}

			setTimeout(async () => {
				const paymentStatus = await call("frappe.client.get_value", {
					doctype: "Payment Request",
					filters: payment_request_name,
					fieldname: ["status", "grand_total"],
				});
				if (!paymentStatus || paymentStatus.status != "Paid") {
					this.eventBus.emit("unfreeze");
					toast.error(
						__(
							`Payment Request took too long to respond. Please try requesting for payment again`
						)
					);
				} else {
					this.eventBus.emit("unfreeze");
					toast.success(
						__("Payment of {0} received successfully.", [
							vm.formatCurrency(
								paymentStatus.grand_total,
								vm.invoice_doc.currency,
								0
							),
						])
					);
					const doc = await call("frappe.client.get_doc", {
						doctype: "Sales Invoice",
						name: vm.invoice_doc.name,
					});
					if (doc) {
						vm.invoice_doc = doc;
						vm.submit(null, true);
					}
				}
			}, 30000);
		},
		async get_mpesa_modes() {
			const vm = this;
			let r = null;
			try {
				r = await call("pospire.pospire.api.m_pesa.get_mpesa_mode_of_payment", {
					company: vm.pos_profile.company,
				});
			} catch {
				// Live-only lookup, and this runs on every shift open. Offline
				// it threw an unhandled rejection on the opening path.
				vm.mpesa_modes = [];
				return;
			}
			vm.mpesa_modes = r || [];
		},
		is_mpesa_c2b_payment(payment) {
			if (this.mpesa_modes.includes(payment.mode_of_payment) && payment.type == "Bank") {
				payment.amount = 0;
				return true;
			} else {
				return false;
			}
		},
		mpesa_c2b_dialg(payment) {
			const data = {
				company: this.pos_profile.company,
				mode_of_payment: payment.mode_of_payment,
				customer: this.invoice_doc.customer,
			};
			this.eventBus.emit("open_mpesa_payments", data);
		},
		set_mpesa_payment(payment) {
			this.pos_profile.use_customer_credit = 1;
			this.redeem_customer_credit = true;
			const invoiceAmount = this.invoice_doc.rounded_total || this.invoice_doc.grand_total;
			let amount =
				payment.unallocated_amount > invoiceAmount
					? invoiceAmount
					: payment.unallocated_amount;
			if (amount < 0 || !amount) amount = 0;
			const advance = {
				type: "Advance",
				credit_origin: payment.name,
				total_credit: flt(payment.unallocated_amount),
				credit_to_redeem: flt(amount),
			};
			this.clear_all_amounts();
			this.customer_credit_dict.push(advance);
		},
	},

	computed: {
		// Cashback applies to returns only: a return either refunds cash or
		// leaves store credit. Normal sales always take payment, so the payment
		// methods must not depend on the POS Profile cashback setting.
		show_payment_methods() {
			return !this.invoice_doc.is_return || this.is_cashback;
		},
		total_payments() {
			let total = parseFloat(this.invoice_doc.loyalty_amount);
			if (this.invoice_doc && this.invoice_doc.payments) {
				this.invoice_doc.payments.forEach((payment) => {
					total += this.flt(payment.amount);
				});
			}

			total += this.flt(this.redeemed_customer_credit);

			if (!this.show_payment_methods) total = 0;

			return this.flt(total, this.currency_precision);
		},
		diff_payment() {
			let diff_payment = this.flt(
				(this.invoice_doc.rounded_total || this.invoice_doc.grand_total) -
					this.total_payments,
				this.currency_precision
			);
			this.paid_change = -diff_payment;
			return diff_payment;
		},
		credit_change() {
			let change = -this.diff_payment;
			if (this.paid_change > change) return 0;
			return this.flt(this.paid_change - change, this.currency_precision);
		},
		diff_lable() {
			let lable = this.diff_payment < 0 ? "Change" : "To Be Paid";
			return lable;
		},
		available_pioints_amount() {
			let amount = 0;
			if (this.customer_info.loyalty_points) {
				amount = this.customer_info.loyalty_points * this.customer_info.conversion_factor;
			}
			return amount;
		},
		available_customer_credit() {
			let total = 0;
			this.customer_credit_dict.map((row) => {
				total += row.total_credit;
			});

			return total;
		},
		redeemed_customer_credit() {
			let total = 0;
			this.customer_credit_dict.map((row) => {
				if (flt(row.credit_to_redeem)) total += flt(row.credit_to_redeem);
				else row.credit_to_redeem = 0;
			});

			return total;
		},
		vaildatPayment() {
			if (this.pos_profile.posa_allow_sales_order) {
				if (this.invoiceType == "Order" && !this.invoice_doc.posa_delivery_date) {
					return true;
				} else {
					return false;
				}
			} else {
				return false;
			}
		},
		request_payment_field() {
			let res = false;
			if (!this.pos_settings || this.pos_settings.invoice_fields.length == 0) {
				res = false;
			} else {
				this.pos_settings.invoice_fields.forEach((el) => {
					if (el.fieldtype == "Button" && el.fieldname == "request_for_payment") {
						res = true;
					}
				});
			}
			return res;
		},
	},

	mounted: function () {
		this.$nextTick(function () {
			this.onBus("send_invoice_doc_payment", (payload) => {
				this.invoice_doc = payload.invoice_doc;
				const default_payment = this.invoice_doc.payments.find(
					(payment) => payment.default == 1
				);
				this.is_credit_sale = 0;
				this.is_write_off_change = 0;
				if (default_payment && !payload.is_return) {
					default_payment.amount = this.flt(
						this.invoice_doc.rounded_total || this.invoice_doc.grand_total,
						this.currency_precision
					);
				}
				if (payload.is_return) {
					this.is_return = true;
					this.is_cashback = false;
					this.invoice_doc.payments.forEach((payment) => {
						payment.amount = 0;
						payment.base_amount = 0;
					});
				} else {
					this.is_return = false;
				}
				this.loyalty_amount = 0;
				this.get_addresses();
				this.get_sales_person_names();
			});
			this.onBus("register_pos_profile", (data) => {
				this.pos_profile = data.pos_profile;
				// Best-effort only: `register_pos_profile` has emitters (Pos.vue's
				// pos_profile_updated / pendingProfileData replays) that hand out
				// a live check_opening_shift response never stamped with
				// pospire_lifecycle_id, and any of them can be the last one to
				// fire before a sale. submit_invoice does NOT trust this object's
				// `pospire_lifecycle_id` alone — it falls back to `pos_offline_id`
				// and then to a durable-row lookup by server name. Kept here only
				// because pos_profile / cashback / mpesa below still need it.
				this.pos_opening_shift = data.pos_opening_shift;
				// Initialize is_cashback based on POS Profile setting
				// If use_cashback is disabled (0), set is_cashback to false
				// If use_cashback is enabled (1), keep it true (default)
				if (this.pos_profile.use_cashback == 0) {
					this.is_cashback = false;
				} else {
					this.is_cashback = true;
				}
				this.get_mpesa_modes();
			});
			this.onBus("add_the_new_address", (data) => {
				this.addresses.push(data);
				this.$forceUpdate();
			});
			this.onBus("update_invoice_type", (data) => {
				this.invoiceType = data;
				if (this.invoice_doc && data != "Order") {
					this.invoice_doc.posa_delivery_date = null;
					this.invoice_doc.posa_notes = null;
					this.invoice_doc.shipping_address_name = null;
				}
			});
		});
		this.onBus("update_customer", (customer) => {
			if (this.customer != customer) {
				this.customer_credit_dict = [];
				this.redeem_customer_credit = false;
				// Reset is_cashback based on POS Profile setting
				this.is_cashback =
					this.pos_profile && this.pos_profile.use_cashback == 1 ? true : false;
			}
		});
		this.onBus("set_pos_settings", (data) => {
			this.pos_settings = data;
		});
		this.onBus("set_customer_info_to_edit", (data) => {
			this.customer_info = data;
		});
		this.onBus("set_mpesa_payment", (data) => {
			this.set_mpesa_payment(data);
		});
	},
	created() {
		document.addEventListener("keydown", this.shortPay.bind(this));
	},

	unmounted() {
		document.removeEventListener("keydown", this.shortPay);
	},

	watch: {
		loyalty_amount(value) {
			if (value > this.available_pioints_amount) {
				this.invoice_doc.loyalty_amount = 0;
				this.invoice_doc.redeem_loyalty_points = 0;
				this.invoice_doc.loyalty_points = 0;
				toast.error(
					`Loyalty Amount can not be more then ${this.available_pioints_amount}`
				);
			} else {
				this.invoice_doc.loyalty_amount = this.flt(this.loyalty_amount);
				this.invoice_doc.redeem_loyalty_points = 1;
				this.invoice_doc.loyalty_points =
					this.flt(this.loyalty_amount) / this.customer_info.conversion_factor;
			}
		},
		is_credit_sale(value) {
			if (value) {
				this.invoice_doc.payments.forEach((payment) => {
					payment.amount = 0;
					payment.base_amount = 0;
				});
			}
		},
		is_write_off_change(value) {
			if (value == 1) {
				this.invoice_doc.write_off_amount = this.diff_payment;
				this.invoice_doc.write_off_outstanding_amount_automatically = 1;
			} else {
				this.invoice_doc.write_off_amount = 0;
				this.invoice_doc.write_off_outstanding_amount_automatically = 0;
			}
		},
		redeemed_customer_credit(value) {
			if (value > this.available_customer_credit) {
				toast.error(
					`You can redeem customer credit upto ${this.available_customer_credit}`
				);
			}
		},
		sales_person() {
			if (this.sales_person) {
				this.invoice_doc.sales_team = [
					{
						sales_person: this.sales_person,
						allocated_percentage: 100,
					},
				];
			} else {
				this.invoice_doc.sales_team = [];
			}
		},
	},
};
</script>

<style scoped>
.pos-panel-container {
	height: 100%;
	display: flex;
	flex-direction: column;
}

.selection {
	width: 100%;
	height: 100%;
}

.payment-method-btn {
	transition: all 0.3s ease !important;
	box-shadow: var(--payments-shadow-btn) !important;
}

.payment-method-btn:hover {
	transform: translateY(-2px) !important;
	box-shadow: var(--payments-shadow-btn-hover) !important;
}

.action-btn {
	transition: all 0.3s ease !important;
	font-weight: 600 !important;
	text-transform: uppercase !important;
	letter-spacing: 0.5px !important;
}

.submit-btn {
	background: var(--payments-gradient-submit) !important;
	box-shadow: 0 6px 16px rgba(25, 118, 210, 0.3) !important;
}

.submit-btn:hover {
	transform: translateY(-2px) !important;
	box-shadow: 0 8px 20px rgba(25, 118, 210, 0.4) !important;
}

.print-btn {
	background: var(--payments-gradient-print) !important;
	box-shadow: 0 6px 16px rgba(76, 175, 80, 0.3) !important;
}

.print-btn:hover {
	transform: translateY(-2px) !important;
	box-shadow: 0 8px 20px rgba(76, 175, 80, 0.4) !important;
}

/* .cancel-btn {
  background: linear-gradient(45deg, #f44336 0%, #ef5350 100%) !important;
  box-shadow: 0 6px 16px rgba(244, 67, 54, 0.3) !important;
} */

/* .cancel-btn:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 8px 20px rgba(244, 67, 54, 0.4) !important;
} */

/* Section headers styling - scoped to payment page only */
.section-header .v-card-title {
	font-weight: 600 !important;
	color: var(--pospire-text-primary) !important;
}

.section-header-title {
	display: flex;
	align-items: center;
	padding-left: 0;
	font-size: 1rem;
	font-weight: 600;
	background-color: var(--pospire-surface-soft);
	color: var(--pospire-text-primary) !important;
}

	.section-header-title .v-icon {
		color: rgb(var(--v-theme-primary)) !important;
		margin-right: 8px;
	}

	.section-title-text {
		color: var(--pospire-text-primary);
	}

/* Payment Method Buttons - Design System Compliant */
.payment-method-btn {
	color: var(--pospire-text-primary) !important;
	border: 1px solid var(--pospire-border) !important;
	background-color: var(--pospire-surface) !important;
	font-weight: 600 !important;
	text-transform: uppercase !important;
	letter-spacing: 0.5px !important;
	transition: all 0.2s ease !important;
}

	.payment-method-btn:hover {
		border-color: rgb(var(--v-theme-primary)) !important;
		background-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, transparent) !important;
		box-shadow: 0 2px 8px rgba(0, 188, 212, 0.2) !important;
	}

.payment-method-btn:active {
	transform: scale(0.98) !important;
}

	.payment-method-btn .v-icon {
		color: rgb(var(--v-theme-primary)) !important;
	}

/* Compact toggle switches for payment options */
.small-switch {
	transform: scale(0.85);
	transform-origin: left center;
}

.loyalty-redemption-row {
	align-items: flex-start;
	margin-bottom: 16px;
	row-gap: 8px;
}
</style>
