"""
Rollback: remove the offline idempotency custom fields added by
`pospire.patches.*.add_offline_fields` (see [docs/offline/12-server-side-changes.md](../../docs/offline/12-server-side-changes.md) §1).

WHEN TO RUN THIS
----------------
Only under a kill-switch-driven rollback (see D-29 in
[docs/offline/15-decision-log.md](../../docs/offline/15-decision-log.md)):

1. Ops has flipped the system-wide `pospire_offline_enabled` setting to False.
2. No client is actively syncing a queued offline transaction — verified by
   checking that the outbox on every enrolled device is drained OR by
   accepting the loss documented in §6 below.
3. A product / engineering decision has been made to abandon the offline
   deployment entirely, not merely pause it. A paused deployment needs the
   kill switch, NOT this patch — kill-switch preserves unsynced data for
   resumption; this patch discards it.

This is a **destructive** migration. It drops the `pos_offline_id` unique
indexes and deletes the Custom Field records. Any Sales Invoice / POS
Opening Entry / POS Closing Entry / Stock Entry / Customer rows that carry
`pos_offline_id` values lose those values on the next `bench migrate`
because the column is dropped via Frappe's Custom-Field-removal path.

If there is ANY chance the offline feature will be re-enabled within the
same site's lifetime, DO NOT run this patch. The kill switch alone is
sufficient; the fields can stay in place indefinitely with no side
effects to online flows.

This patch is registered in `patches.txt` under `[post_model_sync]` as a
commented-out line — `bench migrate` will not run it automatically.
Invoke manually via `bench --site <site> execute pospire.patches.remove_offline_fields.execute`
after the kill-switch and drain-verification steps above.

Follows v16 conventions per `CLAUDE.md`:
- No `frappe.db.commit()` inside this patch (`execute()` is a Frappe
  migration context — the framework commits after the patch returns
  successfully; explicit commits here are disallowed).
- Uses the authoritative v16 helper `frappe.delete_doc("Custom Field", ...)`
  to trigger cache invalidation and column removal rather than raw SQL.
- Respects `order_by="modified desc"` on any list read (none needed here).
"""

import frappe

# Mapping of DocType → list of Custom Field fieldnames to remove.
# Sourced from [docs/offline/12-server-side-changes.md](../../docs/offline/12-server-side-changes.md) §1.
_FIELDS_TO_REMOVE: dict[str, list[str]] = {
	"Sales Invoice": [
		"pos_offline_id",
		"pos_device_id",
		"pos_opening_shift_offline_id",
		"pos_material_receipt_offline_ids",
	],
	"POS Opening Entry": [
		"pos_offline_id",
		"pos_device_id",
	],
	"POS Closing Entry": [
		"pos_offline_id",
		"pos_device_id",
		"variance_at_close",
		"variance_at_sync",
	],
	"Stock Entry": [
		"pos_offline_id",
		"pos_device_id",
	],
	"Customer": [
		"pos_offline_id",
	],
}


def execute() -> None:
	"""Delete offline Custom Fields. Idempotent — safe to re-run."""
	deleted: list[str] = []
	skipped: list[str] = []

	for doctype, fieldnames in _FIELDS_TO_REMOVE.items():
		for fieldname in fieldnames:
			custom_field_name = f"{doctype}-{fieldname}"
			if frappe.db.exists("Custom Field", custom_field_name):
				# `frappe.delete_doc` on a Custom Field drops the underlying
				# column and clears doctype cache. No raw SQL needed.
				frappe.delete_doc(
					"Custom Field",
					custom_field_name,
					ignore_permissions=True,
					force=True,
				)
				deleted.append(custom_field_name)
			else:
				skipped.append(custom_field_name)

		# Clear doctype meta cache so downstream code no longer sees the
		# dropped columns (v16 keeps a nested defaultdict — see CLAUDE.md).
		frappe.clear_cache(doctype=doctype)

	frappe.logger("pospire.offline.rollback").info(
		{
			"event": "remove_offline_fields.executed",
			"deleted": deleted,
			"skipped_missing": skipped,
		}
	)

	# NOTE: we do NOT drop the `POS Offline Recovery Log` or
	# `POS Offline Deletion Event` DocTypes if they exist — those carry
	# audit records and removing them is a separate, explicit decision.
	# A future follow-up patch should handle them if the product team
	# confirms the audit trail is no longer required.
