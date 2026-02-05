<template>
  <div class="pos-panel-container">
    <v-card
      elevation="2"
      rounded="lg"
      class="selection mx-auto pos-scrollable-content">
      <v-progress-linear
        :active="loading"
        :indeterminate="loading"
        absolute
        :location="top"
        color="info"></v-progress-linear>
      <div class="overflow-y-auto pa-4">
        <!-- Payment Status Section -->
        <div class="mb-4 blue-grey-lighten-5" v-if="invoice_doc">
          <v-card variant="flat" class="mb-3 section-header">
            <v-card-title class="section-header-title font-weight-bold">
              <v-icon start size="20" color="#00BCD4">mdi-cash-multiple</v-icon>
              <span style="color: #34495E;">Payment Summary</span>
            </v-card-title>
          </v-card>
          <v-row class="mb-2">
          <v-col cols="7">
            <v-text-field
              variant="outlined"
              color="primary"
              :label="frappe._('Paid Amount')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(total_payments)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"
              density="compact"></v-text-field>
          </v-col>
          <v-col cols="5">
            <v-text-field
              variant="outlined"
              color="primary"
              :label="frappe._(diff_lable)"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(diff_payment)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"
              density="compact"></v-text-field>
          </v-col>
        </v-row>
        </div>

        <!-- Change Details Section -->
        <div class="mb-4" v-if="diff_payment < 0 && !invoice_doc.is_return">
          <v-card variant="flat" class="mb-3 section-header">
            <v-card-title class="section-header-title font-weight-bold">
              <v-icon start size="20" color="#00BCD4">mdi-cash-refund</v-icon>
              <span style="color: #34495E;">Change Details</span>
            </v-card-title>
          </v-card>
          <v-row>
            <v-col cols="7">
            <v-text-field
              variant="outlined"
              color="primary"
              :label="frappe._('Paid Change')"
              bg-color="white"
              v-model="paid_change"
              @update:model-value="set_paid_change()"
              :prefix="currencySymbol(invoice_doc.currency)"
              :rules="paid_change_rules"
              density="compact"
              readonly
              type="number"></v-text-field>
          </v-col>

          <v-col cols="5" v-if="diff_payment < 0 && !invoice_doc.is_return">
            <v-text-field
              variant="outlined"
              color="primary"
              :label="frappe._('Credit Change')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(credit_change)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"
              density="compact"></v-text-field>
            </v-col>
          </v-row>
        </div>
        
        <v-divider class="my-4"></v-divider>

        <!-- Payment Methods Section -->
        <div class="mb-4" v-if="is_cashback">
          <v-card variant="flat" class="mb-3 section-header">
            <v-card-title class="section-header-title font-weight-bold">
              <v-icon start size="20" color="#00BCD4">mdi-credit-card</v-icon>
              <span style="color: #34495E;">Payment Methods</span>
            </v-card-title>
          </v-card>
          <v-row
            class="pyments mb-2"
            v-for="payment in invoice_doc.payments"
            :key="payment.name">
            <v-col cols="6" v-if="!is_mpesa_c2b_payment(payment)">
              <v-text-field
                density="compact"
                variant="outlined"
                color="primary"
                :label="frappe._(payment.mode_of_payment)"
                bg-color="white"
                hide-details
                v-model="payment.amount"
                :rules="[isNumber]"
                :prefix="currencySymbol(invoice_doc.currency)"
                placeholder="0"
                persistent-placeholder
                @focus="set_rest_amount(payment.idx)"
                :readonly="invoice_doc.is_return ? true : false"></v-text-field>
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
              ">
              <v-btn
                block
                variant="outlined"
                size="large"
                rounded="md"
                class="payment-method-btn"
                style="color: #34495E; border-color: #E0E0E0;"
                @click="set_full_amount(payment.idx)">
                <v-icon start size="20" color="#00BCD4">mdi-cash</v-icon>
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
                @click="mpesa_c2b_dialg(payment)">
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
              class="pl-1">
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
                ">
                <v-icon start size="20">mdi-send</v-icon>
                {{ __("Request") }}
              </v-btn>
            </v-col>
          </v-row>
        </div>

        <v-row
          class="pyments px-1 py-0"
          v-if="
            invoice_doc &&
            available_pioints_amount > 0 &&
            !invoice_doc.is_return
          ">
          <v-col cols="7">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Redeem Loyalty Points')"
              bg-color="white"
              hide-details
              v-model="loyalty_amount"
              type="number"
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col cols="5">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('You can redeem upto')"
              bg-color="white"
              hide-details
              :model-value="formatFloat(available_pioints_amount)"
              :prefix="currencySymbol(invoice_doc.currency)"
              disabled></v-text-field>
          </v-col>
        </v-row>

        <v-row
          class="pyments px-1 py-0"
          v-if="
            invoice_doc &&
            available_customer_credit > 0 &&
            !invoice_doc.is_return &&
            redeem_customer_credit
          ">
          <v-col cols="7">
            <v-text-field
              density="compact"
              variant="outlined"
              disabled
              color="primary"
              :label="frappe._('Redeemed Customer Credit')"
              bg-color="white"
              hide-details
              v-model="redeemed_customer_credit"
              type="number"
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col cols="5">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('You can redeem credit upto')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(available_customer_credit)"
              :prefix="currencySymbol(invoice_doc.currency)"
              disabled></v-text-field>
          </v-col>
        </v-row>
        <v-divider></v-divider>

        <v-row class="px-1 py-0">
          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Net Total')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.net_total)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Tax and Charges')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.total_taxes_and_charges)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Total Amount')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.total)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Discount Amount')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.discount_amount)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>

          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Delivery Charge')"
              bg-color="white"
              hide-details
              :model-value="
                formatCurrency(invoice_doc.custom_delivery_charge_rate || 0)
              "
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>

          <v-col cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Grand Total')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.grand_total)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col v-if="invoice_doc.rounded_total" cols="6">
            <v-text-field
              density="compact"
              variant="outlined"
              color="primary"
              :label="frappe._('Rounded Total')"
              bg-color="white"
              hide-details
              :model-value="formatCurrency(invoice_doc.rounded_total)"
              readonly
              :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
          </v-col>
          <v-col
            cols="6"
            v-if="pos_profile.posa_allow_sales_order && invoiceType == 'Order'">
            <v-menu
              ref="order_delivery_date"
              v-model="order_delivery_date"
              :close-on-content-click="false"
              transition="scale-transition"
              density="default">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="invoice_doc.posa_delivery_date"
                  :label="frappe._('Delivery Date')"
                  readonly
                  variant="outlined"
                  density="compact"
                  bg-color="white"
                  clearable
                  color="primary"
                  hide-details
                  v-bind="props"></v-text-field>
              </template>
              <v-date-picker
                :v-model="new Date(invoice_doc.posa_delivery_date)"
                no-title
                scrollable
                color="primary"
                :min="frappe.datetime.now_date()"
                @input="order_delivery_date = false">
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
              :label="frappe._('Address')"
              v-model="invoice_doc.shipping_address_name"
              :items="addresses"
              item-title="address_title"
              item-value="name"
              bg-color="white"
              no-data-text="Address not found"
              hide-details
              :customFilter="addressFilter"
              append-icon="mdi-plus"
              @click:append="new_address">
              <template v-slot:item="{ props, item }">
                <v-list-item v-bind="props">
                  <v-list-item-title class="text-primary text-subtitle-1">
                    <div v-html="item.raw.address_title"></div>
                  </v-list-item-title>
                  <v-list-item-title>
                    <div v-html="item.raw.address_line1"></div>
                  </v-list-item-title>
                  <v-list-item-subtitle
                    v-if="item.raw.custoaddress_line2mer_name">
                    <div v-html="item.raw.address_line2"></div>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="item.raw.city">
                    <div v-html="item.raw.city"></div>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="item.raw.state">
                    <div v-html="item.raw.state"></div>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="item.raw.country">
                    <div v-html="item.raw.mobile_no"></div>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="item.raw.address_type">
                    <div v-html="item.raw.address_type"></div>
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
              bg-color="white"
              clearable
              color="primary"
              auto-grow
              rows="2"
              :label="frappe._('Additional Notes')"
              v-model="invoice_doc.posa_notes"
              :model-value="invoice_doc.posa_notes"></v-textarea>
          </v-col>
        </v-row>

        <div v-if="pos_profile.posa_allow_customer_purchase_order">
          <v-divider></v-divider>
          <v-row class="px-1 py-0" justify="center" align="start">
            <v-col cols="6">
              <v-text-field
                v-model="invoice_doc.po_no"
                :label="frappe._('Purchase Order')"
                variant="outlined"
                density="compact"
                bg-color="white"
                clearable
                color="primary"
                hide-details></v-text-field>
            </v-col>
            <v-col cols="6">
              <v-menu
                ref="po_date_menu"
                v-model="po_date_menu"
                :close-on-content-click="false"
                transition="scale-transition">
                <template v-slot:activator="{ props }">
                  <v-text-field
                    v-model="invoice_doc.po_date"
                    :label="frappe._('Purchase Order Date')"
                    readonly
                    variant="outlined"
                    density="compact"
                    hide-details
                    v-bind="props"
                    color="primary"></v-text-field>
                </template>
                <v-date-picker
                  v-model="invoice_doc.po_date"
                  no-title
                  scrollable
                  color="primary"
                  @input="po_date_menu = false">
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
            ">
            <v-switch
              v-model="is_write_off_change"
              :color="is_write_off_change ? '#00BCD4' : '#BDBDBD'"
              :base-color="is_write_off_change ? '#00BCD4' : '#BDBDBD'"
              inset
              dense
              hide-details
              class="small-switch mt-n2 items-start">
              <template #label>
                <span class="text-body-2 font-weight-regular">
                  {{ frappe._("Write Off Difference Amount") }}
                </span>
              </template>
            </v-switch>
          </v-col>
          <v-col
            cols="6"
            v-if="pos_profile.posa_allow_credit_sale && !invoice_doc.is_return">
            <v-switch
                v-model="is_credit_sale"
                :color="is_credit_sale ? '#00BCD4' : '#BDBDBD'"
                :base-color="is_credit_sale ? '#00BCD4' : '#BDBDBD'"
                inset
                dense
                hide-details
                class="small-switch mt-n2 items-start">
                <template #label>
                  <span class="text-body-2 font-weight-regular">
                    {{ frappe._("Credit Sale") }}
                  </span>
                </template>
            </v-switch>
          </v-col>
          <v-col
            cols="6"
            v-if="invoice_doc.is_return && pos_profile.use_cashback">
            <v-switch
              v-model="is_cashback"
              :color="is_cashback ? '#00BCD4' : '#BDBDBD'"
              :base-color="is_cashback ? '#00BCD4' : '#BDBDBD'"
              inset
              dense
              hide-details
              class="small-switch mt-n2 items-start">
              <template #label>
                <span class="text-body-2 font-weight-regular">
                  {{ frappe._("Cashback?") }}
                </span>
              </template>
              </v-switch>
          </v-col>
          <v-col cols="6" v-if="is_credit_sale">
            <v-menu
              ref="date_menu"
              v-model="date_menu"
              :close-on-content-click="false"
              transition="scale-transition">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="invoice_doc.due_date"
                  :label="frappe._('Due Date')"
                  readonly
                  variant="outlined"
                  density="compact"
                  hide-details
                  v-bind="props"
                  color="primary"></v-text-field>
              </template>
              <v-date-picker
                v-model="credit_sales_due_date"
                no-title
                scrollable
                color="primary"
                :min="frappe.datetime.now_date()"
                @input="date_menu = false">
              </v-date-picker>
            </v-menu>
          </v-col>
          <v-col
            cols="6"
            v-if="!invoice_doc.is_return && pos_profile.use_customer_credit">
            <v-switch
              v-model="redeem_customer_credit"
              :color="redeem_customer_credit ? '#00BCD4' : '#BDBDBD'"
              :base-color="redeem_customer_credit ? '#00BCD4' : '#BDBDBD'"
              inset
              dense
              hide-details
              class="small-switch mt-n2 items-start"
              @update:model-value="get_available_credit($event)"
            >
              <template #label>
                <span class="text-body-2 font-weight-regular">
                  {{ frappe._("Use Customer Credit") }}
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
          ">
          <v-row v-for="(row, idx) in customer_credit_dict" :key="idx">
            <v-col cols="4">
              <div class="pa-2 py-3">{{ row.credit_origin }}</div>
            </v-col>
            <v-col cols="4">
              <v-text-field
                density="compact"
                variant="outlined"
                color="primary"
                :label="frappe._('Available Credit')"
                bg-color="white"
                hide-details
                :model-value="formatCurrency(row.total_credit)"
                disabled
                :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
            </v-col>
            <v-col cols="4">
              <v-text-field
                density="compact"
                variant="outlined"
                color="primary"
                :label="frappe._('Redeem Credit')"
                bg-color="white"
                hide-details
                type="number"
                v-model="row.credit_to_redeem"
                :prefix="currencySymbol(invoice_doc.currency)"></v-text-field>
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
            :disabled="vaildatPayment">
            <v-icon start size="18">mdi-check-circle</v-icon>
            {{ __("Submit") }}
          </v-btn>
        </v-col>

        <v-col cols="12" md="6" class="pa-1">
          <v-btn
            block
            class="btn-primary-action gradient-teal-animate hover-glow ripple-effect"
            @click="submit(undefined, false, true)"
            :disabled="vaildatPayment">
            <v-icon start size="18">mdi-printer</v-icon>
            {{ __("Submit & Print") }}
          </v-btn>
        </v-col>

        <v-col cols="12" md="6" class="pa-1">
          <v-btn
            block
            class="btn-danger click-squish"
            @click="back_to_invoice">
            <v-icon start size="18">mdi-cancel</v-icon>
            {{ __("Cancel Payment") }}
          </v-btn>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
    <div>
      <v-dialog v-model="phone_dialog" max-width="400px">
        <v-card elevation="8" rounded="xl">
          <v-card-title>
            <span class="text-h5 text-primary">{{
              __("Confirm Mobile Number")
            }}</span>
          </v-card-title>
          <v-card-text class="pa-0">
            <v-container>
              <v-text-field
                density="compact"
                variant="outlined"
                color="primary"
                :label="frappe._('Mobile Number')"
                bg-color="white"
                hide-details
                v-model="invoice_doc.contact_mobile"
                type="number"></v-text-field>
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
import format from "../../format";
import hardwareUtils from "../../hardwareManager/hardwareUtils";
import { toast } from "vue3-toastify"; // <-- make sure this is imported

