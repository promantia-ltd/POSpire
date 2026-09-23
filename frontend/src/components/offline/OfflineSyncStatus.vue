<template>
  <!--
    Read-only cashier-side status tracker for offline-queued writes.

    Replaces the old `ReconciliationWorkspace` (which let cashiers Retry /
    Void / Edit-Retry directly from the device). The new model: failed
    entries are handed off to the server-side `POSpire Offline Sync
    Review` queue and resolved by Sales Manager / System Manager from
    Desk. Cashiers no longer have edit authority — they see the status
    of their entries and the recovery row name to give a manager when
    asking for help.

    Three sections:
      • Handoff pending — local rows that haven't reached the server
        review queue yet (transient offline window during handoff).
        Auto-heals on the next online cycle.
      • With manager — tombstones, awaiting manager retry / void.
      • In flight — queued / draining rows for visibility (no actions).
  -->
  <v-card class="offline-sync-status" elevation="1">
    <v-card-title class="offline-sync-status__title d-flex align-center">
      <span>{{ __('Offline Sync Status') }}</span>
      <v-spacer />
      <!--
        Manual sync controls (Phase 1f). Auto-drain is the default and
        runs whenever connectivity is up + nothing is paused. These
        controls are for: (a) the cashier wants to drain right now (e.g.
        before close-shift), (b) the cashier has a backlog and wants to
        keep taking orders without the drain noise, (c) the cashier
        suspects a stuck cycle and wants a manual kick.
      -->
      <v-btn
        v-if="!isPaused"
        size="small"
        variant="outlined"
        prepend-icon="mdi-pause"
        class="ml-2"
        :disabled="actingControl"
        @click="onPause"
      >
        {{ __('Pause') }}
      </v-btn>
      <v-btn
        v-else
        size="small"
        variant="flat"
        color="primary"
        prepend-icon="mdi-play"
        class="ml-2"
        :disabled="actingControl"
        @click="onResume"
      >
        {{ __('Resume') }}
      </v-btn>
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdi-cloud-sync-outline"
        class="ml-2"
        :disabled="actingControl"
        @click="onSyncNow"
      >
        {{ __('Sync now') }}
      </v-btn>
    </v-card-title>

    <v-card-subtitle>
      {{
        __(
          'Tracking your offline-queued transactions. Anything stuck with a manager: share the OSR ID with them.'
        )
      }}
    </v-card-subtitle>

    <!--
      Large-backlog warning. Surfaces when the queue depth crosses the
      threshold so the cashier knows that an unattended drain might run
      for a while. The Pause button in the header is the actionable
      response — this banner just makes the situation legible.
    -->
    <v-alert
      v-if="showBacklogWarning"
      type="warning"
      density="compact"
      variant="tonal"
      class="mx-4 mb-2"
    >
      {{
        __(
          '{0} entries queued. Drain may take several minutes. Tap Pause if you need to keep taking orders without the sync noise.',
          [queuedCount]
        )
      }}
    </v-alert>

    <v-alert
      v-if="isPaused"
      type="info"
      density="compact"
      variant="tonal"
      class="mx-4 mb-2"
    >
      {{
        __(
          'Sync paused. Outgoing transactions are still queued safely; tap Resume to drain.'
        )
      }}
    </v-alert>

    <v-tabs v-model="activeTab" density="compact" color="primary">
      <v-tab value="handed-off">
        {{ __('With manager') }}
        <v-chip
          v-if="handedOffCount > 0"
          size="x-small"
          color="primary"
          variant="tonal"
          class="ml-2"
        >
          {{ handedOffCount }}
        </v-chip>
      </v-tab>
      <v-tab value="needs-review">
        {{ __('Handoff pending') }}
        <v-chip
          v-if="needsReviewCount > 0"
          size="x-small"
          color="warning"
          variant="tonal"
          class="ml-2"
        >
          {{ needsReviewCount }}
        </v-chip>
      </v-tab>
      <v-tab value="pending">
        {{ __('In flight') }}
        <v-chip
          v-if="pendingEntries.length > 0"
          size="x-small"
          variant="tonal"
          class="ml-2"
        >
          {{ pendingEntries.length }}
        </v-chip>
      </v-tab>
    </v-tabs>

    <v-divider />

    <v-window v-model="activeTab">
      <!-- ============ With manager (tombstones) ============ -->
      <v-window-item value="handed-off">
        <div
          v-if="handedOffEntries.length === 0"
          class="offline-sync-status__empty"
        >
          <v-icon icon="mdi-check-circle-outline" size="48" color="success" />
          <div>{{ __('No transactions are with a manager.') }}</div>
        </div>
        <v-list v-else lines="three" class="offline-sync-status__list">
          <v-list-item
            v-for="entry in handedOffEntries"
            :key="entry.offline_id"
            class="offline-sync-status__row"
          >
            <template #prepend>
              <v-icon
                :icon="iconForCategory(entry.last_error_category)"
                :color="colorForCategory(entry.last_error_category)"
                size="large"
              />
            </template>
            <v-list-item-title>
              <span class="offline-sync-status__mono">
                {{ entry.recovery_entry_name || 'OSR-?' }}
              </span>
              <v-chip size="x-small" variant="tonal" class="ml-2">
                {{ entry.type }}
              </v-chip>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="colorForCategory(entry.last_error_category)"
                class="ml-2"
              >
                {{ entry.last_error_category || 'unknown' }}
              </v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>
              <span class="offline-sync-status__mono">
                OFFLINE-{{ shortId(entry.offline_id) }}
              </span>
              ·
              {{
                __('handed off {0}', [relTime(entry.enqueued_at)])
              }}
            </v-list-item-subtitle>
            <template #append>
              <v-tooltip
                location="left"
                :text="
                  __(
                    'Copy the OSR ID and share it with a manager so they can locate this entry in the Desk recovery queue.'
                  )
                "
              >
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-content-copy"
                    size="small"
                    variant="text"
                    @click="copyId(entry.recovery_entry_name)"
                  />
                </template>
              </v-tooltip>
            </template>
          </v-list-item>
        </v-list>
      </v-window-item>

      <!-- ============ Handoff pending (local-only) ============ -->
      <v-window-item value="needs-review">
        <div
          v-if="needsReviewEntries.length === 0"
          class="offline-sync-status__empty"
        >
          <v-icon icon="mdi-check-circle-outline" size="48" color="success" />
          <div>
            {{ __('All failed entries have been handed off to the manager queue.') }}
          </div>
        </div>
        <v-list v-else lines="three" class="offline-sync-status__list">
          <v-list-item
            v-for="entry in needsReviewEntries"
            :key="entry.offline_id"
            class="offline-sync-status__row"
          >
            <template #prepend>
              <v-icon
                :icon="iconForCategory(entry.last_error_category)"
                :color="colorForCategory(entry.last_error_category)"
                size="large"
              />
            </template>
            <v-list-item-title>
              <span class="offline-sync-status__mono">
                OFFLINE-{{ shortId(entry.offline_id) }}
              </span>
              <v-chip size="x-small" variant="tonal" class="ml-2">
                {{ entry.type }}
              </v-chip>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="colorForCategory(entry.last_error_category)"
                class="ml-2"
              >
                {{ entry.last_error_category || 'unknown' }}
              </v-chip>
              <v-chip
                v-if="entry.attempt_count > 0"
                size="x-small"
                variant="tonal"
                color="grey-darken-1"
                class="ml-2"
              >
                {{ __('attempts: {0}', [entry.attempt_count]) }}
              </v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>
              {{ __('Awaiting handoff. Will retry on next online cycle.') }}
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-window-item>

      <!-- ============ In flight ============ -->
      <v-window-item value="pending">
        <div
          v-if="pendingEntries.length === 0"
          class="offline-sync-status__empty"
        >
          <v-icon icon="mdi-cloud-check-outline" size="48" color="success" />
          <div>{{ __('Nothing in flight.') }}</div>
        </div>
        <v-list v-else lines="two" class="offline-sync-status__list">
          <v-list-item
            v-for="entry in pendingEntries"
            :key="entry.offline_id"
            class="offline-sync-status__row"
          >
            <template #prepend>
              <v-icon
                :icon="
                  entry.status === 'in_flight'
                    ? 'mdi-cloud-sync-outline'
                    : 'mdi-cloud-upload-outline'
                "
                :color="entry.status === 'in_flight' ? 'primary' : 'grey'"
                size="large"
              />
            </template>
            <v-list-item-title>
              <span class="offline-sync-status__mono">
                OFFLINE-{{ shortId(entry.offline_id) }}
              </span>
              <v-chip size="x-small" variant="tonal" class="ml-2">
                {{ entry.type }}
              </v-chip>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="entry.status === 'in_flight' ? 'primary' : 'default'"
                class="ml-2"
              >
                {{ entry.status }}
              </v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>
              {{ relTime(entry.enqueued_at) }}
              <span v-if="entry.blocked_reason" class="ml-2">
                · {{ __('blocked: {0}', [entry.blocked_reason]) }}
              </span>
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-window-item>
    </v-window>
  </v-card>
