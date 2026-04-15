<template>
	<v-dialog :model-value="modelValue" max-width="480px" persistent>
		<v-card class="pospire-modal">
			<!-- Reason: cashier optionally explains why before request is created -->
			<template v-if="step === 'reason'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-warning">
						<v-icon size="24">mdi-shield-lock-outline</v-icon>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Approval Required") }}</div>
						<div class="text-body-2">{{ actionLabel }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					<div v-if="showValueSummary" class="mb-3 pa-2 rounded" style="background: #f5f5f5">
						<span v-if="valueFieldLabel" class="text-caption font-weight-medium">{{ valueFieldLabel }}: </span>
						<span v-if="originalValue !== null" class="text-decoration-line-through text-medium-emphasis text-body-2">{{ formatSummaryValue(originalValue) }}</span>
						<v-icon v-if="requestedValue !== null" size="14" class="mx-1">mdi-arrow-right</v-icon>
						<span v-if="requestedValue !== null" class="text-body-2 font-weight-medium">{{ formatSummaryValue(requestedValue) }}</span>
					</div>
					<v-textarea
						v-model="reason"
						:label="__('Reason for change (optional)')"
						variant="outlined"
						density="compact"
						rows="3"
						hide-details
						auto-grow
					></v-textarea>
				</v-card-text>
				<v-card-actions class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="close(false)">{{ __("Cancel") }}</v-btn>
					<v-btn class="btn-primary-action" @click="start">{{ __("Request Approval") }}</v-btn>
				</v-card-actions>
			</template>

			<!-- Loading: creating request -->
			<template v-else-if="step === 'loading'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-teal">
						<v-progress-circular indeterminate size="24" color="white" width="2"></v-progress-circular>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Requesting Approval") }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					{{ __("Setting up approval request...") }}
				</v-card-text>
			</template>

			<!-- Choose mode: both PIN and Remote are configured -->
			<template v-else-if="step === 'choose'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-warning">
						<v-icon size="24">mdi-shield-lock-outline</v-icon>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Approval Required") }}</div>
						<div class="text-body-2">{{ actionLabel }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					<div class="text-body-2 mb-4">{{ __("How would you like to get approval?") }}</div>
					<v-row>
						<v-col :cols="remoteApprovalEnabled && actionConfig && actionConfig.remote_approval ? 6 : 12">
							<v-btn block variant="tonal" color="primary" height="60" @click="step = 'pin'">
								<div class="d-flex flex-column align-center">
									<v-icon size="22">mdi-key-variant</v-icon>
									<span class="text-caption mt-1">{{ __("Manager PIN") }}</span>
								</div>
							</v-btn>
						</v-col>
						<v-col v-if="remoteApprovalEnabled && actionConfig && actionConfig.remote_approval" cols="6">
							<v-btn block variant="tonal" color="secondary" height="60" @click="pick_remote_manager">
								<div class="d-flex flex-column align-center">
									<v-icon size="22">mdi-remote</v-icon>
									<span class="text-caption mt-1">{{ __("Remote Approval") }}</span>
								</div>
							</v-btn>
						</v-col>
					</v-row>
				</v-card-text>
				<v-card-actions class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="cancel">{{ __("Cancel") }}</v-btn>
				</v-card-actions>
			</template>

			<!-- Remote manager picker (shown before waiting when both modes available) -->
			<template v-else-if="step === 'remote_pick'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-warning">
						<v-icon size="24">mdi-remote</v-icon>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Select Manager") }}</div>
						<div class="text-body-2">{{ actionLabel }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					<div class="text-body-2 mb-3">{{ __("Choose a manager to send this request to, or leave blank to notify all.") }}</div>
					<v-select
						v-model="selected_remote_manager"
						:items="[{ full_name: __('All Managers'), user: null }, ...managers]"
						item-title="full_name"
						item-value="user"
						:label="__('Notify Manager (optional)')"
						variant="outlined"
						density="compact"
					></v-select>
				</v-card-text>
				<v-card-actions class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="step = 'choose'">{{ __("Back") }}</v-btn>
					<v-btn class="btn-primary-action" @click="send_remote_request">{{ __("Send Request") }}</v-btn>
				</v-card-actions>
			</template>

			<!-- PIN Entry -->
			<template v-else-if="step === 'pin'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-warning">
						<v-icon size="24">mdi-key-outline</v-icon>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Manager PIN Required") }}</div>
						<div class="text-body-2">{{ actionLabel }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					<div v-if="showValueSummary" class="mb-3 pa-2 rounded" style="background: #f5f5f5">
						<span v-if="valueFieldLabel" class="text-caption font-weight-medium">{{ valueFieldLabel }}: </span>
						<span v-if="originalValue !== null" class="text-decoration-line-through text-medium-emphasis text-body-2">{{ formatSummaryValue(originalValue) }}</span>
						<v-icon v-if="requestedValue !== null" size="14" class="mx-1">mdi-arrow-right</v-icon>
						<span v-if="requestedValue !== null" class="text-body-2 font-weight-medium">{{ formatSummaryValue(requestedValue) }}</span>
					</div>
					<v-select
						v-model="selected_manager"
						:items="managers"
						item-title="full_name"
						item-value="user"
						:label="__('Select Manager')"
						variant="outlined"
						density="compact"
						class="mb-2"
					></v-select>
					<v-text-field
						v-model="pin_input"
						:label="__('Manager PIN')"
						:type="show_pin ? 'text' : 'password'"
						:append-inner-icon="show_pin ? 'mdi-eye-off' : 'mdi-eye'"
						@click:append-inner="show_pin = !show_pin"
						variant="outlined"
						density="compact"
						:error-messages="attempt_error ? [attempt_error] : []"
						@keyup.enter="submit_pin"
						autofocus
					></v-text-field>
					<v-textarea
						v-model="resolution_note"
						:label="__('Resolution note (optional)')"
						variant="outlined"
						density="compact"
						rows="2"
						hide-details
						auto-grow
						class="mt-2"
					></v-textarea>
				</v-card-text>
				<v-card-actions class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="cancel">{{ __("Cancel") }}</v-btn>
					<v-btn
						class="btn-primary-action"
						:loading="loading"
						:disabled="!selected_manager || !pin_input"
						@click="submit_pin"
					>{{ __("Approve") }}</v-btn>
				</v-card-actions>
			</template>

			<!-- Remote Waiting -->
			<template v-else-if="step === 'waiting'">
				<v-card-title class="pospire-modal-header">
					<div class="pospire-modal-icon icon-teal">
						<v-progress-circular indeterminate size="24" color="white" width="2"></v-progress-circular>
					</div>
					<div>
						<div class="pospire-modal-title">{{ __("Waiting for Manager") }}</div>
						<div class="text-body-2">{{ actionLabel }}</div>
					</div>
				</v-card-title>
				<v-card-text class="pospire-modal-body">
					<div v-if="showValueSummary" class="mb-3 pa-2 rounded" style="background: #f5f5f5">
						<span v-if="valueFieldLabel" class="text-caption font-weight-medium">{{ valueFieldLabel }}: </span>
						<span v-if="originalValue !== null" class="text-decoration-line-through text-medium-emphasis text-body-2">{{ formatSummaryValue(originalValue) }}</span>
						<v-icon v-if="requestedValue !== null" size="14" class="mx-1">mdi-arrow-right</v-icon>
						<span v-if="requestedValue !== null" class="text-body-2 font-weight-medium">{{ formatSummaryValue(requestedValue) }}</span>
					</div>
					<p class="text-body-2 text-medium-emphasis text-center">
						{{ __("A manager can approve or reject this request from their screen.") }}
					</p>
				</v-card-text>
				<v-card-actions class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="cancel">{{ __("Cancel Request") }}</v-btn>
				</v-card-actions>
			</template>

			<!-- Result -->
			<template v-else-if="step === 'result'">
				<v-card-title class="pospire-modal-header">
					<div :class="['pospire-modal-icon', result === 'Approved' ? 'icon-success' : 'icon-danger']">
						<v-icon size="24">{{ result === "Approved" ? "mdi-check-circle-outline" : "mdi-close-circle-outline" }}</v-icon>
					</div>
					<div>
						<div class="pospire-modal-title">{{ resultTitle }}</div>
						<div v-if="resolved_by_name" class="text-body-2">{{ __("by {0}", [resolved_by_name]) }}</div>
					</div>
				</v-card-title>
				<v-card-text v-if="resolution_note" class="pospire-modal-body">{{ resolution_note }}</v-card-text>
				<v-card-actions v-if="result !== 'Approved'" class="pospire-modal-actions">
					<v-spacer></v-spacer>
					<v-btn class="pospire-modal-btn-secondary" @click="close(false)">{{ __("Close") }}</v-btn>
				</v-card-actions>
			</template>
		</v-card>
	</v-dialog>
</template>

<script>
import { call } from "frappe-ui";
import { toast } from "vue3-toastify";

export default {
	props: {
		modelValue: { type: Boolean, default: false },
		actionType: { type: String, required: true },
		actionConfig: { type: Object, default: () => ({}) },
		remoteApprovalEnabled: { type: Boolean, default: false },
		managers: { type: Array, default: () => [] },
		posProfile: { type: String, default: "" },
		posOpeningShift: { type: String, default: "" },
		itemCode: { type: String, default: null },
		itemName: { type: String, default: null },
		originalValue: { type: Number, default: null },
		requestedValue: { type: Number, default: null },
		valueFieldLabel: { type: String, default: null },
		invoiceName: { type: String, default: null },
		currency: { type: String, default: "" },
	},

	emits: ["update:modelValue", "approved", "rejected"],

	data() {
		return {
			step: "reason",
			request_name: null,
			reason: "",
			resolution_note: "",
			selected_manager: null,
			selected_remote_manager: null,
			pin_input: "",
			show_pin: false,
			attempt_error: null,
			loading: false,
			result: null,
			resolved_by_name: null,
		};
	},

	computed: {
		actionLabel() {
			return this.itemName ? `${this.actionType} — ${this.itemName}` : this.actionType;
		},
		resultTitle() {
			if (this.result === "Approved") return __("Approved");
			if (this.result === "Expired") return __("Request Expired");
			return __("Rejected");
		},
		showValueSummary() {
			return this.originalValue !== null || this.requestedValue !== null;
		},
	},

	mounted() {
		if (this.modelValue) this.step = "reason";
	},

	watch: {
		modelValue(val) {
			if (val) this.step = "reason";
		},
	},

	methods: {
		async start() {
			this.step = "loading";
			this.request_name = null;
			this.attempt_error = null;
			this.result = null;
			this.selected_manager = null;
			this.selected_remote_manager = null;
			this.pin_input = "";
			this.resolution_note = "";
			this._stop_status_poll();

			try {
				const { pin_approval, remote_approval } = this.actionConfig || {};
				const both_modes = !!(pin_approval && remote_approval && this.remoteApprovalEnabled);

				const r = await call("pospire.pospire.api.approval.create_approval_request", {
					pos_profile: this.posProfile,
					action_type: this.actionType,
					pos_opening_shift: this.posOpeningShift || null,
					invoice: this.invoiceName || null,
					item_code: this.itemCode || null,
					item_name: this.itemName || null,
					original_value: this.originalValue ?? null,
					requested_value: this.requestedValue ?? null,
					value_field_label: this.valueFieldLabel || null,
					reason: this.reason || null,
					broadcast: !both_modes,
				});
				this.request_name = r.name;
				window.frappe?.realtime?.on("pos_approval_resolved", this._on_resolved);
				this._set_initial_step();
				this._start_status_poll();
			} catch {
				toast.error(__("Failed to create approval request"));
				this.close(false);
			}
		},

		_set_initial_step() {
			const { pin_approval, remote_approval } = this.actionConfig || {};
			const remote_available = !!(remote_approval && this.remoteApprovalEnabled);
			if (pin_approval && remote_available) {
				this.step = "choose";
			} else if (pin_approval) {
				this.step = "pin";
			} else {
				this.step = "waiting";
			}
		},

		pick_remote_manager() {
			this.selected_remote_manager = null;
			this.step = "remote_pick";
		},

		async send_remote_request() {
			// Always broadcast at this point — cashier has chosen remote mode.
			// selected_remote_manager is null → notify all eligible managers.
			try {
				await call("pospire.pospire.api.approval.notify_remote_manager", {
					request_name: this.request_name,
					selected_manager: this.selected_remote_manager || null,
				});
			} catch {
				// non-fatal — fall through to waiting
			}
			this.step = "waiting";
		},

		_start_status_poll() {
			this._stop_status_poll();
			this._poll_interval = setInterval(async () => {
				if (!this.request_name || this.step === "result") {
					this._stop_status_poll();
					return;
				}
				try {
					const r = await call("pospire.pospire.api.approval.get_approval_request_status", {
						request_name: this.request_name,
					});
					if (r && r.status && r.status !== "Pending") {
						this._on_resolved({
							request_name: this.request_name,
							status: r.status,
							resolved_by_full_name: r.resolved_by_full_name || null,
							resolution_note: r.resolution_note || null,
						});
					}
				} catch {
					// ignore poll errors
				}
			}, 5000);
		},

		_stop_status_poll() {
			if (this._poll_interval) {
				clearInterval(this._poll_interval);
				this._poll_interval = null;
			}
		},

		async submit_pin() {
			if (!this.selected_manager || !this.pin_input) return;
			this.loading = true;
			this.attempt_error = null;
			try {
				await call("pospire.pospire.api.approval.verify_pin_and_approve", {
					request_name: this.request_name,
					pin: this.pin_input,
					manager_user: this.selected_manager,
					resolution_note: this.resolution_note || null,
				});
				this._on_resolved({ request_name: this.request_name, status: "Approved" });
			} catch (e) {
				this.attempt_error = this._parse_pin_error(e);
			} finally {
				this.loading = false;
				this.pin_input = "";
			}
		},

		_parse_pin_error(e) {
			const raw = String(e?.message || "").toLowerCase();
			if (raw.includes("lockout") || raw.includes("too many") || raw.includes("locked")) {
				return __("Too many failed attempts. Please wait 15 minutes before trying again.");
			}
			if (raw.includes("expired") || raw.includes("not pending")) {
				return __("This approval request has expired. Please start a new one.");
			}
			if (raw.includes("role") || raw.includes("permission")) {
				return __("This manager is not authorised to approve this action.");
			}
			return __("Incorrect PIN. Please try again.");
		},

		_on_resolved(data) {
			if (data.request_name !== this.request_name) return;
			this.result = data.status;
			this.resolved_by_name = data.resolved_by_full_name || null;
			this.resolution_note = data.resolution_note || null;
			this.step = "result";
			window.frappe?.realtime?.off("pos_approval_resolved", this._on_resolved);
			if (data.status === "Approved") {
				setTimeout(() => this.close(true, this.request_name), 1200);
			}
		},

		cancel() {
			this._stop_status_poll();
			if (this.request_name) {
				call("pospire.pospire.api.approval.cancel_approval_request", {
					request_name: this.request_name,
				}).catch(() => {});
			}
			this.reason = "";
			this.close(false);
		},

		close(approved, request_name) {
			this._stop_status_poll();
			window.frappe?.realtime?.off("pos_approval_resolved", this._on_resolved);
			this.$emit("update:modelValue", false);
			this.$emit(approved ? "approved" : "rejected", request_name || null);
		},

		formatSummaryValue(val) {
			if (val === null || val === undefined) return "";
			const symbol = window.get_currency_symbol?.(this.currency) || "";
			return typeof val === "number" ? `${symbol}${val.toFixed(2)}` : String(val);
		},
	},

	beforeUnmount() {
		this._stop_status_poll();
		window.frappe?.realtime?.off("pos_approval_resolved", this._on_resolved);
	},
};
</script>
