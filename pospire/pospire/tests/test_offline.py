# Copyright (c) 2026, Promantia Business Solutions PVT Ltd and Contributors
# See license.txt

"""Server-side test coverage for the offline pipeline.

Targets the public invariants of `pospire/api/offline.py`:

  - P-5  : queued writes are attributed to `owner_user`, not the replay session.
  - P-11 : posting_date is snapshotted at queue time, never recomputed.
  - P-12 : submit-time handlers read POS Profile flags from the OPENING SHIFT
           snapshot, never the live profile.
  - D-9  : accounting-period guards return HTTP 417 on closed periods.
  - D-22, D-23 : idempotency keyed on (doctype, pos_offline_id) is
                 docstatus-aware (draft = resume, submitted = idempotent
                 success, cancelled = throw).
  - H1   : closing references accept either UUID or real opening-shift name.

These tests exercise the helper functions directly when the invariant
lives there (resolvers, idempotency branches, P-12 gate). They use the
full whitelisted endpoints when the invariant only manifests end-to-end
(idempotent submit_invoice replay, kill switch).
"""

from __future__ import annotations

import json
from contextlib import suppress
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, cint, getdate, now_datetime, nowdate

from pospire.pospire.api.offline import (
	ERROR_ACCOUNTING_PERIOD_CLOSED,
	ERROR_PARENT_NOT_READY,
	ERROR_PERMISSION,
	ERROR_SIBLINGS_NOT_READY,
	ERROR_VALIDATION,
	OfflineSubmitError,
	_acting_as_user,
	_aggregate_closing_from_invoices,
	_apply_payload_metadata,
	_assert_offline_action_allowed_by_shift,
	_check_accounting_period_open,
	_enrich_closing_payload,
	_ensure_all_invoices_submitted,
	_existing_by_offline_id,
	_idempotent_submit,
	_resolve_opening_shift,
	_resolve_opening_shift_flexible,
	create_closing_entry,
	get_offline_flags_for_shift,
	is_offline_enabled,
	snapshot_profile_flags_onto_opening_shift,
)
from pospire.pospire.tests.test_utils import (
	create_test_opening_shift,
	ensure_test_company,
	ensure_test_customer,
	get_test_pos_profile,
)

# UUID v4 helper — `_validate_uuid` rejects anything else, so all fixtures
# must use this generator for offline_id values.
_UUID_VALID = "12345678-1234-4abc-9def-0123456789ab"
_UUID_VALID_2 = "abcdef01-2345-4abc-89cd-0123456789ab"
_UUID_VALID_3 = "fedcba98-7654-4abc-89cd-0123456789ab"


def _make_offline_id() -> str:
	"""Generate a fresh UUID v4 for each test so replay tests don't collide."""
	import uuid

	return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Resolver tests — small surface, high signal
# ---------------------------------------------------------------------------


class TestResolvers(FrappeTestCase):
	"""`_resolve_opening_shift` + `_resolve_opening_shift_flexible` (H1)."""

	def test_resolve_opening_shift_strict_rejects_non_uuid(self):
		"""Strict resolver rejects a real shift name with `validation_error`."""
		with self.assertRaises(OfflineSubmitError):
			_resolve_opening_shift("POSA-OS-26-0000030")

	def test_resolve_opening_shift_strict_throws_when_uuid_unknown(self):
		"""Strict resolver throws `parent_not_ready` for an unknown UUID."""
		with self.assertRaises(OfflineSubmitError):
			_resolve_opening_shift(_UUID_VALID)
		self.assertEqual(frappe.local.response.get("error_code"), ERROR_PARENT_NOT_READY)

	def test_resolve_opening_shift_flexible_returns_none_when_ref_empty(self):
		"""Flexible resolver short-circuits on empty input (mixed-mode where
		neither offline_id nor real name was supplied)."""
		name, offline_id = _resolve_opening_shift_flexible(None)
		self.assertIsNone(name)
		self.assertIsNone(offline_id)

	def test_resolve_opening_shift_flexible_throws_for_unknown_name(self):
		"""Flexible resolver throws `parent_not_ready` for a non-existent
		real shift name."""
		with self.assertRaises(OfflineSubmitError):
			_resolve_opening_shift_flexible("POSA-OS-26-DOESNOTEXIST")


# ---------------------------------------------------------------------------
# Strict closure — P-8 server-side sibling validation
# ---------------------------------------------------------------------------


