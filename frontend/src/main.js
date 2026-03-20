import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import "vue3-toastify/dist/index.css";
import "@/assets/css/pos-enhancements.css";

import { createApp } from "vue";
import { createVuetify } from "vuetify";
import { createPinia } from "pinia";
import { frappeRequest } from "frappe-ui";
import Vue3Toastify from "vue3-toastify";
import router from "./router";
import eventBus from "./utils/bus";
import { __ } from "./utils/translate";
import { flt, get_currency_symbol, get_number_format, format_number } from "./utils/numberFormat";
import App from "./App.vue";

// Expose as window globals — matches Frappe's browser environment where these
// are always available as bare identifiers in any JS/template scope.
window.__ = __;
window.flt = flt;
window.get_currency_symbol = get_currency_symbol;
window.get_number_format = get_number_format;
window.format_number = format_number;

const vuetify = createVuetify({
	theme: {
		themes: {
			light: {
				colors: {
					background: "#FFFFFF",
					primary: "#0097A7",
					secondary: "#00BCD4",
					accent: "#9575CD",
					success: "#66BB6A",
					info: "#2196F3",
					warning: "#FF9800",
					error: "#E86674",
					orange: "#E65100",
					golden: "#A68C59",
					badge: "#F5528C",
					customPrimary: "#085294",
				},
			},
		},
	},
});

const pinia = createPinia();
const app = createApp(App);

app.use(vuetify);
app.use(pinia);
app.use(router);
app.use(eventBus);
app.use(Vue3Toastify, {
	autoClose: 3000,
	position: "top-right",
});

if (import.meta.env.DEV) {
	frappeRequest({
		url: "/api/method/pospire.www.pospire.get_context_for_dev",
	}).then((values) => {
		for (let key in values) {
			window[key] = values[key];
		}
		app.mount("#app");
	});
} else {
	app.mount("#app");
}
