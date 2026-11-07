/**
 * API tests — POSpire QA Test Case Workbook, "API" tab (API-001–API-006).
 *
 * Unlike functional.spec.ts/negative.spec.ts, these hit Frappe's JSON-RPC
 * endpoints directly via Playwright's `request` fixture — no browser, no
 * page. Authenticated calls use an API key/secret (Administrator's, seeded
 * on pospire_dev — see .env.test), not the sid-cookie storageState the
 * browser specs use: reusing that cookie for a raw HTTP POST would 417 with
 * a CSRFTokenError the moment the SPA has ever loaded once and stamped a
 * csrf_token on that session (confirmed via reading auth.py's
 * validate_csrf_token()/HTTPRequest chain). An
 * `Authorization: token key:secret` header runs through
 * validate_auth_via_api_keys() in validate_auth(), which frappe's own
 * request dispatch (apps/frappe/frappe/app.py) calls AFTER CSRF validation
 * has already passed against the pre-auth Guest session — so API-key calls
 * never need a CSRF token at all.
 *
 * Root-caused against the actual backend source before writing any
 * assertion (posapp.py, the Sales Invoice/ERPNext controllers, frappe's
 * auth/exception-handling code) — see the comment on each test. Three
 * findings from that research are asserted as EXPECTED (correct) behavior
 * below, which means they currently FAIL against the live app — these are
 * genuine defects the workbook's own Exception Flow column calls for,
 * not test-authoring mistakes:
 *   - API-004: a permission-denied response leaks a full Python traceback
 *     to an unauthenticated caller, because this site runs under `bench
 *     start` (frappe._dev_server=1) — is_traceback_allowed() short-circuits
 *     to true for ANY caller on a dev server, before it ever checks
 *     whether the caller is a system user. Violates "No sensitive data
 *     exposed".
 *   - API-006: the same traceback leak applies to a genuine unhandled
 *     server exception (not a clean frappe.throw) — the response is not
 *     the "friendly error response" the workbook expects.
 *   - API-005's OWN test targets the main checkout path (update_invoice's
 *     payments row), which DOES correctly reject a negative amount
 *     server-side (unlike NEG-001's client-only opening-balance case) — this
 *     one is expected to pass. A separate, unrelated endpoint,
 *     payment_entry.process_pos_payment (used by the outstanding-payment
 *     reconciliation screen, not main checkout), was found during research
 *     to silently coerce a negative amount to positive and swallow
 *     exceptions instead of validating — noted here for visibility, but not
 *     under test since it's a different feature than what API-005 exercises.
 *
 * API-004's workbook text says "401/permission error" — the actual, correct
 * Frappe behavior for a whitelisted method called as Guest is HTTP 403
 * (PermissionError), confirmed via frappe.is_whitelisted()'s actual throw.
 * Asserted as 403, not literally 401 — that's the framework's real intended
 * behavior, not a defect.
 */

import { expect, test, type APIRequestContext } from "@playwright/test";
import { API_KEY, API_SECRET, BASE_URL } from "./auth.config";

const TEST_DATA = {
	companyName: "Lifestyle Retail Stores",
	posProfileName: "MG Road - POS 2",
	customerName: "Sam",
	itemCode: "LSF-002",
	itemRate: 1499,
};

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}

function validInvoicePayload(overrides: Record<string, unknown> = {}) {
	return {
		doctype: "Sales Invoice",
		is_pos: 1,
		ignore_pricing_rule: 1,
		company: TEST_DATA.companyName,
		pos_profile: TEST_DATA.posProfileName,
		customer: TEST_DATA.customerName,
		currency: "INR",
		posting_date: todayIso(),
		items: [
			{
				item_code: TEST_DATA.itemCode,
				qty: 1,
				rate: TEST_DATA.itemRate,
				uom: "Nos",
				conversion_factor: 1,
			},
		],
		payments: [{ mode_of_payment: "Cash", amount: TEST_DATA.itemRate }],
		...overrides,
	};
}

