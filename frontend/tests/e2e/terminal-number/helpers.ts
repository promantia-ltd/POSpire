/**
 * Harness for the terminal invoice number e2e tests (#33385).
 * Seeds and inspects data through Frappe REST with the admin API key from .env.test;
 * the browser logs in as the .env.test user. Every seeded record is prefixed "E2E".
 */

import fs from "node:fs";
import {
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const env: Record<string, string> = {};
for (const line of fs
  .readFileSync(new URL("../.env.test", import.meta.url), "utf8")
  .split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}
export const BASE_URL =
  process.env.POSPIRE_E2E_BASE_URL ??
  env.POSPIRE_E2E_BASE_URL ??
  "http://localhost:8000";

export const COMPANY = "Lifestyle Retail Stores";
export const TILL = "E2E Till 1"; // prefixed
export const PREFIX = "E2E1";
export const PLAIN_TILL = "E2E Till 2"; // no prefix
export const ITEM = "E2E-ITEM";
// A group without a loyalty program: offline Pay mis-totals loyalty customers (see report).
export const CUSTOMER = "E2E Walk-in Customer";
export const SECOND_USER = "e2e.cashier2@example.com";
const ITEM_GROUP = "E2E Items";
// From .env.test, not the repo: seeding creates this user with POS access on the target site.
const SECOND_USER_PASSWORD = env.POSPIRE_E2E_SECOND_USER_PASSWORD ?? "";
if (!SECOND_USER_PASSWORD) {
  throw new Error("Set POSPIRE_E2E_SECOND_USER_PASSWORD in .env.test");
}

export async function adminApi(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      Authorization: `token ${env.POSPIRE_E2E_API_KEY}:${env.POSPIRE_E2E_API_SECRET}`,
      Accept: "application/json",
    },
  });
}

/** An API context logged in with a password session (for a user without API keys). */
export async function userApi(
  usr: string,
  pwd: string,
): Promise<APIRequestContext> {
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Accept: "application/json" },
  });
  expect(
    (await ctx.post("/api/method/login", { data: { usr, pwd } })).ok(),
    `login ${usr}`,
  ).toBeTruthy();
  return ctx;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public excType: string | undefined,
    public status: number,
  ) {
    super(message);
  }
}

function serverMessage(body: any): string {
  try {
    const msgs = JSON.parse(body._server_messages || "[]").map(
      (m: string) => JSON.parse(m).message,
    );
    if (msgs.length) return msgs.join(" | ");
  } catch {
    // fall through
  }
  return body.exception || body.message || JSON.stringify(body).slice(0, 500);
}

export async function callMethod(
  api: APIRequestContext,
  method: string,
  args: object = {},
) {
  const r = await api.post(`/api/method/${method}`, { data: args });
  const body = await r.json().catch(() => ({}));
  if (!r.ok())
    throw new ApiError(serverMessage(body), body.exc_type, r.status());
  return body.message;
}

async function rest(
  api: APIRequestContext,
  verb: "get" | "post" | "put" | "delete",
  url: string,
  data?: object,
) {
  const r = await api[verb](url, data ? { data } : undefined);
  const body = await r.json().catch(() => ({}));
  if (!r.ok())
    throw new ApiError(serverMessage(body), body.exc_type, r.status());
  return body.data;
}

const res = (doctype: string, name = "") =>
  `/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ""}`;

export async function getDoc(
  api: APIRequestContext,
  doctype: string,
  name: string,
) {
  return rest(api, "get", res(doctype, name));
}

export async function exists(
  api: APIRequestContext,
  doctype: string,
  name: string,
): Promise<boolean> {
  const r = await api.get(res(doctype, name));
  return r.ok();
}

export async function list(
  api: APIRequestContext,
  doctype: string,
  filters: unknown[],
  fields = ["name"],
  orderBy = "creation desc",
) {
  const q = new URLSearchParams({
    filters: JSON.stringify(filters),
    fields: JSON.stringify(fields),
    order_by: orderBy,
    limit_page_length: "0",
  });
  return rest(api, "get", `${res(doctype)}?${q}`);
}

async function ensure(
  api: APIRequestContext,
  doctype: string,
  name: string,
  doc: object,
) {
  if (!(await exists(api, doctype, name)))
    await rest(api, "post", res(doctype), { name, __newname: name, ...doc });
}

