/**
 * AES-GCM 256 encryption helper for at-rest encryption of sensitive Dexie
 * rows. Implements the D-24 design:
 *
 *   - Non-extractable CryptoKey generated via `crypto.subtle.generateKey`.
 *   - Key stored directly in Dexie `metadata` (NOT localStorage) as a
 *     structurally-cloneable CryptoKey. Browser enforces that key material
 *     cannot be read from JS; `extractable: false` blocks `exportKey`.
 *   - SHA-256 integrity hash of canonical-JSON plaintext is persisted in
 *     the envelope and re-verified on decrypt. Mismatch throws
 *     `IntegrityMismatchError` so callers can mark the row as corrupt.
 *   - `key_id` lives alongside ciphertext so lazy re-key can ship multiple
 *     keys simultaneously during rotation.
 *
 * Threat-model reminder (see docs/offline/13-security.md §3):
 *   Defends against malicious extensions, IndexedDB export tools, casual
 *   disk access. Does NOT defend against a motivated attacker with OS-level
 *   access and a custom browser build that ignores the extractable flag.
 */

import type { EncryptedEnvelope } from "./types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the SHA-256 of the decrypted plaintext does not match the
 * `payload_integrity_hash` stored in the envelope. A valid AES-GCM tag can
 * only prove the ciphertext was produced with the key and IV we remember;
 * the integrity hash gives us an additional in-band check against silent
 * plaintext truncation / rewrite bugs earlier in the pipeline (e.g. a stale
 * serializer that dropped a line-item). Outbox rows in this state move to
 * `needs_review` with `blocked_reason = 'integrity_mismatch'`.
 */
export class IntegrityMismatchError extends Error {
	readonly expected: string;
	readonly actual: string;
	constructor(expected: string, actual: string) {
		super(
			`Offline payload integrity mismatch: expected ${expected}, got ${actual}`,
		);
		this.name = "IntegrityMismatchError";
		this.expected = expected;
		this.actual = actual;
	}
}

/** Thrown when Web Crypto is not available (very old browser / insecure ctx). */
export class CryptoUnavailableError extends Error {
	constructor() {
		super(
			"Web Crypto API is not available. Offline encryption requires a secure (HTTPS or localhost) context.",
		);
		this.name = "CryptoUnavailableError";
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AES_ALG = "AES-GCM";
const AES_KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12; // NIST-recommended for GCM.

// ---------------------------------------------------------------------------
// Active-key cache — populated by `setActiveKey` at startup (db.ts init).
// Kept in-module so repos can do synchronous `getActiveKey()` calls during
// read/write paths without awaiting Dexie every time. The key itself is
// still authoritatively stored in Dexie `metadata`.
// ---------------------------------------------------------------------------

interface ActiveKey {
	id: string;
	key: CryptoKey;
}

let activeKey: ActiveKey | null = null;

/** Cache of historical keys for lazy re-key (key_id → CryptoKey). */
const keyRing: Map<string, CryptoKey> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a fresh 256-bit AES-GCM CryptoKey that is NON-EXTRACTABLE.
 *
 * The browser blocks `exportKey` on this object, so even a compromised
 * page script can only use it via `subtle.encrypt`/`subtle.decrypt`. The
 * returned object is structurally-cloneable and can be stored directly in
 * IndexedDB.
 */
export async function generateKey(): Promise<CryptoKey> {
	assertSubtle();
	return crypto.subtle.generateKey(
		{ name: AES_ALG, length: AES_KEY_LENGTH },
		false /* extractable */,
		["encrypt", "decrypt"],
	);
}

/**
 * Registers a key as active. Called from db.ts during init after
 * reading / generating the key. The `id` is a UUID v4 minted when the key
 * was created and persisted alongside the key in `metadata`.
 */
export function setActiveKey(id: string, key: CryptoKey): void {
	activeKey = { id, key };
	keyRing.set(id, key);
}

/** Adds a historical (non-active) key to the ring for decrypt-only usage. */
export function registerHistoricalKey(id: string, key: CryptoKey): void {
	if (!keyRing.has(id)) {
		keyRing.set(id, key);
	}
}

/**
 * Returns the current active key, or throws if encryption hasn't been
 * initialised. Callers should treat "no active key" as a bug (db.ts init
 * is supposed to establish one before repos run).
 */
export function getActiveKey(): ActiveKey {
	if (!activeKey) {
		throw new Error(
			"Offline encryption key not initialised. Ensure db.ts init() has run.",
		);
	}
	return activeKey;
}

/** Used by tests and by admin-panel forced re-key flows. */
export function _resetForTests(): void {
	activeKey = null;
	keyRing.clear();
}

/**
 * Encrypts `plaintext` (any structured-clone-safe value) using the active
 * key, returning an envelope ready for persistence.
 *
 * @param plaintext  The value to encrypt. It is serialised via canonical-JSON
 *                   so the integrity hash is deterministic across runtimes.
 * @param key        The CryptoKey to use. Pass the active key's `.key` — we
 *                   take the key explicitly so repos can re-encrypt with a
 *                   specific historical key during rotation.
 * @param keyId      Id of `key` (goes into the envelope).
 * @param aad        Additional authenticated data. Per 13-security §3.1 this
 *                   should be the record's `offline_id` or primary key; it
 *                   prevents ciphertext-swap attacks between rows.
 */
export async function encrypt(
	plaintext: unknown,
	key: CryptoKey,
	keyId: string,
	aad: string,
): Promise<EncryptedEnvelope> {
	assertSubtle();
	const canonical = canonicalStringify(plaintext);
	const plaintextBytes = new TextEncoder().encode(canonical);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
	const aadBytes = new TextEncoder().encode(aad);

	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: AES_ALG, iv, additionalData: aadBytes, tagLength: 128 },
		key,
		plaintextBytes,
	);

