/**
 * Per-terminal invoice numbers (#33385), driven through the POS UI on a seeded
 * "E2E Till 1" (prefix E2E1) and "E2E Till 2" (no prefix). Server state is
 * checked through REST. One file on purpose: every test shares the E2E till,
 * so they run in order in one worker; each starts on a fresh device and shift.
 *
 * Run: npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/terminal-number --project=chromium
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Response,
} from "@playwright/test";
import * as h from "./helpers";

test.describe.configure({ mode: "default", timeout: 120_000 });

const NOT_READY =
  "Invoice numbers for this till are not ready. Connect to the internet and reopen POSpire.";
const OTHER_DEVICE =
  "This POS Profile is linked to another device. Ask a manager to unlink it.";
const CONFLICT = "That invoice number was already used. Press Pay again.";
const OTHER_TAB = "POSpire is already open in another tab on this computer.";
const HELD = "Draft saved on this till.";

let api: APIRequestContext;
let fy: string;

test.beforeAll(async ({ browserName }) => {
  // The tests seed and claim the same tills, so a second browser project would race them.
  test.skip(browserName !== "chromium", "terminal tests run on Chromium only");
  api = await h.adminApi();
  await h.seed(api);
  fy = await h.fyCode(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

const isMethod = (method: string) => (r: Response) =>
  r.url().includes(`/api/method/${method}`) && r.request().method() === "POST";

async function openTill(page: Page, profile = h.TILL) {
  await h.freshTill(api, profile);
  await h.login(page);
  const claim =
    profile === h.TILL
      ? page.waitForResponse(
          isMethod("pospire.pospire.api.terminal_number.claim_terminal"),
        )
      : null;
  await h.openPos(page);
  if (claim) await claim;
}

async function addItem(page: Page) {
  await page.getByPlaceholder(/Search by name/).fill("E2E Test");
  await page.getByText(h.ITEM, { exact: true }).click();
  await expect(page.getByLabel("Total Qty")).toHaveValue("1.00");
}

/** Clicks PAY and waits for the payment panel. Returns the server draft name when online. */
async function pay(page: Page, online = true): Promise<string | undefined> {
  const draft = online
    ? page.waitForResponse(
        isMethod("pospire.pospire.api.posapp.update_invoice"),
      )
    : null;
  await page.getByRole("button", { name: "PAY" }).click();
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeVisible();
  if (!draft) return undefined;
  const body = await (await draft).json();
  return body.message?.name;
}

async function submitOnline(page: Page): Promise<string> {
  const done = page.waitForResponse(
    isMethod("pospire.pospire.api.posapp.submit_invoice"),
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const name = (await (await done).json()).message.name;
  await expect(page.getByText(`Invoice ${name} is Submited`)).toBeVisible();
  return name;
}

async function submitOffline(page: Page) {
  // Offline Pay does not prefill the default mode of payment, so tender cash in full.
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.getByLabel("To Be Paid")).toHaveValue("0.00");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText(/^Queued /).last()).toBeVisible();
  await expect(page.getByLabel("Total Qty")).toHaveValue("0.00");
}

async function goOffline(page: Page) {
  await page.context().setOffline(true);
  // The detector needs two failed pings plus a debounce before it flips.
  await expect(page.getByText("Offline", { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
}

async function goOnline(page: Page) {
  await page.context().setOffline(false);
  const retry = page.getByRole("button", { name: "Try connection now" });
  if (await retry.isVisible()) await retry.click();
  await expect(page.getByText("Online", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
}

async function expectSubmitted(name: string) {
  await expect
    .poll(
      async () =>
        (await h.exists(api, "Sales Invoice", name)) &&
        (await h.invoice(api, name)).docstatus,
      {
        message: `${name} submitted`,
        timeout: 60_000,
      },
    )
    .toBe(1);
}

async function offlineReceipts(page: Page): Promise<string[]> {
  await page.locator(".menu-button").click();
  await page.getByText("Offline receipts", { exact: true }).click();
  const dialog = page.locator(".offline-receipts");
  await expect(dialog.locator(".v-list-item").first()).toBeVisible();
  const titles = await dialog.locator(".v-list-item-title").allInnerTexts();
  await dialog.getByRole("button").first().click(); // close
  return titles.map((t) => t.trim());
}

test("1. online sale is named PREFIX/YY/NNNNNN", async ({ page }) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n));
  expect((await h.invoice(api, h.fmt(fy, n))).pos_profile).toBe(h.TILL);

  // Print Last Invoice opens the receipt for that number.
  await page.locator(".menu-button").click();
  const popup = page.waitForEvent("popup");
  await page.getByText("Print Last Invoice", { exact: true }).click();
  expect(decodeURIComponent((await popup).url())).toContain(
    `name=${h.fmt(fy, n)}`,
  );
});

test("2. abandoned Pay: the next cart reuses the number and no draft is left", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));
  await page.getByRole("button", { name: "Cancel Payment" }).click();
  await page.getByRole("button", { name: "Cancel Sale" }).click();
  await page
    .locator(".v-dialog")
    .getByRole("button", { name: "Cancel Sale" })
    .click();
  await expect(page.getByLabel("Total Qty")).toHaveValue("0.00");

  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n));
  expect(await h.terminalDrafts(api, fy)).toEqual([]);
});

