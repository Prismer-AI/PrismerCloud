// release201/11 §4 — S23 unit tests for daemon-side metric emit helper.
//
// Covers the three new emit paths added in S23:
//   - agent.dispatch       (single event, value=duration_ms)
//   - skill.invoked        (one event per loaded skill)
//   - outbox fallback      (cloud unreachable → metrics.jsonl)
//
// Plus the B-P0 turn.* block (agent performance pipeline), which DOES drive
// the full handleDispatch loop — the emit lives in its finally{} block, so
// that is the only honest way to assert on it.
//
// Otherwise we drive the helper directly with a stubbed CloudClient so we can
// introspect the request body.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonMetricEmit } from '../src/daemon/metric-emit.js';
import { handleDispatch } from '../src/daemon/dispatch.js';
import type { AdapterDef, AgentProfile } from '../src/adapters/contract.js';
import type { CloudClient } from '../src/auth.js';
import type { ConfigPaths } from '../src/config.js';
import { resolveAgentDirPaths } from '../src/daemon/agent-dir.js';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintSystemCap } from '../src/daemon/memory/cap.js';
import {
  getToolSequenceSince,
  resetToolSequenceRing,
  summarizeR5Turn,
  type ToolSequenceEntry,
} from '../src/daemon/memory/tool-sequence.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
// B-3 contract oracle (Minor 2) — metric-registry.ts is the semantics
// authority; the daemon emitter's rows must equal it on the same ring slice.
// metric-registry.ts is pure (no runtime imports), so the daemon test can
// consume it directly.
import { summarizeR5Turn as cloudSummarizeR5Turn, type R5MemoryToolCall } from '../../../src/im/services/metric-registry.js';

