<template>
  <nav>
    <v-app-bar height="72" class="modern-header" elevation="1">
      <v-app-bar-nav-icon @click.stop="drawer = !drawer" class="modern-nav-icon"></v-app-bar-nav-icon>
      <!-- Presentational only: v-toolbar-title is flex:1, so a click handler here covers the whole empty app-bar strip. -->
      <v-toolbar-title class="stylish-brand">
        <div class="brand-container-modern hover-vibrant">
          <!-- Client branding (left) -->
          <div class="client-brand-section">
            <div class="brand-icon" v-if="company_img && company_img !== '/assets/erpnext/images/erpnext-logo.svg'">
              <v-avatar size="36" class="client-logo">
                <v-img :src="company_img"></v-img>
              </v-avatar>
            </div>
            <span class="client-brand-name">{{ company }}</span>
          </div>

          <!-- Divider -->
          <div class="brand-divider"></div>

          <!-- POSpire branding (right) -->
          <div class="pospire-brand-section">
            <span class="powered-by-text">Powered by</span>
            <div class="pospire-logo-animated">
              <svg width="24" height="24" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" class="pospire-icon">
                <rect x="4" y="8" width="20" height="14" rx="3" fill="#34495E"/>
                <rect x="7" y="11" width="10" height="3" rx="1.5" fill="#00BCD4"/>
                <circle cx="8.5" cy="17.5" r="1" fill="#E2E8F0"/>
                <circle cx="12" cy="17.5" r="1" fill="#E2E8F0"/>
                <circle cx="15.5" cy="17.5" r="1" fill="#E2E8F0"/>
                <circle cx="28" cy="12" r="5" fill="url(#accentGradient2)" class="pulse-circle"/>
                <path d="M26 12L27.5 13.5L30.5 10.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <defs>
                  <linearGradient id="accentGradient2" x1="23" y1="7" x2="33" y2="17" gradientUnits="userSpaceOnUse">
                    <stop stop-color="#00BCD4"/>
                    <stop offset="1" stop-color="#0097A7"/>
                  </linearGradient>
                </defs>
              </svg>
              <span class="pospire-name">
                <span class="pospire-pos">POS</span><span class="pospire-pire">pire</span>
              </span>
            </div>
          </div>
        </div>
      </v-toolbar-title>

      <v-spacer></v-spacer>
      <!--
        Offline pending-sync badge. Hidden when queuedCount === 0. Reads
        from @/stores/outbox (Pinia reactive facade over Dexie liveQuery).
        Clickable: emits `open-reconciliation` so the parent can route to the
        OfflineSyncStatus dialog. That dialog is fully read-only — it
        shows handed-off entries (with their server OSR-... IDs so the
        cashier can give one to a manager), local rows still awaiting
        handoff, and rows currently in flight. Recovery actions
        (Retry / Void) live in Desk for Sales Manager / System Manager.
      -->
      <div v-if="queuedCount > 0" class="sync-badge-wrapper">
        <v-chip class="sync-badge" variant="tonal" color="warning" size="small" clickable
          :title="__('Tap to view pending and review queue')" @click="$emit('open-reconciliation')">
          <v-icon start size="small">mdi-cloud-sync-outline</v-icon>
          {{ queuedCount }} {{ __('pending') }}
        </v-chip>
      </div>
      <!--
        Compact inline connectivity pill. Sits next to the profile chip so the
        cashier has an always-visible status indicator even when the wide
        OfflineBanner subtitle is clipped on narrow viewports. Online state is
        rendered as a quiet green dot (no text); offline / degraded states get
        labels so they read at a glance. Click is wired to the same
        reconciliation workspace the badge below uses.
      -->
      <div class="connectivity-pill-wrapper">
        <v-chip
          v-if="connectionQuality === 'offline'"
          class="connectivity-pill"
          variant="tonal"
          color="error"
          size="small"
          :title="__('You are offline. Sales continue locally')"
        >
          <v-icon start size="small">mdi-cloud-off-outline</v-icon>
          {{ __('Offline') }}
        </v-chip>
        <v-chip
          v-else-if="connectionQuality === 'degraded'"
          class="connectivity-pill"
          variant="tonal"
          color="warning"
          size="small"
          :title="__('Connectivity unstable. Saving locally')"
        >
          <v-icon start size="small">mdi-access-point-network-off</v-icon>
          {{ __('Unstable') }}
        </v-chip>
        <v-chip
          v-else
          class="connectivity-pill connectivity-pill--online"
          variant="tonal"
          color="success"
          size="small"
          :title="__('Online')"
        >
          <v-icon start size="small">mdi-check-circle-outline</v-icon>
          {{ __('Online') }}
        </v-chip>
      </div>
      <div class="theme-toggle-wrapper">
        <ThemeToggle />
      </div>
      <div class="user-info">
        <v-chip class="user-chip pospire-chip-neutral" variant="tonal" color="grey-darken-2">
          <v-icon start size="small">mdi-account-circle</v-icon>
          {{ pos_profile.name || 'User' }}
        </v-chip>
      </div>
      <div class="text-center">
        <v-menu>
          <template v-slot:activator="{ props }">
            <v-btn class="menu-button" variant="text" v-bind="props">
              <v-icon>mdi-dots-vertical</v-icon>
            </v-btn>
          </template>
          <v-card class="mx-auto" max-width="300">
            <v-list v-model="menu_item" color="primary">

              <v-list-item @click="close_shift_dialog" v-if="!pos_profile.posa_hide_closing_shift && item == 0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-content-save-move-outline"></v-icon>
                </template>

                <v-list-item-title>{{
                  __('Close Shift')
                }}</v-list-item-title>

              </v-list-item>
              <v-list-item @click="print_last_invoice" v-if="
                pos_profile.posa_allow_print_last_invoice &&
                this.last_invoice
              ">
                <template v-slot:prepend>
                  <v-icon icon="mdi-printer"></v-icon>
                </template>

                <v-list-item-title>{{
                  __('Print Last Invoice')
                }}</v-list-item-title>

              </v-list-item>
              <v-divider class="my-0"></v-divider>
              <v-list-item @click="logOut">
                <template v-slot:prepend>
                  <v-icon icon="mdi-logout"></v-icon>
                </template>

                <v-list-item-title>{{ __('Logout') }}</v-list-item-title>

              </v-list-item>
              <v-list-item @click="go_about">
                <template v-slot:prepend>
                  <v-icon icon="mdi-information-outline"></v-icon>
                </template>

                <v-list-item-title>{{ __('About') }}</v-list-item-title>

              </v-list-item>

            </v-list>
          </v-card>
        </v-menu>
      </div>
      <!--
        OfflineBanner used to live in v-app-bar's `extension` slot, but
        Vuetify auto-reserves the default extension height even when the
        banner v-if'd itself out (online state) — leaving a phantom gap
        above the page content. The banner now mounts at the v-app level
        in App.vue as its own layout item, which collapses cleanly when
        hidden.
      -->
    </v-app-bar>
    <v-navigation-drawer v-model="drawer" v-model:mini-variant="mini" class="modern-sidebar" width="280" temporary>
      <!-- Company Header Section -->
      <div class="sidebar-header">
        <div class="company-info">
          <v-avatar size="48" class="company-avatar">
            <v-img :src="company_img"></v-img>
          </v-avatar>
          <div class="company-details">
            <div class="company-name">{{ company }}</div>
            <div class="company-type">Point of Sale</div>
          </div>
        </div>
      </div>
      
      <v-divider class="sidebar-divider"></v-divider>
      
      <!-- Navigation Menu -->
      <v-list class="navigation-list">
        <div class="menu-section">
          <v-list-item v-for="item in items" :key="item.text" @click="changePage(item.text)" class="nav-item">
            <template v-slot:prepend>
              <div class="nav-icon-container">
                <v-icon :icon="item.icon" class="nav-icon"></v-icon>
              </div>
            </template>

            <v-list-item-title class="nav-text">
              {{ item.text }}
            </v-list-item-title>
          </v-list-item>
        </div>
      </v-list>
    </v-navigation-drawer>
    <v-snackbar v-model="snack" :timeout="5000" :color="snackColor" location="top right">
      {{ snackText }}
    </v-snackbar>
    <v-dialog v-model="freeze" persistent max-width="290">
      <v-card>
        <v-card-title class="text-h5">
          {{ freezeTitle }}
        </v-card-title>
        <v-card-text>{{ freezeMsg }}</v-card-text>
      </v-card>
    </v-dialog>
  </nav>
