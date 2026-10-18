# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Tests for the read-only RCA evidence endpoint."""

from __future__ import annotations

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api import diagnostics


class TestRcaBundleAccess(FrappeTestCase):
	def test_guest_is_rejected(self):
		frappe.set_user("Guest")
		try:
			with self.assertRaises(frappe.PermissionError):
				diagnostics._assert_rca_access()
		finally:
			frappe.set_user("Administrator")

	def test_rca_role_exists_after_ensure(self):
		diagnostics.ensure_rca_role()
		self.assertTrue(frappe.db.exists("Role", diagnostics.RCA_ROLE))
		# Idempotent.
		diagnostics.ensure_rca_role()


class TestRcaBundleContent(FrappeTestCase):
	def test_requires_an_identifier_unless_fleet(self):
		with self.assertRaises(frappe.ValidationError):
			diagnostics.build_rca_bundle()

	def test_fleet_bundle_shape(self):
		bundle = diagnostics.build_rca_bundle(fleet=True, include_logs=False)
		self.assertIn("server", bundle)
		for key in ("latest_beacon_per_device", "open_reviews_by_category", "build_hashes_seen"):
			self.assertIn(key, bundle["fleet"])

	def test_collects_beacons_and_client_events_for_device(self):
		device_id = str(uuid.uuid4())
		frappe.get_doc(
			{
				"doctype": "POS Offline Beacon",
				"device_id": device_id,
				"beacon_at": frappe.utils.now_datetime(),
				"online": 1,
				"queue_depth": 3,
			}
		).insert(ignore_permissions=True)
		# Error Log rows can get committed by the test harness regardless of
		# the test transaction, so remove both rows explicitly.
		def cleanup():
			frappe.db.delete("POS Offline Beacon", {"device_id": device_id})
			frappe.db.delete("Error Log", {"error": ["like", f"%{device_id}%"]})
			frappe.db.commit()

		self.addCleanup(cleanup)
		frappe.get_doc(
			{
				"doctype": "Error Log",
				"method": "POSpire Offline Event: client_error",
				"error": frappe.as_json({"kind": "client_error", "device_id": device_id, "message": "boom"}),
			}
		).insert(ignore_permissions=True)

		bundle = diagnostics.build_rca_bundle(device_id=device_id, include_logs=False)

		self.assertEqual([b.device_id for b in bundle["beacons"]], [device_id])
		self.assertEqual(len(bundle["error_logs"]), 1)
		self.assertEqual(bundle["error_logs"][0]["title"], "POSpire Offline Event: client_error")

	def test_named_review_returned_outside_window(self):
		name = frappe.get_all("POSpire Offline Sync Review", pluck="name", limit=1)
		if not name:
			self.skipTest("no Offline Sync Review rows on this site")
		bundle = diagnostics.build_rca_bundle(
			review=name[0], since="2000-01-01", until="2000-01-02", include_logs=False
		)
		self.assertIn(name[0], [r["name"] for r in bundle["sync_reviews"]])

	def test_rejects_free_text_identifiers(self):
		# Identifiers are used as log-search needles; arbitrary strings must
		# not turn the endpoint into a grep of server logs.
		with self.assertRaises(frappe.ValidationError):
			diagnostics._validate_identifiers("api_secret", None, None, None, None, None)
		with self.assertRaises(frappe.ValidationError):
			diagnostics._validate_identifiers(None, None, None, "a", None, None)
		with self.assertRaises(frappe.DoesNotExistError):
			diagnostics._validate_identifiers(None, "NO-SUCH-INVOICE", None, None, None, None)
		with self.assertRaises(frappe.DoesNotExistError):
			diagnostics._validate_identifiers(None, None, None, None, "nobody@example.invalid", None)
		diagnostics._validate_identifiers(str(uuid.uuid4()), None, None, str(uuid.uuid4()), "Administrator", None)

	def test_window_is_capped(self):
		bundle = diagnostics.build_rca_bundle(
			device_id=str(uuid.uuid4()), since="2020-01-01", until="2026-01-01", include_logs=False
		)
		since, until = (frappe.utils.get_datetime(v) for v in bundle["window"])
		self.assertLessEqual((until - since).days, diagnostics._MAX_WINDOW_DAYS)

	def test_log_file_grep_matches_identifiers_only(self):
		import os
		import tempfile

		with tempfile.TemporaryDirectory() as d:
			with open(os.path.join(d, "frappe.log"), "w") as fh:
				fh.write("unrelated line\nsubmit failed for OFF-123 here\n")
			with open(os.path.join(d, "other.txt"), "w") as fh:
				fh.write("OFF-123 in a non-log file\n")
			hits = diagnostics._log_file_hits(d, {"offline_id": {"OFF-123"}, "device_id": set(),
				"shift": set(), "docname": set(), "user": set()})
		self.assertEqual(hits, {"frappe.log": ["submit failed for OFF-123 here"]})