test("3. reload after an abandoned Pay still uses the unused number", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));

  const claim = page.waitForResponse(
    isMethod("pospire.pospire.api.terminal_number.claim_terminal"),
  );
  await page.reload();
  await claim;
  await expect(page.getByLabel("Total Qty")).toHaveValue("0.00"); // the cart is not restored
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n));
  expect(await h.terminalDrafts(api, fy)).toEqual([]);
});

test("3b. a reload claims the till twice at once and the counter survives", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  await pay(page);
  expect(await submitOnline(page)).toBe(h.fmt(fy, n));

  // As if the till was linked before device keys existed: its first key arrives with this reload.
  execFileSync(
    "bench",
    [
      "execute", // on the bench's current site, the one this suite runs against
      "frappe.utils.password.remove_encrypted_password",
      "--kwargs",
      JSON.stringify({
        doctype: "POS Profile",
        name: h.TILL,
        fieldname: "pospire_device_keys",
      }),
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../../../../../.."),
      stdio: "ignore",
    },
  );
  // A manager saved the POS Profile since the till booted, so the boot registers the till from its
  // cached shift and again from the server: two claims in flight.
  const saved = await api.put(
    `/api/resource/POS Profile/${encodeURIComponent(h.TILL)}`,
    { data: { pospire_reset_skip: 50 } },
  );
  expect(saved.ok()).toBeTruthy();
  // Hold the first claim back (a slow till network) so the second is sent before it returns.
  let claims = 0;
  await page.route(
    (url) => url.pathname.endsWith("terminal_number.claim_terminal"),
    async (route) => {
      if (claims++ === 0) await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    },
  );
  await page.reload();
  await expect(page.getByPlaceholder(/Search by name/)).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => claims, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(6000); // let both claims land
  await expect(page.getByText(OTHER_DEVICE)).toHaveCount(0);

  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n + 1));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n + 1));
});

test("4. two offline sales take N and N+1 and sync under those names", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await goOffline(page);
  for (let i = 0; i < 2; i++) {
    await addItem(page);
    await pay(page, false);
    await submitOffline(page);
  }
  const slips = await offlineReceipts(page);
  expect(slips).toEqual(
    expect.arrayContaining([h.fmt(fy, n), h.fmt(fy, n + 1)]),
  );
  expect(slips.some((s) => s.startsWith("OFFLINE-"))).toBe(false);

  await goOnline(page);
  await expectSubmitted(h.fmt(fy, n));
  await expectSubmitted(h.fmt(fy, n + 1));
});

test("4s. the offline sale confirmation names the till number", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await goOffline(page);
  await addItem(page);
  await pay(page, false);
  await submitOffline(page);
  const queued = await page
    .getByText(/^Queued /)
    .last()
    .innerText();
  await goOnline(page); // sync first so a failure here leaves nothing queued
  await expectSubmitted(h.fmt(fy, n));
  expect(queued).toContain(h.fmt(fy, n));
});

test("4r. a cart started offline can be paid in full", async ({ page }) => {
  await openTill(page);
  await goOffline(page);
  await addItem(page);
  await pay(page, false);
  await expect(page.getByLabel("To Be Paid")).toHaveValue("0.00");
});

