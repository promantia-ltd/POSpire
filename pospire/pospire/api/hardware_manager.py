# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

import re
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

import frappe
from frappe import _
from frappe.utils import cint, flt, fmt_money, format_date, format_datetime, format_time


def format_currency(amount, currency=None):
	"""Format amount as currency string"""
	if currency:
		return fmt_money(amount, currency=currency)
	return fmt_money(amount)


def extract_base_url(url: str) -> str:
	"""Extract base URL from full URL"""
	parsed = urlparse(url)
	return f"{parsed.scheme}://{parsed.hostname}"


def get_enhanced_context(doc):
	"""
	Get enhanced Jinja context with helper functions for template rendering

	Args:
		doc: Document object

	Returns:
		dict: Context with document and helper functions
	"""
	return {
		"doc": doc,
		# Formatting helpers
		"truncate": lambda s, w: (str(s)[:w] + "..." if len(str(s)) > w else str(s).ljust(w))[:w],
		"pad_left": lambda s, w: str(s).ljust(w)[:w],
		"pad_right": lambda s, w: str(s).rjust(w)[:w],
		"pad_center": lambda s, w: str(s).center(w)[:w],
		# Layout helpers
		"separator": lambda char="-", width=42: char * width,
		"blank_line": lambda: "",
		# Currency helpers
		"format_money": lambda x: format_currency(x, doc.currency if hasattr(doc, "currency") else None),
		"format_qty": lambda x: f"{flt(x):.2f}",
		# Text helpers
		"upper": lambda s: str(s).upper(),
		"lower": lambda s: str(s).lower(),
		"title": lambda s: str(s).title(),
		# Date helpers
		"format_datetime": lambda dt: format_datetime(dt) if dt else "",
		"format_date": lambda d: format_date(d) if d else "",
		"format_time": lambda t: format_time(t) if t else "",
		# Math helpers
		"abs": abs,
		"round": round,
		"int": cint,
		"float": flt,
		# Standard Frappe filters
		"format_currency": format_currency,
		"_": _,  # Translation function
	}


@frappe.whitelist()
def hardware_url(api_name):
	"""Get the full hardware URL for a given API name

	Args:
		api_name (str): Name of the API endpoint

	Returns:
		str: Full URL for the hardware endpoint
	"""
	doc = frappe.get_doc("POS Hardware Manager Setting")
	base_url = extract_base_url(doc.hardware_url)
	port = doc.port

	# Get the API endpoint from the doc child table
	api_endpoint = next((item.api_endpoint for item in doc.api_details if item.api_name == api_name), None)

	if not api_endpoint:
		frappe.throw(_("API endpoint not found for the given API name."))

	if not api_endpoint.startswith("/"):
		api_endpoint = "/" + api_endpoint

	# Construct the full URL
	url = f"{base_url}:{port}{api_endpoint}"
	return url


@frappe.whitelist()
def get_hardware_manager_setting(pos_profile_name):
	"""Check if hardware manager is enabled for a POS Profile

	Args:
		pos_profile_name (str): Name of the POS Profile

	Returns:
		bool: True if hardware manager is enabled, False otherwise
	"""
	doc = frappe.get_doc("POS Profile", pos_profile_name)

	if doc.get("posa_hardware_manager") is None:
		return False

	return True if doc.posa_hardware_manager == 1 else False


