<template>
  <v-card class="number-card" elevation="1">
    <v-card-text class="number-card__content">
      <div class="number-card__copy">
        <div class="number-card__title">{{ title }}</div>
        <div class="number-card__value">{{ formattedValue }}</div>
        <div class="number-card__comparison" :class="comparisonClass">
          {{ comparisonText }}
        </div>
      </div>
      <div
        v-if="icon"
        class="number-card__icon"
        :style="{ '--card-accent': iconColor, '--card-accent-bg': iconBg }"
      >
        <v-icon :icon="icon" size="24" />
      </div>
    </v-card-text>
  </v-card>
</template>

<script>
import { computed } from "vue";
import {
	formatCurrency,
	formatNumber,
	formatPercentage,
	formatPoints,
} from "@/utils/dashboardFormat";

export default {
	name: "NumberCard",
	props: {
		title: { type: String, default: "" },
		value: { type: [Number, String], default: 0 },
		valueType: { type: String, default: "number" },
		icon: { type: String, default: "" },
		iconColor: { type: String, default: "rgb(var(--v-theme-primary))" },
		iconBg: {
			type: String,
			default: "color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent)",
		},
		trend: {
			type: Object,
			default: () => ({ status: "no_previous", percentage: null, label: "" }),
		},
	},
	setup(props) {
		const formattedValue = computed(() => {
			const value = Number(props.value) || 0;
			if (props.valueType === "currency") return formatCurrency(value);
			if (props.valueType === "points") return formatPoints(value);
			return formatNumber(value);
		});

		const comparisonText = computed(() => {
			const { status, percentage, label } = props.trend || {};
			if (status === "up") return `▲ ${formatPercentage(percentage)} ${__("vs Previous Shift")}`;
			if (status === "down") return `▼ ${formatPercentage(percentage)} ${__("vs Previous Shift")}`;
			if (status === "same") return __("Same as Previous Shift");
			if (status === "previous_zero") return label || __("No Previous Shift");
			return __("No Previous Shift");
		});

		const comparisonClass = computed(() => {
			const status = props.trend?.status;
			return {
				"number-card__comparison--up": status === "up",
				"number-card__comparison--down": status === "down",
				"number-card__comparison--neutral": status !== "up" && status !== "down",
			};
		});

		return { formattedValue, comparisonText, comparisonClass };
	},
};
</script>

<style scoped>
.number-card {
	height: 116px;
	background: var(--pospire-surface);
	border: 1px solid var(--pospire-border);
	border-radius: 14px;
	box-shadow: var(--pospire-card-shadow);
	transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.number-card__content {
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	padding: 18px 20px;
}
.number-card__copy {
	min-width: 0;
}
.number-card__title {
	color: var(--pospire-text-muted);
	font-size: 0.8125rem;
	font-weight: 500;
	line-height: 1.3;
	margin-bottom: 8px;
}
.number-card__value {
	color: var(--pospire-text-primary);
	font-size: 2rem;
	font-weight: 700;
	line-height: 1.15;
	overflow-wrap: anywhere;
}
.number-card__comparison {
	margin-top: 6px;
	font-size: 0.75rem;
	font-weight: 600;
	line-height: 1.2;
}
.number-card__comparison--up {
	color: rgb(var(--v-theme-success));
}
.number-card__comparison--down {
	color: rgb(var(--v-theme-error));
}
.number-card__comparison--neutral {
	color: var(--pospire-text-muted);
}
.number-card__icon {
	width: 46px;
	height: 46px;
	flex: 0 0 46px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 999px;
	color: var(--card-accent);
	background: var(--card-accent-bg);
}

:global(.v-theme--dark) .number-card__icon {
	background: color-mix(in srgb, var(--card-accent) 22%, var(--pospire-surface-soft));
}
</style>
