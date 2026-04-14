<template>
	<v-row justify="center">
		<v-dialog v-model="customerDialog" max-width="600px" persistent>
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
											v-model="birthday_input_str"
											:label="__('Birthday')"
											placeholder="dd-mm-yyyy"
											clearable
											v-bind="props"
											@click:clear="clearBirthday"
											@blur="onBirthdayInput"
											@keyup.enter="onBirthdayInput"
											class="mb-3"
										/>
									</template>
									<v-date-picker
										v-model="birthday"
										color="primary"
										:max="todayAsDate"
										show-adjacent-months
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

							<v-col cols="6" v-if="loyalty_program != null">
								<v-text-field
									v-model="loyalty_program"
									:label="__('Loyalty Program')"
									density="comfortable"
									variant="outlined"
									readonly
									class="mb-3"
								/>
							</v-col>
							<v-col cols="6" v-if="loyalty_points != null">
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
					<v-btn variant="elevated" color="primary" :loading="submittingCustomer" :disabled="submittingCustomer" @click="submit_dialog">
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
		submittingCustomer: false,
		pos_profile: "",
		customer_id: "",
		customer_name: "",
		tax_id: "",
		mobile_no: "",
		email_id: "",
		referral_code: "",
		birthday: null,
		birthday_input_str: "",
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
	computed: {
		todayAsDate() {
			return new Date();
		},
	},
	watch: {
		// When the calendar picker selects a date, sync it into the text field.
		birthday(val) {
			this.birthday_input_str = val ? datetime.obj_to_str(val, "dd-mm-yyyy") : "";
		},
	},
	methods: {
		clearBirthday() {
			this.birthday = null;
			this.birthday_input_str = "";
			this.birthday_menu = false;
		},
		onBirthdayInput() {
			const val = this.birthday_input_str.trim();
			if (!val) {
				this.birthday = null;
				return;
			}

			// Accept dd-mm-yyyy (with - or /)
			let d = null;
			const ddmmyyyy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/;
			const m = val.match(ddmmyyyy);
			if (m) {
				const parsed = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
				if (!isNaN(parsed)) d = parsed;
			}
			// Accept yyyy-mm-dd (with - or /)
			if (!d && /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(val)) {
				const parsed = new Date(val.replace(/\//g, "-"));
				if (!isNaN(parsed)) d = parsed;
			}

			if (!d) {
				toast.error(__("Invalid date. Use dd-mm-yyyy or yyyy-mm-dd."));
				// Keep the typed text visible so the user can correct it.
				this.birthday = null;
				return;
			}

			// Future date check
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			d.setHours(0, 0, 0, 0);
			if (d > today) {
				toast.error(__("Birthday cannot be a future date."));
				this.birthday = null;
				return;
			}

			this.birthday = d;
			// Normalise to dd-mm-yyyy display
			this.birthday_input_str = datetime.obj_to_str(d, "dd-mm-yyyy");
		},
		validate_birthday() {
			if (!this.birthday) return;
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const b = new Date(this.birthday);
			b.setHours(0, 0, 0, 0);
			if (b > today) {
				toast.error(__("Birthday cannot be a future date."));
				this.birthday = null;
				this.birthday_input_str = "";
			}
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
			this.birthday = null;
			this.birthday_input_str = "";
			this.birthday_menu = false;
			this.group = window.user_defaults?.["Customer Group"] || "";
			this.territory = window.user_defaults?.["Territory"] || "";
			this.customer_id = "";
			this.customer_type = "Individual";
			this.gender = "";
			this.loyalty_points = null;
			this.loyalty_program = null;
		},
		async getCustomerGroups() {
			if (this.groups.length > 0 || this._fetchingGroups) return;
			this._fetchingGroups = true;
			try {
				const data = await call("frappe.client.get_list", {
					doctype: "Customer Group",
					fields: ["name"],
					filters: { is_group: 0 },
					limit: 200,
					order_by: "name",
				});
				if (data && data.length > 0) {
					this.groups = data.map((el) => el.name);
				}
			} finally {
				this._fetchingGroups = false;
			}
		},
		async getCustomerTerritorys() {
			if (this.territorys.length > 0 || this._fetchingTerritories) return;
			this._fetchingTerritories = true;
			try {
				const data = await call("frappe.client.get_list", {
					doctype: "Territory",
					fields: ["name"],
					filters: { is_group: 0 },
					limit: 200,
					order_by: "name",
				});
				if (data && data.length > 0) {
					this.territorys = data.map((el) => el.name);
				}
			} finally {
				this._fetchingTerritories = false;
			}
		},
		async getGenders() {
			if (this.genders.length > 0 || this._fetchingGenders) return;
			this._fetchingGenders = true;
			try {
				const data = await call("frappe.client.get_list", {
					doctype: "Gender",
					fields: ["name"],
					limit: 1000,
					order_by: "name",
				});
				if (data && data.length > 0) {
					this.genders = data.map((el) => el.name);
				}
			} finally {
				this._fetchingGenders = false;
			}
		},
		async submit_dialog() {
			if (this.submittingCustomer) return;
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
			if (this.birthday_input_str.trim()) {
				this.onBirthdayInput();
				// If text is present but onBirthdayInput couldn't produce a valid Date, block.
				if (!this.birthday) return;
			}
			this.submittingCustomer = true;
			const args = {
				customer_id: this.customer_id,
				customer_name: this.customer_name,
				company: this.pos_profile.company,
				tax_id: this.tax_id,
				mobile_no: this.mobile_no,
				email_id: this.email_id,
				referral_code: this.referral_code,
				birthday: this.birthday ? datetime.obj_to_str(this.birthday, "yyyy-mm-dd") : null,
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
			} finally {
				this.submittingCustomer = false;
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
		// Non-reactive in-flight flags — prevent duplicate concurrent API calls
		// if the dialog is opened again before the first fetch resolves.
		this._fetchingGroups = false;
		this._fetchingTerritories = false;
		this._fetchingGenders = false;

		this.eventBus.on("open_update_customer", (data) => {
			this.customerDialog = true;
			// Lazy-load reference data on first open only
			this.getCustomerGroups();
			this.getCustomerTerritorys();
			this.getGenders();
			if (data) {
				// Update mode: populate every field directly from the selected customer
				this.customer_id = data.name;
				this.customer_name = data.customer_name;
				this.tax_id = data.tax_id || "";
				this.mobile_no = data.mobile_no || "";
				this.email_id = data.email_id || "";
				this.referral_code = data.referral_code || "";
				this.birthday = data.birthday ? new Date(data.birthday) : null;
				this.birthday_input_str = this.birthday ? datetime.obj_to_str(this.birthday, "dd-mm-yyyy") : "";
				this.group = data.customer_group;
				this.territory = data.territory;
				this.customer_type = data.customer_type || "Individual";
				this.gender = data.gender || "";
				this.loyalty_points = data.loyalty_points ?? null;
				this.loyalty_program = data.loyalty_program ?? null;
			} else {
				// Create mode: start from a clean slate with user defaults
				this.clear_customer();
			}
		});
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		this.eventBus.on("payments_register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		// set default values for customer group and territory from user defaults
		this.group = window.user_defaults?.["Customer Group"] || "";
		this.territory = window.user_defaults?.["Territory"] || "";
	},
	beforeUnmount() {
		this.eventBus.off("open_update_customer");
		this.eventBus.off("register_pos_profile");
		this.eventBus.off("payments_register_pos_profile");
	},
};
</script>
