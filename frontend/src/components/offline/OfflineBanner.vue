<template>
  <!--
    Connectivity + sync banner. Per 11-ui-ux.md §2: anchored below the navbar,
    non-modal, non-toast. Visibility gated by store-derived state so it never
    rerenders on every connectivity flap (D-31 debounce lives inside
    @/offline/connectivity; by the time the store sees a transition it's
    already debounced).

    State priority (highest first):
      1. needs_review count > 0 → red attention banner (managers)
      2. chained_shifts (>= 2 unsynced openings) → red attention (F5)
      3. offline → amber
      4. degraded connectivity → amber "unstable"
      5. online + queuedCount > 0 → blue "syncing"
      6. otherwise → hidden
  -->
  <div v-if="bannerState !== 'hidden'" ref="rootEl" class="offline-banner"
    :class="`offline-banner--${bannerState}`" role="status" aria-live="polite">
    <v-icon class="offline-banner__icon" :icon="iconForState"></v-icon>
    <span class="offline-banner__label">{{ label }}</span>
    <span v-if="subLabel" class="offline-banner__sub">{{ subLabel }}</span>
    <button v-if="bannerState === 'needs_review'" class="offline-banner__link" @click="$emit('open-reconciliation')">
      {{ __('Review now') }}
    </button>
    <!--
      OFFLINE state: cashier-tappable "Try connection now". Forces an immediate
      ping (bypasses polling cadence). On success, single ping is enough to
      transition the detector to ONLINE; the scheduler then drains naturally.
      On failure we surface a toast so the tap doesn't feel ignored.
    -->
    <button v-if="bannerState === 'offline'" class="offline-banner__link" :disabled="trying"
      @click="onTryConnectionNow">
      <v-icon v-if="trying" size="small" class="mr-1">mdi-loading mdi-spin</v-icon>
      {{ trying ? __('Checking…') : __('Try connection now') }}
    </button>
  </div>
</template>

<script>
/**
 * OfflineBanner.vue
 *
 * Consumes the Pinia `connectivity` and `outbox` stores. No direct network
 * I/O (P-2); no `frappe-ui` imports (component-level rule). The banner is
 * presentational — actions like force-online live on a manager panel.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { toast } from "vue3-toastify";

import { useConnectivityStore } from "@/stores/connectivity";
import { useOutboxStore } from "@/stores/outbox";
import connectivityModule from "@/offline/connectivity";

/**
 * The CSS variable that page-level layouts subtract from their viewport
 * height calc so the bottom edge of the cart / payments card aligns with
 * the bottom of the visible area. Set on <html> (so it cascades to every
 * subtree, including portals/dialogs) instead of being passed as an inline
 * style on <v-app> — that way it survives even if a future ancestor
 * stacking context interferes with style inheritance.
 */
const BANNER_HEIGHT_VAR = "--pospire-banner-height";

function setBannerHeightVar(px) {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty(
		BANNER_HEIGHT_VAR,
		`${Math.max(0, Math.ceil(px))}px`,
	);
}

