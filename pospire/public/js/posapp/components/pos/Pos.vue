<template>
  <div fluid class="mt-2 pos-page">
    <ClosingDialog></ClosingDialog>
    <Drafts></Drafts>
    <SalesOrders></SalesOrders>
    <Returns></Returns>
    <NewAddress></NewAddress>
    <MpesaPayments></MpesaPayments>
    <Variants></Variants>
    <OpeningDialog v-if="dialog" :dialog="dialog"></OpeningDialog>
    
    <!-- Modal Components -->
    <CouponsModal v-model="showCouponsModal"></CouponsModal>
    <OffersModal v-model="showOffersModal"></OffersModal>
    
    <v-row v-show="!dialog" class="itemselector-section">
      <v-col v-show="!payment" xl="5" lg="5" md="5" sm="5" cols="12" class="pos pr-0 test-pos">
        <ItemsSelector></ItemsSelector>
      </v-col>
      <v-col v-show="payment" xl="5" lg="5" md="5" sm="5" cols="12" class="pos pr-0 test-pos">
        <Payments></Payments>
      </v-col>

      <v-col xl="7" lg="7" md="7" sm="7" cols="12" class="pos invoice-section">
        <Invoice></Invoice>
      </v-col>
    </v-row>
  </div>
</template>

<script>

import ItemsSelector from './ItemsSelector.vue';
import Invoice from './Invoice.vue';
import OpeningDialog from './OpeningDialog.vue';
import Payments from './Payments.vue';
import CouponsModal from './CouponsModal.vue';
import OffersModal from './OffersModal.vue';
import Drafts from './Drafts.vue';
import SalesOrders from "./SalesOrders.vue";
import ClosingDialog from './ClosingDialog.vue';
import NewAddress from './NewAddress.vue';
import Variants from './Variants.vue';
import Returns from './Returns.vue';
import MpesaPayments from './Mpesa-Payments.vue';
import { toast } from 'vue3-toastify';

export default {
  data: function () {
    return {
      dialog: false,
      pos_profile: '',
      pos_opening_shift: '',
      payment: false,
      showCouponsModal: false,
      showOffersModal: false,
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
    check_opening_entry() {
      return frappe
        .call('pospire.pospire.api.posapp.check_opening_shift', {
          user: frappe.session.user,
        })
        .then((r) => {
          if (r.message) {
            this.pos_profile = r.message.pos_profile;
            this.pos_opening_shift = r.message.pos_opening_shift;
            this.get_offers(this.pos_profile.name);
            this.eventBus.emit('register_pos_profile', r.message);
            this.eventBus.emit('set_company', r.message.company);
            console.info('LoadPosProfile');
          } else {
            this.create_opening_voucher();
          }
        });
    },
    create_opening_voucher() {
      this.dialog = true;
    },
    get_closing_data() {
      return frappe
        .call(
          'pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening',
          {
            opening_shift: this.pos_opening_shift,
          }
        )
        .then((r) => {
          if (r.message) {
            this.eventBus.emit('open_ClosingDialog', r.message);
          } else {
            // console.log(r);
          }
        });
    },
    submit_closing_pos(data) {
      frappe
        .call(
          'pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift',
          {
            closing_shift: data,
          }
        )
        .then((r) => {
          if (r.message) {

            toast.success(__('POS Shift Closed'));
            this.check_opening_entry();
          } else {
            console.log(r);
          }
        });
    },
    get_offers(pos_profile) {
      return frappe
        .call('pospire.pospire.api.posapp.get_offers', {
          profile: pos_profile,
        })
        .then((r) => {
          if (r.message) {
            console.info('LoadOffers');
            this.eventBus.emit('set_offers', r.message);
          }
        });
    },
    get_pos_setting() {
      frappe.db.get_doc('POS Settings', undefined).then((doc) => {
        this.eventBus.emit('set_pos_settings', doc);
      });
    },
  },

  mounted: function () {
    this.$nextTick(function () {
      this.check_opening_entry();
      this.get_pos_setting();
      this.eventBus.on('close_opening_dialog', () => {
        this.dialog = false;
      });
      this.eventBus.on('register_pos_data', (data) => {
        this.pos_profile = data.pos_profile;
        this.get_offers(this.pos_profile.name);
        this.pos_opening_shift = data.pos_opening_shift;
        this.eventBus.emit('register_pos_profile', data);
        console.info('LoadPosProfile');
      });
      this.eventBus.on('show_payment', (data) => {
        this.payment = data === 'true';
      });
      this.eventBus.on('show_offers', (data) => {
        this.showOffersModal = data === 'true';
      });
      this.eventBus.on('show_coupons', (data) => {
        this.showCouponsModal = data === 'true';
      });
      this.eventBus.on('open_closing_dialog', () => {
        this.get_closing_data();
      });
      this.eventBus.on('submit_closing_pos', (data) => {
        this.submit_closing_pos(data);
      });
    });
  },
  beforeUnmount() {
    this.eventBus.off('close_opening_dialog');
    this.eventBus.off('register_pos_data');
    this.eventBus.off('LoadPosProfile');
    this.eventBus.off('show_offers');
    this.eventBus.off('show_coupons');
    this.eventBus.off('show_payment');
    this.eventBus.off('open_closing_dialog');
    this.eventBus.off('submit_closing_pos');
  },
};
</script>

<style scoped>
/*
 * Height chain: viewport -> pos-page -> itemselector-section -> columns -> panels
 * Only pos-page calculates from viewport. Children use 100% to fill parent.
 */
.pos-page {
  /* Use viewport height minus navbar offset (48px) */
  height: calc(100dvh - var(--v-layout-top, 48px));
  max-height: calc(100dvh - var(--v-layout-top, 48px));
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
