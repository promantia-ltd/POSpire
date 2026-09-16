frappe.provide("frappe.pospire_filter");

(function () {
	const DASHBOARD_NAME = "POSpire Dashboard";
	const WORKSPACE_NAME = "POSpire";
	const REPORT_NAME = "POS Sales Trend by Terminal and Store";

	frappe.pospire_filter._registry = [];
	frappe.pospire_filter._selected = { company: null, pos_profile: null };

	frappe.pospire_filter.reset_registry = function () {
		frappe.pospire_filter._registry = [];
	};

	frappe.pospire_filter.get_company = function () {
		return (
			frappe.pospire_filter._selected.company || frappe.defaults.get_user_default("Company")
		);
	};

	frappe.pospire_filter.get_pos_profile = function () {
		return frappe.pospire_filter._selected.pos_profile || "%";
	};

	const original_make_widget = frappe.widget.make_widget;
	frappe.widget.make_widget = function (opts) {
		const widget = original_make_widget(opts);
		try {
			if (widget && (opts.widget_type === "chart" || opts.widget_type === "number_card")) {
				frappe.pospire_filter._registry.push({ type: opts.widget_type, widget });
				if (opts.widget_type === "chart") {
					ensure_chart_render_is_awaitable(widget);
				}
			}
		} catch (e) {
			console.error("pos_universal_filter: widget registry push failed", e); // eslint-disable-line no-console
		}
		return widget;
	};

	let chart_render_patched = false;
	function ensure_chart_render_is_awaitable(widget) {
		if (chart_render_patched) return;
		chart_render_patched = true;
		const proto = Object.getPrototypeOf(widget);
		const original_render = proto.render;
		proto.render = function (...args) {
			const result = original_render.apply(this, args);
			if (this._pospire_resolve_refresh) {
				const resolve = this._pospire_resolve_refresh;
				this._pospire_resolve_refresh = null;
				resolve();
			}
			return result;
		};
	}

	async function apply_filters(selected) {
		frappe.pospire_filter._selected.company = selected.company;
		frappe.pospire_filter._selected.pos_profile = selected.pos_profile || null;

		const pending = frappe.pospire_filter._registry.map(({ type, widget }) => {
			if (type === "chart" && widget.chart_doc) {
				delete widget.filters;
				if (widget.chart_settings && widget.chart_settings.filters) {
					delete widget.chart_settings.filters;
					widget.save_chart_config_for_user({ filters: null });
				}

				delete widget.filter_group;
				const done = new Promise((resolve) => {
					widget._pospire_resolve_refresh = resolve;
				});
				widget.refresh();
				return done;
			} else if (type === "number_card" && widget.card_doc) {
				widget.refresh();
			}
			return null;
		});

		await Promise.all(pending.filter(Boolean));
	}

	function make_link_control(df, $parent) {
		const f = frappe.ui.form.make_control({ df, parent: $parent });
		f.refresh();
		if (!f.$input) f.make_input();

		f.$wrapper.find(".form-group").css("margin-bottom", 0);
		return f;
	}

	function build_dashboard_bar(on_apply) {
		const $bar = $(`
			<div class="pospire-universal-filter-bar" style="display:flex;align-items:flex-end;
				gap:12px;padding:var(--margin-md) 12px;flex-wrap:wrap;">
				<div class="pospire-filter-company" style="width:220px;"></div>
				<div class="pospire-filter-pos-profile" style="width:220px;"></div>
				<button class="btn btn-primary btn-sm pospire-filter-apply" style="height:30px;">${__(
					"Apply Filter"
				)}</button>
			</div>
		`);

		const company_field = make_link_control(
			{
				fieldname: "pospire_filter_company",
				label: __("Company"),
				fieldtype: "Link",
				options: "Company",
			},
			$bar.find(".pospire-filter-company")
		);
		const pos_profile_field = make_link_control(
			{
				fieldname: "pospire_filter_pos_profile",
				label: __("POS Profile"),
				fieldtype: "Link",
				options: "POS Profile",
				get_query: () => ({ filters: { company: company_field.get_value() } }),
			},
			$bar.find(".pospire-filter-pos-profile")
		);

		let last_company_value = null;
		function clear_pos_profile_if_company_changed() {
			const current = company_field.get_value();
			if (current !== last_company_value) {
				last_company_value = current;
				pos_profile_field.set_value("");
			}
		}
		company_field.$input.on(
			"awesomplete-select change blur",
			clear_pos_profile_if_company_changed
		);

		const $apply_btn = $bar.find(".pospire-filter-apply");
		$apply_btn.on("click", async () => {
			const company = company_field.get_value();
			if (!company) {
				frappe.show_alert({ message: __("Select a Company first"), indicator: "orange" });
				return;
			}

			const original_label = $apply_btn.text();
			$apply_btn.prop("disabled", true).text(__("Applying..."));
			try {
				await on_apply(company, pos_profile_field.get_value());
			} finally {
				$apply_btn.prop("disabled", false).text(original_label);
			}
		});

		return { $bar, company_field, pos_profile_field };
	}

	function detach_from_dashboard() {
		if (frappe.dashboard && frappe.dashboard._pospire_filter_bar) {
			frappe.dashboard._pospire_filter_bar.$bar.hide();
		}
	}

	function attach_to_dashboard() {
		const dashboard = frappe.dashboard;
		if (!dashboard._pospire_filter_bar) {
			const bar = build_dashboard_bar((company, pos_profile) =>
				apply_filters({ company, pos_profile })
			);

			dashboard.container.parent().prepend(bar.$bar);
			dashboard._pospire_filter_bar = bar;
		}

		const bar = dashboard._pospire_filter_bar;
		bar.$bar.show();
		if (!bar.company_field.get_value()) {
			bar.company_field.set_value(frappe.defaults.get_user_default("Company"));
		}
	}

	function detach_from_workspace() {
		if (frappe.workspace && frappe.workspace._pospire_filter_bar) {
			frappe.workspace._pospire_filter_bar.$bar.hide();
		}
	}

	function attach_to_workspace() {
		const workspace = frappe.workspace;
		if (!workspace._pospire_filter_bar) {
			const bar = build_dashboard_bar((company, pos_profile) =>
				apply_filters({ company, pos_profile })
			);

			workspace.body.prepend(bar.$bar);
			workspace._pospire_filter_bar = bar;
		}

		const bar = workspace._pospire_filter_bar;
		bar.$bar.show();
		if (!bar.company_field.get_value()) {
			bar.company_field.set_value(frappe.defaults.get_user_default("Company"));
		}
	}

	function detach_from_report() {
		if (frappe.query_report && frappe.query_report._pospire_filter_bar) {
			frappe.query_report._pospire_filter_bar.$bar.hide();
		}
	}

	function attach_to_report() {
		const report = frappe.query_report;
		if (!report._pospire_filter_bar) {
			const bar = build_dashboard_bar((company, pos_profile) =>
				report.set_filter_value({ company, pos_profile: pos_profile || "" })
			);

			report.page.main.prepend(bar.$bar);
			report._pospire_filter_bar = bar;
		}

		const bar = report._pospire_filter_bar;
		bar.$bar.show();
		if (!bar.company_field.get_value()) {
			bar.company_field.set_value(frappe.defaults.get_user_default("Company"));
		}
	}

	function is_pospire_workspace_route(route) {
		// Public workspace: ["Workspaces", "POSpire"]. Private (per-user) copy
		// of the same workspace name: ["Workspaces", "private", "POSpire"].
		return (
			route[0] === "Workspaces" &&
			(route[1] === WORKSPACE_NAME ||
				(route[1] === "private" && route[2] === WORKSPACE_NAME))
		);
	}

	function is_pospire_report_route(route) {
		return route[0] === "query-report" && route[1] === REPORT_NAME;
	}

	frappe.pospire_filter.setup_for_current_page = function () {
		const route = frappe.get_route();
		if (route[0] === "dashboard-view" && route[1] === DASHBOARD_NAME && frappe.dashboard) {
			frappe.pospire_filter.reset_registry();
			attach_to_dashboard();
			detach_from_workspace();
			detach_from_report();
		} else if (is_pospire_workspace_route(route) && frappe.workspace) {
			frappe.pospire_filter.reset_registry();
			attach_to_workspace();
			detach_from_dashboard();
			detach_from_report();
		} else if (is_pospire_report_route(route) && frappe.query_report) {
			attach_to_report();
			detach_from_dashboard();
			detach_from_workspace();
		} else {
			detach_from_dashboard();
			detach_from_workspace();
			detach_from_report();
		}
	};

	$(document).on("page-change", function () {
		try {
			frappe.pospire_filter.setup_for_current_page();
		} catch (e) {
			console.error("pos_universal_filter: setup_for_current_page failed", e); // eslint-disable-line no-console
		}
	});
})();
