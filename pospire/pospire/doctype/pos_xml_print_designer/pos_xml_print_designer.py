# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class POSXMLPrintDesigner(Document):
	def validate(self):
		"""Validate template before saving"""
		self.validate_default_requires_template()
		self.validate_template()
		self.ensure_single_default()

	def validate_default_requires_template(self):
		"""Ensure is_default can only be enabled when xml_template has content"""
		if self.is_default and not self.xml_template:
			frappe.throw(
				_(
					"Cannot set as default template without XML template content. "
					"Please add XML template first or use 'Convert from Print Format' to generate one."
				),
				title=_("Template Required"),
			)

	def validate_template(self):
		"""Run template validator and throw if critical errors found"""
		if not self.xml_template or not self.ref_doctype:
			return

		# Call the validator
		from pospire.pospire.api.hardware_manager import validate_xml_template

		result = validate_xml_template(self.xml_template, self.ref_doctype)

		# Throw error if validation failed
		if not result.get("valid"):
			error_msg = _("Template validation failed:") + "\n\n"
			error_msg += "\n".join(f"• {err}" for err in result.get("errors", []))
			frappe.throw(error_msg, title=_("Template Validation Error"))

		# Show warnings (but don't block save)
		if result.get("warnings"):
			for warning in result.get("warnings"):
				frappe.msgprint(warning, indicator="orange", alert=True)

	def ensure_single_default(self):
		"""Ensure only one template is marked as default per DocType"""
		if self.is_default:
			# Unset other defaults for this DocType
			frappe.db.sql(
				"""
				UPDATE `tabPOS XML Print Designer`
				SET is_default = 0
				WHERE ref_doctype = %s
				AND name != %s
				AND is_default = 1
			""",
				(self.ref_doctype, self.name),
			)

			frappe.msgprint(
				_("This template is now the default for {0}").format(self.ref_doctype),
				indicator="green",
				alert=True,
			)