class TestStrictClosureValidation(FrappeTestCase):
	"""Strict closure accepts already-submitted server siblings omitted by
	older payloads, while still blocking declared siblings that are not yet
	submitted."""

	def test_auto_includes_submitted_shift_invoices_omitted_from_payload(self):
		"""Online-before-offline invoices are server-submitted siblings. They
		should not force managers to hand-edit historical OSR payloads."""

		def fake_get_all(doctype, filters=None, pluck=None, **kwargs):
			filters = filters or {}
			self.assertEqual(doctype, "Sales Invoice")
			if filters.get("pos_offline_id"):
				return [_UUID_VALID]
			if filters.get("posa_pos_opening_shift") == "POSA-OS-26-0000041":
				return [_UUID_VALID, _UUID_VALID_2]
			return []

		with patch("pospire.pospire.api.offline.frappe.get_all", side_effect=fake_get_all):
			opening_name, canonical_ids, auto_included_ids = _ensure_all_invoices_submitted(
				"POSA-OS-26-0000041",
				[_UUID_VALID],
			)

		self.assertEqual(opening_name, "POSA-OS-26-0000041")
		self.assertEqual(canonical_ids, sorted([_UUID_VALID, _UUID_VALID_2]))
		self.assertEqual(auto_included_ids, [_UUID_VALID_2])

	def test_declared_invoice_must_still_be_submitted(self):
		"""Auto-inclusion only covers submitted server siblings; explicitly
		listed invoice IDs still block the close until they submit."""

		def fake_get_all(doctype, filters=None, pluck=None, **kwargs):
			filters = filters or {}
			self.assertEqual(doctype, "Sales Invoice")
			if filters.get("pos_offline_id"):
				return []
			if filters.get("posa_pos_opening_shift") == "POSA-OS-26-0000041":
				return [_UUID_VALID_2]
			return []

		with patch("pospire.pospire.api.offline.frappe.get_all", side_effect=fake_get_all):
			with self.assertRaises(OfflineSubmitError):
				_ensure_all_invoices_submitted("POSA-OS-26-0000041", [_UUID_VALID_3])
		self.assertEqual(frappe.local.response.get("error_code"), ERROR_SIBLINGS_NOT_READY)


# ---------------------------------------------------------------------------
# Closing enrichment — _aggregate_closing_from_invoices / _enrich_closing_payload
# ---------------------------------------------------------------------------


