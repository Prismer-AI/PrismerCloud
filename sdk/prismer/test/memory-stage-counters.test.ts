// memory203/18 R8.2 + R8.1 + R9.1(daemon side) — extraction-pipeline stage
// counters, /healthz surfacing, and traceId threading from the post_llm_call
// body into the outbox envelopes.
//
// What this proves:
//   1. R8.2 — the {received, skipped, extracted, writeFailed} counters move on
//      the right stages: intake bumps `received`; a heuristically-tiny turn
//      bumps `skipped`; a gateway LLM failure bumps `writeFailed` (and writes
//      NOTHING); a successful extraction bumps `extracted` per written page.
//   2. /healthz carries `memory.counters` (all-zeros shape when idle), so
//      「没触发 vs 被拦 vs 失败」is one HTTP call apart.
//   3. R8.1 — the `extra.trace_id` stamped by the provider's sync_turn is
//      threaded through runBackgroundExtraction → writeExtractedPage → the
//      memory.page.upsert (and attach link.upsert) outbox envelopes.
//      NEGATIVE CONTROL: with the gateway failing, no envelope exists at all.
//
// The LLM seam is the in-pod gateway `/api/v1/messages` — stubbed via
// CloudClient.fetchImpl (the extraction code path runs verbatim).

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
import {
  attachHookServer,
  getMemoryStageCounters,
  resetMemoryStageCounters,
} from '../src/daemon/memory/hook-server.js';

const WS = 'ws_counters';

let server: LocalServer | undefined;
let baseUrl = '';
let scratchDir = '';

function buildState(): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.1.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: WS,
    pid: 99998,
    startedAt: Date.now() - 1_000,
    wsConnected: true,
    hostedAgents: [],
    runningTaskIds: [],
  };
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'prismer-stage-counters-'));
  resetMemoryStageCounters();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  resetMemoryStageCounters();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

interface MountOpts {
  /** Response for the in-pod gateway POST /api/v1/messages. */
  gateway: { status: number; pagesJson?: unknown };
  onGatewayCall?: () => void;
}

function mountServer(opts: MountOpts): { server: LocalServer; registry: RunSessionRegistry; runtime: MemoryRuntime } {
  const db = openLocalDb(':memory:');
  const registry = new RunSessionRegistry(db);
  const memoryRuntime = new MemoryRuntime({ baseDir: scratchDir, deviceId: 'dev_test' });
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'test_key',
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).includes('/api/v1/messages')) {
        opts.onGatewayCall?.();
        if (opts.gateway.status !== 200) {
          return new Response(JSON.stringify({ error: { code: 'upstream', message: 'boom' } }), {
            status: opts.gateway.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Anthropic-wire success envelope carrying the extraction JSON.
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(opts.gateway.pagesJson) }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  server = new LocalServer({
    port: 0, // ephemeral — caller reads the real port back after start (O16-b)
    getState: buildState,
    attachHooks: attachHookServer({
      cloud,
      memoryRuntime,
      runSessionRegistry: registry,
      deviceId: 'dev_test',
      profileResolver: { byProfileName: () => null },
    }),
  });
  return { server, registry, runtime: memoryRuntime };
}

function registerRun(registry: RunSessionRegistry, runId: string, routing = true): void {
  registry.register({
    runId,
    conversationId: 'conv_c',
    taskId: null,
    agentImUserId: 'agent_c',
    workspaceId: WS,
    profileName: 'counters-profile',
    roleTemplateSlug: null,
    adapterName: 'hermes',
    // Configured intent is always present; the negative control proves it is
    // insufficient without the terminal adapter evidence below.
    model: 'configured-model',
    proxyProvider: 'configured-provider',
    ...(routing
      ? {
          servedModel: 'test-model',
          servedProvider: 'test-provider',
          routingEvidenceSource: 'adapter' as const,
        }
      : {}),
  });
}

/** A turn that clears the heuristic gate (≥80 user / ≥200 assistant chars). */
function substantiveExtra(traceId?: string): Record<string, unknown> {
  return {
    user_message:
      'Please record this for future sessions: our API base path is /api/v1 for all backend ' +
      'calls, and every service we build should default to that prefix unless told otherwise.',
    assistant_response:
      'Understood — I will use /api/v1 as the API base for every backend request from now on, and ' +
      'I have noted it so future sessions pick it up automatically. Any new service or client I ' +
      'generate will default to the /api/v1 prefix for backend calls unless you explicitly override it.',
    conversation_history: [],
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

async function postHook(runId: string, extra: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/v1/hooks/post_llm_call?profile=counters-profile&adapter=hermes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'post_llm_call', session_id: runId, extra }),
  });
  return res.status;
}

