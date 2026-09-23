// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt

// List view customisations for POSpire Offline Sync Review.
//
//   P2-10/11/12 : dashboard cards above the list (totals, oldest pending,
//                 SLA breaches per outlet, category breakdown).
//   P2-13/14    : bulk Retry / Void toolbar buttons activated by row selection.
//   P2-15       : operational presets (saved filters) the manager can click
//                 to scope the list quickly.

const PRESETS = [
	{
		label: __("All Pending Review"),
		filters: { status: "Pending Review" },
		description: __(
			"Every entry currently waiting for a manager (any cashier, any reviewer). Sort by oldest first via the column header."
		),
	},
	{
		// Reviewer-scoped: shows entries this manager has touched (clicked
		// Retry, edited, etc — those write reviewer_user). Different from
		// "All Pending Review" — useful when handing off mid-shift.
		label: __("Assigned to me"),
		filters: {
			reviewer_user: frappe.session.user,
			status: ["in", ["Pending Review", "In Review"]],
		},
		description: __(
			"Entries you've already acted on (Retry / Edit set the reviewer). For a fresh look at unassigned work, use 'All Pending Review'."
		),
	},
	{
		label: __("In Review (mid-edit)"),
		filters: { status: "In Review" },
		description: __(
			"Entries another manager has started editing. Coordinate before retrying these."
		),
	},
	{
		label: __("Stuck Retrying"),
		filters: { status: "Retrying" },
		description: __(
			"Should normally clear within seconds. Anything here for >5 min likely means a crashed retry — see runbook §3.3."
		),
	},
	{
		label: __("Permission errors only"),
		filters: { status: "Pending Review", error_category: "permission_error" },
		description: __("Cashier role config issues. Not editable — fix the role, then retry."),
	},
	{
		label: __("Accounting period closed"),
		filters: {
			status: "Pending Review",
			error_category: "accounting_period_closed",
		},
		description: __(
			"System Manager only — needs finance approval to reopen the period or relink to a current date."
		),
	},
	{
		label: __("High-attempt entries"),
		filters: { status: "Pending Review", attempt_count: [">=", 5] },
		description: __(
			"Per runbook §5: 5+ attempts hitting the same error means we're not making progress. Likely a Void candidate."
		),
	},
];

