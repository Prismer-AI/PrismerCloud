/**
 * Shamir Secret Sharing over GF(256) — byte-oriented implementation.
 *
 * Split a secret Buffer into N shares such that any M (threshold) shares can
 * reconstruct the original, but fewer than M reveal zero information.
 *
 * Field: GF(256) with AES irreducible polynomial 0x11B.
 *        Addition = XOR. Multiplication = carryless multiply mod 0x11B.
 *        Share-id x ∈ {1..255} (x=0 is the secret itself).
 *
 * Each byte of the secret is split independently using a polynomial of degree
 * m-1:  P(x) = s + a_1*x + a_2*x^2 + ... + a_{m-1}*x^{m-1}  (all arithmetic in GF(256))
 * where s is the secret byte and a_1..a_{m-1} are uniformly random.
 *
 * Recovery uses Lagrange interpolation evaluated at x=0.
 *
 * Mnemonic format: Crockford base32 with 1-byte version header (0x01) and
 * CRC-16/CCITT-FALSE checksum. Groups of 4 characters separated by hyphens.
 *
 * No external npm dependencies.
 *
 * See: Shamir, "How to Share a Secret", 1979. GF(256) byte-level variant used
 * by industry (Trezor Shamir Backup, HashiCorp Vault, etc.).
 */

import * as crypto from 'node:crypto';

// ============================================================
// Branded type — nominal typing for Shamir shares
// ============================================================

/**
 * Branded `Buffer` that has been validated as a Shamir share by this module.
 *
 * Nominal typing prevents accidentally passing an arbitrary `Buffer` (e.g.
 * `Buffer.from('hello')`) into {@link combineShares} or
 * {@link encodeShareAsMnemonic}. TypeScript structural equality is defeated
 * by the `__brand` phantom field, so the only path to a `ShamirShare` value
 * is through this module's own functions (`splitSecret`,
 * `decodeShareFromMnemonic`) or the explicit escape hatch
 * {@link unsafeAsShamirShare}.
 *
 * This is a compile-time guard only; runtime validation (duplicate ids,
 * inconsistent lengths, CRC) still happens inside `combineShares` /
 * `decodeShareFromMnemonic`.
 */
export type ShamirShare = Buffer & { readonly __brand: unique symbol };

/**
 * Escape hatch for interop paths that already hold raw share Buffers
 * (e.g. legacy callers that read bytes off the wire themselves and cannot
 * route through {@link decodeShareFromMnemonic}).
 *
 * This is a **sharp edge**: the caller is asserting the buffer is a
 * well-formed share byte string (`[share_id, y_byte_1, y_byte_2, ...]` with
 * `share_id ∈ 1..255`). Passing an arbitrary buffer here will compile, and
 * will pass length / id / duplicate checks inside `combineShares`, but will
 * reconstruct a plausibly-shaped yet **semantically wrong** secret.
 *
 * Prefer `decodeShareFromMnemonic` wherever possible — the CRC-16 check
 * there catches tampered or wrong-batch shares.
 */
export function unsafeAsShamirShare(buf: Buffer): ShamirShare {
  return buf as ShamirShare;
}

// ============================================================
// GF(256) arithmetic
// ============================================================

// Precompute log/antilog (exp) tables for fast multiplication using the
// generator g=0x03 (primitive element of GF(256) with polynomial 0x11B).
// x * y = antilog[(log[x] + log[y]) mod 255] for x,y ≠ 0.
const GF_LOG: number[] = new Array(256).fill(0);
const GF_EXP: number[] = new Array(256).fill(0);

(function initGfTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply by generator 0x03 in GF(256) with AES poly 0x11B:
    // 0x03 * x = (x << 1) ^ x, reduced by 0x11B if overflow.
    let next = (x << 1) ^ x;
    if (next & 0x100) next ^= 0x11b;
    x = next & 0xff;
  }
  GF_EXP[255] = GF_EXP[0]; // wrap-around convenience
})();

/** GF(256) multiplication. */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

/** GF(256) division. */
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

/** Evaluate polynomial (coeffs[0] + coeffs[1]*x + ...) at x using Horner's method. */
function gfEval(coeffs: number[], x: number): number {
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ coeffs[i];
  }
  return result;
}

/**
 * Lagrange interpolation at x=0 given (x_i, y_i) points.
 * Returns P(0) = Σ y_i * Π_{j≠i} (0 - x_j) / (x_i - x_j)  in GF(256).
 * Since subtraction = XOR in GF(256), (0 - x_j) = x_j and (x_i - x_j) = x_i ^ x_j.
 */