/** Poll until `check` passes or ~2s elapse (the extraction runs detached). */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('R8.2 — stage counters', () => {
  it('a heuristically-tiny turn counts received+1 skipped+1 and never reaches the gateway', async () => {
    const setup = mountServer({ gateway: { status: 200, pagesJson: { pages: [] } } });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_tiny');

    const status = await postHook('run_tiny', { user_message: 'hi', assistant_response: 'hello' });
    expect(status).toBe(204);
    await waitFor(() => getMemoryStageCounters().skipped >= 1);
    const c = getMemoryStageCounters();
    expect(c.received).toBe(1);
    expect(c.skipped).toBe(1);
    expect(c.extracted).toBe(0);
    expect(c.writeFailed).toBe(0);
  });

  it('a gateway LLM failure counts writeFailed+1 and writes NOTHING (negative control)', async () => {
    const setup = mountServer({ gateway: { status: 503 } });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_fail');

    await postHook('run_fail', substantiveExtra());
    await waitFor(() => getMemoryStageCounters().writeFailed >= 1);
    const c = getMemoryStageCounters();
    expect(c.received).toBe(1);
    expect(c.skipped).toBe(0);
    expect(c.extracted).toBe(0);
    expect(c.writeFailed).toBe(1);
    // Nothing was persisted and NO envelope exists — traceId can't be faked in.
    const slot = setup.runtime.resolve(WS);
    expect(slot.store.loadByPath('project/api-base.pkf')).toBeNull();
    expect(slot.outbox.pendingCount()).toBe(0);
    setup.runtime.closeAll();
  });

  it('negative control: missing adapter routing evidence skips before gateway and writes nothing', async () => {
    let gatewayCalls = 0;
    const setup = mountServer({
      gateway: { status: 200, pagesJson: { pages: [] } },
      onGatewayCall: () => {
        gatewayCalls += 1;
      },
    });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_missing_routing', false);

    expect(await postHook('run_missing_routing', substantiveExtra())).toBe(204);
    await waitFor(() => getMemoryStageCounters().skipped >= 1);
    expect(getMemoryStageCounters()).toMatchObject({ received: 1, skipped: 1, extracted: 0, writeFailed: 0 });
    expect(gatewayCalls).toBe(0);
    expect(setup.runtime.resolve(WS).store.list({ limit: 20 })).toHaveLength(0);
    setup.runtime.closeAll();
  });

  it('a successful extraction counts extracted per written page', async () => {
    const setup = mountServer({
      gateway: {
        status: 200,
        pagesJson: {
          pages: [
            {
              path: 'project/api-base.pkf',
              title: 'API base path',
              placement: 'new',
              kind: 'project',
              content: '<h1>API base</h1><p>/api/v1 everywhere</p>',
            },
          ],
        },
      },
    });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_ok');

    await postHook('run_ok', substantiveExtra());
    await waitFor(() => getMemoryStageCounters().extracted >= 1);
    const c = getMemoryStageCounters();
    expect(c.received).toBe(1);
    expect(c.extracted).toBe(1);
    expect(c.writeFailed).toBe(0);
    expect(setup.runtime.resolve(WS).store.loadByPath('project/api-base.pkf')).not.toBeNull();
    setup.runtime.closeAll();
  });

  it('/healthz surfaces memory.counters (stable all-numbers shape)', async () => {
    const setup = mountServer({ gateway: { status: 200, pagesJson: { pages: [] } } });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as { memory?: { counters?: Record<string, number> } };
    expect(body.memory?.counters).toEqual({
      received: 0,
      skipped: 0,
      extracted: 0,
      writeFailed: 0,
      extractedEmpty: 0,
      placementWarn: 0,
      deliverablePointerMissing: 0,
      extractionGatedOut: 0,
      shardingRequired: 0,
      descriptionRequired: 0,
      pkfInvalid: 0,
      deliverableDedupeHit: 0,
      flatPage: 0,
      replaceOnSectionedPage: 0,
      bareUriUpgraded: 0,
      bareUriScopedDegrade: 0,
      // S5 §3.4-3b (specs/05 Task 5) — real background-compaction failures
      // (candidate GET / LLM / empty projection / persist). Gates excluded.
      compactionFailed: 0,
      deferred: 0,
      deferredRetried: 0,
      deferredAbandoned: 0,
    });
  });

  // memory203/18 W2 — the W1-gate observability gap: llm_called then SILENCE.
  // A reached-LLM turn that yields zero pages is now a counted terminal state
  // (`extractedEmpty`) distinct from skipped (pre-LLM) and writeFailed.
  it('a 0-page LLM outcome counts extractedEmpty (terminal state, not silence)', async () => {
    const setup = mountServer({ gateway: { status: 200, pagesJson: { pages: [] } } });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_empty');

    await postHook('run_empty', substantiveExtra());
    await waitFor(() => getMemoryStageCounters().extractedEmpty >= 1);
    const c = getMemoryStageCounters();
    expect(c.received).toBe(1);
    expect(c.skipped).toBe(0);
    expect(c.extracted).toBe(0);
    expect(c.writeFailed).toBe(0);
    expect(c.extractedEmpty).toBe(1);
    setup.runtime.closeAll();
  });
});