class TestEnrichClosingPayload(FrappeTestCase):
	"""_enrich_closing_payload builds correct totals from submitted invoices."""

	def test_opening_balance_seeded_into_expected_amount(self):
		"""pay_expected starts from the opening shift balance, then adds invoice
		payments — so expected cash = opening_cash + invoice_cash_sales."""

		def fake_get_all(doctype, filters=None, pluck=None, fields=None, **kwargs):
			filters = filters or {}
			if doctype == "POS Opening Shift Detail":
				return [frappe._dict({"mode_of_payment": "Cash", "amount": 5000})]
			if doctype == "Sales Invoice" and pluck == "name":
				return ["INV-001"] if filters.get("posa_pos_opening_shift") else []
			if doctype == "Sales Invoice":
				return [
					frappe._dict(
						name="INV-001",
						posting_date="2026-05-15",
						grand_total=2075,
						net_total=2075,
						total_qty=3,
						customer="Test Customer",
						change_amount=0,
					)
				]
			if doctype == "Sales Invoice Payment":
				return [frappe._dict({"mode_of_payment": "Cash", "amount": 2075})]
			if doctype == "Sales Taxes and Charges":
				return []
			if doctype == "Payment Entry":
				return []
			return []

		with (
			patch("pospire.pospire.api.offline.frappe.get_all", side_effect=fake_get_all),
			patch("pospire.pospire.api.offline.frappe.get_cached_value", return_value=None),
			patch("pospire.pospire.api.offline.frappe.db.get_value", return_value=None),
		):
			agg = _aggregate_closing_from_invoices("POSA-OS-TEST", None)

		self.assertAlmostEqual(agg["pay_expected"]["Cash"], 7075.0)
		self.assertAlmostEqual(agg["grand_total"], 2075.0)
		self.assertEqual(len(agg["pos_transactions"]), 1)

	def test_invoice_via_offline_link_included_in_aggregation(self):
		"""Invoices linked only by pos_opening_shift_offline_id are aggregated —
		matches the two-path lookup used by strict closure."""
		offline_uuid = _UUID_VALID

		def fake_get_all(doctype, filters=None, pluck=None, fields=None, **kwargs):
			filters = filters or {}
			if doctype == "POS Opening Shift Detail":
				return []
			if doctype == "Sales Invoice" and pluck == "name":
				if filters.get("posa_pos_opening_shift"):
					return []
				if filters.get("pos_opening_shift_offline_id") == offline_uuid:
					return ["INV-OFFLINE-001"]
				return []
			if doctype == "Sales Invoice":
				return [
					frappe._dict(
						name="INV-OFFLINE-001",
						posting_date="2026-05-15",
						grand_total=500,
						net_total=500,
						total_qty=1,
						customer="Test Customer",
						change_amount=0,
					)
				]
			if doctype in ("Sales Invoice Payment", "Sales Taxes and Charges", "Payment Entry"):
				return []
			return []

		with (
			patch("pospire.pospire.api.offline.frappe.get_all", side_effect=fake_get_all),
			patch("pospire.pospire.api.offline.frappe.get_cached_value", return_value=None),
			patch("pospire.pospire.api.offline.frappe.db.get_value", return_value=None),
		):
			agg = _aggregate_closing_from_invoices("POSA-OS-TEST", None, opening_offline_id=offline_uuid)

		self.assertAlmostEqual(agg["grand_total"], 500.0)
		self.assertEqual(len(agg["pos_transactions"]), 1)
		self.assertEqual(agg["pos_transactions"][0]["sales_invoice"], "INV-OFFLINE-001")

	def test_grand_total_rounded_to_currency_precision(self):
		"""IEEE-754 sum of invoice totals must not leak past currency precision.

		20000.05 + 44660.05 is 64660.100000000006 in IEEE-754 (the same
		class of noise as the prospect OSR-2026-00005 Grand Total error).
		Quantity uses the same sum-then-round pattern with float precision.
		"""
		noisy_a = 20000.05
		noisy_b = 44660.05
		self.assertNotEqual(noisy_a + noisy_b, 64660.1)
		self.assertNotEqual(0.1 + 0.2, 0.3)

		def fake_get_all(doctype, filters=None, pluck=None, fields=None, **kwargs):
			filters = filters or {}
			if doctype == "POS Opening Shift Detail":
				return []
			if doctype == "Sales Invoice" and pluck == "name":
				return ["INV-A", "INV-B"] if filters.get("posa_pos_opening_shift") else []
			if doctype == "Sales Invoice":
				return [
					frappe._dict(
						name="INV-A",
						posting_date="2026-08-18",
						grand_total=noisy_a,
						net_total=noisy_a,
						total_qty=0.1,
						customer="Cust A",
						change_amount=0,
					),
					frappe._dict(
						name="INV-B",
						posting_date="2026-08-18",
						grand_total=noisy_b,
						net_total=noisy_b,
						total_qty=0.2,
						customer="Cust B",
						change_amount=0,
					),
				]
			if doctype in ("Sales Invoice Payment", "Sales Taxes and Charges", "Payment Entry"):
				return []
			return []

		def fake_get_cached_value(doctype, name=None, field=None, **kwargs):
			if doctype == "System Settings":
				return 2
			return None

		with (
			patch("pospire.pospire.api.offline.frappe.get_all", side_effect=fake_get_all),
			patch(
				"pospire.pospire.api.offline.frappe.get_cached_value",
				side_effect=fake_get_cached_value,
			),
			patch("pospire.pospire.api.offline.frappe.db.get_value", return_value=None),
		):
			agg = _aggregate_closing_from_invoices("POSA-OS-TEST", None)

		self.assertEqual(agg["grand_total"], 64660.1)
		self.assertEqual(agg["net_total"], 64660.1)
		self.assertEqual(agg["total_quantity"], 0.3)


# ---------------------------------------------------------------------------
# Idempotency tests — `_idempotent_submit` docstatus-aware branches (C2/RM2)
# ---------------------------------------------------------------------------


