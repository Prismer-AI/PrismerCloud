// memory202 doc 06 (M-ENC) — at-rest encryption ACTIVATION round-trip.
//
// The crypto primitives + key-manager + store-honors-flag are covered by
// memory-encryption.test.ts. THIS file proves the END-TO-END activation behind
// FF_MEMORY_ENCRYPTION_ENABLED (default OFF):
//
//   write (policy ON → page marked encrypted=true, LOCAL content stays plaintext)
//     → outbox flush ENCRYPTS the cloud-bound payload (envelope `v1:iv:tag:ct`)
//     → POST body carries ciphertext + encrypted:true (NOT the plaintext)
//     → simulate the cloud down-sync DECRYPT (same code path as cloud-sync.ts)
//     → plaintext round-trips back, byte-for-byte.
//
// Plus the two safety negative controls (flag OFF, ephemeral/no-key) and a
// catch-the-bug check (force encrypted=false with flag on → ciphertext assertion
// must go RED).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryOutboxWorker } from '../src/daemon/memory/outbox-worker.js';
import { MemoryKeyManager, isEncryptionEnabled, isEphemeralStorage } from '../src/daemon/memory/key-manager.js';
import { decrypt, isPackedCiphertext } from '../src/daemon/memory/crypto-cipher.js';
import { systemCap } from '../src/daemon/memory/cap.js';

const WS = 'ws_enc';
const SECRET = '# Mission\n\nThe codeword is alpenglow; ship at 0400.';

let dir = '';
let runtime: MemoryRuntime;
let keyManager: MemoryKeyManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-enc-rt-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_enc' });
  keyManager = new MemoryKeyManager({ baseDir: dir, log: silentLog() });
  // Bind the SAME activation policy the runner wiring installs in production
  // (runner-wiring.ts): flag ON + not ephemeral + a durable key resolves.
  runtime.setEncryptionPolicy(
    (workspaceId) =>
      isEncryptionEnabled() &&
      !isEphemeralStorage() &&
      keyManager.getKey(workspaceId, systemCap()) !== null,
  );
});

afterEach(() => {
  runtime.closeAll();
  delete process.env.FF_MEMORY_ENCRYPTION_ENABLED;
  delete process.env.PRISMER_EPHEMERAL_STORAGE;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function silentLog() {
  return { info: () => undefined, warn: () => undefined };
}

function mockCloud(fetchImpl: typeof fetch): CloudClient {
  return new CloudClient({ apiKey: 'sk-test', baseUrl: 'http://cloud.test', fetchImpl });
}

function pageUpsertEnvelope(pageId: string, content: string): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    eventType: 'memory.page.upsert',
    workspaceId: WS,
    actorImUserId: 'im_alice',
    actorKind: 'human',
    deviceId: 'dev_enc',
    createdAt: new Date().toISOString(),
    idempotencyKey: `key_${randomUUID()}`,
    pageId,
    path: 'secrets/plan.md',
    parentVersion: 0,
    contentHash: 'sha',
    payload: { kind: 'inline', content },
  };
}

/**
 * Write a page locally + enqueue its upsert, then flushNow through a fetch mock
 * that captures the POST body. Returns the single outbound event + the page row.
 */
