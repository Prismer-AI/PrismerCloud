// M-RECALL-EMIT unit tests (测试闸 ③).
//
// emitRecallPull() (search.ts handlers call it) enqueues a `recall_pull`
// observability event whenever an agent self-recalls via memory_search /
// memory_load. Covers:
//   ⑦ handleSearch WITH a verified cap subject → exactly one recall_pull lands
//      in the outbox with the correct envelope shape (eventType /
//      actorImUserId / deviceId / idempotencyKey / metrics). spec16 §8.1: the
//      actor is ALWAYS cap.sub — the query actor fields are ignored (the test
//      sends a forged query actor to prove it cannot hijack attribution).
//   ⑧ handleLoad WITH a cap subject → recall_pull (directed self-recall).
//   ⑨ system-cap traffic → no emission (never fabricate an actor).
//   ⑩ emission failure (outbox.enqueue throws) → recall result STILL returns
//      normally (best-effort side-channel, never on the critical path).
//
// Drives the real attachMemoryRpc handler over the LocalServer HTTP harness,
// then inspects the per-workspace memory_outbox table directly. No mocks of the
// production search/store/rpc code — only outbox.enqueue is wrapped for ⑩.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, mintSystemCap } from '../src/daemon/memory/cap.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

const WS = 'ws_recall';
const DEVICE = 'dev_x';
// spec16 §8.1 — fail-closed RPC: helpers carry the suite's agent cap
// (sub=im_alice); ⑨ overrides with the system cap (no fabricated actor).
let cap = '';

beforeEach(async () => {
  // Recall observability uses legacy flat seed pages; placement has its own suite.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-recall-emit-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_alice', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: DEVICE });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, deviceId: DEVICE }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function get(path: string, capOverride?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-prismer-memory-cap': capOverride ?? cap },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown, capOverride?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': capOverride ?? cap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  path: 'auth.md',
  content: 'We chose OAuth over SAML for the auth flow.',
  pageType: 'leaf',
  actorImUserId: 'im_alice',
  actorKind: 'human',
  ...overrides,
});

/** Read every outbox row for a workspace, decoding the stored envelope JSON. */
function outboxRows(workspaceId: string): Array<{ eventType: string; envelope: Record<string, unknown> }> {
  const slot = runtime!.peek(workspaceId);
  if (!slot) return [];
  const db = slot.store.rawDb();
  const rows = db
    .prepare('SELECT eventType, envelopeJson FROM memory_outbox ORDER BY createdAt')
    .all() as Array<{ eventType: string; envelopeJson: string }>;
  return rows.map((r) => ({ eventType: r.eventType, envelope: JSON.parse(r.envelopeJson) }));
}

describe('M-RECALL-EMIT — recall_pull emission on tool-driven recall', () => {
  // ⑦ search WITH a verified cap subject → one recall_pull with the correct
  // shape; the forged query actor must NOT hijack attribution (spec16 §8.1).
  it('⑦ handleSearch emits one well-formed recall_pull attributed to cap.sub (query actor ignored)', async () => {
    await post('/local/memory/write', writeBody());

    const r = await get(
      `/local/memory/search?workspaceId=${WS}&q=OAuth&topK=3&actorImUserId=im_evil&actorKind=human`,
    );
    expect(r.status).toBe(200);
    const results = (r.body as { results: Array<{ pageId: string }> }).results;
    expect(results.length).toBeGreaterThan(0);

    const pulls = outboxRows(WS).filter((e) => e.eventType === 'recall_pull');
    expect(pulls.length).toBe(1);
    const env = pulls[0]!.envelope;
    expect(env.eventType).toBe('recall_pull');
    expect(env.actorImUserId).toBe('im_alice'); // cap.sub, NOT the query's im_evil
    expect(env.actorKind).toBe('agent');
    expect(env.deviceId).toBe(DEVICE);
    expect(env.workspaceId).toBe(WS);
    expect(typeof env.idempotencyKey).toBe('string');
    expect(env.idempotencyKey as string).toMatch(/^obs:recall_pull:im_alice:/);
    expect(env.query).toBe('OAuth');
    expect((env.metadataJson as { tool: string }).tool).toBe('memory_search');
    const metrics = env.metricsJson as { hitCount: number; topK: number };
    expect(metrics.hitCount).toBe(results.length);
    expect(metrics.topK).toBe(3);
    // First hit's pageId is stamped for cloud-side correlation.
    expect(env.pageId).toBe(results[0]!.pageId);
  });

  // ⑧ load WITH a cap subject → recall_pull (directed self-recall).
  it('⑧ handleLoad emits a recall_pull attributed to cap.sub (tool=memory_load)', async () => {
    await post('/local/memory/write', writeBody());

    const r = await get(
      `/local/memory/load?workspaceId=${WS}&path=auth.md&actorImUserId=im_evil&actorKind=human`,
    );
    expect(r.status).toBe(200);

    const pulls = outboxRows(WS).filter((e) => e.eventType === 'recall_pull');
    expect(pulls.length).toBe(1);
    const env = pulls[0]!.envelope;
    expect((env.metadataJson as { tool: string }).tool).toBe('memory_load');
    expect(env.query).toBe('auth.md');
    expect((env.metricsJson as { hitCount: number }).hitCount).toBe(1);
    expect(env.actorImUserId).toBe('im_alice');
    expect(env.actorKind).toBe('agent');
  });

  // ⑨ system-cap traffic → no emission (never fabricate an actor).
  it('⑨ system-cap search/load emits nothing', async () => {
    await post('/local/memory/write', writeBody());

    const sys = mintSystemCap();
    // Search under the system cap.
    const s = await get(`/local/memory/search?workspaceId=${WS}&q=OAuth`, sys);
    expect(s.status).toBe(200);
    expect((s.body as { results: unknown[] }).results.length).toBeGreaterThan(0);

    // Load under the system cap.
    const l = await get(`/local/memory/load?workspaceId=${WS}&path=auth.md`, sys);
    expect(l.status).toBe(200);

    const pulls = outboxRows(WS).filter((e) => e.eventType === 'recall_pull');
    expect(pulls.length).toBe(0);
  });

  // ⑩ emission failure → recall result still returns normally (best-effort).
  it('⑩ emission failure does not break the recall response', async () => {
    await post('/local/memory/write', writeBody());

    // Force outbox.enqueue to throw for this workspace slot. emitRecallPull
    // wraps enqueue in try/catch, so the search/load must still succeed.
    const slot = runtime!.resolve(WS);
    const original = slot.outbox.enqueue.bind(slot.outbox);
    slot.outbox.enqueue = () => {
      throw new Error('simulated outbox failure');
    };
    try {
      const s = await get(`/local/memory/search?workspaceId=${WS}&q=OAuth`);
      expect(s.status).toBe(200);
      expect((s.body as { results: unknown[] }).results.length).toBeGreaterThan(0);

      const l = await get(`/local/memory/load?workspaceId=${WS}&path=auth.md`);
      expect(l.status).toBe(200);
      expect((l.body as { page: { path: string } }).page.path).toBe('auth.md');
    } finally {
      slot.outbox.enqueue = original;
    }

    // Nothing landed (enqueue threw every time), but no error surfaced.
    const pulls = outboxRows(WS).filter((e) => e.eventType === 'recall_pull');
    expect(pulls.length).toBe(0);
  });
});