test("5. Pay online, finish offline: syncs under the same number with no orphan draft", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n));
  await goOffline(page);
  await submitOffline(page);
  await goOnline(page);
  await expectSubmitted(h.fmt(fy, n));
  expect(await h.terminalDrafts(api, fy)).toEqual([]);
});

test("6. a held cart takes the next number when it is paid", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  await page.getByRole("button", { name: "Save and Clear" }).click();
  await expect(page.getByText(HELD)).toBeVisible();

  await addItem(page);
  await pay(page);
  expect(await submitOnline(page)).toBe(h.fmt(fy, n));

  await page.getByRole("button", { name: "Load Draft sales" }).click();
  const dialog = page
    .locator(".v-dialog")
    .filter({ hasText: "Load Sales Invoice" });
  const rows = dialog.locator("tbody tr");
  await expect(rows).toHaveCount(1); // listed once
  await rows
    .first()
    .locator("input[type=checkbox], input[type=radio]")
    .first()
    .check();
  await dialog.getByRole("button", { name: "Load Sale" }).click();
  await expect(page.getByLabel("Total Qty")).toHaveValue("1.00");
  expect(await pay(page)).toBe(h.fmt(fy, n + 1));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n + 1));
});

test("7a. a second tab on a numbered till is blocked", async ({ page }) => {
  await openTill(page);
  const second = await page.context().newPage();
  // The blocked tab must not claim the till (or create a device key) before it is blanked.
  let claims = 0;
  second.on("request", (r) => {
    if (r.url().includes("terminal_number.claim_terminal")) claims++;
  });
  await second.goto("/pospire");
  await expect(second.getByText(OTHER_TAB)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(OTHER_TAB)).toHaveCount(0);
  await second.waitForTimeout(3000);
  expect(claims).toBe(0);
});

test("7b. a second tab on a till without a prefix works", async ({ page }) => {
  await openTill(page, h.PLAIN_TILL);
  const second = await page.context().newPage();
  await h.openPos(second);
  await expect(second.getByText(OTHER_TAB)).toHaveCount(0);
  await addItem(second);
});

/** Wipes this browser's till data (localStorage incl. device id, IndexedDB) but keeps the login. */
async function wipeTill(page: Page) {
  await page.goto("/api/method/ping");
  await page.evaluate(async () => {
    localStorage.clear();
    for (const db of await indexedDB.databases())
      if (db.name) indexedDB.deleteDatabase(db.name);
  });
}

test("8a. wiped till: the cashier is told the till is linked to another device", async ({
  page,
}) => {
  await openTill(page);
  await wipeTill(page);
  await h.openPos(page);
  await expect(page.getByText(OTHER_DEVICE)).toBeVisible();
});

test("8b. wiped till: no numbers until a manager unlinks the device, then it skips ahead", async ({
  page,
}) => {
  await openTill(page); // links this device
  await wipeTill(page);
  const refused = page.waitForResponse(
    isMethod("pospire.pospire.api.terminal_number.claim_terminal"),
  );
  await h.openPos(page);
  const r = await refused;
  expect(r.status()).toBe(417);
  expect((await r.json()).exc_type).toBe("TerminalDeviceMismatch");

  // Online Pay: no counter on the till, so no number and no server draft.
  await addItem(page);
  await page.getByRole("button", { name: "PAY" }).click();
  await expect(page.getByText(NOT_READY)).toBeVisible();

  // Offline Pay: same.
  await goOffline(page);
  await page.getByRole("button", { name: "PAY" }).click();
  await expect(page.getByText(NOT_READY).last()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeHidden();
  await goOnline(page);

  const last = await h.lastUsed(api, fy);
  const skip =
    (await h.getDoc(api, "POS Profile", h.TILL)).pospire_reset_skip ?? 50;
  const reason = `E2E wipe ${Date.now()}`;
  const { floor } = await h.callMethod(
    api,
    "pospire.pospire.api.terminal_number.unlink_terminal_device",
    {
      pos_profile: h.TILL,
      reason,
    },
  );
  expect(floor).toBe(last + skip);

  const claim = page.waitForResponse(
    isMethod("pospire.pospire.api.terminal_number.claim_terminal"),
  );
  await page.reload();
  expect((await claim).ok()).toBeTruthy();
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, last + skip + 1));
  expect(await submitOnline(page)).toBe(h.fmt(fy, last + skip + 1));

  const comments = await h.list(api, "Comment", [
    ["reference_doctype", "=", "POS Profile"],
    ["reference_name", "=", h.TILL],
    ["content", "like", `Device reset:%${reason}%`],
  ]);
  expect(comments).toHaveLength(1);
});

