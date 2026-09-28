// AES-256-GCM at-rest cipher for memory pages (memory202 doc 06 — DEVELOP MVP).
//
// LOCAL-FIRST model (user-decided, do NOT redesign): the daemon holds a
// per-workspace symmetric key; the cloud stores only ciphertext and NEVER
// holds the key. This module is the cipher primitive ONLY — key generation /
// persistence lives in `key-manager.ts`, and the encrypt/decrypt *call sites*
// (outbox flush, cloud sync-down) thread the key through.
//
// IMPORTANT (doc 18 M4 invariant, preserved here): the AES cipher MUST live in
// the DAEMON, never the cloud. The cloud crypto module (`src/im/crypto`) is
// signing-only (Ed25519/DID) and must never gain a decrypt path — if it could
// decrypt, the "cloud can't read encrypted memory" guarantee is void.
//
// Packed format (self-describing single string):
//
//   v1:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>
//
//   - version prefix `v1` so a future scheme (key rotation, AES-256-SIV, …)
//     can coexist on disk / on the wire without ambiguity.
//   - iv  = random 12-byte nonce per encryption (GCM standard).
//   - tag = 16-byte GCM authentication tag (verified on decrypt; tamper throws).
//   - ct  = ciphertext.
//
// base64url (no padding) so the packed string is URL/JSON-safe and never
// collides with the `:` delimiter (base64url alphabet excludes `:`).

import * as crypto from 'node:crypto';

/** AES-256 key length in bytes. Exported so the key manager generates the right size. */
export const MEMORY_KEY_BYTES = 32;

/** GCM nonce length in bytes (NIST-recommended 96-bit IV). */
const IV_BYTES = 12;

/** GCM authentication tag length in bytes (128-bit). */
const TAG_BYTES = 16;

const VERSION = 'v1';

const MODULE = '[memory-cipher]';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(s: string | undefined): Buffer {
  if (typeof s !== 'string') {
    throw new Error(`${MODULE} decrypt: missing packed segment`);
  }
  return Buffer.from(s, 'base64url');
}

/**
 * Encrypt plaintext with an AES-256-GCM key. Returns the self-describing
 * packed string (`v1:iv:tag:ct`). A fresh random 12-byte IV is generated per
 * call — NEVER reuse an IV/key pair (GCM nonce-reuse is catastrophic), which
 * the random-per-call IV guarantees.
 *
 * Fail-closed: an invalid key length throws (never silently produces a
 * weakly-keyed / unencrypted blob).
 */
export function encrypt(plaintext: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== MEMORY_KEY_BYTES) {
    throw new Error(`${MODULE} encrypt: key must be ${MEMORY_KEY_BYTES} bytes (got ${key?.length ?? 'n/a'})`);
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${b64url(iv)}:${b64url(tag)}:${b64url(ct)}`;
}

/**
 * Decrypt a packed string produced by `encrypt`. The GCM tag is verified — any
 * tampering with iv/tag/ct (or a wrong key) makes `decipher.final()` throw, so
 * a corrupted/forged ciphertext NEVER yields plaintext (authenticated).
 *
 * Fail-closed: a malformed packed string, unknown version, or bad key length
 * throws rather than returning a best-effort / partial result.
 */
export function decrypt(packed: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== MEMORY_KEY_BYTES) {
    throw new Error(`${MODULE} decrypt: key must be ${MEMORY_KEY_BYTES} bytes (got ${key?.length ?? 'n/a'})`);
  }
  if (typeof packed !== 'string') {
    throw new Error(`${MODULE} decrypt: packed must be a string`);
  }
  const parts = packed.split(':');
  if (parts.length !== 4) {
    throw new Error(`${MODULE} decrypt: malformed packed string (expected 4 segments, got ${parts.length})`);
  }
  const version = parts[0];
  if (version !== VERSION) {
    throw new Error(`${MODULE} decrypt: unsupported cipher version ${JSON.stringify(version)}`);
  }
  const iv = fromB64url(parts[1]);
  const tag = fromB64url(parts[2]);
  const ct = fromB64url(parts[3]);
  if (iv.length !== IV_BYTES) {
    throw new Error(`${MODULE} decrypt: bad iv length ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`${MODULE} decrypt: bad tag length ${tag.length}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // final() throws on tag mismatch — authenticated decryption, fail-closed.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Cheap structural check: does this string look like a `v1:` packed ciphertext?
 * Used by the cloud-sync-down path to distinguish ciphertext (decrypt) from
 * plaintext (store as-is) defensively. NOT a substitute for `decrypt`'s
 * authenticated verification — it only gates which branch to take.
 */
export function isPackedCiphertext(s: unknown): boolean {
  return typeof s === 'string' && s.startsWith(`${VERSION}:`) && s.split(':').length === 4;
}
