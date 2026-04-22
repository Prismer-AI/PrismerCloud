import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
  splitSecret,
  combineShares,
  encodeShareAsMnemonic,
  decodeShareFromMnemonic,
  unsafeAsShamirShare,
  __internal,
} from '../src/shamir.js';
import type { ShamirShare } from '../src/shamir.js';

// ============================================================
// GF(256) arithmetic sanity
// ============================================================

describe('shamir — GF(256) arithmetic', () => {
  it('multiplies 0x53 * 0xCA === 0x01 (standard AES test vector)', () => {
    // Classical AES test: 0x53 * 0xCA mod 0x11B = 0x01
    expect(__internal.gfMul(0x53, 0xca)).toBe(0x01);
  });

  it('gfDiv(gfMul(a, b), b) === a for random bytes', () => {
    for (let i = 0; i < 50; i++) {
      const a = Math.floor(Math.random() * 255) + 1;
      const b = Math.floor(Math.random() * 255) + 1;
      expect(__internal.gfDiv(__internal.gfMul(a, b), b)).toBe(a);
    }
  });

  it('gfEval reproduces Lagrange-interpolated point', () => {
    const coeffs = [0x42, 0x17, 0xab, 0xef]; // P(x) = 0x42 + 0x17*x + 0xab*x^2 + 0xef*x^3
    const xs = [1, 2, 3, 4];
    const ys = xs.map((x) => __internal.gfEval(coeffs, x));
    // Interpolating 4 points of a cubic back to x=0 should give coeffs[0].
    expect(__internal.gfInterpolateAtZero(xs, ys)).toBe(coeffs[0]);
  });
});

// ============================================================
// Split / Combine
// ============================================================

describe('shamir — splitSecret / combineShares', () => {
  it('splits into N shares and recombines with exactly threshold shares', () => {
    const secret = Buffer.from('master-secret-1234-abcdefABCDEF!!');
    const shares = splitSecret(secret, 5, 3);
    expect(shares).toHaveLength(5);

    // Any 3 of 5 should recover.
    const recovered = combineShares([shares[0], shares[2], shares[4]]);
    expect(recovered.equals(secret)).toBe(true);
  });

  it('all N shares recover the secret', () => {
    const secret = crypto.randomBytes(64);
    const shares = splitSecret(secret, 5, 3);
    const recovered = combineShares(shares);
    expect(recovered.equals(secret)).toBe(true);
  });

  it('< threshold shares do NOT recover the secret', () => {
    const secret = Buffer.from('hello-shamir-world-0123456789');
    const shares = splitSecret(secret, 5, 3);

    // Combine only 2 (below threshold). The result is mathematically defined
    // but will not equal the real secret (unless astronomically unlikely).
    const fake = combineShares([shares[0], shares[1]]);
    expect(fake.equals(secret)).toBe(false);
  });

  it('rejects invalid parameters', () => {
    const secret = Buffer.from('abc');
    expect(() => splitSecret(secret, 5, 1)).toThrow(/threshold/);
    expect(() => splitSecret(secret, 3, 5)).toThrow(/n must be >= threshold/i);
    expect(() => splitSecret(secret, 256, 2)).toThrow(/<= 255/);
    expect(() => splitSecret(Buffer.alloc(0), 3, 2)).toThrow(/empty/);
  });

  it('handles n=255, m=255 edge case without overflow', () => {
    // Small secret keeps the test fast but exercises the max-x boundary.
    const secret = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const shares = splitSecret(secret, 255, 255);
    expect(shares).toHaveLength(255);
    expect(shares[0][0]).toBe(1);
    expect(shares[254][0]).toBe(255);

    // All 255 shares recover.
    const recovered = combineShares(shares);
    expect(recovered.equals(secret)).toBe(true);

    // Any 255 in a different order also recover (just reverse for the test).
    const recovered2 = combineShares([...shares].reverse());
    expect(recovered2.equals(secret)).toBe(true);
  });

  it('rejects duplicate share-ids and inconsistent lengths', () => {
    const secret = Buffer.from('abc123');
    const shares = splitSecret(secret, 3, 2);
    expect(() => combineShares([shares[0], shares[0]])).toThrow(/duplicate/);

    const truncated = shares[1].subarray(0, shares[1].length - 1);
    expect(() => combineShares([shares[0], truncated])).toThrow(/inconsistent/);
  });

  it('combineShares requires at least 2 shares', () => {
    const secret = Buffer.from('abc');
    const shares = splitSecret(secret, 3, 2);
    expect(() => combineShares([shares[0]])).toThrow(/at least 2/);
  });

  it('produces different shares on each split call (randomness)', () => {
    const secret = Buffer.from('repeated-secret');
    const shares1 = splitSecret(secret, 5, 3);
    const shares2 = splitSecret(secret, 5, 3);

    // Share 1 y-bytes should differ almost always (astronomically so).
    expect(shares1[0].subarray(1).equals(shares2[0].subarray(1))).toBe(false);

    // But both sets reconstruct the same secret.
    expect(combineShares(shares1.slice(0, 3)).equals(secret)).toBe(true);
    expect(combineShares(shares2.slice(0, 3)).equals(secret)).toBe(true);
  });

  it('share-id byte is prepended correctly (shuffle-proof)', () => {
    const secret = Buffer.from('xyz');
    const shares = splitSecret(secret, 4, 2);
    for (let i = 0; i < 4; i++) {
      expect(shares[i][0]).toBe(i + 1);
    }
    // Shuffle shares and still recover.
    const shuffled = [shares[3], shares[1]];
    expect(combineShares(shuffled).equals(secret)).toBe(true);
  });
});

