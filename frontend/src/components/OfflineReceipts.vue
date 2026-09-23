<template>
  <v-dialog :model-value="modelValue" max-width="640px" @update:model-value="$emit('update:modelValue', $event)">
    <v-card class="offline-receipts" elevation="8">
      <v-card-title class="d-flex align-center">
        <span>{{ __('Offline receipts') }}</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('update:modelValue', false)" />
      </v-card-title>
      <v-card-subtitle>
        {{ __('Recent sales made on this till, including ones still waiting to sync.') }}
      </v-card-subtitle>

      <v-card-text>
        <div v-if="loading" class="text-center py-6">
          <v-progress-circular indeterminate color="primary" />
        </div>
        <div v-else-if="!rows.length" class="text-center text-grey py-6">
          {{ __('No offline sales recorded on this till.') }}
        </div>
        <v-list v-else density="comfortable">
          <v-list-item
            v-for="row in rows"
            :key="row.offline_id"
            :title="row.displayName"
            :subtitle="row.subtitle"
          >
            <template v-slot:append>
              <v-chip
                size="small"
                :color="row.status === 'synced' ? 'success' : 'warning'"
                variant="tonal"
                class="mr-2"
              >
                {{ row.status === 'synced' ? __('Synced') : __('Pending') }}
              </v-chip>
              <v-btn
                size="small"
                variant="outlined"
                :loading="reprintingId === row.offline_id"
                @click="reprint(row)"
              >
                {{ __('Reprint') }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script>
import hardwareUtils from "@/utils/hardwareUtils";
import { listInvoiceRowsAcrossStatuses } from "@/offline/outbox";
import { provisionalNameFor } from "@/offline/outbox";
import connectivity from "@/offline/connectivity";
import { toast } from "vue3-toastify";

// All non-voided statuses an invoice row can carry — a voided sale was
// cancelled and has nothing to reprint.
const VISIBLE_STATUSES = [
  "enqueued",
  "in_flight",
  "retry_pending",
  "needs_review",
  "handed_off",
  "synced",
];

export default {
  name: "OfflineReceipts",
  mixins: [hardwareUtils],
  props: {
    modelValue: { type: Boolean, default: false },
    posProfile: { type: Object, default: () => ({}) },
  },
  emits: ["update:modelValue"],
  data() {
    return {
      loading: false,
      rows: [],
      reprintingId: null,
    };
  },
  computed: {
    // hardwareUtils.js::printReceipt reads `this.pos_profile` — expose the
    // prop under that name so the mixin works unchanged in this component.
    pos_profile() {
      return this.posProfile;
    },
  },
  watch: {
    modelValue(open) {
      if (open) this.load();
    },
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        const { rows, corruptCount } = await listInvoiceRowsAcrossStatuses(VISIBLE_STATUSES);
        if (corruptCount) {
          console.warn(`[OfflineReceipts] ${corruptCount} row(s) could not be read and were skipped`);
        }
        this.rows = rows
          .sort((a, b) => b.enqueued_at - a.enqueued_at)
          .map((row) => {
            const provisional = provisionalNameFor("invoice", row.offline_id);
            const synced = row.status === "synced" && row.server_doc_name;
            const when = row.enqueued_at ? new Date(row.enqueued_at).toLocaleString() : "";
            return {
              offline_id: row.offline_id,
              status: synced ? "synced" : "pending",
              server_doc_name: row.server_doc_name,
              displayName: synced ? row.server_doc_name : provisional,
              subtitle: when,
            };
          });
      } catch (err) {
        console.error("[OfflineReceipts] failed to load rows", err);
        toast.error(__("Could not load offline receipts."));
      } finally {
        this.loading = false;
      }
    },
    async reprint(row) {
      this.reprintingId = row.offline_id;
      try {
        if (row.status === "synced" && connectivity.isOnline()) {
          await this.printReceipt({ name: row.server_doc_name });
          return;
        }
        const { getOutboxEntry } = await import("@/offline/repos/outbox");
        const entry = await getOutboxEntry(row.offline_id);
        if (!entry) {
          toast.error(
            __("This sale is no longer stored on this till. Print it from the Sales Invoice list."),
          );
          return;
        }
        if (entry.server_doc_name && connectivity.isOnline()) {
          await this.printReceipt({ name: entry.server_doc_name });
          return;
        }
        const invoice = JSON.parse(entry.payload.data);
        await this.printReceipt({ invoice, offlineId: row.offline_id });
      } catch (err) {
        console.error("[OfflineReceipts] reprint failed", err);
        toast.error(__("Could not print the receipt. Please try again."));
      } finally {
        this.reprintingId = null;
      }
    },
  },
};
</script>
