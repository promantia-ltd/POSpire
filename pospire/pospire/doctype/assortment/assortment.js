// Copyright (c) 2026, Rajit and contributors
// For license information, please see license.txt

// frappe.ui.form.on("Assortment", {
// 	refresh(frm) {

// 	},
// });
frappe.ui.form.on("Assortment", {
	refresh: function (frm) {
		frm.add_custom_button("Get Items", function () {
			open_items_popup(frm);
		});
	},
});

function open_items_popup(frm) {
	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Item",
			fields: ["name", "item_name"],
			filters: {
				disabled: 0,
			},
			limit_page_length: 1000,
		},
		callback: function (r) {
			let items = r.message || [];

			let d = new frappe.ui.Dialog({
				title: "Select Items",
				size: "large",
				fields: [
					{
						fieldtype: "HTML",
						fieldname: "items_html",
					},
				],
				primary_action_label: "Add Selected",
				primary_action: function () {
					let selected = [];

					d.$wrapper
						.find('#items-container input[type="checkbox"]:checked')
						.each(function () {
							selected.push({
								item_code: $(this).val(),
								item_name: $(this).data("item_name"),
							});
						});

					add_items_to_table(frm, selected);
					d.hide();
				},
			});
			let existing_items = (frm.doc.assortment_items || []).map((row) => row.item);
			let html = `
				<div style="height:450px; display:flex; flex-direction:column;">
					
					<input 
						type="text" 
						id="item-search" 
						placeholder="Search items..." 
						style="margin-bottom:10px; padding:8px; width:100%; border:1px solid #ccc;"
					/>

					<div style="margin-bottom:10px;">
						<input type="checkbox" id="select-all"> Select All
					</div>

					<div id="items-container" style="flex:1; overflow:auto; border:1px solid #eee; padding:8px;">
			`;

			items.forEach((item) => {
				let checked = existing_items.includes(item.name) ? "checked" : "";

				html += `
					<div class="item-row" style="padding:6px; border-bottom:1px solid #f0f0f0;">
						<label style="cursor:pointer; display:flex; gap:10px;">
							<input 
								type="checkbox" 
								value="${item.name}" 
								data-item_name="${item.item_name}"
								${checked}
							/>
							<div>
								<div style="font-weight:600;">${item.item_name}</div>
								<div style="font-size:12px; color:gray;">${item.name}</div>
							</div>
						</label>
					</div>
				`;
			});

			html += `</div></div>`;

			d.fields_dict.items_html.$wrapper.html(html);
			d.show();
			let search_input = d.$wrapper.find("#item-search");

			search_input.on("input", function () {
				let value = $(this).val().toLowerCase();

				d.$wrapper.find(".item-row").each(function () {
					let text = $(this).text().toLowerCase();
					$(this).toggle(text.includes(value));
				});
			});
			d.$wrapper.find("#select-all").on("change", function () {
				let checked = $(this).is(":checked");

				d.$wrapper
					.find('#items-container input[type="checkbox"]')
					.prop("checked", checked);
			});
		},
	});
}

function add_items_to_table(frm, items) {
	let existing_items = (frm.doc.assortment_items || []).map((row) => row.item);

	items.forEach((item) => {
		if (!existing_items.includes(item.item_code)) {
			let row = frm.add_child("assortment_items");
			row.item = item.item_code;
			row.item_name = item.item_name;
		}
	});

	frm.refresh_field("assortment_items");
}