</template>

<script>
import { storeToRefs } from "pinia";
import { call } from "@/utils/call";
import { OPENING_DIALOG_CACHE_KEY } from "@/utils/call-registry";
import hardwareUtils from "@/utils/hardwareUtils";
import { useOutboxStore } from "@/stores/outbox";
import { useConnectivityStore } from "@/stores/connectivity";
import ThemeToggle from "@/components/ThemeToggle.vue";
import busListeners from "@/utils/busListeners";

export default {
  components: { ThemeToggle },
  mixins: [hardwareUtils, busListeners],
  emits: ["changePage", "open-reconciliation"],
  setup() {
    // Surfaces the outbox depth on the navbar (pending + in-flight). Hidden
    // in the template when queuedCount is 0 so the navbar is unchanged in
    // the steady-state online path.
    const outbox = useOutboxStore();
    const { queuedCount } = storeToRefs(outbox);
    // Compact inline status pill — separate from the full-width OfflineBanner
    // so cashiers always have an at-a-glance indicator in the navbar even on
    // narrow viewports where the banner subtitle gets ellipsised.
    const connectivity = useConnectivityStore();
    const { connectionQuality } = storeToRefs(connectivity);
    return { queuedCount, connectionQuality };
  },
  data() {
    return {
      drawer: false,
      mini: true,
      item: 0,
      items: [{ text: 'POS', icon: 'mdi-network-pos' },
              { text: 'Dashboard', icon: 'mdi-view-dashboard-outline' }
      ],
      page: '',
      fav: true,
      menu: false,
      message: false,
      hints: true,
      menu_item: 0,
      snack: false,
      snackColor: '',
      snackText: '',
      company: 'POSpire',
      company_img: '/assets/erpnext/images/erpnext-logo.svg',
      pos_profile: '',
      freeze: false,
      freezeTitle: '',
      freezeMsg: '',
      last_invoice: '',
    };
  },
  methods: {
    changePage(key) {
      this.$emit('changePage', key);
      this.drawer = false;
    },
    go_about() {
      const win = window.open(
        'https://github.com/promantia-ltd/POSpire',
        '_blank'
      );
      win.focus();
    },
    apply_pos_profile(data) {
      this.pos_profile = data.pos_profile;
      const payments = { text: 'Payments', icon: 'mdi-cash-register' };
      if (
        this.pos_profile.posa_use_pos_awesome_payments &&
        !this.items.some((item) => item.text === 'Payments')
      ) {
        this.items.push(payments);
      }
    },
    close_shift_dialog() {
      // ClosingDialog is owned by Pos.vue, which is only mounted on /pos. From
      // any other route the event lands on nothing, so the menu item silently
      // did nothing. Carry the intent through the navigation instead and let
      // Pos consume it once its opening-shift check has settled.
      if (this.$route.path === '/pos') {
        this.eventBus.emit('open_closing_dialog');
        return;
      }
      this.$router.push({ path: '/pos', query: { close_shift: '1' } });
    },
    show_message(data) {
      this.snack = true;
      this.snackColor = data.color;
      this.snackText = data.title;
    },
    async logOut() {
      this.logged_out = true;
      // The cached POS configuration must not outlive the session that fetched
      // it; the next cashier may have a different profile set.
      try {
        // NOTE: getReadCache lives in "@/offline/runtime" (the registration
        // shim), not "@/offline/read-cache" (the adapter implementations) —
        // the latter never exports it. Corrected from the brief's snippet,
        // which would have silently no-op'd here.
        const { getReadCache } = await import("@/offline/runtime");
        await getReadCache()?.invalidate(OPENING_DIALOG_CACHE_KEY);
      } catch {
        /* non-fatal */
      }
      await call('logout');
      window.location.href = "/login";
    },
    async print_last_invoice() {
      if (!this.last_invoice) return;
      try {
        const res = await this.hardwareConfiguration(
          this.pos_profile.name
        );

        if (res === true) { 
          await this.custom_print(this.last_invoice);
        } else {
          const print_format =
            this.pos_profile.print_format_for_online ||
            this.pos_profile.print_format;
          const letter_head = this.pos_profile.letter_head || 0;
          const url =
            window.location.origin +
            '/printview?doctype=Sales%20Invoice&name=' +
            this.last_invoice +
            '&trigger_print=1' +
            '&format=' +
            print_format +
            '&no_letterhead=' +
            letter_head;
          const printWindow = window.open(url, 'Print');
          printWindow.addEventListener(
            'load',
            function () {
              printWindow.print();
            },
            true
          );
        }
      } catch (err) {
        console.error("Hardware config check failed", err);
      }
    },
  },
  created: function () {
    this.$nextTick(function () {
      this.onBus('show_message', (data) => {
        this.show_message(data);
      });
      this.onBus('set_company', (data) => {
        this.company = data.name;
        this.company_img = data.company_logo
          ? data.company_logo
          : this.company_img;
      });
      // Two sources, same payload shape: Pos.vue broadcasts
      // `register_pos_profile` on /pos, and App.vue publishes
      // `navbar_pos_profile` on every other route — a Navbar-only channel, so
      // that bootstrap doesn't fan out to POS children that aren't mounted.
      this.onBus('register_pos_profile', this.apply_pos_profile);
      this.onBus('navbar_pos_profile', this.apply_pos_profile);
      this.onBus('set_last_invoice', (data) => {
        this.last_invoice = data;
      });
      this.onBus('freeze', (data) => {
        this.freeze = true;
        this.freezeTitle = data.title;
        this.freezeMsg = data.msg;
      });
      this.onBus('unfreeze', () => {
        this.freeze = false;
        this.freezTitle = '';
        this.freezeMsg = '';
      });
    });
  },
};
</script>

