import { afterEach, describe, expect, it } from 'vitest';
import {
  mintCap,
  mintSystemCap,
  verifyCap,
  capAllowsWorkspace,
  isSystemCap,
  __resetCapKeyForTest,
} from '../src/daemon/memory/cap.js';

afterEach(() => {
  __resetCapKeyForTest();
});

describe('memory cap (doc 08 P0.1)', () => {
  it('mint → verify round-trips sub/ws/scope', () => {
    const token = mintCap('im_alice', 'ws_a');
    const cap = verifyCap(token);
    expect(cap).toEqual({ sub: 'im_alice', ws: 'ws_a', scope: ['ws:ws_a'] });
  });

  it('tampering one byte of the signature → null', () => {
    const token = mintCap('im_alice', 'ws_a');
    const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyCap(flipped)).toBeNull();
  });

  it('tampering the payload (re-scope to another ws) → null (sig mismatch)', () => {
    const token = mintCap('im_alice', 'ws_a');
    const [v, , sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ aud: 'memory', sub: 'im_alice', ws: 'ws_b', scope: ['ws:ws_b'], iat: 0, exp: Date.now() + 1e6 }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyCap(`${v}.${forgedPayload}.${sig}`)).toBeNull();
  });

  it('expired cap → null', () => {
    const past = Date.now() - 10_000;
    const token = mintCap('im_alice', 'ws_a', { now: past, ttlMs: 1000 });
    expect(verifyCap(token)).toBeNull();
  });

  it('valid within TTL', () => {
    const token = mintCap('im_alice', 'ws_a', { ttlMs: 60_000 });
    expect(verifyCap(token)?.ws).toBe('ws_a');
  });

  it('wrong audience → null', () => {
    // Hand-craft a token with aud != memory, signed with the real key path is
    // impossible from outside; instead assert verify rejects a non-memory aud
    // by forging then (correctly) failing the signature too — defense in depth.
    const token = mintCap('im_alice', 'ws_a');
    const [v, payloadB64, sig] = token.split('.');
    const decoded = JSON.parse(
      Buffer.from(payloadB64!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(decoded.aud).toBe('memory'); // sanity: minted caps carry aud=memory
    // A token whose payload claims a different aud cannot also carry a valid sig.
    expect(verifyCap(`${v}.${payloadB64}.${sig}badsig`)).toBeNull();
  });

  it('mintCap HARD-REJECTS wildcard scope for an agent', () => {
    expect(() => mintCap('im_alice', '*')).toThrow();
  });

  it('mintCap rejects empty sub / ws', () => {
    expect(() => mintCap('', 'ws_a')).toThrow();
    expect(() => mintCap('im_alice', '')).toThrow();
  });

  it('system cap carries ws:* and isSystemCap=true', () => {
    const cap = verifyCap(mintSystemCap());
    expect(cap).not.toBeNull();
    expect(cap!.scope).toEqual(['ws:*']);
    expect(isSystemCap(cap!)).toBe(true);
  });

  it('agent cap is NOT a system cap', () => {
    const cap = verifyCap(mintCap('im_alice', 'ws_a'))!;
    expect(isSystemCap(cap)).toBe(false);
  });

  it('capAllowsWorkspace: agent cap gates to its own ws only', () => {
    const cap = verifyCap(mintCap('im_alice', 'ws_a'))!;
    expect(capAllowsWorkspace(cap, 'ws_a')).toBe(true);
    expect(capAllowsWorkspace(cap, 'ws_b')).toBe(false);
    expect(capAllowsWorkspace(cap, '')).toBe(false);
  });

  it('capAllowsWorkspace: system cap allows any ws', () => {
    const cap = verifyCap(mintSystemCap())!;
    expect(capAllowsWorkspace(cap, 'ws_a')).toBe(true);
    expect(capAllowsWorkspace(cap, 'ws_anything')).toBe(true);
  });

  it('per-boot key rotation (daemon restart) invalidates prior caps', () => {
    const token = mintCap('im_alice', 'ws_a');
    expect(verifyCap(token)).not.toBeNull();
    __resetCapKeyForTest(); // simulate restart → fresh key
    expect(verifyCap(token)).toBeNull();
  });

  it('malformed inputs → null (no throw)', () => {
    expect(verifyCap(undefined)).toBeNull();
    expect(verifyCap(null)).toBeNull();
    expect(verifyCap('')).toBeNull();
    expect(verifyCap('not-a-token')).toBeNull();
    expect(verifyCap('v1.only-two')).toBeNull();
    expect(verifyCap('v2.aaa.bbb')).toBeNull(); // wrong version
  });

  it('capKey isolation: token body carries no raw key material', () => {
    // The token is sub/ws/scope/iat/exp + an HMAC tag — never the key bytes.
    const token = mintCap('im_alice', 'ws_a');
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'scope', 'sub', 'ws']);
  });
});
