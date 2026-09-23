/**
 * Crypto helper tests (Agent 1).
 *
 * Spec coverage:
 *   - 13-security.md §3 (AES-GCM 256, non-extractable keys)
 *   - 14-testing-strategy.md §4.4 (round-trip, wrong IV/AAD, corruption)
 *   - 03-storage-layer.md §6     (envelope format, integrity hash)
 *
 * Tests are written against the real Web Crypto implementation provided by
 * happy-dom + Node `webcrypto`. We never stub crypto itself — the goal is to
 * prove the real round-trip works and that mismatches fail as specified.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_resetForTests,
	canonicalIntegrityHash,
	CryptoUnavailableError,
	decrypt,
	encrypt,
	generateKey,
	getActiveKey,
	IntegrityMismatchError,
	setActiveKey,
} from "@/offline/crypto";

// ---------------------------------------------------------------------------
// Fixture — each test generates its own key so cleanup is trivial.
// ---------------------------------------------------------------------------

let key: CryptoKey;
const KEY_ID = "test-key";

beforeEach(async () => {
	_resetForTests();
	key = await generateKey();
	setActiveKey(KEY_ID, key);
});

afterEach(() => {
	_resetForTests();
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("encrypt → decrypt round-trip", () => {
	it("returns the original plaintext for a plain object", async () => {
		const plaintext = {
			customer: "Walk-in",
			lines: [
				{ item: "APPLE", qty: 3, rate: 1.5 },
				{ item: "BREAD", qty: 1, rate: 3.0 },
			],
			tax: 0.05,
		};

		const aad = "outbox:test-id-1";
		const envelope = await encrypt(plaintext, key, KEY_ID, aad);
		const recovered = await decrypt(envelope, aad);

		expect(recovered).toEqual(plaintext);
	});

	it("returns the original for primitives and arrays too", async () => {
		const cases: unknown[] = [
			"hello",
			42,
			true,
			[1, 2, 3],
			{ nested: { empty: null } },
		];
		for (const c of cases) {
			const env = await encrypt(c, key, KEY_ID, "aad");
			expect(await decrypt(env, "aad")).toEqual(c);
		}
	});

	it("produces different ciphertexts for repeated encrypts of the same plaintext (random IV)", async () => {
		const p = { a: 1 };
		const e1 = await encrypt(p, key, KEY_ID, "same");
		const e2 = await encrypt(p, key, KEY_ID, "same");
		// IVs must differ (random 12 bytes).
		expect(Array.from(e1.iv)).not.toEqual(Array.from(e2.iv));
		// And therefore ciphertexts differ.
		expect(Array.from(e1.ciphertext)).not.toEqual(Array.from(e2.ciphertext));
	});
});

// ---------------------------------------------------------------------------
// Integrity mismatch — envelope's integrity hash is tampered with.
// ---------------------------------------------------------------------------

describe("integrity mismatch", () => {
	it("throws IntegrityMismatchError when the stored hash is altered post-encrypt", async () => {
		const envelope = await encrypt({ a: 1 }, key, KEY_ID, "aad");
		// Flip one character in the hash to simulate disk tampering.
		const tampered = {
			...envelope,
			payload_integrity_hash:
				envelope.payload_integrity_hash.replace(/^./, (c) =>
					c === "a" ? "b" : "a",
				),
		};
		await expect(decrypt(tampered, "aad")).rejects.toBeInstanceOf(
			IntegrityMismatchError,
		);
	});

	it("throws on any decrypt with wrong AAD (GCM tag verification fails)", async () => {
		const envelope = await encrypt({ a: 1 }, key, KEY_ID, "right-aad");
		await expect(decrypt(envelope, "wrong-aad")).rejects.toThrow();
	});

	it("throws on any decrypt with corrupted ciphertext", async () => {
		const envelope = await encrypt({ a: 1 }, key, KEY_ID, "aad");
		// Flip a byte in the ciphertext — the GCM auth tag catches this.
		const corrupted = new Uint8Array(envelope.ciphertext);
		corrupted[0] = corrupted[0]! ^ 0xff;
		const tampered = { ...envelope, ciphertext: corrupted };
		await expect(decrypt(tampered, "aad")).rejects.toThrow();
	});

	it("throws on any decrypt with mutated IV", async () => {
		const envelope = await encrypt({ a: 1 }, key, KEY_ID, "aad");
		const newIv = new Uint8Array(envelope.iv);
		newIv[0] = newIv[0]! ^ 0x01;
		const tampered = { ...envelope, iv: newIv };
		await expect(decrypt(tampered, "aad")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Non-extractable key — export must reject
// ---------------------------------------------------------------------------

describe("key is non-extractable", () => {
	it("crypto.subtle.exportKey rejects for the generated CryptoKey", async () => {
		const active = getActiveKey();
		// `extractable: false` was passed at generation. exportKey should
		// reject with an InvalidAccessError (name varies per engine).
		await expect(
			crypto.subtle.exportKey("raw", active.key),
		).rejects.toThrow();
	});

	it("the CryptoKey reports extractable=false", async () => {
		const active = getActiveKey();
		expect(active.key.extractable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// CryptoUnavailableError path — we can't easily remove crypto.subtle in
// happy-dom without breaking other tests, so this test just documents the
// error class surface.
// ---------------------------------------------------------------------------

describe("CryptoUnavailableError", () => {
	it("is a proper Error subclass with a descriptive name", () => {
		const err = new CryptoUnavailableError();
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("CryptoUnavailableError");
		expect(err.message).toMatch(/Web Crypto/);
	});
});

// ---------------------------------------------------------------------------
// canonicalIntegrityHash — stable across key orderings.
// ---------------------------------------------------------------------------

describe("canonicalIntegrityHash", () => {
	it("returns the same hash for objects that differ only in key order", async () => {
		const a = { a: 1, b: 2, c: 3 };
		const b = { c: 3, b: 2, a: 1 };
		expect(await canonicalIntegrityHash(a)).toBe(
			await canonicalIntegrityHash(b),
		);
	});

	it("returns different hashes for different values", async () => {
		expect(await canonicalIntegrityHash({ a: 1 })).not.toBe(
			await canonicalIntegrityHash({ a: 2 }),
		);
	});

	it("returns a 64-char hex string (SHA-256)", async () => {
		const h = await canonicalIntegrityHash({ anything: true });
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});
});
