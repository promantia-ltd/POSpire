# Copyright (c) 2025, Promantia Business Solutions PVT Ltd and contributors
# For license information, please see license.txt

"""
HTML to XML Template Converter
Converts Frappe Print Format HTML/Jinja templates to thermal printer XML format
"""

import re
from html import unescape

import frappe
from bs4 import BeautifulSoup, NavigableString, Tag
from frappe import _

# Jinja placeholder pattern for preserving syntax during conversion
JINJA_PLACEHOLDER_PREFIX = "___JINJA_BLOCK_"
JINJA_PLACEHOLDER_SUFFIX = "___"


@frappe.whitelist()
def convert_print_format_to_xml(
	print_format_name: str | None = None,
	html_content: str | None = None,
	doc_type: str | None = None,
) -> dict:
	"""
	Convert a Frappe Print Format or HTML content to thermal printer XML template

	Args:
		print_format_name: Name of Print Format to convert
		html_content: Raw HTML content to convert (if print_format_name not provided)
		doc_type: DocType for context (optional, for field validation)

	Returns:
		dict: {
			"xml_template": str,
			"warnings": list,
			"info": list
		}
	"""
	warnings = []
	info = []

	# Get HTML content
	if print_format_name:
		print_format = frappe.get_doc("Print Format", print_format_name)
		doc_type = doc_type or print_format.doc_type

		# Try to get HTML content from different sources
		html_content = print_format.html

		# If html field is empty, check if it's a standard or Jinja template
		if not html_content:
			# Check if it's a standard print format (no custom HTML)
			if print_format.standard == "Yes" or print_format.print_format_type == "Standard":
				frappe.throw(
					_(
						"Cannot convert Standard Print Format '{0}'. Only custom Print Formats with HTML/Jinja content can be converted."
					).format(print_format_name),
					title=_("Standard Print Format"),
				)

			# Check for Jinja template file
			if print_format.print_format_type == "Jinja":
				# Try to read from template file
				template_path = frappe.get_app_path(
					print_format.module.lower().replace(" ", "_") if print_format.module else "frappe",
					"print_format",
					frappe.scrub(print_format_name),
					frappe.scrub(print_format_name) + ".html",
				)
				try:
					html_content = frappe.read_file(template_path)
				except Exception:
					pass

			# If still no content, throw error
			if not html_content:
				frappe.throw(
					_(
						"Print Format '{0}' has no HTML content to convert. Please select a Print Format with custom HTML/Jinja template."
					).format(print_format_name),
					title=_("No HTML Content"),
				)

		info.append(f"Converted from Print Format: {print_format_name}")
	elif not html_content:
		frappe.throw(_("Either print_format_name or html_content must be provided"))

	# Initialize converter
	converter = HTMLToXMLConverter(html_content, doc_type, warnings, info)
	xml_template = converter.convert()

	return {"xml_template": xml_template, "warnings": warnings, "info": info}