function stubCloud(responses: Array<{ ok: boolean; status?: number; error?: { code: string; message: string } }>): {
  cloud: CloudClient;
  calls: Array<{ method: string; path: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let i = 0;
  const cloud = {
    async request(method: string, path: string, init?: { body?: unknown }) {
      calls.push({ method, path, body: init?.body });
      return responses[i++] ?? { ok: true, status: 200 };
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

function makeTmpPaths(): { paths: ConfigPaths; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'metric-emit-test-'));
  const paths: ConfigPaths = {
    root,
    configFile: join(root, 'config.toml'),
    localDb: join(root, 'local.db'),
    cacheDir: join(root, 'cache'),
    devicesDir: join(root, 'devices'),
    runsDir: join(root, 'runs'),
    workspacesDir: join(root, 'workspaces'),
    logsDir: join(root, 'logs'),
  };
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('daemonMetricEmit — agent.dispatch + skill.invoked (S23)', () => {
  it('posts to /api/im/metrics/batch with normalised events', async () => {
    const { cloud, calls } = stubCloud([{ ok: true, status: 207 }]);
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 4321,
          dims: {
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            taskId: 'task-1',
            projectId: 'proj-1',
            capability: 'general',
          },
        },
        {
          namespace: 'skill',
          name: 'invoked',
          value: 1,
          dims: {
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            skillId: 'sk-engineering',
            taskId: 'task-1',
          },
        },
      ],
      { cloud, agentImUserId: 'agent-1' },
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/api/im/metrics/batch');
    const body = calls[0]!.body as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(2);
    const ev0 = body.events[0] as { namespace: string; name: string; value: number; dims: Record<string, unknown> };
    expect(ev0.namespace).toBe('agent');
    expect(ev0.name).toBe('dispatch');
    expect(ev0.value).toBe(4321);
    expect(ev0.dims.workspaceId).toBe('ws-1');
    expect(ev0.dims.taskId).toBe('task-1');
    const ev1 = body.events[1] as { namespace: string; name: string; value: number; dims: Record<string, unknown> };
    expect(ev1.namespace).toBe('skill');
    expect(ev1.name).toBe('invoked');
    expect(ev1.dims.skillId).toBe('sk-engineering');
  });

  it('drops undefined dim values without breaking the envelope', async () => {
    const { cloud, calls } = stubCloud([{ ok: true }]);
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 100,
          dims: {
            workspaceId: 'ws-2',
            agentId: 'a',
            taskId: 't',
            projectId: undefined,
            capability: undefined,
          },
        },
      ],
      { cloud, agentImUserId: 'a' },
    );
    const body = calls[0]!.body as { events: Array<{ dims: Record<string, unknown> }> };
    expect('projectId' in body.events[0]!.dims).toBe(false);
    expect('capability' in body.events[0]!.dims).toBe(false);
    expect(body.events[0]!.dims.workspaceId).toBe('ws-2');
  });

  it('is a no-op on empty events without hitting cloud', async () => {
    const { cloud, calls } = stubCloud([]);
    await daemonMetricEmit([], { cloud, agentImUserId: 'a' });
    expect(calls.length).toBe(0);
  });

  it('falls back to per-agent outbox when cloud returns non-ok', async () => {
    const { cloud } = stubCloud([
      { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: 'boom' } },
    ]);
    const { paths, cleanup } = makeTmpPaths();
    try {
      await daemonMetricEmit(
        [
          {
            namespace: 'agent',
            name: 'dispatch',
            value: 99,
            dims: { workspaceId: 'ws-3', agentId: 'a', taskId: 't' },
          },
        ],
        { cloud, paths, daemonId: 'did-1', agentImUserId: 'a' },
      );
      const dirs = resolveAgentDirPaths(paths, 'did-1', 'a');
      expect(existsSync(dirs.metricsOutboxFile)).toBe(true);
      const lines = readFileSync(dirs.metricsOutboxFile, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]!) as {
        kind: string;
        eventType: string;
        workspaceId: string;
        taskId: string;
        payload: { value: unknown };
      };
      expect(entry.kind).toBe('metric.event');
      expect(entry.eventType).toBe('agent.dispatch');
      expect(entry.workspaceId).toBe('ws-3');
      expect(entry.taskId).toBe('t');
      expect(entry.payload.value).toBe(99);
    } finally {
      cleanup();
    }
  });

  it('also writes to outbox when cloud throws (network error)', async () => {
    const cloud = {
      async request() {
        throw new Error('ECONNREFUSED');
      },
    } as unknown as CloudClient;
    const { paths, cleanup } = makeTmpPaths();
    try {
      await daemonMetricEmit(
        [
          {
            namespace: 'skill',
            name: 'invoked',
            value: 1,
            dims: { workspaceId: 'w', agentId: 'a', skillId: 's', taskId: 't' },
          },
        ],
        { cloud, paths, daemonId: 'did-2', agentImUserId: 'a' },
      );
      const dirs = resolveAgentDirPaths(paths, 'did-2', 'a');
      expect(existsSync(dirs.metricsOutboxFile)).toBe(true);
      const entry = JSON.parse(
        readFileSync(dirs.metricsOutboxFile, 'utf8').trim().split('\n')[0]!,
      ) as { eventType: string };
      expect(entry.eventType).toBe('skill.invoked');
    } finally {
      cleanup();
    }
  });

  it('silently drops to floor when outbox ctx is missing and cloud fails', async () => {
    const cloud = {
      async request() {
        throw new Error('offline');
      },
    } as unknown as CloudClient;
    // No paths / daemonId / agentImUserId — helper has nowhere to fall back to,
    // but must NOT throw or reject.
    await expect(
      daemonMetricEmit(
        [
          {
            namespace: 'agent',
            name: 'dispatch',
            value: 1,
            dims: { workspaceId: 'w', agentId: 'a', taskId: 't' },
          },
        ],
        { cloud },
      ),
    ).resolves.toBeUndefined();
  });

  it('serialises Date ts into ISO string', async () => {
    const { cloud, calls } = stubCloud([{ ok: true }]);
    const at = new Date('2026-01-01T00:00:00Z');
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 1,
          dims: { workspaceId: 'w', agentId: 'a', taskId: 't' },
          ts: at,
        },
      ],
      { cloud },
    );
    const body = calls[0]!.body as { events: Array<{ ts?: string }> };
    expect(body.events[0]!.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ─── B-P0: turn.* emission from the handleDispatch finally{} block ──────────

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface RecordedEvent {
  namespace: string;
  name: string;
  value?: unknown;
  dims: Record<string, unknown>;
}

/**
 * Drive one full handleDispatch turn against a stubbed long-running adapter
 * and return the recorded `/api/im/metrics/batch` body. The emit is
 * fire-and-forget but `daemonMetricEmit` invokes `cloud.request`
 * synchronously, so the batch is already recorded once the reply resolves.
 */
async function dispatchTurnAndCaptureMetrics(
  result: Record<string, unknown>,
  profileOverrides: Partial<AgentProfile> = {},
): Promise<{ events: RecordedEvent[] }> {
  const requests: RecordedRequest[] = [];
  const profile: AgentProfile = {
    id: 'profile-turn',
    workspaceId: 'ws-turn',
    agentImUserId: 'agent-turn',
    adapterName: 'hermes',
    name: 'Hermes',
    config: { systemPrompt: 'You are Hermes.' },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...profileOverrides,
  };
  const adapter: AdapterDef = {
    name: 'hermes',
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {} as any,
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
  };
  const cloud = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/im/agent_profiles/profile-turn') return profile;
      if (path.startsWith('/api/im/tasks?')) return [];
      if (path.startsWith('/api/im/memory/digest?')) {
        return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
      }
      if (path === '/api/im/tasks/task-turn-1') return { task: { id: 'task-turn-1', metadata: {} } };
      throw new Error(`unexpected GET ${path}`);
    }),
    request: vi.fn(async (method: string, path: string, init: { body?: unknown }) => {
      requests.push({ method, path, body: init?.body });
      return { ok: true, status: 200, data: { ok: true, data: {} } };
    }),
  };

  await handleDispatch(
    {
      taskId: 'task-turn-1',
      agentImUserId: 'agent-turn',
      profileId: 'profile-turn',
      capability: 'code',
      prompt: 'report your metrics',
      conversationId: 'conv-turn-1',
    },
    'req-turn',
    {
      registry: { get: () => adapter } as any,
      cloud: cloud as any,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as any,
      assetCache: { unpin: vi.fn() } as any,
      ws: { send: () => {} } as any,
      ensureService: async () => ({ id: 'svc', healthy: async () => true, dispatch: async () => result as any }),
    },
  );

  const batch = requests.find((r) => r.path === '/api/im/metrics/batch');
  expect(batch).toBeDefined();
  const body = batch!.body as { events: RecordedEvent[] };
  return { events: body.events };
}

