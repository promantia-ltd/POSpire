# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Approval request broadcast and configuration guards.

Covers the silent-wait defects: broadcasting with no recipients, and creating
a request when neither PIN nor remote approval is actually available.
"""

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase
from frappe.utils import now_datetime

from pospire.pospire.api.approval import (
	_broadcast_request_to_managers,
	create_approval_request,
)
from pospire.pospire.doctype.pos_approval_action.pos_approval_action import POSApprovalAction
from pospire.pospire.doctype.pos_profile.pos_profile import validate_pos_profile


def _request_stub():
	return frappe._dict(
		name="POSA-AR-TEST",
		action_type="Edit Rate",
		item_code=None,
		item_name=None,
		original_value=None,
		requested_value=None,
		value_field_label=None,
		requested_by="Administrator",
		pos_profile="_Test Profile",
		expires_at=now_datetime(),
	)


class TestBroadcastRequestToManagers(UnitTestCase):
	def tearDown(self):
		frappe.db.rollback()

	def test_throws_when_approver_role_is_blank(self):
		with self.assertRaises(frappe.ValidationError) as ctx:
			_broadcast_request_to_managers(_request_stub(), {"approver_role": ""}, None)
		self.assertIn("Approver Role", str(ctx.exception))

	def test_throws_when_no_user_holds_approver_role(self):
		with patch("pospire.pospire.api.approval.frappe.get_all", return_value=[]):
			with self.assertRaises(frappe.ValidationError) as ctx:
				_broadcast_request_to_managers(_request_stub(), {"approver_role": "POS Manager"}, None)
			self.assertIn("no user has the role", str(ctx.exception).lower())

	def test_publishes_one_realtime_event_per_recipient(self):
		recipients = ["manager-a@example.com", "manager-b@example.com"]
		real_get_all = frappe.get_all

		def fake_get_all(doctype, *args, **kwargs):
			if doctype == "Has Role":
				return recipients
			return real_get_all(doctype, *args, **kwargs)

		with (
			patch("pospire.pospire.api.approval.frappe.get_all", side_effect=fake_get_all),
			patch("pospire.pospire.api.approval.frappe.publish_realtime") as publish,
		):
			_broadcast_request_to_managers(_request_stub(), {"approver_role": "POS Manager"}, None)
			self.assertEqual(publish.call_count, 2)
			users = [c.kwargs["user"] for c in publish.call_args_list]
			self.assertEqual(users, recipients)
			for c in publish.call_args_list:
				self.assertEqual(c.kwargs["event"], "pos_approval_request")


class TestCreateApprovalRequestConfig(UnitTestCase):
	def tearDown(self):
		frappe.db.rollback()

	def test_throws_when_neither_pin_nor_remote_is_available(self):
		profile = frappe.db.get_value("POS Profile", {}, "name")
		if not profile:
			self.skipTest("No POS Profile on this site")
		with patch(
			"pospire.pospire.api.approval._get_action_config",
			return_value={
				"pin_approval": 0,
				"remote_approval": 0,
				"expiry_minutes": 15,
				"approver_role": "POS Manager",
			},
		):
			with self.assertRaises(frappe.ValidationError) as ctx:
				create_approval_request(
					pos_profile=profile,
					action_type="Edit Rate",
					broadcast=True,
				)
			self.assertIn("neither PIN nor remote", str(ctx.exception))


def _action_row(**overrides):
	values = {
		"doctype": "POS Approval Action",
		"action_type": "Edit Rate",
		"approval_mode": "Required",
		"pin_approval": 0,
		"remote_approval": 0,
	}
	values.update(overrides)
	return POSApprovalAction(values)


def _profile_stub(rows):
	"""Minimal stand-in for the POS Profile doc the validate hook receives."""
	return frappe._dict(
		custom_assortment=None,
		item_groups=[],
		company="_Test Company",
		posa_approval_actions=rows,
	)


class TestPOSApprovalActionValidate(UnitTestCase):
	"""Drive the rules through validate_pos_profile, the hook registered for
	POS Profile in hooks.py. Calling POSApprovalAction.validate() directly would
	pass even if nothing ran it on save -- Frappe does not invoke a child
	DocType's validate() on parent save.
	"""

	def tearDown(self):
		frappe.db.rollback()

	def test_required_mode_rejects_both_channels_off(self):
		doc = _profile_stub([_action_row(pin_approval=0, remote_approval=0)])
		with self.assertRaises(frappe.ValidationError):
			validate_pos_profile(doc, "validate")

	def test_remote_requires_approver_role(self):
		doc = _profile_stub([_action_row(remote_approval=1, approver_role="")])
		with self.assertRaises(frappe.ValidationError) as ctx:
			validate_pos_profile(doc, "validate")
		self.assertIn("Approver Role", str(ctx.exception))

	def test_valid_rows_pass(self):
		doc = _profile_stub(
			[
				_action_row(pin_approval=1),
				_action_row(remote_approval=1, approver_role="POS Manager"),
				_action_row(approval_mode="Not Required"),
			]
		)
		validate_pos_profile(doc, "validate")
