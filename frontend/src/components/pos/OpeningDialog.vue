<template>
	<v-dialog
		v-model="isOpen"
		persistent
		max-width="1100"
		scrollable
		:fullscreen="isFullscreen"
	>
		<v-card
			:rounded="isFullscreen ? 0 : 'xl'"
			elevation="8"
			class="opening-shift-card d-flex flex-column"
			:class="{ 'opening-shift-card--fullscreen': isFullscreen }"
		>
			<v-card-title
				class="d-flex align-center px-4 px-sm-6 py-4 enhanced-modal-header"
			>
				<v-avatar rounded="lg" size="40" color="primary" variant="tonal" class="mr-3 mr-sm-4">
					<v-icon icon="mdi-cash-register" size="22" color="primary" />
				</v-avatar>
				<div class="flex-grow-1 min-width-0">
					<div class="text-h6 font-weight-bold">{{ __("Create Opening Shift") }}</div>
					<div class="text-body-2 text-medium-emphasis d-none d-sm-block">
						{{ __("Set opening cash and review active payment modes") }}
					</div>
				</div>
				<!--
					Hidden while a close is queued: go_desk() navigates to /app
					and tears down the SPA, which on that path would strand the
					cashier with a locked shift and no till. See can_exit_dialog
					for the never-trap invariant that bounds this. Unchanged on
					a normal open-shift dialog.
				-->
				<v-btn
					v-if="can_exit_dialog"
					icon="mdi-close"
					variant="text"
					@click="go_desk"
				></v-btn>
			</v-card-title>

			<v-divider />

			<v-card-text class="overflow-y-auto pa-4 pa-sm-6 flex-grow-1">
				<v-alert
					v-if="config_unavailable"
					type="warning"
					variant="tonal"
					class="mb-4"
				>
					{{ __("POS configuration could not be loaded on this device. If you are offline, connect once to load it; if you are online, the server refused the request. Check that your account has POS access, then reopen this dialog.") }}
				</v-alert>
				<v-alert
					v-else-if="config_is_stale"
					type="info"
					variant="tonal"
					density="compact"
					class="mb-4"
				>
					{{ __("Showing saved POS configuration. It will refresh when the connection returns.") }}
				</v-alert>

				<v-row>
					<!-- Left panel: profile selection + payment modes overview -->
					<v-col cols="12" :md="denominations_enabled ? 5 : 6">
						<v-card variant="outlined" rounded="lg" class="pa-4 h-100 d-flex flex-column">
							<v-autocomplete
								v-model="company"
								:items="companies"
								:label="__('Store')"
								density="comfortable"
								variant="outlined"
								prepend-inner-icon="mdi-domain"
								hide-details
								class="mb-4"
								required
							/>

							<v-autocomplete
								v-model="pos_profile"
								:items="pos_profiles"
								:label="__('POS Profile')"
								density="comfortable"
								variant="outlined"
								prepend-inner-icon="mdi-monitor"
								hide-details
								class="mb-4"
								required
							/>

							<div class="d-flex align-center justify-center mb-4 store-logo-wrap">
								<img
									:src="selectedCompanyLogo || '/assets/pospire/images/app-128x128-rounded.png'"
									:alt="company || 'POSpire'"
									class="store-logo-img"
								/>
							</div>

							<div class="d-flex align-center mb-2">
								<span class="text-subtitle-2 font-weight-bold">
									{{ __("Available Payment Modes") }}
								</span>
								<v-tooltip :text="__('Cash is entered below. Other modes are available for sales during the shift but are not counted here.')">
									<template #activator="{ props }">
										<v-icon
											v-bind="props"
											icon="mdi-information-outline"
											size="16"
											class="ml-1 text-medium-emphasis"
										/>
									</template>
								</v-tooltip>
							</div>

							<!--
								CSS grid, not v-row/v-col: Vuetify's cols/sm
								breakpoints are viewport-width based, but this grid
								lives inside a md="5" column — a fraction of the
								dialog, not the viewport. At a wide viewport (e.g.
								1920px) that column is still only ~5/12 of the
								dialog width, so a viewport-keyed "3 across" rule
								stayed 3-across even when the column had room for
								more, forcing modes like "Credit Card" to truncate
								on a big monitor but not on a narrower tablet.
								auto-fill/minmax responds to the column's actual
								rendered width instead.
							-->
							<div class="payment-mode-grid mb-2">
								<v-card
									v-for="pm in payments_methods"
									:key="pm.mode_of_payment"
									:variant="isCashMode(pm) ? 'tonal' : 'outlined'"
									:color="isCashMode(pm) ? 'primary' : undefined"
									rounded="lg"
									class="pa-3 d-flex align-center payment-mode-chip"
								>
									<v-icon
										:icon="paymentModeIcon(pm.mode_of_payment)"
										size="20"
										class="mr-2"
										:color="isCashMode(pm) ? 'primary' : undefined"
									/>
									<span class="text-body-2 flex-grow-1 text-truncate">
										{{ pm.mode_of_payment }}
									</span>
									<v-icon
										v-if="isCashMode(pm)"
										icon="mdi-check-circle"
										size="18"
										color="primary"
									/>
								</v-card>
							</div>
							<div class="text-caption text-medium-emphasis mb-4">
								{{ __("All modes are available for transactions during the shift.") }}
							</div>
						</v-card>
					</v-col>

					<!-- Right panel: cash entry -->
					<v-col cols="12" :md="denominations_enabled ? 7 : 6">
						<v-card variant="outlined" rounded="lg" class="pa-4 h-100">
							<v-expand-transition>
								<div v-if="denominations_enabled">
									<div class="d-flex align-center mb-1">
										<v-icon icon="mdi-cash" class="mr-2" color="primary" />
										<span class="text-subtitle-1 font-weight-bold">
											{{ __("Opening Cash (Cash Only)") }}
										</span>
									</div>
									<div class="text-body-2 text-medium-emphasis mb-4">
										{{ __("Enter quantity for each denomination in cash drawer.") }}
									</div>

									<!--
										CSS grid, not v-row/v-col — same reasoning as
										the payment chip grid above: a stepper row
										(two 44px buttons + the qty field) needs
										~160px, which cols="6" doesn't reliably give
										at xs (this column's extra padding makes it
										worse than ClosingDialog's), squashing the
										buttons back under the touch minimum.
										auto-fill/minmax sizes off the actual
										container width instead of a viewport
										breakpoint.
									-->
									<div class="denom-grid">
										<v-card
											v-for="row in denomination_rows"
											:key="row.denomination"
											variant="outlined"
											rounded="lg"
											class="pa-3 denom-card"
										>
											<div class="d-flex align-center justify-space-between mb-2">
												<span class="text-body-2 font-weight-bold text-truncate">
													{{ formatCurrency(row.denomination_value) }} {{ __("Note") }}
												</span>
												<v-icon icon="mdi-cash" size="16" color="success" />
											</div>
											<div class="d-flex align-center justify-center mb-2">
												<v-btn
													icon="mdi-minus"
													size="44"
													variant="tonal"
													:disabled="!row.quantity"
													:aria-label="__('Decrease quantity for ') + row.denomination_name"
													class="denom-stepper-btn"
													@click="decrementDenom(row)"
												/>
												<v-text-field
													v-model.number="row.quantity"
													type="number"
													min="0"
													density="compact"
													variant="plain"
													hide-details
													:aria-label="__('Quantity')"
													class="denom-qty-input mx-2"
												/>
												<v-btn
													icon="mdi-plus"
													size="44"
													variant="tonal"
													:aria-label="__('Increase quantity for ') + row.denomination_name"
													class="denom-stepper-btn"
													@click="incrementDenom(row)"
												/>
											</div>
											<div class="text-body-2 text-medium-emphasis text-center">
												{{ currencySymbol(row.currency) }}{{ formatCurrency(row.denomination_value * (row.quantity || 0)) }}
											</div>
										</v-card>
									</div>

									<v-divider class="my-4" />

									<div class="d-flex align-center denom-summary">
										<v-avatar rounded="lg" color="primary" variant="tonal" size="40" class="mr-3">
											<v-icon icon="mdi-credit-card-outline" color="primary" />
										</v-avatar>
										<div>
											<div class="text-caption text-medium-emphasis">{{ __("Counted Cash Total") }}</div>
											<div class="text-h6 font-weight-bold text-primary">
												{{ currencySymbol(pos_profile.currency) }}{{ formatCurrency(denominationTotal) }}
											</div>
										</div>
									</div>
								</div>

								<div v-else>
									<div class="d-flex align-center mb-1">
										<v-icon icon="mdi-cash" class="mr-2" color="primary" />
										<span class="text-subtitle-1 font-weight-bold">{{ __("Opening Cash") }}</span>
									</div>
									<div class="text-body-2 text-medium-emphasis mb-4">
										{{ __("Enter the opening cash amount for this shift.") }}
									</div>
									<v-text-field
										v-if="cashPaymentMethod"
										v-model.number="cashPaymentMethod.amount"
										type="number"
										min="0"
										variant="outlined"
										density="comfortable"
										:prefix="currencySymbol(pos_profile.currency)"
										:label="__('Opening Amount')"
										:rules="amountRules"
										hide-details
									/>
									<div v-else class="text-body-2 text-medium-emphasis">
										{{ __("Select a Company and POS Profile to continue.") }}
									</div>
								</div>
							</v-expand-transition>
						</v-card>
					</v-col>
				</v-row>
			</v-card-text>

			<v-divider />
			<v-card-actions
				class="px-4 px-sm-6 py-4"
				:class="isNarrow ? 'flex-column ga-2' : ''"
			>
				<v-btn
					variant="text"
					color="grey-darken-1"
					:block="isNarrow"
					@click="show_reset_confirm = true"
				>
					{{ __("Reset") }}
				</v-btn>
				<v-spacer v-if="!isNarrow" />
				<!-- Same exit, same reason, same invariant — hiding only the
					 header X would leave the escape hatch wide open. -->
				<v-btn
					v-if="can_exit_dialog"
					variant="outlined"
					color="grey-darken-1"
					:block="isNarrow"
					@click="go_desk"
				>
					{{ __("Cancel") }}
				</v-btn>
				<v-btn
					variant="elevated"
					color="primary"
					append-icon="mdi-arrow-right"
					:loading="is_loading"
					:disabled="is_loading || config_unavailable"
					:block="isNarrow"
					@click="submit_dialog"
				>
					{{ __("Create Opening Shift") }}
				</v-btn>
			</v-card-actions>
		</v-card>

		<ResetConfirmDialog
			v-model="show_reset_confirm"
			@confirm="reset_form"
			@cancel="show_reset_confirm = false"
		/>
	</v-dialog>
</template>

<script>
import { call, isStaleReadResult, unwrapStale } from "@/utils/call";
import { OPENING_DIALOG_CACHE_KEY } from "@/utils/call-registry";
import connectivity from "@/offline/connectivity";
import format from "@/utils/format";
import { toast } from "vue3-toastify";
import { amountRules, isAmountValid } from "@/utils/validation";
import { paymentModeIcon } from "@/utils/paymentModeIcon";
import ResetConfirmDialog from "@/components/pos/ResetConfirmDialog.vue";
export default {
	components: { ResetConfirmDialog },
	mixins: [format],
	// `closingPending` comes in as a prop rather than over the eventBus: this
	// dialog is `v-if`-ed into existence BY the offline-close path, so a
	// `shift_closing_pending` event emitted there always fires before the
	// component (and any listener it would register) exists.
	props: ["dialog", "closingPending"],
	data() {
		return {
			isOpen: this.dialog ? this.dialog : false,
			dialog_data: {},
			is_loading: false,
			show_reset_confirm: false,
			companies: [],
			company_logos: {},
			company: "",
			pos_profiles_data: [],
			pos_profiles: [],
			pos_profile: "",
			payments_method_data: [],
			payments_methods: [],
			amountRules,
			pagination: {},
			snack: false, // TODO : need to remove
			snackColor: "", // TODO : need to remove
			snackText: "", // TODO : need to remove
			denomination_config: {},
			denomination_rows: [],
			denominations_enabled: false,
			config_is_stale: false,
			config_unavailable: false,
			unsubConnectivity: null,
			/**
			 * Inputs to `submit_can_never_succeed` that live outside Vue's
			 * reactivity (a connectivity module, localStorage). Refreshed by
			 * `refresh_submit_gate()` on create and on every connectivity
			 * change — the only two moments either can change while this
			 * dialog is on screen. The outbox store is reactive on its own,
			 * so it is read directly in the computed instead.
			 */
			is_online: true,
			snapshot_usable: true,
			outbox_store: null,
		};
	},
	computed:{
			/** Narrow viewport. Drives anything that stacks or reflows for width. */
			isNarrow() {
				return this.$vuetify.display.smAndDown;
			},
			/** Narrow OR short. Drives fullscreen only — a short-but-wide laptop
			 *  window shouldn't lose the two-column layout just to fit vertically. */
			isFullscreen() {
				return this.isNarrow || this.$vuetify.display.height < 700;
			},

			denominationTotal() {
		if (!this.denomination_rows.length) return 0;

		return this.denomination_rows.reduce((sum, row) => {
			return sum + (row.denomination_value * (row.quantity || 0));
		}, 0);
	},

			/**
			 * Cash MOP for the selected profile, straight from the server
			 * policy. Never falls back to a snapshot — Task 6 deletes the
			 * snapshot dependency, and reintroducing it here would restore the
			 * second source of truth by the back door. The literal "Cash" is a
			 * last resort only for profiles that send no policy at all.
			 */
			cashModeForSelectedProfile() {
				return this.denomination_config[this.pos_profile]?.cash_mode || "Cash";
			},

			/** Selected store's uploaded logo, or null to show the POSpire fallback mark. */
			selectedCompanyLogo() {
				return this.company_logos[this.company] || null;
			},

			/** Payment mode row matching the profile's cash mode, or null before one loads. */
			cashPaymentMethod() {
				return (
					this.payments_methods.find(
						(p) => p.mode_of_payment === this.cashModeForSelectedProfile,
					) || null
				);
			},

			/** Every payment mode except cash — informational only, not entered here. */
			otherPaymentMethods() {
				return this.payments_methods.filter(
					(p) => p.mode_of_payment !== this.cashModeForSelectedProfile,
				);
			},

			/**
			 * Display total for the "Opening Cash Total" summary card. Mirrors
			 * whichever figure is authoritative: the denomination sum when the
			 * breakdown grid is in play (same value the `denominationTotal`
			 * watcher already writes into the cash row), otherwise the cash
			 * row's own amount.
			 */
			cashTotal() {
				return this.denominations_enabled
					? this.denominationTotal
					: this.cashPaymentMethod?.amount || 0;
			},

			/**
			 * Submit is bound to `:disabled="is_loading || config_unavailable"`,
			 * but `submit_dialog` has its OWN refuse-conditions that leave the
			 * button enabled and simply return — so the button can be enabled
			 * yet guaranteed to get the cashier nowhere. Every such condition
			 * has to be mirrored here, because `can_exit_dialog` below is what
			 * stops that turning into a locked-in dialog.
			 *
			 * Named for the property that matters (`can never succeed`), not
			 * for how it fails: two of the three are toast-and-return, not
			 * silent no-ops, but a toast the cashier can do nothing about is
			 * not a way forward.
			 *
			 * The three, in `submit_dialog`'s own order:
			 *   1. no usable form (no payment rows / no company / no profile)
			 *      — the original `submit_is_inert`;
			 *   2. offline with the chained-shift cap reached (>= 3 unsynced
			 *      openings). Reachable by a supported flow: open offline,
			 *      close offline, three times over. Only reconnecting clears
			 *      it, which is precisely what a trapped cashier cannot do
			 *      from inside a `persistent` dialog;
			 *   3. offline with no usable opening snapshot — same shape,
			 *      narrower trigger.
			 * Conditions 2 and 3 are gated on `is_online` because
			 * `submit_dialog` only evaluates them on the offline branch.
			 *
			 * NOT mirrored: the two validation toasts (negative denomination
			 * quantity, invalid amount). Those describe input the cashier can
			 * correct in this dialog, so Submit CAN succeed after a fix — they
			 * are feedback, not a dead end.
			 *
			 * The `?? 0` on the outbox count mirrors `submit_dialog`'s own
			 * fail-open behaviour when the store is unavailable: if the gate
			 * would not fire, this must not claim it would.
			 */
			submit_can_never_succeed() {
				if (
					!this.payments_methods.length ||
					!this.company ||
					!this.pos_profile
				) {
					return true;
				}
				if (this.is_online) return false;
				if ((this.outbox_store?.unsyncedOpeningCount ?? 0) >= 3) return true;
				return !this.snapshot_usable;
			},

			/**
			 * INVARIANT: this dialog must never present zero USABLE controls.
			 * It is `persistent`, so there is no click-away or Esc, and both
			 * exits (header X, Cancel) call the same `go_desk()`. So the
			 * closing-pending gate is lifted the moment Submit cannot get the
			 * cashier out of here — whether because it is disabled
			 * (`config_unavailable`, i.e. offline with a cold config cache,
			 * precisely the case that follows an offline close) or because it
			 * is enabled but guaranteed to refuse (`submit_can_never_succeed`
			 * — no usable profile, the chained-shift cap, or no opening
			 * snapshot). Either way the cashier keeps a way forward or a way
			 * out, always.
			 *
			 * `is_loading` deliberately does NOT lift the gate: it is transient,
			 * self-clearing in submit_dialog's `finally`, and entered only by
			 * the cashier's own action — not a trap, and flickering the exits
			 * on every submit would be worse.
			 */
			can_exit_dialog() {
				return (
					!this.closingPending ||
					this.config_unavailable ||
					this.submit_can_never_succeed
				);
			},

	},
	watch: {
		company(val) {
			this.pos_profiles = [];
			this.pos_profiles_data.forEach((element) => {
				if (element.company === val) {
					this.pos_profiles.push(element.name);
				}
				if (this.pos_profiles.length) {
					this.pos_profile = this.pos_profiles[0];
				} else {
					this.pos_profile = "";
				}
			});
		},
		pos_profile(val) {
			this.payments_methods = [];
			this.payments_method_data.forEach((element) => {
				if (element.parent === val) {
					this.payments_methods.push({
						mode_of_payment: element.mode_of_payment,
						amount: 0,
						currency: element.currency,
					});
				}
			});
			const config = this.denomination_config[val];
			if (config?.denominations?.length) {
				this.denominations_enabled = true;
				this.denomination_rows = config.denominations.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: 0,
					amount: 0,
				}));
			} else {
				this.denominations_enabled = false;
				this.denomination_rows = [];
				if (config) {
					toast.warning(__("Cash denominations are enabled for this profile but no denomination rows are configured."), {
						autoClose: 5000,
					});
				}
			}
		},
		denominationTotal(newVal) {
			if (!this.denominations_enabled) return;

			const config = this.denomination_config[this.pos_profile];
			if (!config) return;

			const cashMode = config.cash_mode;

			const cashRow = this.payments_methods.find(
				(p) => p.mode_of_payment === cashMode
			);

			if (cashRow) {
				cashRow.amount = newVal;
			}
		},
	},
	created: function () {
		// Before the first paint: `can_exit_dialog` reads this, and defaulting
		// to "online, snapshot fine" for a tick would flash the exits away on
		// a dialog that is genuinely exit-worthy.
		this.refresh_submit_gate();
		this.$nextTick(function () {
			this.get_opening_dialog_data();
		});
	},
	mounted() {
		// Dynamic, and tolerant of failure, for the same reason submit_dialog's
		// own chained-shifts gate is: the store may not be initialised yet.
		// `submit_can_never_succeed` fails open on a null store, matching what
		// submit_dialog itself does when the import fails.
		import("@/stores/outbox")
			.then(({ useOutboxStore }) => {
				this.outbox_store = useOutboxStore();
			})
			.catch((err) => {
				console.warn("[OpeningDialog] outbox store unavailable", err);
			});
		// isOnline() needs THRESHOLD_ONLINE = 3 consecutive successful pings
		// before it flips back, and any offline:false read throws without
		// touching the network during that window. A dialog opened in the
		// gap would otherwise stay on stale config for its whole lifetime.
		this.unsubConnectivity = connectivity.onChange(() => {
			// Unconditional, and before the early returns below: connectivity
			// is one of the two inputs to the never-trap gate, and going
			// offline (which takes neither branch below) is exactly when the
			// exits need to come back.
			this.refresh_submit_gate();
			if (!connectivity.isOnline()) return;
			if (!this.config_is_stale && !this.config_unavailable) return;
			this.refresh_dialog_config();
		});
	},
	beforeUnmount() {
		if (this.unsubConnectivity) this.unsubConnectivity();
	},
	methods: {
		isCashMode(pm) {
			return pm.mode_of_payment === this.cashModeForSelectedProfile;
		},
		paymentModeIcon,
		incrementDenom(row) {
			row.quantity = (row.quantity || 0) + 1;
		},
		decrementDenom(row) {
			row.quantity = Math.max(0, (row.quantity || 0) - 1);
		},
		/** Clears entered amounts/quantities only — Store and POS Profile selections are left as-is. */
		reset_form() {
			this.payments_methods.forEach((p) => {
				p.amount = 0;
			});
			this.denomination_rows.forEach((row) => {
				row.quantity = 0;
			});
			this.show_reset_confirm = false;
		},
		close_opening_dialog() {
			this.eventBus.emit("close_opening_dialog");
		},
		/** The opening snapshot Pos.vue persists, or null. Never throws. */
		read_opening_snapshot() {
			try {
				const raw = localStorage.getItem("pospire.opening_shift_snapshot");
				return raw ? JSON.parse(raw) : null;
			} catch {
				return null;
			}
		},
		/**
		 * Is the cached opening snapshot rich enough to synthesise the
		 * `register_pos_data` payload from after an offline enqueue?
		 *
		 * ONE predicate, used by three call sites that used to disagree: the
		 * pre-call offline guard checked only `pos_profile && company` while
		 * the post-ack handler additionally required `pos_profile.name` and a
		 * resolvable company name. A snapshot in between (say `pos_profile:
		 * {}`) passed the guard, queued an opening entry, and only THEN
		 * failed — leaving an orphan opening in the outbox on every attempt.
		 * Now the strict form gates both, so nothing is queued that cannot be
		 * registered, and `submit_can_never_succeed` can mirror the guard
		 * exactly instead of approximately.
		 *
		 * The post-ack check still stands as well: on the online path the
		 * pre-call guard is skipped entirely, and `call()` can still decide to
		 * enqueue mid-flight (forceQueue, or a blip after the probe).
		 */
		snapshot_is_usable(snapshot) {
			return !!(
				snapshot &&
				snapshot.pos_profile &&
				typeof snapshot.pos_profile === "object" &&
				snapshot.pos_profile.name &&
				snapshot.company &&
				(typeof snapshot.company === "object"
					? snapshot.company.name
					: snapshot.company)
			);
		},
		/**
		 * Re-read the two non-reactive inputs to `submit_can_never_succeed`.
		 * Connectivity lives in a plain module and the snapshot in
		 * localStorage, so neither notifies Vue on its own.
		 */
		refresh_submit_gate() {
			this.is_online = connectivity.isOnline();
			this.snapshot_usable = this.snapshot_is_usable(
				this.read_opening_snapshot(),
			);
		},
		/**
		 * Single source of truth for populating the dialog from a
		 * `get_opening_dialog_data` payload. Used by BOTH the initial fetch
		 * and the reconnect refresh — a previous version only had
		 * `refresh_dialog_config` update `payments_method_data` /
		 * `denomination_config`, which never repopulated `companies` /
		 * `pos_profiles_data`. Since `company`/`pos_profile` stayed "" on a
		 * cold-boot-offline dialog, reassigning `payments_method_data` alone
		 * never re-fired the `pos_profile` watcher, so Submit flipped
		 * enabled on reconnect while the form was still completely blank —
		 * the exact silent dead end this task exists to remove.
		 *
		 * Assigns `companies` (does NOT push) so re-running this on refresh
		 * doesn't duplicate entries.
		 *
		 * Selection is STICKY: an already-valid `company`/`pos_profile` is
		 * kept rather than forced back to index 0. In a multi-company setup
		 * where the cashier's company isn't first in the list, unconditionally
		 * reassigning `companies[0]` on a steady-state reconnect fired the
		 * `company` -> `pos_profile` watcher chain, which rebuilds
		 * `denomination_rows` with `quantity: 0` — silently wiping an
		 * in-progress cash count out from under the cashier mid-count. Only
		 * fall back to the first entry when the current pick no longer
		 * resolves (cold start, or the pick vanished from the refreshed list).
		 */
		applyDialogData(r) {
			this.companies = (r.companies || []).map((element) => element.name);
			this.company_logos = {};
			(r.companies || []).forEach((element) => {
				this.company_logos[element.name] = element.company_logo || null;
			});
			const companySticky = Boolean(this.company) && this.companies.includes(this.company);
			if (!companySticky) {
				this.company = this.companies[0];
			}

			this.pos_profiles_data = r.pos_profiles_data || [];
			this.payments_method_data = r.payments_method || [];
			this.denomination_config = r.denomination_config || {};

			// The `company` watcher below only re-derives `pos_profiles` /
			// `pos_profile` when `company` itself CHANGES value, so it does
			// NOT fire on a sticky company. If `pos_profiles_data` changed
			// under a sticky company (e.g. an admin disabled the cashier's
			// selected profile while this device was offline), a stale
			// `pos_profile` would be left pointing at nothing —
			// `denomination_config[this.pos_profile]` resolves to `undefined`
			// and the grid silently disappears with no toast. Re-validate
			// explicitly here, mirroring the watcher's own fallback (keep the
			// current pick if it's still valid, else take `pos_profiles[0]`).
			// Only needed for the sticky-company branch: when company DID
			// change, the watcher already covers this correctly on its own —
			// adding this unconditionally would just duplicate that work.
			if (companySticky) {
				this.pos_profiles = this.pos_profiles_data
					.filter((p) => p.company === this.company)
					.map((p) => p.name);
				const previous = this.pos_profile;
				if (!this.pos_profile || !this.pos_profiles.includes(this.pos_profile)) {
					this.pos_profile = this.pos_profiles[0] || "";
				}
				// The re-selection above changes the denomination grid out from
				// under the cashier — possibly mid-count, possibly removing it
				// entirely. `refresh_dialog_config` bails as soon as the profile
				// changed (the watcher chain has already rebuilt everything), so
				// this is the only place that can say why. Without it the grid
				// just vanishes with no explanation at all.
				if (previous && this.pos_profile !== previous) {
					toast.warning(
						this.pos_profile
							? __("The POS Profile you had selected is no longer available. A different profile has been selected. Re-check the opening amounts before submitting.")
							: __("The POS Profile you had selected is no longer available and this company has no other profile. Contact your manager before opening a shift."),
						{ autoClose: 8000 },
					);
				}
			}

			// Tell the caller whether `pos_profile` was (re)validated
			// SYNCHRONOUSLY above, as opposed to being left for the `company`
			// watcher to resolve on Vue's next microtask flush. Callers that
			// need to know the FINAL `pos_profile` right after calling this
			// method (see `refresh_dialog_config`) can only trust a
			// before/after comparison when `companySticky` is true — a
			// non-sticky company change hasn't actually updated `pos_profile`
			// yet at this point, it's merely been scheduled to.
			return { companySticky };
		},
		async get_opening_dialog_data() {
			// Durable read-cache. The registry marks this method offline:true
			// and OPENING_DIALOG_CACHE_KEY is allowlisted in DURABLE_KEYS, so a
			// successful online call persists to Dexie and is served after a
			// reload while offline. Pos.vue warms it on every online boot,
			// because a terminal that runs all day on an already-open shift
			// never opens this dialog and would otherwise arrive here cold.
			let r = null;
			try {
				const raw = await call({
					method: "pospire.pospire.api.posapp.get_opening_dialog_data",
					args: {},
					intent: "read",
					cacheKey: OPENING_DIALOG_CACHE_KEY,
				});
				// Capture staleness BEFORE unwrapping — unwrapStale discards it.
				this.config_is_stale = isStaleReadResult(raw);
				r = unwrapStale(raw);
			} catch (err) {
				console.warn("[OpeningDialog] get_opening_dialog_data unavailable", err);
				this.config_unavailable = true;
				return;
			}

			if (!r) {
				this.config_unavailable = true;
				return;
			}

			this.config_unavailable = false;
			this.applyDialogData(r);
		},
		async refresh_dialog_config() {
			let fresh = null;
			try {
				const raw = await call({
					method: "pospire.pospire.api.posapp.get_opening_dialog_data",
					args: {},
					intent: "read",
					cacheKey: OPENING_DIALOG_CACHE_KEY,
				});
				this.config_is_stale = isStaleReadResult(raw);
				fresh = unwrapStale(raw);
			} catch {
				return; // still unreachable — keep what we have
			}
			if (!fresh) return;

			this.config_unavailable = false;
			// `previousProfile` lets us tell whether the profile selection
			// actually changed vs. staying exactly as the cashier left it —
			// only in the latter case do neither the `company` nor
			// `pos_profile` watcher fire (Vue only calls a watcher when the
			// value actually changes), leaving payments_methods /
			// denomination_rows untouched, which is what preserves typed
			// quantities across a reconnect. When the profile DID change,
			// the watcher chain already rebuilt everything from scratch (a
			// cold start has nothing to preserve; a vanished profile has
			// nothing valid left to preserve), so re-deriving it again below
			// would just duplicate that work and double any toast.
			//
			// This before/after comparison is only trustworthy when
			// `companySticky` is true. `applyDialogData` settles
			// `pos_profile` SYNCHRONOUSLY in that branch (see its comment),
			// so reading `this.pos_profile` immediately afterward reflects
			// the real outcome. When the company was NOT sticky,
			// `pos_profile` is left for the async `company` watcher to
			// resolve on Vue's next microtask flush (`flush: 'pre'`, the
			// default) — reading it synchronously here would still show the
			// OLD value, making the comparison a false negative. Bail out
			// via `companySticky` instead of trying to read a value that
			// hasn't been written yet. (If any watcher on this component is
			// ever declared `flush: 'sync'`, re-check this reasoning.)
			const previousProfile = this.pos_profile;
			const { companySticky } = this.applyDialogData(fresh);
			if (!companySticky) return;
			if (this.pos_profile !== previousProfile) return;

			// Re-derive the grid for the selected profile WITHOUT resetting
			// quantities the cashier has already counted into it. Mirrors
			// the `pos_profile` watcher's gate EXACTLY: `enabled: true` alone
			// does not mean render the grid — {enabled:true, denominations:[]}
			// is a real "misconfigured" state. Locking the cash field on an
			// unconfigured-but-enabled profile (by gating on `enabled` alone)
			// would strand the cashier with no way to enter opening cash.
			const config = this.denomination_config[this.pos_profile];
			if (!config?.denominations?.length) {
				this.denominations_enabled = false;
				this.denomination_rows = [];
				if (config) {
					toast.warning(__("Cash denominations are enabled for this profile but no denomination rows are configured."), {
						autoClose: 5000,
					});
				}
				return;
			}
			const typed = new Map(
				this.denomination_rows.map((row) => [row.denomination, row.quantity]),
			);
			this.denominations_enabled = true;
			this.denomination_rows = config.denominations.map((d) => ({
				denomination: d.denomination,
				denomination_name: d.denomination_name,
				denomination_value: d.denomination_value,
				currency: d.currency,
				quantity: typed.get(d.denomination) ?? 0,
				amount: 0,
			}));
		},
		async submit_dialog() {
			if (!this.payments_methods.length || !this.company || !this.pos_profile) {
				return;
			}

			if (this.denominations_enabled) {
				const invalidQty = this.denomination_rows.some((row) => {
					const qty = row.quantity === "" || row.quantity === null || row.quantity === undefined
						? 0
						: Number(row.quantity);

					return qty < 0 || !Number.isInteger(qty);
				});

				if (invalidQty) {
					toast.error(__("Quantity must be a non-negative integer."), {
						autoClose: 5000,
					});
					return;
				}
			}

			const has_invalid_amount = this.payments_methods.some((p) => !isAmountValid(p.amount));
			if (has_invalid_amount) {
				toast.error(__("Please enter valid non-negative amounts."), {
					autoClose: 5000,
				});
				return;
			}

			this.is_loading = true;

			const balance_details = this.payments_methods.map((p) => ({
				...p,
				amount:
					p.amount === "" || p.amount === null || p.amount === undefined
						? 0
						: Number(p.amount),
			}));

			let denomination_details = null;

			if (this.denominations_enabled) {
				const rows = this.denomination_rows.map((d) => ({
					denomination: d.denomination,
					denomination_name: d.denomination_name,
					denomination_value: d.denomination_value,
					currency: d.currency,
					quantity: d.quantity || 0,
					amount: (d.denomination_value || 0) * (d.quantity || 0),
				}));

				denomination_details = JSON.stringify(rows);
			}

			// F2: offline shift open. The previous online session left a
			// snapshot under `pospire.opening_shift_snapshot` (Pos.vue) that
			// holds the full POS Profile + Company.
			//
			// M2 fix: load the snapshot UNCONDITIONALLY before the call().
			// `connectivity.isOnline()` is the pre-call snapshot of state —
			// but call() can decide to enqueue mid-flight (e.g. forceQueue,
			// or a network blip after the connectivity probe). If the
			// snapshot was only read in the `offline` branch, the
			// offline-ack handler downstream would dereference a null
			// snapshot when running through an "online but enqueued" path.
			const snapshot = this.read_opening_snapshot();

			const offline = !connectivity.isOnline();
			if (offline) {
				// F5: chained-shifts hard block. Once 3 opening_entries are
				// stacked unsynced, refuse to enqueue a 4th (we keep the cap
				// at 3 = "warn at 2, block at 3"). Forces the cashier to
				// reconnect before further opens.
				try {
					const { useOutboxStore } = await import("@/stores/outbox");
					const outbox = useOutboxStore();
					if ((outbox.unsyncedOpeningCount ?? 0) >= 3) {
						this.is_loading = false;
						toast.error(
							__("Cannot open another shift offline: 3 shifts are already waiting to sync. Reconnect to clear them first."),
							{ autoClose: 7000 },
						);
						return;
					}
				} catch (err) {
					// Store unavailable (e.g. SSR / pre-init). Fail open: better
					// to allow a fourth than to block legitimate opens because
					// of an init race. The reconciliation workspace would catch
					// any actual oversync.
					console.warn("[OpeningDialog] chained-shifts gate skipped", err);
				}

				if (!this.snapshot_is_usable(snapshot)) {
					this.is_loading = false;
					toast.warning(
						__("Opening a shift offline needs a recent online session on this device. Reconnect and open one shift online first."),
						{ autoClose: 6000 },
					);
					return;
				}
			}

			try {
				const r = await call("pospire.pospire.api.posapp.create_opening_voucher", {
					pos_profile: this.pos_profile,
					company: this.company,
					balance_details,
					denomination_details,
				});

				// Offline-enqueue ack — synthesise the data shape from the cached
				// snapshot + the provisional shift. The cashier can start selling
				// immediately; subsequent invoices stamp pos_opening_shift_offline_id
				// so the server resolves to the real shift name on sync.
				if (r && r.offline === true && r.status === "enqueued") {
					// M2 — defensive null guard. We pre-loaded the snapshot
					// unconditionally before the call() (so this path covers
					// both "offline → enqueued" and "online classified →
					// enqueued via forceQueue / mid-flight network blip"),
					// but pre-load may have failed (private mode, quota,
					// corrupt JSON, malformed shape). An offline-ack arriving
					// without a USABLE snapshot means we can't fire
					// register_pos_data with the rich shape downstream
					// components expect (pos_profile.payments, company doc
					// fields). Surface a clear error instead of crashing on
					// `snapshot.pos_profile.name`.
					if (!this.snapshot_is_usable(snapshot)) {
						this.is_loading = false;
						toast.error(
							__("Shift queued offline but the cached profile is missing. Reload while online to refresh the snapshot before opening another shift."),
							{ autoClose: 8000 },
						);
						return;
					}
					const provisionalShift = {
						name: r.provisional_name,
						pos_offline_id: r.offline_id,
						pos_profile: this.pos_profile,
						company: this.company,
						posting_date: new Date().toISOString().slice(0, 10),
						period_start_date: new Date().toISOString().replace("T", " ").slice(0, 19),
						user: snapshot.pos_opening_shift?.user || "",
						balance_details,
						denomination_details: denomination_details
							? JSON.parse(denomination_details)
							: [],
						pospire_pending_sync: true,
					};
					const data = {
						pos_opening_shift: provisionalShift,
						pos_profile: snapshot.pos_profile,
						company: snapshot.company,
						stock_settings: snapshot.stock_settings || { allow_negative_stock: 0 },
					};
					this.eventBus.emit("register_pos_data", data);
					this.eventBus.emit("set_company", data.company);
					toast.info(
						__("Shift opened offline. It will sync when online."),
						{ autoClose: 4000 },
					);
					this.close_opening_dialog();
					return;
				}

				if (r) {
					this.eventBus.emit("register_pos_data", r);
					this.eventBus.emit("set_company", r.company);
					this.close_opening_dialog();
				}
			} catch (err) {
				// A live rejection (permission error, validation failure, 500)
				// used to have no handler at all: `finally` reset the spinner
				// and the rejection escaped as an unhandled promise rejection,
				// so the cashier saw the button un-press and nothing else. That
				// is bad on its own; with the exits hidden during a queued
				// close it is silent AND exit-less.
				console.error("[OpeningDialog] create_opening_voucher failed", err);
				toast.error(
					(err && err.message) ||
						__("Could not open the shift. Please try again."),
					{ autoClose: 7000 },
				);
			} finally {
				this.is_loading = false;
			}
		},
		go_desk() {
			window.location.href = "/app";
		},
	},
};
</script>

