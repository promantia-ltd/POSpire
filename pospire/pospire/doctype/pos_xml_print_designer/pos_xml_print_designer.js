// Copyright (c) 2025, Promantia Business Solutions PVT Ltd and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS XML Print Designer", {
	xml_template: function (frm) {
		if (!frm.doc.xml_template) return;

		frappe.call({
			method: "pospire.pospire.api.hardware_manager.render_receipt_xml_to_html",
			args: {
				xml_string: frm.doc.xml_template,
				doctype: frm.doc.ref_doctype,
				docname: frm.doc.ref_docname,
			},
			callback: function (r) {
				frm.set_df_property("html_preview", "options", r.message);
				frm.refresh_field("html_preview");
			},
		});
	},

	refresh(frm) {
		// Preview button
		if (!frm.doc.__islocal && frm.doc.xml_template) {
			frm.add_custom_button(__("Preview"), function () {
				frm.trigger("xml_template");
			});

			// Validate button
			frm.add_custom_button(
				__("Validate Template"),
				function () {
					validate_template(frm);
				},
				__("Actions")
			);
		}

		// Convert from Print Format button
		if (!frm.doc.__islocal && frm.doc.ref_doctype) {
			frm.add_custom_button(
				__("Convert from Print Format"),
				function () {
					show_print_format_converter(frm);
				},
				__("Actions")
			);
		}
	},
});

function validate_template(frm) {
	if (!frm.doc.xml_template || !frm.doc.ref_doctype) {
		frappe.msgprint(__("Please enter XML template and select DocType"));
		return;
	}

	frappe.call({
		method: "pospire.pospire.api.hardware_manager.validate_xml_template",
		args: {
			xml_template: frm.doc.xml_template,
			doc_type: frm.doc.ref_doctype,
		},
		callback: function (r) {
			if (r.message) {
				show_validation_results(r.message);
			}
		},
	});
}

function show_validation_results(result) {
	const dialog = new frappe.ui.Dialog({
		title: __("Template Validation Results"),
		size: "large",
		fields: [
			{
				fieldtype: "HTML",
				fieldname: "validation_html",
			},
		],
	});

	// Build HTML for results
	let html = '<div style="padding: 10px;">';

	// Status indicator
	if (result.valid) {
		html +=
			'<div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">';
		html += '<h4 style="margin: 0; color: #155724;">✓ Template is valid</h4>';
		html += "</div>";
	} else {
		html +=
			'<div style="background: #f8d7da; border-left: 4px solid #dc3545; padding: 15px; margin-bottom: 20px;">';
		html += '<h4 style="margin: 0; color: #721c24;">✗ Template has errors</h4>';
		html += "</div>";
	}

	// Errors
	if (result.errors && result.errors.length > 0) {
		html += '<div style="margin-bottom: 20px;">';
		html += '<h5 style="color: #dc3545; margin-bottom: 10px;">Errors (must fix):</h5>';
		html += '<ul style="margin: 0; padding-left: 20px;">';
		result.errors.forEach((error) => {
			html += `<li style="color: #721c24; margin-bottom: 5px;">${escapeHtml(error)}</li>`;
		});
		html += "</ul>";
		html += "</div>";
	}

	// Warnings
	if (result.warnings && result.warnings.length > 0) {
		html += '<div style="margin-bottom: 20px;">';
		html += '<h5 style="color: #ff9800; margin-bottom: 10px;">Warnings:</h5>';
		html += '<ul style="margin: 0; padding-left: 20px;">';
		result.warnings.forEach((warning) => {
			html += `<li style="color: #856404; margin-bottom: 5px;">${escapeHtml(warning)}</li>`;
		});
		html += "</ul>";
		html += "</div>";
	}

	// Info
	if (result.info && result.info.length > 0) {
		html += "<div>";
		html += '<h5 style="color: #17a2b8; margin-bottom: 10px;">Info:</h5>';
		html += '<ul style="margin: 0; padding-left: 20px;">';
		result.info.forEach((info) => {
			html += `<li style="color: #0c5460; margin-bottom: 5px;">${escapeHtml(info)}</li>`;
		});
		html += "</ul>";
		html += "</div>";
	}

	html += "</div>";

	dialog.fields_dict.validation_html.$wrapper.html(html);
	dialog.show();
}

