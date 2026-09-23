// Copyright (c) 2026, POSpire and contributors
// For license information, please see license.txt

// Desk form actions for POSpire Offline Sync Review.
//
// Phase 1 buttons: Retry, Void.
// Phase 2 buttons: Edit (per category), Diff, Revert, Dry-run.
//
// All buttons call whitelisted endpoints in `pospire.pospire.api.recovery`
// which enforce CAS / role / category policy server-side. This script is
// purely the manager UX shell — never trust the visibility of a button as
// a security control.

// Categories that have a structured editor server-side. Mirrors the
// CATEGORY_VALIDATORS map in recovery.py — keep these in sync. Listed
// here so we know when to show the Edit button.
//
// `customer_missing` and `customer_missing_offline` both route to the
// "customer" editor key intentionally — they're variants of the same
// problem (unresolvable customer reference) and share the same fix
// (relink to a real Customer doc + drop the offline_id link). The
// server-side `_validate_customer_edit` validator handles both; this
// map's two entries pointing at the same key isn't a duplication bug.
const EDITABLE_CATEGORIES = {
	accounting_period_closed: "accounting_period",
	customer_missing: "customer",
	customer_missing_offline: "customer", // shared with above — see header comment
	stock_shortage: "stock",
	validation_error: "field",
};

// P2-24: real-time "currently reviewing" presence.
//
// Each form open broadcasts a `presence` ping over Frappe's realtime
// layer (socket.io); other tabs viewing the SAME row receive it and
// render a small chip showing who's there. Heartbeat every 15s keeps
// the view alive; a viewer that goes silent for >45s drops off.
//
// The channel name is derived from doctype + name to keep it scoped
// per-row; cross-tab leak across rows is prevented by the channel
// filter. We use frappe.realtime.publish/subscribe directly rather
// than the higher-level frappe.realtime.on(event_name) so we can keep
// the payload compact and the handlers per-form-instance.

const PRESENCE_HEARTBEAT_MS = 15_000;
const PRESENCE_TIMEOUT_MS = 45_000;

function presenceChannel(name) {
	return `pospire_offline_sync_review_presence:${name}`;
}

function setupPresence(frm) {
	const channel = presenceChannel(frm.doc.name);
	const me = frappe.session.user;
	const peers = new Map(); // user -> { last_seen_ms, full_name }
	let heartbeatHandle = null;
	let pruneHandle = null;
	let presenceListener = null;

	function announce(kind = "viewing") {
		try {
			frappe.realtime.publish(channel, {
				kind,
				user: me,
				full_name: frappe.session.user_fullname || me,
				ts: Date.now(),
			});
		} catch (err) {
			// Older sites without realtime — silently no-op. The form
			// works without presence; the chip just doesn't show.
		}
	}

	function renderPeerChip() {
		const others = Array.from(peers.entries())
			.filter(([user]) => user !== me)
			.map(([, info]) => info.full_name || info.user || "?");
		const $existing = frm.dashboard.wrapper.find(".osr-presence-chip");
		$existing.remove();
		if (others.length === 0) return;
		const text =
			others.length === 1
				? __("{0} is viewing this entry", [others[0]])
				: __("{0} viewing this entry", [others.length]);
		const tooltip = others.join(", ");
		frm.dashboard
			.add_indicator(text, "blue")
			.addClass("osr-presence-chip")
			.attr("title", tooltip);
	}

	function onMessage(payload) {
		if (!payload || typeof payload !== "object") return;
		if (payload.user === me) return; // ignore our own echoes
		if (payload.kind === "leaving") {
			peers.delete(payload.user);
			renderPeerChip();
			return;
		}
		peers.set(payload.user, {
			last_seen_ms: Date.now(),
			full_name: payload.full_name,
			user: payload.user,
		});
		renderPeerChip();
	}

	function startup() {
		try {
			presenceListener = onMessage;
			frappe.realtime.on(channel, presenceListener);
		} catch {
			return; // realtime unavailable
		}
		announce("viewing");
		heartbeatHandle = setInterval(() => announce("viewing"), PRESENCE_HEARTBEAT_MS);
		pruneHandle = setInterval(() => {
			const cutoff = Date.now() - PRESENCE_TIMEOUT_MS;
			let dirty = false;
			for (const [user, info] of peers) {
				if (info.last_seen_ms < cutoff) {
					peers.delete(user);
					dirty = true;
				}
			}
			if (dirty) renderPeerChip();
		}, PRESENCE_HEARTBEAT_MS);
	}

	function teardown() {
		announce("leaving");
		if (heartbeatHandle) clearInterval(heartbeatHandle);
		if (pruneHandle) clearInterval(pruneHandle);
		if (presenceListener) {
			try {
				frappe.realtime.off(channel, presenceListener);
			} catch {
				/* ignore */
			}
		}
		if (beforeunloadHandler) {
			try {
				window.removeEventListener("beforeunload", beforeunloadHandler);
			} catch {
				/* ignore */
			}
		}
	}

	// Tab close / page-reload path. Without this, peers wait up to
	// PRESENCE_TIMEOUT_MS to reap the stale viewer. The handler must
	// be a NAMED ref so we can remove it on form-refresh teardown
	// (otherwise stacked refreshes would leak listeners).
	const beforeunloadHandler = () => {
		try {
			announce("leaving");
		} catch {
			/* nothing to fall back to in beforeunload */
		}
	};
	try {
		window.addEventListener("beforeunload", beforeunloadHandler);
	} catch {
		/* unsupported environment — no-op */
	}

	startup();
	// Stash on the form so a single instance reuses + cleans correctly.
	frm.__osr_presence_teardown = teardown;
}

