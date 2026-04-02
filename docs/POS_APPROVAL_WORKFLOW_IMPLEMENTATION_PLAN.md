# POSpire — POS Approval Workflow
## Implementation Plan (Online + Offline)

**Version:** 1.0
**Date:** 2026-04-02
**Author:** Engineering Team
**Status:** Ready for Implementation
**Supersedes:** pos-approval-workflow-solution-design.md (v1.0 draft)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Scope and Phases](#2-scope-and-phases)
3. [Data Model](#3-data-model)
4. [Backend Architecture](#4-backend-architecture)
5. [Frontend Architecture](#5-frontend-architecture)
6. [Remote Approval — Detailed Flow](#6-remote-approval--detailed-flow)
7. [Offline Architecture](#7-offline-architecture)
8. [PIN Security — Revised Design](#8-pin-security--revised-design)
9. [Phase-by-Phase Implementation Tasks](#9-phase-by-phase-implementation-tasks)
10. [Files Affected](#10-files-affected)
11. [Testing Checklist](#11-testing-checklist)
12. [Open Questions](#12-open-questions)

---

## 1. Overview

POSpire currently controls sensitive POS actions (price changes, item deletions,
discounts) through binary on/off toggles on the POS Profile. A cashier either
has full access to an action or is completely blocked from it.

This feature introduces a third option — **"Allowed with Manager Approval"** —
where restricted actions pause and require a manager to authorise before
proceeding. Managers can approve:

- **On-site** — by entering a PIN on the cashier's terminal
- **Remotely** — via a real-time notification pushed to their Frappe Desk browser

Every approval or rejection is permanently recorded as an auditable document.
The system works fully **online** (Phases 1–3) and degrades gracefully to
**offline PIN-only** approval when the terminal has no network (Phase 5).

---

## 2. Scope and Phases

### In Scope

| Phase | Name | Deliverables |
|---|---|---|
| **1** | Foundation | DocTypes, custom fields, backend APIs, scheduler, before_submit enforcement |
| **2** | PIN Approval (Online) | PinEntry.vue, ApprovalDialog.vue, useApprovalWorkflow.js, Invoice/Pos/Payments wiring |
| **3** | Remote Approval (Online) | WebSocket push to manager desk, desk-side JS notification, resolution back to POS |
| **5** | Offline Approval | IndexedDB schema, Web Worker PIN verification, offline strategy, sync engine |

### Out of Scope (Future)

- **Phase 4** — Notification bell in POS Navbar, approval analytics report,
  visual condition builder UI, bulk approval for managers, mobile-optimised
  manager interface

### Why Not Frappe Workflow?

Frappe's built-in Workflow was evaluated and rejected:
- Operates at document level (entire invoice), not field level (individual rate change)
- Triggers on save — but POS cart edits are in-memory before any save
- Uses session authentication — PIN approval requires a *different* user to authorise
- Only one workflow per DocType — we need independent rules per action type
- Email-only notifications — no real-time push

---

## 3. Data Model

### 3.1 POS Approval Request (New Standalone DocType)

Core audit document. One record per approval event, permanently retained.

**Naming:** `POSA-AR-YY-NNNNNNN` (e.g. POSA-AR-26-0000001)

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `action_type` | Select | Delete Item, Edit Rate, Edit Item Discount, Edit Additional Discount, Void Invoice, Sales Return |
| `status` | Select | Pending, Approved, Rejected, Expired, Cancelled (read-only) |
| `pos_profile` | Link → POS Profile | Required |
| `pos_opening_shift` | Link → POS Opening Shift | |
| `requested_by` | Link → User | Auto = frappe.session.user |
| `requested_at` | Datetime | Auto = now() |
| `reason` | Small Text | Optional cashier note |
| `invoice` | Link → Sales Invoice | Set at submit time |
| `item_code` | Link → Item | Nullable |
| `item_name` | Data | Read-only |
| `original_value` | Currency | Value before change |
| `requested_value` | Currency | Value cashier wants |
| `value_field_label` | Data | e.g. "Rate", "Discount %" |
| `resolved_by` | Link → User | Read-only |
| `resolved_at` | Datetime | Read-only |
| `resolution_method` | Select | PIN, Remote, Auto-Expired, Offline-PIN, Offline-Expired |
| `resolution_note` | Small Text | Optional manager comment |
| `expires_at` | Datetime | Auto = requested_at + expiry_minutes |
| `request_payload` | JSON | Hidden, full context for server enforcement |
| `offline_id` | Data | Indexed, unique-if-set. Client UUID for offline records |
| `device_id` | Data | Terminal identifier |
| `offline_duration_seconds` | Int | Time between requested_at and synced_at |
| `synced_at` | Datetime | When offline record was accepted by server |
| `sync_validation_result` | Select | Accepted, Rejected |
| `sync_rejection_reason` | Small Text | |
| `client_clock_skew_seconds` | Int | Flags potential device time manipulation |

**Permissions:**
- POS User: create, read (own records only — no read of others' requests)
- POS Manager: read (all), write (resolve own approvals)
- System Manager: full

**track_changes:** enabled (version history for compliance)

---

### 3.2 POS Approval Action (New Child Table — parent: POS Profile)

Per-profile, per-action configuration row.

| Field | Type | Notes |
|---|---|---|
| `action_type` | Select | Same options as above |
| `approval_mode` | Select | Not Required, Required, Blocked |
| `condition` | Small Text | Python expression (optional). Empty = always required |
| `condition_js` | Small Text | Hidden. JS equivalent computed on save |
| `pin_approval` | Check | Allow on-site PIN approval |
| `remote_approval` | Check | Allow remote approval via desk |
| `expiry_minutes` | Int | Default 15. Minutes before auto-expire |
| `approver_role` | Link → Role | Which role can approve (e.g. POS Manager) |

**Condition examples:**

```python
action.change_percent > 10          # Rate reduced more than 10%
action.requested_value > 20         # Discount exceeds 20%
doc.grand_total > 10000             # Invoice total above threshold
action.original_value > 5000        # Deleting high-value item
doc.customer_group == "VIP" and action.change_percent > 5
doc.is_return and doc.grand_total < -25000
```

---

### 3.3 POS Manager PIN (New Standalone DocType)

Stores hashed PINs for managers. **Raw PIN is never stored or visible.**

| Field | Type | Notes |
|---|---|---|
| `user` | Link → User | Unique — one PIN per user. Used as document name |
| `pin_hash` | Password | werkzeug PBKDF2 hash. **Hidden in form** |
| `is_active` | Check | Default 1 |

**Form visible fields (System Manager only):** `user`, `is_active`
**`pin_hash`** is hidden from the form entirely — only the controller reads/writes it.

**Permissions:** System Manager only (read, write, create, delete)

---

### 3.4 Custom Fields on POS Profile (via fixture)

Three new fields added to `custom_field.json`:

| Fieldname | Type | Label | Position |
|---|---|---|---|
| `posa_approval_workflow_tab` | Tab Break | Approval Workflow | After custom_advance_settings tab |
| `posa_enable_approval_workflow` | Check | Enable Approval Workflow | Under above tab |
| `posa_approval_actions` | Table | Approval Actions | Links to POS Approval Action |

---

## 4. Backend Architecture

### 4.1 New File: `pospire/pospire/api/approval.py`

All endpoints use `@frappe.whitelist()` with full type hints (semgrep enforced).

---

#### `get_approval_config`

```
Purpose : Load full approval config for a POS Profile.
          Called once at POS session start. Cached in frontend memory.
Called by: Frontend on POS load
Returns  : {
    enabled: bool,
    actions: [{ action_type, approval_mode, condition, condition_js,
                pin_approval, remote_approval, expiry_minutes, approver_role }],
    managers: [{ user, full_name, pin_hash, pin_hash_expires_at }]
}
Note: pin_hash included so frontend can seed IndexedDB for offline use.
      condition_js included for offline condition evaluation.
```

---

#### `evaluate_approval_condition`

```
Purpose : Server-side condition evaluation via frappe.safe_eval.
          Called before showing the approval dialog.
Called by: Frontend (online strategy)
Params  : pos_profile (str), action_type (str),
          doc_context (str — JSON), action_context (str — JSON)
Returns : { required: bool, mode: str, pin_allowed: bool,
            remote_allowed: bool, condition_met: bool }
Behaviour:
  - mode = Not Required → { required: false }
  - mode = Blocked → { required: true, mode: "Blocked" }
  - mode = Required, no condition → { required: true, condition_met: true }
  - mode = Required, condition set → frappe.safe_eval():
      True  → { required: true }
      False → { required: false }
      Error → { required: true } (fail-safe, not fail-open)
Security: doc/action passed as plain dicts to safe_eval.
          No document fetching or mutation in this call.
```

**Safe globals whitelist:**

```python
def get_approval_safe_globals() -> dict:
    return {
        "flt": frappe.utils.flt,
        "cint": frappe.utils.cint,
        "abs": abs,
        "round": round,
        "int": int,
        "float": float,
        "len": len,
        "frappe": frappe._dict(
            utils=frappe._dict(
                now_datetime=frappe.utils.now_datetime,
                nowdate=frappe.utils.nowdate,
                getdate=frappe.utils.getdate,
            ),
            db=frappe._dict(get_value=frappe.db.get_value),
        ),
    }
```

No access to: imports, file I/O, exec, eval, os, subprocess.
Enforced by RestrictedPython at AST level.

---

#### `create_approval_request`

```
Purpose : Create a new POS Approval Request when cashier triggers restricted action.
Called by: Frontend (both online and offline sync)
Params  : pos_profile, action_type, pos_opening_shift,
          invoice (opt), item_code (opt), item_name (opt),
          original_value (opt), requested_value (opt),
          value_field_label (opt), reason (opt),
          request_payload (opt JSON),
          offline_id (opt) — if set, idempotent: returns existing doc if found
          device_id (opt)
Returns : POS Approval Request dict
Side effects:
  Online: if remote_approval enabled on action config,
          publishes WebSocket event to all users with approver_role
  Offline sync: no WebSocket — just creates the DB record
```

WebSocket push to manager:

```python
frappe.publish_realtime(
    event="pos_approval_request",
    message={
        "request_name": doc.name,
        "action_type": doc.action_type,
        "item_code": doc.item_code,
        "item_name": doc.item_name,
        "original_value": doc.original_value,
        "requested_value": doc.requested_value,
        "requested_by": doc.requested_by,
        "requested_by_full_name": frappe.db.get_value("User", doc.requested_by, "full_name"),
        "pos_profile": doc.pos_profile,
        "expires_at": str(doc.expires_at),
    },
    user=manager_user  # one call per eligible manager
)
```

---

#### `verify_pin_and_approve`

```
Purpose : Verify manager PIN and approve request in one step (on-site flow).
Called by: Frontend PIN submission
Params  : request_name (str), pin (str), manager_user (str)
Returns : { status: "Approved", request_name: str }
Security:
  - Rate limit: 5 wrong attempts → 15-min lockout, tracked via frappe.cache (Redis)
  - Validates manager_user has required approver_role from POS Profile config
  - Validates manager_user != requested_by (no self-approval)
  - PIN verified with werkzeug.security.check_password_hash
  - Lockout keyed on (request_name, manager_user) — not bypassable by new request
```

---

#### `resolve_approval_request`

```
Purpose : Approve or reject a request from manager's desk (remote flow).
Called by: Manager's desk browser (desk-side JS)
Params  : request_name (str), action (str — "Approved" or "Rejected"),
          resolution_note (str, opt)
Returns : { status: str, request_name: str }
Validates:
  - frappe.session.user has approver_role
  - frappe.session.user != requested_by
  - Request is still Pending and not expired
Side effects:
  Publishes pos_approval_resolved back to cashier:
    frappe.publish_realtime(
        event="pos_approval_resolved",
        message={ request_name, status, resolved_by, resolved_by_name, resolution_note },
        user=requested_by  # cashier's user
    )
```

---

#### `get_pending_approvals`

```
Purpose : Fetch pending requests for manager's queue.
Called by: Manager's desk list view / widget
Params  : pos_profile (str, opt)
Returns : List of pending POS Approval Request dicts (excludes expired)
```

---

#### `regenerate_pin`

```
Purpose : Auto-generate a new PIN for a manager, hash it, email the manager.
          Replaces the old set_manager_pin endpoint.
Called by: System Manager via "Regenerate PIN" button on POS Manager PIN form
Params  : user (str)
Returns : { success: True }
Security:
  - Only callable by System Manager role
  - Generates random 4-6 digit PIN internally
  - Hashes immediately with werkzeug PBKDF2
  - Sends plaintext PIN to manager via email (frappe.sendmail)
  - Plaintext PIN discarded — never returned in response, never logged
```

---

#### `get_managers_for_approval`

```
Purpose : Get dropdown list of managers eligible to approve for an action.
Called by: Frontend manager selection dropdown
Params  : pos_profile (str), action_type (str)
Returns : [{ user, full_name }]
          — users with approver_role AND is_active PIN
```

---

#### `get_approval_request_status`

```
Purpose : Lightweight polling for reconnection catch-up.
Called by: Frontend on WebSocket reconnect (check if resolution missed during disconnect)
Params  : request_name (str)
Returns : { status, resolved_by, resolved_by_name, resolution_note }
```

---

#### `sync_offline_approval_requests` (Phase 5)

```
Purpose : Bulk upload of offline approval records on reconnect.
Called by: Sync engine (Web Worker) after network restores
Params  : requests (str — JSON array of offline approval objects)
Returns : [{ offline_id, server_name, accepted: bool, reason: str }]
Validates each:
  - Manager exists and has approver_role
  - POS Profile config still has action_type as Required
  - Not expired — uses MAX(expiry_minutes, offline_duration) capped at 8 hours
  - No duplicate offline_id (idempotent — safe to retry on partial failure)
  - original_value / requested_value plausible against POS Profile config
  - Clock skew logged (server_time - client requested_at)
```

---

#### `expire_stale_requests` (Scheduler Job)

```python
# Called every 5 minutes via hooks.py scheduler_events
def expire_stale_requests() -> None:
    expired = frappe.get_all(
        "POS Approval Request",
        filters={"status": "Pending", "expires_at": ["<", frappe.utils.now()]},
        pluck="name",
    )
    for name in expired:
        doc = frappe.get_doc("POS Approval Request", name)
        doc.status = "Expired"
        doc.resolution_method = "Auto-Expired"
        doc.save(ignore_permissions=True)
        frappe.publish_realtime(
            event="pos_approval_resolved",
            message={"request_name": name, "status": "Expired"},
            user=doc.requested_by,
        )
    frappe.db.commit()  # nosemgrep: frappe-manual-commit -- scheduler job, no request context
```

---

### 4.2 Modifications to `pospire/pospire/api/invoice.py`

Add to `before_submit`:

```python
def before_submit(doc, method=None):
    validate_shift(doc)
    validate_approval_requests(doc)  # NEW
    # ... existing logic ...

def validate_approval_requests(doc) -> None:
    if not frappe.db.get_value("POS Profile", doc.pos_profile,
                                "posa_enable_approval_workflow"):
        return

    data = frappe.parse_json(doc.get("posa_submit_data") or "{}")
    submitted_requests = data.get("approved_requests", [])

    config = _get_approval_config(doc.pos_profile)
    # Check each Required action that was performed on this invoice
    # against the submitted approved_requests list.
    # Block submission if any required approval is missing or invalid.
```

Server-side enforcement: frontend bypass prevention. Even if a malicious client
skips the approval dialog, the invoice will not submit without a valid
`POS Approval Request` in `Approved` status.

---

### 4.3 Modifications to `pospire/hooks.py`

```python
scheduler_events = {
    "*/5 * * * *": [
        "pospire.pospire.api.approval.expire_stale_requests",
    ],
}

fixtures = [
    "Custom Field",
    "Property Setter",
    # ADD:
    "POS Approval Action",   # child table (exports with POS Profile)
]

# Desk-side JS for manager approval notifications
app_include_js = [
    "/assets/pospire/js/pos_approval_desk.js",
]
```

---

### 4.4 `POS Manager PIN` Controller (`pos_manager_pin.py`)

```python
from werkzeug.security import generate_password_hash
import random
import string

def before_insert(doc, method=None):
    _generate_and_dispatch_pin(doc)

def before_save(doc, method=None):
    if not doc.is_new() and doc.has_value_changed("user"):
        _generate_and_dispatch_pin(doc)

def _generate_and_dispatch_pin(doc) -> None:
    pin = _generate_pin(length=6)
    doc.pin_hash = generate_password_hash(pin)
    _send_pin_email(doc.user, pin)
    # pin goes out of scope — never stored, never returned

def _generate_pin(length: int = 6) -> str:
    return "".join(random.choices(string.digits, k=length))

def _send_pin_email(user: str, pin: str) -> None:
    full_name = frappe.db.get_value("User", user, "full_name") or user
    frappe.sendmail(
        recipients=[user],
        subject=_("Your POSpire Manager PIN"),
        template="pos_manager_pin_notification",
        args={"full_name": full_name, "pin": pin},
        now=True,
    )
```

**Email Template** (`pos_manager_pin_notification`):

```
Subject: Your POSpire Manager PIN

Hi {{ full_name }},

A POS Manager PIN has been created for your account.

Your PIN: {{ pin }}

You will need this PIN to authorise manager-level actions at the POS
terminal. Please keep it confidential.

If you did not expect this email, contact your system administrator
immediately.

— POSpire
```

**"Regenerate PIN" custom button** on the form (via `pos_manager_pin.js`):

```js
frappe.ui.form.on("POS Manager PIN", {
    refresh(frm) {
        if (!frm.is_new()) {
            frm.add_custom_button(__("Regenerate PIN"), () => {
                frappe.confirm(
                    __("This will invalidate the existing PIN and email a new one to {0}. Continue?",
                       [frm.doc.user]),
                    () => frappe.call({
                        method: "pospire.pospire.api.approval.regenerate_pin",
                        args: { user: frm.doc.user },
                        callback: () => frappe.msgprint(__("New PIN sent to {0}", [frm.doc.user])),
                    })
                )
            })
        }
    },
})
```

---

## 5. Frontend Architecture

### 5.1 New: `composables/useApprovalWorkflow.js`

Creates the `composables/` directory (does not exist yet).

**Public interface:**

```js
const { requireApproval, getApprovedRequests, loadConfig } = useApprovalWorkflow()

// Called once on POS session start
await loadConfig(posProfile)

// Called before each restricted action
const approved = await requireApproval("Edit Rate", {
    doc: { grand_total: 2500, customer: "CUST-001", ... },
    action: { original_value: 1000, requested_value: 750,
               change_percent: 25, item_code: "ITEM-001" }
})
if (!approved) return  // revert action

// Called at submit time — passed to backend
const approved_requests = getApprovedRequests()
// → ["POSA-AR-26-0000001", "POSA-AR-26-0000002"]
```

**Internal strategy routing:**

```js
function requireApproval(actionType, context) {
    const strategy = navigator.onLine ? onlineStrategy : offlineStrategy
    return strategy.requireApproval(actionType, context)
}
```

**Online strategy:**
1. `frappe.call evaluate_approval_condition` → if not required, resolve `true`
2. Emit `show_approval_dialog` on eventBus with action details
3. Return `Promise` that resolves when `approval_resolved` fires on eventBus
4. Accumulate `approved_requests[]` with server name

**Offline strategy (Phase 5):**
1. `evaluateConditionLocally(conditionJs, doc, action)` using `expr-eval`
2. Emit `show_approval_dialog` with `offlineMode: true`
3. Verify PIN via Web Worker → Web Crypto API
4. Store approval in IndexedDB with `offline_id`
5. Accumulate `approved_requests[]` with `offline_id`

**Offline strategy stub (Phases 1–3):**

```js
const offlineStrategy = {
    requireApproval() {
        throw new Error("Offline approval not yet supported. Connect to network.")
    }
}
```

---

### 5.2 New: `components/pos/PinEntry.vue`

Reusable numeric keypad component.

```
Props : length (Number, default 6) — expected PIN length
Emits : pin-complete(pin: String)
        pin-clear()

Layout:
  ┌───────────────────────┐
  │  ● ● ● ● ● ●  (dots) │
  ├───┬───┬───┤           │
  │ 1 │ 2 │ 3 │           │
  ├───┼───┼───┤           │
  │ 4 │ 5 │ 6 │           │
  ├───┼───┼───┤           │
  │ 7 │ 8 │ 9 │           │
  ├───┼───┼───┤           │
  │CLR│ 0 │ ⌫ │           │
  └───┴───┴───┘           │
```

Auto-submits (`pin-complete`) when `length` digits entered.
Scoped Vuetify 3 styles consistent with existing POS theme.

---

### 5.3 New: `components/pos/ApprovalDialog.vue`

Multi-state dialog. State machine:

```
choose_method
    ├── [PIN selected]
    │       └── pin_entry
    │               ├── verifying (API call in flight)
    │               │       ├── approved  ✓  (auto-close 1.2s)
    │               │       └── rejected  ✗
    │               └── locked  🔒 (too many attempts)
    │
    └── [Remote selected]
            └── waiting_remote  (spinner + countdown)
                    ├── approved  ✓  (via WebSocket)
                    ├── rejected  ✗  (via WebSocket)
                    ├── expired   ⏰  (via WebSocket)
                    └── waiting_remote_degraded  ⚠️  (network lost)
                            ├── → pin_entry  (switch to PIN)
                            └── → cancelled
```

**Key behaviours:**

- Persistent `v-dialog` — cannot be dismissed by clicking outside
- Registers `frappe.realtime.on("pos_approval_resolved", ...)` on enter `waiting_remote`
- Unregisters on unmount (always — prevents ghost listeners)
- Request name guard: ignores events for other requests
- `navigator.onLine` listener: transitions to `waiting_remote_degraded` if network drops
- On reconnect: calls `get_approval_request_status` once to catch missed resolution
- Emits `approval-resolved` via mitt eventBus on success

**Props:**
```js
actionType       : String   // "Edit Rate"
actionLabel      : String   // "Rate Change — Widget A"
originalValue    : Number
requestedValue   : Number
itemName         : String
posProfile       : String
posOpeningShift  : String
allowPin         : Boolean
allowRemote      : Boolean
offlineMode      : Boolean  // hides remote option, used in Phase 5
```

**Emits:** `approval-resolved({ approved: bool, requestName: str })`

---

### 5.4 New: `public/js/pos_approval_desk.js`

Desk-side JS bundle. Loaded for all logged-in Frappe Desk users via `app_include_js`.

Responsibilities:
- Register `frappe.realtime.on("pos_approval_request", ...)` globally
- Show toast notification with Approve/Reject buttons when event received
- Call `resolve_approval_request` on button click
- Show fallback list view link: "View all pending POS approvals"

```js
// pos_approval_desk.js
frappe.ready(() => {
    frappe.realtime.on("pos_approval_request", (data) => {
        show_approval_toast(data)
    })
})

function show_approval_toast(data) {
    // Vuetify-free — plain Frappe toast (frappe.show_alert style)
    // Contains: action label, item, value change, cashier name
    // Two buttons: Approve (green) / Reject (red)
    // Auto-dismiss in 15 minutes (matches expiry)
}
```

---

### 5.5 Modified: `components/pos/Invoice.vue`

Wrap four existing action handlers with approval gates.

```js
// Import composable
const { requireApproval } = useApprovalWorkflow()

// 1. remove_item — gates on "Delete Item"
async remove_item(item) {
    const approved = await requireApproval("Delete Item", {
        doc: this.get_doc_context(),
        action: {
            action_type: "Delete Item",
            item_code: item.item_code,
            original_value: item.rate * item.qty,
            requested_value: 0,
            change_amount: item.rate * item.qty,
            change_percent: 100,
        }
    })
    if (!approved) return
    // ... existing remove logic unchanged ...
}

// 2. Rate change — gates on "Edit Rate"
// Capture original rate on focus, gate on blur/confirm
async handle_rate_change(item, newRate) {
    const approved = await requireApproval("Edit Rate", {
        doc: this.get_doc_context(),
        action: {
            action_type: "Edit Rate",
            item_code: item.item_code,
            original_value: item._original_rate,
            requested_value: newRate,
            change_amount: Math.abs(newRate - item._original_rate),
            change_percent: Math.abs((newRate - item._original_rate) / item._original_rate * 100),
        }
    })
    if (!approved) { item.rate = item._original_rate; return }
    // ... existing rate update logic ...
}

// 3. handleDiscountPercentageChange — gates on "Edit Item Discount"
// 4. Additional discount change — gates on "Edit Additional Discount"
// Same pattern as above
```

`get_doc_context()` — helper that builds the `doc` dict from current invoice state:
```js
get_doc_context() {
    return {
        grand_total: this.invoice_doc.grand_total,
        net_total: this.invoice_doc.net_total,
        total_qty: this.invoice_doc.total_qty,
        discount_amount: this.invoice_doc.discount_amount,
        additional_discount_percentage: this.invoice_doc.additional_discount_percentage,
        customer: this.invoice_doc.customer,
        customer_group: this.invoice_doc.customer_group,
        pos_profile: this.invoice_doc.pos_profile,
        is_return: this.invoice_doc.is_return ? 1 : 0,
        currency: this.invoice_doc.currency,
    }
}
```

---

### 5.6 Modified: `components/pos/Pos.vue`

Mount `<ApprovalDialog>` alongside existing modals:

```html
<template>
    <!-- existing modals -->
    <CouponsModal ... />
    <OffersModal ... />

    <!-- NEW -->
    <ApprovalDialog
        v-if="approvalDialogVisible"
        v-bind="approvalDialogProps"
        @approval-resolved="onApprovalResolved"
    />
</template>
```

Wire eventBus:
```js
import mitt from "mitt"
const emitter = inject("emitter")

onMounted(() => {
    emitter.on("show_approval_dialog", (props) => {
        approvalDialogProps.value = props
        approvalDialogVisible.value = true
    })
    emitter.on("approval_resolved", (result) => {
        approvalDialogVisible.value = false
    })
})
```

---

### 5.7 Modified: `components/pos/Payments.vue`

Pass accumulated approved requests on submit:

```js
async submit_invoice(print) {
    const response = await frappe.call({
        method: "pospire.pospire.api.posapp.submit_invoice",
        args: {
            invoice: this.invoice_doc.name,
            data: JSON.stringify({
                ...this.existing_data,
                approved_requests: approvalHelper.getApprovedRequests(),
                // ["POSA-AR-26-0000001", "POSA-AR-26-0000002"]
                // or offline: ["OFFLINE-AR-uuid1", "OFFLINE-AR-uuid2"]
            }),
        },
    })
    // ... existing handling ...
}
```

---

## 6. Remote Approval — Detailed Flow

### Architecture

```
POS Terminal (cashier)         Redis PubSub            Manager's Browser
   Vue SPA                   (Frappe backbone)          Frappe Desk
      │                            │                        │
      │  [WebSocket connected]     │            [WebSocket connected]
      │                            │                        │
      │──create_approval_request──>│                        │
      │              publish_realtime(user=manager)────────>│
      │                            │                        │
      │  <waiting spinner>         │           [toast: Approve / Reject]
      │                            │                        │
      │                            │<──resolve_approval()───│
      │              publish_realtime(user=cashier)         │
      │<─────pos_approval_resolved─│                        │
      │                            │                        │
   [✓ Approved — dialog closes]    │                        │
```

### WebSocket Routing

`frappe.publish_realtime(event, message, user=X)` sends the event **only to
all active WebSocket connections authenticated as user X**. If the manager has
multiple tabs open, all tabs receive the notification. Routing is by user
identity, not connection ID — reconnected browsers still receive correctly.

### Request Name Guard

`ApprovalDialog.vue` ignores resolved events for other requests:

```js
handleResolution(data) {
    if (data.request_name !== this.currentRequestName) return
    // ... process resolution ...
}
```

### Edge Cases

| Scenario | Behaviour |
|---|---|
| Manager closes toast without acting | Stays Pending. Scheduler auto-expires. `pos_approval_resolved` with `Expired` pushed to cashier. |
| Manager goes offline mid-review | Stays Pending. Cashier sees countdown. Auto-expires on schedule. |
| Cashier cancels while waiting | Frontend calls `resolve_approval_request(action: "Cancelled")`. Action reverted. |
| POS loses WebSocket mid-wait | `frappe.realtime` auto-reconnects. Frontend calls `get_approval_request_status` once to catch missed resolution. |
| Two managers both click Approve | First wins — sets Approved. Second call finds status ≠ Pending, returns graceful error. |
| Manager doesn't have Desk open | Event queued in Redis. Notified on next Desk login. Cashier sees countdown timer. Can cancel/switch to PIN. |

---

## 7. Offline Architecture

### 7.1 What Works Offline vs What Doesn't

| Capability | Online | Offline |
|---|---|---|
| Condition evaluation | Server — `frappe.safe_eval` (Python) | Client — `expr-eval` (JS) using `condition_js` |
| PIN verification | Server — werkzeug PBKDF2 | Web Worker — Web Crypto API PBKDF2 |
| Approval request creation | Server → DB | Client → IndexedDB |
| Remote approval | WebSocket realtime | NOT AVAILABLE — PIN only |
| Request expiry | Server scheduler (5 min) | Client timer (60s check) |
| Server-side enforcement | `before_submit` validates DB | Deferred to sync time |

### 7.2 Strategy Pattern

`useApprovalWorkflow.js` routes transparently:

```js
function requireApproval(actionType, context) {
    const strategy = navigator.onLine ? onlineStrategy : offlineStrategy
    return strategy.requireApproval(actionType, context)
}
```

`Invoice.vue` never changes. It always calls `requireApproval()` — the strategy
decides how to fulfil it.

### 7.3 Condition Evaluation Offline

Conditions are Python expressions. For offline, a JS equivalent is precomputed.

**`condition_js` computed on `POS Approval Action` save:**

```python
def _normalize_to_js(expr: str) -> str:
    return (expr
        .replace(" and ", " && ")
        .replace(" or ", " || ")
        .replace("not ", "!")
        .replace("True", "true")
        .replace("False", "false"))
```

**Client-side evaluation using `expr-eval` (no `eval()`):**

```js
import { Parser } from "expr-eval"

function evaluateConditionLocally(conditionJs, doc, action) {
    try {
        const parser = new Parser()
        return parser.evaluate(conditionJs, {
            doc, action,
            flt: parseFloat, cint: parseInt, abs: Math.abs,
        })
    } catch (e) {
        // Fail-safe: condition error → approval required
        return true
    }
}
```

**Allowed condition syntax** (valid in both Python and JS):
- Operators: `> < >= <= == != && || ! + - * / %`
- Functions: `flt()`, `cint()`, `abs()`, `round()`, `int()`, `float()`, `len()`
- Identifiers: `doc.*`, `action.*`, `true`, `false`
- NOT allowed: list comprehensions, imports, method calls beyond whitelist

### 7.4 IndexedDB Schema (Dexie.js)

```js
// pospire_offline.js
const db = new Dexie("pospire_offline")

db.version(1).stores({
    manager_pins:
        "user, cached_at, expires_at",

    approval_requests:
        "offline_id, server_name, action_type, status, " +
        "invoice_offline_id, sync_status, requested_at",

    pin_attempts:
        "user, attempts, locked_until",
})
```

**`manager_pins` record:**
```js
{
    user: "manager@store.com",
    full_name: "John Manager",
    pin_hash: "pbkdf2:sha256:600000$salt$hash",
    cached_at: "2026-04-02T09:00:00",
    expires_at: "2026-04-03T09:00:00",   // 24h TTL (configurable)
}
```

**`approval_requests` record:**
```js
{
    offline_id: "OFFLINE-AR-<uuidv4>",
    server_name: null,                    // set after sync
    action_type: "Edit Rate",
    status: "Approved",
    resolution_method: "Offline-PIN",
    invoice_offline_id: "OFFLINE-INV-<uuid>",
    device_id: "DEVICE-<uuid>",
    requested_by: "cashier@store.com",
    requested_at: "2026-04-02T14:30:00",
    resolved_by: "manager@store.com",
    resolved_at: "2026-04-02T14:31:00",
    original_value: 1000,
    requested_value: 750,
    expires_at: "2026-04-02T14:45:00",
    synced_at: null,
    sync_status: "pending",               // pending | synced | rejected
    sync_rejection_reason: null,
    request_payload: { doc: {...}, action: {...} },
}
```

### 7.5 Web Worker PIN Verification

PIN verification runs in a **Web Worker** — off the main thread. PBKDF2 with
600,000 iterations is CPU-intensive and would freeze the UI on the main thread.

```
ApprovalDialog (main thread)
    │
    │  postMessage({
    │      type: "VERIFY_PIN",
    │      pin: "123456",
    │      manager: "manager@store.com"
    │  })
    │
    ▼
pinVerifier.worker.js
    │
    ├── Load pin record from IndexedDB
    │       Check expires_at — if expired, reject with HASH_EXPIRED
    │
    ├── Check pin_attempts in IndexedDB
    │       If locked_until > now → reject with LOCKED
    │
    ├── Parse hash string: "pbkdf2:sha256:600000$<salt>$<hash>"
    │
    ├── crypto.subtle.importKey("raw", pin_bytes, "PBKDF2", false, ["deriveBits"])
    │
    ├── crypto.subtle.deriveBits(
    │       { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    │       keyMaterial, 256
    │   )
    │
    ├── Constant-time compare: derivedHash == storedHash
    │
    ├── Wrong PIN:
    │       increment attempts in IndexedDB
    │       if attempts >= 5: set locked_until = now + 15min
    │       → { verified: false, locked: false, attempts_left: N }
    │         or { verified: false, locked: true, locked_until }
    │
    └── Correct PIN:
            clear attempts in IndexedDB
            → { verified: true }
    │
    postMessage(result)
    │
    ▼
ApprovalDialog (main thread)
    │
    ├── verified = true:
    │       Create approval_requests record in IndexedDB
    │       Emit approval-resolved
    │
    └── verified = false:
            Show error, update attempt counter UI
```

### 7.6 PIN Hash TTL Enforcement

PIN hashes expire after 24 hours (configurable). After expiry, the worker
returns `HASH_EXPIRED`:

```
ApprovalDialog shows:
"Cannot verify PIN offline — manager PIN cache has expired.
 Please connect to network to refresh, then retry."
```

The dialog offers: "Cancel action" or "Keep waiting (reconnect)".

PIN changes on the server take effect within the TTL window — maximum 24 hours
delay for offline terminals.

### 7.7 Offline During Remote Approval Wait

If the POS goes offline while already waiting for remote approval:

```
ApprovalDialog: waiting_remote
    │
    window.addEventListener("offline", handleNetworkLoss)
    │
    handleNetworkLoss() → state = "waiting_remote_degraded"
```

Cashier sees:

```
┌──────────────────────────────────────────────┐
│  ⚠️  Network Lost                            │
│                                              │
│  Remote approval is no longer available.     │
│  The pending request will be cancelled.      │
│                                              │
│  What would you like to do?                  │
│                                              │
│  [ 🔢  Switch to PIN Approval ]              │
│  [ ✕   Cancel — revert action ]              │
│  [ ⏳  Keep Waiting (reconnect) ]            │
└──────────────────────────────────────────────┘
```

- **Switch to PIN:** Cancels the remote request (backend updated on reconnect),
  transitions to `pin_entry` using `offlineStrategy` with cached PIN hash.
- **Cancel:** Action reverted. On reconnect, cancels the server record.
- **Keep Waiting:** On WebSocket reconnect, calls `get_approval_request_status`
  once. If the manager responded during disconnect, resolution applied.

### 7.8 Sync Protocol on Reconnect

**Critical ordering rule: approvals sync BEFORE invoices.**
`before_submit` validates approved requests exist — so they must be in the DB
before the invoice upload attempt.

```
Network returns
    │
    ▼
Sync Engine (Web Worker)
    │
    ├── Step 1: Upload offline approval_requests
    │     POST sync_offline_approval_requests([...])
    │
    │     Server validates each:
    │       ✓ Manager user exists and has approver_role
    │       ✓ POS Profile config still has action_type as Required
    │       ✓ Not expired: MAX(expiry_minutes, offline_duration) ≤ 8h cap
    │       ✓ No duplicate offline_id (idempotent — safe to retry)
    │       ✓ original_value / requested_value plausible
    │       ✓ Clock skew logged (server_time - client requested_at)
    │
    │     Server returns:
    │       [{ offline_id, server_name, accepted: true  },
    │        { offline_id, accepted: false, reason: "Manager deactivated" }]
    │
    ├── Step 2: Update IndexedDB
    │     accepted → { server_name, synced_at, sync_status: "synced" }
    │     rejected → { sync_status: "rejected", sync_rejection_reason }
    │                  linked invoice → sync_blocked = true
    │                  alert cashier (see below)
    │
    ├── Step 3: Upload invoices
    │     invoices where sync_blocked = false → upload with server_names
    │     invoices where sync_blocked = true  → SKIPPED, flagged in UI
    │
    └── Step 4: Download config updates
          PIN hash refreshes, approval config changes, new managers
```

### 7.9 Sync Rejection — User Notification

```
┌────────────────────────────────────────────────────┐
│  ⚠️  Sync Issue — Manager Review Required          │
│                                                    │
│  An approval for "Edit Rate" on Invoice            │
│  #OFFLINE-INV-abc123 was rejected by the server.   │
│                                                    │
│  Reason: Approving manager account was deactivated │
│                                                    │
│  This invoice cannot be submitted automatically.   │
│  Please contact your store manager to resolve.     │
│                                                    │
│  [ View Invoice ]                                  │
└────────────────────────────────────────────────────┘
```

**No auto-cancellation of completed sales.** The invoice stays in the offline
queue as `sync_blocked = true`. A manager with system access manually reviews
and either resubmits with a fresh online approval or voids the invoice.

### 7.10 Offline Audit Trail

Offline approvals are distinctly marked:

| Field | Online value | Offline value |
|---|---|---|
| `resolution_method` | PIN / Remote | **Offline-PIN** / **Offline-Expired** |
| `offline_id` | null | OFFLINE-AR-uuid |
| `device_id` | null | DEVICE-uuid |
| `offline_duration_seconds` | null | seconds between requested_at and synced_at |
| `sync_validation_result` | null | Accepted / Rejected |
| `client_clock_skew_seconds` | null | server_time - client requested_at |

Example audit queries:
- `resolution_method IN (Offline-PIN, Offline-Expired)` → all offline approvals
- `offline_duration_seconds > 14400` → approvals where device was offline > 4 hours
- `sync_validation_result = Rejected` → fraud indicators

---

## 8. PIN Security — Revised Design

### Core Principle

**Neither the System Manager nor anyone with DB access ever knows a manager's PIN.**
The only person who sees the plaintext PIN is the manager, in the email.

### Flow

```
System Manager             System                        Manager
    │                        │                              │
    │── Creates doc,         │                              │
    │   fills user field ───>│                              │
    │                        │── Generate random PIN        │
    │                        │   (6 digits, secrets.choice) │
    │                        │── Hash (werkzeug PBKDF2)     │
    │                        │── Store ONLY hash            │
    │                        │── Send email ───────────────>│
    │                        │── Discard plaintext          │── Receives PIN
    │<── Sees: user,         │                              │   in email only
    │    is_active only      │                              │
    │    (no PIN, no hash)   │                              │
```

### What System Manager Can Do

| Action | Available |
|---|---|
| Create PIN for a manager | ✅ (fills user field only) |
| See the PIN | ❌ (hidden from form and API) |
| See the hash | ❌ (hidden from form) |
| Regenerate PIN | ✅ (button on form — sends new email) |
| Deactivate PIN | ✅ (uncheck is_active) |
| Delete PIN record | ✅ |

### Rate Limiting

**Online:** 5 failed attempts per approval request → 15-minute lockout.
Tracked in `frappe.cache` (Redis). Keyed on `(request_name, manager_user)`.

**Offline:** Same counters in IndexedDB `pin_attempts` table.
Keyed on `(user)` — per terminal, per manager.
Lockout: `locked_until = now + 15min`.

---

## 9. Phase-by-Phase Implementation Tasks

---

### Phase 1 — Foundation

**Goal:** All backend infrastructure ready. Testable via `bench console` and HTTP.

#### 1.1 DocTypes

- [ ] Create `POS Approval Action` child DocType JSON + controller (`__init__.py`, `.py`, `.json`)
  - Fields: `action_type`, `approval_mode`, `condition`, `condition_js`,
    `pin_approval`, `remote_approval`, `expiry_minutes`, `approver_role`
  - Controller: `before_save` → compute `condition_js` via `_normalize_to_js`

- [ ] Create `POS Manager PIN` DocType JSON + controller
  - Fields: `user` (unique, name field), `pin_hash` (hidden), `is_active`
  - Controller: `before_insert` + `before_save` → `_generate_and_dispatch_pin`
  - Email template: `pos_manager_pin_notification`
  - Form JS: `Regenerate PIN` custom button

- [ ] Create `POS Approval Request` DocType JSON + controller
  - All fields including offline-ready fields (`offline_id`, `device_id`, etc.)
  - `resolution_method` options include: PIN, Remote, Auto-Expired, Offline-PIN, Offline-Expired
  - `track_changes = 1`
  - Permissions: POS User (create, read own), POS Manager (read all), System Manager (full)

#### 1.2 Custom Fields

- [ ] Add 3 entries to `pospire/fixtures/custom_field.json`:
  - `posa_approval_workflow_tab` (Tab Break on POS Profile)
  - `posa_enable_approval_workflow` (Check on POS Profile)
  - `posa_approval_actions` (Table → POS Approval Action on POS Profile)

#### 1.3 Backend APIs

- [ ] Create `pospire/pospire/api/approval.py` with all 8 endpoints:
  - `get_approval_config`
  - `evaluate_approval_condition` + `get_approval_safe_globals`
  - `create_approval_request`
  - `verify_pin_and_approve`
  - `resolve_approval_request`
  - `get_pending_approvals`
  - `regenerate_pin`
  - `get_managers_for_approval`
  - `get_approval_request_status`
  - `expire_stale_requests` (scheduler)
  - `sync_offline_approval_requests` (Phase 5 — stub returning empty list for now)

#### 1.4 Hooks

- [ ] Add `scheduler_events` to `hooks.py`
- [ ] Add DocType names to `fixtures` tuple in `hooks.py`
- [ ] Add `app_include_js` entry for `pos_approval_desk.js`

#### 1.5 Invoice Enforcement

- [ ] Add `validate_approval_requests(doc)` to `invoice.py:before_submit`
- [ ] Add `posa_submit_data` custom field to Sales Invoice (stores `approved_requests` JSON) — or pass via existing `data` param

#### 1.6 Verify

```bash
bench --site <site> migrate
bench --site <site> console
# Create POS Manager PIN → verify email sent, pin_hash set, hash not logged
# Create POS Approval Request → verify naming pattern
# Call approval APIs via frappe.call in browser console
```

---

### Phase 2 — PIN Approval (Online)

**Goal:** Full end-to-end PIN approval flow testable in the POS.

#### 2.1 New Frontend Files

- [ ] Create `pospire/public/js/posapp/composables/useApprovalWorkflow.js`
  - `loadConfig(posProfile)` — calls `get_approval_config`, stores in session
  - `requireApproval(actionType, context)` — strategy pattern
  - `getApprovedRequests()` — returns accumulated names
  - `onlineStrategy` — full implementation
  - `offlineStrategy` — stub (throws "not supported")

- [ ] Create `components/pos/PinEntry.vue`
  - 3×4 keypad, masked dots, `pin-complete` emit

- [ ] Create `components/pos/ApprovalDialog.vue`
  - All states: `choose_method`, `pin_entry`, `verifying`, `approved`, `rejected`, `locked`
  - Remote states stubbed (visible but inactive until Phase 3)
  - `navigator.onLine` listener wired (no offline state yet)
  - `frappe.realtime` listener wired (no-op until Phase 3)

#### 2.2 Modified Frontend Files

- [ ] `Invoice.vue` — wrap 4 handlers:
  - `remove_item` → approval gate ("Delete Item")
  - Rate change handler → approval gate ("Edit Rate") — capture `_original_rate` on focus
  - `handleDiscountPercentageChange` → approval gate ("Edit Item Discount")
  - Additional discount field → approval gate ("Edit Additional Discount")
  - Add `get_doc_context()` helper

- [ ] `Pos.vue` — mount `<ApprovalDialog>`, wire eventBus events

- [ ] `Payments.vue` — pass `approved_requests` in submit data

#### 2.3 Verify

```bash
bench clear-cache && bench build --app pospire
# In POS: configure POS Profile approval action for "Delete Item" (PIN only)
# Create POS Manager PIN for a manager user → check email
# Delete item from cart → dialog appears → enter PIN → approved → item removed
# Submit invoice → before_submit validates approval → success
# Try submit without approval → blocked with error
```

---

### Phase 3 — Remote Approval (Online)

**Goal:** Manager can approve/reject from Frappe Desk in real-time.

#### 3.1 Desk-Side JS

- [ ] Create `pospire/public/js/pos_approval_desk.js`
  - `frappe.realtime.on("pos_approval_request", show_approval_toast)`
  - Toast: action details, cashier name, Approve/Reject buttons, countdown timer
  - Calls `resolve_approval_request` on button click
  - Auto-dismisses on expiry

#### 3.2 ApprovalDialog.vue — Remote States

- [ ] Wire `waiting_remote` state fully:
  - Show spinner + countdown timer
  - Register `frappe.realtime.on("pos_approval_resolved", handleResolution)`
  - Unregister on unmount
  - Request name guard in `handleResolution`
  - On WebSocket reconnect: call `get_approval_request_status` (catch-up)
- [ ] Wire `waiting_remote_degraded` state:
  - `navigator.onLine` listener → transition on network loss
  - Three options: Switch to PIN / Cancel / Keep Waiting

#### 3.3 Verify

```bash
# Two browser windows: cashier (POS) + manager (Frappe Desk)
# Configure action for "Edit Rate" with remote_approval = true
# Change rate → dialog → select Remote → waiting spinner
# Manager sees toast notification
# Manager clicks Approve → cashier dialog shows "✓ Approved"
# Test: Manager rejects → cashier dialog shows "✗ Rejected" → rate reverted
# Test: Disconnect cashier network mid-wait → degraded UI shown
# Test: No manager responds → auto-expire pushes to cashier after expiry_minutes
```

---

### Phase 5 — Offline Approval

**Goal:** Full PIN approval works with zero network. Approvals sync on reconnect.

#### 5.1 Dependencies

- [ ] Add `dexie` to `package.json` (IndexedDB wrapper)
- [ ] Add `expr-eval` to `package.json` (safe JS expression evaluator)
  - Note: install in Phase 1 for online preliminary condition check

#### 5.2 IndexedDB Schema

- [ ] Create `pospire/public/js/posapp/offline/pospire_offline.js`
  - Dexie schema: `manager_pins`, `approval_requests`, `pin_attempts`

#### 5.3 Web Worker

- [ ] Create `pospire/public/js/posapp/workers/pinVerifier.worker.js`
  - `VERIFY_PIN` message handler
  - Load pin record from IndexedDB
  - Check TTL expiry
  - Check lockout
  - Web Crypto PBKDF2 deriveBits
  - Constant-time comparison
  - Increment/clear attempts
  - Return `{ verified, locked, attempts_left, locked_until, reason }`

#### 5.4 Offline Strategy

- [ ] Implement `offlineStrategy` in `useApprovalWorkflow.js`:
  - `evaluateConditionLocally(conditionJs, doc, action)` via `expr-eval`
  - Emit `show_approval_dialog` with `offlineMode: true`
  - Post `VERIFY_PIN` to Web Worker → await response
  - Create `approval_requests` record in IndexedDB on success
  - Accumulate `offline_id` in `getApprovedRequests()`

#### 5.5 ApprovalDialog.vue — Offline Mode

- [ ] When `offlineMode = true`:
  - Hide "Request Remote Approval" button
  - Show "Offline Mode — PIN only" notice
- [ ] Wire `waiting_remote_degraded` → PIN transition
- [ ] Wire `pin_hash_expired` state: show cache expired message

#### 5.6 Sync Engine

- [ ] Create `pospire/public/js/posapp/offline/syncEngine.js` (or extend existing)
  - On network restore: upload approval_requests → then upload invoices
  - Call `sync_offline_approval_requests`
  - Handle accepted/rejected responses
  - Set `sync_blocked` on invoices with rejected approvals
  - Emit `SYNC_APPROVAL_REJECTED` event to POS for user notification

#### 5.7 Backend — `sync_offline_approval_requests`

- [ ] Implement full validation logic in `approval.py`
  - Manager exists + has role
  - POS Profile config matches
  - Expiry with 8h grace cap
  - Idempotent on `offline_id`
  - Clock skew logging

#### 5.8 `get_approval_config` — Extend for Offline

- [ ] Add `managers` array to response (pin_hash, expires_at)
- [ ] Frontend seeds IndexedDB `manager_pins` on POS load and on periodic sync

#### 5.9 Verify

```bash
# Load POS while online → pin hashes seeded in IndexedDB
# Disable network (DevTools → Offline)
# Delete item → dialog shows PIN only (no Remote option)
# Enter PIN → Web Worker verifies → approved → item removed
# Complete sale → invoice in offline queue
# Re-enable network → sync engine uploads approval → then invoice
# Check: POSA-AR-... created in DB with resolution_method = Offline-PIN
# Test: deactivate manager mid-offline → sync rejects approval → invoice blocked → alert shown
# Test: 6 wrong PINs → lockout after 5
# Test: PIN cache TTL expired → hash_expired message shown
```

---

## 10. Files Affected

### New Files — 17

| File | Phase | Purpose |
|---|---|---|
| `pospire/doctype/pos_approval_action/pos_approval_action.json` | 1 | Child table DocType |
| `pospire/doctype/pos_approval_action/pos_approval_action.py` | 1 | condition_js computation |
| `pospire/doctype/pos_approval_action/__init__.py` | 1 | Module init |
| `pospire/doctype/pos_manager_pin/pos_manager_pin.json` | 1 | PIN storage DocType |
| `pospire/doctype/pos_manager_pin/pos_manager_pin.py` | 1 | Auto-generate + email PIN |
| `pospire/doctype/pos_manager_pin/pos_manager_pin.js` | 1 | Regenerate PIN button |
| `pospire/doctype/pos_manager_pin/__init__.py` | 1 | Module init |
| `pospire/doctype/pos_approval_request/pos_approval_request.json` | 1 | Core audit DocType |
| `pospire/doctype/pos_approval_request/pos_approval_request.py` | 1 | Status validation |
| `pospire/doctype/pos_approval_request/__init__.py` | 1 | Module init |
| `pospire/api/approval.py` | 1 | All API endpoints + scheduler |
| `public/js/pos_approval_desk.js` | 3 | Manager toast notifications |
| `public/js/posapp/composables/useApprovalWorkflow.js` | 2 | Frontend approval helper |
| `public/js/posapp/components/pos/PinEntry.vue` | 2 | Numeric keypad component |
| `public/js/posapp/components/pos/ApprovalDialog.vue` | 2–3 | Multi-state dialog |
| `public/js/posapp/offline/pospire_offline.js` | 5 | IndexedDB schema (Dexie) |
| `public/js/posapp/workers/pinVerifier.worker.js` | 5 | Web Crypto PIN verification |

### Modified Files — 6

| File | Phase | Changes |
|---|---|---|
| `pospire/hooks.py` | 1 | Add scheduler_events, fixtures, app_include_js |
| `pospire/fixtures/custom_field.json` | 1 | Add 3 POS Profile fields |
| `pospire/api/invoice.py` | 1 | Add validate_approval_requests in before_submit |
| `public/js/posapp/components/pos/Invoice.vue` | 2 | Wrap 4 handlers with approval gates |
| `public/js/posapp/components/pos/Pos.vue` | 2 | Mount ApprovalDialog, wire eventBus |
| `public/js/posapp/components/pos/Payments.vue` | 2 | Pass approved_requests on submit |

---

## 11. Testing Checklist

### Phase 1 — Backend

- [ ] POS Manager PIN: save triggers email, `pin_hash` set, plaintext not logged
- [ ] POS Manager PIN: regenerate button sends new email, old hash replaced
- [ ] `evaluate_approval_condition`: condition True → required, False → not required
- [ ] `evaluate_approval_condition`: condition error → fail-safe (required)
- [ ] `evaluate_approval_condition`: mode Blocked → required
- [ ] `verify_pin_and_approve`: correct PIN → Approved
- [ ] `verify_pin_and_approve`: wrong PIN → error, attempt counter increments
- [ ] `verify_pin_and_approve`: 5 wrong attempts → locked 15 min
- [ ] `verify_pin_and_approve`: self-approval blocked (cashier == manager)
- [ ] `resolve_approval_request`: manager without role → blocked
- [ ] `expire_stale_requests`: Pending + past expires_at → Expired + realtime push
- [ ] `before_submit`: invoice with approved request → submits
- [ ] `before_submit`: invoice missing required approval → blocked

### Phase 2 — PIN Approval (Online)

- [ ] Delete item: approval dialog appears, correct PIN → item removed
- [ ] Delete item: wrong PIN → error shown, item NOT removed
- [ ] Rate change: original rate captured on focus, restored on rejection
- [ ] Discount change: approval required above configured threshold
- [ ] Approval not required (condition false): dialog does NOT appear
- [ ] Multiple approvals in one invoice: all accumulated, all validated at submit
- [ ] Submit without completing approval: blocked

### Phase 3 — Remote Approval (Online)

- [ ] Manager receives toast notification on Frappe Desk
- [ ] Manager approves: POS dialog updates in real-time
- [ ] Manager rejects: POS dialog shows rejection + rate reverted
- [ ] Auto-expire: spinner shows countdown, expired state shown
- [ ] Network drop during wait: degraded UI, three options presented
- [ ] Reconnect after drop: `get_approval_request_status` catches missed resolution
- [ ] Two managers approve same request: only first accepted, second gets graceful error
- [ ] Cashier cancels while waiting: server record marked Cancelled

### Phase 5 — Offline

- [ ] POS loaded online: `manager_pins` seeded in IndexedDB
- [ ] Go offline: dialog shows PIN only, Remote option hidden
- [ ] Offline PIN correct: Web Worker verifies, approval in IndexedDB
- [ ] Offline PIN wrong: attempt counter increments in IndexedDB
- [ ] Offline 5 wrong PINs: lockout set in IndexedDB
- [ ] Offline invoice saved to queue with `offline_id`
- [ ] Reconnect: approval synced first, then invoice (ordering verified)
- [ ] Server accepts offline approval: `server_name` set, invoice submits
- [ ] Server rejects offline approval: `sync_blocked`, cashier alerted
- [ ] PIN hash TTL expired: hash_expired message, cannot verify offline
- [ ] condition_js evaluation: same result as Python condition for standard expressions
- [ ] Clock skew logged when device time differs from server

---

## 12. Open Questions

1. **PIN length** — 6 digits (as designed) or 4? 6 is more secure; 4 is faster
   to enter at a busy POS terminal.

2. **Self-service PIN setup** — Should managers be able to change their own PIN
   via a self-service screen (without SM involvement)? Would require a separate
   "Change My POS PIN" UI accessible to the manager user only.

3. **Approver role granularity** — Single "POS Manager" role for all action types,
   or allow per-action role (e.g. "Store Manager" required only for Void Invoice)?
   Current design supports per-action via `approver_role` field on the action row.

4. **PIN hash TTL for offline** — 24 hours is the default. Stores with poor
   connectivity (rural locations) may need 48–72 hours. Should this be a setting
   on POS Profile?

5. **Sync rejection handling** — When an offline approval is server-rejected, who
   is responsible for resolution? Current design: manager with system access
   manually reviews and voids or resubmits. Should there be a formal manager
   task/notification created in Frappe?

6. **Phase 4 priority** — Should the notification bell in POS Navbar and the
   approval analytics report be built before Phase 5 (offline)? Depends on
   whether the offline migration is imminent.

7. **Condition parity validation** — Should the `POS Approval Action` controller
   run Python vs JS condition parity tests on save (using sample vectors)?
   Divergent conditions would be flagged as server-only. Worth the complexity?

---

*End of Implementation Plan*