class HTMLToXMLConverter:
	"""Handles the conversion from HTML/Jinja to thermal printer XML"""

	def __init__(self, html_content, doc_type=None, warnings=None, info=None):
		self.original_html = html_content
		self.doc_type = doc_type
		self.warnings = warnings or []
		self.info = info or []

		# Storage for Jinja blocks
		self.jinja_blocks = {}
		self.jinja_counter = 0

		# Configuration
		self.line_width = 42  # Standard thermal printer width

	def convert(self):
		"""Main conversion method"""

		# Step 1: Extract and preserve Jinja blocks
		html_safe = self._extract_jinja_blocks(self.original_html)

		# Step 2: Parse HTML
		soup = BeautifulSoup(html_safe, "html.parser")

		# Step 3: Convert to XML structure
		xml_lines = []
		xml_lines.append('<?xml version="1.0" encoding="UTF-8"?>')
		xml_lines.append("<output>")
		xml_lines.append("  <ticket>")

		# Convert body content
		body = soup.find("body") or soup
		for element in body.children:
			if isinstance(element, Tag):
				converted = self._convert_element(element, indent=4)
				if converted:
					xml_lines.extend(converted)

		xml_lines.append("  </ticket>")
		xml_lines.append("</output>")

		# Step 4: Restore Jinja blocks
		xml_content = "\n".join(xml_lines)
		xml_content = self._restore_jinja_blocks(xml_content)

		# Step 5: Add info messages
		if not self.warnings:
			self.info.append("Conversion completed successfully")
		self.info.append(f"Total Jinja blocks preserved: {len(self.jinja_blocks)}")

		return xml_content

	def _extract_jinja_blocks(self, html):
		"""Extract Jinja syntax and replace with placeholders"""

		# Patterns for Jinja blocks
		patterns = [
			(r"\{%.*?%\}", "statement"),  # {% ... %}
			(r"\{\{.*?\}\}", "variable"),  # {{ ... }}
			(r"\{#.*?#\}", "comment"),  # {# ... #}
		]

		result = html
		for pattern, _block_type in patterns:
			matches = re.finditer(pattern, result, re.DOTALL)
			for match in matches:
				jinja_block = match.group(0)
				placeholder = f"{JINJA_PLACEHOLDER_PREFIX}{self.jinja_counter}{JINJA_PLACEHOLDER_SUFFIX}"
				self.jinja_blocks[placeholder] = jinja_block
				result = result.replace(jinja_block, placeholder, 1)
				self.jinja_counter += 1

		return result

	def _restore_jinja_blocks(self, xml_content):
		"""Restore Jinja blocks from placeholders"""
		result = xml_content
		for placeholder, jinja_block in self.jinja_blocks.items():
			result = result.replace(placeholder, jinja_block)
		return result

	def _convert_element(self, element, indent=0):
		"""Convert HTML element to XML lines"""

		if isinstance(element, NavigableString):
			text = str(element).strip()
			if text:
				return [" " * indent + f"<line><text>{self._escape_xml(text)}</text></line>"]
			return []

		if not isinstance(element, Tag):
			return []

		tag_name = element.name.lower()

		# Map HTML tags to conversion methods
		tag_handlers = {
			"p": self._convert_paragraph,
			"div": self._convert_div,
			"span": self._convert_span,
			"h1": self._convert_heading,
			"h2": self._convert_heading,
			"h3": self._convert_heading,
			"h4": self._convert_heading,
			"h5": self._convert_heading,
			"h6": self._convert_heading,
			"b": self._convert_bold,
			"strong": self._convert_bold,
			"i": self._convert_italic,
			"em": self._convert_italic,
			"u": self._convert_underline,
			"br": self._convert_break,
			"hr": self._convert_separator,
			"table": self._convert_table,
			"ul": self._convert_list,
			"ol": self._convert_list,
			"li": self._convert_list_item,
			"img": self._convert_image,
		}

		handler = tag_handlers.get(tag_name, self._convert_generic)
		return handler(element, indent)

	def _convert_paragraph(self, element, indent):
		"""Convert <p> to <line><text>"""
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		attrs = self._get_text_attributes(element)
		attr_str = " " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) if attrs else ""

		return [" " * indent + f"<line><text{attr_str}>{text_content}</text></line>"]

	def _convert_div(self, element, indent):
		"""Convert <div> - process children"""
		lines = []

		# Check for alignment
		align = self._get_alignment(element)
		if align:
			self.info.append(f"Found div with alignment: {align}")

		for child in element.children:
			if isinstance(child, Tag):
				converted = self._convert_element(child, indent)
				if converted:
					lines.extend(converted)
			elif isinstance(child, NavigableString):
				text = str(child).strip()
				if text:
					attrs = {"align": align} if align else {}
					attr_str = " " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) if attrs else ""
					lines.append(
						" " * indent + f"<line><text{attr_str}>{self._escape_xml(text)}</text></line>"
					)

		return lines

	def _convert_span(self, element, indent):
		"""Convert <span> - inline formatting"""
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		attrs = self._get_text_attributes(element)
		attr_str = " " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) if attrs else ""

		return [" " * indent + f"<line><text{attr_str}>{text_content}</text></line>"]

	def _convert_heading(self, element, indent):
		"""Convert <h1>-<h6> to centered, bold text"""
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		# Headings are typically centered and bold
		attr_str = ' align="center" bold="true"'

		lines = []
		lines.append(" " * indent + f"<line><text{attr_str}>{text_content}</text></line>")

		# Add separator after heading
		level = int(element.name[1])  # h1 -> 1, h2 -> 2, etc.
		if level <= 2:
			lines.append(" " * indent + '<line><text>{{ separator("=") }}</text></line>')

		return lines

	def _convert_bold(self, element, indent):
		"""Convert <b>/<strong> to bold="true" """
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		return [" " * indent + f'<line><text bold="true">{text_content}</text></line>']

	def _convert_italic(self, element, indent):
		"""Convert <i>/<em> - thermal printers don't support italic, use regular text"""
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		self.warnings.append(
			"Italic text detected - thermal printers don't support italic, using regular text"
		)
		return [" " * indent + f"<line><text>{text_content}</text></line>"]

	def _convert_underline(self, element, indent):
		"""Convert <u> to underline="true" """
		text_content = self._get_text_with_formatting(element)
		if not text_content.strip():
			return []

		return [" " * indent + f'<line><text underline="true">{text_content}</text></line>']

	def _convert_break(self, element, indent):
		"""Convert <br> to blank line"""
		return [" " * indent + "<line><text>{{ blank_line() }}</text></line>"]

	def _convert_separator(self, element, indent):
		"""Convert <hr> to separator"""
		return [" " * indent + '<line><text>{{ separator("-") }}</text></line>']

	def _convert_table(self, element, indent):
		"""Convert <table> to multiple <line> elements"""
		lines = []
		lines.append(" " * indent + "<!-- Table converted to lines -->")

		# Find all rows
		rows = element.find_all("tr")

		for row_idx, row in enumerate(rows):
			cells = row.find_all(["td", "th"])
			if not cells:
				continue

			# Calculate column width
			col_width = self.line_width // len(cells)

			# Build line with multiple text elements
			line_parts = []
			for cell_idx, cell in enumerate(cells):
				cell_text = self._get_text_with_formatting(cell)

				# Determine alignment
				if cell_idx == 0:
					align = "left"
				elif cell_idx == len(cells) - 1:
					align = "right"
				else:
					align = "center"

				# Bold for header cells
				is_header = cell.name == "th" or row_idx == 0
				bold_attr = ' bold="true"' if is_header else ""

				line_parts.append(
					f'<text align="{align}" length="{col_width}"{bold_attr}>{{{{ truncate({cell_text}, {col_width}) }}}}</text>'
				)

			lines.append(" " * indent + f'<line>{" ".join(line_parts)}</line>')

		# Add separator after table
		lines.append(" " * indent + '<line><text>{{ separator("-") }}</text></line>')

		self.info.append(f"Converted table with {len(rows)} rows")
		return lines

	def _convert_list(self, element, indent):
		"""Convert <ul>/<ol> to lines with bullets/numbers"""
		lines = []
		list_type = element.name  # 'ul' or 'ol'

		items = element.find_all("li", recursive=False)
		for idx, item in enumerate(items, start=1):
			prefix = f"{idx}. " if list_type == "ol" else "• "
			text_content = self._get_text_with_formatting(item)
			lines.append(" " * indent + f"<line><text>{prefix}{text_content}</text></line>")

		return lines

	def _convert_list_item(self, element, indent):
		"""Convert standalone <li> - should be handled by parent list"""
		text_content = self._get_text_with_formatting(element)
		return [" " * indent + f"<line><text>• {text_content}</text></line>"]

	def _convert_image(self, element, indent):
		"""Convert <img> to logo/image element"""
		src = element.get("src", "")

		if "logo" in src.lower() or "company" in src.lower():
			lines = []
			lines.append(" " * indent + "<!-- Company logo -->")
			lines.append(" " * indent + '<line><image>{{ doc.company_logo or "" }}</image></line>')
			self.info.append("Detected logo image - added logo element")
			return lines

		self.warnings.append(f"Image detected: {src} - Thermal printer XML has limited image support")
		return [" " * indent + f"<!-- Image: {src} (not supported) -->"]

	def _convert_generic(self, element, indent):
		"""Generic handler for unknown tags - process children"""
		lines = []
		for child in element.children:
			if isinstance(child, Tag):
				converted = self._convert_element(child, indent)
				if converted:
					lines.extend(converted)
			elif isinstance(child, NavigableString):
				text = str(child).strip()
				if text:
					lines.append(" " * indent + f"<line><text>{self._escape_xml(text)}</text></line>")
		return lines

	def _get_text_with_formatting(self, element):
		"""Get text content preserving Jinja placeholders"""
		# Use get_text but preserve our placeholders
		text = element.get_text(separator=" ", strip=True)
		return self._escape_xml(text)

	def _get_text_attributes(self, element):
		"""Extract text attributes from HTML element"""
		attrs = {}

		# Check for alignment
		align = self._get_alignment(element)
		if align:
			attrs["align"] = align

		# Check for bold/italic/underline in style or class
		style = element.get("style", "").lower()
		class_names = " ".join(element.get("class", [])).lower()

		if "font-weight:bold" in style or "bold" in class_names:
			attrs["bold"] = "true"

		if "text-decoration:underline" in style or "underline" in class_names:
			attrs["underline"] = "true"

		return attrs

	def _get_alignment(self, element):
		"""Extract text alignment from HTML element"""
		# Check style attribute
		style = element.get("style", "").lower()
		if "text-align:center" in style:
			return "center"
		elif "text-align:right" in style:
			return "right"
		elif "text-align:left" in style:
			return "left"

		# Check class attribute
		class_names = " ".join(element.get("class", [])).lower()
		if "text-center" in class_names or "center" in class_names:
			return "center"
		elif "text-right" in class_names or "right" in class_names:
			return "right"
		elif "text-left" in class_names or "left" in class_names:
			return "left"

		# Check align attribute (deprecated but still used)
		align = element.get("align", "").lower()
		if align in ["left", "center", "right"]:
			return align

		return None

	def _escape_xml(self, text):
		"""Escape XML special characters but preserve Jinja placeholders"""
		# Don't escape our Jinja placeholders
		if JINJA_PLACEHOLDER_PREFIX in str(text):
			return str(text)

		# Unescape HTML entities first
		text = unescape(str(text))

		# Escape XML special characters
		text = text.replace("&", "&amp;")
		text = text.replace("<", "&lt;")
		text = text.replace(">", "&gt;")
		text = text.replace('"', "&quot;")
		text = text.replace("'", "&apos;")

		return text


@frappe.whitelist()
def get_print_formats_for_doctype(doc_type: str) -> list:
	"""Get list of available Print Formats for a DocType"""
	if not doc_type:
		return []

	print_formats = frappe.get_all(
		"Print Format",
		filters={"doc_type": doc_type},
		fields=["name", "standard", "disabled"],
		order_by="standard desc, name asc",
	)

	# Filter out disabled formats
	print_formats = [pf for pf in print_formats if not pf.get("disabled")]

	return print_formats
