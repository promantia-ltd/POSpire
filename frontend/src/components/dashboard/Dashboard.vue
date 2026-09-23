<template>
  <v-container fluid class="dashboard-page">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <div v-if="loading" class="dashboard-page__state">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <WidgetRenderer v-else :layout="layout" :data="widgetData" />
  </v-container>
</template>

<script>
import { computed, onMounted, ref } from "vue";
import { call, unwrapStale } from "@/utils/call";
import WidgetRenderer from "@/components/widgets/WidgetRenderer.vue";

const CARD_KEYS = [
	"total_net_sales",
	"bill_count",
	"loyalty_redemptions",
	"total_returns",
	"held_invoices",
	"cancelled_invoices",
];

// Client-side fallback that mirrors the server default in
// dashboard.py::DEFAULT_DASHBOARD_LAYOUT. Used only when the layout endpoint
// is unreachable (offline first load or server error) so the dashboard still
// renders instead of going blank.
const DEFAULT_LAYOUT = [
	...CARD_KEYS.map((key) => ({ widget_type: "number-card", data_key: key, column_span: 4 })),
	{ widget_type: "chart", data_key: "hourly_sales", variant: "line", column_span: 6 },
	{ widget_type: "chart", data_key: "payment_distribution", variant: "donut", column_span: 6 },
	{ widget_type: "table", data_key: "top_products", column_span: 6 },
	{ widget_type: "table", data_key: "top_categories", column_span: 6 },
	{ widget_type: "table", data_key: "shift_summary", column_span: 6 },
];

const PREVIOUS_ZERO_LABELS = {
	total_net_sales: "Previous Shift had no Net Sales",
	bill_count: "Previous Shift had no Bills",
	loyalty_redemptions: "Previous Shift had no Loyalty Redemptions",
	total_returns: "Previous Shift had no Returns",
	held_invoices: "Previous Shift had no Held Invoices",
	cancelled_invoices: "Previous Shift had no Cancelled Invoices",
};

export default {
	name: "Dashboard",
	components: { WidgetRenderer },
	setup() {
		const loading = ref(false);
		const error = ref("");
		const layout = ref([]);
		const shift = ref({});

		const widgetData = computed(() => {
			const result = shift.value || {};
			const cards = result.cards || {};
			const comparisons = result.card_comparisons || {};
			const bound = {};

			for (const key of CARD_KEYS) {
				const trend = comparisons[key] || { status: "no_previous", percentage: null };
				bound[key] = {
					value: cards[key] ?? 0,
					trend: {
						...trend,
						label: trend.status === "previous_zero" ? __(PREVIOUS_ZERO_LABELS[key]) : "",
					},
				};
			}

			bound.hourly_sales = result.hourly_sales || { labels: [], values: [] };
			bound.payment_distribution = result.payment_distribution || [];
			bound.top_products = result.top_products || [];
			bound.top_categories = result.top_categories || [];
			bound.shift_summary = result.shift_summary || {};

			return bound;
		});

		async function fetchLayout() {
			try {
				const response = await call({
					method: "pospire.pospire.api.dashboard.get_dashboard_layout",
					intent: "read",
					cacheKey: "dashboard.layout",
				});
				const result = unwrapStale(response);
				layout.value = Array.isArray(result) && result.length ? result : DEFAULT_LAYOUT;
			} catch (err) {
				if (err?.name !== "OfflineReadUnavailable") {
					console.error("[Dashboard] failed to load layout", err);
				}
				layout.value = DEFAULT_LAYOUT;
			}
		}

		async function fetchShift() {
			try {
				const response = await call({
					method: "pospire.pospire.api.dashboard.get_shift_dashboard",
					intent: "read",
					cacheKey: "dashboard.shift",
				});
				shift.value = unwrapStale(response) || {};
			} catch (err) {
				if (err?.name !== "OfflineReadUnavailable") {
					console.error("[Dashboard] failed to load shift dashboard", err);
				}
				shift.value = {};
				error.value =
					err?.name === "OfflineReadUnavailable" ? "" : err?.message || __("Could not load dashboard.");
			}
		}

		async function fetchAll() {
			loading.value = true;
			error.value = "";
			await Promise.all([fetchLayout(), fetchShift()]);
			loading.value = false;
		}

		onMounted(fetchAll);

		return { loading, error, layout, widgetData };
	},
};
</script>

<style scoped>
.dashboard-page {
	min-height: 100%;
	padding: 16px 18px 32px;
	background: var(--pospire-app-bg);
	color: var(--pospire-text-main);
	transition: background-color 0.2s ease, color 0.2s ease;
}
.dashboard-page__state {
	min-height: 240px;
	display: flex;
	align-items: center;
	justify-content: center;
}
</style>
