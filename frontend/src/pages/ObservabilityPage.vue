<template>
  <!--
    B6 — Central observability dashboard.

    Polls `pospire.pospire.api.offline.get_observability_summary` every 30s
    and renders fleet-wide totals + per-outlet rollup + per-device list +
    7-day trend + build-hash distribution. Permissioned server-side
    (System Manager + Sales Manager).

    Charts use a thin SVG sparkline (no external chart dep) — the dashboard
    has to load fast on a manager's tablet, and Chart.js / d3 would balloon
    the bundle for a single screen.
  -->
  <v-container fluid class="observability-page">
    <v-row align="center" class="observability-page__heading">
      <v-col>
        <h2 class="observability-page__title">
          <v-icon icon="mdi-cloud-sync-outline" class="mr-2" />
          {{ __('Offline observability') }}
        </h2>
        <div class="observability-page__sub" v-if="generatedAt">
          {{ __('Updated') }} {{ formatTime(generatedAt) }} ·
          {{ __('refreshes every') }} {{ refreshSeconds }}s
        </div>
      </v-col>
      <v-col cols="auto">
        <v-btn
          variant="tonal"
          prepend-icon="mdi-refresh"
          :loading="loading"
          @click="fetchSummary"
        >
          {{ __('Refresh') }}
        </v-btn>
      </v-col>
    </v-row>

    <!-- Fleet totals -->
    <v-row dense>
      <v-col v-for="kpi in kpis" :key="kpi.label" cols="6" md="2">
        <v-card variant="tonal" :color="kpi.color || 'grey-lighten-3'">
          <v-card-text class="observability-page__kpi">
            <div class="observability-page__kpi-value">{{ kpi.value }}</div>
            <div class="observability-page__kpi-label">{{ kpi.label }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Trend sparkline -->
    <v-row v-if="trend.length" dense>
      <v-col cols="12">
        <v-card variant="outlined">
          <v-card-title class="observability-page__panel-title">
            {{ __('Needs-review trend (last 7 days)') }}
          </v-card-title>
          <v-card-text>
            <svg
              :viewBox="`0 0 ${trendWidth} ${trendHeight}`"
              class="observability-page__sparkline"
              role="img"
              :aria-label="__('Needs-review trend')"
            >
              <polyline
                :points="trendPolyline"
                fill="none"
                stroke="#c62828"
                stroke-width="2"
              />
              <g v-for="(pt, i) in trendPoints" :key="i">
                <circle :cx="pt.x" :cy="pt.y" r="3" fill="#c62828" />
                <text
                  :x="pt.x"
                  :y="pt.y - 8"
                  text-anchor="middle"
                  font-size="11"
                  fill="#475569"
                >
                  {{ pt.label }}
                </text>
              </g>
              <g v-for="(pt, i) in trendPoints" :key="`x-${i}`">
                <text
                  :x="pt.x"
                  :y="trendHeight - 4"
                  text-anchor="middle"
                  font-size="10"
                  fill="#94a3b8"
                >
                  {{ pt.day }}
                </text>
              </g>
            </svg>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Outlet rollup -->
    <v-row dense>
      <v-col cols="12" md="6">
        <v-card variant="outlined">
          <v-card-title class="observability-page__panel-title">
            {{ __('Outlets') }}
          </v-card-title>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ __('Outlet') }}</th>
                <th class="text-right">{{ __('Devices') }}</th>
                <th class="text-right">{{ __('Online') }}</th>
                <th class="text-right">{{ __('Max queue') }}</th>
                <th class="text-right">{{ __('Needs review') }}</th>
                <th class="text-right">{{ __('Oldest min') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="outlet in outlets" :key="outlet.outlet">
                <td>{{ outlet.outlet }}</td>
                <td class="text-right">{{ outlet.devices }}</td>
                <td class="text-right">
                  <v-chip
                    size="x-small"
                    :color="outlet.online_devices === outlet.devices ? 'success' : 'warning'"
                    variant="tonal"
                  >
                    {{ outlet.online_devices }}/{{ outlet.devices }}
                  </v-chip>
                </td>
                <td class="text-right">{{ outlet.queue_depth_max }}</td>
                <td class="text-right">
                  <strong v-if="outlet.needs_review_sum > 0" class="text-error">
                    {{ outlet.needs_review_sum }}
                  </strong>
                  <span v-else>0</span>
                </td>
                <td class="text-right">
                  <span v-if="outlet.oldest_minutes_max > 30" class="text-warning">
                    {{ outlet.oldest_minutes_max }}
                  </span>
                  <span v-else>{{ outlet.oldest_minutes_max }}</span>
                </td>
              </tr>
              <tr v-if="!outlets.length">
                <td colspan="6" class="observability-page__empty">
                  {{ __('No beacons yet. Devices report every 5 minutes.') }}
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </v-col>

      <!-- Build hash distribution -->
      <v-col cols="12" md="6">
        <v-card variant="outlined">
          <v-card-title class="observability-page__panel-title">
            {{ __('Client builds (last hour)') }}
          </v-card-title>
          <v-card-text>
            <div v-if="buildHashes.length === 0" class="observability-page__empty">
              {{ __('No builds reported yet.') }}
            </div>
            <v-list v-else density="compact">
              <v-list-item v-for="b in buildHashes" :key="b.sw_build_hash">
                <v-list-item-title>
                  <code class="observability-page__hash">{{ b.sw_build_hash }}</code>
                </v-list-item-title>
                <template #append>
                  <v-chip size="x-small" variant="tonal">
                    {{ b.devices }} {{ b.devices === 1 ? __('device') : __('devices') }}
                  </v-chip>
                </template>
              </v-list-item>
            </v-list>
            <p class="observability-page__hint" v-if="buildHashes.length > 1">
              {{ __('Multiple builds in flight. Likely a staged rollout. Three or more usually means a device fleet stuck on stale code.') }}
            </p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Device list -->
    <v-row dense>
      <v-col cols="12">
        <v-card variant="outlined">
          <v-card-title class="observability-page__panel-title">
            {{ __('Devices') }}
            <v-spacer />
            <v-text-field
              v-model="deviceFilter"
              :label="__('Filter')"
              density="compact"
              variant="outlined"
              hide-details
              clearable
              max-width="240"
              prepend-inner-icon="mdi-magnify"
            />
          </v-card-title>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ __('Device') }}</th>
                <th>{{ __('Outlet') }}</th>
                <th>{{ __('User') }}</th>
                <th>{{ __('Last beacon') }}</th>
                <th class="text-right">{{ __('Queue') }}</th>
                <th class="text-right">{{ __('Needs review') }}</th>
                <th class="text-right">{{ __('Oldest min') }}</th>
                <th>{{ __('State') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="dev in filteredDevices" :key="dev.device_id">
                <td>
                  <code class="observability-page__hash">{{ shortDevice(dev.device_id) }}</code>
                </td>
                <td>{{ dev.outlet || '—' }}</td>
                <td>{{ dev.user || '—' }}</td>
                <td>
                  <span :title="dev.beacon_at">
                    {{ formatRelative(dev.beacon_at) }}
                  </span>
                </td>
                <td class="text-right">{{ dev.queue_depth }}</td>
                <td class="text-right">
                  <strong v-if="dev.needs_review > 0" class="text-error">
                    {{ dev.needs_review }}
                  </strong>
                  <span v-else>0</span>
                </td>
                <td class="text-right">
                  <span v-if="(dev.oldest_minutes ?? 0) > 30" class="text-warning">
                    {{ dev.oldest_minutes }}
                  </span>
                  <span v-else>{{ dev.oldest_minutes ?? '—' }}</span>
                </td>
                <td>
                  <v-chip
                    size="x-small"
                    :color="stateColorFor(dev)"
                    variant="tonal"
                  >
                    {{ stateLabelFor(dev) }}
                  </v-chip>
                </td>
              </tr>
              <tr v-if="!filteredDevices.length">
                <td colspan="8" class="observability-page__empty">
                  {{ __('No devices match.') }}
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script>
import { computed, defineComponent, onMounted, onBeforeUnmount, ref } from "vue";
import { call } from "@/utils/call";
import { toast } from "vue3-toastify";

export default defineComponent({
  name: "ObservabilityPage",
  setup() {
    const loading = ref(false);
    const refreshSeconds = 30;

    const generatedAt = ref(null);
    const totals = ref({
      devices: 0,
      online_devices: 0,
      stale_devices: 0,
      queue_depth_total: 0,
      needs_review_total: 0,
      max_queue_depth: 0,
    });
    const outlets = ref([]);
    const devices = ref([]);
    const trend = ref([]);
    const buildHashes = ref([]);
    const deviceFilter = ref("");

    let refreshTimer = null;

    const kpis = computed(() => [
      {
        label: __("Devices"),
        value: totals.value.devices,
        color: totals.value.devices ? "primary" : "grey-lighten-3",
      },
      {
        label: __("Online now"),
        value: totals.value.online_devices,
        color:
          totals.value.online_devices === totals.value.devices && totals.value.devices > 0
            ? "success"
            : "warning",
      },
      {
        label: __("Stale"),
        value: totals.value.stale_devices,
        color: totals.value.stale_devices > 0 ? "warning" : "grey-lighten-3",
      },
      {
        label: __("Queue total"),
        value: totals.value.queue_depth_total,
        color: totals.value.queue_depth_total > 50 ? "warning" : "grey-lighten-3",
      },
      {
        label: __("Needs review"),
        value: totals.value.needs_review_total,
        color: totals.value.needs_review_total > 0 ? "error" : "grey-lighten-3",
      },
      {
        label: __("Max queue"),
        value: totals.value.max_queue_depth,
        color: totals.value.max_queue_depth > 50 ? "warning" : "grey-lighten-3",
      },
    ]);

    const filteredDevices = computed(() => {
      const q = deviceFilter.value?.trim().toLowerCase();
      if (!q) return devices.value;
      return devices.value.filter((d) => {
        const blob = `${d.device_id} ${d.outlet || ""} ${d.user || ""}`.toLowerCase();
        return blob.includes(q);
      });
    });

    // ---- Sparkline ----------------------------------------------------
    const trendWidth = 600;
    const trendHeight = 100;

    const trendPoints = computed(() => {
      if (!trend.value.length) return [];
      const max = trend.value.reduce(
        (m, t) => Math.max(m, Number(t.needs_review_sum) || 0),
        1,
      );
      const xStep = trendWidth / Math.max(1, trend.value.length - 1);
      return trend.value.map((t, i) => {
        const value = Number(t.needs_review_sum) || 0;
        const x = i * xStep;
        const y = trendHeight - 18 - (value / max) * (trendHeight - 30);
        const day = String(t.day).slice(5); // MM-DD
        return { x, y, value, label: value, day };
      });
    });

    const trendPolyline = computed(() =>
      trendPoints.value.map((p) => `${p.x},${p.y}`).join(" "),
    );

    // ---- Helpers ------------------------------------------------------
    function formatTime(iso) {
      try {
        return new Date(iso).toLocaleTimeString();
      } catch {
        return iso;
      }
    }

    function formatRelative(iso) {
      try {
        const ms = Date.now() - new Date(iso).getTime();
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
      } catch {
        return iso;
      }
    }

    function shortDevice(id) {
      return id ? id.slice(0, 8) : "—";
    }

    function stateColorFor(dev) {
      if (dev.stale) return "grey-darken-1";
      if (dev.needs_review > 0) return "error";
      if ((dev.oldest_minutes ?? 0) > 30) return "warning";
      if (cint(dev.online)) return "success";
      return "warning";
    }

    function stateLabelFor(dev) {
      if (dev.stale) return __("stale");
      if (dev.needs_review > 0) return __("needs review");
      if ((dev.oldest_minutes ?? 0) > 30) return __("queue aging");
      if (cint(dev.online)) return __("online");
      return __("offline");
    }

    function cint(v) {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    }

    // ---- Fetch --------------------------------------------------------
    async function fetchSummary() {
      if (loading.value) return;
      loading.value = true;
      try {
        const r = await call("pospire.pospire.api.offline.get_observability_summary");
        if (r) {
          generatedAt.value = r.generated_at;
          totals.value = r.totals;
          outlets.value = r.outlets || [];
          devices.value = r.devices || [];
          trend.value = r.trend_7d || [];
          buildHashes.value = r.build_hashes || [];
        }
      } catch (err) {
        console.error("[ObservabilityPage] fetch failed", err);
        toast.error(
          err && err.message
            ? err.message
            : __("Could not load observability data"),
        );
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      fetchSummary();
      refreshTimer = setInterval(fetchSummary, refreshSeconds * 1000);
    });

    onBeforeUnmount(() => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    });

    return {
      loading,
      refreshSeconds,
      generatedAt,
      totals,
      outlets,
      devices,
      trend,
      buildHashes,
      deviceFilter,
      kpis,
      filteredDevices,
      trendWidth,
      trendHeight,
      trendPoints,
      trendPolyline,
      formatTime,
      formatRelative,
      shortDevice,
      stateColorFor,
      stateLabelFor,
      fetchSummary,
    };
  },
});
</script>

<style scoped>
.observability-page {
  padding: 16px;
  max-width: 1400px;
}

.observability-page__heading {
  margin-bottom: 8px;
}

.observability-page__title {
  display: flex;
  align-items: center;
  font-weight: 600;
  font-size: 1.25rem;
  margin: 0;
}

.observability-page__sub {
  font-size: 0.85em;
  color: #64748b;
}

.observability-page__kpi {
  text-align: center;
  padding: 12px 8px;
}

.observability-page__kpi-value {
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1.1;
}

.observability-page__kpi-label {
  font-size: 0.78em;
  color: #475569;
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.observability-page__panel-title {
  font-weight: 600;
  font-size: 0.95em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.observability-page__sparkline {
  width: 100%;
  height: auto;
}

.observability-page__hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: #f1f5f9;
  padding: 1px 6px;
  border-radius: 3px;
}

.observability-page__hint {
  font-size: 0.85em;
  color: #64748b;
  margin-top: 8px;
}

.observability-page__empty {
  text-align: center;
  color: #94a3b8;
  font-style: italic;
  padding: 12px;
}
</style>