<style scoped>
/* Header Styles */
.modern-header {
  background: var(--pospire-navbar-bg) !important;
  border-bottom: 1px solid var(--pospire-border) !important;
  backdrop-filter: blur(10px);
  padding: 0 1rem 0 0;
  height: 72px;
  max-height: 72px;
  ;
}

.modern-nav-icon {
  color: var(--pospire-text-muted) !important;
  border-radius: 8px;
  margin-inline-start: 0.75rem !important;
  transition: all 0.2s ease;
}

.modern-nav-icon:hover {
  background-color: var(--pospire-hover-bg) !important;
  color: var(--pospire-text-main) !important;
}

/* Brand Title */
.stylish-brand {
  transition: all 0.3s ease;
  padding: 8px 0;
  background: none;
  border: none;
  box-shadow: none;
  height: auto !important;
  line-height: normal !important;
  min-width: 0 !important;
  flex-shrink: 1 !important;
  overflow: hidden;
}

.stylish-brand:hover {
  transform: none;
}

/* Brand Container */
.brand-container-modern {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, transparent);
  border-radius: 10px;
  border: 1px solid rgba(0, 188, 212, 0.15);
  transition: all 0.3s ease;
  max-width: 100%;
  flex-shrink: 1;
  min-width: 0;
}

.brand-container-modern:hover {
  background: linear-gradient(135deg, rgba(0, 188, 212, 0.12) 0%, rgba(52, 73, 94, 0.08) 100%);
  border-color: rgba(0, 188, 212, 0.25);
}