test.describe("API — direct JSON-RPC endpoint tests (API-001 to API-006)", () => {
	let authed: APIRequestContext;

	test.beforeAll(async ({ playwright }) => {
		test.skip(!API_KEY || !API_SECRET, "POSPIRE_E2E_API_KEY/SECRET not set in .env.test");
		authed = await playwright.request.newContext({
			baseURL: BASE_URL,
			extraHTTPHeaders: {
				Authorization: `token ${API_KEY}:${API_SECRET}`,
				Accept: "application/json",
			},
		});
	});

	test.afterAll(async () => {
		await authed?.dispose();
	});

	test("API-001 — Get items with valid parameters", async () => {
		// get_items' `pos_profile` arg must be the FULL POS Profile object, not
		// a bare name — ItemsSelector.vue always sends `vm.pos_profile` (the
		// whole doc), and posapp.py's _load() only handles dict/list/JSON-string
		// input, so a bare name string here would actually exercise the
		// API-006 crash path instead. frappe.client.get is the standard
		// whitelisted method for fetching a full doc.
		const profileRes = await authed.post("/api/method/frappe.client.get", {
			data: { doctype: "POS Profile", name: TEST_DATA.posProfileName },
		});
		expect(profileRes.status()).toBe(200);
		const posProfile = (await profileRes.json()).message;

		const res = await authed.post("/api/method/pospire.pospire.api.posapp.get_items", {
			data: { pos_profile: posProfile, search_value: TEST_DATA.itemCode },
		});
		expect(res.status()).toBe(200);
		const items = (await res.json()).message;
		expect(Array.isArray(items)).toBe(true);
		expect(items.some((item: { item_code: string }) => item.item_code === TEST_DATA.itemCode)).toBe(
			true,
		);
	});

	test("API-001 (exception) — Invalid POS Profile name returns a controlled error", async () => {
		// get_item_group_condition() unconditionally calls
		// frappe.get_cached_doc("POS Profile", pos_profile) before any caching
		// branch — a non-existent profile name raises frappe.DoesNotExistError
		// (a ValidationError subclass, HTTP 404), not a graceful empty list.
		const res = await authed.post("/api/method/pospire.pospire.api.posapp.get_items", {
			data: { pos_profile: { name: "Nonexistent POS Profile - NEG-API" } },
		});
		expect(res.status()).toBe(404);
	});

	test("API-002 — Create invoice, and duplicate submission is handled safely", async () => {
		const createRes = await authed.post("/api/method/pospire.pospire.api.posapp.update_invoice", {
			data: { data: JSON.stringify(validInvoicePayload()) },
		});
		expect(createRes.status()).toBe(200);
		const invoiceDoc = (await createRes.json()).message;
		expect(invoiceDoc.name).toBeTruthy();
		expect(invoiceDoc.docstatus).toBe(0);

		// submit_invoice's idempotency is keyed on offline_id, not payload
		// equality (posapp.py's _existing_by_offline_id() lookup) — reusing
		// the SAME offline_id on a second call is exactly what a real retried
		// request looks like, and is the one path that's genuinely deduped
		// server-side.
		//
		// `invoice` must be the FULL invoice doc object, not just its name —
		// submit_invoice's first line is `invoice = _load(invoice)`, and
		// _load() only special-cases dict/list; a bare name string like
		// "SINV-26-00530" isn't valid JSON, so _load() would crash trying
		// json.loads() on it (confirmed live: a bare 500 JSONDecodeError).
		// This mirrors what Payments.vue actually sends (`invoice:
		// this.invoice_doc`, the whole object).
		const offlineId = `api-test-${Date.now()}`;
		const submitPayload = {
			invoice: invoiceDoc,
			data: JSON.stringify(invoiceDoc),
			offline_id: offlineId,
		};

		const firstSubmit = await authed.post(
			"/api/method/pospire.pospire.api.posapp.submit_invoice",
			{ data: submitPayload },
		);
		expect(firstSubmit.status()).toBe(200);
		const firstResult = (await firstSubmit.json()).message;
		expect(firstResult.name).toBe(invoiceDoc.name);

		const duplicateSubmit = await authed.post(
			"/api/method/pospire.pospire.api.posapp.submit_invoice",
			{ data: submitPayload },
		);
		expect(duplicateSubmit.status()).toBe(200);
		const duplicateResult = (await duplicateSubmit.json()).message;
		// Short-circuited by the offline_id lookup — same invoice, not a
		// second submission attempt against an already-submitted doc.
		expect(duplicateResult.name).toBe(invoiceDoc.name);
		expect(duplicateResult.was_already_submitted).toBe(true);

		const countRes = await authed.post("/api/method/frappe.client.get_count", {
			data: { doctype: "Sales Invoice", filters: JSON.stringify({ name: invoiceDoc.name }) },
		});
		expect((await countRes.json()).message).toBe(1);
	});

	test("API-003 — Missing mandatory field (company) returns a validation error, no partial record", async () => {
		// "Missing customer" turned out to be untestable here: update_invoice()
		// calls invoice_doc.set_missing_values(), and ERPNext's
		// SalesInvoice.set_pos_fields() defaults `customer` from the POS
		// Profile's own `customer` field whenever a pos_profile can be
		// resolved — and one CAN always be resolved even with no pos_profile
		// sent at all, since set_pos_fields() falls back to
		// get_pos_profile(self.company) (any active default profile for that
		// company). Confirmed live: omitting both `customer` and
		// `pos_profile` still produced a real invoice with
		// customer="MG Store POS Customer" auto-filled. `company` has no such
		// fallback — omitting it (and pos_profile, so nothing can re-derive
		// it either) is the one mandatory field this endpoint genuinely can't
		// paper over, confirmed live: "Please select a Company".
		const { company: _omitCompany, pos_profile: _omitProfile, ...payloadMissingCompany } =
			validInvoicePayload();

		const res = await authed.post("/api/method/pospire.pospire.api.posapp.update_invoice", {
			data: { data: JSON.stringify(payloadMissingCompany) },
		});

		expect(res.status()).toBe(417);
		const body = await res.json();
		expect(JSON.stringify(body)).toMatch(/company/i);
	});

	test("API-003 (variant) — Empty items array [KNOWN DEFECT: crashes instead of a clean validation error]", async () => {
		// The doctype's own `items` field is reqd=1, same as `customer`/
		// `company` — but unlike those two, an empty items list never reaches
		// the mandatory-field check at all. accounts_controller.py's
		// validate() calls set_total_in_words() BEFORE the mandatory check
		// runs, which does abs(self.base_rounded_total) — with zero items,
		// that total is never computed and stays None, so abs(None) raises a
		// bare TypeError. Confirmed live via the exact traceback:
		//   selling_controller.py:199, set_total_in_words() -> abs(None)
		//   TypeError: bad operand type for abs(): 'NoneType'
		// That's an unhandled crash (HTTP 500), not the clean 417
		// MandatoryError the workbook's "Validation response returned"
		// expects — this assertion is intentionally the CORRECT expected
		// behavior, so it currently FAILS, flagging the gap.
		const res = await authed.post("/api/method/pospire.pospire.api.posapp.update_invoice", {
			data: { data: JSON.stringify(validInvoicePayload({ items: [] })) },
		});
		expect(res.status()).toBe(417);
		const body = await res.json();
		expect(JSON.stringify(body)).toMatch(/items/i);
	});

	test("API-004 — Calling a protected endpoint without authentication is denied", async ({
		playwright,
	}) => {
		const anonymous = await playwright.request.newContext({ baseURL: BASE_URL });
		try {
			const res = await anonymous.post("/api/method/pospire.pospire.api.posapp.get_items", {
				data: { pos_profile: { name: TEST_DATA.posProfileName } },
			});

			// frappe.is_whitelisted() throws a PermissionError (HTTP 403) for a
			// Guest session calling a non-guest-allowed method — this is the
			// framework's actual, correct behavior. The workbook's "401" is
			// describing the general idea (unauthenticated access denied), not
			// this framework's specific status code.
			expect(res.status()).toBe(403);

			// KNOWN DEFECT (see file header): on this dev-server target,
			// is_traceback_allowed() returns true for ANY caller, so this 403
			// body embeds a full Python traceback regardless of auth state —
			// violating "No sensitive data exposed". This assertion is
			// expected to FAIL until that's fixed (e.g. running behind a
			// production-mode site, or frappe adding an auth check before
			// is_dev_server short-circuits).
			const bodyText = await res.text();
			expect(bodyText).not.toMatch(/Traceback \(most recent call last\)/);
		} finally {
			await anonymous.dispose();
		}
	});

	test("API-005 — Invalid (negative) payment amount is rejected server-side", async () => {
		// A negative amount has to go through submit_invoice against an
		// EXISTING draft, not update_invoice — confirmed live that
		// update_invoice can't be used to test this at all: its own
		// set_missing_values() call runs with for_validate=False, which
		// unconditionally calls ERPNext's update_multi_mode_option()
		// (sales_invoice.py) — that function does `doc.set("payments", [])`
		// and REBUILDS the payments table from the POS Profile's configured
		// modes on every single call, silently discarding whatever payments
		// array was sent. submit_invoice's own .save() runs
		// set_missing_values(for_validate=True), which skips that rebuild
		// entirely (set_pos_fields() only calls update_multi_mode_option()
		// `if not for_validate`) — so a payments array survives there, and
		// ERPNext's verify_payment_amount_is_positive() (SalesInvoice.
		// validate(), enforced whenever is_pos=1, which POSpire always sets)
		// genuinely rejects it. Unlike NEG-001's opening-balance case, this is
		// a real server-side guard, not just a client-side toast.
		const createRes = await authed.post(
			"/api/method/pospire.pospire.api.posapp.update_invoice",
			{ data: { data: JSON.stringify(validInvoicePayload()) } },
		);
		expect(createRes.status()).toBe(200);
		const invoiceDoc = (await createRes.json()).message;
		invoiceDoc.payments = [{ mode_of_payment: "Cash", amount: -100 }];

		const res = await authed.post("/api/method/pospire.pospire.api.posapp.submit_invoice", {
			data: {
				invoice: invoiceDoc,
				data: JSON.stringify(invoiceDoc),
				offline_id: `api-test-neg-${Date.now()}`,
			},
		});

		expect(res.status()).toBe(417);
		const body = await res.json();
		expect(JSON.stringify(body)).toMatch(/amount must be positive/i);

		const countRes = await authed.post("/api/method/frappe.client.get_count", {
			data: {
				doctype: "Sales Invoice",
				filters: JSON.stringify({ name: invoiceDoc.name, docstatus: 1 }),
			},
		});
		expect((await countRes.json()).message).toBe(0);
	});

	test("API-006 — A genuine unhandled server exception returns a friendly, stable response", async () => {
		// posapp.py's shared _load() helper does json.loads(value) whenever the
		// arg isn't already a dict/list — a non-JSON string here raises a bare
		// json.decoder.JSONDecodeError (not a frappe.throw/ValidationError),
		// which has no http_status_code attribute and falls through to
		// frappe's generic exception handler's default of HTTP 500. This is a
		// real, repeatable "server exception" distinct from API-003's clean
		// 417s.
		const res = await authed.post("/api/method/pospire.pospire.api.posapp.update_invoice", {
			data: { data: "this is not valid JSON {{{" },
		});

		// "Application remains stable": Frappe always returns a structured
		// response rather than hanging or crashing the whole process — true
		// today, this assertion passes.
		expect(res.status()).toBe(500);

		// KNOWN DEFECT (see file header): the SAME dev-server traceback leak
		// as API-004 applies here — a "friendly error response" should not
		// include the raw exception internals. Expected to FAIL until fixed.
		const bodyText = await res.text();
		expect(bodyText).not.toMatch(/Traceback \(most recent call last\)/);
	});
});
