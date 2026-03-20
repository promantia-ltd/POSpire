import { call } from "frappe-ui";
import { toast } from "vue3-toastify";
import { __ } from "@/utils/translate";

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

		async custom_print(invoice_name) {
			try {
				const url = await this.hardwareURL("Printer");
				if (!url) return;

				// Generate XML using default template for Sales Invoice
				const xmlPayload = await frappeCall(
					"pospire.pospire.api.hardware_manager.generate_print_xml",
					{
						doc_type: "Sales Invoice",
						sales_invoice_name: invoice_name,
						// template_path and template_name are optional
						// If not provided, will use default template for Sales Invoice
					}
				);

				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/xml;charset=utf-8" },
					body: xmlPayload,
					mode: "cors",
				});

				if (res.ok) {
					toast.success(__("Printing..."));
				} else {
					toast.error(__("Failed to print"));
				}
			} catch (err) {
				toast.error(__("Error: Printer not started or not configured"));
				console.error("Error: " + (err.message || err));
			}
		},
	},
};
