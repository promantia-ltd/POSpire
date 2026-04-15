# POSpire — POS Approval Workflow
## User Manual

**Version:** 1.0
**Date:** 2026-04-02
**Applies to:** POSpire Phase 1–3 (Online Approval)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Who Does What](#2-who-does-what)
3. [System Administrator Guide](#3-system-administrator-guide)
   - 3.1 [Step 1 — Create Manager PINs](#31-step-1--create-manager-pins)
   - 3.2 [Step 2 — Configure POS Profile](#32-step-2--configure-pos-profile)
   - 3.3 [Understanding Approval Modes](#33-understanding-approval-modes)
   - 3.4 [Understanding Conditions](#34-understanding-conditions)
   - 3.5 [Recommended Configurations](#35-recommended-configurations)
4. [Manager Guide](#4-manager-guide)
   - 4.1 [Receiving Your PIN](#41-receiving-your-pin)
   - 4.2 [Approving On-Site (PIN)](#42-approving-on-site-pin)
   - 4.3 [Approving Remotely (Desk Notification)](#43-approving-remotely-desk-notification)
   - 4.4 [Viewing Pending Approvals](#44-viewing-pending-approvals)
5. [Cashier Guide](#5-cashier-guide)
   - 5.1 [What Triggers an Approval](#51-what-triggers-an-approval)
   - 5.2 [PIN Approval Flow](#52-pin-approval-flow)
   - 5.3 [Remote Approval Flow](#53-remote-approval-flow)
   - 5.4 [When a Request Expires](#54-when-a-request-expires)
   - 5.5 [Blocked Actions](#55-blocked-actions)
6. [Audit Trail](#6-audit-trail)
7. [Troubleshooting](#7-troubleshooting)
8. [Security Notes](#8-security-notes)

---

## 1. Overview

The POS Approval Workflow gives store managers oversight over sensitive cashier
actions — price changes, item deletions, discounts — without blocking the
cashier from working.

When a cashier performs a restricted action, the POS pauses and asks for a
manager to authorise it. The manager can do this in two ways:

- **On-site PIN** — The manager walks to the terminal, selects their name from
  a dropdown, and enters their personal PIN on the keypad. Takes ~10 seconds.

- **Remote approval** — The cashier sends a request. The manager receives a
  notification on their Frappe Desk browser on any device in the store, reviews
  it, and clicks Approve or Reject — without leaving their current location.

Every approval, rejection, and expiry is permanently recorded as an audit
document for compliance and reporting.

---

## 2. Who Does What

| Role | Responsibility |
|---|---|
| **System Manager** | Creates and manages Manager PINs. Configures approval rules on POS Profiles. |
| **Manager / Supervisor** | Approves or rejects cashier requests. Either on-site via PIN or remotely via Frappe Desk. |
| **Cashier** | Performs POS actions. Initiates approval requests when required. Selects which manager to ask. |

---

## 3. System Administrator Guide

### 3.1 Step 1 — Create Manager PINs

Every manager who will authorise POS actions needs a **POS Manager PIN** record.

**Where:** Frappe Desk → Search "POS Manager PIN" → New

**Steps:**

1. Open **POS Manager PIN** from the desk search bar
2. Click **New**
3. In the **User** field, select the manager's user account (e.g. `john.manager@store.com`)
4. Ensure **Is Active** is checked
5. Click **Save**

**What happens automatically:**
- The system generates a random 6-digit PIN
- The PIN is immediately hashed and stored — you never see it
- An email is sent to the manager with their PIN

> **Important:** You will not see the PIN at any point. The manager receives
> it in their email. This is by design — not even the System Manager can
> view someone else's PIN.

**To create PINs for multiple managers:** Repeat the above for each manager.

---

**Regenerating a PIN** (e.g. manager forgot their PIN, or security reset):

1. Open the manager's **POS Manager PIN** record
2. Click the **Regenerate PIN** button at the top right
3. Confirm the dialog
4. A new PIN is generated and emailed to the manager
5. The old PIN stops working immediately

**Deactivating a manager** (e.g. staff leaves):

1. Open their **POS Manager PIN** record
2. Uncheck **Is Active**
3. Save — they can no longer approve any POS actions

---

### 3.2 Step 2 — Configure POS Profile

Approval rules are set per POS Profile, so different stores or terminals can
have different requirements.

**Where:** Frappe Desk → POS Profile → (select your profile) → Approval Workflow tab

**Steps:**

1. Open the relevant **POS Profile**
2. Click the **Approval Workflow** tab
3. Check **Enable Approval Workflow**
4. In the **Approval Actions** table, click **Add Row** for each action you want to control
5. Configure each row (see table below)
6. Save the POS Profile

**Approval Actions table — columns explained:**

| Column | What to set |
|---|---|
| **Action Type** | The cashier action being controlled (see list below) |
| **Approval Mode** | Not Required / Required / Blocked (see Section 3.3) |
| **Approver Role** | Which Frappe Role can approve this action (e.g. "POS Manager") |
| **Expiry (Minutes)** | How long a remote request waits before auto-expiring (default: 15) |
| **Allow PIN Approval** | ✓ = Manager can approve on-site by entering a PIN |
| **Allow Remote Approval** | ✓ = Manager can approve from their own device remotely |
| **Condition** | Optional expression — approval only required when this is true (see Section 3.4) |

**Available Action Types:**

| Action Type | What it controls |
|---|---|
| Delete Item | Cashier removes a line item from the cart |
| Edit Rate | Cashier changes an item's selling price |
| Edit Item Discount | Cashier applies a % discount to a specific line item |
| Edit Additional Discount | Cashier applies an invoice-level discount |
| Void Invoice | Cashier cancels an existing submitted invoice |
| Sales Return | Cashier processes a return against a previous invoice |

> **Tip:** You do not need to add a row for every action type. Actions with no
> row in the table are treated as "Not Required" — the cashier can perform them
> freely.

---

### 3.3 Understanding Approval Modes

**Not Required** — No change from existing behaviour. The cashier performs the
action with no interruption. Use this for actions you want to permit freely.

**Required** — The action pauses and a manager must authorise it before it
proceeds. If a Condition is also set, the pause only happens when the condition
is met (e.g. only for discounts above 20%).

**Blocked** — The action is completely prevented. The cashier sees an error
message and cannot proceed regardless of manager availability. Use this for
actions your store policy prohibits entirely.

---

### 3.4 Understanding Conditions

The **Condition** column lets you write a simple expression so that approval is
only required when specific criteria are met. Leave it blank to always require
approval when mode is Required.

**Conditions use two context objects:**

`doc` — the current invoice/cart state:

| Variable | Meaning |
|---|---|
| `doc.grand_total` | Invoice total after taxes |
| `doc.net_total` | Invoice total before taxes |
| `doc.total_qty` | Total number of items in cart |
| `doc.discount_amount` | Invoice-level discount amount |
| `doc.additional_discount_percentage` | Invoice-level discount % |
| `doc.customer` | Customer ID |
| `doc.customer_group` | Customer group |
| `doc.is_return` | 1 if this is a return invoice |

`action` — details of the specific change:

| Variable | Meaning |
|---|---|
| `action.original_value` | Value before the change |
| `action.requested_value` | Value the cashier wants to set |
| `action.change_amount` | Absolute difference (original − requested) |
| `action.change_percent` | % change from original |
| `action.item_code` | Item being affected |
| `action.item_group` | Item group of the affected item |

**Example conditions:**

```
action.change_percent > 10
```
→ Approval required only when rate is reduced more than 10% from original

```
action.requested_value > 20
```
→ Approval required only when item discount exceeds 20%

```
doc.grand_total > 10000
```
→ Approval required only when invoice total exceeds ₹10,000

```
action.original_value > 5000
```
→ Approval required only when deleting an item worth more than ₹5,000

```
doc.grand_total > 50000 or action.change_percent > 15
```
→ Approval required for high-value invoices OR large price changes

> **Security note:** If a condition contains a typo or error, the system
> **always requires approval** (fail-safe). It never silently skips approval
> due to a bad condition expression.

---

### 3.5 Recommended Configurations

**Small retail store (manager always on floor):**

| Action Type | Mode | PIN | Remote | Expiry | Role |
|---|---|---|---|---|---|
| Delete Item | Required | ✓ | ✗ | 10 min | POS Manager |
| Edit Rate | Required | `action.change_percent > 10` | ✓ | ✗ | 10 min |
| Edit Item Discount | Required | `action.requested_value > 15` | ✓ | ✗ | 10 min |
| Void Invoice | Required | ✓ | ✗ | 30 min | Store Manager |

**Multi-floor / large store:**

| Action Type | Mode | Condition | PIN | Remote | Expiry | Role |
|---|---|---|---|---|---|---|
| Delete Item | Required | `action.original_value > 500` | ✓ | ✗ | 10 min | POS Manager |
| Edit Rate | Required | `action.change_percent > 10` | ✓ | ✓ | 15 min | POS Manager |
| Edit Item Discount | Required | `action.requested_value > 20` | ✓ | ✓ | 15 min | POS Manager |
| Edit Additional Discount | Required | `doc.grand_total > 10000` | ✓ | ✓ | 15 min | POS Manager |
| Void Invoice | Required | _(blank — always)_ | ✓ | ✓ | 30 min | Store Manager |

**Quick-service restaurant:**

| Action Type | Mode | Condition | PIN | Remote | Expiry | Role |
|---|---|---|---|---|---|---|
| Delete Item | Not Required | — | — | — | — | — |
| Edit Item Discount | Required | `action.requested_value > 10` | ✓ | ✗ | 5 min | POS Manager |
| Void Invoice | Required | _(blank — always)_ | ✓ | ✓ | 15 min | Store Manager |

---

## 4. Manager Guide

### 4.1 Receiving Your PIN

When a System Manager creates a PIN for you, you will receive an email:

```
Subject: Your POSpire Manager PIN

Hi [Your Name],

A POS Manager PIN has been created for your account by your system
administrator.

Your PIN: 847291

You will need this PIN to authorise manager-level actions at the POS
terminal. Please keep it confidential and do not share it with anyone.

If you did not expect this email, contact your system administrator
immediately.

— POSpire
```

**Keep this PIN private.** You will enter it on the cashier's terminal when
asked. Do not share it with cashiers or other staff.

If you forget your PIN or suspect it has been compromised, contact your System
Manager and ask them to regenerate it from your POS Manager PIN record.

---

### 4.2 Approving On-Site (PIN)

When a cashier requires PIN approval, they will call you to their terminal.

**What you will see on the terminal:**

```
┌─────────────────────────────────────────────┐
│  Manager Approval Required                  │
│                                             │
│  Edit Rate — Widget A                       │
│  Current: ₹1,000  →  Requested: ₹750       │
│  Change: 25% reduction                      │
│                                             │
│  Cashier: Jane Smith                        │
│  Selected Manager: ▼ [Your Name]            │
│                                             │
│  [  ● ● ● ● ● ●  ]  ← PIN dots             │
│  ┌───┬───┬───┐                              │
│  │ 1 │ 2 │ 3 │                              │
│  │ 4 │ 5 │ 6 │                              │
│  │ 7 │ 8 │ 9 │                              │
│  │CLR│ 0 │ ⌫ │                              │
│  └───┴───┴───┘                              │
└─────────────────────────────────────────────┘
```

**Steps:**
1. Review the action details shown in the dialog
2. Ensure you are satisfied the action is legitimate
3. Enter your 6-digit PIN on the keypad
4. The dialog closes automatically with a green checkmark if correct

**If you enter the wrong PIN:**
- An error is shown: "Invalid PIN. X attempt(s) remaining."
- You have 5 attempts in total
- After 5 wrong attempts, PIN entry is locked for 15 minutes for this request

**To reject the action:** Ask the cashier to click Cancel — this reverts the
action and records it as Cancelled in the audit log.

---

### 4.3 Approving Remotely (Desk Notification)

When a cashier sends a remote approval request and you are selected as the
approving manager, you will receive a notification in your **Frappe Desk** browser
window.

> **Note:** You must be logged into Frappe Desk on a browser for remote
> notifications to reach you. If your browser is closed, you will not receive
> the notification and the request will eventually expire.

**What the notification shows:**

```
┌─────────────────────────────────────────────┐
│  🔔 POS Approval Required                   │
│                                             │
│  Edit Rate — Widget A                       │
│  ₹1,000 → ₹750  (25% reduction)            │
│  Requested by: Jane Smith                   │
│  POS Profile: Main Store                    │
│  Expires in: 14 min 32 sec                  │
│                                             │
│  [ ✓ Approve ]       [ ✗ Reject ]          │
└─────────────────────────────────────────────┘
```

**Steps:**
1. Review the request details in the notification
2. Click **Approve** if the action is legitimate, or **Reject** if not
3. For rejections, you can optionally add a short note explaining why
4. The cashier's terminal updates in real-time — their waiting screen
   immediately shows your decision

**Approval counts immediately** — the cashier can proceed with the action
as soon as you click Approve.

---

### 4.4 Viewing Pending Approvals

If you missed a notification or want to see all outstanding requests:

1. In Frappe Desk, navigate to **POS Approval Request**
2. Filter by **Status = Pending**
3. Open any request to review details and resolve it using the form buttons

---

## 5. Cashier Guide

### 5.1 What Triggers an Approval

You will see an approval dialog when you attempt an action that your store's
POS Profile has configured as **Required**. This can happen when you:

- **Delete an item** from the cart
- **Change an item's price** (rate field)
- **Apply a discount** to an item
- **Apply an additional invoice discount**
- **Void a submitted invoice**
- **Process a return** above a threshold

Whether the dialog appears depends on your store's configuration — some actions
may only require approval above a certain discount level or invoice total.
If no dialog appears, the action is permitted freely.

---

### 5.2 PIN Approval Flow

PIN approval is used when the manager is **physically present** in the store.

**Step 1 — Action blocked, dialog opens**

When you perform a restricted action, a dialog appears showing:
- The action type and details (what you tried to change, from/to values)
- A dropdown to select the manager
- Method buttons: PIN Approval, Remote Approval (if enabled)

**Step 2 — Select the manager**

From the **Select Manager** dropdown, choose the manager who is with you.
The dropdown shows only managers who have an active PIN for the required role.

If no managers appear in the dropdown, no one has a PIN set up for the
required role — contact your System Manager.

**Step 3 — Hand the terminal to the manager**

Click **Enter PIN**. The keypad appears. Hand the terminal to the manager.

**Step 4 — Manager enters their PIN**

The manager enters their 6-digit PIN on the keypad. They do not tell you
the PIN — they enter it themselves.

**Step 5 — Action proceeds or fails**

- ✓ **Correct PIN** — Dialog closes with a green confirmation. The action
  (price change, item deletion, etc.) is applied automatically.
- ✗ **Wrong PIN** — An error shows the number of remaining attempts.
  The manager can try again.
- 🔒 **Too many wrong attempts** — Entry locked for 15 minutes. The manager
  will need to wait or a different manager with the right role can be selected.

**To cancel:** Click **Cancel** at any time to revert the action without
requiring approval.

---

### 5.3 Remote Approval Flow

Remote approval is used when the manager **is not physically present** and
needs to authorise from their own device.

> **Note:** Your POS Profile must have Remote Approval enabled for this to
> be available. If only PIN Approval is enabled, the remote option will not
> appear.

**Step 1 — Select manager and choose Remote**

In the approval dialog, select the manager from the dropdown, then click
**Request Remote Approval**.

**Step 2 — Waiting screen**

A waiting screen appears with a spinner and countdown timer:

```
┌─────────────────────────────────────────────┐
│  Waiting for Manager Approval...            │
│                                             │
│  Edit Rate — Widget A                       │
│  ₹1,000 → ₹750                             │
│                                             │
│  Request sent to: John Manager              │
│  Expires in: 14:47                          │
│                                             │
│  [ Cancel Request ]                         │
└─────────────────────────────────────────────┘
```

**Step 3 — Manager responds**

The manager receives a notification on their Frappe Desk browser and clicks
Approve or Reject. Your screen updates immediately:

- ✓ **Approved** — Green confirmation shown. Action applied. Dialog closes.
- ✗ **Rejected** — Red message shown, with the manager's note if they left
  one. The action is reverted (original value restored).

**Step 4 — If no response**

If the manager does not respond within the configured time (default 15 minutes),
the request auto-expires:

```
┌─────────────────────────────────────────────┐
│  ⏰ Request Expired                         │
│                                             │
│  No manager responded within 15 minutes.   │
│  The action has been reverted.              │
│                                             │
│  [ Try Again ]    [ Cancel ]                │
└─────────────────────────────────────────────┘
```

You can click **Try Again** to send a new request, or **Cancel** to revert.

---

### 5.4 When a Request Expires

Approval requests expire after the configured timeout (typically 10–30 minutes).

When a request expires:
- Your waiting screen automatically shows the expired state
- The action is reverted to its original value
- The expiry is recorded in the audit trail

You can start a new approval request for the same action if needed.

---

### 5.5 Blocked Actions

If an action is set to **Blocked** in your POS Profile, you will see:

```
This action is not permitted on this POS Profile.
```

No approval dialog appears — the action cannot proceed regardless of manager
availability. Contact your System Manager if you believe this is in error.

---

## 6. Audit Trail

Every approval event — approved, rejected, expired, or cancelled — is
permanently recorded as a **POS Approval Request** document.

**Where to view:** Frappe Desk → POS Approval Request

**Each record shows:**

| Field | What it captures |
|---|---|
| Name | Unique reference (e.g. POSA-AR-26-00001) |
| Action Type | What was requested (Edit Rate, Delete Item, etc.) |
| Status | Approved / Rejected / Expired / Cancelled |
| Requested By | Which cashier triggered the request |
| Requested At | Date and time of the request |
| Selected Manager | Which manager the cashier nominated |
| Resolved By | Which manager actually approved/rejected |
| Resolved At | Date and time of resolution |
| Resolution Method | PIN / Remote / Auto-Expired |
| Original Value | The value before the change |
| Requested Value | The value the cashier wanted |
| Invoice | The Sales Invoice this relates to |
| POS Opening Shift | The shift it occurred in |
| Resolution Note | Manager's comment on rejection |

**Useful audit queries:**

- *All price change approvals last 30 days:*
  Filter — Action Type = Edit Rate, Requested At = last 30 days

- *All rejections by cashier:*
  Filter — Status = Rejected, Requested By = [cashier name]

- *All expired requests (no manager responded):*
  Filter — Status = Expired

- *All approvals by a specific manager:*
  Filter — Resolved By = [manager name]

- *Approvals for a specific shift:*
  Filter — POS Opening Shift = [shift name]

---

## 7. Troubleshooting

**No managers appearing in the dropdown when requesting approval**

- No POS Manager PIN records exist for users with the required approver role
- Or all matching PIN records have Is Active unchecked
- Contact your System Manager to set up PIN records

**"Approval request is no longer pending" error**

- The request expired before the PIN was entered, or another action resolved it
- Click Cancel, then try the action again to create a fresh request

**Remote approval notification not appearing in Frappe Desk**

- The manager must be logged into Frappe Desk in a browser tab
- The browser tab must be open (not just the tab — the browser itself)
- Frappe Desk auto-connects to WebSocket on load; notifications work as long
  as the browser is connected to the server

**Invoice submission fails with approval error**

- The invoice contains a restricted action (price change, deletion) but the
  approved_requests list is missing or the approval has expired
- Open the invoice draft, redo the restricted action to get a fresh approval,
  then re-submit

**PIN locked — "Locked for 15 minutes"**

- 5 incorrect PIN attempts were made for this specific approval request
- Wait 15 minutes, or select a different manager from the dropdown to start
  a fresh approval with a different manager's PIN
- The lockout is per-request — a new approval request for the same action
  does not inherit the previous lockout

**"You cannot approve your own request" error**

- The logged-in user on the POS is also the manager attempting to approve
- A different user with the approver role must approve the request

---

## 8. Security Notes

**PIN privacy:** Manager PINs are never visible to anyone in the system —
not to the System Manager, not in the database UI, not in any log file.
Only the manager receives the PIN, in a one-time email on creation.

**No self-approval:** The system prevents a cashier from approving their
own requests, even if they have the approver role.

**Rate limiting:** PIN entry is limited to 5 attempts per request. After
5 failures, the entry is locked for 15 minutes. This prevents guessing.

**Server enforcement:** Even if the POS frontend is bypassed, every invoice
submission is validated server-side. An invoice that required approval cannot
be submitted without a valid, non-expired, Approved request on record.

**Audit permanence:** POS Approval Request records are never deleted
automatically. Every action taken — approved, rejected, or expired — is
permanently retained for compliance and dispute resolution.

---

*End of User Manual*