frappe.listview_settings["POSpire Offline Sync Review"] = {
	add_fields: ["error_category", "attempt_count", "cashier_user"],

	hide_name_column: false,

	get_indicator(doc) {
		const map = {
			"Pending Review": ["Pending Review", "orange", "status,=,Pending Review"],
			"In Review": ["In Review", "blue", "status,=,In Review"],
			Retrying: ["Retrying", "blue", "status,=,Retrying"],
			Resolved: ["Resolved", "green", "status,=,Resolved"],
			Voided: ["Voided", "grey", "status,=,Voided"],
		};
		return map[doc.status];
	},

	onload(listview) {
		// ============ P2-15: operational presets ============
		PRESETS.forEach((preset) => {
			listview.page.add_menu_item(
				preset.label,
				() => {
					listview.filter_area.clear();
					Object.entries(preset.filters).forEach(([field, value]) => {
						if (Array.isArray(value)) {
							listview.filter_area.add(listview.doctype, field, value[0], value[1]);
						} else {
							listview.filter_area.add(listview.doctype, field, "=", value);
						}
					});
					listview.refresh();
					if (preset.description) {
						frappe.show_alert({
							message: preset.description,
							indicator: "blue",
						});
					}
				},
				false /* not standard menu */
			);
		});

		// ============ P2-13/14: bulk action toolbar ============
		// Frappe's listview exposes bulk actions via `add_bulk_action`-
		// style hooks. We add two buttons that only enable when at least
		// one row is selected; the list framework wires that for us.

		listview.page.add_action_item(__("Bulk Retry"), () => {
			const selected = (listview.get_checked_items() || []).map((d) => d.name);
			if (!selected.length) {
				frappe.show_alert({
					message: __("Select at least one entry to bulk-retry."),
					indicator: "orange",
				});
				return;
			}
			if (selected.length > 50) {
				frappe.show_alert({
					message: __(
						"Bulk retry caps at 50 per call. Selection is {0} — split into smaller batches.",
						[selected.length]
					),
					indicator: "orange",
				});
				return;
			}
			frappe.confirm(
				__(
					"Replay {0} selected entr{1}? Each one runs through the same single-retry path with its own CAS lock + audit row. Already-terminal rows will be skipped with an error result.",
					[selected.length, selected.length === 1 ? "y" : "ies"]
				),
				() => {
					frappe.call({
						method: "pospire.pospire.api.recovery.bulk_retry",
						args: { names: selected },
						freeze: true,
						freeze_message: __("Replaying {0} entries…", [selected.length]),
						callback: (r) => {
							const summary = (r.message || {}).summary || {};
							frappe.msgprint({
								title: __("Bulk retry complete"),
								message: __(
									"<p>{0}/{1} resolved successfully. {2} failed (back to Pending Review with updated error).</p><p>See each row's Activity tab for per-row outcomes.</p>",
									[summary.ok, summary.total, summary.error]
								),
								indicator: summary.error === 0 ? "green" : "orange",
							});
							listview.refresh();
						},
					});
				}
			);
		});

		listview.page.add_action_item(__("Bulk Void"), () => {
			const selected = (listview.get_checked_items() || []).map((d) => d.name);
			if (!selected.length) {
				frappe.show_alert({
					message: __("Select at least one entry to bulk-void."),
					indicator: "orange",
				});
				return;
			}
			if (selected.length > 100) {
				frappe.show_alert({
					message: __(
						"Bulk void caps at 100 per call. Selection is {0} — split into smaller batches.",
						[selected.length]
					),
					indicator: "orange",
				});
				return;
			}
			const d = new frappe.ui.Dialog({
				title: __("Bulk Void {0} Entries", [selected.length]),
				fields: [
					{
						fieldtype: "Small Text",
						fieldname: "reason",
						label: __("Shared Reason"),
						reqd: 1,
						description: __(
							"Required. Stored as reviewer_notes on every selected row + as the void Activity row's detail."
						),
					},
				],
				primary_action_label: __("Void All"),
				primary_action(values) {
					d.hide();
					frappe.call({
						method: "pospire.pospire.api.recovery.bulk_void",
						args: { names: selected, reason: values.reason },
						freeze: true,
						freeze_message: __("Voiding {0} entries…", [selected.length]),
						callback: (r) => {
							const summary = (r.message || {}).summary || {};
							frappe.msgprint({
								title: __("Bulk void complete"),
								message: __(
									"<p>{0}/{1} voided. {2} skipped (already terminal or invalid state).</p>",
									[summary.ok, summary.total, summary.error]
								),
								indicator: summary.error === 0 ? "orange" : "red",
							});
							listview.refresh();
						},
					});
				},
			});
			d.show();
		});

		// ============ P2-10/11/12: dashboard cards ============
		// We render a compact summary above the list rows. Refreshes on
		// every list refresh (cheap server-side) so the numbers track
		// the actions the manager just took.
		const $page = listview.page.main;
		const $summary = $(`
			<div class="osr-dashboard">
				<style>
					.osr-dashboard { display: grid; gap: 12px; margin: 8px 0 16px;
						grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
					.osr-card { background: var(--card-bg, #fff); border: 1px solid
						var(--border-color, #e0e0e0); border-radius: 8px; padding: 12px 14px; }
					.osr-card__label { font-size: 0.72rem; text-transform: uppercase;
						letter-spacing: 0.5px; color: var(--text-muted, #6b7280); }
					.osr-card__value { font-size: 1.5rem; font-weight: 600; line-height: 1.2;
						margin-top: 4px; }
					.osr-card__sub { font-size: 0.78rem; color: var(--text-muted, #6b7280);
						margin-top: 4px; }
					.osr-card--alert { border-color: var(--red-300, #fca5a5);
						background: var(--red-50, #fef2f2); }
					.osr-card--info { border-color: var(--blue-300, #93c5fd); }
					.osr-card--ok { border-color: var(--green-300, #86efac); }
				</style>
			</div>
		`);
		$page.find(".osr-dashboard").remove();
		$page.find(".layout-main-section, .layout-main").first().prepend($summary);

		const renderDashboard = () => {
			frappe.call({
				method: "pospire.pospire.api.recovery.dashboard_summary",
				args: { window_days: 7 },
				callback: (r) => {
					const data = r.message || {};
					const totals = data.totals || {};
					const slaBreaches = (data.by_outlet || []).filter(
						(o) => o.sla_breached
					).length;
					const oldest = (data.oldest_pending || [])[0];
					const oldestMin = oldest ? oldest.age_minutes : 0;
					const trend = data.trends || [];
					// Last day's pivot
					const lastDay = trend[trend.length - 1] || { ok: 0, error: 0 };

					$summary.html(`
						<div class="osr-card osr-card--info">
							<div class="osr-card__label">${__("Pending Review")}</div>
							<div class="osr-card__value">${totals["Pending Review"] || 0}</div>
							<div class="osr-card__sub">${__("In Review: {0} · Retrying: {1}", [
								totals["In Review"] || 0,
								totals["Retrying"] || 0,
							])}</div>
						</div>
						<div class="osr-card ${slaBreaches > 0 ? "osr-card--alert" : ""}">
							<div class="osr-card__label">${__("SLA Breaches")}</div>
							<div class="osr-card__value">${slaBreaches}</div>
							<div class="osr-card__sub">${__("outlets with oldest > 4h")}</div>
						</div>
						<div class="osr-card ${oldestMin > 240 ? "osr-card--alert" : ""}">
							<div class="osr-card__label">${__("Oldest Pending")}</div>
							<div class="osr-card__value">${formatAge(oldestMin)}</div>
							<div class="osr-card__sub">${
								oldest
									? frappe.utils.escape_html(
											oldest.category + " · " + (oldest.cashier || "?")
									  )
									: __("queue empty")
							}</div>
						</div>
						<div class="osr-card osr-card--ok">
							<div class="osr-card__label">${__("Today's retries")}</div>
							<div class="osr-card__value">${lastDay.ok || 0}<span class="text-muted small">/${
						(lastDay.ok || 0) + (lastDay.error || 0)
					}</span></div>
							<div class="osr-card__sub">${__("ok / total · last 7d window")}</div>
							${renderTrendSparkline(trend)}
						</div>
						<div class="osr-card">
							<div class="osr-card__label">${__("Categories Pending")}</div>
							<div class="osr-card__value">${(data.by_category || []).length}</div>
							<div class="osr-card__sub">${__("distinct error categories")}</div>
						</div>
						<div class="osr-card">
							<div class="osr-card__label">${__("Resolved (window)")}</div>
							<div class="osr-card__value">${totals.Resolved || 0}</div>
							<div class="osr-card__sub">${__("Voided: {0}", [totals.Voided || 0])}</div>
						</div>
					`);
				},
			});
		};

		// Re-fetch the dashboard once on first render and on every list
		// refresh (after bulk action / preset apply).
		listview.dashboard_render = renderDashboard;
		const origRefresh = listview.refresh.bind(listview);
		listview.refresh = function (...args) {
			const ret = origRefresh(...args);
			renderDashboard();
			return ret;
		};
		renderDashboard();
	},
};