export default {
  mixins: [format, hardwareUtils],
  data: () => ({
    loading: false,
    pos_profile: "",
    invoice_doc: "",
    loyalty_amount: 0,
    credit_sales_due_date: new Date(frappe.datetime.now_date()),
    is_credit_sale: 0,
    is_write_off_change: 0,
    date_menu: false,
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
    back_to_invoice() {
      this.eventBus.emit("show_payment", "false");
      this.eventBus.emit("set_customer_readonly", false);
    },
    submit(event, payment_received = false, print = false) {
      if (!this.invoice_doc.is_return && this.total_payments < 0) {
        toast.error(`Payments not correct`);
        frappe.utils.play_sound("error");
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
          toast.error(
            __("Please request phone payment or use other payment method")
          );
          frappe.utils.play_sound("error");
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
        frappe.utils.play_sound("error");
        return;
      }

      if (
        this.pos_profile.posa_allow_partial_payment &&
        !this.pos_profile.posa_allow_credit_sale &&
        this.total_payments == 0
      ) {
        toast.error(`Please enter the amount paid`);
        frappe.utils.play_sound("error");
        return;
      }

      if (!this.paid_change) this.paid_change = 0;

      if (this.paid_change > -this.diff_payment) {
        toast.error(`Paid change can not be greater than total change!`);
        frappe.utils.play_sound("error");
        return;
      }

      let total_change = this.flt(
        this.flt(this.paid_change) + this.flt(-this.credit_change)
      );

      if (this.is_cashback && total_change != -this.diff_payment) {
        toast.error(`Error in change calculations!`);
        frappe.utils.play_sound("error");
        return;
      }

      let credit_calc_check = this.customer_credit_dict.filter((row) => {
        if (flt(row.credit_to_redeem))
          return flt(row.credit_to_redeem) > flt(row.total_credit);
        else return false;
      });

      if (credit_calc_check.length > 0) {
        toast.error(`redeamed credit can not greater than its total.`);
        frappe.utils.play_sound("error");
        return;
      }

      if (
        !this.invoice_doc.is_return &&
        this.redeemed_customer_credit >
          (this.invoice_doc.rounded_total || this.invoice_doc.grand_total)
      ) {
        toast.error(`can not redeam customer credit more than invoice total`);
        frappe.utils.play_sound("error");
        return;
      }

      this.is_sucessful_invoice = this.submit_invoice(print);
    },
    submit_invoice(print) {
      let totalPayedAmount = 0;
      this.invoice_doc.payments.forEach((payment) => {
        payment.amount = flt(payment.amount);
        totalPayedAmount += payment.amount;
      });
      if (this.invoice_doc.is_return && totalPayedAmount == 0) {
        this.invoice_doc.is_pos = 0;
      }
      if (this.customer_credit_dict.length) {
        this.customer_credit_dict.forEach((row) => {
          row.credit_to_redeem = flt(row.credit_to_redeem);
        });
      }
      let data = {};
      data["total_change"] = !this.invoice_doc.is_return
        ? -this.diff_payment
        : 0;
      data["paid_change"] = !this.invoice_doc.is_return ? this.paid_change : 0;
      data["credit_change"] = -this.credit_change;
      data["redeemed_customer_credit"] = this.redeemed_customer_credit;
      data["customer_credit_dict"] = this.customer_credit_dict;
      data["is_cashback"] = this.is_cashback;

      const vm = this;
      frappe.call({
        method: "pospire.pospire.api.posapp.submit_invoice",
        args: {
          data: data,
          invoice: this.invoice_doc,
        },
        async: false,
        callback: function (r) {
          if (!r?.message) {
            toast.error("Error submitting invoice");
            return;
          }
          if (print) {
            vm.handlePrint(vm.invoice_doc.name);
          }
          vm.customer_credit_dict = [];
          vm.redeem_customer_credit = false;
          // Reset is_cashback based on POS Profile setting
          vm.is_cashback = vm.pos_profile && vm.pos_profile.use_cashback == 1 ? true : false;
          vm.sales_person = "";

          vm.eventBus.emit("set_last_invoice", vm.invoice_doc.name);
          toast.success(`Invoice ${r.message.name} is Submited`);
          //s
          frappe.utils.play_sound("submit");
          vm.addresses = [];
          vm.eventBus.emit("clear_invoice");
          vm.back_to_invoice();
          return;
        },
      });
      console.log(this.is_sucessful_invoice);
    },
    async handlePrint(invoice_name) {
      try {
        await this.hardwareConfiguration(this.pos_profile.name).then((res) => {
          if (res === true) {
            this.custom_print(invoice_name);
          } else {
            vm.load_print_page();
          }
        });
      } catch (err) {
        console.error("Hardware config check failed:", err);
        this.load_print_page(invoice_name); // fallback
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
      this.invoice_doc.payments.forEach((payment) => {
        if (
          payment.idx == idx &&
          payment.amount == 0 &&
          this.diff_payment > 0
        ) {
          payment.amount = this.diff_payment;
        }
      });
    },
    clear_all_amounts() {
      this.invoice_doc.payments.forEach((payment) => {
        payment.amount = 0;
      });
    },
    load_print_page() {
      const print_format =
        this.pos_profile.print_format_for_online ||
        this.pos_profile.print_format;
      const letter_head = this.pos_profile.letter_head || 0;
      const url =
        frappe.urllib.get_base_url() +
        "/printview?doctype=Sales%20Invoice&name=" +
        this.invoice_doc.name +
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
      const today = frappe.datetime.now_date();
      const parse_today = Date.parse(today);
      const new_date = Date.parse(this.invoice_doc.due_date);
      if (new_date < parse_today) {
        setTimeout(() => {
          this.invoice_doc.due_date = today;
        }, 0);
      }
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
        this.paid_change_rules = [
          "Paid change can not be greater than total change!",
        ];
        this.credit_change = 0;
      }
    },
    get_available_credit(e) {
      this.clear_all_amounts();
      if (e) {
        frappe
          .call("pospire.pospire.api.posapp.get_available_credit", {
            customer: this.invoice_doc.customer,
            company: this.pos_profile.company,
          })
          .then((r) => {
            const data = r.message;
            if (data.length) {
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
          });
      } else {
        this.customer_credit_dict = [];
      }
    },
    get_addresses() {
      const vm = this;
      if (!vm.invoice_doc) {
        return;
      }
      frappe.call({
        method: "pospire.pospire.api.posapp.get_customer_addresses",
        args: { customer: vm.invoice_doc.customer },
        async: true,
        callback: function (r) {
          if (!r.exc) {
            vm.addresses = r.message;
          } else {
            vm.addresses = [];
          }
        },
      });
    },
    addressFilter(item, queryText, itemText) {
      const textOne = item.address_title
        ? item.address_title.toLowerCase()
        : "";
      const textTwo = item.address_line1
        ? item.address_line1.toLowerCase()
        : "";
      const textThree = item.address_line2
        ? item.address_line2.toLowerCase()
        : "";
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
    get_sales_person_names() {
      const vm = this;
      if (
        vm.pos_profile.posa_local_storage &&
        localStorage.sales_persons_storage
      ) {
        vm.sales_persons = JSON.parse(
          localStorage.getItem("sales_persons_storage")
        );
      }
      frappe.call({
        method: "pospire.pospire.api.posapp.get_sales_person_names",
        callback: function (r) {
          if (r.message) {
            vm.sales_persons = r.message;
            if (vm.pos_profile.posa_local_storage) {
              localStorage.setItem("sales_persons_storage", "");
              localStorage.setItem(
                "sales_persons_storage",
                JSON.stringify(r.message)
              );
            }
          }
        },
      });
    },
    salesPersonFilter(itemText, queryText, itemRow) {
      const item = itemRow.raw;
      const textOne = item.sales_person_name
        ? item.sales_person_name.toLowerCase()
        : "";
      const textTwo = item.name.toLowerCase();
      const searchText = queryText.toLowerCase();

      return (
        textOne.indexOf(searchText) > -1 || textTwo.indexOf(searchText) > -1
      );
    },
    request_payment() {
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

      frappe
        .call({
          method: "pospire.pospire.api.posapp.update_invoice",
          args: {
            data: formData,
          },
          async: false,
          callback: function (r) {
            if (r.message) {
              vm.invoice_doc = r.message;
            }
          },
        })
        .then(() => {
          frappe
            .call({
              method: "pospire.pospire.api.posapp.create_payment_request",
              args: {
                doc: vm.invoice_doc,
              },
            })
            .fail(() => {
              this.eventBus.emit("unfreeze");
              toast.error(__(`Payment request failed`));
            })
            .then(({ message }) => {
              const payment_request_name = message.name;
              setTimeout(() => {
                frappe.db
                  .get_value("Payment Request", payment_request_name, [
                    "status",
                    "grand_total",
                  ])
                  .then(({ message }) => {
                    if (message.status != "Paid") {
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
                            message.grand_total,
                            vm.invoice_doc.currency,
                            0
                          ),
                        ])
                      );
                      frappe.db
                        .get_doc("Sales Invoice", vm.invoice_doc.name)
                        .then((doc) => {
                          vm.invoice_doc = doc;
                          vm.submit(null, true);
                        });
                    }
                  });
              }, 30000);
            });
        });
    },
    get_mpesa_modes() {
      const vm = this;
      frappe.call({
        method: "pospire.pospire.api.m_pesa.get_mpesa_mode_of_payment",
        args: { company: vm.pos_profile.company },
        async: true,
        callback: function (r) {
          if (!r.exc) {
            vm.mpesa_modes = r.message;
          } else {
            vm.mpesa_modes = [];
          }
        },
      });
    },
    is_mpesa_c2b_payment(payment) {
      if (
        this.mpesa_modes.includes(payment.mode_of_payment) &&
        payment.type == "Bank"
      ) {
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
      const invoiceAmount =
        this.invoice_doc.rounded_total || this.invoice_doc.grand_total;
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
    total_payments() {
      let total = parseFloat(this.invoice_doc.loyalty_amount);
      if (this.invoice_doc && this.invoice_doc.payments) {
        this.invoice_doc.payments.forEach((payment) => {
          total += this.flt(payment.amount);
        });
      }

      total += this.flt(this.redeemed_customer_credit);

      if (!this.is_cashback) total = 0;

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
        amount =
          this.customer_info.loyalty_points *
          this.customer_info.conversion_factor;
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
        if (
          this.invoiceType == "Order" &&
          !this.invoice_doc.posa_delivery_date
        ) {
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
          if (
            el.fieldtype == "Button" &&
            el.fieldname == "request_for_payment"
          ) {
            res = true;
          }
        });
      }
      return res;
    },
  },

  mounted: function () {
    this.$nextTick(function () {
      this.eventBus.on("send_invoice_doc_payment", (invoice_doc) => {
        this.invoice_doc = invoice_doc.invoice_doc;
        const default_payment = this.invoice_doc.payments.find(
          (payment) => payment.default == 1
        );
        this.is_credit_sale = 0;
        this.is_write_off_change = 0;
        if (default_payment && !invoice_doc.is_return) {
          default_payment.amount = this.flt(
            this.invoice_doc.rounded_total || this.invoice_doc.grand_total,
            this.currency_precision
          );
        }
        if (invoice_doc.is_return) {
          this.is_return = true;
          // Initialize is_cashback based on POS Profile setting for returns
          if (this.pos_profile && this.pos_profile.use_cashback == 0) {
            this.is_cashback = false;
          } else if (this.pos_profile && this.pos_profile.use_cashback == 1) {
            this.is_cashback = true;
          }
          invoice_doc.payments.forEach((payment) => {
            payment.amount = 0;
            payment.base_amount = 0;
          });
        }
        this.loyalty_amount = 0;
        this.get_addresses();
        this.get_sales_person_names();
      });
      this.eventBus.on("register_pos_profile", (data) => {
        this.pos_profile = data.pos_profile;
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
      this.eventBus.on("add_the_new_address", (data) => {
        this.addresses.push(data);
        this.$forceUpdate();
      });
      this.eventBus.on("update_invoice_type", (data) => {
        this.invoiceType = data;
        if (this.invoice_doc && data != "Order") {
          this.invoice_doc.posa_delivery_date = null;
          this.invoice_doc.posa_notes = null;
          this.invoice_doc.shipping_address_name = null;
        }
      });
    });
    this.eventBus.on("update_customer", (customer) => {
      if (this.customer != customer) {
        this.customer_credit_dict = [];
        this.redeem_customer_credit = false;
        // Reset is_cashback based on POS Profile setting
        this.is_cashback = this.pos_profile && this.pos_profile.use_cashback == 1 ? true : false;
      }
    });
    this.eventBus.on("set_pos_settings", (data) => {
      this.pos_settings = data;
    });
    this.eventBus.on("set_customer_info_to_edit", (data) => {
      this.customer_info = data;
    });
    this.eventBus.on("set_mpesa_payment", (data) => {
      this.set_mpesa_payment(data);
    });
  },
  created() {
    document.addEventListener("keydown", this.shortPay.bind(this));
  },
  beforeUnmount() {
    this.eventBus.off("send_invoice_doc_payment");
    this.eventBus.off("register_pos_profile");
    this.eventBus.off("add_the_new_address");
    this.eventBus.off("update_invoice_type");
    this.eventBus.off("update_customer");
    this.eventBus.off("set_pos_settings");
    this.eventBus.off("set_customer_info_to_edit");
    this.eventBus.off("update_invoice_coupons");
    this.eventBus.off("set_mpesa_payment");
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
    credit_sales_due_date(value) {
      this.invoice_doc.due_date = frappe.datetime.get_datetime_as_string(value);
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
  color: #34495E !important; /* Deep Slate - Design System */
}

.section-header-title {
  display: flex;
  align-items: center;
  padding-left: 0;
  font-size: 1rem;
  font-weight: 600;
  background-color: #ECEFF1;
  color: #34495E !important; /* Deep Slate - Design System */
}

.section-header-title .v-icon {
  color: #00BCD4 !important; /* Vibrant Teal - Design System */
  margin-right: 8px;
}

/* Payment Method Buttons - Design System Compliant */
.payment-method-btn {
  color: #34495E !important; /* Deep Slate */
  border: 1px solid #E0E0E0 !important;
  background-color: #FFFFFF !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.5px !important;
  transition: all 0.2s ease !important;
}

.payment-method-btn:hover {
  border-color: #00BCD4 !important;
  background-color: rgba(0, 188, 212, 0.05) !important;
  box-shadow: 0 2px 8px rgba(0, 188, 212, 0.2) !important;
}

.payment-method-btn:active {
  transform: scale(0.98) !important;
}

.payment-method-btn .v-icon {
  color: #00BCD4 !important; /* Vibrant Teal for icons */
}
</style>