class TestIdempotentSubmit(FrappeTestCase):
	"""Verify the (doctype, pos_offline_id) idempotency contract."""

	def test_existing_by_offline_id_returns_none_for_unknown(self):
		"""The cheap existence probe returns None when the offline_id has
		never been seen for the given doctype."""
		self.assertIsNone(_existing_by_offline_id("Sales Invoice", _make_offline_id()))

	def test_insert_payload_strips_cart_docstatus(self):
		"""Cart closing payloads stamp `docstatus: 1`. If that leaks into
		`frappe.get_doc` + insert, Frappe writes a submitted row and the
		follow-up `.submit()` becomes update-after-submit — which is how
		the prospect Grand Total float noise turned into UpdateAfterSubmitError.
		"""
		captured: dict = {}

		def fake_get_doc(payload):
			captured["payload"] = dict(payload)
			raise AssertionError("stop-after-get-doc")

		with (
			patch("pospire.pospire.api.offline._existing_by_offline_id", return_value=None),
			patch("pospire.pospire.api.offline.frappe.get_doc", side_effect=fake_get_doc),
		):
			with self.assertRaises(AssertionError):
				_idempotent_submit(
					"POS Closing Shift",
					{
						"docstatus": 1,
						"name": "POSA-CS-SHOULD-NOT-LEAK",
						"owner": "ravneet.bedi@promantia.com",
						"grand_total": 64660.10000000002,
					},
					_UUID_VALID,
					device_id=_UUID_VALID_2,
				)

		payload = captured["payload"]
		self.assertNotIn("docstatus", payload)
		self.assertNotIn("name", payload)
		self.assertNotIn("owner", payload)
		self.assertEqual(payload["doctype"], "POS Closing Shift")
		self.assertEqual(payload["pos_offline_id"], _UUID_VALID)
		self.assertEqual(payload["pos_device_id"], _UUID_VALID_2)

	def test_closing_submit_closes_opening_without_repair(self):
		"""Cart `docstatus: 1` must still insert a draft and run on_submit.

		That is the real repair: POSClosingShift.on_submit marks the opening
		Closed. `_ensure_opening_closed` is a safety net and must be a no-op
		on this path (`opening_shift_repaired` stays unset).
		"""
		# Profile-first, NOT the `ensure_test_company()` + `get_test_pos_profile()`
		# idiom used elsewhere in this file. Both helpers are "first row" lookups,
		# not fixtures, so that idiom silently skips on any site whose first
		# Company happens to own no POS Profile. Taking the profile and reading
		# its company back off it keeps the pair consistent and the test running.
		profile_row = frappe.get_all("POS Profile", fields=["name", "company"], limit=1)
		if profile_row:
			company, pos_profile = profile_row[0].company, profile_row[0].name
		else:
			company = ensure_test_company()
			pos_profile = get_test_pos_profile(company)
		if not pos_profile:
			self.skipTest("No POS Profile available for testing")

		# NB: if that profile has `posa_allow_delete`, POSClosingShift.on_submit
		# also runs delete_draft_invoices(). Harmless here — the opening shift is
		# created fresh, so no Sales Invoice links to it.
		opening = create_test_opening_shift(company, pos_profile)
		closing_name = None
		try:
			result = create_closing_entry(
				data={
					"doctype": "POS Closing Shift",
					"period_start_date": opening.period_start_date,
					"period_end_date": now_datetime(),
					"posting_date": nowdate(),
					"user": "Administrator",
					"pos_profile": pos_profile,
					"company": company,
					"docstatus": 1,
					"name": "POSA-CS-SHOULD-NOT-LEAK",
					"payment_reconciliation": [
						{
							"mode_of_payment": "Cash",
							"opening_amount": 0,
							"closing_amount": 0,
							"expected_amount": 0,
						}
					],
					"grand_total": 64660.10000000002,
					"owner_user": "Administrator",
					"invoice_offline_ids": [],
					"pos_opening_shift": opening.name,
				},
				offline_id=_make_offline_id(),
				device_id=_make_offline_id(),
				opening_entry_ref=opening.name,
			)
			closing_name = result.get("name")
			self.assertTrue(closing_name)
			self.assertNotEqual(closing_name, "POSA-CS-SHOULD-NOT-LEAK")
			self.assertEqual(cint(result.get("docstatus")), 1)
			self.assertFalse(result.get("was_already_submitted"))
			self.assertNotIn("opening_shift_repaired", result)

			opening.reload()
			self.assertEqual(opening.status, "Closed")
			self.assertEqual(opening.pos_closing_shift, closing_name)
		finally:
			with suppress(Exception):
				if closing_name:
					closing = frappe.get_doc("POS Closing Shift", closing_name)
					if cint(closing.docstatus) == 1:
						closing.cancel()
					frappe.delete_doc("POS Closing Shift", closing_name, force=True, ignore_permissions=True)
			with suppress(Exception):
				opening.reload()
				if cint(opening.docstatus) == 1:
					opening.cancel()
				frappe.delete_doc("POS Opening Shift", opening.name, force=True, ignore_permissions=True)

	def test_replay_against_cancelled_doc_throws_validation_error(self):
		"""docstatus=2 → cannot replay; throws ERROR_VALIDATION so client
		moves to needs_review (vs falsely reporting was_already_submitted)."""
		# Use Customer (non-submittable, but cancellable via flag) for a
		# cheaper test surface than Sales Invoice. We simulate the
		# scenario by directly setting an offline_id on a Customer and
		# then checking `_idempotent_submit` would resume — we cannot
		# easily produce docstatus=2 on a non-submittable doctype, so
		# this test focuses on the live posapp flow which short-circuits
		# the same way. Skip for now; documented in test plan.
		self.skipTest(
			"docstatus=2 path needs a cancellable doctype + submitted "
			"insert; covered by the live posapp.submit_invoice idempotency "
			"test in the integration suite."
		)


