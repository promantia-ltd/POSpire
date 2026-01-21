<template>
  <div fluid>
    <v-row v-show="!dialog">
      <v-col md="8" cols="12" class="pb-2 pr-0">
        <v-card class="modern-payments-card mx-auto mt-3 overflow-y-auto"
          style="max-height: 94vh; height: 94vh">
          <div class="modern-payments-content">
            <!-- Customer Section -->
            <div class="mb-6 customer-section-wrapper">
              <Customer></Customer>
              <PaidInvoice></PaidInvoice>
            </div>

            <!-- Invoices Section -->
            <div class="mb-6 invoices-section-wrapper">
              <div class="section-header mb-4">
                <v-card class="modern-section-card" variant="flat">
                  <v-card-title class="section-title">
                    <v-icon class="section-icon" size="24" color="#00BCD4">mdi-file-document-outline</v-icon>
                    <div class="section-text">
                      <div class="section-main-title">{{ __("Invoices") }}</div>
                      <div v-if="total_outstanding_amount" class="section-subtitle">
                        {{ __("Total Outstanding") }}: {{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(total_outstanding_amount) }}
                      </div>
                    </div>
                    <div v-if="total_selected_invoices" class="section-badge">
                      <v-chip color="primary" variant="flat" size="small">
                        {{ __("Selected") }}: {{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(total_selected_invoices) }}
                      </v-chip>
                    </div>
                  </v-card-title>
                </v-card>
              </div>
            <v-row :align="center" no-gutters class="mb-1">
              <v-col md="4" cols="12">
                <v-select density="compact" variant="outlined" hide-details clearable bg-color="white"
                  v-model="pos_profile_search" :items="pos_profiles_list" item-value="name"
                  label="Select POS Profile"></v-select>
              </v-col>
              <v-col> </v-col>
              <v-col md="4" cols="6">
                <v-switch v-model="include_paid" color="primary" inset dense hide-details class="small-switch mt-n2">
                  <template v-slot:label>
                    <span class="ml-n0 mt-4 d-block">{{ frappe._('Show Paid Invoice') }}</span>
                  </template>
                </v-switch>
              </v-col>
              <v-col> </v-col>
              <v-col md="3" cols="12">
                <v-btn block color="#00BCD4" class="text-white" @click="get_outstanding_invoices">{{ __("Search") }}</v-btn>
              </v-col>
            </v-row>
            <v-data-table
              :headers="invoices_headers"
              :items="paginatedInvoices"
              item-key="name"
              class="elevation-1 mt-0"
              show-select
              v-model="selected_invoices"
              :loading="invoices_loading"
              return-object
              checkbox-color="primary"
              @item-selected="onInvoiceSelected"
              hide-default-footer
            >
              <template v-slot:item.grand_total="{ item }">
                {{ currencySymbol(item.currency) }}
                {{ formatCurrency(item.grand_total) }}
              </template>
              <template v-slot:item.outstanding_amount="{ item }">
                <span class="text-primary">{{ currencySymbol(item.currency) }}
                  {{ formatCurrency(item.outstanding_amount) }}</span>
              </template>
              <template v-slot:item.actions="{ item }">
                <div class="d-flex ga-2 justify-end">
                  <v-icon color="medium-emphasis" icon="mdi-eye-arrow-right" size="small" @click="view(item.name)"></v-icon>
                </div>
              </template>
              <template v-slot:bottom>
                <div class="text-center compact-pagination">
                      <span class="text-caption page-info">
                        {{ paginatedInvoices.length ? ((page - 1) * itemsPerPage + 1) : 0 }} -
                        {{ Math.min(page * itemsPerPage, outstanding_invoices.length) }}
                        of {{ outstanding_invoices.length }}
                      </span>
                  <v-pagination
                    :total-visible="5"
                    v-model="page"
                    :length="pageCount"
                    density="compact"
                    size="small"
                  ></v-pagination>
                </div>
              </template>

            </v-data-table>
            <v-divider></v-divider>
            </div>
          </div>
          <div v-if="
            pos_profile.posa_allow_reconcile_payments &&
            unallocated_payments.length
          " class="mb-6">
            <div class="section-header mb-4">
              <v-card class="modern-section-card" variant="flat">
                <v-card-title class="section-title">
                  <v-icon class="section-icon" size="24" color="#00BCD4">mdi-credit-card-outline</v-icon>
                  <div class="section-text">
                    <div class="section-main-title">{{ __("Payments") }}</div>
                    <div v-if="total_unallocated_amount" class="section-subtitle">
                      {{ __("Total Unallocated") }}: {{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(total_unallocated_amount) }}
                    </div>
                  </div>
                  <div v-if="total_selected_payments" class="section-badge">
                    <v-chip color="primary" variant="flat" size="small">
                      {{ __("Selected") }}: {{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(total_selected_payments) }}
                    </v-chip>
                  </div>
                </v-card-title>
              </v-card>
            </div>
            <v-data-table :headers="unallocated_payments_headers" :items="paginatedUnallocatedPayments" item-key="name"
              class="elevation-1 mt-0" :single-select="singleSelect" show-select v-model="selected_payments" return-object
              :loading="unallocated_payments_loading" checkbox-color="primary"   hide-default-footer >
              <template v-slot:item.paid_amount="{ item }">
                {{ currencySymbol(item.currency) }}
                {{ formatCurrency(item.paid_amount) }}
              </template>
              <template v-slot:item.unallocated_amount="{ item }">
                <span class="text-primary">
                  {{ currencySymbol(item.currency) }}
                  {{ formatCurrency(item.unallocated_amount) }}
                </span>
              </template>
                <template v-slot:bottom>
                  <div class="text-center compact-pagination">
                    <span class="text-caption page-info">
                      {{ paginatedUnallocatedPayments.length ? ((paymentsPage - 1) * paymentsItemsPerPage + 1) : 0 }} -
                      {{ Math.min(paymentsPage * paymentsItemsPerPage, unallocated_payments.length) }}
                      of {{ unallocated_payments.length }}
                    </span>
                    
                    <v-pagination
                      :total-visible="5"
                      v-model="paymentsPage"
                      :length="paymentsPageCount"
                      density="compact"
                      size="small"
                    ></v-pagination>
                  </div>
                </template>

            </v-data-table>
            <v-divider></v-divider>
          </div>
          <div v-if="pos_profile.posa_allow_mpesa_reconcile_payments" class="mb-6">
            <div class="section-header mb-4">
              <v-card class="modern-section-card" variant="flat">
                <v-card-title class="section-title">
                  <v-icon class="section-icon" size="24" color="#00BCD4">mdi-cellphone-nfc</v-icon>
                  <div class="section-text">
                    <div class="section-main-title">{{ __("Search Mpesa Payments") }}</div>
                  </div>
                  <div v-if="total_selected_mpesa_payments" class="section-badge">
                    <v-chip color="primary" variant="flat" size="small">
                      {{ __("Selected") }}: {{ currencySymbol(pos_profile.currency) }} {{ formatCurrency(total_selected_mpesa_payments) }}
                    </v-chip>
                  </div>
                </v-card-title>
              </v-card>
            </div>
            <v-row :align="center" no-gutters class="mb-1">
              <v-col md="4" cols="12" class="mr-1">
                <v-text-field density="compact" variant="outlined" color="primary" :label="frappe._('Search by Name')"
                  bg-color="white" hide-details v-model="mpesa_search_name" clearable></v-text-field>
              </v-col>
              <v-col md="4" cols="12" class="mr-1">
                <v-text-field density="compact" variant="outlined" color="primary" :label="frappe._('Search by Mobile')"
                  bg-color="white" hide-details v-model="mpesa_search_mobile" clearable></v-text-field>
              </v-col>
              <v-col> </v-col>
              <v-col md="3" cols="12">
                <v-btn block color="#00BCD4" class="text-white" @click="get_draft_mpesa_payments_register">{{ __("Search")
                  }}</v-btn>
              </v-col>
            </v-row>
            <v-data-table :headers="mpesa_payment_headers"   :items="paginatedMpesaPayments" item-key="name"
              class="elevation-1 mt-0" :single-select="singleSelect" show-select v-model="selected_mpesa_payments" 
              :loading="mpesa_payments_loading" checkbox-color="primary"   hide-default-footer>
              <template v-slot:item.amount="{ item }">
                <span class="text-primary">
                  {{ currencySymbol(item.currency) }}
                  {{ formatCurrency(item.amount) }}
                </span>
              </template>

              <template v-slot:bottom>
                <div class="text-center compact-pagination">
                  <span class="text-caption page-info">
                    {{ paginatedMpesaPayments.length ? ((mpesaPage - 1) * mpesaItemsPerPage + 1) : 0 }} -
                    {{ Math.min(mpesaPage * mpesaItemsPerPage, mpesa_payments.length) }}
                    of {{ mpesa_payments.length }}
                  </span>
                  <v-pagination
                  :total-visible="5"
                  v-model="mpesaPage"
                  :length="mpesaPageCount"
                  density="compact"
                  size="small"
                  ></v-pagination>
                </div>
              </template>
            </v-data-table>
          </div>
        </v-card>
      </v-col>
      <v-col md="4" cols="12" class="pb-3">
        <v-card class="modern-totals-card mx-auto mt-3" style="max-height: 94vh; height: 94vh">
          <div class="totals-header mb-4">
            <v-card class="modern-section-card" variant="flat">
              <v-card-title class="section-title">
                <v-icon class="section-icon" size="24" color="#00BCD4">mdi-calculator</v-icon>
                <div class="section-text">
                  <div class="section-main-title">{{ __("Totals") }}</div>
                </div>
              </v-card-title>
            </v-card>
          </div>
          <div class="totals-content">
            <v-row>
              <v-col md="7" class="mt-1">
                <span>{{ __("Total Invoices:") }}</span>
              </v-col>
              <v-col md="5">
                <v-text-field class="p-0 m-0" density="compact" color="primary" bg-color="white" hide-details
                  :model-value="formatCurrency(total_selected_invoices)" total_selected_invoices readonly flat
                  :prefix="currencySymbol(pos_profile.currency)"></v-text-field>
              </v-col>
            </v-row>

            <v-row v-if="total_selected_payments">
              <v-col md="7" class="mt-1"><span>{{ __("Total Payments:") }}</span></v-col>
              <v-col md="5">
                <v-text-field class="p-0 m-0" density="compact" color="primary" bg-color="white" hide-details
                  :model-value="formatCurrency(total_selected_payments)" total_selected_payments readonly flat
                  :prefix="currencySymbol(pos_profile.currency)"></v-text-field>
              </v-col>
            </v-row>

            <v-row v-if="total_selected_mpesa_payments">
              <v-col md="7" class="mt-1"><span>{{ __("Total Mpesa:") }}</span></v-col>
              <v-col md="5">
                <v-text-field class="p-0 m-0" density="compact" color="primary" bg-color="white" hide-details
                  :model-value="formatCurrency(total_selected_mpesa_payments)" total_selected_mpesa_payments readonly
                  flat :prefix="currencySymbol(pos_profile.currency)"></v-text-field>
              </v-col>
            </v-row>

            <v-divider v-if="payment_methods.length"></v-divider>
            <div v-if="pos_profile.posa_allow_make_new_payments" class="mt-6">
              <div class="subsection-header mb-4">
                <v-card class="modern-subsection-card" variant="flat">
                  <v-card-title class="subsection-title">
                    <v-icon class="subsection-icon" size="20">mdi-cash-multiple</v-icon>
                    <span class="subsection-text">{{ __("Make New Payment") }}</span>
                  </v-card-title>
                </v-card>
              </div>
              <v-row v-if="payment_methods.length" v-for="method in payment_methods" :key="method.row_id">
                <v-col md="7"><span class="mt-1">{{ __(method.mode_of_payment) }}:</span>
                </v-col>
                <v-col md="5">
                  <v-text-field  class="p-0 m-0" density="compact" color="primary" bg-color="white" hide-details
                    v-model.number="method.amount" @input="calculateDifference" flat :prefix="currencySymbol(pos_profile.currency)"
                  ></v-text-field></v-col>
              </v-row>
            </div>

            <v-divider></v-divider>
            <v-divider class="my-4"></v-divider>
            <div class="difference-section">
              <v-row>
                <v-col md="7">
                  <div class="difference-label">
                    <v-icon class="mr-2" size="20" color="primary">mdi-delta</v-icon>
                    <span class="text-h6 font-weight-medium text-primary">{{ __("Difference:") }}</span>
                  </div>
                </v-col>
                <v-col md="5">
                  <v-text-field class="p-0 m-0" density="compact" color="primary" bg-color="white" hide-details
                    :model-value="formatCurrency(total_of_diff)" total_of_diff flat readonly
                    :prefix="currencySymbol(pos_profile.currency)"></v-text-field>
                </v-col>
              </v-row>
            </div>
          </div>
          <div class="pb-6 pr-6" style="position: absolute; bottom: 0; width: 100%">
            <v-btn block color="#00BCD4" class="text-white" @click="submit">
              {{ __("Submit") }}
            </v-btn>
          </div>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script>
