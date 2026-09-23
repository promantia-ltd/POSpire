<template>
  <v-row class="widget-grid" dense>
    <v-col
      v-for="(item, index) in resolvedWidgets"
      :key="index"
      cols="12"
      :sm="item.sm"
      :md="item.cols"
    >
      <v-card
        v-if="item.type !== 'number-card'"
        class="widget-grid__card"
        elevation="1"
      >
        <v-card-title v-if="item.title" class="widget-grid__title">
          {{ item.title }}
        </v-card-title>
        <v-card-text class="widget-grid__body">
          <component :is="item.component" v-bind="item.props" />
        </v-card-text>
      </v-card>
      <component :is="item.component" v-else v-bind="item.props" />
    </v-col>
  </v-row>
</template>

<script>
import { computed } from "vue";
import { REGISTRY } from "./registry";
import { resolveWidget } from "./catalog";

export default {
	name: "WidgetRenderer",
	props: {
		layout: { type: Array, default: () => [] },
		data: { type: Object, default: () => ({}) },
	},
	setup(props) {
		const resolvedWidgets = computed(() => {
			const items = [];
			for (const descriptor of props.layout) {
				const slice = props.data?.[descriptor.data_key];
				const resolved = resolveWidget(descriptor, slice);
				const component = resolved && REGISTRY[resolved.type];
				if (!resolved || !component) {
					if (import.meta.env.DEV) {
						console.warn("[WidgetRenderer] skipping widget", descriptor);
					}
					continue;
				}
				items.push({
					component,
					type: resolved.type,
					title: resolved.title,
					props: resolved.props,
					cols: Math.min(Math.max(resolved.colSpan, 1), 12),
					sm: resolved.type === "number-card" ? 6 : 12,
				});
			}
			return items;
		});

		return { resolvedWidgets };
	},
};
</script>

<style scoped>
.widget-grid {
	align-items: stretch;
}
.widget-grid__card {
	height: 390px;
	background: var(--pospire-surface);
	border: 1px solid var(--pospire-border);
	border-radius: 14px;
	box-shadow: var(--pospire-card-shadow);
	transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.widget-grid__title {
	color: var(--pospire-text-primary);
	font-size: 1rem;
	font-weight: 600;
	padding: 16px 18px 0;
}
.widget-grid__body {
	height: calc(100% - 48px);
	padding: 8px 18px 16px;
}
</style>