.brand-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-icon svg {
  transition: transform 0.3s ease;
}

.brand-container-modern:hover .brand-icon svg {
  transform: scale(1.05);
}

.brand-text {
  display: flex;
  align-items: baseline;
}

/* White-label branding styles */
.client-brand-section {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-shrink: 1;
}

.client-brand-name {
  font-family: 'Inter', sans-serif;
  font-size: 1.35rem;
  font-weight: 600;
  color: var(--pospire-text-primary);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.client-logo {
  border: 1px solid var(--pospire-border);
  background: var(--pospire-surface);
}

.brand-divider {
  width: 1px;
  height: 28px;
  background: linear-gradient(180deg, transparent, var(--pospire-border), transparent);
  margin: 0 12px;
}

/* POSpire branding section */
.pospire-brand-section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.powered-by-text {
  font-size: 0.6rem;
  color: var(--pospire-text-faint);
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.pospire-logo-animated {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pospire-icon {
  transition: transform 0.3s ease;
}

.pospire-brand-section:hover .pospire-icon {
  transform: scale(1.1) rotate(-5deg);
}

.pospire-name {
  display: flex;
  align-items: baseline;
}

.pospire-pos {
  font-family: 'Inter', sans-serif;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--pospire-text-primary);
  letter-spacing: -0.3px;
}

.pospire-pire {
  font-family: 'Inter', sans-serif;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--pospire-text-muted);
  letter-spacing: -0.2px;
  transition: color 0.3s ease;
}

.pospire-brand-section:hover .pospire-pire {
  color: #00BCD4;
}

/* Pulse animation for POSpire checkmark circle */
.pulse-circle {
  animation: pospirePulse 2s ease-in-out infinite;
  transform-origin: 28px 12px;
}

@keyframes pospirePulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.15);
  }
}