import { toast } from "vue3-toastify";

import format from "../../format";
import Customer from "../pos/Customer.vue";
import PaidInvoice from "../pos/PaidInvoice.vue";
import UpdateCustomer from "../pos/UpdateCustomer.vue";

export default {
  mixins: [format],
  data: function () {
    return {
      page: 1,
      itemsPerPage: 5,
      paymentsPage: 1,
      paymentsItemsPerPage: 5,
      mpesaPage: 1,
      mpesaItemsPerPage: 5,
      dialog: false,
      include_paid: false,
      pos_profile: "",
      pos_opening_shift: "",
      customer_name: "",
      customer_info: "",
      company: "",
      singleSelect: false,
      invoices_loading: false,
      unallocated_payments_loading: false,
      mpesa_payments_loading: false,
      payment_methods: [],
      outstanding_invoices: [],
      unallocated_payments: [],
      mpesa_payments: [],
      selected_invoices: [],
      selected_payments: [],
      selected_mpesa_payments: [],
      pos_profiles_list: [],
      pos_profile_search: "",
      payment_methods_list: [],
      mpesa_searchname: "",
      mpesa_search_mobile: "",
      invoices_headers: [
        {
          title: __("Invoice"),
          align: "start",
          sortable: true,
          key: "name",
        },
        {
          title: __("Customer"),
          align: "start",
          sortable: true,
          key: "customer_name",
        },
        {
          title: __("Date"),
          align: "start",
          sortable: true,
          key: "posting_date",
        },
        {
          title: __("Due Date"),
          align: "start",
          sortable: true,
          key: "due_date",
        },
        {
          title: __("Total"),
          align: "end",
          sortable: true,
          key: "grand_total",
        },
        {
          title: __("Outstanding"),
          align: "end",
          sortable: true,
          key: "outstanding_amount",
        },
        {
          title: __("Actions"),
          align: "end",
          sortable: false,
          key: "actions",
        }
      ],
      unallocated_payments_headers: [
        {
          title: __("Payment ID"),
          align: "start",
          sortable: true,
          key: "name",
        },
        {
          title: __("Customer"),
          align: "start",
          sortable: true,
          key: "customer_name",
        },
        {
          title: __("Date"),
          align: "start",
          sortable: true,
          key: "posting_date",
        },
        {
          title: __("Mode"),
          align: "start",
          sortable: true,
          key: "mode_of_payment",
        },
        {
          title: __("Paid"),
          align: "end",
          sortable: true,
          key: "paid_amount",
        },
        {
          title: __("Unallocated"),
          align: "end",
          sortable: true,
          key: "unallocated_amount",
        },
      ],
      mpesa_payment_headers: [
        {
          title: __("Payment ID"),
          align: "start",
          sortable: true,
          key: "transid",
        },
        {
          title: __("Full Name"),
          align: "start",
          sortable: true,
          key: "full_name",
        },
        {
          title: __("Mobile Number"),
          align: "start",
          sortable: true,
          key: "mobile_no",
        },
        {
          title: __("Date"),
          align: "start",
          sortable: true,
          key: "posting_date",
        },
        {
          title: __("Amount"),
          align: "end",
          sortable: true,
          key: "amount",
        },
      ],
    };
  },

  components: {
    Customer,
    UpdateCustomer,
    PaidInvoice
  },

  methods: {
    check_opening_entry() {
      var vm = this;
      return frappe
        .call("pospire.pospire.api.posapp.check_opening_shift", {
          user: frappe.session.user,
        })
        .then((r) => {
          if (r.message) {
            this.pos_profile = r.message.pos_profile;
            this.pos_opening_shift = r.message.pos_opening_shift;
            this.company = r.message.company.name;
            vm.eventBus.emit("payments_register_pos_profile", r.message);
            vm.eventBus.emit("set_company", r.message.company);
            this.set_payment_methods();
            this.pos_profile_search = r.message.pos_profile.name;
            this.pos_profiles_list.push(this.pos_profile_search);
            this.payment_methods_list = [];
            this.pos_profile.payments.forEach((element) => {
              this.payment_methods_list.push(element.mode_of_payment);
            });
            this.get_available_pos_profiles();
            this.get_outstanding_invoices();
            this.get_draft_mpesa_payments_register();
          } else {
            this.create_opening_voucher();
          }
        });
    },
    view(id) {
      var vm = this;
      frappe.call({
        method: "pospire.pospire.api.posapp.search_invoices_with_items",
        args: {
          invoice_name: id,
          company: vm.company
        },
        async: false,
        callback: function (r) {
          if (r.message && r.message.length > 0 && r.message[0].items) {
            vm.eventBus.emit("open_paid", r.message[0].items);
          } else {
            toast.warn(__(`Invoice has no items`, [id]));
          }
        },
      });
      //const found = books.value.find(book => book.id === id)
    },

    calculateDifference() {
      console.log("New difference calculated:", this.total_of_diff);
    },
    get_available_pos_profiles() {
      if (!this.pos_profile.posa_allow_mpesa_reconcile_payments) return;
      return frappe
        .call(
          "pospire.pospire.api.payment_entry.get_available_pos_profiles",
          {
            company: this.company,
            currency: this.pos_profile.currency,
          }
        )
        .then((r) => {
          if (r.message) {
            this.pos_profiles_list = r.message;
          }
        });
    },
    create_opening_voucher() {
      this.dialog = true;
    },
    fetch_customer_details() {
      var vm = this;
      if (this.customer_name) {
        frappe.call({
          method: "pospire.pospire.api.posapp.get_customer_info",
          args: {
            customer: vm.customer_name,
          },
          async: false,
          callback: (r) => {
            const message = r.message;
            if (!r.exc) {
              vm.customer_info = {
                ...message,
              };
              vm.set_mpesa_search_params();
              vm.eventBus.emit("set_customer_info_to_edit", vm.customer_info);
            }
          },
        });
      }
    },
    onInvoiceSelected(event) {
      this.eventBus.emit("set_customer", event.item.customer);
    },
    get_outstanding_invoices() {
      this.invoices_loading = true;
      return frappe
        .call(
          "pospire.pospire.api.payment_entry.get_outstanding_invoices",
          {
            customer: this.customer_name,
            company: this.company,
            currency: this.pos_profile.currency,
            pos_profile_name: this.pos_profile_search,
            include_paid: this.include_paid
          }
        )
        .then((r) => {
          if (r.message) {
            this.outstanding_invoices = r.message;
            this.invoices_loading = false;
          }
        });
    },
    get_unallocated_payments() {
      if (!this.pos_profile.posa_allow_reconcile_payments) return;
      this.unallocated_payments_loading = true;
      if (!this.customer_name) {
        this.unallocated_payments = [];
        this.unallocated_payments_loading = false;
        return;
      }
      return frappe
        .call(
          "pospire.pospire.api.payment_entry.get_unallocated_payments",
          {
            customer: this.customer_name,
            company: this.company,
            currency: this.pos_profile.currency,
          }
        )
        .then((r) => {
          if (r.message) {
            this.unallocated_payments = r.message;
            this.unallocated_payments_loading = false;
          }
        });
    },
    set_mpesa_search_params() {
      if (!this.pos_profile.posa_allow_mpesa_reconcile_payments) return;
      if (!this.customer_name) return;
      this.mpesa_search_name = this.customer_info.customer_name.split(" ")[0];
      if (this.customer_info.mobile_no) {
        this.mpesa_search_mobile =
          this.customer_info.mobile_no.substring(0, 4) +
          " ***** " +
          this.customer_info.mobile_no.substring(9);
      }
    },
    get_draft_mpesa_payments_register() {
      if (!this.pos_profile.posa_allow_mpesa_reconcile_payments) return;
      const vm = this;
      this.mpesa_payments_loading = true;
      return frappe
        .call("pospire.pospire.api.m_pesa.get_mpesa_draft_payments", {
          company: vm.company,
          mode_of_payment: null,
          full_name: vm.mpesa_search_name || null,
          mobile_no: vm.mpesa_search_mobile || null,
          payment_methods_list: vm.payment_methods_list,
        })
        .then((r) => {
          if (r.message) {
            vm.mpesa_payments = r.message;
          } else {
            vm.mpesa_payments = [];
          }
          vm.mpesa_payments_loading = false;
        });
    },
    set_payment_methods() {
      // get payment methods from pos profile
      if (!this.pos_profile.posa_allow_make_new_payments) return;
      this.payment_methods = [];
      this.pos_profile.payments.forEach((method) => {
        this.payment_methods.push({
          mode_of_payment: method.mode_of_payment,
          amount: 0,
          row_id: method.name,
        });
      });
    },
    clear_all(with_customer_info = true) {
      this.customer_name = "";
      if (with_customer_info) {
        this.customer_info = "";
      }
      this.mpesa_search_mobile = "";
      this.mpesa_search_name = "";
      this.mpesa_payments = [];
      this.selected_mpesa_payments = [];
      this.outstanding_invoices = [];
      this.unallocated_payments = [];
      this.selected_invoices = [];
      this.selected_payments = [];
      this.selected_mpesa_payments = [];
      this.set_payment_methods();
    },
    submit() {
      const customer = this.customer_name;
      const vm = this;
      if (!customer) {
        toast.error(__("Please select a customer"));
        return;
      }
      if (
        this.total_selected_payments == 0 &&
        this.total_selected_mpesa_payments == 0 &&
        this.total_payment_methods == 0
      ) {
        toast.error(__("Please make a payment or select a payment"));
        return;
      }
      if (
        this.total_selected_payments > 0 &&
        this.selected_invoices.length == 0
      ) {
        toast.error(__("Please select an invoice"));
        return;
      }

      this.payment_methods.forEach((payment) => {
        payment.amount = flt(payment.amount);
      });

      const payload = {};
      payload.customer = customer;
      payload.company = this.company;
      payload.currency = this.pos_profile.currency;
      payload.pos_opening_shift_name = this.pos_opening_shift.name;
      payload.pos_profile_name = this.pos_profile.name;
      payload.pos_profile = this.pos_profile;
      payload.payment_methods = this.payment_methods;
      payload.selected_invoices = this.selected_invoices;
      payload.selected_payments = this.selected_payments;
      payload.total_selected_invoices = flt(this.total_selected_invoices);
      payload.selected_mpesa_payments = this.selected_mpesa_payments;
      payload.total_selected_payments = flt(this.total_selected_payments);
      payload.total_payment_methods = flt(this.total_payment_methods);
      payload.total_selected_mpesa_payments = flt(
        this.total_selected_mpesa_payments
      );

      frappe.call({
        method: "pospire.pospire.api.payment_entry.process_pos_payment",
        args: { payload },
        freeze: true,
        freeze_message: __("Processing Payment"),
        callback: function (r) {
          if (r.message) {
            frappe.utils.play_sound("submit");
            vm.clear_all(false);
            vm.customer_name = customer;
            vm.get_outstanding_invoices();
            vm.get_unallocated_payments();
            vm.set_mpesa_search_params();
            vm.get_draft_mpesa_payments_register();
          }
        },
      });
    },
  },

  computed: {
    pageCount() {
      return Math.ceil(this.outstanding_invoices.length / this.itemsPerPage);
    },
    paginatedInvoices() {
        const start = (this.page - 1) * this.itemsPerPage;
        const end = start + this.itemsPerPage;
        return this.outstanding_invoices.slice(start, end);
      },
    paymentsPageCount() {
      return Math.ceil(this.unallocated_payments.length / this.paymentsItemsPerPage);
    },
    paginatedUnallocatedPayments() {
      const start = (this.paymentsPage - 1) * this.paymentsItemsPerPage;
      const end = start + this.paymentsItemsPerPage;
      return this.unallocated_payments.slice(start, end);
    },

    mpesaPageCount() {
      return Math.ceil(this.mpesa_payments.length / this.mpesaItemsPerPage);
    },
    paginatedMpesaPayments() {
      const start = (this.mpesaPage - 1) * this.mpesaItemsPerPage;
      const end = start + this.mpesaItemsPerPage;
      return this.mpesa_payments.slice(start, end);
    },
    total_outstanding_amount() {
      return this.outstanding_invoices.reduce(
        (acc, cur) => acc + flt(cur.outstanding_amount),
        0
      );
    },
    total_unallocated_amount() {
      return this.unallocated_payments.reduce(
        (acc, cur) => acc + flt(cur.unallocated_amount),
        0
      );
    },
    total_selected_invoices() {
      return this.selected_invoices.reduce(
        (acc, cur) => acc + flt(cur.outstanding_amount),
        0
      );
    },
    total_selected_payments() {
      return this.selected_payments.reduce(
        (acc, cur) => acc + flt(cur.unallocated_amount),
        0
      );
    },
    total_selected_mpesa_payments() {
      return this.selected_mpesa_payments.reduce(
        (acc, cur) => acc + flt(cur.amount),
        0
      );
    },
    total_payment_methods() {
      return this.payment_methods.reduce(
        (acc, cur) => acc + flt(cur.amount),
        0
      );
    },
    total_of_diff() {
      return flt(
        this.total_selected_invoices -
        this.total_selected_payments -
        this.total_selected_mpesa_payments -
        this.total_payment_methods
      );
    },
  },

  mounted: function () {
    this.$nextTick(function () {
      this.check_opening_entry();
      this.eventBus.on("update_customer", (customer_name) => {
        this.clear_all(true);
        this.customer_name = customer_name;
        this.fetch_customer_details();
        this.get_outstanding_invoices();
        this.get_unallocated_payments();
        this.get_draft_mpesa_payments_register();
      });
      this.eventBus.on("fetch_customer_details", () => {
        this.fetch_customer_details();
      });
    });
  },
  beforeUnmount() {
    this.eventBus.off("update_customer");
    this.eventBus.off("fetch_customer_details");
  },
};
</script>