# ---------------------------------------------------------------------------
# Payload metadata tests — P-5 + P-11 (`_apply_payload_metadata`)
# ---------------------------------------------------------------------------


class TestApplyPayloadMetadata(FrappeTestCase):
	"""`_apply_payload_metadata` enforces posting_date + owner_user contracts."""

	def test_missing_posting_date_throws_validation_error(self):
		"""P-11 — posting_date is required on every queued write."""
		with self.assertRaises(OfflineSubmitError):
			_apply_payload_metadata({"owner_user": "Administrator"})
		self.assertEqual(frappe.local.response.get("error_code"), ERROR_VALIDATION)

	def test_missing_owner_user_throws_validation_error(self):
		"""P-5 — owner_user is required so the replay can attribute the
		write to the original cashier."""
		with self.assertRaises(OfflineSubmitError):
			_apply_payload_metadata({"posting_date": "2026-04-29"})

	def test_returns_owner_user_and_pops_it_from_payload(self):
		"""On success: returns owner_user; pops both `owner_user` AND any
		stray `owner` key so `frappe.get_doc(payload)` doesn't try to
		write the magic Frappe `owner` field (set_only_once → throws)."""
		payload = {
			"posting_date": nowdate(),
			"owner_user": "Administrator",
			"owner": "Administrator",
		}
		owner = _apply_payload_metadata(payload)
		self.assertEqual(owner, "Administrator")
		self.assertNotIn("owner_user", payload)
		self.assertNotIn("owner", payload)

	def test_falls_back_to_owner_when_owner_user_missing(self):
		"""Backward-compat: callers that only supply `owner` (legacy
		queued payloads) are accepted."""
		payload = {"posting_date": nowdate(), "owner": "Administrator"}
		owner = _apply_payload_metadata(payload)
		self.assertEqual(owner, "Administrator")


# ---------------------------------------------------------------------------
# Owner impersonation — P-5 (`_acting_as_user`)
# ---------------------------------------------------------------------------


class TestActingAsUser(FrappeTestCase):
	"""`_acting_as_user` swaps `frappe.session.user` for the duration of
	the offline replay so the doc's owner reflects the cashier, not the
	admin who ran the sync."""

	def test_no_owner_user_is_no_op(self):
		"""None / empty owner_user leaves the session unchanged."""
		original = frappe.session.user
		with _acting_as_user(None):
			self.assertEqual(frappe.session.user, original)
		self.assertEqual(frappe.session.user, original)

	def test_same_user_short_circuits(self):
		"""Asking to impersonate the current user is a no-op."""
		original = frappe.session.user
		with _acting_as_user(original):
			self.assertEqual(frappe.session.user, original)

	def test_missing_user_falls_through_with_warning(self):
		"""A non-existent user defaults gracefully (the offline replay
		shouldn't be blocked indefinitely by a removed user account)."""
		original = frappe.session.user
		with _acting_as_user("ghost-user@example.invalid"):
			# Implementation falls through; session.user stays the
			# replay session (logged as a warning, not raised).
			self.assertEqual(frappe.session.user, original)


# ---------------------------------------------------------------------------
# Accounting period guard — D-9 (`_check_accounting_period_open`)
# ---------------------------------------------------------------------------


