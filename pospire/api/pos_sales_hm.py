import frappe
from frappe import _


@frappe.whitelist()
def generate_print_xml(doc_type, sales_invoice_name, template_path=None):
	doc = frappe.get_doc(doc_type, sales_invoice_name)
	print(doc)
	xml = frappe.render_template(template_path, {"doc": doc})
	return xml