@frappe.whitelist()
def render_receipt_xml_to_html(xml_string, doctype=None, docname=None):
	"""Convert XML receipt template to HTML preview

	Args:
		xml_string (str): XML template content
		doctype (str): DocType to fetch document from
		docname (str): Document name to fetch

	Returns:
		str: HTML preview of the receipt
	"""
	try:
		doc = frappe.get_doc(doctype, docname)

		# Use enhanced context with helper functions
		context = get_enhanced_context(doc)

		# Render Jinja inside XML
		rendered_xml = frappe.render_template(xml_string, context)

		# Parse rendered XML
		root = ET.fromstring(rendered_xml)

		html_output = """
		<div class="xml-preview" style="
			font-family: 'Courier New', monospace;
			font-size: 12px;
			line-height: 1.4;
			width: 336px;
			max-width: 336px;
			overflow: hidden;
			margin: auto;
			border: 1px dashed #ccc;
			padding: 8px;
			background: #fff;
			box-sizing: content-box;
		">
		"""

		for ticket in root.findall("ticket"):
			for line in ticket.findall("line"):
				# Calculate total line width to detect overflow
				text_elements = line.findall("text")
				total_width = sum(int(t.attrib.get("length", "42")) for t in text_elements)
				overflow_style = ""
				overflow_title = ""
				if total_width > 42 and len(text_elements) > 1:
					overflow_style = "border-left: 3px solid red; padding-left: 3px;"
					overflow_title = f' title="Line exceeds 42 chars ({total_width})"'
				line_html = f'<div class="line" style="margin-bottom: 2px; white-space: nowrap; overflow: hidden; max-width: 336px;{overflow_style}"{overflow_title}>'
				for text in text_elements:
					content = text.text or ""
					align = text.attrib.get("align", "left")
					bold = "font-weight:bold;" if text.attrib.get("bold") == "true" else ""
					underline = "text-decoration:underline;" if text.attrib.get("underline") == "true" else ""
					_size = text.attrib.get("size", "1")  # Reserved for future font sizing
					length = int(text.attrib.get("length", "42"))  # default to 42 chars

					# Truncate content if it exceeds the length for accurate preview
					if len(content) > length:
						content = content[: length - 1] + "…"

					# Calculate width as percentage of 42-char line (336px total)
					width_percent = (length / 42) * 100

					style = (
						f"display:inline-block;"
						f"width:{width_percent:.2f}%;"
						f"text-align:{align};"
						f"overflow:hidden;"
						f"text-overflow:ellipsis;"
						f"white-space:nowrap;"
						f"{bold}{underline}"
					)

					line_html += f"<span style='{style}'>{content}</span>"
				line_html += "</div>"
				html_output += line_html

			# Handle barcode tag
			for barcode in ticket.findall("barcode"):
				barcode_value = barcode.text or ""
				line_html = f"""
				<div class="line" style="text-align:center; margin: 8px 0;">
					<div style="font-size:10px;">[Barcode: {barcode_value}]</div>
				</div>
				"""
				html_output += line_html

		html_output += "</div>"
		return html_output

	except Exception as e:
		return f"<div style='color: red;'>Error rendering XML: {e}</div>"


@frappe.whitelist()
def get_print_templates(doctype=None):
	"""Get available print templates

	Args:
		doctype (str, optional): Filter by doctype

	Returns:
		list: List of print template documents
	"""
	filters = {}
	if doctype:
		filters["ref_doctype"] = doctype

	templates = frappe.get_all(
		"POS XML Print Designer", filters=filters, fields=["name", "print_format", "ref_doctype"]
	)

	return templates


@frappe.whitelist()
def generate_print_xml(doc_type, sales_invoice_name, template_path=None, template_name=None):
	"""Generate print XML from template and document

	Args:
		doc_type (str): DocType of the document
		sales_invoice_name (str): Name of the document
		template_path (str, optional): Path to XML template file
		template_name (str, optional): Name of POS XML Print Designer template

	Returns:
		str: Rendered XML string
	"""
	# Fetch the document
	doc = frappe.get_doc(doc_type, sales_invoice_name)

	# Determine template content - priority: template_name > template_path > default
	template_content = None

	if template_name:
		# Use specified template by name
		template_content = frappe.get_value("POS XML Print Designer", template_name, "xml_template")
		if not template_content:
			frappe.throw(_("Template '{0}' not found").format(template_name))

	elif template_path:
		# Read template from file path
		try:
			template_content = frappe.read_file(template_path)
		except Exception as e:
			frappe.throw(_("Failed to read template file: {0}").format(str(e)))

	else:
		# Try to find default template for this doctype
		default_template = frappe.get_value(
			"POS XML Print Designer", {"ref_doctype": doc_type, "is_default": 1}, "xml_template"
		)

		if not default_template:
			frappe.throw(
				_(
					"No default template found for {0}. Please set a template as default or specify template_name."
				).format(doc_type)
			)

		template_content = default_template

	# Render template with enhanced context (includes helper functions)
	context = get_enhanced_context(doc)
	rendered_xml = frappe.render_template(template_content, context)

	return rendered_xml


# Template Validation Functions


