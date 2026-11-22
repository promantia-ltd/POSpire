/**
 * Shared constants between playwright.config.ts, auth.setup.ts, and specs
 * that need to build their own BrowserContext (e.g. smoke.spec.ts's shared
 * `page` across a describe.serial block). Kept in its own module (no
 * `test()` calls) because Playwright forbids importing a file that calls
 * `test()` into the config file itself.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, ".env.test") });

export const AUTH_FILE = path.resolve(__dirname, "auth.json");
export const BASE_URL = process.env.POSPIRE_E2E_BASE_URL ?? "http://localhost:8004";
// Used by api.spec.ts's pure HTTP request tests (Playwright's `request`
// fixture, no browser) — an Authorization: token key:secret header bypasses
// Frappe's CSRF check entirely (see validate_auth_via_api_keys() running in
// validate_auth(), which is called after CSRF validation already passed
// against the pre-auth Guest session), so no browser-derived token is needed.
export const API_KEY = process.env.POSPIRE_E2E_API_KEY ?? "";
export const API_SECRET = process.env.POSPIRE_E2E_API_SECRET ?? "";

// security-test-restricted@pospire.test — a dedicated throwaway user with
// zero roles, used by security.spec.ts's SEC-001 to test whitelisted POS
// API methods directly with a session that has no Sales/POS/Accounts/System
// Manager role at all. See setup_security_test_user.py.
export const RESTRICTED_API_KEY = process.env.POSPIRE_E2E_RESTRICTED_API_KEY ?? "";
export const RESTRICTED_API_SECRET = process.env.POSPIRE_E2E_RESTRICTED_API_SECRET ?? "";