</template>

<script>
/**
 * OfflineSyncStatus.vue
 *
 * Read-only replacement for ReconciliationWorkspace. No retry/void/edit
 * actions — recovery happens server-side in Desk under the manager's
 * authority. The component subscribes to the outbox Pinia store for
 * three derived lists and renders a tabbed view.
 *
 * Single non-trivial action: copy the OSR-... recovery row name to
 * clipboard so the cashier can paste it into a chat / email when asking
 * a manager to look at a stuck entry.
 */
import { computed, defineComponent, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useOutboxStore } from "@/stores/outbox";
import {
  scheduler as syncScheduler,
  LARGE_BACKLOG_THRESHOLD,
} from "@/offline/sync";

const ROW_HEIGHT_PX = 88;

export default defineComponent({
  name: "OfflineSyncStatus",
  setup() {
    const outbox = useOutboxStore();
    const {
      needsReviewEntries,
      needsReviewCount,
      handedOffEntries,
      handedOffCount,
      pendingEntries,
      pendingCount,
      inFlightCount,
      queuedCount,
      schedulerPhase,
    } = storeToRefs(outbox);

    /**
     * Cashier-pause flag. Sourced from the scheduler's `isPaused()` —
     * not from the store's `schedulerPhase` because the latter conflates
     * user-paused with non-leader-tab. We seed from the scheduler at
     * mount and keep in sync with `schedulerPhase` so a pause issued
     * from a different tab updates this one.
     */
    const isPaused = ref(syncScheduler.isPaused());

    // schedulerPhase ranges over { idle, draining, paused } and is
    // broadcast across tabs. When we see "paused" here AND the
    // scheduler reports paused, we believe it; "idle" / "draining"
    // means another tab resumed and we should clear our cached flag.
    // Re-deriving on every change keeps the button label in sync
    // without needing a per-tab BroadcastChannel listener of our own.
    function syncPausedFromScheduler() {
      isPaused.value = syncScheduler.isPaused();
    }

    // `actingControl` debounces double-clicks on the control buttons.
    // pauseSync / resumeSync write to Dexie, which is fast but not
    // free; without this guard a fast tap can produce two redundant
    // writes + two broadcast publications.
    const actingControl = ref(false);

    async function onPause() {
      if (actingControl.value) return;
      actingControl.value = true;
      try {
        await syncScheduler.pauseSync();
        syncPausedFromScheduler();
      } finally {
        actingControl.value = false;
      }
    }

    async function onResume() {
      if (actingControl.value) return;
      actingControl.value = true;
      try {
        await syncScheduler.resumeSync();
        syncPausedFromScheduler();
      } finally {
        actingControl.value = false;
      }
    }

    function onSyncNow() {
      // Behaviour matches the scheduler's `syncNow` JSDoc:
      //   - When unpaused: kicks the drain loop awake. Useful for the
      //     just-reconnected case where the loop is on its idle 30s
      //     wake — Sync Now bypasses that wait.
      //   - When paused: arms a one-shot bypass flag, runs exactly
      //     ONE drain cycle, then re-honours paused. Lets the cashier
      //     drain a single oldest entry (e.g. before close-shift)
      //     without unsetting Pause.
      // For full drain while paused, the cashier should hit Resume.
      syncScheduler.syncNow();
    }

    const showBacklogWarning = computed(
      () => queuedCount.value >= LARGE_BACKLOG_THRESHOLD,
    );

    // Pick the most useful initial section while the liveQuery counts
    // settle. After the cashier clicks a tab, keep their selection stable.
    const selectedTab = ref("handed-off");
    const tabManuallySelected = ref(false);
    const preferredTab = computed(() => {
      if (handedOffCount.value > 0) return "handed-off";
      if (needsReviewCount.value > 0) return "needs-review";
      if (pendingEntries.value.length > 0) return "pending";
      return "handed-off";
    });

    watch(
      preferredTab,
      (tab) => {
        if (!tabManuallySelected.value) {
          selectedTab.value = tab;
        }
      },
      { immediate: true },
    );

    const activeTab = computed({
      get() {
        return selectedTab.value;
      },
      set(tab) {
        if (tab) {
          selectedTab.value = tab;
          tabManuallySelected.value = true;
        }
      },
    });

    function shortId(id) {
      if (!id) return "?";
      return String(id).slice(0, 8);
    }

    function iconForCategory(cat) {
      switch (cat) {
        case "permission_error":
          return "mdi-shield-alert-outline";
        case "accounting_period_closed":
          return "mdi-calendar-lock-outline";
        case "stock_shortage":
          return "mdi-package-variant-closed-remove";
        case "batch_or_serial_conflict":
          return "mdi-tag-multiple-outline";
        case "parent_not_ready":
        case "siblings_not_ready":
          return "mdi-link-variant-off";
        case "customer_missing":
          return "mdi-account-question-outline";
        case "validation_error":
          return "mdi-alert-circle-outline";
        case "schema_mismatch":
          return "mdi-database-alert-outline";
        default:
          return "mdi-help-circle-outline";
      }
    }

    function colorForCategory(cat) {
      switch (cat) {
        case "permission_error":
        case "accounting_period_closed":
        case "schema_mismatch":
          return "error";
        case "stock_shortage":
        case "batch_or_serial_conflict":
        case "parent_not_ready":
        case "siblings_not_ready":
        case "customer_missing":
          return "warning";
        default:
          return "grey-darken-1";
      }
    }

    function relTime(ts) {
      if (!ts) return "—";
      const diffMs = Date.now() - ts;
      const min = Math.floor(diffMs / 60_000);
      if (min < 1) return __("just now");
      if (min < 60) return __("{0} min ago", [min]);
      const hr = Math.floor(min / 60);
      if (hr < 24) return __("{0} hr ago", [hr]);
      const days = Math.floor(hr / 24);
      return __("{0} d ago", [days]);
    }

    async function copyId(value) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Clipboard API unavailable / permission denied — fall back to
        // the legacy execCommand path. Failures here are silent; the
        // user can long-press to copy manually.
        try {
          const ta = document.createElement("textarea");
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {
          /* ignore */
        }
      }
    }

    return {
      ROW_HEIGHT_PX,
      activeTab,
      needsReviewEntries,
      needsReviewCount,
      handedOffEntries,
      handedOffCount,
      pendingEntries,
      pendingCount,
      inFlightCount,
      queuedCount,
      schedulerPhase,
      isPaused,
      actingControl,
      showBacklogWarning,
      onPause,
      onResume,
      onSyncNow,
      shortId,
      iconForCategory,
      colorForCategory,
      relTime,
      copyId,
    };
  },
});
</script>

<style scoped>
.offline-sync-status {
  border-radius: 12px;
}
.offline-sync-status__title {
  padding-bottom: 4px;
}
.offline-sync-status__list {
  background: transparent;
}
.offline-sync-status__row {
  border-bottom: 1px solid var(--pospire-border-subtle);
}
.offline-sync-status__empty {
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--pospire-text-muted);
  font-size: 0.95rem;
}
.offline-sync-status__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  font-weight: 600;
}
</style>