async function writeAndFlush(content: string): Promise<{
  outboundEvent: { encrypted?: boolean; payload?: { content?: string } };
  localPlaintext: string;
  pageEncryptedFlag: boolean;
  posted: boolean;
}> {
  const slot = runtime.resolve(WS);
  // Locally-authored write (no explicit `encrypted`) → policy decides.
  const page = slot.store.write({
    workspaceId: WS,
    path: 'secrets/plan.md',
    content,
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  slot.outbox.enqueue(pageUpsertEnvelope(page.id, content));

  let capturedBody: { events: Array<Record<string, unknown>> } | null = null;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string) as typeof capturedBody extends null
      ? never
      : { events: Array<Record<string, unknown>> };
    const ids = (capturedBody!.events as Array<{ eventId?: string }>).map((e) => e.eventId!);
    return new Response(JSON.stringify({ ok: true, data: { acked: ids, errors: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const worker = new MemoryOutboxWorker({
    runtime,
    cloud: mockCloud(fetchMock as unknown as typeof fetch),
    keyManager,
    log: silentLog(),
  });
  await worker.flushNow();

  const localPlaintext = slot.store.loadContent(page.id)?.content ?? '';
  const reloaded = slot.store.loadById(page.id);
  const posted = capturedBody !== null;
  const outboundEvent = posted
    ? ((capturedBody as { events: Array<Record<string, unknown>> }).events[0] as {
        encrypted?: boolean;
        payload?: { content?: string };
      })
    : { payload: {} };

  return {
    outboundEvent,
    localPlaintext,
    pageEncryptedFlag: reloaded?.encrypted ?? false,
    posted,
  };
}

describe('M-ENC activation round-trip (flag ON)', () => {
  beforeEach(() => {
    process.env.FF_MEMORY_ENCRYPTION_ENABLED = 'true';
  });

  it('write → page marked encrypted=true, LOCAL content stays plaintext', async () => {
    const r = await writeAndFlush(SECRET);
    expect(r.pageEncryptedFlag).toBe(true);
    // Local SQLite keeps plaintext so daemon FTS/recall work.
    expect(r.localPlaintext).toBe(SECRET);
    expect(r.localPlaintext).toContain('alpenglow');
  });

  it('outbound cloud payload is CIPHERTEXT (v1:...) + encrypted:true, never plaintext', async () => {
    const r = await writeAndFlush(SECRET);
    expect(r.posted).toBe(true);
    const out = r.outboundEvent.payload?.content ?? '';
    expect(isPackedCiphertext(out)).toBe(true);
    expect(out.startsWith('v1:')).toBe(true);
    expect(out).not.toContain('alpenglow'); // ciphertext doesn't leak plaintext
    expect(r.outboundEvent.encrypted).toBe(true);
  });

  it('cloud down-sync DECRYPT round-trips the ciphertext back to the original plaintext', async () => {
    const r = await writeAndFlush(SECRET);
    const ciphertext = r.outboundEvent.payload?.content ?? '';
    expect(isPackedCiphertext(ciphertext)).toBe(true);

    // Simulate the cloud→local down-sync decrypt (cloud-sync.ts materialisePage:
    // `gcmDecrypt(content, keyManager.getKey(ws, systemCap()))`). Same key the
    // outbox flush used → recovers the original plaintext byte-for-byte.
    const key = keyManager.getKey(WS, systemCap());
    expect(key).not.toBeNull();
    const recovered = decrypt(ciphertext, key!);
    expect(recovered).toBe(SECRET);
  });

  it('catch-the-bug: forcing encrypted=false even with flag ON ⇒ outbound is plaintext (the ciphertext assert would go RED)', async () => {
    // Prove the test has teeth: an explicit encrypted=false bypasses the policy
    // (down-sync semantics), so the page stays plaintext end-to-end. If the
    // activation regressed to "never mark encrypted", the round-trip suite above
    // would see THIS plaintext outbound and its `isPackedCiphertext` assert fail.
    const slot = runtime.resolve(WS);
    const page = slot.store.write({
      workspaceId: WS,
      path: 'secrets/plan.md',
      content: SECRET,
      actorImUserId: 'im_alice',
      actorKind: 'human',
      encrypted: false, // force OFF despite flag ON
    });
    expect(page.encrypted).toBe(false);
    slot.outbox.enqueue(pageUpsertEnvelope(page.id, SECRET));

    let body: { events: Array<{ payload?: { content?: string } }> } | null = null;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      const ids = (body!.events as Array<{ eventId?: string }>).map((e) => e.eventId!);
      return new Response(JSON.stringify({ ok: true, data: { acked: ids, errors: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      keyManager,
      log: silentLog(),
    }).flushNow();

    const out = body!.events[0]?.payload?.content ?? '';
    expect(isPackedCiphertext(out)).toBe(false); // plaintext, NOT ciphertext
    expect(out).toContain('alpenglow');
  });
});

describe('M-ENC negative control 1 — flag OFF (default): unchanged plaintext behavior', () => {
  it('page written encrypted=false, outbound cloud payload is PLAINTEXT', async () => {
    // FF_MEMORY_ENCRYPTION_ENABLED unset → default OFF.
    const r = await writeAndFlush(SECRET);
    expect(r.pageEncryptedFlag).toBe(false);
    const out = r.outboundEvent.payload?.content ?? '';
    expect(isPackedCiphertext(out)).toBe(false);
    expect(out).toContain('alpenglow'); // plaintext travels as today
    expect(r.outboundEvent.encrypted).not.toBe(true);
    expect(r.localPlaintext).toBe(SECRET);
  });
});

describe('M-ENC negative control 2 — ephemeral / no durable key: fail-closed to plaintext', () => {
  it('flag ON but ephemeral storage → encrypted=false plaintext (no crash, no ciphertext-without-key)', async () => {
    process.env.FF_MEMORY_ENCRYPTION_ENABLED = 'true';
    process.env.PRISMER_EPHEMERAL_STORAGE = 'true';
    const r = await writeAndFlush(SECRET);
    // Policy short-circuits on ephemeral → no encrypt intent, no orphaned ciphertext.
    expect(r.pageEncryptedFlag).toBe(false);
    const out = r.outboundEvent.payload?.content ?? '';
    expect(isPackedCiphertext(out)).toBe(false);
    expect(out).toContain('alpenglow');
    expect(r.localPlaintext).toBe(SECRET);
  });
});