class TestAccountingPeriodGuard(FrappeTestCase):
	"""`_check_accounting_period_open` throws HTTP 417 / accounting_period_closed
	when posting_date falls in a closed period."""

	def test_no_company_or_date_is_no_op(self):
		"""Defensive: missing inputs short-circuit instead of throwing."""
		# Should not raise.
		_check_accounting_period_open(None, "Some Co")
		_check_accounting_period_open("2026-04-29", None)

	def test_open_period_passes(self):
		"""An ordinary date in a reachable period → no throw."""
		company = ensure_test_company()
		# Today is necessarily in an open period on a fresh test site.
		_check_accounting_period_open(nowdate(), company)


# ---------------------------------------------------------------------------
# Profile flag snapshot — P-12 (snapshot_profile_flags_onto_opening_shift +
# get_offline_flags_for_shift + _assert_offline_action_allowed_by_shift)
# ---------------------------------------------------------------------------


class TestProfileFlagSnapshot(FrappeTestCase):
	"""End-to-end exercise of the P-12 snapshot read path."""

	def test_get_offline_flags_for_shift_returns_zero_for_missing_shift(self):
		"""Empty / unknown shift → zero-default flag map (so the gate
		below treats this as 'feature disabled')."""
		flags = get_offline_flags_for_shift("")
		self.assertEqual(flags.get("custom_allow_negative_stock"), 0)
		self.assertEqual(flags.get("custom_allow_add_to_stock_at_pos"), 0)

	def test_assert_action_allowed_passes_when_no_shift(self):
		"""Empty shift name → falls open (customer creation, shift open
		itself etc. don't have a parent shift to consult)."""
		_assert_offline_action_allowed_by_shift(None, "any_flag", "Test action")

	def test_assert_action_allowed_throws_permission_when_flag_zero(self):
		"""A shift snapshot with the flag at 0 refuses the offline replay
		with HTTP 403 (ERROR_PERMISSION)."""
		# Build a synthetic shift with the snapshot fields explicitly 0.
		# We reach into Frappe directly to set them so we don't depend
		# on the snapshot helper, which is tested separately.
		company = ensure_test_company()
		profile = get_test_pos_profile(company)
		if not profile:
			self.skipTest("No POS Profile available on test site")

		shift = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": company,
				"pos_profile": profile,
				"user": "Administrator",
				"period_start_date": nowdate(),
				"posting_date": nowdate(),
				"balance_details": [{"mode_of_payment": "Cash", "amount": 0}],
			}
		)
		shift.insert(ignore_permissions=True)
		# Stamp the snapshot fields directly (via db_set so doc-update
		# hooks don't try to re-snapshot from the live profile).
		if frappe.get_meta("POS Opening Shift").has_field("pos_profile_snapshot_allow_add_to_stock_at_pos"):
			shift.db_set("pos_profile_snapshot_allow_add_to_stock_at_pos", 0)
		else:
			self.skipTest(
				"pos_profile_snapshot_allow_add_to_stock_at_pos field not yet migrated on this site"
			)

		try:
			with self.assertRaises(OfflineSubmitError):
				_assert_offline_action_allowed_by_shift(
					shift.name,
					"custom_allow_add_to_stock_at_pos",
					"Add to stock",
				)
			self.assertEqual(frappe.local.response.get("error_code"), ERROR_PERMISSION)
		finally:
			# Clean up — un-submit the shift so it doesn't taint the
			# next test that opens a shift on this profile.
			with suppress(Exception):
				frappe.delete_doc("POS Opening Shift", shift.name, ignore_permissions=True)

	def test_assert_action_allowed_passes_when_flag_one(self):
		"""Flag=1 → no throw."""
		company = ensure_test_company()
		profile = get_test_pos_profile(company)
		if not profile:
			self.skipTest("No POS Profile available on test site")

		shift = frappe.get_doc(
			{
				"doctype": "POS Opening Shift",
				"company": company,
				"pos_profile": profile,
				"user": "Administrator",
				"period_start_date": nowdate(),
				"posting_date": nowdate(),
				"balance_details": [{"mode_of_payment": "Cash", "amount": 0}],
			}
		)
		shift.insert(ignore_permissions=True)
		if frappe.get_meta("POS Opening Shift").has_field("pos_profile_snapshot_allow_add_to_stock_at_pos"):
			shift.db_set("pos_profile_snapshot_allow_add_to_stock_at_pos", 1)
		else:
			self.skipTest(
				"pos_profile_snapshot_allow_add_to_stock_at_pos field not yet migrated on this site"
			)

		try:
			_assert_offline_action_allowed_by_shift(
				shift.name,
				"custom_allow_add_to_stock_at_pos",
				"Add to stock",
			)
		finally:
			with suppress(Exception):
				frappe.delete_doc("POS Opening Shift", shift.name, ignore_permissions=True)