function turnEventsByName(events: RecordedEvent[]): Map<string, RecordedEvent> {
  const turn = events.filter((e) => e.namespace === 'turn');
  return new Map(turn.map((e) => [e.name, e]));
}

describe('B-P0 — turn.* metrics emitted from the dispatch finally block', () => {
  it('emits all 8 turn events with model/provider/conversationId dims when usage is present', async () => {
    const { events } = await dispatchTurnAndCaptureMetrics({
      ok: true,
      output: 'done',
      metrics: { durationMs: 4321, firstEventMs: 321 },
      metadata: {
        modelUsed: 'glm-4.7',
        providerUsed: 'prismer-gateway',
        hermes: {
          status: 'dispatched',
          runId: 'run-turn-1',
          usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 120 },
        },
      },
    });

    const byName = turnEventsByName(events);
    const expected = [
      'count',
      'tokens_input',
      'tokens_output',
      'tokens_cache_read',
      'tokens_cache_write',
      'duration_ms',
      'first_event_ms',
      'tool_calls',
    ];
    expect([...byName.keys()].sort()).toEqual([...expected].sort());

    expect(byName.get('count')!.value).toBe(1);
    expect(byName.get('tokens_input')!.value).toBe(1200);
    expect(byName.get('tokens_output')!.value).toBe(340);
    expect(byName.get('tokens_cache_read')!.value).toBe(900);
    expect(byName.get('tokens_cache_write')!.value).toBe(120);
    expect(byName.get('duration_ms')!.value).toBe(4321);
    expect(byName.get('first_event_ms')!.value).toBe(321);
    expect(byName.get('tool_calls')!.value).toBe(0);

    for (const name of expected) {
      expect(byName.get(name)!.dims).toMatchObject({
        workspaceId: 'ws-turn',
        agentId: 'agent-turn',
        taskId: 'task-turn-1',
        conversationId: 'conv-turn-1',
        model: 'glm-4.7',
        provider: 'prismer-gateway',
        status: 'ok',
      });
    }
  });

  it('emits only count/duration/first_event/tool_calls (no token rows) when usage is absent, falling back to profile model', async () => {
    const { events } = await dispatchTurnAndCaptureMetrics(
      {
        ok: true,
        output: 'done without usage',
        metrics: { durationMs: 1500, firstEventMs: 210 },
        metadata: { hermes: { status: 'dispatched', runId: 'run-turn-2' } },
      },
      { config: { systemPrompt: 'You are Hermes.', model: 'profile-fallback-model' } },
    );

    const byName = turnEventsByName(events);
    expect([...byName.keys()].sort()).toEqual(['count', 'duration_ms', 'first_event_ms', 'tool_calls'].sort());
    expect(byName.get('duration_ms')!.value).toBe(1500);
    expect(byName.get('first_event_ms')!.value).toBe(210);
    // Adapter surfaced no modelUsed → profile fallback; provider default.
    expect(byName.get('count')!.dims.model).toBe('profile-fallback-model');
    expect(byName.get('count')!.dims.provider).toBe('prismer-gateway');
    expect(byName.get('count')!.dims.status).toBe('ok');
  });

  it('emits turn.tool_calls as the sum of recorded tool invocations', async () => {
    const { events } = await dispatchTurnAndCaptureMetrics({
      ok: true,
      output: 'used two tools',
      metrics: { durationMs: 900 },
      metadata: { hermes: { status: 'dispatched', runId: 'run-turn-3' } },
    });
    const byName = turnEventsByName(events);
    // The stub adapter records no tool calls → honest zero, never absent.
    expect(byName.get('tool_calls')!.value).toBe(0);
  });

  it('marks the turn as error when the adapter reports a failed terminal state', async () => {
    const { events } = await dispatchTurnAndCaptureMetrics({
      ok: false,
      output: '',
      // Permanent upstream failure wording → the retry loop exits on attempt 1
      // (no 1s/3s backoff) while the terminal state stays a failure.
      error: { code: 'upstream_llm_error', message: 'HTTP 401: bad credentials' },
      metrics: { durationMs: 700 },
      metadata: { hermes: { status: 'failed', error: 'HTTP 401: bad credentials' } },
    });
    const byName = turnEventsByName(events);
    expect(byName.get('count')!.dims.status).toBe('error');
    expect(byName.get('duration_ms')!.value).toBe(700);
    // No metrics.firstEventMs on this result → no latency row.
    expect(byName.has('first_event_ms')).toBe(false);
  });
});

