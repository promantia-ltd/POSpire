<template>
	<div class="widget-chart" :class="{ 'widget-chart--html-legend': usesHtmlLegend }">
		<div v-if="!hasData" class="widget-chart__empty">{{ emptyText || __("No data available") }}</div>
		<component
			:is="chartComponent"
			v-else
			:key="chartRenderKey"
			class="widget-chart__canvas"
			:data="chartData"
			:options="chartOptions"
			:plugins="chartPlugins"
		/>
		<div v-if="hasData && usesHtmlLegend" class="widget-chart__legend">
			<div
				v-for="item in htmlLegendItems"
				:key="item.index"
				class="widget-chart__legend-item"
				:title="item.label"
			>
				<span class="widget-chart__legend-dot" :style="{ backgroundColor: item.color }"></span>
				<span class="widget-chart__legend-label">{{ item.label }}</span>
				<span class="widget-chart__legend-value">{{ item.value }}</span>
			</div>
		</div>
	</div>
</template>

<script>
import { computed, nextTick, ref, watch } from "vue";
import { useTheme } from "vuetify";
import { Line, Bar, Doughnut } from "vue-chartjs";
import {
	Chart as ChartJS,
	Title,
	Tooltip,
	Legend,
	LineElement,
	BarElement,
	PointElement,
	CategoryScale,
	LinearScale,
	ArcElement,
	Filler,
} from "chart.js";
import { PRIMARY, CATEGORICAL } from "./palette";

ChartJS.register(
	Title,
	Tooltip,
	Legend,
	LineElement,
	BarElement,
	PointElement,
	CategoryScale,
	LinearScale,
	ArcElement,
	Filler,
);