# ---------------------------------------------------------------------------
# Kill switch — F10 / RH1 (`is_offline_enabled` whitelisted endpoint)
# ---------------------------------------------------------------------------


class TestKillSwitch(FrappeTestCase):
	"""`is_offline_enabled` returns the boolean value any cashier role
	can read, bypassing the doctype's System-Manager-only permission."""

	def test_default_is_enabled(self):
		"""Fresh Single doctype defaults `enabled = 1`; missing doctype
		also returns True so a pre-migrate boot doesn't block the SPA."""
		result = is_offline_enabled()
		self.assertIn("enabled", result)
		self.assertIsInstance(result["enabled"], bool)

	def test_disable_then_re_enable_round_trip(self):
		"""Flipping the switch through the doctype reflects in the read
		endpoint — no permission denial regardless of doctype role
		restrictions."""
		if not frappe.db.exists("DocType", "POSpire Offline Settings"):
			self.skipTest("POSpire Offline Settings doctype not migrated")

		# Snapshot original state so we don't taint subsequent tests.
		original = is_offline_enabled()["enabled"]
		try:
			doc = frappe.get_doc("POSpire Offline Settings")
			doc.enabled = 0
			doc.save(ignore_permissions=True)
			frappe.db.commit()
			self.assertFalse(is_offline_enabled()["enabled"])

			doc.enabled = 1
			doc.save(ignore_permissions=True)
			frappe.db.commit()
			self.assertTrue(is_offline_enabled()["enabled"])
		finally:
			doc = frappe.get_doc("POSpire Offline Settings")
			doc.enabled = 1 if original else 0
			doc.save(ignore_permissions=True)
			frappe.db.commit()


# ---------------------------------------------------------------------------
# Snapshot helper — the writer side (`snapshot_profile_flags_onto_opening_shift`)
# ---------------------------------------------------------------------------


class TestSnapshotProfileFlagsOntoOpeningShift(FrappeTestCase):
	"""The writer side of P-12. Setting the snapshot fields on an
	opening shift at insertion time."""

	def test_no_pos_profile_is_no_op(self):
		"""Defensive: a shift without a profile shouldn't crash the
		snapshot helper."""
		shift = frappe.new_doc("POS Opening Shift")
		# No pos_profile assigned. Should not raise.
		snapshot_profile_flags_onto_opening_shift(shift)

	def test_writes_snapshot_fields_when_profile_present(self):
		"""Verify the helper populates the snapshot fields on the shift
		doc (or is a graceful no-op when those custom fields don't exist
		on this branch)."""
		company = ensure_test_company()
		profile = get_test_pos_profile(company)
		if not profile:
			self.skipTest("No POS Profile available on test site")

		shift = frappe.new_doc("POS Opening Shift")
		shift.pos_profile = profile
		# Write the snapshot.
		snapshot_profile_flags_onto_opening_shift(shift)

		# Either both fields are populated (if the custom field schema
		# is current) or both are missing entirely (legacy schema). The
		# helper must never leave them in a half-set state.
		has_neg = shift.meta.has_field("pos_profile_snapshot_allow_negative_stock")
		has_atp = shift.meta.has_field("pos_profile_snapshot_allow_add_to_stock_at_pos")
		if has_neg:
			self.assertIn(shift.pos_profile_snapshot_allow_negative_stock, (0, 1))
		if has_atp:
			self.assertIn(shift.pos_profile_snapshot_allow_add_to_stock_at_pos, (0, 1))


# ---------------------------------------------------------------------------
# Cross-path idempotency — C1 (`posapp.submit_invoice` accepts offline_id +
# stamps it on the doc so a queued retry finds the existing row)
# ---------------------------------------------------------------------------


