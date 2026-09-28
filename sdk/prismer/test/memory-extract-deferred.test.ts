// memory203/18 R9.2 — extraction deferred retry (doc 18 §9.4).
//
// Under burst the in-pod extraction call to /api/v1/messages is starved by the
// workspace concurrency limiter (429 / 504 slot-deadline / status=0
// cloud_unreachable) and the turn's knowledge used to be DROPPED forever.
//
// What this proves:
//   1. Limiter-class failures (429 / 504 / status=0) DEFER: the turn lands on
//      the bounded in-memory queue (`deferred` counter), writeFailed unchanged.
//   2. NEGATIVE CONTROL — a non-limiter failure (503 upstream, i.e. a permanent
//      model error) does NOT enter the queue: writeFailed+1, queue empty.
//      A 0-page parse outcome (extractedEmpty) doesn't enter it either.
//   3. Retry success runs the NORMAL written/synced path with the ORIGINAL
//      traceId (outbox envelope carries it) and counts deferredRetried.
//   4. Max attempts (3 total) → extraction_abandoned: queue drained,
//      deferredAbandoned+1, nothing written.
//   5. Bounded queue (32) drops the OLDEST entry (`deferred_dropped`): after 33
//      enqueues the first drain processes entry #2, not entry #1.
//
// The pump timer is unref'd + ~60s so it never interferes; tests drive
// `drainDeferredExtractionOnce()` deterministically (the timer calls exactly it).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { openLocalDb } from '../src/sync/store.js';
import { RunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import type { ExtractInput } from '../src/daemon/memory/extract.js';
import {
  attachHookServer,
  getMemoryStageCounters,
  resetMemoryStageCounters,
  enqueueDeferredExtraction,
  drainDeferredExtractionOnce,
  getDeferredExtractionQueueSize,
  resetDeferredExtractions,
  type AttachHookServerOptions,
  type HookResolverContext,
} from '../src/daemon/memory/hook-server.js';

const WS = 'ws_deferred';

let server: LocalServer | undefined;
let baseUrl = '';
let scratchDir = '';

function buildState(): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.1.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: WS,
    pid: 99997,
    startedAt: Date.now() - 1_000,
    wsConnected: true,
    hostedAgents: [],
    runningTaskIds: [],
  };
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'prismer-deferred-'));
  resetMemoryStageCounters();
  resetDeferredExtractions();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  resetMemoryStageCounters();
  resetDeferredExtractions();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

const ONE_PAGE = {
  pages: [
    {
      path: 'project/burst-window.pkf',
      title: 'Burst window knowledge',
      placement: 'new',
      kind: 'project',
      content: '<h1>Burst</h1><p>knowledge from the busiest ingestion window</p>',
    },
  ],
};

/**
 * Gateway whose /api/v1/messages behavior is scripted per call:
 * each entry is a status (429/503/504), 'reject' (transport, status=0), or
 * 'ok' (200 + ONE_PAGE). The LAST entry repeats for any further calls.
 */
function scriptedCloud(script: Array<number | 'reject' | 'ok'>): { cloud: CloudClient; calls: () => number } {
  let n = 0;
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'test_key',
    fetchImpl: (async (url: string | URL | Request) => {
      if (!String(url).includes('/api/v1/messages')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const step = script[Math.min(n, script.length - 1)]!;
      n += 1;
      if (step === 'reject') throw new Error('ECONNREFUSED cloud_unreachable');
      if (step === 'ok') {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ONE_PAGE) }], stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: { code: 'limited', message: 'busy' } }), {
        status: step,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  return { cloud, calls: () => n };
}

interface Mounted {
  server: LocalServer;
  registry: RunSessionRegistry;
  runtime: MemoryRuntime;
  opts: AttachHookServerOptions;
}

function mountServer(cloud: CloudClient): Mounted {
  const db = openLocalDb(':memory:');
  const registry = new RunSessionRegistry(db);
  const memoryRuntime = new MemoryRuntime({ baseDir: scratchDir, deviceId: 'dev_test' });
  const opts: AttachHookServerOptions = {
    cloud,
    memoryRuntime,
    runSessionRegistry: registry,
    deviceId: 'dev_test',
    profileResolver: { byProfileName: () => null },
  };
  // ephemeral port — caller reads the real port back after start (O16-b)
  server = new LocalServer({ port: 0, getState: buildState, attachHooks: attachHookServer(opts) });
  return { server, registry, runtime: memoryRuntime, opts };
}

function registerRun(registry: RunSessionRegistry, runId: string): void {
  registry.register({
    runId,
    conversationId: 'conv_d',
    taskId: null,
    agentImUserId: 'agent_d',
    workspaceId: WS,
    profileName: 'deferred-profile',
    roleTemplateSlug: null,
    adapterName: 'hermes',
    model: 'configured-model',
    proxyProvider: 'configured-provider',
    servedModel: 'test-model',
    servedProvider: 'test-provider',
    routingEvidenceSource: 'adapter',
  });
}

