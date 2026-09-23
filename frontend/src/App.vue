<template>
	<!--
		The banner sits at the top of v-main as an in-flow, position:sticky
		strip. It self-publishes its rendered height to
		--pospire-banner-height on <html> via a ResizeObserver in
		OfflineBanner.vue, which page-level CSS subtracts from its
		viewport-height calc so the cart's bottom edge stays aligned. No
		hardcoded heights, no Vuetify layout-item registration, no inline
		style binding here.
	-->
	<v-app class="pospire-app">
		<!--
			Navbar registers at the v-app level so Vuetify auto-pads <v-main>
			for the navbar's actual height (writes to --v-layout-top). The
			banner is NOT a layout item — it's an in-flow div inside v-main.
		-->
		<Navbar
			@changePage="navigateTo($event)"
			@open-reconciliation="reconciliationOpen = true"
		></Navbar>

		<v-main>
			<!--
				OfflineBanner owns its own visibility (internal v-if on the
				bannerState !== 'hidden' predicate) and its own height
				publication. We unconditionally render the component; when
				it's hidden it produces no DOM and zeroes
				--pospire-banner-height in onBeforeUnmount.
			-->
			<OfflineBanner
				class="pospire-app__banner"
				@open-reconciliation="reconciliationOpen = true"
			/>
			<router-view class="mx-4 md-4"></router-view>

			<!--
				Read-only Offline Sync Status — opens via the banner's
				"Review now" button or the Navbar's pending-sync badge.
				Replaces the old cashier-side ReconciliationWorkspace
				(which had Retry/Void/Edit-Retry actions). All recovery
				actions now live in Desk under Sales Manager / System
				Manager authority — this dialog only shows the cashier
				the status of their handed-off entries.
			-->
			<v-dialog v-model="reconciliationOpen" max-width="900" scrollable>
				<OfflineSyncStatus />
			</v-dialog>
		</v-main>
	</v-app>
</template>

<script>
import Navbar from "@/components/Navbar.vue";
import OfflineBanner from "@/components/offline/OfflineBanner.vue";
import OfflineSyncStatus from "@/components/offline/OfflineSyncStatus.vue";
import connectivity from "@/offline/connectivity";
import { initOfflineStorage } from "@/offline/db";
import { registerReadCache } from "@/offline/runtime";
import { DexieMetadataReadCache } from "@/offline/read-cache";
import { call } from "@/utils/call";
import {
	scheduler as syncScheduler,
	migrateLegacyNeedsReviewEntries,
} from "@/offline/sync";
import { startBeacon, stopBeacon } from "@/offline/beacon";