frappe.ui.form.on("POSpire Offline Sync Review", {
	refresh(frm) {
		frm.disable_save();

		// Re-establish presence on every refresh — Frappe re-creates the
		// form view across navigation, so prior heartbeat handles get
		// orphaned. teardown ensures we don't leak intervals.
		if (frm.__osr_presence_teardown) {
			try {
				frm.__osr_presence_teardown();
			} catch {
				/* ignore */
			}
		}
		setupPresence(frm);

		const status = frm.doc.status;
		const category = frm.doc.error_category;
		const isTerminal = status === "Resolved" || status === "Voided";
		const isOpenForActions = status === "Pending Review" || status === "In Review";

		// ============ Retry ============
		if (isOpenForActions) {
			frm.add_custom_button(__("Retry"), () => onRetry(frm), null, "primary");
		}

		// ============ Edit (Phase 2-A) ============
		const editorKey = EDITABLE_CATEGORIES[category];
		if (isOpenForActions && editorKey) {
			frm.add_custom_button(__("Edit Payload"), () => {
				openEditDialog(frm, editorKey);
			});
		}

		// ============ Diff (Phase 2-B) ============
		// Only meaningful when the working payload differs from the
		// original. Compare hashes — cheaper than parsing both blobs.
		if (frm.doc.payload_hash !== frm.doc.original_payload_hash) {
			frm.add_custom_button(__("Diff"), () => {
				showDiffDialog(frm);
			});
		}

		// ============ Revert (Phase 2-B) ============
		if (isOpenForActions && frm.doc.payload_hash !== frm.doc.original_payload_hash) {
			frm.add_custom_button(__("Revert"), () => {
				openRevertDialog(frm);
			});
		}

		// ============ Dry-run (Phase 2-B) ============
		if (!isTerminal && status !== "Retrying") {
			frm.add_custom_button(__("Dry-Run Replay"), () => {
				onDryRun(frm);
			});
		}

		// ============ Void ============
		if (!isTerminal && status !== "Retrying") {
			frm.add_custom_button(__("Void"), () => {
				openVoidDialog(frm);
			});
		}

		// Status indicator pill in the form header.
		const colors = {
			"Pending Review": "orange",
			"In Review": "blue",
			Retrying: "blue",
			Resolved: "green",
			Voided: "grey",
		};
		if (colors[status]) {
			frm.page.set_indicator(status, colors[status]);
		}
	},
});

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function onRetry(frm) {
	frappe.confirm(
		__(
			"Replay this entry against the server? The original cashier ({0}) keeps attribution; you ({1}) will be recorded as the reviewer.",
			[frm.doc.cashier_user, frappe.session.user]
		),
		() => {
			frappe.call({
				method: "pospire.pospire.api.recovery.retry",
				args: { name: frm.doc.name },
				freeze: true,
				freeze_message: __("Replaying…"),
				callback: (r) => {
					const msg = r.message || {};
					if (msg.outcome === "ok") {
						frappe.show_alert({
							message: __("Resolved as {0} {1}", [
								msg.resolved_doctype,
								msg.resolved_doc_name,
							]),
							indicator: "green",
						});
					} else if (msg.outcome === "error") {
						frappe.msgprint({
							title: __("Retry failed — entry returned to Pending Review"),
							message: msg.error_detail || __("Unknown error"),
							indicator: "red",
						});
					}
					frm.reload_doc();
				},
			});
		}
	);
}