export default defineComponent({
  name: "OfflineBanner",
  emits: ["open-reconciliation"],
  setup() {
    const connectivity = useConnectivityStore();
    const outbox = useOutboxStore();
    const trying = ref(false);

    async function onTryConnectionNow() {
      if (trying.value) return;
      trying.value = true;
      try {
        const ok = await connectivityModule.forcePingNow();
        if (!ok) {
          toast.warning(__("Still offline: server unreachable"), { autoClose: 3000 });
        }
        // On success the connectivity transition fires; banner auto-hides.
      } finally {
        trying.value = false;
      }
    }

    // `storeToRefs` preserves reactivity on destructured refs.
    const { connectionQuality } = storeToRefs(connectivity);
    const {
      pendingCount,
      inFlightCount,
      needsReviewCount,
      unsyncedOpeningCount,
      queuedCount,
      oldestPendingMinutes,
    } = storeToRefs(outbox);

    // State priority (see template comment).
    const bannerState = computed(() => {
      if (needsReviewCount.value > 0) return "needs_review";
      if (unsyncedOpeningCount.value >= 2) return "chained_shifts";
      if (connectionQuality.value === "offline") return "offline";
      if (connectionQuality.value === "degraded") return "degraded";
      if (queuedCount.value > 0) return "syncing";
      return "hidden";
    });

    const label = computed(() => {
      switch (bannerState.value) {
        case "needs_review":
          return `${needsReviewCount.value} transaction${needsReviewCount.value === 1 ? "" : "s"} need attention`;
        case "chained_shifts":
          return `${unsyncedOpeningCount.value} unsynced shift${unsyncedOpeningCount.value === 1 ? "" : "s"} stacked. Reconnect before opening another`;
        case "offline": {
          if (oldestPendingMinutes.value !== null && oldestPendingMinutes.value >= 30) {
            return `You are offline: ${oldestPendingMinutes.value} min`;
          }
          return `You are offline: ${queuedCount.value} transaction${queuedCount.value === 1 ? "" : "s"} queued`;
        }
        case "degraded":
          return "Connectivity unstable: saving locally";
        case "syncing":
          return `Syncing ${inFlightCount.value || pendingCount.value} transaction${(inFlightCount.value || pendingCount.value) === 1 ? "" : "s"}…`;
        default:
          return "";
      }
    });

    const subLabel = computed(() => {
      if (bannerState.value === "chained_shifts") {
        return "New shift opens are blocked at 3.";
      }
      if (bannerState.value === "offline") {
        return "Sales continue; transactions will sync when online.";
      }
      if (bannerState.value === "degraded") {
        return "Do not hard-reload.";
      }
      return "";
    });

    const iconForState = computed(() => {
      switch (bannerState.value) {
        case "needs_review":
          return "mdi-alert-circle-outline";
        case "chained_shifts":
          return "mdi-cash-register";
        case "offline":
          return "mdi-cloud-off-outline";
        case "degraded":
          return "mdi-access-point-network-off";
        case "syncing":
          return "mdi-cloud-sync-outline";
        default:
          return "mdi-circle-outline";
      }
    });

    /*
     * Dynamic banner-height publication.
     *
     * Page-level layouts (Pos.vue, Pay.vue, .pos-page etc) subtract
     * --pospire-banner-height from their viewport-height calc to keep the
     * cart's bottom edge aligned. Hardcoding 44px is fragile: text zoom,
     * longer translations, or a future second-line subtitle would all push
     * the rendered banner past 44px and the page would silently overflow.
     *
     * Instead we observe the banner's actual rendered border-box and write
     * the result to --pospire-banner-height on <html> on every change. When
     * the banner v-if's itself out (online steady state), rootEl flips to
     * null, we tear down the observer and zero the variable — pages reclaim
     * the 44px immediately.
     */
    const rootEl = ref(null);
    let observer = null;

    function teardown() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      setBannerHeightVar(0);
    }

    function startObserving(el) {
      if (!el || typeof ResizeObserver === "undefined") {
        // SSR or ancient browser fallback — best-effort static measurement.
        if (el) setBannerHeightVar(el.offsetHeight);
        return;
      }
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const box = entry.borderBoxSize?.[0];
        const height = box ? box.blockSize : entry.contentRect.height;
        setBannerHeightVar(height);
      });
      observer.observe(el);
      // Synchronous first read so the very first paint already has the
      // right --pospire-banner-height value (the observer's initial
      // callback fires after layout, which would cause a 1-frame flash).
      setBannerHeightVar(el.offsetHeight);
    }

    watch(rootEl, (el, oldEl) => {
      if (oldEl && !el) teardown();
      if (el && el !== oldEl) {
        // Re-attach if the element changed (rare — happens on bannerState
        // transitions that destroy/recreate the same v-if'd div).
        if (observer) observer.disconnect();
        startObserving(el);
      }
    });

    onBeforeUnmount(teardown);

    return {
      bannerState,
      label,
      subLabel,
      iconForState,
      trying,
      onTryConnectionNow,
      rootEl,
    };
  },
});
</script>

<style scoped>
.offline-banner {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 10px;
  padding: 8px 16px;
  /*
   * 44px is the design floor for one-line content; the banner is free to
   * grow if a future subtitle / translation / zoom pushes it taller. The
   * ResizeObserver in setup() publishes the actual rendered height to
   * --pospire-banner-height so page calcs stay correct regardless. The
   * earlier "lock to 44px exactly" approach masked overflow by clipping;
   * dynamic height is the honest fix.
   */
  min-height: 44px;
  box-sizing: border-box;
  font-size: 0.92rem;
  font-weight: 500;
  width: 100%;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  line-height: 1;
  /*
   * Sticky-pinned to the top of v-main's content area so even if the
   * page below has overflow:hidden / transforms / its own stacking
   * context, the banner can't be visually clipped by it. z-index is
   * set high enough to beat ordinary in-flow content but stays below
   * Vuetify overlays / dialogs (which use 2000+).
   */
  position: sticky;
  top: 0;
  z-index: 100;
}

.offline-banner__icon {
  font-size: 20px !important;
  flex-shrink: 0;
  /* Force icon line-box to match the banner's, defeating Vuetify's
     default 1.5 line-height that nudges the icon below center. */
  line-height: 1;
  height: 20px;
}

.offline-banner__label {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1;
}

.offline-banner__sub {
  font-weight: 400;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1;
}

.offline-banner__link {
  margin-left: auto;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.offline-banner__link:hover {
  background: rgba(255, 255, 255, 0.35);
}

/* ONLINE (hidden) is handled by v-if; no rule needed. */

.offline-banner--syncing {
  background: #1e88e5;
  color: #ffffff;
}

.offline-banner--degraded {
  background: #ffb300;
  color: #263238;
}

.offline-banner--offline {
  background: #e65100;
  color: #ffffff;
}

.offline-banner--needs_review {
  background: #c62828;
  color: #ffffff;
}

.offline-banner--chained_shifts {
  background: #b71c1c;
  color: #ffffff;
}

@media (max-width: 900px) {
  .offline-banner__sub {
    display: none;
  }
}
</style>
