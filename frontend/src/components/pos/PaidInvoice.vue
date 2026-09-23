<template>
	<v-row justify="center">
		<v-dialog v-model="paidDialog" max-width="900px" class="pospire-dialog" persistent>
			<v-card class="pospire-modal" elevation="8">
				<v-card-title class="pospire-modal-header">
					<v-icon class="mr-3" size="28" color="primary"
						>mdi-file-document-outline</v-icon
					>
					<div>
						<div class="text-h6 font-weight-bold paid-invoice-title">
							{{ __("Load Sales Invoice Items") }}
						</div>
						<div class="text-caption paid-invoice-subtitle">
							{{ __("All the items in the current invoices") }}
						</div>
					</div>
				</v-card-title>

				<v-card-text class="pospire-modal-body pa-4">
					<v-data-table
						:headers="headers"
						:items="paginatedItems"
						item-value="name"
						class="elevation-1 rounded-lg"
						show-select
						v-model="selected"
						select-strategy="single"
						return-object
						hide-default-footer
					>
						<template v-slot:item.amount="{ item }">
							{{ formatCurrency(item.amount) }}
						</template>

						<template v-slot:bottom>
							<div class="text-center compact-pagination py-2">
								<span class="text-caption page-info">
									{{ paginatedItems.length ? (page - 1) * itemsPerPage + 1 : 0 }}
									-
									{{ Math.min(page * itemsPerPage, dialog_data.length) }}
									of {{ dialog_data.length }}
								</span>
								<v-pagination
									:total-visible="5"
									v-model="page"
									:length="pageCount"
									density="compact"
									size="small"
								/>
							</div>
						</template>
					</v-data-table>
				</v-card-text>

				<v-card-actions class="pospire-modal-actions">
					<v-spacer />
					<v-btn
						variant="elevated"
						color="primary"
						@click="close_dialog"
					>
						{{ __("Close") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
import format from "@/utils/format";
import busListeners from "@/utils/busListeners";
export default {
	mixins: [format, busListeners],
	data: () => ({
		page: 1,
		itemsPerPage: 5,
		paidDialog: false,
		singleSelect: true,
		selected: [],
		dialog_data: {},
		headers: [
			{
				title: __("Name"),
				value: "item_name",
				align: "start",
				sortable: true,
			},
			{
				title: __("Item Code"),
				align: "start",
				sortable: true,
				value: "item_code",
			},
			{
				title: __("Qty"),
				align: "start",
				sortable: true,
				value: "qty",
			},
			{
				title: __("UOM"),
				value: "uom",
				align: "start",
				sortable: false,
			},
			{
				title: __("Price"),
				value: "amount",
				align: "end",
				sortable: false,
			},
		],
	}),
	watch: {},
	computed: {
		pageCount() {
			return Math.ceil(this.dialog_data.length / this.itemsPerPage);
		},
		paginatedItems() {
			const start = (this.page - 1) * this.itemsPerPage;
			const end = start + this.itemsPerPage;
			return this.dialog_data.slice(start, end);
		},
	},
	methods: {
		close_dialog() {
			this.paidDialog = false;
		},
	},
	created: function () {
		this.onBus("open_paid", (data) => {
			this.paidDialog = true;
			this.dialog_data = data;
		});
	},
};
</script>

<style scoped>
/* POSpire Modal Styling */
.pospire-modal {
	border-radius: 16px !important;
	overflow: hidden;
}

.pospire-modal-header {
	background: var(--section-bg) !important;
	border-bottom: 2px solid var(--pospire-border) !important;
	padding: 20px 24px !important;
	display: flex !important;
	align-items: center !important;
}

.pospire-modal-body {
	background: var(--pospire-surface) !important;
	padding: 24px !important;
}

.pospire-modal-actions {
	background: var(--pospire-surface-soft) !important;
	border-top: 2px solid var(--pospire-border) !important;
	padding: 16px 24px !important;
}

.compact-pagination {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 1rem;
	padding: 0.5rem;
}

.page-info {
	color: var(--pospire-text-muted);
}

.paid-invoice-title {
	color: var(--pospire-text-primary);
}

.paid-invoice-subtitle {
	color: var(--pospire-text-muted);
}
</style>