export default {
	components: {
		Navbar,
		OfflineBanner,
		OfflineSyncStatus,
	},
	data() {
		return {
			reconciliationOpen: false,
			offlineDisabled: false,
		};
	},
	beforeMount() {
		// Register the read-cache before route components mount. Dashboard.vue
		// can fetch on its own onMounted hook; if this stayed in App.mounted(),
		// that first successful online read could happen before call() had a
		// cache implementation to write into.
		registerReadCache(new DexieMetadataReadCache());
	},
	async mounted() {
		// Bootstrap the offline storage layer: opens Dexie, seeds device_id,
		// generates the encryption key (D-24), starts the health probe.
		// On failure (e.g. crypto.subtle unavailable, IndexedDB blocked) we
		// boot in offline-disabled mode rather than crashing the SPA.
		try {
			await initOfflineStorage();
		} catch (err) {
			this.offlineDisabled = true;
			// eslint-disable-next-line no-console
			console.error(
				"[App] initOfflineStorage failed; running in offline-disabled mode",
				err,
			);
			// Skip the rest — without storage, scheduler / connectivity have
			// nothing to do.
			return;
		}

		// Start the connectivity detector so it drives the banner state.
		connectivity.start();

		this.bootstrapPosProfileForNavbar().catch((err) => {
			// Non-fatal: POS.vue still performs the full opening-shift flow when
			// the cashier visits POS. This startup fetch only teaches Navbar
			// whether profile-gated menu items such as Payments should appear.
			console.warn("[App] POS profile bootstrap failed", err);
		});

		// Start the outbox sync scheduler. Acquires the Web Locks API leader
		// lock; only the leader tab drains. Other tabs read state passively
		// via BroadcastChannel("pospire-offline").
		syncScheduler.start().catch((err) => {
			// eslint-disable-next-line no-console
			console.warn("[App] syncScheduler.start failed", err);
		});

		// Phase 1c: one-shot boot-time migration. Devices upgrading from
		// a pre-recovery-doctype client may have `needs_review` rows
		// already in their local outbox; the new code path uploads them
		// to the server-side `POSpire Offline Sync Review` queue. The
		// scheduler's cycle preamble would also pick these up on the
		// next wake, but doing it explicitly at boot gives an immediate
		// summary in the console and avoids the up-to-30s wait. Fire-
		// and-forget — failures here aren't fatal because the cycle
		// preamble is the safety net.
		migrateLegacyNeedsReviewEntries()
			.then((res) => {
				if (res.attempted > 0) {
					// eslint-disable-next-line no-console
					console.info(
						`[App] handed off ${res.attempted} legacy needs_review entr${res.attempted === 1 ? "y" : "ies"} to the server-side review queue`,
					);
				}
			})
			.catch((err) => {
				// eslint-disable-next-line no-console
				console.warn(
					"[App] migrateLegacyNeedsReviewEntries failed (non-fatal — cycle preamble will retry)",
					err,
				);
			});

		// B5 — observability beacon. Starts a 5-min ping that includes queue
		// depth + oldest pending age + last sync outcome. Pos.vue updates the
		// outlet/shift/user context via setBeaconContext when a shift opens.
		try {
			startBeacon();
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn("[App] startBeacon failed", err);
		}
	},
	beforeUnmount() {
		// Clean teardown of background timers + in-flight fetches when the
		// SPA is being torn down (e.g. tab close / Frappe logout).
		try {
			stopBeacon();
		} catch {
			/* idempotent */
		}
		try {
			syncScheduler.stop();
		} catch {
			/* idempotent */
		}
		try {
			connectivity.stop();
		} catch {
			/* idempotent */
		}
	},
	methods: {
		async bootstrapPosProfileForNavbar() {
			if (!window.user || window.user === "Guest") return;

			// "/" redirects to "/pos", so the path is only trustworthy once the
			// initial navigation has settled.
			await this.$router.isReady();

			// On /pos, Pos.vue runs the full opening-shift flow and broadcasts
			// the result. Bootstrapping here as well duplicated
			// check_opening_shift and, through register_pos_profile, every read
			// hanging off it — items, customers, approval, tax, M-Pesa. On every
			// other route nothing else populates the Navbar, so this stays.
			if (this.$route.path === "/pos") return;

			const snapshotKey = "pospire.opening_shift_snapshot";
			const snapshotMetaKey = "pospire.opening_shift_snapshot.meta";
			const snapshotTTLMs = 24 * 60 * 60 * 1000;
			const cachedSnapshot = this.readCachedOpeningSnapshot(
				snapshotKey,
				snapshotMetaKey,
				snapshotTTLMs,
			);
			const browserOffline =
				typeof navigator !== "undefined" && navigator.onLine === false;
			const shouldUseCachedImmediately =
				cachedSnapshot && (!connectivity.isOnline() || browserOffline);

			if (shouldUseCachedImmediately) {
				this.emitOpeningSnapshotForNavbar(cachedSnapshot);
			}

			let snapshot = null;
			try {
				snapshot = await call("pospire.pospire.api.posapp.check_opening_shift", {
					user: window.user,
				});
			} catch (err) {
				if (cachedSnapshot && !shouldUseCachedImmediately) {
					this.emitOpeningSnapshotForNavbar(cachedSnapshot);
					return;
				}
				if (!cachedSnapshot) {
					console.warn(
						"[App] POS profile bootstrap failed and no cached snapshot is available",
						err,
					);
				}
				return;
			}

			if (!snapshot?.pos_profile) return;

			this.persistOpeningSnapshot(snapshot, snapshotKey, snapshotMetaKey);
			this.emitOpeningSnapshotForNavbar(snapshot);
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
				localStorage.setItem(metaKey, JSON.stringify({ cached_at: Date.now() }));
			} catch {
				/* quota / privacy mode — non-fatal */
			}
		},
		emitOpeningSnapshotForNavbar(snapshot) {
			if (!snapshot?.pos_profile) return;
			// Navbar-only channel. `register_pos_profile` fans out to every POS
			// child — items, customers, offers, coupons, payments — each of
			// which answers by firing its own reads. Navbar is the only thing
			// that needs the profile on these routes.
			this.eventBus.emit("navbar_pos_profile", snapshot);
			this.eventBus.emit("set_company", snapshot.company);
		},
		navigateTo(page) {
			const routes = {
				POS: "/pos",
				Payments: "/payments",
				Dashboard: "/dashboard",
			};

			const route = routes[page] || "/pos";

			if (this.$route.path !== route) {
				this.$router.push(route);
			}
		},
	},
};
</script>

<style scoped>
.pospire-app {
	margin-top: 0px;
	height: 100vh;
	background: var(--pospire-app-bg);
	color: var(--pospire-text-main);
}
</style>
