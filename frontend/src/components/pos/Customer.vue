<template>
	<div>
		<v-autocomplete
			density="compact"
			clearable
			auto-select-first
			variant="outlined"
			color="primary"
			:label="__('Customer')"
			v-model="customer"
			:items="customers"
			item-title="customer_name"
			item-value="name"
			:no-data-text="__('Customers not found')"
			hide-details
			:customFilter="customFilter"
			:disabled="readonly"
		>
			<template #prepend-inner>
				<v-icon
					class="customer-action-icon mr-2"
					color="primary"
					@click.stop="edit_customer"
				>mdi-account-edit</v-icon>
				<v-icon
					class="customer-action-icon mr-1"
					color="#00BCD4"
					@click.stop="new_customer"
				>mdi-account-plus</v-icon>
			</template>
			<template v-slot:item="{ props, item }">
				<v-list-item v-bind="props">
					<v-list-item-subtitle v-if="item.raw.customer_name != item.raw.name">
						<div v-html="`ID: ${item.raw.name}`"></div>
					</v-list-item-subtitle>
					<v-list-item-subtitle v-if="item.raw.tax_id">
						<div v-html="`TAX ID: ${item.raw.tax_id}`"></div>
					</v-list-item-subtitle>
					<v-list-item-subtitle v-if="item.raw.email_id">
						<div v-html="`Email: ${item.raw.email_id}`"></div>
					</v-list-item-subtitle>
					<v-list-item-subtitle v-if="item.raw.mobile_no">
						<div v-html="`Mobile No: ${item.raw.mobile_no}`"></div>
					</v-list-item-subtitle>
					<v-list-item-subtitle v-if="item.raw.primary_address">
						<div v-html="`Primary Address: ${item.raw.primary_address}`"></div>
					</v-list-item-subtitle>
				</v-list-item>
			</template>
		</v-autocomplete>

		<UpdateCustomer />
	</div>
</template>

<script>
import { call } from "frappe-ui";
import UpdateCustomer from "./UpdateCustomer.vue";
export default {
	data: () => ({
		pos_profile: "",
		customers: [],
		customer: "",
		readonly: false,
		customer_info: {},
	}),

	components: {
		UpdateCustomer,
	},

	methods: {
		async get_customer_names() {
			var vm = this;
			if (this.customers.length > 0) {
				return;
			}
			const profile_doc = vm.pos_profile.pos_profile;
			if (profile_doc?.posa_local_storage && localStorage.customer_storage) {
				vm.customers = JSON.parse(localStorage.getItem("customer_storage"));
			}

			const r = await call("pospire.pospire.api.posapp.get_customer_names", {
				pos_profile: profile_doc,
			});
			if (r) {
				vm.customers = r;
				if (profile_doc?.posa_local_storage) {
					localStorage.setItem("customer_storage", "");
					localStorage.setItem("customer_storage", JSON.stringify(r));
				}
			}
		},
		new_customer() {
			this.eventBus.emit("open_update_customer", null);
		},
		edit_customer() {
			this.eventBus.emit("open_update_customer", this.customer_info);
		},
		customFilter(itemText, queryText, itemRow) {
			const item = itemRow.raw;
			const textOne = item.customer_name ? item.customer_name.toLowerCase() : "";
			const textTwo = item.tax_id ? item.tax_id.toLowerCase() : "";
			const textThree = item.email_id ? item.email_id.toLowerCase() : "";
			const textFour = item.mobile_no ? item.mobile_no.toLowerCase() : "";
			const textFifth = item.name.toLowerCase();
			const searchText = queryText.toLowerCase();

			return (
				textOne.indexOf(searchText) > -1 ||
				textTwo.indexOf(searchText) > -1 ||
				textThree.indexOf(searchText) > -1 ||
				textFour.indexOf(searchText) > -1 ||
				textFifth.indexOf(searchText) > -1
			);
		},
	},

	computed: {},

	created: function () {
		this.$nextTick(function () {
			this.eventBus.on("register_pos_profile", (pos_profile) => {
				this.pos_profile = pos_profile;
				this.get_customer_names();
			});
			this.eventBus.on("payments_register_pos_profile", (pos_profile) => {
				this.pos_profile = pos_profile;
				this.get_customer_names();
			});
			this.eventBus.on("set_customer", (customer) => {
				this.customer = customer;
			});
			this.eventBus.on("add_customer_to_list", (customer) => {
				this.customers.push(customer);
			});
			this.eventBus.on("set_customer_readonly", (value) => {
				this.readonly = value;
			});
			this.eventBus.on("set_customer_info_to_edit", (data) => {
				this.customer_info = data;
			});
			this.eventBus.on("fetch_customer_details", () => {
				this.get_customer_names();
			});
		});
	},

	watch: {
		customer() {
			this.eventBus.emit("update_customer", this.customer);
		},
	},
};
</script>

<style scoped>
.customer-action-icon {
	cursor: pointer;
	transition: transform 0.15s ease, filter 0.15s ease, color 0.15s ease;
}

.customer-action-icon:hover {
	transform: scale(1.3);
	color: #00BCD4 !important;
	filter: brightness(1.25) drop-shadow(0 0 4px #00BCD4);
}

.customer-action-icon:active {
	transform: scale(1.1);
}
</style>
