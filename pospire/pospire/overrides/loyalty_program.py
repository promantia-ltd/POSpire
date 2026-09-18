import frappe
from erpnext.accounts.doctype.loyalty_program.loyalty_program import LoyaltyProgram
from frappe import _
from frappe.query_builder import Case
from frappe.query_builder.functions import Sum
from frappe.utils import flt, today


class CustomLoyaltyProgram(LoyaltyProgram):
	def validate_lowest_tier(self):
		# Core erpnext compares rule.min_spent without converting it to a
		# number first. The Minimum Total Spent grid field has no "default",
		# so an untouched row sends nothing at all (None), which always fails
		# `!= 0`, and mixing a filled row with an untouched one crashes
		# sorted() with a TypeError instead of raising a normal validation
		# message. Converting each value up front fixes both, while keeping
		# the rule itself: the lowest tier must still be 0, since
		# get_loyalty_program_details_with_points always applies the lowest
		# tier's rate unconditionally regardless of its min_spent.
		for rule in self.collection_rules:
			rule.min_spent = flt(rule.min_spent)

		tiers = sorted(self.collection_rules, key=lambda x: x.min_spent)
		if tiers and tiers[0].min_spent != 0:
			frappe.throw(
				_(
					"The lowest tier must have a minimum spent amount of 0. Customers need to be part of a tier as soon as they are enrolled in the program."
				)
			)


def get_loyalty_details(
	customer, loyalty_program, expiry_date=None, company=None, include_expired_entry=False
):
	# Core erpnext sums purchase_amount across every Loyalty Point Entry row,
	# including redemption rows. apply_loyalty_points() writes the full
	# invoice grand_total into purchase_amount on every redemption row it
	# creates, so one redemption that draws from N earlier rows counts that
	# same bill N times toward the customer's lifetime spend. Since tier
	# selection (get_loyalty_program_details_with_points) is driven by this
	# total, redemptions can push a customer into a tier they haven't earned,
	# and ERPNext never demotes a tier once granted. Excluding rows that have
	# redeem_against set fixes total_spent going forward and self-corrects
	# any already-wrong total the next time it's read, without a data patch.
	# loyalty_points itself must still include the negative redemption rows,
	# so only the total_spent side of the query is restricted.
	if not expiry_date:
		expiry_date = today()

	LoyaltyPointEntry = frappe.qb.DocType("Loyalty Point Entry")

	query = (
		frappe.qb.from_(LoyaltyPointEntry)
		.select(
			Sum(LoyaltyPointEntry.loyalty_points).as_("loyalty_points"),
			Sum(
				Case()
				.when(LoyaltyPointEntry.redeem_against.isnull(), LoyaltyPointEntry.purchase_amount)
				.else_(0)
			).as_("total_spent"),
		)
		.where(
			(LoyaltyPointEntry.customer == customer)
			& (LoyaltyPointEntry.loyalty_program == loyalty_program)
			& (LoyaltyPointEntry.posting_date <= expiry_date)
		)
		.groupby(LoyaltyPointEntry.customer)
	)

	if company:
		query = query.where(LoyaltyPointEntry.company == company)

	if not include_expired_entry:
		query = query.where(LoyaltyPointEntry.expiry_date >= expiry_date)

	loyalty_point_details = query.run(as_dict=True)

	if loyalty_point_details:
		return loyalty_point_details[0]
	else:
		return {"loyalty_points": 0, "total_spent": 0}
