<template>
  <div class="widget-table">
    <div v-if="!rows.length" class="widget-table__empty">
      {{ emptyText || __("No data available") }}
    </div>
    <div v-else class="widget-table__inner">
      <div class="widget-table__header" :style="gridStyle">
        <span v-for="col in columns" :key="col.key" :class="alignClass(col)">{{ col.label }}</span>
      </div>
      <div class="widget-table__body" :class="{ 'widget-table__body--scroll': expanded }">
        <div
          v-for="(row, index) in visibleRows"
          :key="index"
          class="widget-table__row"
          :style="gridStyle"
        >
          <span v-for="col in columns" :key="col.key" :class="alignClass(col)">
            <template v-if="col.bar">
              <svg class="widget-table__bar" viewBox="0 0 100 10" preserveAspectRatio="none">
                <rect x="0" y="0" width="100" height="10" rx="5" class="widget-table__bar-track" />
                <rect x="0" y="0" :width="barWidth(row, col)" height="10" rx="5" class="widget-table__bar-value" />
              </svg>
            </template>
            <template v-else>{{ cell(row, col) }}</template>
          </span>
        </div>
      </div>
      <button
        v-if="rows.length > previewLimit"
        type="button"
        class="widget-table__toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? __("Show Less") : __("View All") }}
      </button>
    </div>
  </div>
</template>

<script>
import { computed, ref } from "vue";

export default {
	name: "WidgetDataTable",
	props: {
		columns: { type: Array, default: () => [] },
		rows: { type: Array, default: () => [] },
		previewLimit: { type: Number, default: 5 },
		emptyText: { type: String, default: "" },
	},
	setup(props) {
		const expanded = ref(false);

		const visibleRows = computed(() =>
			expanded.value ? props.rows : props.rows.slice(0, props.previewLimit),
		);

		const gridStyle = computed(() => ({
			gridTemplateColumns: props.columns
				.map((c) => (c.width ? c.width : "minmax(0, 1fr)"))
				.join(" "),
		}));

		const maxByColumn = computed(() => {
			const maxes = {};
			for (const col of props.columns) {
				if (!col.bar) continue;
				const valueKey = col.barValueKey || col.key;
				maxes[col.key] = props.rows.reduce(
					(max, row) => Math.max(max, Number(row[valueKey]) || 0),
					0,
				);
			}
			return maxes;
		});

		function cell(row, col) {
			const value = row[col.key];
			return col.format ? col.format(value, row) : value;
		}

		function barWidth(row, col) {
			const max = maxByColumn.value[col.key] || 0;
			if (!max) return 0;
			const valueKey = col.barValueKey || col.key;
			return Math.max((Number(row[valueKey]) / max) * 100, 2);
		}

		function alignClass(col) {
			return col.align === "right" ? "widget-table__num" : "";
		}

		return { expanded, visibleRows, gridStyle, cell, barWidth, alignClass };
	},
};
</script>

<style scoped>
.widget-table {
	height: 100%;
}
.widget-table__inner {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}
.widget-table__header,
.widget-table__row {
	display: grid;
	align-items: center;
	column-gap: 12px;
}
.widget-table__header {
	height: 34px;
	color: var(--pospire-text-muted);
	font-size: 0.75rem;
	font-weight: 700;
	border-bottom: 1px solid var(--pospire-border);
}
.widget-table__body {
	min-height: 0;
}
.widget-table__body--scroll {
	max-height: 320px;
	overflow-y: auto;
	padding-right: 2px;
}
.widget-table__row {
	height: 40px;
	color: var(--pospire-text-main);
	font-size: 0.875rem;
	border-bottom: 1px solid var(--pospire-border-subtle);
	transition: background-color 0.15s ease;
}
.widget-table__row:hover {
	background: var(--pospire-hover-bg);
}
.widget-table__num {
	justify-self: end;
	font-variant-numeric: tabular-nums;
	text-align: right;
	white-space: nowrap;
}
.widget-table__bar {
	width: 100%;
	height: 12px;
	display: block;
}
.widget-table__bar-track {
	fill: var(--pospire-table-bar-track);
}
.widget-table__bar-value {
	fill: rgb(var(--v-theme-success));
}
.widget-table__toggle {
	align-self: flex-end;
	margin-top: 8px;
	border: 0;
	padding: 0;
	background: transparent;
	color: rgb(var(--v-theme-primary));
	cursor: pointer;
	font-size: 0.8125rem;
	font-weight: 600;
}
.widget-table__empty {
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--pospire-text-muted);
	font-size: 0.875rem;
	font-weight: 500;
}
</style>