def remove_jinja_tags(template):
	"""
	Remove Jinja tags from template for XML validation

	Args:
		template (str): Template with Jinja syntax

	Returns:
		str: Template with Jinja tags removed
	"""
	# Remove Jinja variable tags {{ }}
	template = re.sub(r"\{\{[^}]+\}\}", "JINJA_VAR", template)

	# Remove Jinja block tags {% %}
	template = re.sub(r"\{%[^%]+%\}", "", template)

	# Remove Jinja comment tags {# #}
	template = re.sub(r"\{#[^#]+#\}", "", template)

	return template


def validate_jinja_syntax(template):
	"""
	Validate Jinja syntax in template

	Args:
		template (str): Template to validate

	Returns:
		list: List of error messages
	"""
	errors = []

	# Check for unmatched Jinja tags
	open_blocks = re.findall(r"\{%\s*(if|for|block|macro|call|filter|set|trans)\s", template)
	close_blocks = re.findall(r"\{%\s*end(if|for|block|macro|call|filter|set|trans)\s*%\}", template)

	if len(open_blocks) != len(close_blocks):
		errors.append(
			f"Unmatched Jinja blocks: {len(open_blocks)} opening tags, {len(close_blocks)} closing tags"
		)

	# Check for unclosed variable tags
	open_vars = template.count("{{")
	close_vars = template.count("}}")
	if open_vars != close_vars:
		errors.append(f"Unclosed Jinja variables: {open_vars} opening, {close_vars} closing")

	# Check for unclosed block tags
	open_tags = template.count("{%")
	close_tags = template.count("%}")
	if open_tags != close_tags:
		errors.append(f"Unclosed Jinja blocks: {open_tags} opening, {close_tags} closing")

	return errors


def extract_jinja_fields(template):
	"""
	Extract all field references from Jinja template

	Args:
		template (str): Template to parse

	Returns:
		list: List of field paths (e.g., ['doc.name', 'doc.items', 'item.item_name'])
	"""
	fields = []

	# Find all {{ doc.field }} patterns
	doc_fields = re.findall(r"\{\{\s*doc\.([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)", template)
	fields.extend([f"doc.{field}" for field in doc_fields])

	# Find all {% for item in doc.items %} patterns
	for_loops = re.findall(r"\{%\s*for\s+(\w+)\s+in\s+doc\.(\w+)", template)
	for var_name, table_name in for_loops:
		fields.append(f"doc.{table_name}")

		# Find fields used within this loop variable
		loop_fields = re.findall(rf"\{{\{{\s*{var_name}\.([a-zA-Z_][a-zA-Z0-9_]*)", template)
		fields.extend([f"{var_name}.{field}" for field in loop_fields])

	return list(set(fields))  # Remove duplicates


def field_exists(meta, field_path):
	"""
	Check if a field exists in DocType meta

	Args:
		meta: DocType meta object
		field_path (str): Field path (e.g., 'doc.name', 'item.item_name')

	Returns:
		bool: True if field exists
	"""
	# Handle standard fields
	standard_fields = ["name", "owner", "creation", "modified", "modified_by", "docstatus", "idx"]

	parts = field_path.split(".")

	if len(parts) == 2:  # doc.field
		field_name = parts[1]

		# Check standard fields
		if field_name in standard_fields:
			return True

		# Check if field exists in meta
		return meta.has_field(field_name)

	elif len(parts) >= 2:  # item.field (child table)
		# For child table fields, we can't validate without knowing the child doctype
		# Return True to avoid false positives
		return True

	return False


def check_character_widths(template):
	"""
	Check for lines that may exceed character width

	Args:
		template (str): Template to check

	Returns:
		list: List of warning messages
	"""
	warnings = []

	# Find all length attributes
	length_attrs = re.findall(r'length="(\d+)"', template)

	# Check for lengths > 42 (standard thermal printer width)
	for length in length_attrs:
		if int(length) > 42:
			warnings.append(f"Character width {length} exceeds standard printer width (42)")

	# Find lines with multiple text elements and calculate total width
	lines = re.findall(r"<line[^>]*>(.*?)</line>", template, re.DOTALL)
	for i, line in enumerate(lines):
		text_elements = re.findall(r'<text[^>]*length="(\d+)"', line)
		if text_elements:
			total_width = sum(int(w) for w in text_elements)
			if total_width > 42:
				warnings.append(f"Line {i+1}: Total width {total_width} exceeds 42 characters")

	return warnings


