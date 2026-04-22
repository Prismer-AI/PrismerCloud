// Memory DB content encryption (opt-in, v1.9.0 soft goal → v2.0 mandatory)
//
// Enables AES-256-GCM encryption of the `content` column in memory_files.
// Rest of the schema (path, description, hashes) stays plaintext so that
// FTS indexing on path+description still works.
//
// Activation (opt-in):
//   PRISMER_DB_ENCRYPTION=1      — turn on encryption for new writes
//   PRISMER_DB_KEY=<base64:32B>  — 32-byte raw key, or
//   PRISMER_DB_KEY_FILE=<path>   — read key from file (must be 32 bytes after base64-decode)
//
// Ciphertext envelope (base64 fields, colon-delimited):
//   ENC:v1:<nonce_b64>:<authTag_b64>:<ciphertext_b64>
//
// Decryption is keyed by the envelope version prefix. Plaintext rows are
// returned as-is so that a DB with mixed plaintext+ciphertext (during lazy
// migration) stays readable. New writes always encrypt when enabled.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

const ENVELOPE_PREFIX = 'ENC:v1:';
const NONCE_LEN = 12;   // GCM recommended
const AUTHTAG_LEN = 16;

export interface ContentCrypto {
  enabled: boolean;
  encrypt: (plaintext: string) => string;
  decrypt: (value: string) => string;
}

function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

function loadKey(): Buffer | null {
  const raw = process.env['PRISMER_DB_KEY'];
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(`PRISMER_DB_KEY must decode to 32 bytes, got ${buf.length}`);
    }
    return buf;
  }
  const keyFile = process.env['PRISMER_DB_KEY_FILE'];
  if (keyFile) {
    const contents = fs.readFileSync(keyFile, 'utf-8').trim();
    const buf = Buffer.from(contents, 'base64');
    if (buf.length !== 32) {
      throw new Error(`PRISMER_DB_KEY_FILE must decode to 32 bytes, got ${buf.length}`);
    }
    return buf;
  }
  return null;
}

export function createContentCrypto(): ContentCrypto {
  const flag = process.env['PRISMER_DB_ENCRYPTION'] === '1';
  if (!flag) {
    return {
      enabled: false,
      encrypt: (s) => s,
      decrypt: (s) => s,
    };
  }

  const key = loadKey();
  if (!key) {
    // Opt-in set but no key — fail loud rather than silently write plaintext.
    throw new Error(
      'PRISMER_DB_ENCRYPTION=1 requires PRISMER_DB_KEY or PRISMER_DB_KEY_FILE ' +
      '(32-byte key, base64-encoded). See sdk/prismer-cloud/runtime/src/memory-db-crypto.ts',
    );
  }

  const encrypt = (plaintext: string): string => {
    if (typeof plaintext !== 'string') return plaintext;
    if (isEncrypted(plaintext)) return plaintext;  // idempotent
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      ENVELOPE_PREFIX.slice(0, -1), // "ENC:v1"
      nonce.toString('base64'),
      authTag.toString('base64'),
      ct.toString('base64'),
    ].join(':');
  };

  const decrypt = (value: string): string => {
    if (typeof value !== 'string') return value;
    if (!isEncrypted(value)) return value;  // plaintext pass-through
    const parts = value.split(':');
    if (parts.length !== 5) {
      throw new Error('Malformed encrypted envelope (expected 5 fields)');
    }
    const [, , nonceB64, authTagB64, ctB64] = parts;
    const nonce = Buffer.from(nonceB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (nonce.length !== NONCE_LEN || authTag.length !== AUTHTAG_LEN) {
      throw new Error('Malformed encrypted envelope (bad nonce/tag length)');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  };

  return { enabled: true, encrypt, decrypt };
}

/** Generate a fresh 32-byte key, base64-encoded, for documentation / key-rotation flows. */
export function generateKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