test("9. a till without a prefix keeps the naming series", async ({ page }) => {
  await openTill(page, h.PLAIN_TILL);
  await addItem(page);
  const draft = await pay(page);
  const name = await submitOnline(page);
  expect(name).toBe(draft);
  expect(name).not.toMatch(/^[A-Z][A-Z0-9]{0,3}\/\d{2}\/\d{6}$/);
  const doc = await h.invoice(api, name);
  expect(doc.pos_profile).toBe(h.PLAIN_TILL);
  expect(name.startsWith(doc.naming_series.split(".")[0])).toBe(true);
});

test("10. a return on a numbered till keeps the naming series", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await addItem(page);
  await pay(page);
  const original = await submitOnline(page);
  expect(original).toBe(h.fmt(fy, n));

  await page.getByRole("button", { name: "Sales Return" }).click();
  const dialog = page
    .locator(".v-dialog")
    .filter({ hasText: "Select Return Invoice" });
  await dialog.getByRole("textbox", { name: /Invoice ID/ }).fill(original);
  await dialog.getByRole("button", { name: "Search" }).click();
  await dialog
    .getByRole("row", { name: original })
    .getByRole("checkbox")
    .check();
  await dialog.getByRole("button", { name: "Select Items" }).click();
  await page.getByRole("button", { name: "Load Return" }).click();
  const ret = await pay(page);
  const name = await submitOnline(page);
  expect(name).toBe(ret);
  const doc = await h.invoice(api, name);
  expect(doc.is_return).toBe(1);
  expect(doc.return_against).toBe(original);
  expect(name).not.toMatch(/^[A-Z][A-Z0-9]{0,3}\/\d{2}\/\d{6}$/);
  expect(name.startsWith(doc.naming_series.split(".")[0])).toBe(true);
  // The return did not use up a till number.
  await addItem(page);
  expect(await pay(page)).toBe(h.fmt(fy, n + 1));
});

test("11. a number taken elsewhere: conflict message, then the next number works", async ({
  page,
}) => {
  await openTill(page);
  const n = (await h.lastUsed(api, fy)) + 1;
  await h.submitInvoiceWithNumber(api, h.fmt(fy, n));

  await addItem(page);
  await page.getByRole("button", { name: "PAY" }).click();
  await expect(page.getByText(CONFLICT)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeHidden();

  expect(await pay(page)).toBe(h.fmt(fy, n + 1));
  expect(await submitOnline(page)).toBe(h.fmt(fy, n + 1));
});

test("12a. a second user cannot open a shift on a numbered till that has one open", async () => {
  const shift = await h.freshTill(api);
  const cashier2 = await h.userApi(h.secondUser.user, h.secondUser.pwd);
  const err = await h
    .callMethod(cashier2, "pospire.pospire.api.posapp.create_opening_voucher", {
      pos_profile: h.TILL,
      company: h.COMPANY,
      balance_details: [{ mode_of_payment: "Cash", amount: 0 }],
    })
    .catch((e) => e);
  await cashier2.dispose();
  expect(err).toBeInstanceOf(h.ApiError);
  expect(err.message).toBe(
    `POS Profile ${h.TILL} already has an open shift (${shift}).`,
  );
});

test("12b. the opening dialog shows the open-shift message", async ({
  page,
}) => {
  const shift = await h.freshTill(api);
  await h.login(page, h.secondUser.user, h.secondUser.pwd);
  const opening = page.waitForResponse(
    isMethod("pospire.pospire.api.posapp.create_opening_voucher"),
  );
  await page.goto("/pospire");
  await h.openShiftInDialog(page, h.TILL);
  expect((await opening).ok()).toBe(false);
  await expect(
    page.getByText(
      `POS Profile ${h.TILL} already has an open shift (${shift}).`,
    ),
  ).toBeVisible();
});
