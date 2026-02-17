import frappe
from frappe import _

ALLOWED_DOCTYPES = {"Sales Invoice", "POS Invoice", "Sales Order", "Delivery Note"}


@frappe.whitelist()
def generate_print_xml(doc_type: str, sales_invoice_name: str, template_path: str | None = None) -> str:
	if doc_type not in ALLOWED_DOCTYPES:
		frappe.throw(_("Invalid DocType"))

	doc = frappe.get_doc(doc_type, sales_invoice_name)

	if not template_path:
		frappe.throw(_("Template path is required"))

	xml = frappe.render_template(template_path, {"doc": doc})  # nosemgrep: frappe-ssti
	return xml