function openVoidDialog(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Void Recovery Entry"),
		fields: [
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason"),
				reqd: 1,
				description: __(
					"Required. Stored on the recovery row and the audit log. The cashier device will see this entry as voided after the next vacuum cycle."
				),
			},
		],
		primary_action_label: __("Void"),
		primary_action(values) {
			d.hide();
			frappe.call({
				method: "pospire.pospire.api.recovery.void_entry",
				args: { name: frm.doc.name, reason: values.reason },
				freeze: true,
				freeze_message: __("Voiding…"),
				callback: (r) => {
					if ((r.message || {}).outcome === "ok") {
						frappe.show_alert({
							message: __("Entry voided"),
							indicator: "orange",
						});
					}
					frm.reload_doc();
				},
			});
		},
	});
	d.show();
}

// ---------------------------------------------------------------------------
// Edit dialogs (P2-01..04)
// ---------------------------------------------------------------------------

function openEditDialog(frm, editorKey) {
	if (editorKey === "accounting_period") {
		openAccountingPeriodEditDialog(frm);
	} else if (editorKey === "customer") {
		openCustomerEditDialog(frm);
	} else if (editorKey === "stock") {
		openStockEditDialog(frm);
	} else if (editorKey === "field") {
		openFieldEditDialog(frm);
	}
}

function submitEdit(frm, patch, reason, dialogToClose) {
	frappe.call({
		method: "pospire.pospire.api.recovery.edit_payload",
		args: {
			name: frm.doc.name,
			patch: patch,
			reason: reason,
		},
		freeze: true,
		freeze_message: __("Applying edit…"),
		callback: (r) => {
			const msg = r.message || {};
			if (msg.outcome === "ok") {
				frappe.show_alert({
					message: __("Payload updated; entry now In Review."),
					indicator: "green",
				});
				if (dialogToClose) dialogToClose.hide();
			} else if (msg.outcome === "noop") {
				frappe.show_alert({
					message: __("No changes applied (idempotent edit)."),
					indicator: "blue",
				});
				if (dialogToClose) dialogToClose.hide();
			}
			frm.reload_doc();
		},
		error: (err) => {
			// Server-side validation failures land here. Frappe shows the
			// error in a default modal; we don't close the dialog so the
			// manager can correct and resubmit.
			console.warn("[recovery edit] failed", err);
		},
	});
}