/* Shimmer effect on hover */
.pospire-brand-section::after {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(0, 188, 212, 0.1), transparent);
  transition: left 0.5s ease;
}

.pospire-brand-section:hover::after {
  left: 100%;
}

.pospire-brand-section {
  position: relative;
  overflow: hidden;
  padding: 4px 8px;
  border-radius: 6px;
}

.brand-pos-modern {
  font-family: 'Inter', sans-serif;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--pospire-text-primary);
  letter-spacing: -0.5px;
  line-height: 1;
}

.brand-pire-modern {
  font-family: 'Inter', sans-serif;
  font-size: 1.4rem;
  font-weight: 500;
  color: #00BCD4;
  letter-spacing: -0.5px;
  line-height: 1;
}

/* Brand Text */
.brand-name-primary {
  font-family: 'Inter', sans-serif;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--pospire-text-primary);
  letter-spacing: -0.5px;
  line-height: 1;
  text-transform: uppercase;
  position: relative;
}

.brand-name-accent {
  font-family: 'Inter', sans-serif;
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--pospire-text-muted);
  letter-spacing: -0.3px;
  line-height: 1;
  text-transform: lowercase;
  position: relative;
  transition: color 0.3s ease;
}

.brand-container-modern:hover .brand-name-accent {
  color: #00BCD4;
}

/* Hover underline effect */
.brand-container-modern:hover .brand-name-accent::after {
  content: '';
  position: absolute;
  bottom: -3px;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, #00BCD4, rgba(0, 188, 212, 0.3));
  border-radius: 2px;
  animation: underlineSlide 0.3s ease-out;
}

@keyframes underlineSlide {
  from { width: 0; }
  to { width: 100%; }
}

/* Logo animation */
@keyframes logoPulse {
  0%, 100% {
    opacity: 0.5;
    transform: scale(1);
  }
  50% {
    opacity: 0.2;
    transform: scale(1.3);
  }
}

.brand-icon svg circle:last-of-type {
  animation: logoPulse 2s ease-in-out infinite;
  transform-origin: center;
}

/* Legacy brand styles */
.brand-container {
  display: flex;
  align-items: baseline;
  gap: 6px;
  position: relative;
  height: auto;
  padding: 4px 0;
}

.brand-pos {
  font-family: var(--brand-font-latin);
  font-size: 1.7rem;
  font-weight: 600;
  color: var(--pospire-text-primary);
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
}

.brand-mati {
  font-family: var(--brand-font-latin);
  font-size: 1.7rem;
  font-weight: 600;
  color: #00BCD4;
  letter-spacing: 0.5px;
  line-height: 1;
}

.user-info {
  margin-right: 8px;
  height: 100%;
  display: flex;
  align-items: center;
}

.sync-badge-wrapper {
  margin-right: 10px;
  height: 100%;
  display: flex;
  align-items: center;
}

.sync-badge {
  font-weight: 600;
  letter-spacing: 0.3px;
}

.connectivity-pill-wrapper {
  margin-right: 10px;
  height: 100%;
  display: flex;
  align-items: center;
}

.connectivity-pill {
  font-weight: 600;
  letter-spacing: 0.3px;
}

.theme-toggle-wrapper {
  margin-right: 10px;
  height: 100%;
  display: flex;
  align-items: center;
}

/*
 * Online pill is intentionally low-key: same chip shape as offline/degraded
 * for layout stability (no jumping when the network flaps), but muted so it
 * doesn't distract during the steady-state happy path.
 */