// ─── B-3 (memory211/03 §7.2 B4): R5 turn rows, REAL emission ───────────────
//
// The §11 B-3 hand-check ("手测一条记录") as a test: drive a full
// handleDispatch whose adapter makes REAL memory RPC calls (search / browse /
// load through the LocalServer + MemoryRuntime the daemon actually serves) so
// the per-workspace tool-sequence ring is populated by the real recording
// path, then assert the three R5 rows POSTed to /api/im/metrics/batch — the
// very events that become `im_metric_events` rows — against BOTH the daemon
// analyzer and the cloud contract oracle (metric-registry.ts summarizeR5Turn)
// over the same ring slice. The existing B-P0 tests (no memory calls) are the
// standing null-for-empty negative control; the explicit re-assertion below
// keeps the 0-row posture visible next to this block.

const R5_WS = 'ws-r5';

const r5BaseState: LocalServerState = {
  daemonId: 'dev_r5',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 9_999_999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

async function r5Http(
  baseUrl: string,
  sysCap: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'x-prismer-memory-cap': sysCap,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
}

/** A small workspace (hub→leaf) so search/load have real pages to address. */
async function seedR5Pages(baseUrl: string, sysCap: string): Promise<void> {
  await r5Http(baseUrl, sysCap, 'POST', '/local/memory/write', {
    workspaceId: R5_WS,
    path: 'INDEX.md',
    content: '# index\n\n- aurora/index.md',
    pageType: 'hub',
    title: 'Workspace Index',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  await r5Http(baseUrl, sysCap, 'POST', '/local/memory/write', {
    workspaceId: R5_WS,
    path: 'aurora/index.md',
    content: '# aurora\n\n## quorum-rings\n\nQuorum rings order themselves by lease age.',
    pageType: 'hub',
    title: 'Aurora',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  // Seeding writes are not the behaviour under test — the dispatch window is.
  resetToolSequenceRing(R5_WS);
}

interface R5MemoryCallContext {
  baseUrl: string;
  sysCap: string;
}

interface R5DispatchResult {
  events: RecordedEvent[];
  /** The exact ring slice the dispatch finally window saw (via the same
   *  getToolSequenceSince call the emitter uses, from a `before` timestamp
   *  taken just before the dispatch). */
  ringSlice: ToolSequenceEntry[];
}

/**
 * One full handleDispatch turn with real memory RPC calls executed by the
 * stub adapter (simulating the agent's tool calls), returning the recorded
 * /api/im/metrics/batch events + the ring slice the finally block summarised.
 */
async function dispatchTurnWithR5MemoryCalls(
  memoryCalls: (ctx: R5MemoryCallContext) => Promise<void>,
): Promise<R5DispatchResult> {
  const requests: RecordedRequest[] = [];
  const profile: AgentProfile = {
    id: 'profile-r5',
    workspaceId: R5_WS,
    agentImUserId: 'agent-r5',
    adapterName: 'hermes',
    name: 'Hermes',
    config: { systemPrompt: 'You are Hermes.' },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adapter: AdapterDef = {
    name: 'hermes',
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {} as any,
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
  };
  const cloud = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/im/agent_profiles/profile-r5') return profile;
      if (path.startsWith('/api/im/tasks?')) return [];
      if (path.startsWith('/api/im/memory/digest?')) {
        return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
      }
      if (path === '/api/im/tasks/task-r5-1') return { task: { id: 'task-r5-1', metadata: {} } };
      throw new Error(`unexpected GET ${path}`);
    }),
    request: vi.fn(async (method: string, path: string, init: { body?: unknown }) => {
      requests.push({ method, path, body: init?.body });
      return { ok: true, status: 200, data: { ok: true, data: {} } };
    }),
  };

  const dir = mkdtempSync(join(tmpdir(), 'r5-metric-emit-'));
  const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_r5' });
  const server = new LocalServer({
    port: 0,
    getState: () => r5BaseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  try {
    await server.start();
    const baseUrl = boundBaseUrl(server);
    const sysCap = mintSystemCap();
    resetToolSequenceRing(R5_WS);
    await seedR5Pages(baseUrl, sysCap);
    const before = Date.now();

    await handleDispatch(
      {
        taskId: 'task-r5-1',
        agentImUserId: 'agent-r5',
        profileId: 'profile-r5',
        capability: 'code',
        prompt: 'recall the quorum page',
        conversationId: 'conv-r5-1',
      },
      'req-r5',
      {
        registry: { get: () => adapter } as any,
        cloud: cloud as any,
        uriResolver: {
          rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
          rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
        } as any,
        assetCache: { unpin: vi.fn() } as any,
        ws: { send: () => {} } as any,
        ensureService: async () => ({
          id: 'svc',
          healthy: async () => true,
          dispatch: async () => {
            await memoryCalls({ baseUrl, sysCap });
            return {
              ok: true,
              output: 'done',
              metrics: { durationMs: 111 },
              metadata: { hermes: { status: 'dispatched', runId: 'run-r5-1' } },
            } as any;
          },
        }),
      },
    );

    const batch = requests.find((r) => r.path === '/api/im/metrics/batch');
    expect(batch).toBeDefined();
    const body = batch!.body as { events: RecordedEvent[] };
    return { events: body.events, ringSlice: getToolSequenceSince(R5_WS, before) };
  } finally {
    await server.stop();
    runtime.closeAll();
    rmSync(dir, { recursive: true, force: true });
    resetToolSequenceRing(R5_WS);
  }
}

function toOracleEntry(e: ToolSequenceEntry): R5MemoryToolCall {
  return { verb: e.verb, at: e.at, ...(e.queries !== undefined ? { queries: e.queries } : {}) };
}

const R5_ROWS = ['first_round_hybrid', 'first_round_direct_read', 'tool_rounds'] as const;

describe('B-3 — R5 turn rows emitted from the dispatch finally block (real memory RPC)', () => {
  it('hybrid first round: batch search (2 queries) + browse in one round → 1/0/1', async () => {
    const { events, ringSlice } = await dispatchTurnWithR5MemoryCalls(async ({ baseUrl, sysCap }) => {
      // W1a batch recall: TWO queries in ONE search call → rings queries: 2.
      expect(
        await r5Http(
          baseUrl,
          sysCap,
          'GET',
          `/local/memory/search?workspaceId=${R5_WS}&queries=${encodeURIComponent(JSON.stringify(['quorum', 'aurora']))}&topK=5`,
        ),
      ).toBe(200);
      expect(await r5Http(baseUrl, sysCap, 'GET', `/local/memory/place-context?workspaceId=${R5_WS}`)).toBe(200);
    });

    const byName = turnEventsByName(events);
    expect(byName.get('first_round_hybrid')!.value).toBe(1);
    expect(byName.get('first_round_direct_read')!.value).toBe(0);
    expect(byName.get('tool_rounds')!.value).toBe(1);
    for (const name of R5_ROWS) {
      expect(byName.get(name)!.dims).toMatchObject({
        workspaceId: R5_WS,
        agentId: 'agent-r5',
        taskId: 'task-r5-1',
        conversationId: 'conv-r5-1',
        status: 'ok',
      });
    }
    // Row oracle (the hand-check): the emitted values equal the daemon analyzer
    // over the exact ring slice the finally saw, which equals the cloud
    // contract oracle — the values that land in im_metric_events.
    expect(summarizeR5Turn(ringSlice)).toEqual({ firstRoundHybrid: 1, firstRoundDirectRead: 0, toolRounds: 1 });
    expect(cloudSummarizeR5Turn(ringSlice.map(toOracleEntry))).toEqual({
      firstRoundHybrid: 1,
      firstRoundDirectRead: 0,
      toolRounds: 1,
    });
  });

  it('direct-read first round: a straight load with no preceding browse → 0/1/1', async () => {
    const { events, ringSlice } = await dispatchTurnWithR5MemoryCalls(async ({ baseUrl, sysCap }) => {
      expect(
        await r5Http(baseUrl, sysCap, 'GET', `/local/memory/load?workspaceId=${R5_WS}&path=aurora/index.md`),
      ).toBe(200);
    });

    const byName = turnEventsByName(events);
    expect(byName.get('first_round_hybrid')!.value).toBe(0);
    expect(byName.get('first_round_direct_read')!.value).toBe(1);
    expect(byName.get('tool_rounds')!.value).toBe(1);
    expect(summarizeR5Turn(ringSlice)).toEqual({ firstRoundHybrid: 0, firstRoundDirectRead: 1, toolRounds: 1 });
    expect(cloudSummarizeR5Turn(ringSlice.map(toOracleEntry))).toEqual({
      firstRoundHybrid: 0,
      firstRoundDirectRead: 1,
      toolRounds: 1,
    });
  });

  it('negative control — a turn with no memory calls emits none of the three R5 rows (null-for-empty)', async () => {
    const { events } = await dispatchTurnWithR5MemoryCalls(async () => {
      /* no memory tool calls this turn */
    });

    const byName = turnEventsByName(events);
    for (const name of R5_ROWS) {
      expect(byName.has(name), `no ${name} row on an empty turn`).toBe(false);
    }
  });
});