function profileDoc(prefix: string, customer: string) {
  return {
    company: COMPANY,
    customer,
    warehouse: "Sales Floor - LRS",
    selling_price_list: "Standard Selling",
    currency: "INR",
    write_off_account: "Write Off - LRS",
    write_off_cost_center: "Main - LRS",
    income_account: "Sales - LRS",
    taxes_and_charges: "GST 18% Output - LRS",
    posa_tax_inclusive: 1,
    update_stock: 1,
    posa_cash_mode_of_payment: "Cash",
    set_grand_total_to_default_mop: 1,
    posa_allow_print_last_invoice: 1,
    // Off so an abandoned Pay leaves its draft and the next Pay must replace it.
    posa_allow_delete: 0,
    posa_allow_return: 1,
    pospire_invoice_prefix: prefix,
    payments: [{ mode_of_payment: "Cash", default: 1 }],
    applicable_for_users: [
      { user: env.POSPIRE_E2E_USERNAME || "Administrator", default: 0 },
      { user: SECOND_USER, default: 0 },
    ],
  };
}

/** Idempotent: creates the E2E records once and reuses them afterwards. */
export async function seed(api: APIRequestContext): Promise<void> {
  await ensure(api, "Item Group", ITEM_GROUP, {
    item_group_name: ITEM_GROUP,
    parent_item_group: "All Item Groups",
  });
  await ensure(api, "Item", ITEM, {
    item_code: ITEM,
    item_name: "E2E Test Item",
    item_group: ITEM_GROUP,
    stock_uom: "Nos",
    is_stock_item: 0,
    gst_hsn_code: "640419",
  });
  const prices = await list(api, "Item Price", [
    ["item_code", "=", ITEM],
    ["price_list", "=", "Standard Selling"],
  ]);
  if (!prices.length) {
    await rest(api, "post", res("Item Price"), {
      item_code: ITEM,
      price_list: "Standard Selling",
      price_list_rate: 100,
    });
  }
  // Customers are named by series here, so match on customer_name.
  let [customer] = await list(api, "Customer", [
    ["customer_name", "=", CUSTOMER],
  ]);
  customer ??= await rest(api, "post", res("Customer"), {
    customer_name: CUSTOMER,
    customer_group: "Individual",
    customer_type: "Individual",
    gst_category: "Unregistered",
  });
  await ensure(api, "User", SECOND_USER, {
    email: SECOND_USER,
    first_name: "E2E Cashier 2",
    send_welcome_email: 0,
    new_password: SECOND_USER_PASSWORD,
    roles: [
      { role: "Sales User" },
      { role: "Accounts User" },
      { role: "Stock User" },
    ],
  });
  for (const [name, prefix] of [
    [TILL, PREFIX],
    [PLAIN_TILL, ""],
  ]) {
    const doc = profileDoc(prefix, customer.name);
    if (await exists(api, "POS Profile", name))
      await rest(api, "put", res("POS Profile", name), doc);
    else
      await rest(api, "post", res("POS Profile"), {
        name,
        __newname: name,
        ...doc,
      });
  }
}

/** Closes every open shift on the profile and frees its device link, so a new browser context can claim it. */
export async function resetTill(
  api: APIRequestContext,
  profile: string,
): Promise<void> {
  const open = await list(api, "POS Opening Shift", [
    ["pos_profile", "=", profile],
    ["docstatus", "=", 1],
    ["status", "=", "Open"],
  ]);
  for (const { name } of open) {
    const closing = await callMethod(
      api,
      "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.make_closing_shift_from_opening",
      {
        opening_shift: await getDoc(api, "POS Opening Shift", name),
      },
    );
    await callMethod(
      api,
      "pospire.pospire.doctype.pos_closing_shift.pos_closing_shift.submit_closing_shift",
      { closing_shift: closing },
    );
  }
  await rest(api, "put", res("POS Profile", profile), {
    pospire_linked_device: "",
  });
  // Unused Pay drafts left by an earlier test would block a desk insert of that number.
  const drafts = await list(api, "Sales Invoice", [
    ["pos_profile", "=", profile],
    ["name", "like", `${PREFIX}/%`],
    ["docstatus", "=", 0],
  ]);
  for (const { name } of drafts)
    await rest(api, "delete", res("Sales Invoice", name));
}

