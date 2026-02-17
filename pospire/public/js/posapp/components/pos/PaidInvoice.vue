<template>
	<v-row justify="center">
		<v-dialog v-model="paidDialog" max-width="900px" class="pospire-dialog">
			<v-card class="pospire-modal" elevation="8">
				<v-card-title class="pospire-modal-header">
					<v-icon class="mr-3" size="28" color="#00BCD4"
						>mdi-file-document-outline</v-icon
					>
					<div>
						<div class="text-h6 font-weight-bold" style="color: #1e293b">
							{{ __("Load Sales Invoice Items") }}
						</div>
						<div class="text-caption" style="color: #64748b">
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
						style="background-color: #00bcd4 !important; color: white !important"
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
import format from "../../format";
export default {
	mixins: [format],
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
		this.eventBus.on("open_paid", (data) => {
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
	background: linear-gradient(135deg, #f8fafc 0%, #ffffff 100%) !important;
	border-bottom: 2px solid #e2e8f0 !important;
	padding: 20px 24px !important;
	display: flex !important;
	align-items: center !important;
}

.pospire-modal-body {
	background: #ffffff !important;
	padding: 24px !important;
}

.pospire-modal-actions {
	background: #f8f9fa !important;
	border-top: 2px solid #e2e8f0 !important;
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
	color: #64748b;
}
</style>