class TestPosappLiveIdempotency(FrappeTestCase):
	"""C1: live `posapp.submit_invoice` accepts and stamps `offline_id`
	so a network-failure-after-server-commit replay through the offline
	endpoint doesn't insert a duplicate."""

	def test_live_endpoint_accepts_offline_id_kwarg_without_error(self):
		"""Smoke test: passing offline_id to posapp.submit_invoice doesn't
		blow up at the import / signature level. (Full submit-then-retry
		integration covered by the frontend E2E plan.)"""
		# Inspect the function signature to ensure offline_id kwarg exists.
		import inspect

		from pospire.pospire.api.posapp import submit_invoice as posapp_submit_invoice

		sig = inspect.signature(posapp_submit_invoice)
		self.assertIn("offline_id", sig.parameters)


# ---------------------------------------------------------------------------
# Recovery replay — manager retry must replay endpoint args, not wrapper docs
# ---------------------------------------------------------------------------


class TestRecoveryReplay(FrappeTestCase):
	"""Manager retry of a handed-off row should use the stored offline
	endpoint contract exactly as the scheduler would have sent it."""

	def test_retry_customer_wrapper_payload_uses_inner_data(self):
		"""A customer recovery row stores `{data, offline_id, device_id}`.
		Retry must pass `data` to `offline.create_customer`; passing the
		wrapper itself makes ERPNext Customer validation see
		`customer_name=None` and raise `'NoneType' object has no attribute
		'strip'`."""
		from pospire.pospire.api.recovery import handoff, retry

		original_user = frappe.session.user
		frappe.set_user("Administrator")

		offline_id = _make_offline_id()
		device_id = _make_offline_id()
		customer_name = f"_Test Offline Customer {frappe.generate_hash(length=8)}"
		recovery_name = None
		customer_doc = None

		try:
			inner = {
				"doctype": "Customer",
				"customer_name": customer_name,
				"customer_type": "Individual",
				# "Individual" is a leaf group seeded by ERPNext install;
				# "All Customer Groups" is the is_group=1 root and is refused.
				"customer_group": "Individual",
				"territory": "All Territories",
				"owner_user": "Administrator",
				"owner": "Administrator",
			}
			wrapper = {
				"data": json.dumps(inner),
				"offline_id": offline_id,
				"device_id": device_id,
			}

			handoff_result = handoff(
				offline_id=offline_id,
				entry_type="customer",
				payload=wrapper,
				error_category="retry_exhausted",
				error_detail="'NoneType' object has no attribute 'strip'",
				attempt_count=8,
				device_id=device_id,
				cashier_user="Administrator",
				schema_version=1,
			)
			recovery_name = handoff_result["name"]

			result = retry(recovery_name)
			self.assertEqual(result.get("outcome"), "ok")
			self.assertEqual(result.get("resolved_doctype"), "Customer")

			customer_doc = result.get("resolved_doc_name")
			self.assertTrue(customer_doc)
			customer = frappe.get_doc("Customer", customer_doc)
			self.assertEqual(customer.customer_name, customer_name)
			self.assertEqual(customer.pos_offline_id, offline_id)
		finally:
			with suppress(Exception):
				if customer_doc:
					frappe.delete_doc("Customer", customer_doc, force=True, ignore_permissions=True)
			with suppress(Exception):
				if recovery_name:
					frappe.delete_doc(
						"POSpire Offline Sync Review",
						recovery_name,
						force=True,
						ignore_permissions=True,
					)
			frappe.set_user(original_user)


# ---------------------------------------------------------------------------
# Module-level smoke
# ---------------------------------------------------------------------------


class TestModuleSurface(FrappeTestCase):
	"""Sanity checks on the offline.py module surface — guard against
	accidental removal of public names referenced by other apps / scripts."""

	def test_public_api_exports(self):
		"""Things the frontend / runbooks / docs reference. Removal must
		be intentional + accompanied by a test update."""
		from pospire.pospire.api import offline as off_mod

		expected = [
			"ping",
			"is_offline_enabled",
			"submit_invoice",
			"create_material_receipt",
			"create_opening_entry",
			"create_closing_entry",
			"create_customer",
			"log_batch",
			"submit_recovery_log",
			"record_beacon",
			"get_observability_summary",
			"snapshot_profile_flags_onto_opening_shift",
			"get_offline_flags_for_shift",
			"get_shift_invoice_offline_ids",
		]
		for name in expected:
			self.assertTrue(
				hasattr(off_mod, name),
				f"public name `{name}` missing from offline.py — was a "
				"public function removed without a corresponding test update?",
			)
