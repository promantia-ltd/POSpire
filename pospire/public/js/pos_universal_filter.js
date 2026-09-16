// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt
//
// Every Dashboard Chart / Number Card in this app scopes itself to a
// company via a dynamic_filters_json condition. That condition now reads
// frappe.pospire_filter.get_company() (see pospire/fixtures/dashboard_chart.json
// and number_card.json) instead of the site's default company — so a plain
// refresh() always shows whatever's selected in this filter bar, and falls
// back to the normal site default only when nothing's been picked yet.
//
// This adds a Company + POS Profile filter bar with an explicit "Apply
// Filter" button directly under the breadcrumb of the legacy Dashboard page,
// the POSpire Workspace, and the standalone "POS Sales Trend by Terminal and
// Store" report page, and applies the chosen values on whichever of the
// three is current — refreshing every rendered chart/number-card widget on
// the first two, or driving the report's own native filters on the third —
// without touching the user's persisted default company.

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

	// Read by dashboard_chart.json / number_card.json's own dynamic_filters_json
	// (evaluated by frappe.dashboard_utils.get_all_filters) instead of the
	// stock frappe.defaults.get_user_default("Company") expression, so a
	// plain refresh() naturally picks up whatever's selected in the filter
	// bar — see the note on apply_filters() for why overriding
	// ChartWidget.filters after the fact doesn't reliably stick.
	frappe.pospire_filter.get_company = function () {
		return frappe.pospire_filter._selected.company || frappe.defaults.get_user_default("Company");
	};

	// Number Card dynamic_filters_json entries pair this with a "like" operator
	// (not "="), so an unselected POS Profile evaluates to "%" and matches every
	// row instead of filtering to field = null.
	frappe.pospire_filter.get_pos_profile = function () {
		return frappe.pospire_filter._selected.pos_profile || "%";
	};

	// Every chart / number-card widget instance is created through this
	// single funnel (frappe/public/js/frappe/widgets/widget_group.js) —
	// both the legacy Dashboard page's WidgetGroup and the Workspace's
	// SingleWidgetGroup (block.js) call it, so this one patch transparently
	// captures widgets from either page without a separate hook per page type.
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

	// ChartWidget.refresh() (chart_widget.js) is entirely fire-and-forget: it
	// kicks off `get_settings().then(() => { ...; frappe.run_serially([
	// prepare_chart_object, setup_filter_button, fetch_and_update_chart]); })`
	// but never returns that promise, and fetch_and_update_chart() itself
	// doesn't return its own `this.fetch(...).then(...)` either. For a
	// "Report"-type chart (this app's "POS Sales Trend by Terminal & Store" —
	// an actual query-report run, slower than the Group-By/Sum charts) that
	// leaves a real window, right after Apply Filter, where `this.filters`
	// (and therefore that chart's own funnel-icon "Set Filters" dialog, which
	// pre-fills from `this.filters` via `dialog.set_values()`) still holds
	// the previous company — apply_filters() below had already moved on
	// before the async chain finished.
	//
	// render() is the one call every refresh cycle reaches right before it's
	// done (chart_widget.js's fetch_and_update_chart() calls it last, after
	// data arrives) and it's shared across all chart instances via one
	// prototype, so patch it once, here, off the first chart widget seen —
	// resolving a promise this file plants on the instance right before
	// calling refresh() lets apply_filters() actually await completion.
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

	// ChartWidget.set_chart_filters() (frappe/public/js/frappe/widgets/chart_widget.js)
	// resolves filters in this priority order:
	//   this.filters = chart_settings.filters || this.filters || chart_saved_filters
	// Two things can each independently pin a chart to a stale company,
	// both of which have to be cleared before every refresh:
	//   1. `this.filters` — once set on the first render, it wins on every
	//      later refresh() forever, so the freshly-evaluated
	//      dynamic_filters_json (chart_saved_filters, which now reads
	//      frappe.pospire_filter.get_company() — see dashboard_chart.json /
	//      number_card.json) never gets a second chance to run.
	//   2. `chart_settings.filters` — a PER-USER, SERVER-PERSISTED override.
	//      Opening a chart's own funnel-icon filter popup calls
	//      save_chart_config_for_user({filters: ...}), freezing whatever
	//      company was active at that moment into the "Dashboard Settings"
	//      doctype for that user+chart, permanently — it outranks
	//      everything else, including chart_saved_filters, on every future
	//      load regardless of what this filter bar does. (A stale copy of
	//      exactly this was found and cleaned up server-side while building
	//      this feature; without clearing chart_settings.filters here too,
	//      the same thing would silently reappear the next time anyone
	//      touches that funnel icon.)
	// NumberCardWidget doesn't have either problem — get_filters() always
	// re-derives straight from card_doc, no cached instance property.
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
				// setup_filter_button() (chart_widget.js) unconditionally does
				// `this.filters = this.filter_group.get_filters()` whenever
				// filter_group already exists — clobbering the freshly-evaluated
				// dynamic_filters_json back to whatever was in the filter-group
				// UI from the chart's very first render. Dropping filter_group
				// here forces create_filter_group_and_add_filters() to rebuild
				// it from the new this.filters instead of overwriting it.
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

	// This site's "dashboard-view" route does NOT use the modern
	// frappe.views.DashboardView class — it's a legacy, database-stored
	// standard "Page" doctype record (module "Core", left over from an old
	// Frappe version) whose own script builds a private `class Dashboard`
	// and exposes the live instance as the global `frappe.dashboard`. That
	// class's constructor does `this.wrapper.find(".page-content").empty()`
	// right after Frappe builds the page's standard toolbar — which detaches
	// page.page_form from the document (it still exists as a JS object, so
	// page.add_field() "succeeds" with no error, but nothing ever appears).
	// So instead of the page toolbar, this builds its own row (see
	// attach_to_dashboard()/attach_to_workspace() below for exactly where
	// each page inserts it) with all three controls together in one row.
	// only_input left at its default (false) so each control renders the
	// standard label + input-wrapper markup (base_input.js make_wrapper()) —
	// with only_input:true the label is never created at all (see
	// base_input.js's only_input branches on make_wrapper/set_input_areas/
	// set_label), which is why the bar previously showed unlabeled boxes of
	// mismatched height next to the button.
	function make_link_control(df, $parent) {
		const f = frappe.ui.form.make_control({ df, parent: $parent });
		f.refresh();
		if (!f.$input) f.make_input();
		// Bootstrap's .form-group (base_input.js's non-only_input wrapper)
		// carries its own margin-bottom. As a flex item that's part of this
		// control's own box height (flex items don't collapse margins with
		// their children), so align-items:flex-end on the bar was aligning to
		// that invisible extra space below the input, not the input itself —
		// which is why the Apply Filter button (no such margin) sat visibly
		// lower than the two fields.
		f.$wrapper.find(".form-group").css("margin-bottom", 0);
		return f;
	}

	// `on_apply(company, pos_profile)` is the one thing that differs per
	// page: Dashboard/Workspace refresh the widget registry (apply_filters()
	// above); the standalone report instead needs to drive its own native
	// filter fields directly (see attach_to_report()). May return a promise —
	// the click handler below awaits it either way.
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

		// POS Profile is scoped 1:1 to a Company — get_query above already
		// restricts the dropdown to the newly selected company, but a value
		// picked under the previous company is never re-validated on its own,
		// so it would otherwise sit there stale once the company changes to
		// one with no matching (or a different) profile.
		//
		// `df.onchange` (what a standalone Link control appears built for
		// this) does NOT reliably fire here: link.js routes every selection
		// through validate_link_and_fetch(), an async server round trip, and
		// only once that resolves does base_control.js's validate_and_set_in_model
		// reach the `df.onchange` step — in practice this control never got
		// there. Binding straight to the events Awesomplete/the input itself
		// emit sidesteps that chain entirely.
		let last_company_value = null;
		function clear_pos_profile_if_company_changed() {
			const current = company_field.get_value();
			if (current !== last_company_value) {
				last_company_value = current;
				pos_profile_field.set_value("");
			}
		}
		company_field.$input.on("awesomplete-select change blur", clear_pos_profile_if_company_changed);

		const $apply_btn = $bar.find(".pospire-filter-apply");
		$apply_btn.on("click", async () => {
			const company = company_field.get_value();
			if (!company) {
				frappe.show_alert({ message: __("Select a Company first"), indicator: "orange" });
				return;
			}
			// Disabled + relabeled until every widget's refresh (including the
			// slower "Report"-type chart's actual query-report run) has
			// genuinely completed — otherwise a quick click into that chart's
			// own funnel-icon dialog right after Apply Filter can still catch
			// `this.filters` mid-update and show the previous company.
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
			// dashboard_view.js's Dashboard constructor wraps the widget area
			// in `<div class="dashboard" style="margin: var(--margin-md)">`
			// (this.container, i.e. .dashboard-graph, is the only child that
			// gets emptied/re-rendered on refresh — the outer .dashboard wrapper
			// persists). Prepending into .page-content directly (this bar's
			// former parent) put it outside that margin, flush with the page
			// edges, while the actual widget cards sit inset by var(--margin-md)
			// — hence the bar looking un-aligned with the cards below it.
			// Prepending as a sibling of .dashboard-graph instead makes it
			// inherit the exact same left/right inset for free.
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
			// workspace.js's prepare_container() builds `this.body` (the
			// .layout-main-section) and appends .editor-js-container into it
			// exactly once per session — every later show_page() reuses both
			// and just re-renders the EditorJS blocks inside them
			// (this.editor.render({blocks: ...}), see prepare_editorjs()).
			// So prepending into this.body, same as the Dashboard page's
			// dashboard.container.parent(), gives a stable insertion point
			// that survives switching between workspaces without needing to
			// wait on editor-render timing.
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
			// This report has no built-in POS Profile filter/support of its own
			// (pos_sales_trend_by_terminal_and_store.js/.py) — both were given
			// one specifically so this bar's selection has somewhere real to
			// land, the same way dynamic_filters_json gives the Dashboard's
			// charts/cards one. set_filter_value() sets the report's own native
			// fields and triggers its normal refresh chain — there's no widget
			// registry involved here, unlike Dashboard/Workspace.
			const bar = build_dashboard_bar((company, pos_profile) =>
				report.set_filter_value({ company, pos_profile: pos_profile || "" })
			);
			// setup_report_wrapper() (query_report.js) guards itself with
			// `if (this.$report) return;` — this.page.main and everything
			// appended to it (the native filter row included) is built once
			// per session and reused across every report shown on this same
			// "query-report" route, not recreated per report switch. So
			// prepending here, above that native filter row, is safe long-term
			// as long as we detach (hide) whenever a different report is open.
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
			(route[1] === WORKSPACE_NAME || (route[1] === "private" && route[2] === WORKSPACE_NAME))
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

	// Any failure below must never break the Dashboard/Workspace page's own
	// rendering (charts, cards) — this feature is additive. page-change fires
	// on every route render, including workspace-to-workspace switches that
	// stay within the same "Workspaces" page shell (frappe/public/js/frappe/
	// views/container.js's change_to()), so this one binding covers both.
	$(document).on("page-change", function () {
		try {
			frappe.pospire_filter.setup_for_current_page();
		} catch (e) {
			console.error("pos_universal_filter: setup_for_current_page failed", e); // eslint-disable-line no-console
		}
	});
})();