/** Opens a shift as the API user (the .env.test user). Returns the shift name. */
export async function openShift(
  api: APIRequestContext,
  profile: string,
): Promise<string> {
  const r = await callMethod(
    api,
    "pospire.pospire.api.posapp.create_opening_voucher",
    {
      pos_profile: profile,
      company: COMPANY,
      balance_details: [{ mode_of_payment: "Cash", amount: 0 }],
    },
  );
  return r.pos_opening_shift.name;
}

export async function freshTill(
  api: APIRequestContext,
  profile = TILL,
): Promise<string> {
  await resetTill(api, profile);
  return openShift(api, profile);
}

export async function fyCode(api: APIRequestContext): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const fy = await callMethod(api, "erpnext.accounts.utils.get_fiscal_year", {
    date: today,
    company: COMPANY,
    as_dict: 1,
  });
  return String(fy.year_start_date).slice(2, 4);
}

export const fmt = (fy: string, n: number) =>
  `${PREFIX}/${fy}/${String(n).padStart(6, "0")}`;

/** Mirrors get_last_number: highest submitted/cancelled number, raised to the device-reset floor. */
export async function lastUsed(
  api: APIRequestContext,
  fy: string,
): Promise<number> {
  const rows = await list(
    api,
    "Sales Invoice",
    [
      ["name", "like", `${PREFIX}/${fy}/%`],
      ["docstatus", "in", [1, 2]],
    ],
    ["name"],
    "name desc",
  );
  const top = rows
    .map((r: { name: string }) => r.name)
    .find((n: string) => /^\w+\/\d{2}\/\d{6}$/.test(n));
  const last = top ? Number(top.slice(-6)) : 0;
  const p = await getDoc(api, "POS Profile", TILL);
  return p.pospire_floor_fy === fy
    ? Math.max(last, p.pospire_floor_number || 0)
    : last;
}

export async function invoice(api: APIRequestContext, name: string) {
  return getDoc(api, "Sales Invoice", name);
}

/** Drafts on the server that hold a number of this till. */
export async function terminalDrafts(
  api: APIRequestContext,
  fy: string,
): Promise<string[]> {
  const rows = await list(api, "Sales Invoice", [
    ["name", "like", `${PREFIX}/${fy}/%`],
    ["docstatus", "=", 0],
  ]);
  return rows.map((r: { name: string }) => r.name);
}

/** Inserts and submits a desk-style invoice on the till's profile that takes `number`. */
export async function submitInvoiceWithNumber(
  api: APIRequestContext,
  number: string,
) {
  const [customer] = await list(api, "Customer", [
    ["customer_name", "=", CUSTOMER],
  ]);
  return rest(api, "post", res("Sales Invoice"), {
    company: COMPANY,
    customer: customer.name,
    pos_profile: TILL,
    pospire_terminal_number: number,
    // Local date, not UTC: the server posts in IST, and a UTC date is a day behind before 05:30.
    due_date: new Date().toLocaleDateString("en-CA"),
    items: [{ item_code: ITEM, qty: 1, rate: 100 }],
    docstatus: 1,
  });
}

// ---------------------------------------------------------------- browser

export async function login(
  page: Page,
  user = env.POSPIRE_E2E_USERNAME,
  pwd = env.POSPIRE_E2E_PASSWORD,
) {
  const r = await page.request.post("/api/method/login", {
    data: { usr: user, pwd },
  });
  expect(r.ok(), "login").toBeTruthy();
}

export const secondUser = { user: SECOND_USER, pwd: SECOND_USER_PASSWORD };

export async function openPos(page: Page) {
  // Items must be loaded before a test goes offline.
  const items = page.waitForResponse(
    (r) =>
      r.url().includes("/api/method/pospire.pospire.api.posapp.get_items") &&
      r.ok(),
    { timeout: 30_000 },
  );
  await page.goto("/pospire");
  await items;
  await expect(page.getByPlaceholder(/Search by name/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Online", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Fills the Create Opening Shift dialog for `profile` and submits it. */
export async function openShiftInDialog(page: Page, profile: string) {
  const dialog = page
    .locator(".v-dialog")
    .filter({ hasText: "Create Opening Shift" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel("Store").click();
  await page.getByRole("option", { name: COMPANY, exact: true }).click();
  await dialog.getByLabel("POS Profile").click();
  await page.getByRole("option", { name: profile, exact: true }).click();
  await dialog.getByRole("button", { name: "Create Opening Shift" }).click();
}