/** Clears the heuristic gate (≥80 user / ≥200 assistant chars). */
function substantiveExtra(traceId: string): Record<string, unknown> {
  return {
    user_message:
      'Please read the burst-window ingestion notes and remember the durable operational facts ' +
      'they contain so future sessions can recall them without re-reading the raw sources.',
    assistant_response:
      'I read the burst-window ingestion notes. Durable facts worth keeping: the limiter grants ' +
      'per-workspace slots with a bounded queue of depth ten; starved calls surface as 429 or 504 ' +
      'after the slot deadline; extraction retries must stay serial to remain gentle on the limiter.',
    conversation_history: [],
    trace_id: traceId,
  };
}

async function postHook(runId: string, extra: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/v1/hooks/post_llm_call?profile=deferred-profile&adapter=hermes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'post_llm_call', session_id: runId, extra }),
  });
  return res.status;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function outboxEnvelopes(runtime: MemoryRuntime, eventType: string): Array<Record<string, unknown>> {
  const db = runtime.resolve(WS).store.rawDb();
  const rows = db
    .prepare('SELECT envelopeJson FROM memory_outbox WHERE eventType = ? ORDER BY createdAt')
    .all(eventType) as Array<{ envelopeJson: string }>;
  return rows.map((r) => JSON.parse(r.envelopeJson) as Record<string, unknown>);
}