<style scoped>
/* Modern Payments Card Styles */
.modern-payments-card {
  border-radius: 16px;
  background: var(--card-bg) !important;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05) !important;
  padding: 1.5rem;
}

.modern-payments-content {
  padding: 0.5rem 0;
}

/* Modern Section Header Styles */
.section-header {
  margin-bottom: 1.5rem;
}

.modern-section-card {
  background: var(--section-bg) !important;
  border-radius: 12px;
  border: 1px solid var(--border-light);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem !important;
  font-size: 1rem !important;
}

.section-icon {
  color: var(--icon-section, #00BCD4) !important;
  background: var(--icon-section-bg, rgba(0, 188, 212, 0.1));
  border-radius: 8px;
  padding: 6px;
}

.section-text {
  flex: 1;
}

.section-main-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-main);
  line-height: 1.2;
}

.section-subtitle {
  font-size: 0.875rem;
  color: var(--text-sub);
  margin-top: 2px;
}

.section-badge {
  margin-left: auto;
}

/* Modern Totals Card Styles */
.modern-totals-card {
  border-radius: 16px;
  background: var(--card-bg) !important;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05) !important;
  padding: 1.5rem;
  overflow-y: auto;
}

.totals-header {
  border-bottom: 1px solid var(--border-light);
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
}

