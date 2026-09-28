// memory203/13 §0.5 — the cloud-extract lane is RETIRED.
//
// This file USED to prove the HTTP extract-turn route was NON-BLOCKING: it ACKed
// 202 {queued:true} fast and ran the slow cloud /api/im/memory/extract call in
// the background. That whole architecture is gone: automatic extraction now runs
// IN-POD via the post_llm_call hook (extract.ts → the agent's own gateway
// /api/v1/messages), and the cloud does ZERO LLM for memory. The extract-turn /
// extract-compress HTTP routes are kept addressable (so an older provider shell
// never 404s) but are inert no-ops that return
// `{ok:true, retired:true, reason:'cloud_extract_retired_memory203_13_0_5'}`
// UNCONDITIONALLY and forward NOTHING to any cloud (rpc.ts:189-190).
//
// What remains verifiable here: the retired route responds instantly and never
// touches the cloud. We keep the SLOW cloud seam wired to prove the route does
// not (even accidentally) forward to it — the stub is never hit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { CloudClient } from '../src/auth.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';

const SLOW_MS = 1500; // a deliberately slow cloud seam — the route must NOT wait on it
const FAST_BUDGET_MS = 300; // the retired no-op returns well under the slow cloud delay

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

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let extractCalls = 0;
// spec16 §8.1 — fail-closed RPC: the extract fetches carry the suite's cap.
let cap = '';

beforeEach(async () => {
  process.env.PRISMER_LOG_LEVEL = 'silent';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-extract-nonblocking-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_x', 'ws_slow');
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  extractCalls = 0;

  // A SLOW cloud seam. If the retired route ever regressed to forwarding, this
  // stub would be hit (extractCalls > 0) and/or the response would block SLOW_MS.
  const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/api/im/memory/extract')) {
      extractCalls += 1;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return new Response(JSON.stringify({ ok: true, data: { extracted: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, cloud, deviceId: 'dev_x' }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
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

const substantiveBody = (workspaceId: string) => ({
  workspaceId,
  userMessage:
    'Please record this for future sessions: our API base path is /api/v1 for all backend ' +
    'calls, and every service we build should default to that prefix unless told otherwise.',
  assistantResponse:
    'Understood — I will use /api/v1 as the API base for every backend request from now on, and ' +
    'I have noted it so future sessions pick it up automatically. Any new service or client I ' +
    'generate will default to the /api/v1 prefix for backend calls unless you explicitly override it.',
  sessionId: 'sess_slow',
});

describe('extract-turn is a retired inert no-op (memory203/13 §0.5)', () => {
  it('returns the retired 200 FAST and never forwards to the (slow) cloud', async () => {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/local/memory/extract-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
      body: JSON.stringify(substantiveBody('ws_slow')),
    });
    const latency = Date.now() - t0;
    const body = (await res.json()) as { ok: boolean; retired: boolean; reason: string };

    // 1. Retired inert response.
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      retired: true,
      reason: 'cloud_extract_retired_memory203_13_0_5',
    });

    // 2. Returns well under the slow-cloud delay — it can't be waiting on a cloud
    //    call it never makes.
    expect(latency).toBeLessThan(FAST_BUDGET_MS);
    expect(latency).toBeLessThan(SLOW_MS / 2);

    // 3. NEGATIVE CONTROL on the retirement — the cloud extract stub is NEVER hit,
    //    even after a window a (regressed) background forward would need.
    await new Promise((r) => setTimeout(r, SLOW_MS + 200));
    expect(extractCalls).toBe(0);
  });

  it('multiple rapid turns all return the retired no-op fast, none forwarding', async () => {
    const t0 = Date.now();
    const results = await Promise.all(
      ['ws_a', 'ws_b', 'ws_c'].map((ws) =>
        fetch(`${baseUrl}/local/memory/extract-turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
          body: JSON.stringify(substantiveBody(ws)),
        }),
      ),
    );
    const latency = Date.now() - t0;
    for (const r of results) expect(r.status).toBe(200);
    expect(latency).toBeLessThan(SLOW_MS);
    // None of the three forwarded to the cloud.
    await new Promise((r) => setTimeout(r, 100));
    expect(extractCalls).toBe(0);
  });
});