describe('R8.1 — traceId threading (hook body → outbox envelopes)', () => {
  it('extra.trace_id lands on the memory.page.upsert AND the attach link.upsert envelopes', async () => {
    const setup = mountServer({
      gateway: {
        status: 200,
        pagesJson: {
          pages: [
            {
              path: 'project/desktop.pkf',
              title: 'Desktop hub',
              placement: 'hub',
              kind: 'project',
              content: '<h1>Desktop</h1>',
            },
            {
              path: 'project/desktop/sync.pkf',
              title: 'Sync protocol',
              placement: 'attach',
              parentHubPath: 'project/desktop.pkf',
              kind: 'project',
              content: '<h1>Sync</h1><p>outbox + checkpoints</p>',
            },
          ],
        },
      },
    });
    await setup.server.start();
    baseUrl = boundBaseUrl(setup.server);
    registerRun(setup.registry, 'run_trace');

    await postHook('run_trace', substantiveExtra('run_trace-cafe0123'));
    await waitFor(() => getMemoryStageCounters().extracted >= 2);

    const db = setup.runtime.resolve(WS).store.rawDb();
    const rows = db
      .prepare('SELECT eventType, envelopeJson FROM memory_outbox ORDER BY createdAt')
      .all() as Array<{ eventType: string; envelopeJson: string }>;
    const pageEnvs = rows.filter((r) => r.eventType === 'memory.page.upsert');
    const linkEnvs = rows.filter((r) => r.eventType === 'memory.link.upsert');
    expect(pageEnvs.length).toBe(2);
    expect(linkEnvs.length).toBe(1);
    for (const r of [...pageEnvs, ...linkEnvs]) {
      const env = JSON.parse(r.envelopeJson) as { traceId?: string };
      expect(env.traceId).toBe('run_trace-cafe0123');
    }
    setup.runtime.closeAll();
  });
});
