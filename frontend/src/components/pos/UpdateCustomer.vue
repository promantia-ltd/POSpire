<template>
	<v-row justify="center">
		<v-dialog v-model="customerDialog" max-width="600px" @click:outside="clear_customer">
			<v-card elevation="8" rounded="xl">
				<v-card-title
					class="d-flex justify-center align-center py-4 enhanced-modal-header"
				>
					<v-icon size="24" color="primary" class="me-2">
						{{ customer_id ? "mdi-account-edit" : "mdi-account-plus" }}
					</v-icon>
					<span class="text-h6 font-weight-bold text-primary">
						{{ customer_id ? __("Update Customer") : __("Create Customer") }}
					</span>
				</v-card-title>

				<v-card-text>
					<v-container>
						<v-row dense>
							<v-col cols="12">
								<v-text-field
									variant="outlined"
									density="comfortable"
									color="primary"
									:label="__('Customer Name') + ' *'"
									v-model="customer_name"
									class="mb-3"
								/>
							</v-col>

							<v-col cols="6">
								<v-text-field
									variant="outlined"
									density="comfortable"
									color="primary"
									:label="__('Tax ID')"
									v-model="tax_id"
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6">
								<v-text-field
									variant="outlined"
									density="comfortable"
									color="primary"
									:label="__('Mobile No')"
									v-model="mobile_no"
									class="mb-3"
								/>
							</v-col>

							<v-col cols="6">
								<v-text-field
									variant="outlined"
									density="comfortable"
									color="primary"
									:label="__('Email Id')"
									v-model="email_id"
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6">
								<v-select
									variant="outlined"
									density="comfortable"
									color="primary"
									:items="genders"
									:label="__('Gender')"
									v-model="gender"
									class="mb-3"
								/>
							</v-col>

							<v-col cols="6">
								<v-text-field
									variant="outlined"
									density="comfortable"
									color="primary"
									:label="__('Referral Code')"
									v-model="referral_code"
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6">
								<v-menu
									v-model="birthday_menu"
									:close-on-content-click="false"
									transition="scale-transition"
									offset-y
									min-width="290px"
								>
									<template v-slot:activator="{ props }">
										<v-text-field
											variant="outlined"
											density="comfortable"
											color="primary"
											v-model="birthday_string"
											:label="__('Birthday')"
											readonly
											clearable
											v-bind="props"
											@click:clear="resetBirthday"
											class="mb-3"
										/>
									</template>
									<v-date-picker
										v-model="birthday"
										color="primary"
										:max="datetime.now_date()"
										show-adjacent-months
										view="date"
										@update:model-value="birthday_menu = false"
									/>
								</v-menu>
							</v-col>

							<v-col cols="6">
								<v-autocomplete
									clearable
									density="comfortable"
									variant="outlined"
									color="primary"
									:label="__('Customer Group') + ' *'"
									v-model="group"
									:items="groups"
									:no-data-text="__('Group not found')"
									required
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6">
								<v-autocomplete
									clearable
									density="comfortable"
									variant="outlined"
									color="primary"
									:label="__('Territory') + ' *'"
									v-model="territory"
									:items="territorys"
									:no-data-text="__('Territory not found')"
									required
									class="mb-3"
								/>
							</v-col>

							<v-col cols="6" v-if="loyalty_program">
								<v-text-field
									v-model="loyalty_program"
									:label="__('Loyalty Program')"
									density="comfortable"
									variant="outlined"
									readonly
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6" v-if="loyalty_points">
								<v-text-field
									v-model="loyalty_points"
									:label="__('Loyalty Points')"
									density="comfortable"
									variant="outlined"
									readonly
									class="mb-3"
								/>
							</v-col>
						</v-row>
					</v-container>
				</v-card-text>

				<v-card-actions class="d-flex justify-end py-4 enhanced-modal-header">
					<v-btn variant="text" color="grey-darken-1" class="me-2" @click="close_dialog">
						{{ __("Close") }}
					</v-btn>
					<v-btn variant="elevated" color="primary" @click="submit_dialog">
						{{ __("Submit") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
import { call } from "@/utils/call";
import { datetime } from "@/utils/datetime";
import { playSound } from "@/utils/sounds";
import { toast } from "vue3-toastify";

export default {
	data: () => ({
		customerDialog: false,
		pos_profile: "",
		customer_id: "",
		customer_name: "",
		tax_id: "",
		mobile_no: "",
		email_id: "",
		referral_code: "",
		birthday: null,
		birthday_menu: false,
		group: "",
		groups: [],
		territory: "",
		territorys: [],
		genders: [],
		customer_type: "Individual",
		gender: "",
		loyalty_points: null,
		loyalty_program: null,
	}),
	setup() {
		return { datetime };
	},
	watch: {},
	computed: {
		birthday_string: {
			get() {
				return this.birthday ? datetime.obj_to_str(this.birthday, "dd-mm-yyyy") : "";
			},
			set(val) {
				this.birthday = val ? datetime.str_to_obj(val) : null;
			},
		},
	},
	methods: {
		resetBirthday() {
			this.birthday = null;
			this.birthday_menu = false;
		},
		close_dialog() {
			this.customerDialog = false;
			this.clear_customer();
		},
		clear_customer() {
			this.customer_name = "";
			this.tax_id = "";
			this.mobile_no = "";
			this.email_id = "";
			this.referral_code = "";
			this.birthday = null; // Explicit null instead of empty string
			this.birthday_menu = false; // Reset menu state
			this.$nextTick(() => {
				if (this.$refs.birthday_menu) {
					this.$refs.birthday_menu.isActive = false; // Force close menu
				}
			});
			this.group = window.user_defaults?.["Customer Group"] || "";
			this.territory = window.user_defaults?.["Territory"] || "";
			this.customer_id = "";
			this.customer_type = "Individual";
			this.gender = "";
			this.loyalty_points = null;
			this.loyalty_program = null;
		},
		async getCustomerGroups() {
			if (this.groups.length > 0) return;
			const vm = this;
			const data = await call("frappe.client.get_list", {
				doctype: "Customer Group",
				fields: ["name"],
				filters: { is_group: 0 },
				limit: 1000,
				order_by: "name",
			});
			if (data && data.length > 0) {
				data.forEach((el) => {
					vm.groups.push(el.name);
				});
			}
		},
		async getCustomerTerritorys() {
			if (this.territorys.length > 0) return;
			const vm = this;
			const data = await call("frappe.client.get_list", {
				doctype: "Territory",
				fields: ["name"],
				filters: { is_group: 0 },
				limit: 5000,
				order_by: "name",
			});
			if (data && data.length > 0) {
				data.forEach((el) => {
					vm.territorys.push(el.name);
				});
			}
		},
		async getGenders() {
			const vm = this;
			const data = await call("frappe.client.get_list", {
				doctype: "Gender",
				fields: ["name"],
				limit: 1000,
				order_by: "name",
			});
			if (data && data.length > 0) {
				data.forEach((el) => {
					vm.genders.push(el.name);
				});
			}
		},
		async submit_dialog() {
			if (!this.customer_name) {
				toast.error(__("Customer name is required."));
				return;
			}
			if (!this.group) {
				toast.error(__("Customer group is required."));
				return;
			}
			if (!this.territory) {
				toast.error(__("Customer territory is required."));
				return;
			}
			const args = {
				customer_id: this.customer_id,
				customer_name: this.customer_name,
				company: this.pos_profile.company,
				tax_id: this.tax_id,
				mobile_no: this.mobile_no,
				email_id: this.email_id,
				referral_code: this.referral_code,
				birthday: this.birthday
					? datetime.obj_to_str(this.birthday, "yyyy-mm-dd")
					: null,
				customer_group: this.group,
				territory: this.territory,
				customer_type: this.customer_type,
				gender: this.gender,
				method: this.customer_id ? "update" : "create",
				pos_profile_doc: this.pos_profile,
			};
			try {
				const r = await call("pospire.pospire.api.posapp.create_customer", args);
				if (r && r.name) {
					const text = this.customer_id
						? __("Customer Updated Successfully.")
						: __("Customer Created Successfully.");
					toast.success(text);
					args.name = r.name;
					playSound("submit");
					this.eventBus.emit("add_customer_to_list", args);
					this.eventBus.emit("set_customer", r.name);
					this.eventBus.emit("fetch_customer_details");
					this.close_dialog();
				} else {
					playSound("error");
					toast.error(__("Customer creation failed."));
				}
			} catch (error) {
				playSound("error");
				const serverMessage = this.extractServerMessage(error);
				toast.error(serverMessage || __("Customer creation failed."));
			}
		},
		extractServerMessage(error) {
			if (error?.messages?.length) {
				return error.messages[error.messages.length - 1];
			}
			return null;
		},
	},
	created: function () {
		this.eventBus.on("open_update_customer", (data) => {
			this.customerDialog = true;
			if (data) {
				this.customer_name = data.customer_name;
				this.customer_id = data.name;
				this.tax_id = data.tax_id;
				this.mobile_no = data.mobile_no;
				this.email_id = data.email_id;
				this.referral_code = data.referral_code;
				this.birthday = data.birthday ? new Date(data.birthday) : null;
				this.group = data.customer_group;
				this.territory = data.territory;
				this.loyalty_points = data.loyalty_points;
				this.loyalty_program = data.loyalty_program;
				this.gender = data.gender;
			} else {
				this.birthday = null; // Explicit null for new customers
			}
		});
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		this.eventBus.on("payments_register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		this.getCustomerGroups();
		this.getCustomerTerritorys();
		this.getGenders();
		// set default values for customer group and territory from user defaults
		this.group = window.user_defaults?.["Customer Group"] || "";
		this.territory = window.user_defaults?.["Territory"] || "";
	},
};
</script>