function formatAge(minutes) {
	if (!minutes) return "—";
	if (minutes < 60) return `${minutes}m`;
	const hr = Math.floor(minutes / 60);
	if (hr < 24) return `${hr}h ${minutes % 60}m`;
	const d = Math.floor(hr / 24);
	return `${d}d ${hr % 24}h`;
}

// P2-20: tiny stacked-bar sparkline. One bar per day in the trend
// window, green for retry ok / red for retry error. Renders as inline
// SVG so it lives entirely inside the dashboard card without pulling
// a chart lib. Empty days show as a faint grey baseline tick.
function renderTrendSparkline(trend) {
	if (!Array.isArray(trend) || trend.length === 0) return "";
	const W = 120;
	const H = 32;
	const barWidth = Math.max(2, Math.floor((W - trend.length) / trend.length));
	const maxTotal = Math.max(1, ...trend.map((t) => (t.ok || 0) + (t.error || 0)));
	const bars = trend
		.map((t, i) => {
			const x = i * (barWidth + 1);
			const okH = ((t.ok || 0) / maxTotal) * H;
			const errH = ((t.error || 0) / maxTotal) * H;
			const okY = H - okH;
			const errY = H - okH - errH;
			const baseTick =
				okH + errH < 1
					? `<rect x="${x}" y="${
							H - 1
					  }" width="${barWidth}" height="1" fill="#9ca3af" />`
					: "";
			return `
				${baseTick}
				<rect x="${x}" y="${okY}" width="${barWidth}" height="${okH}" fill="#16a34a" />
				<rect x="${x}" y="${errY}" width="${barWidth}" height="${errH}" fill="#dc2626" />
			`;
		})
		.join("");
	return `
		<svg viewBox="0 0 ${
			trend.length * (barWidth + 1)
		} ${H}" width="100%" height="32" preserveAspectRatio="none" style="margin-top: 6px; display:block;">
			${bars}
		</svg>
	`;
}