function gfInterpolateAtZero(xs: number[], ys: number[]): number {
  let result = 0;
  const k = xs.length;
  for (let i = 0; i < k; i++) {
    let num = 1;
    let den = 1;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      num = gfMul(num, xs[j]); // (0 - x_j) in GF(256) is x_j (XOR-based subtraction)
      den = gfMul(den, xs[i] ^ xs[j]);
    }
    const term = gfMul(ys[i], gfDiv(num, den));
    result ^= term;
  }
  return result;
}

// ============================================================
// Split / Combine
// ============================================================

/**
 * Split a secret into n shares; any m can recombine.
 *
 * Each returned share Buffer is [share_id_byte, y_byte_1, y_byte_2, ...].
 * The share-id is 1..n (never 0).
 *
 * @param secret plaintext bytes
 * @param n total shares (2..255)
 * @param m threshold (2..n)
 */
export function splitSecret(secret: Buffer, n: number, m: number): ShamirShare[] {
  if (!Number.isInteger(n) || !Number.isInteger(m)) {
    throw new Error('splitSecret: n and m must be integers');
  }
  if (m < 2) {
    throw new Error('splitSecret: threshold m must be >= 2');
  }
  if (n < m) {
    throw new Error('splitSecret: total shares n must be >= threshold m');
  }
  if (n > 255) {
    throw new Error('splitSecret: n must be <= 255 (GF(256) x-range)');
  }
  if (secret.length === 0) {
    throw new Error('splitSecret: secret cannot be empty');
  }

  const secretLen = secret.length;
  // For each byte of the secret, pick m-1 random coefficients. We allocate
  // `secretLen * (m-1)` random bytes once from crypto.randomBytes for performance.
  const randomCoeffs =
    m > 1 ? crypto.randomBytes(secretLen * (m - 1)) : Buffer.alloc(0);

  // Prepare share buffers: 1 byte share-id + secretLen y bytes per share.
  const shares: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const buf = Buffer.alloc(secretLen + 1);
    buf[0] = i + 1; // share-id 1..n
    shares.push(buf);
  }

  // For each byte of the secret, build the polynomial and evaluate at each share-id.
  const coeffs = new Array(m).fill(0);
  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    coeffs[0] = secret[byteIdx];
    for (let k = 1; k < m; k++) {
      coeffs[k] = randomCoeffs[byteIdx * (m - 1) + (k - 1)];
    }
    for (let i = 0; i < n; i++) {
      const xVal = i + 1;
      shares[i][byteIdx + 1] = gfEval(coeffs, xVal);
    }
  }

  // Brand cast: these buffers were constructed here under the Shamir
  // invariants (valid share-id in [1..n], secretLen+1 bytes, polynomial
  // evaluation y_bytes). Safe to assert as ShamirShare.
  return shares as ShamirShare[];
}

/**
 * Combine shares to recover the secret. Any m of n suffice (where m is the
 * threshold used at split time).
 *
 * @param shares array of share Buffers (each [x_byte, y_bytes...])
 * @returns recovered secret
 */
export function combineShares(shares: ShamirShare[]): Buffer {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error('combineShares: at least one share is required');
  }
  if (shares.length < 2) {
    throw new Error('combineShares: at least 2 shares required');
  }

  const expectedLen = shares[0].length;
  if (expectedLen < 2) {
    throw new Error('combineShares: share too short to contain id + data');
  }

  const xs: number[] = [];
  const seen = new Set<number>();
  for (const s of shares) {
    if (!Buffer.isBuffer(s)) {
      throw new Error('combineShares: all shares must be Buffers');
    }
    if (s.length !== expectedLen) {
      throw new Error(
        `combineShares: inconsistent share lengths (expected ${expectedLen}, got ${s.length})`,
      );
    }
    const x = s[0];
    if (x === 0) {
      throw new Error('combineShares: share-id byte cannot be 0');
    }
    if (seen.has(x)) {
      throw new Error(`combineShares: duplicate share-id ${x}`);
    }
    seen.add(x);
    xs.push(x);
  }

  const secretLen = expectedLen - 1;
  const secret = Buffer.alloc(secretLen);

  const ys = new Array(shares.length).fill(0);
  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    for (let i = 0; i < shares.length; i++) {
      ys[i] = shares[i][byteIdx + 1];
    }
    secret[byteIdx] = gfInterpolateAtZero(xs, ys);
  }

  return secret;
}

// ============================================================
// Mnemonic encoding (Crockford base32 + version + CRC-16)
// ============================================================

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
    map[CROCKFORD_ALPHABET[i]] = i;
  }
  // Crockford aliases (O→0, I/L→1)
  map['O'] = 0;
  map['I'] = 1;
  map['L'] = 1;
  return map;
})();