.totals-content {
  padding-top: 0.5rem;
}

/* Subsection Styles */
.subsection-header {
  margin: 1.5rem 0 1rem 0;
}

.modern-subsection-card {
  background: var(--subsection-bg) !important;
  border-radius: 10px;
  border: 1px solid var(--border-subsection);
}

.subsection-title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem !important;
  font-size: 0.95rem !important;
}

.subsection-icon {
  color: var(--icon-subsection) !important;
  background: var(--icon-subsection-bg);
  border-radius: 6px;
  padding: 4px;
}

.subsection-text {
  font-weight: 500;
  color: var(--text-subsection);
}

/* Difference Section */
.difference-section {
  background: var(--difference-bg);
  border-radius: 12px;
  padding: 1rem;
  border: 1px solid var(--border-difference);
}

.difference-label {
  display: flex;
  align-items: center;
}

/* Enhanced Data Tables */
.v-data-table {
  border-radius: 12px !important;
  overflow: hidden;
  border: 1px solid var(--border-light) !important;
}

.v-data-table .v-data-table__wrapper {
  border-radius: 12px;
}

/* Input field styling */
input[total_of_diff] {
  text-align: right;
}

input[payments_methods] {
  text-align: right;
}

input[total_selected_payments] {
  text-align: right;
}

input[total_selected_invoices] {
  text-align: right;
}

input[total_selected_mpesa_payments] {
  text-align: right;
}

.small-switch .v-label {
   margin-left: -6px; 
   margin-top: 4px;
   display: block;
}

/* Modern Button Styling */
.v-btn {
  border-radius: var(--btn-radius) !important;
  text-transform: none !important;
  font-weight: 500 !important;
  box-shadow: var(--btn-shadow) !important;
}

.v-btn:hover {
  transform: translateY(-1px);
  transition: all 0.2s ease;
}

/* Enhanced Chips */
.v-chip {
  border-radius: var(--chip-radius) !important;
  font-weight: 500 !important;
}
</style>
