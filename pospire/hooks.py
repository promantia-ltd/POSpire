from . import __version__ as app_version

app_name = "pospire"
app_title = "POSpire"
app_publisher = "Rajit"
app_description = "POSpire POS Application"
app_icon = "octicon octicon-file-directory"
app_color = "grey"
app_email = "rajit@example.com"
app_license = "GPLv3"

POSPIRE_COLOR = "#2563EB"

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
app_include_css = "/assets/pospire/css/pos-enhancements.css"
app_include_js = [
	"pospire.bundle.js",
]

# include js, css files in header of web template
# web_include_css = "/assets/pospire/css/pospire.css"
# web_include_js = "/assets/pospire/js/pospire.js"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
doctype_js = {
	"POS Profile": "pospire/api/pos_profile.js",
	"Sales Invoice": "pospire/api/invoice.js",
	"Company": "pospire/api/company.js",
}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Website user home page (by function)
# get_website_user_home_page = "pospire.utils.get_home_page"

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Installation
# ------------

# before_install = "pospire.install.before_install"
# after_install = "pospire.install.after_install"
# before_uninstall = "pospire.uninstall.before_uninstall"
after_uninstall = "pospire.uninstall.after_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "pospire.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

doc_events = {
	"Sales Invoice": {
		"validate": "pospire.pospire.api.invoice.validate",
		"before_submit": "pospire.pospire.api.invoice.before_submit",
		"before_cancel": "pospire.pospire.api.invoice.before_cancel",
	},
	"Customer": {
		"validate": "pospire.pospire.api.customer.validate",
		"after_insert": "pospire.pospire.api.customer.after_insert",
	},
}

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"pospire.tasks.all"
# 	],
# 	"daily": [
# 		"pospire.tasks.daily"
# 	],
# 	"hourly": [
# 		"pospire.tasks.hourly"
# 	],
# 	"weekly": [
# 		"pospire.tasks.weekly"
# 	]
# 	"monthly": [
# 		"pospire.tasks.monthly"
# 	]
# }

# Testing
# -------

# before_tests = "pospire.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "pospire.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "pospire.task.get_dashboard_data"
# }

# override_doctype_class = {
# "doctype": "method",
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