def validate_xml_attributes(template):
	"""
	Validate XML attribute values

	Args:
		template (str): Template to validate

	Returns:
		list: List of error messages
	"""
	errors = []

	# Valid attribute values
	valid_align = ["left", "right", "center"]
	valid_bool = ["true", "false"]
	valid_size = ["0", "1", "2", "3"]
	valid_barcode_type = ["EAN13", "CODE128", "EAN8", "UPCA", "UPCE"]

	# Check align attributes
	align_values = re.findall(r'align="([^"]+)"', template)
	for value in align_values:
		if value not in valid_align and not re.match(r"\{\{.*\}\}", value):  # Ignore Jinja variables
			errors.append(f"Invalid align value '{value}'. Must be one of: {', '.join(valid_align)}")

	# Check bold attributes
	bold_values = re.findall(r'bold="([^"]+)"', template)
	for value in bold_values:
		if value not in valid_bool and not re.match(r"\{\{.*\}\}", value):
			errors.append(f"Invalid bold value '{value}'. Must be 'true' or 'false'")

	# Check underline attributes
	underline_values = re.findall(r'underline="([^"]+)"', template)
	for value in underline_values:
		if value not in valid_bool and not re.match(r"\{\{.*\}\}", value):
			errors.append(f"Invalid underline value '{value}'. Must be 'true' or 'false'")

	# Check size attributes
	size_values = re.findall(r'<line[^>]*size="([^"]+)"', template)
	for value in size_values:
		if value not in valid_size and not re.match(r"\{\{.*\}\}", value):
			errors.append(f"Invalid size value '{value}'. Must be one of: {', '.join(valid_size)}")

	# Check barcode type attributes
	barcode_types = re.findall(r'<barcode[^>]*type="([^"]+)"', template)
	for value in barcode_types:
		if value not in valid_barcode_type and not re.match(r"\{\{.*\}\}", value):
			errors.append(f"Invalid barcode type '{value}'. Must be one of: {', '.join(valid_barcode_type)}")

	return errors


@frappe.whitelist()
def validate_xml_template(xml_template, doc_type):
	"""
	Validate XML template structure and content

	Args:
		xml_template (str): XML template to validate
		doc_type (str): DocType name for field validation

	Returns:
		dict: {
			"valid": bool,
			"errors": [],      # Critical issues
			"warnings": [],    # Non-blocking issues
			"info": []         # Informational messages
		}
	"""
	errors = []
	warnings = []
	info = []

	# 1. Check XML well-formedness
	try:
		# Strip Jinja to validate pure XML structure
		xml_without_jinja = remove_jinja_tags(xml_template)
		ET.fromstring(xml_without_jinja)
		info.append("XML structure is well-formed")
	except ET.ParseError as e:
		errors.append(f"XML Parse Error: {e!s}")

	# 2. Validate XML print structure
	required_elements = ["output", "ticket"]
	for element in required_elements:
		if f"<{element}" not in xml_template:
			errors.append(f"Missing required element: <{element}>")

	if "<output>" in xml_template and "</output>" in xml_template:
		info.append("Required print format elements present")

	# 3. Validate Jinja syntax
	jinja_errors = validate_jinja_syntax(xml_template)
	if jinja_errors:
		errors.extend(jinja_errors)
	else:
		info.append("Jinja syntax is valid")

	# 4. Check field existence (if doc_type provided)
	if doc_type:
		try:
			meta = frappe.get_meta(doc_type)
			fields = extract_jinja_fields(xml_template)

			missing_fields = []
			for field in fields:
				if field.startswith("doc.") and not field_exists(meta, field):
					field_name = field.split(".")[1]
					if field_name not in ["items", "payments", "taxes"]:  # Common child tables
						missing_fields.append(field_name)

			if missing_fields:
				warnings.extend([f"Field '{field}' not found in {doc_type}" for field in missing_fields])
			else:
				info.append(f"All fields exist in {doc_type}")
		except Exception as e:
			warnings.append(f"Could not validate fields: {e!s}")

	# 5. Character width warnings
	width_warnings = check_character_widths(xml_template)
	if width_warnings:
		warnings.extend(width_warnings)
	else:
		info.append("Character widths are within limits")

	# 6. Validate attributes
	attr_errors = validate_xml_attributes(xml_template)
	if attr_errors:
		errors.extend(attr_errors)
	else:
		info.append("Attribute values are valid")

	return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings, "info": info}
