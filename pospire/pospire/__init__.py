def _patch_loyalty_details():
	# get_loyalty_details() is a standalone function, not a doctype controller
	# method, so it can't go through override_doctype_class like the other
	# pospire overrides. See pospire.pospire.overrides.loyalty_program for why
	# this needs patching. Import deferred to function scope so this module
	# stays cheap to import regardless of app load order.
	import erpnext.accounts.doctype.loyalty_program.loyalty_program as loyalty_program_module

	from pospire.pospire.overrides.loyalty_program import get_loyalty_details

	loyalty_program_module.get_loyalty_details = get_loyalty_details


_patch_loyalty_details()
