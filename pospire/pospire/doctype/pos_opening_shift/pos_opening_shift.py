# Copyright (c) 2020, Youssef Restom and contributors
# For license information, please see license.txt


import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

from pospire.pospire.api.status_updater import StatusUpdater


class POSOpeningShift(StatusUpdater):
	def validate(self):
		self.validate_pos_profile_and_cashier()
		self.set_status()
		self.update_cash_total()

	def validate_pos_profile_and_cashier(self):
		if self.company != frappe.db.get_value("POS Profile", self.pos_profile, "company"):
			frappe.throw(_(f"POS Profile {self.pos_profile} does not belongs to company {self.company}"))

		if not cint(frappe.db.get_value("User", self.user, "enabled")):
			frappe.throw(_(f"User {self.user} has been disabled. Please select valid user/cashier"))

	def on_submit(self):
		self.set_status(update=True)

	def update_cash_total(self):
		# If denominations not used, do not override manual amount
		if not self.denomination_details:
			return

		total = 0
		for d in self.denomination_details:
			d.amount = (d.denomination_value or 0) * (d.quantity or 0)
			total += d.amount
		for b in self.balance_details:
			if b.mode_of_payment == "Cash":
				b.amount = total