describe('R9.2 — limiter-class failures defer instead of dropping', () => {
  it.each([
    ['429 rate-limit', 429 as const],
    ['504 slot-deadline', 504 as const],
    ['status=0 cloud_unreachable', 'reject' as const],
  ])('%s → queued (deferred+1, writeFailed unchanged)', async (_label, step) => {
    const { cloud } = scriptedCloud([step]);
    const m = mountServer(cloud);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_defer');

    expect(await postHook('run_defer', substantiveExtra('tr_defer01'))).toBe(204);
    await waitFor(() => getMemoryStageCounters().deferred >= 1);
    const c = getMemoryStageCounters();
    expect(c.deferred).toBe(1);
    expect(c.writeFailed).toBe(0);
    expect(getDeferredExtractionQueueSize()).toBe(1);
    m.runtime.closeAll();
  });

  it('NEGATIVE CONTROL — a non-limiter failure (503) does NOT defer: writeFailed+1, queue empty', async () => {
    const { cloud } = scriptedCloud([503]);
    const m = mountServer(cloud);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_hard');

    await postHook('run_hard', substantiveExtra('tr_hard01'));
    await waitFor(() => getMemoryStageCounters().writeFailed >= 1);
    const c = getMemoryStageCounters();
    expect(c.writeFailed).toBe(1);
    expect(c.deferred).toBe(0);
    expect(getDeferredExtractionQueueSize()).toBe(0);
    m.runtime.closeAll();
  });

  it('NEGATIVE CONTROL — a 0-page outcome (extractedEmpty) does NOT defer', async () => {
    const { cloud } = scriptedCloud(['ok']);
    // Overwrite the ok payload shape: empty pages via a dedicated stub.
    const empty = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test_key',
      fetchImpl: (async (url: string | URL | Request) => {
        if (!String(url).includes('/api/v1/messages')) {
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: '{"pages":[]}' }], stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    void cloud;
    const m = mountServer(empty);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_zero');

    await postHook('run_zero', substantiveExtra('tr_zero01'));
    await waitFor(() => getMemoryStageCounters().extractedEmpty >= 1);
    expect(getMemoryStageCounters().deferred).toBe(0);
    expect(getDeferredExtractionQueueSize()).toBe(0);
    m.runtime.closeAll();
  });
});

describe('R9.2 — retry pump semantics (driven deterministically)', () => {
  it('retry success writes pages with the ORIGINAL traceId and counts deferredRetried', async () => {
    // First call starved (429); the retry succeeds.
    const { cloud, calls } = scriptedCloud([429, 'ok']);
    const m = mountServer(cloud);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_recover');

    await postHook('run_recover', substantiveExtra('tr_recover1'));
    await waitFor(() => getMemoryStageCounters().deferred >= 1);
    expect(getDeferredExtractionQueueSize()).toBe(1);

    await drainDeferredExtractionOnce();

    const c = getMemoryStageCounters();
    expect(c.deferredRetried).toBe(1);
    expect(c.deferredAbandoned).toBe(0);
    expect(c.extracted).toBe(1);
    expect(getDeferredExtractionQueueSize()).toBe(0);
    expect(calls()).toBe(2); // live attempt + one retry
    // The trace chain shows the gap AND the recovery: the outbox envelope
    // carries the turn's ORIGINAL traceId, not a fresh one.
    const [up] = outboxEnvelopes(m.runtime, 'memory.page.upsert');
    expect(up).toBeDefined();
    expect(up!.traceId).toBe('tr_recover1');
    expect(m.runtime.resolve(WS).store.loadByPath('project/burst-window.pkf')).not.toBeNull();
    m.runtime.closeAll();
  });

  it('max 3 attempts → extraction_abandoned (deferredAbandoned+1, nothing written)', async () => {
    const { cloud, calls } = scriptedCloud([429]); // always starved
    const m = mountServer(cloud);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_abandon');

    await postHook('run_abandon', substantiveExtra('tr_abandon1'));
    await waitFor(() => getMemoryStageCounters().deferred >= 1);

    await drainDeferredExtractionOnce(); // attempt 2 → re-queued
    expect(getDeferredExtractionQueueSize()).toBe(1);
    expect(getMemoryStageCounters().deferredAbandoned).toBe(0);

    await drainDeferredExtractionOnce(); // attempt 3 → abandoned
    const c = getMemoryStageCounters();
    expect(c.deferredAbandoned).toBe(1);
    expect(c.deferredRetried).toBe(0);
    expect(getDeferredExtractionQueueSize()).toBe(0);
    expect(calls()).toBe(3); // exactly 3 total attempts
    expect(m.runtime.resolve(WS).store.loadByPath('project/burst-window.pkf')).toBeNull();
    // `deferred` counts entries, not tries — still 1 after the re-queue.
    expect(c.deferred).toBe(1);
    m.runtime.closeAll();
  });

  it('a hard (non-limiter) failure ON RETRY abandons immediately (no useless re-queues)', async () => {
    const { cloud } = scriptedCloud([429, 503]);
    const m = mountServer(cloud);
    await m.server.start();
    baseUrl = boundBaseUrl(m.server);
    registerRun(m.registry, 'run_hard_retry');

    await postHook('run_hard_retry', substantiveExtra('tr_hardretry'));
    await waitFor(() => getMemoryStageCounters().deferred >= 1);

    await drainDeferredExtractionOnce(); // retry hits 503 → abandon
    const c = getMemoryStageCounters();
    expect(c.deferredAbandoned).toBe(1);
    expect(getDeferredExtractionQueueSize()).toBe(0);
    m.runtime.closeAll();
  });
});

describe('R9.2 — bounded queue (drop-oldest at 32)', () => {
  it('the 33rd enqueue evicts entry #1; the next drain processes entry #2', async () => {
    const { cloud } = scriptedCloud(['ok']);
    const m = mountServer(cloud);
    await m.server.start(); // server unused, but gives the runtime a home
    baseUrl = boundBaseUrl(m.server);

    const ctx: HookResolverContext = {
      agentImUserId: 'agent_d',
      workspaceId: WS,
      profileName: 'deferred-profile',
      roleTemplateSlug: null,
      conversationId: 'conv_d',
      taskId: null,
      adapterName: 'hermes',
    };
    const input = (traceId: string): ExtractInput => ({
      userMessage:
        'Please read the burst-window ingestion notes and remember the durable operational facts ' +
        'they contain so future sessions can recall them without re-reading the raw sources.',
      assistantResponse:
        'I read the burst-window ingestion notes. Durable facts worth keeping: the limiter grants ' +
        'per-workspace slots with a bounded queue of depth ten; starved calls surface as 429 or 504 ' +
        'after the slot deadline; extraction retries must stay serial to remain gentle on the limiter.',
      conversationHistory: [],
      agentImUserId: 'agent_d',
      workspaceId: WS,
      roleSlug: null,
      conversationId: 'conv_d',
      runId: 'run_bound',
      sessionMetadata: { model: 'test-model', platform: 'hermes' },
      traceId,
    });

    for (let i = 0; i < 33; i++) {
      enqueueDeferredExtraction({ input: input(`tr_bound_${i}`), ctx, opts: m.opts, attempts: 1 }, `tr_bound_${i}`);
    }
    expect(getDeferredExtractionQueueSize()).toBe(32); // bounded, oldest dropped
    expect(getMemoryStageCounters().deferred).toBe(33); // every push counted

    await drainDeferredExtractionOnce(); // gateway 'ok' → writes with the entry's traceId
    const [up] = outboxEnvelopes(m.runtime, 'memory.page.upsert');
    expect(up).toBeDefined();
    // Drop-OLDEST: tr_bound_0 was evicted, so the head is tr_bound_1.
    expect(up!.traceId).toBe('tr_bound_1');
    m.runtime.closeAll();
  });
});