fixtures = [
	{
		"doctype": "Custom Field",
		"filters": [
			[
				"name",
				"in",
				(
					"Sales Invoice-posa_pos_opening_shift",
					"Item Barcode-posa_uom",
					"POS Profile-posa_pos_awesome_settings",
					"POS Profile-posa_allow_delete",
					"POS Profile-posa_allow_user_to_edit_rate",
					"POS Profile-posa_allow_user_to_edit_additional_discount",
					"POS Profile-posa_allow_user_to_edit_item_discount",
					"POS Profile-posa_display_items_in_stock",
					"POS Profile-posa_allow_submissions_in_background_job",
					"POS Profile-posa_allow_partial_payment",
					"POS Profile-posa_allow_credit_sale",
					"POS Profile-posa_pos_awesome_advance_settings",
					"Batch-posa_batch_price",
					"POS Profile-posa_max_discount_allowed",
					"POS Profile-posa_allow_return",
					"POS Profile-posa_col_1",
					"POS Profile-posa_scale_barcode_start",
					"Sales Invoice-posa_is_printed",
					"POS Profile-posa_local_storage",
					"POS Profile-posa_cash_mode_of_payment",
					"POS Profile-use_customer_credit",
					"POS Profile-use_cashback",
					"POS Profile-posa_hide_closing_shift",
					"Customer-posa_discount",
					"POS Profile-posa_apply_customer_discount",
					"Sales Invoice-posa_offers",
					"Sales Invoice-posa_coupons",
					"Sales Invoice Item-posa_offers",
					"Sales Invoice Item-posa_row_id",
					"Sales Invoice Item-posa_offer_applied",
					"Sales Invoice Item-posa_is_offer",
					"Sales Invoice Item-posa_is_replace",
					"POS Profile-posa_auto_set_batch",
					"POS Profile-posa_search_serial_no",
					"Sales Invoice-posa_additional_notes_section",
					"Sales Invoice-posa_notes",
					"Sales Invoice-posa_column_break_111",
					"Sales Invoice-posa_delivery_date",
					"Sales Invoice Item-posa_notes",
					"Sales Invoice Item-posa_delivery_date",
					"Sales Order-posa_additional_notes_section",
					"Sales Order-posa_notes",
					"Sales Order Item-posa_notes",
					"POS Profile-posa_allow_sales_order",
					"POS Profile-custom_allow_select_sales_order",
					"POS Profile-posa_column_break_112",
					"POS Profile-posa_show_template_items",
					"POS Profile-posa_hide_variants_items",
					"Customer-posa_referral_code",
					"POS Profile-posa_fetch_coupon",
					"Company-posa_referral_section",
					"Company-posa_auto_referral",
					"Company-posa_column_break_22",
					"Company-posa_customer_offer",
					"Company-posa_primary_offer",
					"Company-posa_referral_campaign",
					"Customer-posa_referral_company",
					"Customer-posa_referral_section",
					"Customer-posa_birthday",
					"Sales Order-posa_offers",
					"Sales Order-posa_coupons",
					"Sales Order Item-posa_row_id",
					"POS Profile-posa_tax_inclusive",
					"POS Profile-posa_use_percentage_discount",
					"POS Profile-posa_allow_customer_purchase_order",
					"POS Profile-posa_allow_print_last_invoice",
					"POS Profile-posa_display_additional_notes",
					"POS Profile-posa_allow_write_off_change",
					"POS Profile-posa_new_line",
					"POS Profile-posa_input_qty",
					"POS Profile-posa_display_item_code",
					"POS Profile-posa_allow_zero_rated_items",
					"POS Profile-posa_allow_print_draft_invoices",
					"Address-posa_delivery_charges",
					"Sales Invoice-posa_delivery_charges",
					"Sales Invoice-posa_delivery_charges_rate",
					"POS Profile-posa_auto_set_delivery_charges",
					"POS Profile-posa_use_delivery_charges",
					"POS Profile-hide_expected_amount",
					"POS Profile-posa_allow_change_posting_date",
					"POS Profile-posa_default_card_view",
					"POS Profile-posa_default_sales_order",
					"POS Profile-column_break_dqsba",
					"POS Profile-posa_use_server_cache",
					"POS Profile-posa_server_cache_duration",
					"POS Profile-posa_allow_duplicate_customer_names",
					"POS Profile-column_break_anyol",
					"POS Profile-pose_use_limit_search",
					"POS Profile-posa_search_limit",
					"POS Profile-posa_search_batch_no",
					"POS Profile-pos_awesome_payments",
					"POS Profile-posa_use_pos_awesome_payments",
					"POS Profile-posa_allow_make_new_payments",
					"POS Profile-posa_allow_reconcile_payments",
					"POS Profile-column_break_uolvm",
					"POS Profile-posa_allow_mpesa_reconcile_payments",
					"POS Profile-custom_allow_user_to_edit_item_total",
					"Sales Invoice Item-custom_sales_person",
					"Sales Invoice-custom_delivery_charge_rate",
					"POS Profile-posa_hardware_manager_setting",
					"POS Profile-posa_hardware_manager",
				),
			]
		],
	},
	{
		"doctype": "Property Setter",
		"filters": [
			[
				"name",
				"in",
				("Sales Invoice-posa_pos_opening_shift-no_copy", "POS Profile-posa_tax_inclusive-hidden"),
			]
		],
	},
]
add_to_apps_screen = [
	{
		"name": "POSpire",
		"title": "POSpire",
		"route": "/app/pospire",
		"color": POSPIRE_COLOR,
		"logo": "/assets/pospire/images/app-128x128-rounded.png",
	}
]