// P2-01
function openAccountingPeriodEditDialog(frm) {
	let currentPostingDate = "";
	try {
		const p = JSON.parse(frm.doc.payload || "{}");
		currentPostingDate = p.posting_date || "";
	} catch {
		/* ignore */
	}
	const d = new frappe.ui.Dialog({
		title: __("Reassign Posting Date"),
		fields: [
			{
				fieldtype: "HTML",
				options: `<div class="text-muted small mb-3">${__(
					"Choose a posting date in an OPEN Accounting Period. The server will validate the period; if the chosen date is in a closed period the edit is rejected. Existing posting_date: <b>{0}</b>",
					[frappe.utils.escape_html(currentPostingDate || "—")]
				)}</div>`,
			},
			{
				fieldtype: "Date",
				fieldname: "posting_date",
				label: __("New Posting Date"),
				reqd: 1,
				default: frappe.datetime.get_today(),
			},
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason (audit log)"),
				reqd: 1,
				description: __(
					"e.g. 'Period 2026-01 was closed before this entry replayed; relinking to today's date with finance approval.'"
				),
			},
		],
		primary_action_label: __("Apply"),
		primary_action(values) {
			submitEdit(frm, { posting_date: values.posting_date }, values.reason, d);
		},
	});
	d.show();
}

// P2-02
function openCustomerEditDialog(frm) {
	let currentCustomer = "";
	try {
		const p = JSON.parse(frm.doc.payload || "{}");
		currentCustomer = p.customer || "";
	} catch {
		/* ignore */
	}
	const d = new frappe.ui.Dialog({
		title: __("Relink Customer"),
		fields: [
			{
				fieldtype: "HTML",
				options: `<div class="text-muted small mb-3">${__(
					"Pick a real customer to replace the missing offline reference. The cashier ({0}) must have read access; if they don't, the edit is rejected. Existing customer: <b>{1}</b>",
					[
						frappe.utils.escape_html(frm.doc.cashier_user),
						frappe.utils.escape_html(currentCustomer || "—"),
					]
				)}</div>`,
			},
			{
				fieldtype: "Link",
				fieldname: "customer",
				label: __("Replacement Customer"),
				options: "Customer",
				reqd: 1,
			},
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason (audit log)"),
				reqd: 1,
			},
		],
		primary_action_label: __("Apply"),
		primary_action(values) {
			submitEdit(frm, { customer: values.customer }, values.reason, d);
		},
	});
	d.show();
}

// P2-03
function openStockEditDialog(frm) {
	let cartItems = [];
	let currentSetWarehouse = "";
	try {
		const p = JSON.parse(frm.doc.payload || "{}");
		cartItems = Array.isArray(p.items) ? p.items : [];
		currentSetWarehouse = p.set_warehouse || "";
	} catch {
		/* ignore */
	}

	// Pre-populate the table grid so the manager can edit qty / warehouse
	// per line.
	const itemRows = cartItems.map((it, idx) => ({
		index: idx,
		item_code: it.item_code || "",
		current_qty: it.qty,
		current_warehouse: it.warehouse || "",
		new_qty: it.qty,
		new_warehouse: it.warehouse || "",
	}));

	const d = new frappe.ui.Dialog({
		size: "large",
		title: __("Reassign Stock"),
		fields: [
			{
				fieldtype: "HTML",
				options: `<div class="text-muted small mb-3">${__(
					"Adjust the top-level warehouse and/or per-line qty + warehouse. Stock availability is checked at retry time, not here — use Dry-Run after applying to preview."
				)}</div>`,
			},
			{
				fieldtype: "Link",
				fieldname: "warehouse",
				label: __("New Top-Level Warehouse (optional)"),
				options: "Warehouse",
				default: currentSetWarehouse,
				description: __("Leave blank to keep the queued set_warehouse unchanged."),
			},
			{
				fieldtype: "Section Break",
				label: __("Per-line Adjustments"),
			},
			{
				fieldtype: "Table",
				fieldname: "items",
				label: __("Items"),
				cannot_add_rows: true,
				cannot_delete_rows: true,
				in_place_edit: true,
				data: itemRows,
				get_data: () => itemRows,
				fields: [
					{
						fieldtype: "Int",
						fieldname: "index",
						label: __("Index"),
						in_list_view: 1,
						read_only: 1,
						columns: 1,
					},
					{
						fieldtype: "Data",
						fieldname: "item_code",
						label: __("Item"),
						in_list_view: 1,
						read_only: 1,
						columns: 2,
					},
					{
						fieldtype: "Float",
						fieldname: "current_qty",
						label: __("Old Qty"),
						in_list_view: 1,
						read_only: 1,
						columns: 1,
					},
					{
						fieldtype: "Float",
						fieldname: "new_qty",
						label: __("New Qty"),
						in_list_view: 1,
						columns: 1,
					},
					{
						fieldtype: "Link",
						fieldname: "current_warehouse",
						label: __("Old Warehouse"),
						options: "Warehouse",
						read_only: 1,
						in_list_view: 1,
						columns: 3,
					},
					{
						fieldtype: "Link",
						fieldname: "new_warehouse",
						label: __("New Warehouse"),
						options: "Warehouse",
						in_list_view: 1,
						columns: 3,
					},
				],
			},
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason (audit log)"),
				reqd: 1,
			},
		],
		primary_action_label: __("Apply"),
		primary_action(values) {
			const patch = {};
			if (values.warehouse && values.warehouse !== currentSetWarehouse) {
				patch.warehouse = values.warehouse;
			}
			const itemPatches = [];
			(values.items || []).forEach((row) => {
				const idx = row.index;
				const orig = cartItems[idx] || {};
				const ip = { index: idx };
				let included = false;
				if (
					row.new_qty !== undefined &&
					row.new_qty !== null &&
					Number(row.new_qty) !== Number(orig.qty)
				) {
					ip.qty = Number(row.new_qty);
					included = true;
				}
				if (row.new_warehouse && row.new_warehouse !== (orig.warehouse || "")) {
					ip.warehouse = row.new_warehouse;
					included = true;
				}
				if (included) itemPatches.push(ip);
			});
			if (itemPatches.length) patch.items = itemPatches;

			if (!patch.warehouse && !patch.items) {
				frappe.show_alert({
					message: __("Nothing to apply."),
					indicator: "blue",
				});
				return;
			}
			submitEdit(frm, patch, values.reason, d);
		},
	});
	d.show();
}

