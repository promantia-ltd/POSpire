<template>
	<v-row justify="center">
		<v-dialog v-model="draftsDialog" max-width="900px">
			<v-card class="rounded-xl shadow-lg" elevation="8" rounded="xl">
				<v-card-title class="d-flex align-center justify-space-between">
					<span class="text-h6 font-weight-bold text-primary">
						{{ __("Load Sales Invoice") }}
					</span>
					<v-btn icon="mdi-close" variant="text" @click="close_dialog"></v-btn>
				</v-card-title>

				<v-card-subtitle class="pb-2">
					<span class="text-medium-emphasis">
						{{ __("Load previously saved invoices") }}
					</span>
				</v-card-subtitle>

				<v-card-text class="pa-0">
					<v-container fluid>
						<v-row no-gutters>
							<v-col cols="12" class="pa-1">
								<v-data-table
									:headers="headers"
									:items="paginatedDialogData"
									item-value="name"
									class="elevation-1"
									show-select
									v-model="selected"
									select-strategy="single"
									return-object
									hide-default-footer
								>
									<template v-slot:item.posting_time="{ item }">
										{{ item.posting_time.split(".")[0] }}
									</template>
									<template v-slot:item.grand_total="{ item }">
										{{ currencySymbol(item.currency) }}
										{{ formatCurrency(item.grand_total) }}
									</template>

									<template v-slot:bottom>
										<div class="text-center compact-pagination">
											<span class="text-caption page-info">
												{{
													paginatedDialogData.length
														? (page - 1) * itemsPerPage + 1
														: 0
												}}
												-
												{{
													Math.min(
														page * itemsPerPage,
														dialog_data.length
													)
												}}
												of {{ dialog_data.length }}
											</span>
											<v-pagination
												:total-visible="5"
												v-model="page"
												:length="pageCount"
												density="compact"
												size="small"
											></v-pagination>
										</div>
									</template>
								</v-data-table>
							</v-col>
						</v-row>
					</v-container>
				</v-card-text>

				<v-card-actions class="justify-end">
					<v-btn variant="text" color="grey-darken-1" @click="close_dialog">Close</v-btn>
					<v-btn variant="elevated" color="primary" @click="submit_dialog"
						>Load Sale</v-btn
					>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
import format from "../../format";
import { toast } from "vue3-toastify";
export default {
	// props: ["draftsDialog"],
	mixins: [format],
	data: () => ({
		page: 1,
		itemsPerPage: 5,
		draftsDialog: false,
		singleSelect: true,
		selected: [],
		dialog_data: {},
		headers: [
			{
				title: __("Customer"),
				value: "customer_name",
				align: "start",
				sortable: true,
			},
			{
				title: __("Date"),
				align: "start",
				sortable: true,
				value: "posting_date",
			},
			{
				title: __("Time"),
				align: "start",
				sortable: true,
				value: "posting_time",
			},
			{
				title: __("Invoice"),
				value: "name",
				align: "start",
				sortable: true,
			},
			{
				title: __("Amount"),
				value: "grand_total",
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
		paginatedDialogData() {
			const start = (this.page - 1) * this.itemsPerPage;
			const end = start + this.itemsPerPage;
			return this.dialog_data.slice(start, end);
		},
	},
	methods: {
		close_dialog() {
			this.draftsDialog = false;
		},

		submit_dialog() {
			if (this.selected.length > 0) {
				this.eventBus.emit("load_invoice", this.selected[0]);
				this.draftsDialog = false;
			} else {
				toast.error("Select an invoice to load");
			}
		},
	},
	created: function () {
		this.eventBus.on("open_drafts", (data) => {
			this.draftsDialog = true;
			this.dialog_data = data;
		});
	},
};
</script>
