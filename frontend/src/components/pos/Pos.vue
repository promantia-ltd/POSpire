<template>
	<div fluid class="mt-2 pos-page">
		<ClosingDialog></ClosingDialog>
		<Drafts></Drafts>
		<SalesOrders></SalesOrders>
		<Returns></Returns>
		<NewAddress></NewAddress>
		<MpesaPayments></MpesaPayments>
		<Variants></Variants>
		<!--
			`closing-pending` is passed as a prop rather than signalled over the
			eventBus: the dialog is `v-if`-ed into existence BY the close path,
			so a `shift_closing_pending` event emitted there always fires
			before this component exists and its listener would never run.
		-->
		<OpeningDialog
			v-if="dialog"
			:dialog="dialog"
			:closing-pending="!!pendingClosingOfflineId"
		></OpeningDialog>

		<!-- Modal Components -->
		<CouponsModal v-model="showCouponsModal"></CouponsModal>
		<OffersModal v-model="showOffersModal"></OffersModal>

		<v-row v-show="!dialog" class="itemselector-section">
			<v-col
				v-show="!payment"
				xl="5"
				lg="5"
				md="5"
				sm="5"
				cols="12"
				class="pos pr-0 test-pos"
			>
				<ItemsSelector></ItemsSelector>
			</v-col>
			<v-col
				v-show="payment"
				xl="5"
				lg="5"
				md="5"
				sm="5"
				cols="12"
				class="pos pr-0 test-pos"
			>
				<Payments></Payments>
			</v-col>

			<v-col xl="7" lg="7" md="7" sm="7" cols="12" class="pos invoice-section">
				<Invoice></Invoice>
			</v-col>
		</v-row>
	</div>
</template>

<script>
import ItemsSelector from "./ItemsSelector.vue";
import Invoice from "./Invoice.vue";
import OpeningDialog from "./OpeningDialog.vue";
import Payments from "./Payments.vue";
import CouponsModal from "./CouponsModal.vue";
import OffersModal from "./OffersModal.vue";
import Drafts from "./Drafts.vue";
import SalesOrders from "./SalesOrders.vue";
import ClosingDialog from "./ClosingDialog.vue";
import NewAddress from "./NewAddress.vue";
import Variants from "./Variants.vue";
import Returns from "./Returns.vue";
import MpesaPayments from "./Mpesa-Payments.vue";
import { call, unwrapStale } from "@/utils/call";
import { OPENING_DIALOG_CACHE_KEY } from "@/utils/call-registry";
import { toast } from "vue3-toastify";
import { onSynced, readDeviceId } from "@/offline/outbox";
import { setBeaconContext } from "@/offline/beacon";
import connectivity from "@/offline/connectivity";

