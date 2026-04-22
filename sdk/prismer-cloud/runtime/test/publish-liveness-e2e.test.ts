/**
 * E2E publish → see → kill → 90s offline test (Sprint A2.4).
 *
 * Stitches together publishAgent + heartbeat-loop + a mock cloud (stateful
 * fetch impl + mini sweep cron) to verify the full liveness chain end-to-end:
 *
 *   1. Runtime publishes → cloud sees agent online with daemonId
 *   2. Heartbeat loop keeps it online by ticking
 *   3. Stop the loop (simulating daemon kill) → no more ticks
 *   4. Sweep cron flips the agent to offline after the threshold
 *   5. Re-publish restores it to online
 *
 * Timing is compressed (intervalMs=50, sweep threshold=200ms) so the test
 * completes in ~1s of wall time. The production thresholds (30s heartbeat,
 * 90s sweep) are exercised by separate unit tests; this one verifies the
 * *interaction* shape, not the exact timer values.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishAgent } from '../src/agents/publish-agent';
import { startHeartbeatLoop, type HeartbeatLoopHandle } from '../src/agents/heartbeat-loop';

interface CloudAgent {
  cloudAgentId: string;
  imUserId: string;
  daemonId: string;
  status: 'online' | 'offline' | 'busy' | 'idle' | 'crashed';
  lastHeartbeatAt: number;
}

interface MockCloud {
  fetchImpl: typeof fetch;
  registered: Map<string, CloudAgent>;
  registerCalls: { body: any }[];
  heartbeatCalls: { body: any }[];
  startSweep(thresholdMs: number, intervalMs: number): void;
  stopSweep(): void;
}

function createMockCloud(opts?: { nextCloudId?: () => string }): MockCloud {
  const registered = new Map<string, CloudAgent>();
  const registerCalls: { body: any }[] = [];
  const heartbeatCalls: { body: any }[] = [];
  let counter = 0;
  const nextId = opts?.nextCloudId ?? (() => `cmoMOCK${++counter}`);
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;

    // v1.9.16 publish is two-step — step 1 is POST /api/im/register to
    // ensure the role=agent IMUser exists. We don't track its details in
    // this mock (the flow is only exercised indirectly via step 2), just
    // return a shape that matches the real handler so the runtime progresses.
    if (url.endsWith('/api/im/register') && method === 'POST') {
      const username = (body as { username?: string })?.username ?? 'unknown';
      return new Response(
        JSON.stringify({ ok: true, data: { imUserId: `imUser_${username}`, role: 'agent', isNew: true } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/api/im/agents/register') && method === 'POST') {
      registerCalls.push({ body });
      const cloudAgentId = nextId();
      const imUserId = `imUser_${cloudAgentId}`;
      registered.set(cloudAgentId, {
        cloudAgentId,
        imUserId,
        daemonId: body.daemonId,
        status: 'online',
        lastHeartbeatAt: Date.now(),
      });
      return new Response(
        JSON.stringify({ ok: true, data: { agentId: cloudAgentId, userId: imUserId } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/api/im/me/agents/heartbeat') && method === 'POST') {
      heartbeatCalls.push({ body });
      const now = Date.now();
      for (const a of body.agents as { cloudAgentId: string; status: CloudAgent['status'] }[]) {
        const existing = registered.get(a.cloudAgentId);
        if (existing) {
          existing.lastHeartbeatAt = now;
          existing.status = a.status;
        }
      }
      return new Response(JSON.stringify({ ok: true, data: { updated: [], skipped: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    registered,
    registerCalls,
    heartbeatCalls,
    startSweep(thresholdMs: number, intervalMs: number) {
      sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const a of registered.values()) {
          if (a.status !== 'offline' && now - a.lastHeartbeatAt > thresholdMs) {
            a.status = 'offline';
          }
        }
      }, intervalMs);
      if (sweepTimer && typeof (sweepTimer as any).unref === 'function') {
        (sweepTimer as any).unref();
      }
    },
    stopSweep() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
let regFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-e2e-'));
  regFile = path.join(tmpDir, 'published-agents.toml');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('publish → see → kill → offline e2e', () => {
  it('publish makes the agent visible to cloud with daemonId set', async () => {
    const cloud = createMockCloud();
    const result = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      hostname: 'TEST-HOST',
      registryFile: regFile,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Cloud-side state matches what the runtime returned.
    expect(cloud.registered.size).toBe(1);
    const cloudAgent = cloud.registered.get(result.cloudAgentId);
    expect(cloudAgent).toBeDefined();
    expect(cloudAgent!.status).toBe('online');
    expect(cloudAgent!.daemonId).toBe('daemon-A');

    // Wire shape includes daemonId — the load-bearing field for publish.
    expect(cloud.registerCalls).toHaveLength(1);
    expect(cloud.registerCalls[0].body.daemonId).toBe('daemon-A');
    expect(cloud.registerCalls[0].body.adapter).toBe('claude-code');
  });

  it('heartbeat keeps the agent online while the loop runs', async () => {
    const cloud = createMockCloud();
    const pub = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;

    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
      intervalMs: 50,
      fireImmediately: true,
    });

    // Let the loop tick a few times.
    await sleep(220);
    loop.stop();

    // Multiple heartbeats fired and each carried daemonId + cloudAgentId.
    expect(cloud.heartbeatCalls.length).toBeGreaterThanOrEqual(2);
    const lastCall = cloud.heartbeatCalls[cloud.heartbeatCalls.length - 1];
    expect(lastCall.body.daemonId).toBe('daemon-A');
    expect(lastCall.body.agents).toHaveLength(1);
    expect(lastCall.body.agents[0].cloudAgentId).toBe(pub.cloudAgentId);
    expect(lastCall.body.agents[0].status).toBe('online');

    // Cloud-side last-heartbeat is recent — well within the (production) 90s window.
    const cloudAgent = cloud.registered.get(pub.cloudAgentId)!;
    expect(cloudAgent.status).toBe('online');
    expect(Date.now() - cloudAgent.lastHeartbeatAt).toBeLessThan(200);
  });

  it('killing the heartbeat loop → sweep flips agent to offline after threshold', async () => {
    const cloud = createMockCloud();
    cloud.startSweep(/* thresholdMs */ 200, /* intervalMs */ 50);

    const pub = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;

    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
      intervalMs: 30,
      fireImmediately: true,
    });

    // Let the loop establish steady-state online.
    await sleep(120);
    expect(cloud.registered.get(pub.cloudAgentId)!.status).toBe('online');

    // Kill the daemon — no more ticks.
    loop.stop();

    // Wait long enough for the sweep to expire it (threshold 200ms + sweep tick).
    await sleep(400);
    cloud.stopSweep();

    expect(cloud.registered.get(pub.cloudAgentId)!.status).toBe('offline');
  });

  it('republish after offline restores online', async () => {
    const cloud = createMockCloud();
    cloud.startSweep(150, 30);

    const first = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // No heartbeat loop running → sweep will mark offline.
    await sleep(300);
    expect(cloud.registered.get(first.cloudAgentId)!.status).toBe('offline');

    // Republish → fresh registration row, status=online.
    const second = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
    });
    cloud.stopSweep();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // alreadyPublished=true because the local registry remembers the prior publish.
    expect(second.alreadyPublished).toBe(true);
    // The new cloud row is online.
    const newAgent = cloud.registered.get(second.cloudAgentId)!;
    expect(newAgent.status).toBe('online');
  });

  it('killing cloud (fetch fails) increments consecutiveFailures on the loop', async () => {
    const cloud = createMockCloud();
    const pub = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: cloud.fetchImpl,
      registryFile: regFile,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;

    // After publish, swap fetch for one that always rejects (cloud is down).
    const deadFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'daemon-A',
      cloudApiBase: 'https://mock-cloud',
      fetchImpl: deadFetch,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    await loop.tick();
    await loop.tick();
    loop.stop();

    expect(loop.consecutiveFailures()).toBe(3);
    expect(loop.lastSuccessAt()).toBe(0);
  });
});
