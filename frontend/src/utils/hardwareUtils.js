import { call, unwrapStale } from "@/utils/call";
import { toast } from "vue3-toastify";
import { __ } from "@/utils/translate";
import { PRINT_CONFIG_CACHE_KEY_PREFIX } from "@/utils/call-registry";
import { buildPrintContext } from "@/offline/print/context";
import { renderReceiptXml } from "@/offline/print/xml";
import { xmlToReceiptHtml } from "@/offline/print/html";
import connectivity from "@/offline/connectivity";

const frappeCall = (method, args = {}) => call(method, args);

export default {
	methods: {
		hardwareConfiguration(pos_name) {
			return frappeCall(
				"pospire.pospire.api.hardware_manager.get_hardware_manager_setting",
				{ pos_profile_name: pos_name }
			);
		},

		async hardwareURL(api_name) {
			const url = await frappeCall("pospire.pospire.api.hardware_manager.hardware_url", {
				api_name,
			});
			if (!url) {
				toast.error(__("Hardware URL not configured for {0}", [api_name]));
				throw new Error("URL not configured");
			}
			return url;
		},

		/**
		 * Read (and, online, prime the durable cache for) the offline print
		 * config — printer URL, default XML template (+ its modified
		 * timestamp), company address, and the site's date/time/number/
		 * currency formatting. Read-only, safe to call both online (live)
		 * and offline (resolves from whatever was cached the last time this
		 * ran online — see get_offline_print_config). Invoice.vue primes
		 * this once while online, at shift-open; printReceipt() calls it
		 * again at print time, which transparently resolves from cache when
		 * offline instead of hitting the network.
		 */
		async getPrintConfig(pos_profile_name) {
			if (!pos_profile_name) return null;
			try {
				const config = unwrapStale(
					await call({
						method: "pospire.pospire.api.hardware_manager.get_offline_print_config",
						args: { pos_profile: pos_profile_name },
						intent: "read",
						cacheKey: PRINT_CONFIG_CACHE_KEY_PREFIX + pos_profile_name,
					}),
				);
				return config || null;
			} catch (err) {
				console.warn("[hardwareUtils] getPrintConfig unavailable", err);
				return null;
			}
		},

		/** The one place that actually talks to the printer agent, both for
		 * the live (online) XML and the offline-rendered one — extracted so
		 * there's a single fetch call to reason about, not one per caller. */
		async postToPrinter(url, xml) {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/xml;charset=utf-8" },
				body: xml,
				mode: "cors",
			});
			if (!res.ok) {
				throw new Error(`Printer responded with HTTP ${res.status}`);
			}
			return res;
		},

		/**
		 * Legacy online-only thermal print by invoice name. Superseded by
		 * printReceipt(), which covers this same case (Hardware Manager on,
		 * online) plus the other three. Kept only as a thin wrapper in case
		 * anything still calls it directly.
		 */
		async custom_print(invoice_name) {
			return this.printReceipt({ name: invoice_name });
		},

		/**
		 * Single print entry point for every combination of Hardware
		 * Manager on/off and online/offline — see the flow table in
		 * docs/OFFLINE_RECEIPT_PRINTING_IMPLEMENTATION_PLAN.md §3. One
		 * template (the default POS XML Print Designer template) drives
		 * every case; only WHO renders it (server vs. browser) and WHERE
		 * the result goes (printer vs. a browser window) changes.
		 *
		 * Call shapes:
		 *   printReceipt({ name })              — print a real, already-
		 *     submitted/synced invoice by its server name. Always the
		 *     online path (see Navbar.vue's reprint logic — this shape is
		 *     only used once a sale's server_doc_name is known).
		 *   printReceipt({ invoice, offlineId }) — print from an in-memory
		 *     invoice object: a sale just submitted (online or offline),
		 *     or one reconstructed from a stored offline sale for reprint.
		 *
		 * No silent fallback on failure, in any of the four cells —
		 * matches how the online path has always behaved (a Hardware-
		 * Manager profile with an unreachable printer shows an error and
		 * stops, it does not quietly swap to a browser receipt instead).
		 */
		async printReceipt({ name, invoice, offlineId } = {}) {
			const posProfile = this.pos_profile || {};
			const hwOn = !!posProfile.posa_hardware_manager;
			const online = connectivity.isOnline();

			try {
				if (hwOn && online) {
					return await this._printThermalOnline(name || invoice?.name);
				}
				if (hwOn && !online) {
					return await this._printThermalOffline(invoice, offlineId, posProfile);
				}
				if (!hwOn && online) {
					if (posProfile.posa_browser_receipt_from_xml) {
						return await this._printBrowserFromTemplateOnline(name || invoice?.name);
					}
					// Unchanged legacy path: the profile's own print format via /printview.
					this.load_print_page(name || invoice?.name);
					return true;
				}
				// !hwOn && !online
				return await this._printBrowserOffline(invoice, offlineId, posProfile);
			} catch (err) {
				console.error("[hardwareUtils] printReceipt failed:", err);
				toast.error(err?.userMessage || __("Could not print the receipt. Please try again."));
				return false;
			}
		},

		async _printThermalOnline(invoiceName) {
			const url = await this.hardwareURL("Printer");
			const xmlPayload = await frappeCall(
				"pospire.pospire.api.hardware_manager.generate_print_xml",
				{ doc_type: "Sales Invoice", sales_invoice_name: invoiceName },
			);
			await this.postToPrinter(url, xmlPayload);
			toast.success(__("Printing..."));
			return true;
		},

		async _printThermalOffline(invoice, offlineId, posProfile) {
			const config = await this.getPrintConfig(posProfile.name);
			if (!config || !config.printer_url || !config.template) {
				const err = new Error("print config not cached");
				err.userMessage = __(
					"Receipt settings are not saved on this till. Connect once to download them.",
				);
				throw err;
			}
			const doc = buildPrintContext(invoice, {
				posProfile,
				printConfig: config,
				offlineId,
				pendingSync: true,
			});
			let xml;
			try {
				xml = renderReceiptXml(config.template, doc, config);
			} catch (renderErr) {
				const err = new Error("template render failed offline");
				err.userMessage = __(
					"The receipt template cannot print offline: {0}. Ask your admin to check the POS XML Print Designer warnings.",
					[renderErr?.message || renderErr],
				);
				throw err;
			}
			await this.postToPrinter(config.printer_url, xml);
			toast.success(__("Printing..."));
			return true;
		},

		async _printBrowserFromTemplateOnline(invoiceName) {
			// Window must open synchronously, before any await, or some
			// browsers no longer treat it as triggered by the click that
			// led here and silently block it.
			const win = window.open("", "ReceiptPrint");
			if (!win) {
				toast.warning(__("Allow pop-ups for POSpire to print receipts."));
				return false;
			}
			const xmlPayload = await frappeCall(
				"pospire.pospire.api.hardware_manager.generate_print_xml",
				{ doc_type: "Sales Invoice", sales_invoice_name: invoiceName },
			);
			this._writeReceiptWindow(win, xmlToReceiptHtml(xmlPayload));
			return true;
		},

		async _printBrowserOffline(invoice, offlineId, posProfile) {
			const win = window.open("", "ReceiptPrint");
			if (!win) {
				toast.warning(__("Allow pop-ups for POSpire to print receipts."));
				return false;
			}
			const config = await this.getPrintConfig(posProfile.name);
			if (!config || !config.template) {
				win.close();
				const err = new Error("print config not cached");
				err.userMessage = __(
					"Receipt settings are not saved on this till. Connect once to download them.",
				);
				throw err;
			}
			const doc = buildPrintContext(invoice, {
				posProfile,
				printConfig: config,
				offlineId,
				pendingSync: true,
			});
			let xml;
			try {
				xml = renderReceiptXml(config.template, doc, config);
			} catch (renderErr) {
				win.close();
				const err = new Error("template render failed offline");
				err.userMessage = __(
					"The receipt template cannot print offline: {0}. Ask your admin to check the POS XML Print Designer warnings.",
					[renderErr?.message || renderErr],
				);
				throw err;
			}
			this._writeReceiptWindow(win, xmlToReceiptHtml(xml));
			return true;
		},

		_writeReceiptWindow(win, bodyHtml) {
			const html =
				"<!doctype html><html><head><meta charset=\"utf-8\">" +
				"<title>" + __("Receipt") + "</title></head>" +
				"<body style=\"margin:0;padding:12px;\">" +
				bodyHtml +
				"</body></html>";
			win.document.open();
			win.document.write(html);
			win.document.close();
			win.addEventListener(
				"load",
				() => {
					try {
						win.focus();
						win.print();
					} catch (e) {
						console.error("Receipt print trigger failed:", e);
					}
				},
				true,
			);
		},
	},
};
