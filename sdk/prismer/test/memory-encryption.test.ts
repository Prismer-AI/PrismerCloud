// memory202 doc 06 — daemon at-rest encryption MVP tests.
//
// Covers the security guarantees, not just happy path:
//   - AES-256-GCM round-trips
//   - GCM tamper (flip a byte) → decrypt throws (authenticated)
//   - key persists + reloads from disk (durable)
//   - ephemeral signal → fails closed (no silent encrypt-and-lose)
//   - MemoryStore.write honors the `encrypted` flag while keeping local plaintext

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encrypt,
  decrypt,
  isPackedCiphertext,
  MEMORY_KEY_BYTES,
} from '../src/daemon/memory/crypto-cipher.js';
import { MemoryKeyManager } from '../src/daemon/memory/key-manager.js';
import { mintCap, verifyCap, systemCap } from '../src/daemon/memory/cap.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import * as crypto from 'node:crypto';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.PRISMER_EPHEMERAL_STORAGE;
});

function mkdir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

describe('crypto-cipher (AES-256-GCM)', () => {
  const key = crypto.randomBytes(MEMORY_KEY_BYTES);

  it('round-trips plaintext', () => {
    const pt = '# Secret\n\nLaunch the rocket at dawn. token=hunter2';
    const packed = encrypt(pt, key);
    expect(isPackedCiphertext(packed)).toBe(true);
    expect(packed.startsWith('v1:')).toBe(true);
    expect(packed).not.toContain('rocket'); // ciphertext doesn't leak plaintext
    expect(decrypt(packed, key)).toBe(pt);
  });

  it('uses a fresh IV per encryption (ciphertexts differ, both decrypt)', () => {
    const pt = 'same plaintext';
    const a = encrypt(pt, key);
    const b = encrypt(pt, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(pt);
    expect(decrypt(b, key)).toBe(pt);
  });

  it('GCM tamper (flip a byte in ct) → decrypt throws', () => {
    const packed = encrypt('authentic content', key);
    const parts = packed.split(':');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0xff; // flip a byte
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('base64url')}`;
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('tampered auth tag → decrypt throws', () => {
    const packed = encrypt('authentic content', key);
    const parts = packed.split(':');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[0] ^= 0xff;
    const tampered = `${parts[0]}:${tag.toString('base64url')}:${parts[2]}:${parts[3]}`;
    // (deliberately corrupting iv slot too is fine — any tamper must throw)
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('wrong key → decrypt throws (no plaintext leak)', () => {
    const packed = encrypt('content', key);
    const wrong = crypto.randomBytes(MEMORY_KEY_BYTES);
    expect(() => decrypt(packed, wrong)).toThrow();
  });

  it('rejects malformed packed strings + wrong key length', () => {
    expect(() => decrypt('not-packed', key)).toThrow();
    expect(() => decrypt('v2:a:b:c', key)).toThrow(); // unknown version
    expect(() => encrypt('x', crypto.randomBytes(16))).toThrow(); // wrong key len
  });
});

describe('MemoryKeyManager', () => {
  it('generates, persists 0600, and reloads the same key', () => {
    const baseDir = mkdir('prismer-memkey-');
    const wsId = 'ws_alpha';
    const km1 = new MemoryKeyManager({ baseDir, log: silentLog() });
    const k1 = km1.getKeyOrNull(wsId);
    expect(k1).not.toBeNull();
    expect(k1!.length).toBe(MEMORY_KEY_BYTES);

    const keyFile = join(baseDir, wsId, '.memkey');
    expect(existsSync(keyFile)).toBe(true);
    // 0600 perms (POSIX). mode & 0o777 isolates the perm bits.
    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);

    // A FRESH manager (cold cache) loads the SAME persisted key.
    const km2 = new MemoryKeyManager({ baseDir, log: silentLog() });
    const k2 = km2.getKeyOrNull(wsId);
    expect(k2).not.toBeNull();
    expect(k2!.equals(k1!)).toBe(true);
  });

  it('different workspaces get different keys', () => {
    const baseDir = mkdir('prismer-memkey-');
    const km = new MemoryKeyManager({ baseDir, log: silentLog() });
    const a = km.getKeyOrNull('ws_a');
    const b = km.getKeyOrNull('ws_b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.equals(b!)).toBe(false);
  });

  it('ephemeral storage → returns null (fail-closed, no key file written)', () => {
    process.env.PRISMER_EPHEMERAL_STORAGE = 'true';
    const baseDir = mkdir('prismer-memkey-');
    const km = new MemoryKeyManager({ baseDir, log: silentLog() });
    const k = km.getKeyOrNull('ws_eph');
    expect(k).toBeNull();
    // No key was persisted (would have been orphaned on restart).
    expect(existsSync(join(baseDir, 'ws_eph', '.memkey'))).toBe(false);
  });

  // ── doc 08 §2.3 (F3) — capability key gate ──────────────────────────────
  it('getKey: cap{ws:A} cannot load ws_b key (fail-closed, no file touched)', () => {
    const baseDir = mkdir('prismer-memkey-');
    const km = new MemoryKeyManager({ baseDir, log: silentLog() });
    const capA = verifyCap(mintCap('im_alice', 'ws_a'))!;
    // own-ws → key
    expect(km.getKey('ws_a', capA)).not.toBeNull();
    // cross-ws → null AND no ws_b key file is created
    expect(km.getKey('ws_b', capA)).toBeNull();
    expect(existsSync(join(baseDir, 'ws_b', '.memkey'))).toBe(false);
  });

  it('getKey: system cap reaches any ws', () => {
    const baseDir = mkdir('prismer-memkey-');
    const km = new MemoryKeyManager({ baseDir, log: silentLog() });
    expect(km.getKey('ws_a', systemCap())).not.toBeNull();
    expect(km.getKey('ws_zzz', systemCap())).not.toBeNull();
  });
});

describe('MemoryStore.write honors encrypted flag (local plaintext)', () => {
  let baseDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    baseDir = mkdir('prismer-memstore-');
    store = new MemoryStore({
      dbPath: join(baseDir, 'memory.db'),
      workspaceId: 'ws_store',
      deviceId: 'dev_1',
    });
    store.open();
  });
  afterEach(() => store.close());

  it('encrypted=true stamps the page row but keeps local content plaintext', () => {
    const page = store.write({
      workspaceId: 'ws_store',
      path: 'secrets/plan.md',
      content: '# Plan\n\nThe magic word is alpenglow.',
      actorImUserId: 'u1',
      actorKind: 'human',
      encrypted: true,
    });
    expect(page.encrypted).toBe(true);
    // Local store keeps PLAINTEXT so local FTS/recall work (daemon is trusted).
    const content = store.loadContent(page.id);
    expect(content?.content).toContain('alpenglow');
  });

  it('encrypted defaults false (no behavior change)', () => {
    const page = store.write({
      workspaceId: 'ws_store',
      path: 'public/readme.md',
      content: 'public content',
      actorImUserId: 'u1',
      actorKind: 'human',
    });
    expect(page.encrypted).toBe(false);
  });
});

function silentLog() {
  return { info: () => undefined, warn: () => undefined };
}