.connectivity-pill--online {
  opacity: 0.7;
}

.user-chip {
  height: 36px;
  font-weight: 500;
  border-radius: 18px;
}

.menu-button {
  color: var(--pospire-text-muted) !important;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.text-center {
  height: 100%;
  display: flex;
  align-items: center;
}

.menu-button:hover {
  background-color: var(--pospire-hover-bg) !important;
  color: var(--pospire-text-main) !important;
}

/* Sidebar Styles */
.modern-sidebar {
  background: var(--sidebar-bg) !important;
  border-right: 1px solid var(--pospire-border) !important;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1) !important;
}

.sidebar-header {
  padding: 24px 20px 20px 20px;
  background: var(--sidebar-header-bg);
}

.company-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.company-avatar {
  border: 2px solid var(--pospire-border);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.company-details {
  flex: 1;
}

.company-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--pospire-text-primary);
  line-height: 1.2;
}

.company-type {
  font-size: 0.85rem;
  color: var(--pospire-text-muted);
  font-weight: 500;
  margin-top: 2px;
}

.sidebar-divider {
  border-color: var(--pospire-border) !important;
  margin: 0 !important;
}

.navigation-list {
  padding: 16px 0 !important;
}

.menu-section {
  margin-bottom: 8px;
}

.nav-item {
  margin: 4px 12px;
  border-radius: 12px;
  transition: all 0.2s ease;
  min-height: 48px !important;
  padding: 8px 16px !important;
}

.nav-item:hover {
  background-color: var(--hover-bg) !important;
  transform: translateX(2px);
}

.nav-item.v-list-item--active {
   background: var(--active-gradient) !important;
  color: white !important;
  box-shadow: 0 4px 8px rgba(59, 130, 246, 0.3);
}

.nav-icon-container {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background-color: var(--pospire-surface-muted);
  transition: all 0.2s ease;
}

.nav-item:hover .nav-icon-container {
   background-color: var(--hover-bg-dark);
}

.nav-item.v-list-item--active .nav-icon-container {
  background-color: rgba(255, 255, 255, 0.2) !important;
}

.nav-icon {
  color: var(--pospire-text-muted) !important;
  font-size: 18px !important;
  transition: all 0.2s ease;
}

.nav-item:hover .nav-icon {
  color: var(--pospire-text-main) !important;
}

.nav-item.v-list-item--active .nav-icon {
  color: white !important;
}

.nav-text {
  font-weight: 500 !important;
  color: var(--pospire-text-main) !important;
  font-size: 0.95rem !important;
  margin-left: 12px;
  transition: all 0.2s ease;
}

.nav-item.v-list-item--active .nav-text {
  color: white !important;
  font-weight: 600 !important;
}

/* Remove old workaround styles - keep functionality but improve aesthetics */
.v-navigation-drawer .v-list-item-title {
  color: inherit !important;
}

.v-navigation-drawer .v-icon {
  color: inherit !important;
}

/* Responsive Brand Styles */
@media (max-width: 1200px) {
  .client-brand-name {
    max-width: 220px;
    font-size: 1.2rem;
  }

  .brand-container-modern {
    gap: 8px;
    padding: 6px 12px;
  }

  .pospire-name {
    font-size: 0.85rem;
  }
}

@media (max-width: 960px) {
  .client-brand-name {
    max-width: 180px;
    font-size: 1.1rem;
  }

  .brand-divider {
    margin: 0 8px;
    height: 24px;
  }

  .pospire-icon {
    width: 20px;
    height: 20px;
  }

  .powered-by-text {
    font-size: 0.55rem;
  }

  .pospire-pos,
  .pospire-pire {
    font-size: 0.8rem;
  }
}

@media (max-width: 768px) {
  .pospire-brand-section {
    display: none;
  }

  .brand-divider {
    display: none;
  }

  .client-brand-name {
    max-width: 180px;
    font-size: 1.2rem;
  }

  .brand-container-modern {
    padding: 6px 12px;
  }
}

@media (max-width: 600px) {
  .client-brand-name {
    max-width: 120px;
    font-size: 1rem;
  }

  .client-logo {
    width: 28px !important;
    height: 28px !important;
  }

  .user-info {
    display: none;
  }
}
</style>
