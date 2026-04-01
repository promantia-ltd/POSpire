import frappe
from frappe import _

no_cache = 1


def get_context(context: dict) -> dict:
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/pospire"
		raise frappe.Redirect

	roles = set(frappe.get_roles())
	allowed = {"Sales User", "Sales Manager", "System Manager", "Accounts Manager", "Accounts User"}
	if not allowed.intersection(roles):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- required after session ops per CRM pattern
	context.boot = get_boot()
	return context


def get_boot() -> dict:
	return frappe._dict(
		{
			"csrf_token": frappe.sessions.get_csrf_token(),
			"site_name": frappe.local.site,
			"user": frappe.session.user,
			"user_image": frappe.db.get_value("User", frappe.session.user, "user_image"),
			"default_route": "/pospire/pos",
			"sys_defaults": {
				"float_precision": frappe.db.get_single_value("System Settings", "float_precision") or 2,
				"currency_precision": frappe.db.get_single_value("System Settings", "currency_precision")
				or 2,
			},
			"user_defaults": frappe.defaults.get_defaults_for(frappe.session.user),
		}
	)


@frappe.whitelist(  # nosemgrep: frappe-semgrep-rules.rules.security.guest-whitelisted-method -- dev-only endpoint; throws immediately if not in developer_mode
	methods=["POST"],
	allow_guest=True,
)
def get_context_for_dev() -> dict:
	"""Boot data endpoint for Vite dev server."""
	if not frappe.conf.developer_mode:
		frappe.throw(_("Developer mode only"))  # nosemgrep: frappe-missing-translate-function-python
	return get_boot()
