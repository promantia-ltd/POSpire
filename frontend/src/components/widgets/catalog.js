import { CARD_COLORS } from "./palette";
import {
	formatCurrency,
	formatNumber,
	formatCompactCurrency,
	formatHourLabel,
} from "@/utils/dashboardFormat";

const CARD_META = {
	total_net_sales: { valueType: "currency", icon: "mdi-cash-multiple" },
	bill_count: { valueType: "number", icon: "mdi-receipt-text-outline" },
	loyalty_redemptions: { valueType: "points", icon: "mdi-star-circle-outline" },
	total_returns: { valueType: "currency", icon: "mdi-cash-refund" },
	held_invoices: { valueType: "number", icon: "mdi-pause-circle-outline" },
	cancelled_invoices: { valueType: "number", icon: "mdi-close-circle-outline" },
};

function cardEntry(dataKey, defaultTitle) {
	const meta = CARD_META[dataKey];
	return {
		defaultType: "number-card",
		defaultTitle,
		icon: meta.icon,
		resolvers: {
			"number-card": (slice) => ({
				value: slice?.value ?? 0,
				valueType: meta.valueType,
				trend: slice?.trend ?? { status: "no_previous", percentage: null, label: "" },
				iconColor: CARD_COLORS[dataKey]?.color,
				iconBg: CARD_COLORS[dataKey]?.background,
			}),
		},
	};
}

function rankedProducts(slice) {
	return (slice || [])
		.filter((row) => Number(row.total_qty) > 0)
		.map((row, index) => ({ ...row, rank: index + 1 }));
}

export const CATALOG = {
	total_net_sales: cardEntry("total_net_sales", () => __("Total Net Sales")),
	bill_count: cardEntry("bill_count", () => __("Bills")),
	loyalty_redemptions: cardEntry("loyalty_redemptions", () => __("Loyalty")),
	total_returns: cardEntry("total_returns", () => __("Returns")),
	held_invoices: cardEntry("held_invoices", () => __("Held")),
	cancelled_invoices: cardEntry("cancelled_invoices", () => __("Cancelled")),

	hourly_sales: {
		defaultType: "chart",
		defaultTitle: () => __("Hourly Sales"),
		defaultVariant: "line",
		resolvers: {
			chart: (slice) => ({
				labels: (slice?.labels || []).map(formatHourLabel),
				values: slice?.values || [],
				valueFormat: formatCompactCurrency,
			}),
		},
	},

	payment_distribution: {
		defaultType: "chart",
		defaultTitle: () => __("Payment Distribution"),
		defaultVariant: "donut",
		resolvers: {
			chart: (slice) => {
				const rows = (slice || []).filter((row) => Number(row.amount) > 0);
				return {
					labels: rows.map((row) => row.mode_of_payment || __("Unknown")),
					values: rows.map((row) => Number(row.amount) || 0),
					valueFormat: formatCurrency,
					legendMode: "html",
				};
			},
		},
	},

	top_products: {
		defaultType: "table",
		defaultTitle: () => __("Top Selling Products"),
		defaultVariant: "bar",
		resolvers: {
			table: (slice) => ({
				rows: rankedProducts(slice),
				columns: [
					{ key: "rank", label: "#", width: "34px" },
					{ key: "item_name", label: __("Product"), width: "minmax(0, 1fr)" },
					{ key: "total_qty", label: __("Qty"), align: "right", width: "76px", format: formatNumber },
					{
						key: "total_sales",
						label: __("Sales"),
						align: "right",
						width: "110px",
						format: formatCurrency,
					},
				],
			}),
			chart: (slice) => {
				const rows = (slice || []).filter((row) => Number(row.total_sales) > 0);
				return {
					labels: rows.map((row) => row.item_name || row.item_code || __("Unknown")),
					values: rows.map((row) => Number(row.total_sales) || 0),
					valueFormat: formatCurrency,
					legendMode: "html",
				};
			},
		},
	},

	top_categories: {
		defaultType: "table",
		defaultTitle: () => __("Top Selling Categories"),
		defaultVariant: "bar",
		resolvers: {
			table: (slice) => ({
				rows: (slice || []).filter((row) => Number(row.total_qty) > 0),
				columns: [
					{ key: "item_group", label: __("Category"), width: "minmax(92px, 0.75fr)" },
					{
						key: "total_sales_bar",
						label: "",
						bar: true,
						barValueKey: "total_sales",
						width: "minmax(120px, 1.4fr)",
					},
					{
						key: "total_sales",
						label: __("Sales"),
						align: "right",
						width: "96px",
						format: formatCurrency,
					},
				],
			}),
			chart: (slice) => {
				const rows = (slice || []).filter((row) => Number(row.total_sales) > 0);
				return {
					labels: rows.map((row) => row.item_group || __("Unknown")),
					values: rows.map((row) => Number(row.total_sales) || 0),
					valueFormat: formatCurrency,
					legendMode: "html",
				};
			},
		},
	},

	shift_summary: {
		defaultType: "table",
		defaultTitle: () => __("Shift Summary"),
		resolvers: {
			table: (slice) => ({
				previewLimit: 99,
				rows: [
					{ label: __("Opening Float"), value: formatCurrency(slice?.opening_float || 0) },
					{ label: __("Cash Sales"), value: `+${formatCurrency(slice?.cash_sales || 0)}` },
					{ label: __("Cash In"), value: `+${formatCurrency(slice?.cash_in || 0)}` },
					{ label: __("Cash Out"), value: `-${formatCurrency(slice?.cash_out || 0)}` },
				],
				columns: [
					{ key: "label", label: "", width: "minmax(0, 1fr)" },
					{ key: "value", label: "", align: "right", width: "140px" },
				],
			}),
		},
	},
};

const DEFAULT_SPAN = { "number-card": 4, chart: 6, table: 6 };

export function resolveWidget(descriptor, slice) {
	const entry = CATALOG[descriptor.data_key];
	if (!entry) return null;

	let type = descriptor.widget_type || entry.defaultType;
	let resolver = entry.resolvers[type];
	if (!resolver) {
		if (import.meta.env.DEV) {
			console.warn(
				"[catalog] unsupported widget_type",
				descriptor.widget_type,
				"for",
				descriptor.data_key,
			);
		}
		type = entry.defaultType;
		resolver = entry.resolvers[type];
	}

	const title = descriptor.title || entry.defaultTitle?.();
	const props = resolver(slice);
	if (type === "number-card") {
		props.title = title;
		props.icon = descriptor.icon || entry.icon;
	}
	if (type === "chart") {
		props.variant = descriptor.variant || entry.defaultVariant || "line";
		props.legendMode = descriptor.legend_mode || descriptor.legendMode || props.legendMode || "chart";
	}

	return {
		type,
		title,
		props,
		colSpan: descriptor.column_span || DEFAULT_SPAN[type] || 6,
	};
}
