<template>
  <v-row justify="center">
    <!-- Invoice Selection Dialog -->
    <v-dialog v-model="invoicesDialog" max-width="800px" min-width="800px">
      <v-card class="rounded-xl shadow-lg" variant="flat" color="white" elevation="8" rounded="xl">
        <v-card-title>
          <span class="text-h5 text-primary">
            {{ __('Select Return Invoice') }}
          </span>
        </v-card-title>

        <v-container>
          <v-row class="mb-4">
            <v-text-field
              color="primary"
              :label="frappe._('Invoice ID')"
              bg-color="white"
              hide-details
              v-model="invoice_name"
              density="compact"
              clearable
              class="mx-4"
              @keyup.enter="search_invoices"
            ></v-text-field>
            <v-btn
              variant="text"
              class="ml-2"
              color="primary"
              theme="dark"
              @click="search_invoices"
            >
              {{ __('Search') }}
            </v-btn>
          </v-row>

          <v-row>
            <v-col cols="12" class="pa-1">
              <!-- Loading State -->
              <div v-if="loading" class="text-center py-8">
                <v-progress-circular
                  indeterminate
                  color="primary"
                  size="64"
                ></v-progress-circular>
                <p class="mt-4 text-body-2 text-grey">{{ __('Loading invoices...') }}</p>
              </div>

              <!-- Data Table -->
              <v-data-table
                v-else-if="dialog_data && dialog_data.length"
                :headers="headers"
                :items="paginatedDialogData"
                item-key="name"
                class="elevation-1"
                show-select
                v-model="selected"
                select-strategy="single"
                return-object
                hide-default-footer
                :item-selectable="(item) => !item.fully_returned"
              >
                <!-- Invoice Name with Status Badges -->
                <template v-slot:item.name="{ item }">
                  <div class="d-flex align-center">
                    <span>{{ item.name }}</span>
                    <v-chip
                      v-if="item.fully_returned"
                      size="x-small"
                      color="error"
                      class="ml-2"
                    >
                      {{ __('Fully Returned') }}
                    </v-chip>
                    <v-chip
                      v-else-if="item.has_returns"
                      size="x-small"
                      color="warning"
                      class="ml-2"
                    >
                      {{ __('Partial Return') }}
                    </v-chip>
                  </div>
                </template>

                <template v-slot:item.grand_total="{ item }">
                  {{ currencySymbol(item.currency) }}
                  {{ formatCurrency(item.grand_total) }}
                </template>

                <template v-slot:bottom>
                  <div class="text-center compact-pagination">
                      <span class="text-caption page-info">
                        {{ paginatedDialogData.length ? ((page - 1) * itemsPerPage + 1) : 0 }} -
                        {{ Math.min(page * itemsPerPage, dialog_data.length) }}
                        of {{ dialog_data.length }}
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

              <!-- Empty State -->
              <div v-else class="text-center py-8">
                <v-icon size="64" color="grey-lighten-1">mdi-file-document-outline</v-icon>
                <p class="mt-4 text-body-2 text-grey">{{ __('No invoices found') }}</p>
              </div>
            </v-col>
          </v-row>
        </v-container>

        <v-card-actions class="mt-4">
          <v-spacer></v-spacer>
          <v-btn color="grey-darken-1 mx-2" variant="text" theme="dark" @click="close_dialog">
            {{ __('Close') }}
          </v-btn>
          <v-btn
            v-if="selected.length && !selected[0].fully_returned"
            variant="elevated"
            color="primary"
            theme="dark"
            @click="open_item_selection"
          >
            {{ __('Select Items') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Item Selection Dialog -->
    <v-dialog v-model="itemSelectionDialog" max-width="900px" min-width="900px">
      <v-card class="rounded-xl shadow-lg" variant="flat" color="white" elevation="8" rounded="xl">
        <v-card-title>
          <span class="text-h5 text-primary">
            {{ __('Select Items to Return') }}
          </span>
          <span v-if="selectedInvoice" class="text-subtitle-2 ml-2 text-grey">
            - {{ selectedInvoice.name }}
          </span>
        </v-card-title>

        <v-container>
          <!-- Item Selection Table -->
          <v-data-table
            :headers="itemHeaders"
            :items="returnableItems"
            item-key="sales_invoice_item"
            class="elevation-1"
            hide-default-footer
          >
            <!-- Checkbox for selection -->
            <template v-slot:item.select="{ item }">
              <v-checkbox
                v-model="selectedItems"
                :value="item.sales_invoice_item"
                :disabled="!item.can_return"
                hide-details
                density="compact"
              ></v-checkbox>
            </template>

            <!-- Item Name -->
            <template v-slot:item.item_name="{ item }">
              <div>
                <div class="font-weight-medium">{{ item.item_name }}</div>
                <div class="text-caption text-grey">{{ item.item_code }}</div>
              </div>
            </template>

            <!-- Return Status Badge -->
            <template v-slot:item.status="{ item }">
              <v-chip
                v-if="!item.can_return"
                size="small"
                color="error"
              >
                {{ __('Fully Returned') }}
              </v-chip>
              <v-chip
                v-else-if="item.already_returned_qty > 0"
                size="small"
                color="warning"
              >
                {{ __('Partial') }}
              </v-chip>
              <v-chip
                v-else
                size="small"
                color="success"
              >
                {{ __('Available') }}
              </v-chip>
            </template>

            <!-- Remaining Qty Display -->
            <template v-slot:item.remaining_qty="{ item }">
              <div class="text-center">
                <div class="font-weight-medium">
                  {{ item.remaining_qty }} / {{ item.original_qty }}
                </div>
                <v-progress-linear
                  :model-value="(item.remaining_qty / item.original_qty) * 100"
                  :color="item.remaining_qty === item.original_qty ? 'success' : (item.remaining_qty > 0 ? 'warning' : 'error')"
                  height="4"
                  class="mt-1"
                  rounded
                ></v-progress-linear>
              </div>
            </template>

            <!-- Return Qty Input -->
            <template v-slot:item.return_qty="{ item }">
              <v-text-field
                v-if="item.can_return && isItemSelected(item.sales_invoice_item)"
                v-model.number="returnQuantities[item.sales_invoice_item]"
                type="number"
                :min="1"
                :max="item.remaining_qty"
                density="compact"
                hide-details
                variant="outlined"
                class="return-qty-input"
                style="max-width: 100px"
                @update:model-value="validateReturnQty(item)"
              ></v-text-field>
              <span v-else-if="!item.can_return" class="text-grey">-</span>
              <span v-else class="text-grey text-caption">{{ __('Select to edit') }}</span>
            </template>

            <!-- Rate -->
            <template v-slot:item.rate="{ item }">
              {{ currencySymbol(selectedInvoice?.currency) }}
              {{ formatCurrency(item.rate) }}
            </template>
          </v-data-table>

          <!-- Summary -->
          <v-row class="mt-4" v-if="selectedItems.length > 0">
            <v-col cols="12">
              <v-alert type="info" density="compact" variant="tonal">
                <div class="d-flex justify-space-between align-center">
                  <span>{{ __('Items selected') }}: {{ selectedItems.length }}</span>
                  <span>{{ __('Total return amount') }}: {{ currencySymbol(selectedInvoice?.currency) }} {{ formatCurrency(totalReturnAmount) }}</span>
                </div>
              </v-alert>
            </v-col>
          </v-row>
        </v-container>

        <v-card-actions class="mt-4">
          <v-spacer></v-spacer>
          <v-btn color="grey-darken-1 mx-2" variant="text" theme="dark" @click="close_item_selection">
            {{ __('Back') }}
          </v-btn>
          <v-btn
            v-if="selectedItems.length > 0"
            variant="elevated"
            color="primary"
            theme="dark"
            @click="submit_return"
          >
            {{ __('Load Return') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-row>
</template>

<script>

import format from '../../format';
export default {
  mixins: [format],
  data: () => ({
    page: 1,
    itemsPerPage: 5,
    invoicesDialog: false,
    itemSelectionDialog: false,
    singleSelect: true,
    selected: [],
    selectedItems: [],
    returnQuantities: {},
    dialog_data: [],
    company: '',
    invoice_name: '',
    loading: false,
    selectedInvoice: null,
    returnableItems: [],
    headers: [
      {
        title: __('Customer'),
        value: 'customer',
        align: 'start',
        sortable: true,
      },
      {
        title: __('Date'),
        align: 'start',
        sortable: true,
        value: 'posting_date',
      },
      {
        title: __('Invoice'),
        value: 'name',
        align: 'start',
        sortable: true,
      },
      {
        title: __('Amount'),
        value: 'grand_total',
        align: 'end',
        sortable: false,
      },
    ],
    itemHeaders: [
      {
        title: '',
        value: 'select',
        align: 'center',
        sortable: false,
        width: '50px',
      },
      {
        title: __('Item'),
        value: 'item_name',
        align: 'start',
        sortable: true,
      },
      {
        title: __('Status'),
        value: 'status',
        align: 'center',
        sortable: false,
      },
      {
        title: __('Available'),
        value: 'remaining_qty',
        align: 'center',
        sortable: false,
      },
      {
        title: __('Return Qty'),
        value: 'return_qty',
        align: 'center',
        sortable: false,
      },
      {
        title: __('UOM'),
        value: 'uom',
        align: 'center',
        sortable: false,
      },
      {
        title: __('Rate'),
        value: 'rate',
        align: 'end',
        sortable: false,
      },
    ],
  }),
  watch: {
    selectedItems: {
      handler(newVal, oldVal) {
        // Initialize return quantities for newly selected items
        newVal.forEach((itemId) => {
          if (!(itemId in this.returnQuantities)) {
            const item = this.returnableItems.find(i => i.sales_invoice_item === itemId);
            if (item) {
              this.returnQuantities[itemId] = item.remaining_qty;
            }
          }
        });
        // Clean up deselected items
        Object.keys(this.returnQuantities).forEach((itemId) => {
          if (!newVal.includes(itemId)) {
            delete this.returnQuantities[itemId];
          }
        });
      },
      deep: true,
    },
  },
  computed: {
    pageCount() {
      return Math.ceil(this.dialog_data.length / this.itemsPerPage);
    },
    paginatedDialogData() {
      const start = (this.page - 1) * this.itemsPerPage;
      const end = start + this.itemsPerPage;
      return this.dialog_data.slice(start, end);
    },
    totalReturnAmount() {
      let total = 0;
      this.selectedItems.forEach((itemId) => {
        const item = this.returnableItems.find(i => i.sales_invoice_item === itemId);
        if (item) {
          const qty = this.returnQuantities[itemId] || 0;
          total += qty * item.rate;
        }
      });
      return total;
    },
  },
  methods: {
    close_dialog() {
      this.invoicesDialog = false;
    },
    search_invoices_by_enter(e) {
      if (e.keyCode === 13) {
        this.search_invoices();
      }
    },
    search_invoices() {
      const vm = this;
      vm.loading = true;
      vm.page = 1;
      frappe.call({
        method: 'pospire.pospire.api.posapp.search_invoices_for_return',
        args: {
          invoice_name: vm.invoice_name,
          company: vm.company,
        },
        async: false,
        callback: function (r) {
          vm.loading = false;
          if (r.message && Array.isArray(r.message)) {
            vm.dialog_data = r.message;
          } else {
            vm.dialog_data = [];
          }
        },
        error: function(r) {
          vm.loading = false;
          vm.dialog_data = [];
          frappe.show_alert({
            message: __('Failed to load invoices'),
            indicator: 'red'
          });
        }
      });
    },
    open_item_selection() {
      if (this.selected.length > 0) {
        const invoice = this.selected[0];
        this.selectedInvoice = invoice;

        // Use the return_status from the invoice data
        if (invoice.return_status && Array.isArray(invoice.return_status)) {
          this.returnableItems = invoice.return_status;
        } else {
          this.returnableItems = [];
        }

        // Reset selection state
        this.selectedItems = [];
        this.returnQuantities = {};

        // Auto-select all returnable items with their max qty
        this.returnableItems.forEach((item) => {
          if (item.can_return) {
            this.selectedItems.push(item.sales_invoice_item);
            this.returnQuantities[item.sales_invoice_item] = item.remaining_qty;
          }
        });

        this.itemSelectionDialog = true;
      }
    },
    close_item_selection() {
      this.itemSelectionDialog = false;
    },
    isItemSelected(itemId) {
      return this.selectedItems.includes(itemId);
    },
    validateReturnQty(item) {
      const itemId = item.sales_invoice_item;
      let qty = this.returnQuantities[itemId];

      if (qty < 1) {
        this.returnQuantities[itemId] = 1;
      } else if (qty > item.remaining_qty) {
        this.returnQuantities[itemId] = item.remaining_qty;
        frappe.show_alert({
          message: __('Cannot return more than {0} {1}', [item.remaining_qty, item.uom]),
          indicator: 'orange'
        });
      }
    },
    submit_return() {
      if (this.selectedItems.length === 0) {
        frappe.show_alert({
          message: __('Please select at least one item to return'),
          indicator: 'orange'
        });
        return;
      }

      const return_doc = this.selectedInvoice;
      const invoice_doc = {};
      const items = [];

      // Build items array from selected items with their return quantities
      this.selectedItems.forEach((itemId) => {
        const item = this.returnableItems.find(i => i.sales_invoice_item === itemId);
        if (item) {
          const return_qty = this.returnQuantities[itemId] || item.remaining_qty;

          // Find the original item from the invoice for complete data
          const original_item = return_doc.items.find(i => i.name === itemId);
          if (original_item) {
            const new_item = { ...original_item };

            // Set qty to negative for return (use the user-specified quantity)
            new_item.qty = -Math.abs(return_qty);
            new_item.stock_qty = -Math.abs(return_qty * (item.conversion_factor || 1));
            new_item.amount = -Math.abs(return_qty * item.rate);

            // Store reference to original invoice item
            new_item.sales_invoice_item = itemId;
            new_item.si_detail = itemId;

            // Store max returnable qty for validation in cart
            new_item.max_returnable_qty = item.remaining_qty;
            new_item.original_qty = item.original_qty;
            new_item.already_returned_qty = item.already_returned_qty;

            items.push(new_item);
          }
        }
      });

      if (items.length === 0) {
        frappe.show_alert({
          message: __('No valid items to return'),
          indicator: 'red'
        });
        return;
      }

      invoice_doc.items = items;
      invoice_doc.is_return = 1;
      invoice_doc.return_against = return_doc.name;
      invoice_doc.customer = return_doc.customer;

      const data = { invoice_doc, return_doc };
      this.eventBus.emit('load_return_invoice', data);

      // Close both dialogs
      this.itemSelectionDialog = false;
      this.invoicesDialog = false;
    },
    // Keep old method for backward compatibility (but won't be used)
    submit_dialog() {
      this.open_item_selection();
    },
  },
  created: function () {
    this.eventBus.on('open_returns', (data) => {
      this.invoicesDialog = true;
      this.company = data;
      this.invoice_name = '';
      this.dialog_data = [];
      this.selected = [];
      this.selectedItems = [];
      this.returnQuantities = {};
      this.selectedInvoice = null;
      this.returnableItems = [];
      this.search_invoices();
    });
  },
};
</script>

<style scoped>
.return-qty-input :deep(input) {
  text-align: center;
}
</style>
