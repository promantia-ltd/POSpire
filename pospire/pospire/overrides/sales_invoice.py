import frappe
from erpnext.accounts.doctype.loyalty_point_entry.loyalty_point_entry import get_redemption_details
from frappe.utils import flt


class CustomSalesInvoice:
	# Mixed into Sales Invoice via extend_doctype_class (not override_doctype_class,
	# which replaces the whole controller class and can silently stop applying if
	# another app also overrides it, or if erpnext's own controller changes).
	#
	# Core erpnext subtracts get_redemption_details()'s result, which is already
	# negative (sum of loyalty_points < 0), so it adds already-used points back
	# instead of deducting them. That lets a later redemption re-charge rows
	# that are already fully used (see erpnext core sales_invoice.py,
	# apply_loyalty_points). Fixed here to add the (negative) redeemed amount,
	# and skip rows that have nothing left.
	def apply_loyalty_points(self):
		from erpnext.accounts.doctype.loyalty_point_entry.loyalty_point_entry import (
			get_loyalty_point_entries,
		)

		loyalty_point_entries = get_loyalty_point_entries(
			self.customer, self.loyalty_program, self.company, self.posting_date
		)
		redemption_details = get_redemption_details(self.customer, self.loyalty_program, self.company)

		points_to_redeem = self.loyalty_points
		for lp_entry in loyalty_point_entries:
			if lp_entry.invoice_type != self.doctype or lp_entry.invoice == self.name:
				# redeemption should be done against same doctype
				# also it shouldn't be against itself
				continue
			available_points = lp_entry.loyalty_points + flt(redemption_details.get(lp_entry.name))
			if available_points <= 0:
				continue
			if available_points > points_to_redeem:
				redeemed_points = points_to_redeem
			else:
				redeemed_points = available_points
			doc = frappe.get_doc(
				{
					"doctype": "Loyalty Point Entry",
					"company": self.company,
					"loyalty_program": self.loyalty_program,
					"loyalty_program_tier": lp_entry.loyalty_program_tier,
					"customer": self.customer,
					"invoice_type": self.doctype,
					"invoice": self.name,
					"redeem_against": lp_entry.name,
					"loyalty_points": -1 * redeemed_points,
					"purchase_amount": self.grand_total,
					"expiry_date": lp_entry.expiry_date,
					"posting_date": self.posting_date,
				}
			)
			doc.flags.ignore_permissions = 1
			doc.save()
			points_to_redeem -= redeemed_points
			if points_to_redeem < 1:  # since points_to_redeem is integer
				break
