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
import connectivity from "@/offline/connectivity";
import { datetime } from "@/utils/datetime";
import { playSound } from "@/utils/sounds";
import { toast } from "vue3-toastify";
import { putCustomer } from "@/offline/repos/customers";
import { voidEntry as voidOutboxEntry } from "@/offline/outbox";

import busListeners from "@/utils/busListeners";
export default {
	mixins: [busListeners],
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
			const ddmmyyyy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
			const m = val.match(ddmmyyyy);
			if (m) {
				const parsed = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
				if (!isNaN(parsed)) d = parsed;
			}
			// Accept yyyy-mm-dd (with - or /)
			if (!d && /^\d{4}[/-]\d{2}[/-]\d{2}$/.test(val)) {
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
		/**
		 * Loads the three reference lists (Customer Group / Territory /
		 * Gender) used by this dialog's dropdowns from the offline-capable
		 * endpoint. One round-trip instead of three, and the result is
		 * cached for 12h via the registry's read-cache so subsequent opens
		 * — including offline ones — don't refetch and the dropdowns
		 * always have data to render.
		 *
		 * Falls back gracefully on offline + cold cache: the dropdowns
		 * stay empty and the dialog still opens; the cashier sees a
		 * "Territory not found" affordance rather than a crash.
		 */
		async loadCustomerFormOptions() {
			if (this._fetchingFormOptions) return;
			if (
				this.groups.length > 0 &&
				this.territorys.length > 0 &&
				this.genders.length > 0
			) {
				return;
			}
			this._fetchingFormOptions = true;
			try {
				const res = await call({
					method: "pospire.pospire.api.offline.get_customer_form_options",
					intent: "read",
					cacheKey: "offline.customer_form_options",
				});
				// Read calls served from the offline cache return a
				// StaleReadResult<{...}> wrapper; live reads return the
				// payload directly. Unwrap once so the rest of the method
				// only deals with the inner shape.
				const payload =
					res && typeof res === "object" && "stale" in res && "data" in res
						? res.data
						: res;
				if (!payload || typeof payload !== "object") return;
				if (Array.isArray(payload.customer_groups)) {
					this.groups = payload.customer_groups;
				}
				if (Array.isArray(payload.territories)) {
					this.territorys = payload.territories;
				}
				if (Array.isArray(payload.genders)) {
					this.genders = payload.genders;
				}
			} catch (err) {
				// Offline + cold cache, or transient server issue. Leave
				// the dropdowns empty rather than crashing the dialog.
				// eslint-disable-next-line no-console
				console.warn(
					"[UpdateCustomer] loadCustomerFormOptions failed",
					err,
				);
			} finally {
				this._fetchingFormOptions = false;
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
			// Edits ("update" path) are NOT offline-capable: the offline
			// create_customer endpoint is create-only and would either fail or
			// silently produce a duplicate. Block offline edits with a clear
			// message; create still works offline via the adapter.
			const isEdit = !!this.customer_id;
			if (isEdit && !connectivity.isOnline()) {
				toast.warning(
					__("Editing an existing customer requires an online connection."),
					{ autoClose: 4000 },
				);
				return;
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
				method: isEdit ? "update" : "create",
				pos_profile_doc: this.pos_profile,
			};
			try {
				const r = await call("pospire.pospire.api.posapp.create_customer", args);

				// Offline-enqueue ack: r.offline === true with provisional_name.
				// We treat it as success so the cashier can keep working — the
				// provisional name (OFFLINE-CUST-…) replaces r.name everywhere
				// the customer is referenced until sync resolves it server-side.
				if (r && r.offline === true && r.status === "enqueued") {
					const provisionalName = r.provisional_name;
					args.name = provisionalName;
					args.pos_offline_id = r.offline_id;

					// Persist the provisional row to the encrypted Dexie
					// customers table BEFORE the eventBus emits + toast.
					// The earlier code fire-and-forgot this — when it failed
					// (Dexie quota / schema blip / corruption), the outbox
					// row was already enqueued but the local picker had no
					// row, so a reload would lose the customer and the
					// cashier would re-create them. Two queued create_customer
					// rows for the same person → two real Customer docs at
					// sync.
					//
					// Failure mode now: AWAIT putCustomer; on failure, void
					// the just-enqueued outbox entry so the orphan queue
					// doesn't sync, surface a toast, and DON'T emit the
					// eventBus events that put the customer in the cart.
					// Cashier sees a clear failure message and can retry —
					// no silent data loss.
					try {
						await putCustomer({
							name: provisionalName,
							customer_name: args.customer_name,
							mobile_no: args.mobile_no || null,
							tax_id: args.tax_id || null,
							customer_group: args.customer_group || null,
							email_id: args.email_id || null,
							offline_created: true,
							offline_id: r.offline_id,
							cached_at: Date.now(),
						});
					} catch (err) {
						console.warn(
							"[UpdateCustomer] putCustomer failed; voiding orphan outbox entry",
							err,
						);
						// Best-effort rollback. Note: this is NOT a true
						// shared transaction — putCustomer and voidEntry
						// are both Dexie writes, so a storage-level fault
						// (quota exhausted, safe-mode, IndexedDB blocked)
						// can fail BOTH. The toast copy below branches on
						// the actual void outcome so the cashier doesn't
						// get told the queue was rolled back when it
						// wasn't. A real shared-transaction rewrite is
						// tracked as a backlog item; this branching keeps
						// the failure mode honest in the meantime.
						let voidSucceeded = false;
						try {
							await voidOutboxEntry(
								r.offline_id,
								"local customer cache write failed; rolling back to avoid orphan queue",
							);
							voidSucceeded = true;
						} catch (voidErr) {
							console.warn(
								"[UpdateCustomer] voidOutboxEntry failed during recovery — outbox row may need manual cleanup",
								voidErr,
							);
						}
						if (voidSucceeded) {
							toast.error(
								__(
									"Customer create failed (local cache write). The queue was rolled back; please try again.",
								),
								{ autoClose: 5000 },
							);
						} else {
							// Both Dexie writes failed — likely device
							// storage is unhealthy. The cashier's queue
							// has an orphan entry that needs manual
							// cleanup (manager-side via the recovery
							// queue once it reaches the server, or
							// dev-console deletion if it never does).
							// Surface the offline_id so support has a
							// concrete handle.
							toast.error(
								__(
									"Customer create failed AND rollback failed. Local storage may be unhealthy. Contact support; reference offline_id {0}.",
									[r.offline_id],
								),
								{ autoClose: 8000 },
							);
						}
						this.submittingCustomer = false;
						return;
					}

					toast.info(
						__("Customer queued offline. It will sync when online."),
						{ autoClose: 3000 },
					);
					playSound("submit");

					// add_customer_to_list MUST fire before set_customer so the
					// new entry is in the list when Customer.vue's watcher
					// derives offline_id by name lookup.
					this.eventBus.emit("add_customer_to_list", args);
					this.eventBus.emit("set_customer", provisionalName);
					this.close_dialog();
					return;
				}

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
		// Non-reactive in-flight flag — prevents duplicate concurrent fetches
		// if the dialog is opened again before the first request resolves.
		this._fetchingFormOptions = false;

		this.onBus("open_update_customer", (data) => {
			this.customerDialog = true;
			// Lazy-load reference data on first open only. Pos.vue
			// pre-warms the same cache on shift-open so this is usually a
			// cache hit (including when offline).
			this.loadCustomerFormOptions();
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
		this.onBus("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		this.onBus("payments_register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		// set default values for customer group and territory from user defaults
		this.group = window.user_defaults?.["Customer Group"] || "";
		this.territory = window.user_defaults?.["Territory"] || "";
	},
};
</script>