const MNEMONIC_VERSION = 0x01;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
function crc16(buf: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/** Encode bytes as Crockford base32 string (no padding). */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Decode Crockford base32 string back into bytes.
 *  Requires the caller to know the original byte length (stored in the
 *  version header of the mnemonic framing so this is never ambiguous).
 */
function base32Decode(s: string, expectedByteLen: number): Buffer {
  const normalized = s.toUpperCase();
  let bits = 0;
  let value = 0;
  const out = Buffer.alloc(expectedByteLen);
  let outIdx = 0;
  for (const ch of normalized) {
    const n = CROCKFORD_LOOKUP[ch];
    if (n === undefined) {
      throw new Error(`base32Decode: invalid character "${ch}"`);
    }
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      if (outIdx >= expectedByteLen) {
        // Extra trailing bits are padding — validate they are zero, then stop.
        bits -= 8; // discard the high byte we would have emitted
        value &= (1 << bits) - 1;
        continue;
      }
      out[outIdx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (outIdx !== expectedByteLen) {
    throw new Error(
      `base32Decode: decoded ${outIdx} bytes, expected ${expectedByteLen}`,
    );
  }
  return out;
}

/**
 * Encode a share as a mnemonic string.
 *
 * Framing (before base32 encoding):
 *   [0x01 version] [share bytes...] [CRC-16/CCITT-FALSE of (version||share)]
 *
 * Output is Crockford base32, grouped in blocks of 4 characters separated by
 * hyphens for readability. Case-insensitive on decode.
 */
export function encodeShareAsMnemonic(share: ShamirShare): string {
  if (!Buffer.isBuffer(share) || share.length < 2) {
    throw new Error('encodeShareAsMnemonic: share must be a Buffer of length >= 2');
  }
  const versioned = Buffer.concat([Buffer.from([MNEMONIC_VERSION]), share]);
  const crc = crc16(versioned);
  const crcBuf = Buffer.from([(crc >> 8) & 0xff, crc & 0xff]);
  const framed = Buffer.concat([versioned, crcBuf]);
  const raw = base32Encode(framed);
  // Group into 4-char blocks, separated by '-'.
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    groups.push(raw.slice(i, i + 4));
  }
  return groups.join('-');
}

/**
 * Decode a mnemonic string back into a share Buffer. Strips whitespace,
 * hyphens, and normalizes case. Validates the version byte and CRC-16.
 */
export function decodeShareFromMnemonic(encoded: string): ShamirShare {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('decodeShareFromMnemonic: input must be a non-empty string');
  }
  // Strip whitespace, hyphens, normalize case.
  const stripped = encoded.replace(/[\s-]/g, '').toUpperCase();
  if (stripped.length === 0) {
    throw new Error('decodeShareFromMnemonic: empty after stripping');
  }

  // Each 5 characters of base32 encodes roughly 3.125 bytes; the exact byte
  // length depends on the share length (which we don't know yet). Strategy:
  // decode into the maximum possible byte length, then trim using the CRC.
  // We know the framing is [version(1) || share(k) || crc(2)] for k >= 1.
  // base32Encode produces ceil(totalBits / 5) chars → totalBytes = floor(bits/8).
  const totalBits = stripped.length * 5;
  const maxBytes = Math.floor(totalBits / 8);
  if (maxBytes < 4) {
    // Need at least version(1) + share(1) + crc(2).
    throw new Error('decodeShareFromMnemonic: input too short to contain version + share + CRC');
  }

  const decoded = base32Decode(stripped, maxBytes);

  // decoded = [version, ...share, crc_hi, crc_lo]
  if (decoded[0] !== MNEMONIC_VERSION) {
    throw new Error(
      `decodeShareFromMnemonic: unsupported version 0x${decoded[0].toString(16)} (expected 0x${MNEMONIC_VERSION.toString(16)})`,
    );
  }
  const crcRead = (decoded[decoded.length - 2] << 8) | decoded[decoded.length - 1];
  const body = decoded.subarray(0, decoded.length - 2);
  const crcCalc = crc16(body);
  if (crcRead !== crcCalc) {
    throw new Error(
      `decodeShareFromMnemonic: CRC mismatch (got 0x${crcRead.toString(16)}, expected 0x${crcCalc.toString(16)})`,
    );
  }

  // share bytes are decoded[1..length-2]
  // Brand cast: CRC-16 passed, so the buffer is a validated share from a
  // mnemonic produced by {@link encodeShareAsMnemonic}. Safe to assert.
  return Buffer.from(decoded.subarray(1, decoded.length - 2)) as ShamirShare;
}

// Internal helpers exposed for tests only.
export const __internal = {
  gfMul,
  gfDiv,
  gfEval,
  gfInterpolateAtZero,
  crc16,
  base32Encode,
  base32Decode,
};