	return {
		iv,
		ciphertext: new Uint8Array(ciphertextBuffer),
		payload_integrity_hash: await sha256Hex(plaintextBytes),
		key_id: keyId,
		alg: "AES-GCM-256",
		v: 1,
	};
}

/**
 * Decrypts an envelope. Looks up the key by `envelope.key_id` from the key
 * ring (registered keys). Verifies the SHA-256 integrity hash after decrypt
 * and throws `IntegrityMismatchError` on mismatch.
 *
 * @param envelope  The stored envelope.
 * @param aad       Same AAD that was supplied at encrypt time.
 * @returns The decoded plaintext (parsed from canonical JSON).
 */
export async function decrypt<T = unknown>(
	envelope: EncryptedEnvelope,
	aad: string,
): Promise<T> {
	assertSubtle();
	const key = keyRing.get(envelope.key_id);
	if (!key) {
		throw new Error(
			`Offline decrypt: unknown key_id ${envelope.key_id} (not in keyring)`,
		);
	}
	const aadBytes = new TextEncoder().encode(aad);

	const plaintextBuffer = await crypto.subtle.decrypt(
		{
			name: AES_ALG,
			iv: envelope.iv,
			additionalData: aadBytes,
			tagLength: 128,
		},
		key,
		envelope.ciphertext,
	);
	const plaintextBytes = new Uint8Array(plaintextBuffer);

	const actualHash = await sha256Hex(plaintextBytes);
	if (actualHash !== envelope.payload_integrity_hash) {
		throw new IntegrityMismatchError(
			envelope.payload_integrity_hash,
			actualHash,
		);
	}

	const canonical = new TextDecoder().decode(plaintextBytes);
	return JSON.parse(canonical) as T;
}

/**
 * Computes the SHA-256 hash of a canonical-JSON serialisation of `value`.
 * Exposed so callers (outbox enqueue) can stamp `payload_integrity_hash`
 * onto the outbox row without doing an encrypt (when they already have the
 * envelope from `encrypt` they should just copy the hash from that, but
 * some code paths hash-only).
 */
export async function canonicalIntegrityHash(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(canonicalStringify(value)));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialisation: object keys sorted recursively so two
 * semantically-equal objects produce byte-identical output. Needed so the
 * integrity hash survives object-property-order differences between
 * serialisers (JSON.stringify's key order follows insertion order).
 *
 * Limitations: does not handle cycles (outbox payloads are plain data so this
 * is fine). Skips `undefined` values (JSON semantics). `Date` and other
 * special types should be flattened by the caller before reaching us.
 */
function canonicalStringify(value: unknown): string {
	return JSON.stringify(value, canonicalReplacer);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const v = value as Record<string, unknown>;
		const sortedKeys = Object.keys(v).sort();
		const sorted: Record<string, unknown> = {};
		for (const k of sortedKeys) {
			sorted[k] = v[k];
		}
		return sorted;
	}
	return value;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const arr = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < arr.length; i++) {
		out += arr[i].toString(16).padStart(2, "0");
	}
	return out;
}

function assertSubtle(): void {
	if (
		typeof crypto === "undefined" ||
		typeof crypto.subtle === "undefined" ||
		typeof crypto.subtle.encrypt !== "function"
	) {
		throw new CryptoUnavailableError();
	}
}