import busListeners from "@/utils/busListeners";
export default {
	mixins: [busListeners],
	data: function () {
		return {
				dialog: false,
				pos_profile: "",
				pos_opening_shift: "",
				payment: false,
				showCouponsModal: false,
				showOffersModal: false,
				pendingProfileData: null,
				pendingMasterDataRefresh: { items: false, customers: false },
				cartHasItems: false,
				pendingClosingOfflineId: null,
				shiftLifecycleId: null,
			};
		},

	components: {
		ItemsSelector,
		Invoice,
		OpeningDialog,
		Payments,
		Drafts,
		ClosingDialog,
		CouponsModal,
		OffersModal,
		Returns,
		NewAddress,
		Variants,
		MpesaPayments,
		SalesOrders,
	},

	methods: {
		async check_opening_entry() {
			const SNAPSHOT_KEY = "pospire.opening_shift_snapshot";
			const SNAPSHOT_META_KEY = "pospire.opening_shift_snapshot.meta";
			const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

			const cachedSnapshot = this.readCachedOpeningSnapshot(
				SNAPSHOT_KEY,
				SNAPSHOT_META_KEY,
				SNAPSHOT_TTL_MS,
			);
			let registeredFromCache = false;
			if (cachedSnapshot) {
				this.applyOpeningSnapshot(cachedSnapshot);
				registeredFromCache = true;
			}

			let r = null;
			let liveCallSucceeded = false;
			try {
				r = await call("pospire.pospire.api.posapp.check_opening_shift", {
					user: window.user,
				});
				liveCallSucceeded = true;
				// Warm the opening-dialog cache on every online boot, not
				// only when the dialog opens. OpeningDialog is v-if="dialog"
				// so it is constructed only when create_opening_voucher()
				// fires; a terminal running all day on an open shift would
				// otherwise reach the dialog (after an offline close) cold.
				// Fire-and-forget: never block the shift check on this.
				call({
					method: "pospire.pospire.api.posapp.get_opening_dialog_data",
					args: {},
					intent: "read",
					cacheKey: OPENING_DIALOG_CACHE_KEY,
				}).catch(() => {
					/* non-fatal — the dialog retries when it opens */
				});
				if (r) {
					this.persistOpeningSnapshot(r, SNAPSHOT_KEY, SNAPSHOT_META_KEY);
				}
			} catch (err) {
				if (!registeredFromCache) {
					console.warn(
						"[Pos] check_opening_shift failed and no fresh snapshot cached",
						err,
					);
				}
			}

			if (r) {
				if (!registeredFromCache || this.openingSnapshotDiffers(cachedSnapshot, r)) {
					this.applyOpeningSnapshot(r);
				} else {
					// The live response is a DIFFERENT object for the same shift
					// and the server does not echo `pospire_lifecycle_id`, so a
					// bare reassignment drops a stamp the cached snapshot was
					// already carrying — leaving Invoice.isShiftLocked() with
					// nothing to key on until registerShiftLifecycle() resolves.
					// Carry it across explicitly rather than relying on that race.
					const stamped = this.pos_opening_shift?.pospire_lifecycle_id;
					this.pos_profile = r.pos_profile;
					this.pos_opening_shift = r.pos_opening_shift;
					if (stamped && this.pos_opening_shift && !this.pos_opening_shift.pospire_lifecycle_id) {
						this.pos_opening_shift.pospire_lifecycle_id = stamped;
					}
				}
			} else if (liveCallSucceeded && !cachedSnapshot?.pos_opening_shift?.pospire_pending_sync) {
				this.invalidateOpeningSnapshot(SNAPSHOT_KEY, SNAPSHOT_META_KEY);
				this.pos_profile = "";
				this.pos_opening_shift = "";
				this.create_opening_voucher();
			} else if (!registeredFromCache) {
				this.create_opening_voucher();
			}
		},

		readCachedOpeningSnapshot(key, metaKey, ttlMs) {
			try {
				const raw = localStorage.getItem(key);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (!parsed || !parsed.pos_profile || !parsed.pos_opening_shift) {
					return null;
				}
				const metaRaw = localStorage.getItem(metaKey);
				if (!metaRaw) return null;
				const meta = JSON.parse(metaRaw);
				if (
					!meta?.cached_at ||
					typeof meta.cached_at !== "number" ||
					Date.now() - meta.cached_at > ttlMs
				) {
					return null;
				}
				return parsed;
			} catch {
				return null;
			}
		},

		persistOpeningSnapshot(snapshot, key, metaKey) {
			try {
				localStorage.setItem(key, JSON.stringify(snapshot));
				localStorage.setItem(
					metaKey,
					JSON.stringify({ cached_at: Date.now() }),
				);
			} catch {
				/* quota / privacy mode — non-fatal */
			}
		},

		invalidateOpeningSnapshot(key, metaKey) {
			try {
				localStorage.removeItem(metaKey);
				const raw = localStorage.getItem(key);
				if (raw) {
					const parsed = JSON.parse(raw);
					parsed.pos_opening_shift = null;
					localStorage.setItem(key, JSON.stringify(parsed));
				}
			} catch {
				/* private mode */
			}
		},

		/**
		 * Drop the cached opening snapshot when reconciliation released the very
		 * shift it names.
		 *
		 * A released shift is one whose closing already landed server-side, so
		 * selling against it is invalid — but `isSellingBlocked` correctly stops
		 * blocking the moment it stops being `closed_pending_sync`. Offline,
		 * `check_opening_shift` can't be reached to contradict the snapshot, so
		 * without this the next boot re-applies that shift UNLOCKED and rings
		 * invoices against a closed shift. The old code got this for free by
		 * nulling the snapshot at close time; that null-out had to go, so the
		 * guard is re-established here from the durable reconciliation result.
		 */
		dropSnapshotForReleasedShifts(releasedIds) {
			if (!Array.isArray(releasedIds) || !releasedIds.length) return;
			try {
				const raw = localStorage.getItem("pospire.opening_shift_snapshot");
				if (!raw) return;
				const cachedShift = JSON.parse(raw)?.pos_opening_shift;
				if (!cachedShift) return;
				// Same two keys registerOpenedShift dedupes on, in the same order.
				const cachedId =
					cachedShift.pospire_lifecycle_id || cachedShift.pos_offline_id;
				if (!cachedId || !releasedIds.includes(cachedId)) return;
				this.invalidateOpeningSnapshot(
					"pospire.opening_shift_snapshot",
					"pospire.opening_shift_snapshot.meta",
				);
			} catch {
				/* private mode / corrupt cache — non-fatal */
			}
		},

		/**
		 * Reconciliation-path contribution prune — DISTINCT from the live
		 * `onSynced` `closing_entry` prune further below. Do NOT fold these
		 * two into one: they cover different windows.
		 *
		 * A closing can land in `released` here WITHOUT `onSynced` ever
		 * having fired for it, because that live callback needs a
		 * subscriber running at the moment the sync happens:
		 *   - the `onSynced` prune itself threw (it is warn-only and does
		 *     not retry, so the row would otherwise survive forever);
		 *   - another tab drained the outbox while this tab was on a
		 *     different route and `Pos.vue` was unmounted;
		 *   - the outbox row was vacuumed to a tombstone before this tab
		 *     observed the sync.
		 * In every one of those, this reconciliation pass is the ONLY
		 * remaining place that ever learns the closing landed, so it must
		 * carry its own prune rather than relying on `onSynced` to have
		 * already done it.
		 *
		 * `deleteContributionsForShift` is idempotent (deletes are a no-op
		 * on an already-empty shift), so this and the `onSynced` prune can
		 * never conflict — the common case prunes once via `onSynced` and
		 * this call simply finds nothing left to do on the next boot.
		 *
		 * `released` ONLY, same as `dropSnapshotForReleasedShifts` — never
		 * `reopened`. A reopened shift's closing was voided, so the shift
		 * is still sellable and its takings must still be there.
		 *
		 * Fire-and-forget by design: called without `await` from the
		 * reconciliation chain, which must boot the POS regardless of
		 * whether pruning succeeds. Failure is caught here and only
		 * warned — it must never reject into that chain.
		 */
		pruneReleasedShiftContributions(releasedIds) {
			if (!Array.isArray(releasedIds) || !releasedIds.length) return;
			import("@/offline/contribution-ledger")
				.then(({ deleteContributionsForShift }) =>
					Promise.all(
						releasedIds.map((id) => deleteContributionsForShift(id)),
					),
				)
				.catch((err) => {
					console.warn(
						"[Pos] reconciliation contribution prune failed",
						err,
					);
				});
		},

		openingSnapshotDiffers(cached, live) {
			if (!cached) return true;
			if (
				cached.pos_opening_shift?.name !== live.pos_opening_shift?.name
			) {
				return true;
			}
			if (
				cached.pos_profile?.modified !== live.pos_profile?.modified
			) {
				return true;
			}
			return false;
		},

		applyOpeningSnapshot(snapshot) {
			if (!snapshot?.pos_profile) return;
			// Symmetric with the `register_pos_data` handler, and for the same
			// reason: this is the OTHER door a shift change comes through
			// (check_opening_entry when openingSnapshotDiffers), and it can
			// carry a DIFFERENT shift than the one currently registered.
			// `shiftLifecycleId` is only re-assigned tens of ms later by the
			// async registerShiftLifecycle() below; during that gap a stale id
			// would still satisfy the onSynced routing guard and wipe the shift
			// just applied. Placed after the early return, not before it — a
			// rejected snapshot changes no shift, so clearing the id there
			// would blind the routing guard for a shift that is still current.
			this.shiftLifecycleId = null;
			this.pos_profile = snapshot.pos_profile;
			this.pos_opening_shift = snapshot.pos_opening_shift;
			// Every shift gets a durable row and a local lifecycle UUID,
			// online-opened ones included. Fire-and-forget: a Dexie failure
			// must never block the POS from loading.
			this.registerShiftLifecycle(snapshot);
			// Resolve any contribution left `pending` by a crash between the
			// stage and the confirm. Fire-and-forget: nothing during boot reads
			// this, and a failure just leaves rows pending, which still count
			// toward the displayed total.
			this.reconcileContributions(snapshot);
			this.get_offers(this.pos_profile.name);
			this.eventBus.emit("register_pos_profile", snapshot);
			this.eventBus.emit("set_company", snapshot.company);
			// Closing-pending is no longer read off the snapshot — it lives on
			// the durable shift row and is re-announced by
			// registerShiftLifecycle() once the row has been looked up.
			try {
				setBeaconContext({
					outlet:
						snapshot.pos_profile.warehouse ||
						snapshot.pos_profile.name ||
						"",
					active_shift: snapshot.pos_opening_shift?.name || "",
					user: snapshot.pos_opening_shift?.user || "",
				});
			} catch (err) {
				console.warn("[Pos] setBeaconContext failed", err);
			}
			this.warm_customer_form_options_cache();
		},
		async registerShiftLifecycle(snapshot) {
			const shift = snapshot?.pos_opening_shift;
			if (!shift) return;
			try {
				// initOfflineStorage() is already kicked off by App.vue's
				// mounted() well before Pos.vue exists (routes are
				// lazy-loaded and app.mount() does not await
				// router.isReady()), so init has normally already STARTED
				// by the time this fires. The real hazard is that it can
				// still be IN FLIGHT: Dexie's db.open() and the crypto key
				// bootstrap are real IndexedDB / Web Crypto round trips.
				// initOfflineStorage() is idempotent (cached `initialised`
				// flag + cached `initPromise`), so awaiting it here just
				// joins whichever init is already running rather than
				// starting a second db.open() or re-key — the write below
				// can never race the storage it depends on. It also
				// guarantees seedDeviceId() (which runs first inside init)
				// has already run, so readDeviceId() below returns a real
				// id instead of "unknown-device".
				const { initOfflineStorage } = await import("@/offline/db");
				await initOfflineStorage();
				const { getShiftById, registerOpenedShift } = await import(
					"@/offline/shift-lifecycle"
				);
				const openingCashByMop = {};
				(shift.balance_details || []).forEach((row) => {
					openingCashByMop[row.mode_of_payment] = Number(row.amount) || 0;
				});
				const lifecycleId = await registerOpenedShift({
					// `pos_offline_id` is a PERSISTED server custom field: it
					// stays set forever once an offline-opened shift syncs,
					// so it cannot distinguish "unsynced" from "synced".
					// `pospire_pending_sync` is the client-side flag the
					// onSynced handler actually clears; the server never
					// returns this field at all, so a genuinely
					// online-opened shift is also (correctly) falsy here.
					openingServerName: shift.pospire_pending_sync
						? null
						: shift.name || null,
					posProfile: snapshot.pos_profile || {},
					openingCashByMop,
					cashierUser: shift.user || window.user || "",
					deviceId: readDeviceId(),
					// Durable identity of this shift's row. `pos_offline_id`
					// covers the unsynced-offline case; `pospire_lifecycle_id`
					// covers every other case, INCLUDING a shift opened offline
					// and synced mid-shift, whose `pos_offline_id` the sync
					// handler has since cleared. Passing it on the online path
					// too is deliberate: registerOpenedShift tries the server
					// name first and this second, so the row is still found
					// when its `opening_server_name` never landed.
					lifecycleId:
						shift.pos_offline_id || shift.pospire_lifecycle_id || undefined,
				});
				this.shiftLifecycleId = lifecycleId;
				// Task 9's lock reads this off the in-memory shift. Guard
				// against a second, differently-shifted call (cached
				// snapshot vs. live response race in check_opening_entry)
				// resolving out of order and stamping this shift's UUID onto
				// whatever shift is now current.
				//
				// The guard is a VALUE comparison, not object identity. On the
				// `registeredFromCache && !openingSnapshotDiffers` path,
				// check_opening_entry reassigns `pos_opening_shift` to the live
				// response — a different object describing the SAME shift — so
				// an identity check simply lost the race whenever the network
				// beat the Dexie write. Losing it meant no `pospire_lifecycle_id`
				// stamp (durable cart lock inert for the whole session) and no
				// restampOpeningSnapshotCache (released-shift snapshot
				// invalidation never fires, since it falls back to
				// `pos_offline_id`, which an online-opened shift never has).
				// Every device with a shift open at upgrade time takes that
				// path on its first reload. Same predicate
				// restampOpeningSnapshotCache uses: `pos_offline_id` else `name`.
				if (this.sameShift(this.pos_opening_shift, shift)) {
					shift.pospire_lifecycle_id = lifecycleId;
					// Stamp the currently-mounted object too when it is a
					// different instance of the same shift — Invoice.vue holds
					// the one it was handed via `register_pos_profile`, while
					// buildOfflineClosingStub reads this one.
					if (this.pos_opening_shift !== shift) {
						this.pos_opening_shift.pospire_lifecycle_id = lifecycleId;
					}
					this.restampOpeningSnapshotCache(shift, lifecycleId);
				}

				// Durable closing-pending state, re-announced. After a reload
				// no `shift_closing_pending` event has ever fired in this
				// session, so the shift row is the only thing that knows this
				// shift is closing. Re-emitting rehydrates every in-session
				// listener (cart lock, opening-dialog exit gate) from it.
				// Deliberately LAST in the try: a decrypt failure here must not
				// cost us the lifecycle-id stamping above.
				const row = await getShiftById(lifecycleId);
				if (row?.status === "closed_pending_sync") {
					this.pendingClosingOfflineId = row.pending_closing_offline_id;
					this.eventBus.emit("shift_closing_pending", {
						shift_lifecycle_id: lifecycleId,
						closing_offline_id: row.pending_closing_offline_id,
					});
					// The shift stays applied so the durable lock keeps
					// resolving against it, but the cashier needs a route to a
					// working till — otherwise a reload during a queued close
					// strands them on a shift they can neither sell on nor
					// close again.
					this.create_opening_voucher();
				}
			} catch (err) {
				console.warn("[Pos] registerShiftLifecycle failed", err);
			}
		},
		/**
		 * Resolve contributions left `pending` by a crash between staging and
		 * confirming (see contribution-ledger.ts). Fire-and-forget and
		 * non-fatal by construction: nothing during boot depends on this
		 * having run, so it must never delay or throw into
		 * `check_opening_entry`.
		 *
		 * Needs the shift's lifecycle id BEFORE `registerShiftLifecycle` (also
		 * fired above, also un-awaited) has necessarily stamped it anywhere:
		 * `this.shiftLifecycleId` was just nulled out synchronously by
		 * `applyOpeningSnapshot` and is only reassigned once
		 * `registerShiftLifecycle`'s internal awaits resolve, which can
		 * happen after this method's own synchronous portion has already run.
		 * So this uses the same per-sale fallback chain Payments.vue uses
		 * rather than trusting `this.shiftLifecycleId` or
		 * `pospire_lifecycle_id` alone: the in-memory stamp, then the
		 * pre-sync offline id, then a direct Dexie lookup by server name. A
		 * brand-new shift (nothing to reconcile yet) can race
		 * `registerShiftLifecycle`'s write of the durable row, but a resumed
		 * shift's row was already written in an earlier session, so the
		 * lookup that matters in practice never races it.
		 */
		async reconcileContributions(snapshot) {
			const shift = snapshot?.pos_opening_shift;
			if (!shift) return;
			try {
				let shiftLifecycleId =
					shift.pospire_lifecycle_id || shift.pos_offline_id || null;
				if (!shiftLifecycleId && shift.name) {
					const { findShiftByServerName } = await import(
						"@/offline/shift-lifecycle"
					);
					const row = await findShiftByServerName(shift.name);
					shiftLifecycleId = row?.offline_id || null;
				}
				if (!shiftLifecycleId) return;
				const { reconcilePendingContributions } = await import(
					"@/offline/contribution-ledger"
				);
				await reconcilePendingContributions({
					shiftLifecycleId,
					// Same `pospire_pending_sync` discriminator registerShiftLifecycle
					// uses: `pos_offline_id` is a persisted server field that
					// survives sync, so it cannot tell "unsynced" from "synced".
					openingServerName: shift.pospire_pending_sync
						? null
						: shift.name || null,
					openingOfflineId: shift.pos_offline_id || null,
				});
			} catch (err) {
				console.warn("[Pos] reconcileContributions failed", err);
			}
		},
		/**
		 * Do these two shift objects describe the SAME shift?
		 *
		 * Value predicate, deliberately not `===`: the cached snapshot and the
		 * live `check_opening_shift` response are always distinct objects for
		 * the same shift, and every guard that used identity instead silently
		 * no-opped whenever the live response arrived first.
		 *
		 * `pos_offline_id` is preferred because a shift opened offline is
		 * renamed on sync (provisional -> server name), so `name` is not stable
		 * across that boundary; once it IS synced `pos_offline_id` is cleared
		 * on both sides and `name` is. An offline id on ONE side only means the
		 * two are at different points across that rename, which is a mismatch
		 * — falling back to `name` there would compare a provisional name
		 * against a server one and never match anyway.
		 */
		sameShift(a, b) {
			if (!a || !b) return false;
			if (a === b) return true;
			if (a.pos_offline_id || b.pos_offline_id) {
				return !!a.pos_offline_id && a.pos_offline_id === b.pos_offline_id;
			}
			return !!a.name && a.name === b.name;
		},
		// `persistOpeningSnapshot` runs synchronously right after
		// `registerShiftLifecycle` is fired (fire-and-forget), so the
		// cached snapshot is always written BEFORE the async lookup above
		// resolves and stamps `pospire_lifecycle_id` in memory. Without
		// this, the id would never survive a reload — exactly when Task 9
		// needs to read it back. Patches the cache in place the same way
		// the onSynced handler further below already does.
		restampOpeningSnapshotCache(shift, lifecycleId) {
			try {
				const raw = localStorage.getItem("pospire.opening_shift_snapshot");
				if (!raw) return;
				const cached = JSON.parse(raw);
				const cachedShift = cached?.pos_opening_shift;
				if (!cachedShift) return;
				if (!this.sameShift(cachedShift, shift)) return;
				cachedShift.pospire_lifecycle_id = lifecycleId;
				localStorage.setItem(
					"pospire.opening_shift_snapshot",
					JSON.stringify(cached),
				);
			} catch {
				/* localStorage parse failure is non-fatal */
			}
		},
		create_opening_voucher() {
			this.dialog = true;
		},
		/**
		 * One-shot handoff from Navbar's Close Shift when it was tapped from a
		 * route where this component -- and therefore ClosingDialog -- was not
		 * mounted. Navbar navigates here with `?close_shift=1` rather than
		 * emitting into the void.
		 *
		 * The flag is stripped before anything else so it is consumed exactly
		 * once: a refresh, a back-navigation or a later remount must not
		 * reopen the dialog. When no shift is open the opening dialog owns the
		 * screen, so the intent is dropped rather than acted on.
		 */
		async consumeCloseShiftIntent() {
			if (this._closeShiftIntentConsumed) return;
			if (this.$route.query.close_shift !== "1") return;
			// Spend the intent synchronously, before the first await. Vue
			// Router keeps the old query on `$route` until replace() settles,
			// so a second call in the meantime would otherwise see the flag
			// still set and fire a second closing request.
			this._closeShiftIntentConsumed = true;

			// Strip only our own flag: other params and the hash belong to
			// whoever put them there.
			const query = { ...this.$route.query };
			delete query.close_shift;
			try {
				await this.$router.replace({
					path: this.$route.path,
					query,
					hash: this.$route.hash,
				});
			} catch (err) {
				// A cancelled or aborted navigation leaves the flag in the URL,
				// so a later reload can re-arm it. The guard above still holds
				// for this instance, which is what prevents the double request.
				console.warn("[Pos] could not strip close_shift from the URL", err);
			}
			if (!this.pos_opening_shift) return;
			// Returned, not fire-and-forget: the caller's terminal catch owns
			// any rejection from here.
			return this.get_closing_data();
		},
		async get_closing_data() {
			let r = null;
			try {
				r = await call(
					"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening",
					{
						opening_shift: this.pos_opening_shift,
					}
				);
			} catch (err) {
				console.warn("[Pos] make_closing_shift offline fallback", err);
				r = await this.buildOfflineClosingStub();
			}
			if (r) {
				this.eventBus.emit("open_ClosingDialog", r);
			}
		},
		async buildOfflineClosingStub() {
			const opening = this.pos_opening_shift || {};
			const balance = Array.isArray(opening.balance_details)
				? opening.balance_details
				: [];
			const cashMode =
				(this.pos_profile && this.pos_profile.posa_cash_mode_of_payment) || "Cash";
			// Same source `utils/format.js` reads at mount (`this.currency_precision`)
			// — Pos.vue doesn't mix that helper in, so read the site value directly
			// rather than hardcoding 2. A 3-decimal currency (KWD, BHD, OMR) would
			// otherwise get every queued payment silently rounded to 2dp here while
			// the server keeps full precision.
			const precision = window.sys_defaults?.currency_precision || 2;

			// Phase 2: totals come from the contribution ledger, which
			// records EVERY sale — online and offline — so the figure is no
			// longer missing the pre-outage takings.
			//
			// Resolve the lifecycle id with the SAME fallback chain
			// Payments.vue's submit_invoice and reconcileContributions use,
			// so this reads the same row the sales were staged against. NOT
			// `this.shiftLifecycleId` — `applyOpeningSnapshot` nulls it
			// synchronously before the un-awaited `registerShiftLifecycle`
			// can re-stamp it, so it can read `null` here even though a
			// durable row exists.
			let lifecycleId =
				opening.pospire_lifecycle_id || opening.pos_offline_id || null;
			if (!lifecycleId && opening.name) {
				try {
					const { findShiftByServerName } = await import(
						"@/offline/shift-lifecycle"
					);
					const row = await findShiftByServerName(opening.name);
					lifecycleId = row?.offline_id || null;
				} catch (err) {
					console.warn("[Pos] findShiftByServerName failed", err);
				}
			}

			// Fall back to the Phase 1 outbox scan when no lifecycle id is
			// resolvable at all (an upgrade-day snapshot predating the
			// stamp). An offline-only figure is worse than the ledger's but
			// far better than a blank one. The banner wording differs between
			// the two — only the scan branch is blind to online sales — so the
			// stub carries a discriminator, not just `pospire_offline_stub`.
			let queued = { byMop: {}, uncertainCount: 0 };
			let source = "scan";
			try {
				if (lifecycleId) {
					const [
						{ deriveExpectedByMop },
						{ scanQueuedContributionsByInvoice },
					] = await Promise.all([
						import("@/offline/contribution-ledger"),
						import("@/offline/shift-lifecycle"),
					]);
					const derived = await deriveExpectedByMop(lifecycleId, precision);
					// Keyed off whether the ledger actually HAS rows, not off
					// whether an id resolved. An upgrade-day shift resolves an id
					// but has no contributions at all, and its figure then comes
					// entirely from the outbox — which is blind to online sales,
					// so the Phase 1 caveat is still the truthful banner there.
					if (derived.offlineIds.length > 0) source = "ledger";
					// Assign from the ledger FIRST, before the scan even runs.
					// `contributionForInvoice`/`resolveChangeAmount` (which the
					// scan below calls per row) are unguarded on payload shape —
					// unlike `listInvoiceRowsAcrossStatuses`, which is
					// deliberately written so one poison row cannot "silently
					// zero the cashier's entire expected-amount figure". A scan
					// throw below must therefore only cost the outbox-side
					// additions, never the ledger figure already computed here.
					queued = {
						byMop: derived.byMop,
						// `skippedCount` is money that DECRYPTED NOWHERE: an
						// undecryptable row's amount is simply absent from
						// `byMop`, so without this the dialog would show a short
						// number with no hint that anything went missing.
						uncertainCount: derived.pendingCount + derived.skippedCount,
					};

					// Run the Phase 1 scan alongside the ledger EVEN THOUGH an id
					// resolved. Two live cases need it:
					//  - Upgrade day: a shift stamped with a lifecycle id but
					//    opened before Phase 2 shipped has queued sales and NO
					//    contributions at all. Branching only on "did an id
					//    resolve" left this case showing opening amounts only —
					//    strictly worse than the Phase 1 stopgap it replaced.
					//  - A permanent gap: a sale where staging was skipped (no
					//    lifecycle id at sale time, Dexie in safe mode, the
					//    staging timeout in Payments.vue firing) is invisible to
					//    the ledger forever, but the scan still catches it if it
					//    was queued.
					// Wrapped in its own try/catch — see the comment above
					// `queued`'s assignment: a scan failure must not undo it.
					let scan = { byMop: {}, uncertainCount: 0, byInvoice: new Map() };
					try {
						scan = await scanQueuedContributionsByInvoice({
							openingServerName: opening.name || null,
							shiftOfflineId: lifecycleId,
							cashMode,
							precision,
						});
					} catch (err) {
						console.warn(
							"[Pos] outbox scan failed; queued-only sales may be missing from the figure",
							err,
						);
					}

					// UNION the two stores, per invoice. Both key on the same
					// invoice `offline_id` (`call()` passes it as
					// `offlineIdempotencyKey`; `enqueue` stores it verbatim), so
					// "in the ledger" and "in the outbox" is an exact test and
					// the union is exactly computable: every ledger contribution,
					// PLUS every outbox invoice the ledger never saw.
					//
					// Earlier revisions computed the scan and then threw its
					// money away, folding it into a bare count. That understated
					// the drawer by the full value of any sale whose staging was
					// skipped — on upgrade day, by the whole pre-upgrade shift.
					// Neither store is a superset of the other (the scan can't
					// see online sales; the ledger can't see sales staged before
					// it existed or when staging was skipped), so taking either
					// one alone is wrong.
					const ledgerIds = new Set(derived.offlineIds);
					const byMop = { ...derived.byMop };
					const f = 10 ** precision;
					let gapCount = 0;
					for (const [offlineId, contribution] of scan.byInvoice) {
						if (ledgerIds.has(offlineId)) continue; // already counted — never twice.
						gapCount += 1;
						for (const [mop, amount] of Object.entries(contribution)) {
							byMop[mop] =
								Math.round(((byMop[mop] || 0) + amount) * f) / f;
						}
					}
					queued = {
						byMop,
						// Combine every signal the ledger's own pendingCount
						// misses: contributions still pending (stage/confirm not
						// resolved) PLUS rows that would not decrypt PLUS outbox
						// invoices this shift has in needs_review/handed_off
						// (server rejected or handed the sale off) PLUS the
						// invoices the ledger never recorded at all.
						// `confirmContribution` fires on the enqueue ack, before
						// either outbox outcome is known, so a later-rejected
						// sale stays "confirmed" and would otherwise raise no
						// flag at all.
						uncertainCount:
							derived.pendingCount +
							derived.skippedCount +
							scan.uncertainCount +
							gapCount,
					};
				} else {
					const { sumQueuedPaymentsByMop } = await import(
						"@/offline/shift-lifecycle"
					);
					queued = await sumQueuedPaymentsByMop({
						openingServerName: opening.name || null,
						// The two fields `lifecycleId` above is derived from
						// (`pospire_lifecycle_id`, `pos_offline_id`) are both
						// already known falsy by the time this branch is
						// reachable — that's what made `lifecycleId` null — so
						// there is nothing left to pass here.
						shiftOfflineId: null,
						cashMode,
						precision,
					});
				}
			} catch (err) {
				console.warn("[Pos] expected-amount derivation failed", err);
			}

			const seen = new Set();
			const payment_reconciliation = balance.map((row) => {
				seen.add(row.mode_of_payment);
				const opening_amount = row.amount || 0;
				return {
					mode_of_payment: row.mode_of_payment,
					opening_amount,
					expected_amount:
						opening_amount + (queued.byMop[row.mode_of_payment] || 0),
					closing_amount: 0,
					difference: 0,
				};
			});
			// A MOP taken on an invoice but absent from balance_details gets
			// its own row, mirroring the server's seen_mops handling. Dropping
			// it would silently lose the amount.
			Object.entries(queued.byMop).forEach(([mode_of_payment, amount]) => {
				if (seen.has(mode_of_payment)) return;
				payment_reconciliation.push({
					mode_of_payment,
					opening_amount: 0,
					expected_amount: amount,
					closing_amount: 0,
					difference: 0,
				});
			});

			return {
				name: "",
				pos_opening_shift: opening.name || "",
				pos_opening_shift_offline_id: opening.pos_offline_id || null,
				period_start_date: opening.period_start_date || "",
				pos_profile: opening.pos_profile || (this.pos_profile && this.pos_profile.name),
				user: opening.user || "",
				company: opening.company || (this.pos_profile && this.pos_profile.company),
				grand_total: 0,
				net_total: 0,
				total_quantity: 0,
				payment_reconciliation,
				pos_transactions: [],
				taxes: [],
				denomination_details: opening.denomination_details || [],
				pospire_offline_stub: true,
				pospire_uncertain_count: queued.uncertainCount,
				// "ledger" | "scan" — which store the expected amounts came
				// from. The dialog needs it because only the scan branch is
				// structurally blind to sales made earlier while ONLINE, and
				// that caveat must not be shown when it is false.
				pospire_source: source,
			};
		},
		async submit_closing_pos(data) {
			// Carry the parent opening's offline_id and the list of invoice
			// offline_ids onto the closing payload so the registry adapter can
			// build parent_offline_ids correctly. The adapter strips these
			// from the persisted doc before sending.
			const closingPayload = {
				...data,
				pos_opening_shift_offline_id:
					data.pos_opening_shift_offline_id ||
					this.pos_opening_shift?.pos_offline_id ||
					null,
				// Only a still-queued opening is a local outbox parent; the id
				// above is still sent to the server either way.
				pos_opening_shift_pending_sync: Boolean(
					this.pos_opening_shift?.pospire_pending_sync,
				),
				invoice_offline_ids: await this.collectShiftInvoiceOfflineIds(),
			};

			const closeRoute = await this.classifyCloseRoute();
			if (closeRoute === "already-queued") {
				toast.warning(
					__("A close-shift is already queued for this shift. It will finalise once every invoice in this shift has synced."),
					{ autoClose: 6000 },
				);
				return;
			}
			let r = null;
			try {
				r = await call({
					method:
						"pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift",
					args: { closing_shift: closingPayload },
					intent: "write",
					forceQueue: closeRoute === "force-queue",
				});
			} catch (err) {
				console.error("[Pos] submit_closing_shift failed", err);
				toast.error(err && err.message ? err.message : __("Failed to close shift"));
				this.check_opening_entry();
				return;
			}
			if (r && r.offline === true && r.status === "enqueued") {
				// Durable closing-pending state. The old code wrote a marker into
				// the opening-shift snapshot and then nulled that same snapshot six
				// lines later, so every reload-time recovery hook was dead: the
				// sales lock evaporated and the queued close became invisible on
				// refresh. State now lives on the shift row, which can also
				// represent "A is closing while B is already open" — the normal
				// state right after this branch routes the cashier to the dialog.
				if (this.shiftLifecycleId) {
					try {
						const { markShiftClosingPending } = await import(
							"@/offline/shift-lifecycle"
						);
						await markShiftClosingPending(this.shiftLifecycleId, r.offline_id);
					} catch (err) {
						console.warn("[Pos] markShiftClosingPending failed", err);
					}
				}
				this.pendingClosingOfflineId = r.offline_id;
				toast.info(
					__("Shift close queued. It will finalise once every invoice in this shift has synced."),
					{ autoClose: 5000 },
				);
				this.eventBus.emit("shift_closing_pending", {
					shift_lifecycle_id: this.shiftLifecycleId,
					closing_offline_id: r.offline_id,
				});
				// The snapshot is deliberately left pointing at the closing shift so
				// the next boot can still find it. The lock is NOT re-derived from
				// the snapshot's `pospire_lifecycle_id`: registerShiftLifecycle()
				// re-derives the id through registerOpenedShift()'s dedupe and
				// re-emits from getShiftById(). The stamp is only a fallback for
				// Invoice.isShiftLocked().
				this.pos_opening_shift = "";
				this.create_opening_voucher();
				return;
			}
			if (r) {
				toast.success(__("POS Shift Closed"));
				this.check_opening_entry();
			}
		},
		async classifyCloseRoute() {
			const openingOfflineId = this.pos_opening_shift?.pos_offline_id;
			const openingServerName = this.pos_opening_shift?.name;
			if (!openingOfflineId && !openingServerName) return "live";
			try {
				const { listByStatus } = await import("@/offline/outbox");
				const unsyncedStatuses = [
					"enqueued",
					"in_flight",
					"retry_pending",
					"needs_review",
					"handed_off",
				];
				const all = await Promise.all(
					unsyncedStatuses.map((s) => listByStatus(s)),
				);
				const flat = all.flat();
				const matchesShift = (row) => {
					if (openingOfflineId && row.shift_offline_id === openingOfflineId) {
						return true;
					}
					if (!openingServerName) return false;
					if (row.shift_offline_id) return false;
					const inner = this.unwrapInnerInvoicePayload(row.payload);
					return (
						inner &&
						(inner.posa_pos_opening_shift === openingServerName ||
							inner.pos_opening_shift === openingServerName)
					);
				};
				const queuedClosing = flat.find(
					(row) => row.type === "closing_entry" && matchesShift(row),
				);
				if (queuedClosing) return "already-queued";
				const queuedInvoice = flat.find(
					(row) => row.type === "invoice" && matchesShift(row),
				);
				if (queuedInvoice) return "force-queue";
				return "live";
			} catch (err) {
				console.warn("[Pos] classifyCloseRoute failed; defaulting to live", err);
				return "live";
			}
		},

		async collectShiftInvoiceOfflineIds() {
			// `pos_offline_id` is CLEARED once the opening syncs (see the
			// opening-sync handler below), but this shift's pre-sync invoice
			// rows still carry that UUID in `shift_offline_id`. The lifecycle id
			// is deliberately preserved as the surviving handle on them, so the
			// local anchor must fall back to it or those invoices vanish from
			// strict closure.
			// The server endpoint keys off the REAL offline id only; the
			// lifecycle fallback below is a local-scan concern and must not be
			// sent as `opening_shift_offline_id`.
			const openingOfflineId = this.pos_opening_shift?.pos_offline_id || null;
			const openingLocalAnchor =
				openingOfflineId ||
				this.pos_opening_shift?.pospire_lifecycle_id ||
				this.shiftLifecycleId ||
				null;
			const openingServerName = this.pos_opening_shift?.name;
			if (!openingLocalAnchor && !openingServerName) return [];

			const merged = new Set();
			try {
				const { listByStatus } = await import("@/offline/outbox");
				const all = await Promise.all([
					listByStatus("enqueued"),
					listByStatus("in_flight"),
					listByStatus("retry_pending"),
					listByStatus("needs_review"),
					// handed_off is a tombstone awaiting server-side review, NOT a
					// terminal state — it must still block closure.
					listByStatus("handed_off"),
					listByStatus("synced"),
				]);
				const flat = all.flat();
				const invoiceRows = flat.filter((row) => row.type === "invoice");

				const { selectShiftInvoiceOfflineIds } = await import(
					"@/offline/shift-invoice-anchors"
				);
				selectShiftInvoiceOfflineIds(
					{ localAnchor: openingLocalAnchor, serverName: openingServerName ?? null },
					invoiceRows,
					(row) => {
						const inner = this.unwrapInnerInvoicePayload(row.payload);
						if (!inner) return null;
						return (
							inner.posa_pos_opening_shift || inner.pos_opening_shift || null
						);
					},
				).forEach((id) => merged.add(id));
			} catch (err) {
				console.warn("[Pos] collectShiftInvoiceOfflineIds local scan failed", err);
			}

			try {
				const { call } = await import("@/utils/call");
				const serverIds = await call({
					method: "pospire.pospire.api.offline.get_shift_invoice_offline_ids",
					args: {
						opening_shift_name: openingServerName ?? null,
						opening_shift_offline_id: openingOfflineId ?? null,
					},
					intent: "read",
				});
				if (Array.isArray(serverIds)) {
					serverIds.forEach((id) => { if (id) merged.add(id); });
				}
			} catch (err) {
				console.warn("[Pos] collectShiftInvoiceOfflineIds server fetch failed", err);
			}

			return [...merged];
		},

		unwrapInnerInvoicePayload(payload) {
			if (!payload || typeof payload !== "object") return null;
			if (typeof payload.data === "string") {
				try {
					return JSON.parse(payload.data);
				} catch {
					return null;
				}
			}
			return payload;
		},
		async get_offers(pos_profile) {
			// `get_offers` is registered as `offline:true` with a 2h cache.
			// On a stale-cache hit the underlying call() returns a
			// StaleReadResult<T> wrapper { data, stale, cachedAt }. We unwrap
			// uniformly here so neither the localStorage snapshot nor the
			// eventBus consumers (Invoice.vue's posOffers) ever see the
			// wrapper. Without unwrap, posOffers becomes the wrapper object,
			// posOffers.forEach throws, and the offer engine silently no-ops.
			const OFFERS_KEY = "pospire.offers_snapshot." + pos_profile;
			let offers = null;
			try {
				offers = unwrapStale(
					await call("pospire.pospire.api.posapp.get_offers", {
						profile: pos_profile,
					}),
				);
				if (offers) {
					try {
						localStorage.setItem(OFFERS_KEY, JSON.stringify(offers));
					} catch {
						/* non-fatal */
					}
				}
			} catch {
				try {
					const cached = localStorage.getItem(OFFERS_KEY);
					if (cached) {
						// Defensive: a previous build wrote the wrapper into
						// localStorage. Strip it on read so devices don't have
						// to clear their cache to recover.
						const parsed = JSON.parse(cached);
						offers = unwrapStale(parsed);
					}
				} catch {
					/* corrupt cache */
				}
			}
			if (offers) {
				this.eventBus.emit("set_offers", offers);
			}
		},
		/**
		 * Warm the offline read-cache entry for the Create / Update Customer
		 * dialog's reference-data dropdowns (Customer Group, Territory,
		 * Gender). We hit this on shift-open — when the cashier is reliably
		 * online — so the cache is populated before they ever open the
		 * dialog. Subsequent dialog opens (including offline ones) read from
		 * cache and the dropdowns render normally instead of empty.
		 *
		 * Fire-and-forget: the dialog itself also calls the same endpoint
		 * lazily, so a transient failure here just defers the warm to first
		 * dialog open. Catch swallows because there is no graceful UI for
		 * "warm-up failed" — the dialog will surface the real error if and
		 * when it can't load.
		 */
		async warm_customer_form_options_cache() {
			try {
				await call({
					method:
						"pospire.pospire.api.offline.get_customer_form_options",
					intent: "read",
					cacheKey: "offline.customer_form_options",
				});
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(
					"[Pos] warm_customer_form_options_cache failed (non-fatal)",
					err,
				);
			}
		},
		async get_pos_setting() {
			const KEY = "pospire.pos_settings_snapshot";
			let doc = null;
			try {
				doc = await call("frappe.client.get", { doctype: "POS Settings", name: "POS Settings" });
				if (doc) {
					try {
						localStorage.setItem(KEY, JSON.stringify(doc));
					} catch {
						/* non-fatal */
					}
				}
			} catch {
				try {
					const cached = localStorage.getItem(KEY);
					if (cached) doc = JSON.parse(cached);
				} catch {
					/* corrupt cache */
				}
			}
			if (doc) {
				this.eventBus.emit("set_pos_settings", doc);
			}
		},
	},

	mounted: function () {
		// Re-warm customer form options whenever the device comes back online.
		// Covers the case where the POS opened while offline (empty Dexie)
		// and connectivity was restored later in the session.
		this._unsubConnectivity = connectivity.onChange(() => {
			if (connectivity.isOnline()) {
				this.warm_customer_form_options_cache();
			}
		});

		this.$nextTick(function () {
			// Rebuild closing-pending state from the outbox BEFORE the shift
			// check runs, so a reload lands in the right state instead of
			// silently resuming selling on a shift that is already closing —
			// or staying locked on one whose closing landed while the app was
			// shut. The shift check is chained rather than merely sequenced:
			// reconciliation is async, and check_opening_entry() reads the very
			// rows it rewrites. Chained off `.finally` so an import or Dexie
			// failure still boots the POS.
			import("@/offline/shift-lifecycle")
				.then(({ reconcilePendingClosuresFromOutbox }) =>
					reconcilePendingClosuresFromOutbox(),
				)
				.then((result) => {
					// `released` ONLY — deliberately not `result.reopened`. A
					// reopened shift is one whose closing was voided, so it is
					// still Open server-side and its snapshot is the thing that
					// lets the cashier resume on it. Dropping that snapshot is
					// what used to strand them in the opening dialog and get a
					// second shift opened against the first.
					this.dropSnapshotForReleasedShifts(result?.released);
					// Reconciliation-path contribution prune (see the method's
					// doc comment). Deliberately NOT awaited: this whole chain
					// exists to unblock `check_opening_entry()` in `.finally`
					// below, and pruning must never delay or fail that boot.
					this.pruneReleasedShiftContributions(result?.released);
				})
				.catch((err) => {
					console.warn("[Pos] pending-closure reconciliation failed", err);
				})
				.finally(() => {
					// Chained, not merely sequenced: the closing dialog needs
					// `pos_opening_shift`, which only exists once the shift
					// check has settled.
					this.check_opening_entry()
						.finally(() => this.consumeCloseShiftIntent())
						.catch((err) => {
							console.warn("[Pos] opening-shift check failed", err);
						});
				});
			this.get_pos_setting();
			this.onBus("close_opening_dialog", () => {
				this.dialog = false;
			});
			this.onBus("register_pos_data", (data) => {
				// FIRST, before anything can observe the new shift. `pos_opening_shift`
				// below is assigned synchronously but `shiftLifecycleId` is only
				// assigned tens of ms later, inside registerShiftLifecycle(), after
				// initOfflineStorage() + registerOpenedShift(). If the previous
				// shift's closing syncs inside that gap — and that gap IS a reconnect,
				// which is exactly when both happen at once — the onSynced handler's
				// `resolved.shiftLifecycleId === this.shiftLifecycleId` would still
				// match the OLD shift and wipe the one just opened. Nulling first
				// makes that comparison unmatchable during the gap.
				// `pendingClosingOfflineId` is cleared for a different reason: it
				// gates the opening dialog's exits, and a closing parked in
				// needs_review / handed_off can sit there indefinitely — a new shift
				// must end the exit-less state.
				this.shiftLifecycleId = null;
				this.pendingClosingOfflineId = null;
				this.pos_profile = data.pos_profile;
				this.get_offers(this.pos_profile.name);
				this.pos_opening_shift = data.pos_opening_shift;
				this.registerShiftLifecycle(data);
				this.eventBus.emit("register_pos_profile", data);
				if (data.pos_profile && data.company) {
					this.persistOpeningSnapshot(
						data,
						"pospire.opening_shift_snapshot",
						"pospire.opening_shift_snapshot.meta",
					);
				}
				this.warm_customer_form_options_cache();
			});
			this.onBus("show_payment", (data) => {
				this.payment = data === "true";
			});
			this.onBus("show_offers", (data) => {
				this.showOffersModal = data === "true";
			});
			this.onBus("show_coupons", (data) => {
				this.showCouponsModal = data === "true";
			});
			this.onBus("open_closing_dialog", () => {
				this.get_closing_data();
			});
			this.onBus("submit_closing_pos", (data) => {
				this.submit_closing_pos(data);
			});

			// Track whether the cart has items so the profile refresh
			// can decide to apply immediately or defer.
			this.onBus("add_item", () => {
				this.cartHasItems = true;
			});
			this.onBus("load_invoice", () => {
				this.cartHasItems = true;
			});
			this.onBus("load_order", () => {
				this.cartHasItems = true;
			});
			this.onBus("load_return_invoice", () => {
				this.cartHasItems = true;
			});

			// Shared handler: reset cart flag and apply any pending refreshes.
			// Priority: pendingProfileData (register_pos_profile already cascades
			// get_items + get_customer_names downstream, so standalone refresh
			// events are skipped to avoid redundant fetches).
			const onCartEmpty = () => {
				this.cartHasItems = false;
				if (this.pendingProfileData) {
					this.get_offers(this.pendingProfileData.pos_profile.name);
					this.eventBus.emit("register_pos_profile", this.pendingProfileData);
				} else {
					if (this.pendingMasterDataRefresh.items) {
						this.eventBus.emit("refresh_items");
					}
					if (this.pendingMasterDataRefresh.customers) {
						this.eventBus.emit("refresh_customers");
					}
				}
				// Unconditionally reset all pending state — even when
				// pendingProfileData took priority, so stale master-data
				// flags cannot replay on the next cart-clear.
				this.pendingProfileData = null;
				this.pendingMasterDataRefresh = { items: false, customers: false };
				this._deferredRefreshToastShown = false;
			};

			// Cart cleared via payment or Save-and-Clear.
			this.onBus("clear_invoice", onCartEmpty);
			// Cart emptied by manually removing the last item.
			this.onBus("cart_emptied", onCartEmpty);

			// F2: when an offline-opened shift finally syncs, swap the cart's
			// `pos_opening_shift.name` from the provisional `OFFLINE-OPN-...`
			// to the real server doc name. Subsequent invoices stop needing
			// the offline_id forwarding (Invoice.vue's get_invoice_doc only
			// emits `pos_opening_shift_offline_id` when that field is set).
			this._unsubShiftSync = onSynced(async (event) => {
				if (event.type === "opening_entry") {
					if (!event.server_doc_name || !event.provisional_name) return;
					// FIRST: give the durable shift row its server identity. The
					// row was created keyed only by this opening's outbox id
					// (`event.offline_id` === the shift row's `offline_id`), with
					// `opening_server_name: null`. Everything below clears
					// `pos_offline_id` from memory and from the snapshot, so
					// after the next reload the shift looks like an ordinary
					// server-named one — and without this write its row could not
					// be found by that name, a SECOND `open` row was created, and
					// any queued close stopped applying to the shift the cashier
					// was on. Status is preserved by attachOpeningServerName: the
					// close may already be queued by the time the opening lands.
					try {
						const { attachOpeningServerName } = await import(
							"@/offline/shift-lifecycle"
						);
						await attachOpeningServerName(
							event.offline_id,
							event.server_doc_name,
						);
					} catch (err) {
						console.warn("[Pos] attachOpeningServerName failed", err);
					}
					if (
						this.pos_opening_shift &&
						this.pos_opening_shift.name === event.provisional_name
					) {
						// Keep the lifecycle id reachable after `pos_offline_id`
						// goes: it is the only remaining handle on the durable row
						// (and on this shift's pre-sync outbox rows) once the
						// offline id is cleared below.
						if (!this.pos_opening_shift.pospire_lifecycle_id) {
							this.pos_opening_shift.pospire_lifecycle_id =
								this.pos_opening_shift.pos_offline_id || event.offline_id;
						}
						this.pos_opening_shift.name = event.server_doc_name;
						this.pos_opening_shift.pos_offline_id = null;
						this.pos_opening_shift.pospire_pending_sync = false;
					}
					// Refresh the localStorage snapshot so a hard reload picks up
					// the resolved name instead of the now-stale provisional one.
					try {
						const raw = localStorage.getItem("pospire.opening_shift_snapshot");
						if (raw) {
							const cached = JSON.parse(raw);
							if (
								cached?.pos_opening_shift?.name === event.provisional_name
							) {
								// Same reason as the in-memory patch above: this is
								// the last chance to persist the durable row's id
								// before `pos_offline_id` is cleared out of the
								// snapshot, and the next boot's dedupe reads it.
								if (!cached.pos_opening_shift.pospire_lifecycle_id) {
									cached.pos_opening_shift.pospire_lifecycle_id =
										cached.pos_opening_shift.pos_offline_id ||
										event.offline_id;
								}
								cached.pos_opening_shift.name = event.server_doc_name;
								cached.pos_opening_shift.pos_offline_id = null;
								cached.pos_opening_shift.pospire_pending_sync = false;
								localStorage.setItem(
									"pospire.opening_shift_snapshot",
									JSON.stringify(cached),
								);
							}
						}
					} catch {
						/* localStorage parse failure is non-fatal */
					}
					toast.success(
						`Shift ${event.server_doc_name} now synced`,
						{ autoClose: 3000 },
					);
					return;
				}

					// H4: closing entry synced. The shift is now genuinely closed
					// on the server. Key off the CLOSING's own offline_id: the old
					// guard read the ACTIVE shift's pending marker, so a synced
					// closing for shift A could reset shift B — and after a reload
					// (marker gone) it matched nothing at all and silently returned.
					if (event.type === "closing_entry") {
						let resolved = null;
						try {
							const { resolveClosingSynced } = await import(
								"@/offline/shift-lifecycle"
							);
							resolved = await resolveClosingSynced(
								event.offline_id,
								event.server_doc_name ?? null,
							);
						} catch (err) {
							console.warn("[Pos] resolveClosingSynced failed", err);
							return;
						}
						if (!resolved) return;

						// The close has landed server-side, so this shift's
						// contributions can go. Deliberately NOT done at close
						// time: a queued close can sit unsynced for hours and
						// the dialog may be reopened in the meantime.
						//
						// LIVE-SYNC prune — DISTINCT from the reconciliation-path
						// prune in `pruneReleasedShiftContributions` (called from
						// the `mounted` reconciliation chain). Do NOT merge these
						// two: this one only ever fires while a subscriber is
						// running at the moment the sync happens (see that
						// method's doc comment for the cases it misses and why
						// the other hook exists to catch them).
						try {
							const { deleteContributionsForShift } = await import(
								"@/offline/contribution-ledger"
							);
							await deleteContributionsForShift(resolved.shiftLifecycleId);
						} catch (err) {
							console.warn("[Pos] contribution prune failed", err);
						}

						if (this.pendingClosingOfflineId === event.offline_id) {
							this.pendingClosingOfflineId = null;
						}
						toast.success(__("Shift closed and synced"), { autoClose: 3000 });
						this.eventBus.emit("shift_closing_complete", {
							shift_lifecycle_id: resolved.shiftLifecycleId,
							closing_offline_id: event.offline_id,
							closing_server_name: event.server_doc_name,
						});

						// Route to the opening dialog only if the cashier is STILL on
						// the shift that just closed. If they already opened the next
						// one, leave it — and its snapshot — completely alone.
						if (resolved.shiftLifecycleId === this.shiftLifecycleId) {
							this.invalidateOpeningSnapshot(
								"pospire.opening_shift_snapshot",
								"pospire.opening_shift_snapshot.meta",
							);
							this.shiftLifecycleId = null;
							this.pos_opening_shift = "";
							this.pos_profile = "";
							this.create_opening_voucher();
						}
					}
				});

			// Shared deferred-refresh toast guard — one neutral toast for
			// both pos_profile_updated and pos_master_data_invalidated.
			this._deferredRefreshToastShown = false;

			// When the POS Profile is saved from the desk mid-shift, re-fetch it and:
			// - If cart is empty  → apply immediately.
			// - If cart has items → hold as pending; applies after current invoice clears.
			window.frappe?.realtime?.on("pos_profile_updated", (data) => {
				if (this.pos_profile && data.pos_profile === this.pos_profile.name) {
					call("pospire.pospire.api.posapp.check_opening_shift", {
						user: window.user,
					}).then((r) => {
						if (!r) return;
						this.pos_profile = r.pos_profile;
						if (!this.cartHasItems) {
							this.get_offers(r.pos_profile.name);
							this.eventBus.emit("register_pos_profile", r);
						} else {
							this.pendingProfileData = r;
							if (!this._deferredRefreshToastShown) {
								this._deferredRefreshToastShown = true;
								toast.info(
									__("Updates detected. Catalog will refresh after this transaction."),
									{ autoClose: 4000 }
								);
							}
						}
					});
				}
			});

			// When master data (Item, Customer, etc.) changes, the backend
			// publishes pos_master_data_invalidated with scoped flags.
			window.frappe?.realtime?.on("pos_master_data_invalidated", (data) => {
				if (!data || typeof data !== "object") return;
				if (!this.cartHasItems) {
					if (data.items) this.eventBus.emit("refresh_items");
					if (data.customers) this.eventBus.emit("refresh_customers");
				} else {
					if (data.items) this.pendingMasterDataRefresh.items = true;
					if (data.customers) this.pendingMasterDataRefresh.customers = true;
					if (!this._deferredRefreshToastShown) {
						this._deferredRefreshToastShown = true;
						toast.info(
							__("Updates detected. Catalog will refresh after this transaction."),
							{ autoClose: 4000 }
						);
					}
				}
			});
		});
	},
	beforeUnmount() {
		window.frappe?.realtime?.off("pos_profile_updated");
		window.frappe?.realtime?.off("pos_master_data_invalidated");
		if (typeof this._unsubConnectivity === "function") {
			this._unsubConnectivity();
			this._unsubConnectivity = null;
		}
		if (typeof this._unsubShiftSync === "function") {
			this._unsubShiftSync();
			this._unsubShiftSync = null;
		}
	},
};
</script>

<style scoped>
/*
 * Height chain: viewport -> pos-page -> itemselector-section -> columns -> panels
 * Only pos-page calculates from viewport. Children use 100% to fill parent.
 */
.pos-page {
	/*
	 * Subtract navbar (--v-layout-top, written by Vuetify when v-app-bar
	 * registers) AND the offline banner (--pospire-banner-height, set on
	 * <v-app> in App.vue, 0px when hidden / 44px when visible). Without
	 * the banner term the cart's bottom edge runs off-screen whenever
	 * the banner is showing.
	 */
	height: calc(
		100dvh - var(--v-layout-top, 48px) - var(--pospire-banner-height, 0px)
	);
	max-height: calc(
		100dvh - var(--v-layout-top, 48px) - var(--pospire-banner-height, 0px)
	);
	overflow: hidden;
}

.itemselector-section {
	/* Fill parent height using explicit height, not flex */
	/* v-row children need explicit parent height for height: 100% to work */
	height: 100% !important;
	max-height: 100% !important;
	overflow: hidden;
}

/* Ensure columns pass height to children */
.pos {
	height: 100%;
	max-height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.invoice-section {
	height: 100%;
	max-height: 100%;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
</style>