// ============================================================
// Mnemonic encoding
// ============================================================

describe('shamir — mnemonic encoding', () => {
  it('roundtrips a share losslessly', () => {
    const secret = Buffer.from('master-secret-abcdef');
    const shares = splitSecret(secret, 3, 2);

    for (const share of shares) {
      const mnemonic = encodeShareAsMnemonic(share);
      const decoded = decodeShareFromMnemonic(mnemonic);
      expect(decoded.equals(share)).toBe(true);
    }
  });

  it('formats mnemonics as hyphen-grouped blocks of 4 chars', () => {
    const share = Buffer.from([0x01, 0xde, 0xad, 0xbe, 0xef, 0x42, 0x17]);
    const mnemonic = encodeShareAsMnemonic(share);
    // Every hyphen-delimited segment is at most 4 chars.
    const parts = mnemonic.split('-');
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(4);
    }
    // Only uppercase base32 + hyphens.
    expect(/^[0-9A-Z-]+$/.test(mnemonic)).toBe(true);
  });

  it('decode is case-insensitive and tolerates whitespace + hyphens', () => {
    const share = Buffer.from([0x03, 0x11, 0x22, 0x33, 0x44]);
    const mnemonic = encodeShareAsMnemonic(share);

    // Lowercase + extra whitespace should still work.
    const mangled = mnemonic.toLowerCase().replace(/-/g, ' - ') + '   ';
    expect(decodeShareFromMnemonic(mangled).equals(share)).toBe(true);
  });

  it('single-character flip triggers CRC failure', () => {
    const share = Buffer.from([0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const mnemonic = encodeShareAsMnemonic(share);
    const stripped = mnemonic.replace(/-/g, '');

    // Flip one character to a different valid base32 char.
    const orig = stripped[5];
    const alt = orig === '0' ? '1' : '0';
    const tampered = stripped.slice(0, 5) + alt + stripped.slice(6);

    expect(() => decodeShareFromMnemonic(tampered)).toThrow(/CRC/);
  });

  it('rejects unknown base32 characters', () => {
    expect(() => decodeShareFromMnemonic('ABCD-EF#G-HJKM')).toThrow(/invalid/);
  });

  it('rejects version mismatch', () => {
    // Forge a framing with wrong version byte: [0x02, ...share, CRC].
    const badBody = Buffer.concat([
      Buffer.from([0x02]), // wrong version
      Buffer.from([0xaa, 0xbb, 0xcc]),
    ]);
    const badCrc = __internal.crc16(badBody);
    const framed = Buffer.concat([
      badBody,
      Buffer.from([(badCrc >> 8) & 0xff, badCrc & 0xff]),
    ]);
    const mnemonic = __internal.base32Encode(framed);
    expect(() => decodeShareFromMnemonic(mnemonic)).toThrow(/version/);
  });

  it('rejects empty and too-short mnemonics', () => {
    expect(() => decodeShareFromMnemonic('')).toThrow();
    expect(() => decodeShareFromMnemonic('AB')).toThrow(/too short|CRC|invalid/);
  });
});

// ============================================================
// Branded type — nominal typing for ShamirShare
// ============================================================

describe('shamir — ShamirShare branded type', () => {
  it('splitSecret returns a ShamirShare[] (type-level)', () => {
    const shares = splitSecret(Buffer.from('brand-test'), 3, 2);
    // Type assertion: these must assign cleanly to ShamirShare[] without a cast.
    const typed: ShamirShare[] = shares;
    expect(typed).toHaveLength(3);
  });

  it('decodeShareFromMnemonic returns a ShamirShare (type-level)', () => {
    const shares = splitSecret(Buffer.from('decode-brand-test'), 3, 2);
    const mnemonic = encodeShareAsMnemonic(shares[0]);
    const decoded = decodeShareFromMnemonic(mnemonic);
    // Type assertion: must be assignable to ShamirShare without a cast.
    const typed: ShamirShare = decoded;
    expect(typed.equals(shares[0])).toBe(true);
  });

  it('rejects arbitrary Buffer passed to combineShares without a cast (ts-expect-error)', () => {
    // This test is a compile-time guard. The @ts-expect-error comment asserts
    // that the type checker rejects this call; if the brand is ever removed,
    // this will fail with "Unused '@ts-expect-error' directive".
    const notAShare = Buffer.from('not a share');
    // @ts-expect-error — arbitrary Buffer cannot be passed as ShamirShare[]
    expect(() => combineShares([notAShare, notAShare])).toThrow();
  });

  it('rejects arbitrary Buffer passed to encodeShareAsMnemonic without a cast (ts-expect-error)', () => {
    const notAShare = Buffer.from([0x42, 0x17]);
    // @ts-expect-error — arbitrary Buffer cannot be passed as ShamirShare
    expect(() => encodeShareAsMnemonic(notAShare)).not.toThrow();
    // (runtime accepts any Buffer ≥ 2 bytes; brand is compile-time only)
  });

  it('unsafeAsShamirShare escape hatch casts a raw Buffer (documented sharp edge)', () => {
    const raw = Buffer.from([0x01, 0xaa, 0xbb]);
    const share: ShamirShare = unsafeAsShamirShare(raw);
    // Compile-time: share is now ShamirShare. Runtime: unchanged.
    expect(share.length).toBe(3);
    expect(share[0]).toBe(0x01);
  });
});

// ============================================================
// End-to-end: secret → shares → mnemonic → decode → recombine
// ============================================================

describe('shamir — end-to-end recovery', () => {
  it('secret → split → encode → decode → combine is byte-exact', () => {
    const original = crypto.randomBytes(32); // typical master-key size
    const shares = splitSecret(original, 5, 3);
    const mnemonics = shares.map(encodeShareAsMnemonic);

    // Lose 2 shares; recover from the remaining 3.
    const recovered = combineShares([
      decodeShareFromMnemonic(mnemonics[1]),
      decodeShareFromMnemonic(mnemonics[2]),
      decodeShareFromMnemonic(mnemonics[4]),
    ]);
    expect(recovered.equals(original)).toBe(true);
  });

  it('works for a 1-byte secret (minimal valid case)', () => {
    const secret = Buffer.from([0x42]);
    const shares = splitSecret(secret, 3, 2);
    const recovered = combineShares(shares.slice(0, 2));
    expect(recovered.equals(secret)).toBe(true);
  });

  it('works for a large 512-byte secret', () => {
    const secret = crypto.randomBytes(512);
    const shares = splitSecret(secret, 7, 4);
    const mnemonics = shares.map(encodeShareAsMnemonic);
    const recovered = combineShares(
      mnemonics.slice(0, 4).map(decodeShareFromMnemonic),
    );
    expect(recovered.equals(secret)).toBe(true);
  });
});
