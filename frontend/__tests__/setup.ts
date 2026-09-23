/**
 * Global test setup.
 *
 * 1. `fake-indexeddb/auto` patches `globalThis.indexedDB` + `IDBKeyRange` so
 *    Dexie opens a real, in-memory IndexedDB implementation. Every test file
 *    that imports `@/offline/db` transitively boots up against this fake.
 * 2. Web Crypto in happy-dom is already wired to the Node `webcrypto` export,
 *    so `crypto.subtle.generateKey`, `subtle.encrypt/decrypt`, and
 *    `crypto.randomUUID` Just Work. We keep a defensive fallback for the
 *    rare CI image that omits it.
 * 3. `localStorage` is provided by happy-dom. We clear it between tests so
 *    the `pospire.device_id` seed from one test doesn't leak into another.
 *
 * IMPORTANT: Do NOT import any `@/offline/...` modules from this file.
 * Modules initialise lazily; tests import them directly so the fresh module
 * graph per test file gets a fresh in-memory IndexedDB.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach } from "vitest";

// Fallback: some CI containers ship a very minimal Web Crypto. Wire up a
// Node-backed one before the first test runs.
//
// `CryptoKey` ALSO needs to be exposed as a global. happy-dom doesn't
// install the constructor on globalThis even when it provides `crypto`, so
// `db.ts.bootstrapEncryptionKey()`'s `storedKey.value instanceof CryptoKey`
// throws `ReferenceError: CryptoKey is not defined` under vitest. Pull it
// from Node's webcrypto and bind it ourselves.
{
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { webcrypto } = require("node:crypto");

	if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
		Object.defineProperty(globalThis, "crypto", {
			value: webcrypto,
			writable: false,
			configurable: true,
		});
	}

	if (typeof globalThis.CryptoKey === "undefined" && webcrypto.CryptoKey) {
		Object.defineProperty(globalThis, "CryptoKey", {
			value: webcrypto.CryptoKey,
			writable: false,
			configurable: true,
		});
	}
}

// Per-test hygiene ---------------------------------------------------------

beforeEach(() => {
	// Reset localStorage so device_id / schema_version seeds are deterministic.
	try {
		localStorage.clear();
	} catch {
		/* happy-dom always provides this; guard for stripped envs */
	}
});

// NOTE: no global afterEach database-delete. Per-test isolation is handled
// by test files calling `setupOfflineStorage()` in their own `beforeEach`,
// which clears all object stores without tearing down the Dexie connection.
// A global `indexedDB.deleteDatabase` here would invalidate the module-level
// Dexie `db` singleton and surface as `DatabaseClosedError` on every test
// after the first.