// P2-04
function openFieldEditDialog(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Edit a Single Top-Level Field"),
		fields: [
			{
				fieldtype: "HTML",
				options: `<div class="text-muted small mb-3">${__(
					"Targeted edit of one top-level field on the queued payload. Refuses nested paths (use a category-specific editor for those) and refuses adding new fields. Type of the new value must match the queued type."
				)}</div>`,
			},
			{
				fieldtype: "Data",
				fieldname: "field_path",
				label: __("Field Name"),
				reqd: 1,
				description: __(
					"Top-level only (no dots / no brackets). Field must already exist on the payload."
				),
			},
			{
				fieldtype: "Code",
				options: "JSON",
				fieldname: "value_json",
				label: __("New Value (JSON)"),
				reqd: 1,
				description: __(
					'JSON-encoded new value. e.g. "some-string" / 42 / true / null / {"k": "v"}.'
				),
			},
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason (audit log)"),
				reqd: 1,
			},
		],
		primary_action_label: __("Apply"),
		primary_action(values) {
			let parsed;
			try {
				parsed = JSON.parse(values.value_json);
			} catch (e) {
				frappe.msgprint({
					title: __("Invalid JSON"),
					message: __("New value must be valid JSON. Parser said: {0}", [
						String(e).slice(0, 120),
					]),
					indicator: "red",
				});
				return;
			}
			submitEdit(frm, { field_path: values.field_path, value: parsed }, values.reason, d);
		},
	});
	d.show();
}

// ---------------------------------------------------------------------------
// Diff (P2-07)
// ---------------------------------------------------------------------------