export default {
	name: "WidgetChart",
	props: {
		variant: { type: String, default: "line" },
		labels: { type: Array, default: () => [] },
		values: { type: Array, default: () => [] },
		colors: { type: [Array, String], default: () => CATEGORICAL },
		valueFormat: { type: Function, default: (v) => v },
		emptyText: { type: String, default: "" },
		legendMode: { type: String, default: "chart" },
	},
	setup(props) {
		const theme = useTheme();
		const chartRenderKey = ref(0);
		const disableThemeAnimation = ref(false);
		const themeName = computed(() => theme.global.name.value);
		const isRadial = computed(() => props.variant === "donut");
		const usesHtmlLegend = computed(
			() => isRadial.value && ["html", "custom"].includes(props.legendMode),
		);
		function themeVar(name, fallback) {
			if (typeof window === "undefined") return fallback;
			const source =
				document.querySelector(".v-application") ||
				document.querySelector(".v-theme--dark") ||
				document.documentElement;
			return getComputedStyle(source).getPropertyValue(name).trim() || fallback;
		}

		const themeColors = computed(() => {
			const colors = theme.current.value.colors;
			return {
				text: themeVar("--pospire-text-primary", colors["on-surface"] || colors.surface),
				muted: themeVar("--pospire-text-muted", colors["on-surface-variant"] || colors["on-surface"]),
				grid: themeVar("--pospire-chart-grid", colors.outline || colors.surface),
				tooltipBg: themeVar("--pospire-chart-tooltip-bg", colors.surface),
				tooltipText: themeVar("--pospire-chart-tooltip-text", colors["on-surface"]),
			};
		});

		watch(
			themeName,
			async () => {
				disableThemeAnimation.value = true;
				chartRenderKey.value += 1;
				await nextTick();
				if (typeof requestAnimationFrame === "undefined") {
					disableThemeAnimation.value = false;
					return;
				}
				requestAnimationFrame(() => {
					disableThemeAnimation.value = false;
				});
			},
			{ flush: "sync" },
		);

		const hasData = computed(() => {
			if (!props.labels.length) return false;
			// Radial charts need a positive slice; axis charts still draw a flat
			// baseline when every value is zero, matching the prior dashboard.
			if (isRadial.value) return props.values.some((v) => Number(v) > 0);
			return true;
		});

		const chartComponent = computed(() => {
			if (props.variant === "bar") return Bar;
			if (props.variant === "donut") return Doughnut;
			return Line;
		});

		const chartData = computed(() => {
			if (isRadial.value) {
				const palette = Array.isArray(props.colors) ? props.colors : CATEGORICAL;
				return {
					labels: props.labels,
					datasets: [
						{
							data: props.values,
							backgroundColor: props.labels.map((_, i) => palette[i % palette.length]),
							borderWidth: 0,
						},
					],
				};
			}
			const single = typeof props.colors === "string" ? props.colors : PRIMARY;
			return {
				labels: props.labels,
				datasets: [
					{
						data: props.values,
						borderColor: single,
						backgroundColor: props.variant === "area" ? `${single}22` : single,
						fill: props.variant === "area",
						tension: 0.4,
						pointRadius: 3,
						borderRadius: props.variant === "bar" ? 6 : 0,
					},
				],
			};
		});

		const htmlLegendItems = computed(() => {
			if (!isRadial.value) return [];
			const palette = Array.isArray(props.colors) ? props.colors : CATEGORICAL;
			return props.labels.map((label, index) => ({
				index,
				label,
				value: props.valueFormat(props.values[index] || 0),
				color: palette[index % palette.length],
			}));
		});

		// Draws a "Total <sum>" label in the centre of a doughnut, matching the
		// original payment-distribution donut.
		const centerTotalPlugin = {
			id: "donutCenterTotal",
			afterDatasetsDraw(chart) {
				if (props.variant !== "donut") return;
				const { ctx, chartArea } = chart;
				if (!chartArea) return;
				const total = props.values.reduce((sum, v) => sum + (Number(v) || 0), 0);
				const cx = (chartArea.left + chartArea.right) / 2;
				const cy = (chartArea.top + chartArea.bottom) / 2;
				ctx.save();
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillStyle = themeColors.value.muted;
				ctx.font = "600 11px sans-serif";
				ctx.fillText(__("Total"), cx, cy - 10);
				ctx.fillStyle = themeColors.value.text;
				ctx.font = "700 17px sans-serif";
				ctx.fillText(props.valueFormat(total), cx, cy + 9);
				ctx.restore();
			},
		};

		const chartPlugins = computed(() => (isRadial.value ? [centerTotalPlugin] : []));

		const chartOptions = computed(() => ({
			responsive: true,
			maintainAspectRatio: false,
			animation: disableThemeAnimation.value ? false : undefined,
			layout: isRadial.value ? { padding: { bottom: 4 } } : {},
			plugins: {
				legend: {
					display: isRadial.value && !usesHtmlLegend.value,
					position: "bottom",
					labels: isRadial.value
						? {
								color: themeColors.value.text,
								usePointStyle: true,
								boxWidth: 8,
								generateLabels: (chart) => {
									const dataset = chart.data.datasets[0] || { data: [], backgroundColor: [] };
									return chart.data.labels.map((label, i) => ({
										text: `${label}  ${props.valueFormat(dataset.data[i])}`,
										fillStyle: dataset.backgroundColor[i],
										strokeStyle: dataset.backgroundColor[i],
										index: i,
									}));
								},
							}
						: {},
				},
				tooltip: {
					backgroundColor: themeColors.value.tooltipBg,
					titleColor: themeColors.value.tooltipText,
					bodyColor: themeColors.value.tooltipText,
					callbacks: {
						label: (ctx) => {
							const raw = isRadial.value ? ctx.parsed : ctx.parsed.y;
							return ` ${props.valueFormat(raw)}`;
						},
					},
				},
			},
			scales: isRadial.value
				? {}
				: {
						y: {
							ticks: {
								color: themeColors.value.muted,
								callback: (v) => props.valueFormat(v),
							},
							grid: { color: themeColors.value.grid },
						},
						x: {
							ticks: { color: themeColors.value.muted },
							grid: { display: false },
						},
					},
		}));

		return {
			hasData,
			usesHtmlLegend,
			htmlLegendItems,
			chartComponent,
			chartRenderKey,
			chartData,
			chartOptions,
			chartPlugins,
		};
	},
};
</script>

<style scoped>
.widget-chart {
	height: 320px;
	position: relative;
}
.widget-chart--html-legend {
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.widget-chart__canvas {
	min-height: 0;
	flex: 1 1 auto;
}
.widget-chart__legend {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: 8px 14px;
	flex: 0 0 auto;
	padding-top: 2px;
}
.widget-chart__legend-item {
	display: grid;
	grid-template-columns: 10px minmax(0, 1fr) auto;
	align-items: center;
	column-gap: 8px;
	min-width: 0;
	color: var(--pospire-text-primary);
	font-size: 0.8125rem;
	line-height: 1.25;
}
.widget-chart__legend-dot {
	width: 9px;
	height: 9px;
	border-radius: 999px;
}
.widget-chart__legend-label {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--pospire-text-main);
}
.widget-chart__legend-value {
	justify-self: end;
	color: var(--pospire-text-primary);
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.widget-chart__empty {
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--pospire-text-muted);
	font-size: 0.875rem;
	font-weight: 500;
}
</style>