<style scoped>
.store-logo-wrap {
	min-height: clamp(48px, 8vw, 72px);
}

.store-logo-img {
	height: clamp(48px, 8vw, 72px);
	width: auto;
	max-width: 100%;
	object-fit: contain;
}

.opening-shift-card--fullscreen {
	width: 100%;
	height: 100%;
}

.min-width-0 {
	min-width: 0;
}

.payment-mode-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
	gap: 8px;
}

.payment-mode-chip {
	min-height: 48px;
	transition: border-color 0.15s ease;
}

.denom-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
	gap: 8px;
}

.denom-card {
	height: 100%;
}

.denom-stepper-btn {
	flex: 0 0 auto;
}

.denom-qty-input {
	width: 56px;
	flex: 0 0 auto;
}

.denom-qty-input :deep(input) {
	text-align: center;
}

.denom-summary > div {
	min-width: 0;
}

@media (max-width: 599px) {
	.denom-summary {
		gap: 12px;
	}

	/*
	 * pos-enhancements.css forces `.enhanced-modal-header` / `.v-card-text`
	 * padding with `!important` and no media query, silently cancelling the
	 * `px-4`/`pa-4` mobile-reduced padding classes on the header, footer,
	 * and body below `sm`. These overrides restore that reduction — same
	 * padding value the utility classes were already trying to set.
	 *
	 * The `.v-card-actions` rule needs `.v-card` in the chain specifically:
	 * the winning global selector is `body:has(.pos-page) .v-dialog .v-card >
	 * .v-card-actions` (pos-enhancements.css), which is 4 classes + 1 element
	 * (body) — a bare `.opening-shift-card.d-flex .v-card-actions` ties on
	 * classes (4) and loses on the element tiebreak. Adding `.v-card` here
	 * brings it to 5 classes, which wins outright before types are compared.
	 */
	.opening-shift-card.d-flex .v-card-title.enhanced-modal-header,
	.opening-shift-card.v-card.d-flex .v-card-actions {
		padding: 16px !important;
	}

	.opening-shift-card.d-flex .v-card-text {
		padding: 16px !important;
	}
}
</style>