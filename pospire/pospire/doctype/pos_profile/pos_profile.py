import frappe

def validate_pos_profile(doc, method):
    if doc.custom_assortment and doc.item_groups:
        frappe.throw("Please select either Assortment or Item Group, not both")
    if doc.custom_assortment:
        assortment_company = frappe.db.get_value(
            "Assortment",
            doc.custom_assortment,
            "company"
        )

        if assortment_company and assortment_company != doc.company:
            frappe.throw(
                f"Assortment belongs to '{assortment_company}', "
                f"but POS Profile belongs to '{doc.company}'"
            )