function showDiffDialog(frm) {
	let original = "(empty)";
	let working = "(empty)";
	try {
		original = JSON.stringify(JSON.parse(frm.doc.original_payload), null, 2);
	} catch {
		original = String(frm.doc.original_payload || "");
	}
	try {
		working = JSON.stringify(JSON.parse(frm.doc.payload), null, 2);
	} catch {
		working = String(frm.doc.payload || "");
	}

	const html = `
		<style>
			.osr-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-height: 65vh; }
			.osr-diff__col { display: flex; flex-direction: column; }
			.osr-diff__col h4 { font-size: 0.85rem; margin: 0 0 6px; color: #555; font-weight: 600; }
			.osr-diff__pre {
				background: var(--fg-color, #f8f9fa); border: 1px solid var(--border-color, #d4d4d4);
				padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
				font-size: 0.78rem; white-space: pre; overflow: auto; height: 100%;
				border-radius: 4px;
			}
			.osr-diff__col--working { border-left: 3px solid var(--primary, #1f6feb); padding-left: 8px; }
		</style>
		<div class="osr-diff">
			<div class="osr-diff__col">
				<h4>${__("Original (immutable)")}</h4>
				<div class="osr-diff__pre">${frappe.utils.escape_html(original)}</div>
			</div>
			<div class="osr-diff__col osr-diff__col--working">
				<h4>${__("Working (current)")}</h4>
				<div class="osr-diff__pre">${frappe.utils.escape_html(working)}</div>
			</div>
		</div>
		<div class="text-muted small mt-3">
			${__(
				"Field-level edit history is on the form's Edit History tab. This view shows the canonical JSON snapshot only."
			)}
		</div>
	`;

	const d = new frappe.ui.Dialog({
		size: "extra-large",
		title: __("Payload Diff"),
		fields: [{ fieldtype: "HTML", options: html }],
		primary_action_label: __("Close"),
		primary_action() {
			d.hide();
		},
	});
	d.show();
}

// ---------------------------------------------------------------------------
// Revert (P2-08)
// ---------------------------------------------------------------------------

function openRevertDialog(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Revert Payload to Original"),
		fields: [
			{
				fieldtype: "HTML",
				options: `<div class="text-warning small mb-3"><b>${__(
					"This discards every working-payload edit and resets to the cashier's queued payload."
				)}</b><br/>${__(
					"The reset itself is recorded as one Edit row with field_path = (payload root). Original payload remains immutable."
				)}</div>`,
			},
			{
				fieldtype: "Small Text",
				fieldname: "reason",
				label: __("Reason (audit log)"),
				reqd: 1,
			},
		],
		primary_action_label: __("Revert"),
		primary_action(values) {
			d.hide();
			frappe.call({
				method: "pospire.pospire.api.recovery.revert_to_original",
				args: { name: frm.doc.name, reason: values.reason },
				freeze: true,
				freeze_message: __("Reverting…"),
				callback: () => {
					frappe.show_alert({
						message: __("Payload reverted to original."),
						indicator: "blue",
					});
					frm.reload_doc();
				},
			});
		},
	});
	d.show();
}

// ---------------------------------------------------------------------------
// Dry-run (P2-09)
// ---------------------------------------------------------------------------

function onDryRun(frm) {
	frappe.call({
		method: "pospire.pospire.api.recovery.dry_run_replay",
		args: { name: frm.doc.name },
		freeze: true,
		freeze_message: __("Dry-running replay…"),
		callback: (r) => {
			const msg = r.message || {};
			if (msg.outcome === "ok") {
				frappe.msgprint({
					title: __("Dry-run succeeded"),
					message: __(
						"<p>Replay would resolve as <b>{0}</b> (provisional name <b>{1}</b>, docstatus {2}).</p><p>Nothing was committed — click Retry to actually apply.</p>",
						[
							msg.would_resolve_doctype || "?",
							msg.would_resolve_doc_name || "?",
							msg.would_docstatus ?? "?",
						]
					),
					indicator: "green",
				});
			} else {
				frappe.msgprint({
					title: __("Dry-run failed"),
					message: __(
						"<p>The replay would fail with category <b>{0}</b>:</p><pre>{1}</pre><p>Edit the payload, then dry-run again before clicking Retry.</p>",
						[
							msg.error_category || "unknown",
							frappe.utils.escape_html(msg.error_detail || ""),
						]
					),
					indicator: "red",
				});
			}
		},
	});
}
