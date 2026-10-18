# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Read-only RCA evidence bundle.

`get_rca_bundle` gathers everything needed to debug one POSpire incident
(or the fleet) into a single JSON payload: the documents an offline_id
became, Offline Sync Review rows with their activity trail, device beacons,
matching Error Log rows (including client events shipped via `log_batch`),
failed scheduled jobs, and matching bench log lines.

Access: System Manager or the `POSpire RCA Reader` role. The RCA role is
meant for a dedicated API-key user so tooling can pull evidence from
production over REST without shell or DB access. Every query here is a
SELECT — nothing is written.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import timedelta
from typing import Any

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, get_bench_path, get_datetime, now_datetime

RCA_ROLE = "POSpire RCA Reader"
_ALLOWED_ROLES = frozenset({RCA_ROLE, "System Manager"})

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_TRUNC = 3000
_MAX_WINDOW_DAYS = 31
_LOG_FILES = ("frappe.log", "worker.error.log", "worker.log", "web.error.log", "scheduler.log")
_LOG_TAIL_BYTES = 5 * 1024 * 1024
_LOG_LINE_CAP = 200

_OFFLINE_ID_DOCTYPES = (
	"Sales Invoice",
	"Customer",
	"Stock Entry",
	"POS Opening Shift",
	"POS Closing Shift",
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@frappe.whitelist(methods=["GET", "POST"])
@rate_limit(limit=30, seconds=60)
def get_rca_bundle(
	offline_id: str | None = None,
	invoice: str | None = None,
	review: str | None = None,
	device_id: str | None = None,
	user: str | None = None,
	shift: str | None = None,
	since: str | None = None,
	until: str | None = None,
	fleet: int | str = 0,
	include_logs: int | str = 1,
) -> dict[str, Any]:
	"""Return the RCA evidence bundle. See module docstring."""
	_assert_rca_access()
	_validate_identifiers(offline_id, invoice, review, device_id, user, shift)
	frappe.logger("pospire.rca").info(
		{
			"event": "get_rca_bundle",
			"by": frappe.session.user,
			"offline_id": offline_id,
			"invoice": invoice,
			"review": review,
			"device_id": device_id,
			"user": user,
			"shift": shift,
			"fleet": cint(fleet),
		}
	)
	return build_rca_bundle(
		offline_id=offline_id,
		invoice=invoice,
		review=review,
		device_id=device_id,
		user=user,
		shift=shift,
		since=since,
		until=until,
		fleet=bool(cint(fleet)),
		include_logs=bool(cint(include_logs)),
		# This site's logs only — the bench logs dir is shared by every site.
		logs_dir=frappe.get_site_path("logs"),
	)


def build_rca_bundle(
	*,
	offline_id: str | None = None,
	invoice: str | None = None,
	review: str | None = None,
	device_id: str | None = None,
	user: str | None = None,
	shift: str | None = None,
	since: str | None = None,
	until: str | None = None,
	fleet: bool = False,
	include_logs: bool = True,
	logs_dir: str | None = None,
) -> dict[str, Any]:
	"""Build the bundle without the access gate (bench console / scripts)."""
	until_dt = get_datetime(until) if until else now_datetime()
	since_dt = get_datetime(since) if since else until_dt - timedelta(hours=24)
	if since_dt > until_dt:
		frappe.throw(_("`since` must be before `until`"))
	if until_dt - since_dt > timedelta(days=_MAX_WINDOW_DAYS):
		since_dt = until_dt - timedelta(days=_MAX_WINDOW_DAYS)

	ids: dict[str, set[str]] = {
		k: set() for k in ("offline_id", "device_id", "user", "shift", "docname")
	}
	_add(ids, "offline_id", offline_id)
	_add(ids, "device_id", device_id)
	_add(ids, "user", user)
	_add(ids, "shift", shift)
	_add(ids, "docname", invoice)
	_add(ids, "docname", review)

	bundle: dict[str, Any] = {
		"generated_at": str(now_datetime()),
		"site": frappe.local.site,
		"window": [str(since_dt), str(until_dt)],
		"server": _server_info(),
	}

	if fleet:
		bundle["fleet"] = _fleet(since_dt)
	else:
		if not any(ids.values()):
			frappe.throw(
				_("Pass at least one of offline_id, invoice, review, device_id, user, shift — or fleet=1")
			)
		bundle["documents"] = _resolve_ids(ids, invoice, review, shift)
		bundle["sync_reviews"] = _sync_reviews(ids, since_dt)
		# Review rows can reveal more devices / users; widen before the rest.
		for row in bundle["sync_reviews"]:
			_add(ids, "device_id", row["device_id"])
			_add(ids, "user", row["cashier_user"])
		bundle["beacons"] = _beacons(ids, since_dt, until_dt)
		bundle["error_logs"] = _error_logs(ids, since_dt, until_dt)
		bundle["scheduler_failures"] = _scheduler_failures(since_dt, until_dt)
		if include_logs:
			bundle["log_file_hits"] = _log_file_hits(logs_dir or os.path.join(get_bench_path(), "logs"), ids)

	bundle["identifiers"] = {k: sorted(v) for k, v in ids.items()}
	return bundle


def ensure_rca_role() -> None:
	"""Create the RCA reader role if missing. Called from install hooks."""
	if frappe.db.exists("Role", RCA_ROLE):
		return
	frappe.get_doc(
		{
			"doctype": "Role",
			"role_name": RCA_ROLE,
			"desk_access": 0,
			"description": "Read-only access to POSpire RCA evidence via "
			"pospire.pospire.api.diagnostics.get_rca_bundle.",
		}
	).insert(ignore_permissions=True)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _assert_rca_access() -> None:
	if frappe.session.user == "Administrator":
		return
	if not _ALLOWED_ROLES.intersection(frappe.get_roles()):
		frappe.throw(_("Not permitted to read RCA diagnostics"), frappe.PermissionError)


def _validate_identifiers(
	offline_id: str | None,
	invoice: str | None,
	review: str | None,
	device_id: str | None,
	user: str | None,
	shift: str | None,
) -> None:
	"""Identifiers become substring needles for Error Log and log-file search.
	Accept only well-formed UUIDs and names of existing records, so a caller
	cannot turn the endpoint into a free-text grep of server logs."""
	for label, value in (("offline_id", offline_id), ("device_id", device_id)):
		if value and not _UUID_RE.match(value):
			frappe.throw(_("{0} must be a UUID").format(label))
	for label, doctype, value in (
		("invoice", "Sales Invoice", invoice),
		("review", "POSpire Offline Sync Review", review),
		("shift", "POS Opening Shift", shift),
		("user", "User", user),
	):
		if value and not frappe.db.exists(doctype, value):
			frappe.throw(_("{0} {1} not found").format(label, value), frappe.DoesNotExistError)


def _add(ids: dict[str, set[str]], key: str, value: Any) -> None:
	if value:
		ids[key].add(str(value))


def _trunc(value: Any, n: int = _TRUNC) -> Any:
	if isinstance(value, str) and len(value) > n:
		return value[:n] + f"... [truncated {len(value) - n} chars]"
	return value


def _has_column(doctype: str, column: str) -> bool:
	try:
		return frappe.db.has_column(doctype, column)
	except Exception:
		return False


def _server_info() -> dict[str, Any]:
	version = str(frappe.get_attr("pospire.__version__") or "0")
	try:
		offline_enabled = cint(frappe.db.get_single_value("POSpire Offline Settings", "enabled"))
	except Exception:
		offline_enabled = None
	return {
		"pospire_version": version,
		# Mirrors offline._server_build_hash().
		"server_build_hash": hashlib.sha1(version.encode("utf-8")).hexdigest()[:12],
		"offline_enabled": offline_enabled,
		"frappe_version": frappe.__version__,
	}


def _resolve_ids(
	ids: dict[str, set[str]], invoice: str | None, review: str | None, shift: str | None
) -> list[dict[str, Any]]:
	"""Expand the given identifiers into offline_ids / devices / users / shifts."""
	docs: list[dict[str, Any]] = []

	if invoice:
		fields = ["name", "docstatus", "status", "posting_date", "owner", "creation", "modified",
			"grand_total", "is_return", "pos_profile"]
		fields += [
			c for c in ("pos_offline_id", "pos_device_id", "pos_opening_shift_offline_id", "posa_pos_opening_shift")
			if _has_column("Sales Invoice", c)
		]
		row = frappe.db.get_value("Sales Invoice", invoice, fields, as_dict=True)
		if row:
			docs.append({"doctype": "Sales Invoice", **row})
			_add(ids, "offline_id", row.get("pos_offline_id"))
			_add(ids, "device_id", row.get("pos_device_id"))
			_add(ids, "user", row.get("owner"))
			_add(ids, "shift", row.get("posa_pos_opening_shift"))
			_add(ids, "offline_id", row.get("pos_opening_shift_offline_id"))

	if review:
		row = frappe.db.get_value("POSpire Offline Sync Review", review,
			["offline_id", "device_id", "cashier_user", "shift_offline_id"], as_dict=True)
		if row:
			_add(ids, "offline_id", row.offline_id)
			_add(ids, "device_id", row.device_id)
			_add(ids, "user", row.cashier_user)
			_add(ids, "offline_id", row.shift_offline_id)

	if shift:
		fields = ["name", "user", "status", "docstatus", "period_start_date", "period_end_date",
			"pos_profile", "pos_closing_shift"]
		fields += [c for c in ("pos_offline_id", "pos_device_id") if _has_column("POS Opening Shift", c)]
		row = frappe.db.get_value("POS Opening Shift", shift, fields, as_dict=True)
		if row:
			docs.append({"doctype": "POS Opening Shift", **row})
			_add(ids, "user", row.get("user"))
			_add(ids, "device_id", row.get("pos_device_id"))
			_add(ids, "offline_id", row.get("pos_offline_id"))

	# Any offline_id → the server doc(s) it became. More than one = idempotency break.
	for oid in sorted(ids["offline_id"]):
		for doctype in _OFFLINE_ID_DOCTYPES:
			if not _has_column(doctype, "pos_offline_id"):
				continue
			for r in frappe.get_all(doctype, filters={"pos_offline_id": oid},
					fields=["name", "docstatus", "owner", "creation", "modified"], limit=5):
				docs.append({"doctype": doctype, "pos_offline_id": oid, **r})
	return docs


def _sync_reviews(ids: dict[str, set[str]], since) -> list[dict[str, Any]]:
	doctype = "POSpire Offline Sync Review"
	names: list[str] = []
	# Rows named explicitly (offline_id / review name) are returned whatever
	# their age — the incident may be weeks old. Device / user matches are
	# windowed, or a busy cashier would return every review ever filed.
	if ids["offline_id"]:
		names += frappe.get_all(doctype, or_filters=[
			["offline_id", "in", sorted(ids["offline_id"])],
			["shift_offline_id", "in", sorted(ids["offline_id"])],
		], pluck="name", limit=50)
	if ids["docname"]:
		names += frappe.get_all(doctype, filters={"name": ["in", sorted(ids["docname"])]}, pluck="name")
	ors = []
	if ids["device_id"]:
		ors.append(["device_id", "in", sorted(ids["device_id"])])
	if ids["user"]:
		ors.append(["cashier_user", "in", sorted(ids["user"])])
	if ors:
		names += frappe.get_all(doctype, or_filters=ors,
			filters=[["modified", ">=", since]], pluck="name", limit=50)
	names = sorted(set(names))[:50]
	out = []
	for name in names:
		d = frappe.get_doc("POSpire Offline Sync Review", name)
		out.append({
			"name": d.name, "status": d.status, "entry_type": d.entry_type,
			"offline_id": d.offline_id, "device_id": d.device_id, "cashier_user": d.cashier_user,
			"posting_date": str(d.posting_date or ""), "shift_offline_id": d.shift_offline_id,
			"parent_offline_ids": d.parent_offline_ids, "client_build_hash": d.client_build_hash,
			"schema_version": d.schema_version, "error_category": d.error_category,
			"attempt_count": d.attempt_count, "last_attempt_at": str(d.last_attempt_at or ""),
			"error_detail": _trunc(d.error_detail),
			"payload_edited": d.payload_hash != d.original_payload_hash,
			"payload": _trunc(d.payload),
			"resolved": [d.resolved_doctype, d.resolved_doc_name],
			"legal_hold": d.legal_hold, "reviewer_notes": d.reviewer_notes, "created": str(d.creation),
			"activity": [
				{"at": str(a.at), "actor": a.actor, "action": a.action, "outcome": a.outcome,
				 "detail": _trunc(a.detail, 500)}
				for a in (d.activity or [])
			],
		})
	return out


def _beacons(ids: dict[str, set[str]], since, until) -> list[dict[str, Any]]:
	ors = []
	if ids["device_id"]:
		ors.append(["device_id", "in", sorted(ids["device_id"])])
	if ids["user"]:
		ors.append(["user", "in", sorted(ids["user"])])
	if not ors:
		return []
	return frappe.get_all("POS Offline Beacon", or_filters=ors,
		filters=[["beacon_at", "between", [since, until]]],
		fields=["device_id", "beacon_at", "online", "outlet", "user", "active_shift", "queue_depth",
			"in_flight", "needs_review", "handed_off", "oldest_minutes", "oldest_handed_off_minutes",
			"last_sync_at", "last_sync_outcome", "sw_build_hash", "spa_user_agent"],
		order_by="beacon_at asc", limit=300)


def _needles(ids: dict[str, set[str]], keys=("offline_id", "device_id", "user", "shift", "docname")) -> list[str]:
	return sorted({v for k in keys for v in ids[k]})


def _error_logs(ids: dict[str, set[str]], since, until) -> list[dict[str, Any]]:
	"""Error Log rows in the window that mention any identifier."""
	needles = _needles(ids)
	rows = frappe.get_all("Error Log", filters=[["creation", "between", [since, until]]],
		fields=["name", "creation", "method", "error", "reference_doctype", "reference_name", "trace_id"],
		order_by="creation asc", limit=2000)
	out = []
	for r in rows:
		text = f"{r.method or ''}\n{r.error or ''}\n{r.reference_name or ''}"
		if not any(n in text for n in needles):
			continue
		out.append({"name": r.name, "creation": str(r.creation), "title": r.method,
			"reference": [r.reference_doctype, r.reference_name], "trace_id": r.trace_id,
			"error": _trunc(r.error, 2500)})
	return out[-150:]


def _scheduler_failures(since, until) -> list[dict[str, Any]]:
	return [
		{**r, "details": _trunc(r.get("details"), 1500), "creation": str(r["creation"])}
		for r in frappe.get_all("Scheduled Job Log",
			filters=[["status", "=", "Failed"], ["creation", "between", [since, until]]],
			fields=["scheduled_job_type", "creation", "details"], order_by="creation desc", limit=30)
	]


def _log_file_hits(logs_dir: str, ids: dict[str, set[str]]) -> dict[str, list[str]]:
	"""Grep the tail of bench log files for the incident identifiers.

	Users are excluded from the needles — an email matches far too much
	unrelated noise in request logs."""
	needles = _needles(ids, ("offline_id", "device_id", "shift", "docname"))
	if not needles or not os.path.isdir(logs_dir):
		return {}
	pattern = re.compile("|".join(re.escape(n) for n in needles))
	hits: dict[str, list[str]] = {}
	for fname in sorted(os.listdir(logs_dir)):
		if not fname.startswith(_LOG_FILES):
			continue
		path = os.path.join(logs_dir, fname)
		try:
			with open(path, "rb") as fh:
				fh.seek(max(0, os.path.getsize(path) - _LOG_TAIL_BYTES))
				text = fh.read().decode("utf-8", errors="replace")
		except OSError:
			continue
		lines = [ln[:800] for ln in text.splitlines() if pattern.search(ln)]
		if lines:
			hits[fname] = lines[-_LOG_LINE_CAP:]
	return hits


def _fleet(since) -> dict[str, Any]:
	out: dict[str, Any] = {}
	out["latest_beacon_per_device"] = frappe.db.sql(
		"""SELECT b.device_id, b.beacon_at, b.online, b.outlet, b.user, b.active_shift,
			b.queue_depth, b.needs_review, b.handed_off, b.oldest_minutes,
			b.last_sync_outcome, b.sw_build_hash
		FROM `tabPOS Offline Beacon` b
		JOIN (SELECT device_id, MAX(beacon_at) AS beacon_at FROM `tabPOS Offline Beacon`
			WHERE beacon_at >= %(since)s GROUP BY device_id) latest
			ON latest.device_id = b.device_id AND latest.beacon_at = b.beacon_at
		ORDER BY b.queue_depth DESC, b.oldest_minutes DESC
		LIMIT 200""",
		{"since": since},
		as_dict=True,
	)
	out["open_reviews_by_category"] = frappe.db.sql(
		"""SELECT error_category, entry_type, status, COUNT(*) AS n, MIN(creation) AS oldest
		FROM `tabPOSpire Offline Sync Review`
		WHERE status IN ('Pending Review', 'In Review', 'Retrying')
		GROUP BY error_category, entry_type, status ORDER BY n DESC""",
		as_dict=True,
	)
	out["build_hashes_seen"] = frappe.db.sql(
		"""SELECT sw_build_hash, COUNT(DISTINCT device_id) AS devices, MAX(beacon_at) AS last_seen
		FROM `tabPOS Offline Beacon` WHERE beacon_at >= %(since)s
		GROUP BY sw_build_hash ORDER BY last_seen DESC""",
		{"since": since},
		as_dict=True,
	)
	out["error_log_titles"] = frappe.db.sql(
		"""SELECT method AS title, COUNT(*) AS n, MAX(creation) AS last_seen FROM `tabError Log`
		WHERE creation >= %(since)s GROUP BY method ORDER BY n DESC LIMIT 30""",
		{"since": since},
		as_dict=True,
	)
	out["scheduler_failures"] = frappe.db.sql(
		"""SELECT scheduled_job_type, COUNT(*) AS n, MAX(creation) AS last_failed
		FROM `tabScheduled Job Log` WHERE status = 'Failed' AND creation >= %(since)s
		GROUP BY scheduled_job_type ORDER BY n DESC""",
		{"since": since},
		as_dict=True,
	)
	return out