function escapeHtml(text) {
	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};
	return text.replace(/[&<>"']/g, (m) => map[m]);
}

function show_print_format_converter(frm) {
	// Get available Print Formats for this DocType
	frappe.call({
		method: "pospire.api.template_converter.get_print_formats_for_doctype",
		args: {
			doc_type: frm.doc.ref_doctype,
		},
		callback: function (r) {
			if (!r.message || r.message.length === 0) {
				frappe.msgprint(__("No Print Formats found for {0}", [frm.doc.ref_doctype]));
				return;
			}

			// Show dialog to select Print Format
			const print_formats = r.message;
			const dialog = new frappe.ui.Dialog({
				title: __("Convert Print Format to XML Template"),
				fields: [
					{
						fieldtype: "HTML",
						fieldname: "info_html",
						options: `
							<div style="padding: 10px; background: #f8f9fa; border-left: 3px solid #17a2b8; margin-bottom: 15px;">
								<p style="margin: 0; color: #0c5460;">
									<strong>⚙️ HTML to XML Converter</strong><br>
									This tool converts Frappe Print Format HTML/Jinja templates to thermal printer XML format.
									The converter will attempt to map HTML elements to thermal printer commands.
								</p>
							</div>
						`,
					},
					{
						fieldtype: "Select",
						fieldname: "print_format",
						label: __("Select Print Format"),
						options: print_formats.map((pf) => pf.name),
						reqd: 1,
						description: __("Choose a Print Format to convert"),
					},
					{
						fieldtype: "Check",
						fieldname: "append_mode",
						label: __("Append to existing template"),
						default: 0,
						description: __(
							"If checked, converted XML will be appended to existing template instead of replacing it"
						),
					},
				],
				primary_action_label: __("Convert"),
				primary_action: function (values) {
					dialog.hide();

					// Show progress indicator
					frappe.show_alert({
						message: __("Converting..."),
						indicator: "blue",
					});

					// Call conversion API
					frappe.call({
						method: "pospire.api.template_converter.convert_print_format_to_xml",
						args: {
							print_format_name: values.print_format,
							doc_type: frm.doc.ref_doctype,
						},
						callback: function (conv_result) {
							if (conv_result.message) {
								const result = conv_result.message;

								// Update template field
								if (values.append_mode && frm.doc.xml_template) {
									// Append to existing template (before closing tags)
									const existing = frm.doc.xml_template;
									const insert_pos = existing.lastIndexOf("</ticket>");
									if (insert_pos > 0) {
										const new_content =
											existing.substring(0, insert_pos) +
											"\n    <!-- Converted content -->\n" +
											result.xml_template.substring(
												result.xml_template.indexOf("<ticket>") + 8,
												result.xml_template.lastIndexOf("</ticket>")
											) +
											"\n" +
											existing.substring(insert_pos);
										frm.set_value("xml_template", new_content);
									} else {
										frm.set_value("xml_template", result.xml_template);
									}
								} else {
									frm.set_value("xml_template", result.xml_template);
								}

								// Show results dialog
								show_conversion_results(result, values.print_format);
							}
						},
					});
				},
			});

			dialog.show();
		},
	});
}

function show_conversion_results(result, print_format_name) {
	const dialog = new frappe.ui.Dialog({
		title: __("Conversion Results"),
		size: "large",
		fields: [
			{
				fieldtype: "HTML",
				fieldname: "results_html",
			},
		],
	});

	// Build results HTML
	let html = '<div style="padding: 10px;">';

	// Success indicator
	html +=
		'<div style="background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin-bottom: 20px;">';
	html += '<h4 style="margin: 0; color: #155724;">✓ Conversion completed</h4>';
	html += `<p style="margin: 5px 0 0 0; color: #155724;">Print Format "${escapeHtml(
		print_format_name
	)}" has been converted to XML template.</p>`;
	html += "</div>";

	// Warnings
	if (result.warnings && result.warnings.length > 0) {
		html += '<div style="margin-bottom: 20px;">';
		html += '<h5 style="color: #ff9800; margin-bottom: 10px;">⚠️ Warnings:</h5>';
		html += '<ul style="margin: 0; padding-left: 20px;">';
		result.warnings.forEach((warning) => {
			html += `<li style="color: #856404; margin-bottom: 5px;">${escapeHtml(warning)}</li>`;
		});
		html += "</ul>";
		html += "</div>";
	}

	// Info
	if (result.info && result.info.length > 0) {
		html += "<div>";
		html += '<h5 style="color: #17a2b8; margin-bottom: 10px;">ℹ️ Information:</h5>';
		html += '<ul style="margin: 0; padding-left: 20px;">';
		result.info.forEach((info) => {
			html += `<li style="color: #0c5460; margin-bottom: 5px;">${escapeHtml(info)}</li>`;
		});
		html += "</ul>";
		html += "</div>";
	}

	// Next steps
	html +=
		'<div style="margin-top: 20px; padding: 15px; background: #e7f3ff; border-left: 4px solid #2196F3;">';
	html += '<h5 style="margin: 0 0 10px 0; color: #0c5460;">📝 Next Steps:</h5>';
	html += '<ol style="margin: 0; padding-left: 20px; color: #0c5460;">';
	html += "<li>Review the converted XML template</li>";
	html += "<li>Adjust formatting and helper functions as needed</li>";
	html += '<li>Use "Preview" button to test the template</li>';
	html += '<li>Use "Validate Template" to check for errors</li>';
	html += "<li>Save the template when ready</li>";
	html += "</ol>";
	html += "</div>";

	html += "</div>";

	dialog.fields_dict.results_html.$wrapper.html(html);
	dialog.show();
}
