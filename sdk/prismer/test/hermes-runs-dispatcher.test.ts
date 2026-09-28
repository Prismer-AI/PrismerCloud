// release202/08 Phase 1 — Hermes one-shot task-run dispatch via /v1/runs.
//
// Verifies the flag-gated router in hermes/index.ts + runs-dispatcher.ts:
//
//   flag ON  + task-run (no triggering sender) → POST /v1/runs (202 + run_id),
//              subscribe GET /v1/runs/{id}/events, consume the SSE; the run
//              input carries image_url parts; system_prompt embeds the
//              <execution_context>; NO /api/sessions* request (stateless).
//   flag ON  + chat turn (has triggering sender) → still /api/sessions/{id}/
//              chat/stream (sessions path, unchanged).
//   flag OFF → everything (incl. a bare task-run) stays on sessions
//              (regression — A3 behaviour byte-for-byte).
//
// fetch is stubbed — no real Hermes. The stub session-mapper short-circuits the
// sqlite dependency exactly like adapter-multimodal.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentProfile, TaskInput } from '../src/adapters/contract.js';
import type { ResolvedAssetRef } from '../src/types/im-events.js';
import {
  HERMES_TASK_RUNS_DISPATCH_ENV,
  deriveDispatchKind,
  isPhaseAEligibleRunDispatch,
} from '../src/adapters/persistence/hermes/flag.js';
import { deriveExecutionContext } from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import {
  buildRunIdempotencyKey,
  dispatchViaRuns,
  type RunsDispatchDeps,
} from '../src/adapters/persistence/hermes/runs-dispatcher.js';
import { isLimiterClassError } from '../src/daemon/dispatch.js';

const FLAG = HERMES_TASK_RUNS_DISPATCH_ENV;

function makeImageRef(overrides: Partial<ResolvedAssetRef> = {}): ResolvedAssetRef {
  return {
    assetId: 'ast-img-1',
    contentHash: 'sha256-abc',
    mime: 'image/png',
    sizeBytes: 100,
    kind: 'image',
    workspaceId: 'ws-1',
    role: 'attachment',
    cdnUrl: 'https://cdn.example.com/img.png',
    reachable: 'cdn',
    ...overrides,
  };
}

function makeProfile(): AgentProfile {
  return {
    id: 'profile-test',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-test',
    agentUsername: 'test-agent',
    adapterName: 'hermes',
    name: 'default',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    config: { apiKey: 'sk-test', prismerMcpServerPath: '/tmp/mcp.js' },
  };
}

function makeStubSessionMapper() {
  let cached:
    | { conversationId: string; agentImUserId: string; hermesSessionId: string; hermesSessionKey: string | null }
    | null = null;
  return {
    get(conversationId: string, agentImUserId: string) {
      if (!cached) return null;
      return cached.conversationId === conversationId && cached.agentImUserId === agentImUserId
        ? cached
        : null;
    },
    async createForConversation(
      _baseUrl: string,
      _apiKey: string,
      conversationId: string,
      agentImUserId: string,
    ) {
      cached = {
        conversationId,
        agentImUserId,
        hermesSessionId: `sess-${conversationId}`,
        hermesSessionKey: null,
      };
      return cached;
    },
  };
}

function buildSse(deltaText: string): string {
  return [
    'event: run.started',
    'data: {"run_id":"run-1"}',
    '',
    'event: assistant.delta',
    `data: {"delta":${JSON.stringify(deltaText)}}`,
    '',
    'event: run.completed',
    'data: {"usage":{"input_tokens":10,"output_tokens":3}}',
    '',
  ].join('\n');
}

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
  } as unknown as Response;
}

function makeStubFetch(
  captured: Array<{
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
  }>,
): typeof fetch {
  return vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/health/detailed')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          gateway_state: 'running',
          platforms: { api_server: { state: 'connected' } },
        }),
      } as Response;
    }
    if (url.endsWith('/v1/capabilities')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: { session_chat_streaming: true, run_approval_response: true },
        }),
      } as Response;
    }
    captured.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      rawBody: init?.body,
    });
    // /v1/runs POST → 202 + run_id
    if (url.endsWith('/v1/runs') && method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ run_id: 'run-1' }) } as Response;
    }
    // /v1/runs/{id}/events → SSE
    if (url.includes('/v1/runs/') && url.endsWith('/events')) {
      return sseResponse(buildSse('run-ack'));
    }
    // sessions session-create + chat/stream
    if (url.endsWith('/api/sessions')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({ session: { id: 'sess-conv-1' } }),
      } as Response;
    }
    if (url.includes('/api/sessions/') && url.endsWith('/chat/stream')) {
      return sseResponse(buildSse('session-ack'));
    }
    return { ok: false, status: 404, text: async () => `unexpected ${url}` } as Response;
    },
  ) as unknown as typeof fetch;
}

describe('hermes adapter — task-run dispatch via /v1/runs (release202/08 Phase 1)', () => {
  let home: string;
  let oldHermesHome: string | undefined;
  let oldFlag: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prismer-hermes-runs-'));
    oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(home, 'hermes');
    oldFlag = process.env[FLAG];
  });

  afterEach(async () => {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    if (oldFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = oldFlag;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    const { setHermesSessionMapper } = await import('../src/adapters/persistence/hermes/sessions-mapper.js');
    setHermesSessionMapper(null);
  });

  async function dispatch(task: Partial<TaskInput>, requests: Array<{ url: string; method?: string; body?: unknown }>) {
    const { hermesAdapter } = await import('../src/adapters/persistence/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/persistence/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);
    vi.stubGlobal('fetch', makeStubFetch(requests));
    const service = await hermesAdapter.ensureService!(makeProfile());
    return service.dispatch({
      taskId: 't-1',
      prompt: 'fallback',
      ...task,
    } as TaskInput);
  }

  it('flag ON + task-run (no triggering sender) → POST /v1/runs + events SSE, no session', async () => {
    process.env[FLAG] = 'true';
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    // task-run signal: no conversationType (→ task-run), no currentMessageSender.
    const result = await dispatch(
      {
        taskId: 't-run',
        prompt: 'do the kanban work',
        currentPrompt: 'do the kanban work',
        metadata: {
          workspaceId: 'ws-1',
          prismerTaskId: 'task-9',
          dispatchedFrom: 'task_projection', // S7 Task 2 — Phase-A eligibility stamp
        },
      },
      requests,
    );

    expect(result.ok).toBe(true);
    const post = requests.find((r) => r.url.endsWith('/v1/runs') && r.method === 'POST');
    expect(post, 'POST /v1/runs should have been hit').toBeDefined();
    const events = requests.find((r) => r.url.includes('/v1/runs/') && r.url.endsWith('/events'));
    expect(events, 'GET /v1/runs/{id}/events should have been hit').toBeDefined();
    // Stateless: no session create / chat-stream anywhere.
    expect(requests.some((r) => r.url.endsWith('/api/sessions'))).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/chat/stream'))).toBe(false);

    const body = post!.body as { input: unknown; system_prompt: unknown };
    expect(typeof body.input).toBe('string');
    expect(body.input).toContain('do the kanban work');
    // system_prompt carries the standalone <execution_context type="task-run">.
    expect(typeof body.system_prompt).toBe('string');
    expect(body.system_prompt).toContain('<execution_context');
    expect(body.system_prompt).toContain('type="task-run"');
    expect(body.system_prompt).toContain('<task_id>t-run</task_id>');
    // task-run subset: NO current_turn_sender.
    expect(body.system_prompt).not.toContain('<current_turn_sender');

    expect((result.metadata?.hermes as Record<string, unknown>)?.dispatchKind).toBe('run');
    expect((result.metadata?.hermes as Record<string, unknown>)?.endpoint).toBe('/v1/runs');
  });

  it('flag ON + task-run with multimodal → image_url part inside run input', async () => {
    process.env[FLAG] = '1';
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const result = await dispatch(
      {
        taskId: 't-run-img',
        prompt: 'analyse the chart',
        currentPrompt: 'analyse the chart',
        assetRefs: [makeImageRef()],
        metadata: { workspaceId: 'ws-1', dispatchedFrom: 'task_projection' },
      },
      requests,
    );

    expect(result.ok).toBe(true);
    const post = requests.find((r) => r.url.endsWith('/v1/runs') && r.method === 'POST');
    expect(post).toBeDefined();
    const body = post!.body as {
      input: Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]?.type).toBe('text');
    expect(body.input[0]?.text).toContain('analyse the chart');
    const img = body.input.find((p) => p.type === 'image_url');
    expect(img?.image_url?.url).toBe('https://cdn.example.com/img.png');
  });

  it('flag ON + chat turn (has triggering sender) → still sessions path', async () => {
    process.env[FLAG] = 'true';
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const result = await dispatch(
      {
        taskId: 't-turn',
        prompt: 'quick question',
        currentPrompt: 'quick question',
        conversationType: 'group',
        currentMessageSender: 'winshare',
        currentMessageSenderRole: 'human',
        metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
      },
      requests,
    );

    expect(result.ok).toBe(true);
    expect(requests.some((r) => r.url.endsWith('/chat/stream'))).toBe(true);
    expect(requests.some((r) => r.url.endsWith('/v1/runs') && r.method === 'POST')).toBe(false);
  });

  it('flag OFF → bare task-run still goes through sessions (regression / A3)', async () => {
    delete process.env[FLAG];
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const result = await dispatch(
      {
        taskId: 't-run-off',
        prompt: 'do the kanban work',
        currentPrompt: 'do the kanban work',
        // Has conversationId+agentImUserId so the sessions path's hard
        // requirement is satisfied (matches how cloud stamps kanban tasks today).
        metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
      },
      requests,
    );

    expect(result.ok).toBe(true);
    // Zero /v1/runs dispatch — flag OFF makes the router inert.
    expect(requests.some((r) => r.url.endsWith('/v1/runs') && r.method === 'POST')).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/chat/stream'))).toBe(true);
  });

  it('index.ts wiring: metadata.dispatchedAt freezes the body; P2 retries reuse ONE Idempotency-Key', async () => {
    process.env[FLAG] = 'true';
    const requests: Array<{
      url: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string;
    }> = [];
    const { hermesAdapter } = await import('../src/adapters/persistence/hermes/index.js');
    const { setHermesSessionMapper } = await import(
      '../src/adapters/persistence/hermes/sessions-mapper.js'
    );
    setHermesSessionMapper(makeStubSessionMapper() as never);
    vi.stubGlobal('fetch', makeStubFetch(requests));
    const service = await hermesAdapter.ensureService!(makeProfile());
    const task = {
      taskId: 'run_wire1',
      prompt: 'do the kanban work',
      currentPrompt: 'do the kanban work',
      metadata: {
        workspaceId: 'ws-1',
        dispatchedAt: '2026-09-20T10:00:00+08:00',
        dispatchedFrom: 'task_projection',
      },
    } as TaskInput;

    // The daemon's P2 retry loop re-enters dispatch() with the SAME per-call
    // options (daemon/dispatch.ts mints the nonce once, outside the loop), so
    // both attempts must present ONE `Idempotency-Key` and a byte-identical
    // body — otherwise the retry is a second, separately-billed run upstream.
    const P2_NONCE = 'aaaaaaaa-1111-2222-3333-444444444444';
    vi.setSystemTime(new Date('2026-09-20T10:00:00+08:00'));
    const first = await service.dispatch(task, { idempotencyNonce: P2_NONCE });
    // Same task, seconds later, SAME call options (the P2 retry shape).
    vi.setSystemTime(new Date('2026-09-20T10:00:05+08:00'));
    const second = await service.dispatch(task, { idempotencyNonce: P2_NONCE });
    // A genuinely NEW dispatch call (cloud requeue) carries a fresh nonce.
    const third = await service.dispatch(task, { idempotencyNonce: 'bbbbbbbb-2222-3333-4444-555555555555' });
    vi.useRealTimers();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const runPosts = requests.filter((r) => r.url.endsWith('/v1/runs') && r.method === 'POST');
    expect(runPosts).toHaveLength(3);
    // P2 retry shape: same key, byte-identical body.
    expect(runPosts[0]!.headers!['Idempotency-Key']).toBe('runs:run_wire1:aaaaaaaa');
    expect(runPosts[1]!.headers!['Idempotency-Key']).toBe(runPosts[0]!.headers!['Idempotency-Key']);
    expect(runPosts[0]!.rawBody).toBe(runPosts[1]!.rawBody);
    expect(runPosts[0]!.rawBody).toContain('<now>2026-09-20T10:00:00+08:00</now>');
    // NEGATIVE CONTROL for the C-1 bug: a re-minted nonce per attempt would
    // have made these equal — they must differ, or the retry re-runs upstream.
    // A NEW dispatch call is a new execution, not a replay.
    expect(runPosts[2]!.headers!['Idempotency-Key']).toBe('runs:run_wire1:bbbbbbbb');
    expect(runPosts[2]!.headers!['Idempotency-Key']).not.toBe(runPosts[0]!.headers!['Idempotency-Key']);
  });

  it('steerRun POSTs /v1/runs/{id}/steer and reports upstream status (interface only)', async () => {
    const requests: Array<{
      url: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string;
    }> = [];
    const { hermesAdapter } = await import('../src/adapters/persistence/hermes/index.js');
    vi.stubGlobal('fetch', makeStubFetch(requests));
    const service = await hermesAdapter.ensureService!(makeProfile());

    const okStub = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => '{}' }) as Response,
    );
    vi.stubGlobal('fetch', okStub);
    const accepted = await service.steerRun('run_steer1', 'use the table format');
    expect(accepted).toEqual({ accepted: true, status: 200 });
    const [url, init] = okStub.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/runs\/run_steer1\/steer$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ input: 'use the table format' });

    // 409 run_not_accepting_steer (run already settled) → not accepted, no throw.
    const conflictStub = vi.fn(
      async () => ({ ok: false, status: 409, text: async () => '{"error":"run_not_accepting_steer"}' }) as Response,
    );
    vi.stubGlobal('fetch', conflictStub);
    expect(await service.steerRun('run_steer1', 'too late')).toEqual({
      accepted: false,
      status: 409,
    });
  });

  it('reinstalls built-in PKF skills before reading the dispatch prompt', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const { hermesAdapter, getHermesProfileDir, getHermesProfileName } = await import(
      '../src/adapters/persistence/hermes/index.js'
    );
    const { setHermesSessionMapper } = await import('../src/adapters/persistence/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);
    vi.stubGlobal('fetch', makeStubFetch(requests));
    const profile = makeProfile();
    const service = await hermesAdapter.ensureService!(profile);
    const skillsDir = join(getHermesProfileDir(getHermesProfileName(profile)), 'skills');
    rmSync(join(skillsDir, 'pkf-writing'), { recursive: true, force: true });
    rmSync(join(skillsDir, 'pkf-svg'), { recursive: true, force: true });

    const result = await service.dispatch({
      taskId: 't-skill-prompt',
      prompt: 'write a long structured report',
      currentPrompt: 'write a long structured report',
      conversationType: 'group',
      currentMessageSender: 'winshare',
      currentMessageSenderRole: 'human',
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const chat = requests.find((r) => r.url.includes('/api/sessions/') && r.url.endsWith('/chat/stream'));
    expect(chat, 'chat stream request should be sent').toBeDefined();
    const systemMessage = (chat!.body as { system_message?: unknown }).system_message;
    expect(typeof systemMessage).toBe('string');
    expect(systemMessage).toContain('## pkf-writing');
    expect(systemMessage).toContain('## pkf-svg');
  });
});

// ════════════════════════════════════════════════════════════════════════
// release202/08 §2 — deterministic run/turn classification. Unit-level (no
// fetch, no service) coverage of the two pure functions that decide transport:
//   deriveExecutionContext(task) → 'task-run' | 'group-session' | 'dm-session'
//   deriveDispatchKind(task, ecType) → 'run' | 'turn'
// This pins the entry-point semantics independent of the adapter wiring above.
// ════════════════════════════════════════════════════════════════════════

const ECTX_DEPS = { model: 'claude-test', supportsVision: false, profileName: 'p' };

function ec(task: Partial<TaskInput>) {
  return deriveExecutionContext({ taskId: 't', prompt: 'x', ...task } as TaskInput, ECTX_DEPS);
}
function kind(task: Partial<TaskInput>) {
  const t = { taskId: 't', prompt: 'x', ...task } as TaskInput;
  return deriveDispatchKind(t, deriveExecutionContext(t, ECTX_DEPS).type);
}

describe('deriveExecutionContext — conversationType classification (§2)', () => {
  it('no conversationType → task-run', () => {
    expect(ec({ metadata: { workspaceId: 'ws-1' } }).type).toBe('task-run');
  });
  it('conversationType=group → group-session', () => {
    expect(ec({ conversationType: 'group' }).type).toBe('group-session');
  });
  it('conversationType=direct → dm-session', () => {
    expect(ec({ conversationType: 'direct' }).type).toBe('dm-session');
  });
  it('conversationType=unknown → task-run (degrade)', () => {
    expect(ec({ conversationType: 'unknown' }).type).toBe('task-run');
  });
  it('envelope conversationType is honoured when task omits it', () => {
    expect(
      ec({ contextEnvelope: { conversationType: 'group' } as TaskInput['contextEnvelope'] }).type,
    ).toBe('group-session');
  });
});

describe('deriveDispatchKind × deriveExecutionContext — flag ON (§2.2 mapping)', () => {
  let oldFlag: string | undefined;
  beforeEach(() => {
    oldFlag = process.env[FLAG];
    process.env[FLAG] = 'true';
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = oldFlag;
  });

  it('kanban / scheduled fire (task-run, no triggering sender) → run', () => {
    expect(
      kind({
        taskId: 't-kanban',
        // S7 Task 2 — a run dispatch now also needs a Phase-A eligibility stamp
        // (cloud stamps `dispatchedFrom` when it creates the kanban run row).
        metadata: { workspaceId: 'ws-1', prismerTaskId: 'k1', dispatchedFrom: 'task_projection' },
      }),
    ).toBe('run');
  });

  it('task-run that somehow carries a live currentMessageSender → turn', () => {
    // sender present is the tie-breaker even with no conversationType.
    expect(kind({ currentMessageSender: 'winshare' })).toBe('turn');
  });

  it('task-run with triggerSenderUsername in metadata → turn', () => {
    expect(kind({ metadata: { triggerSenderUsername: 'winshare' } })).toBe('turn');
  });

  it('group chat turn (conversationType=group + sender) → turn', () => {
    expect(kind({ conversationType: 'group', currentMessageSender: 'winshare' })).toBe('turn');
  });

  it('dm chat turn (conversationType=direct + sender) → turn', () => {
    expect(kind({ conversationType: 'direct', currentMessageSender: 'ceo' })).toBe('turn');
  });

  it('group conversationType WITHOUT a sender is still a session type → turn (not run)', () => {
    // group-session ≠ task-run, so deriveDispatchKind never promotes it to run
    // even though no sender is present.
    const c = ec({ conversationType: 'group' });
    expect(c.type).toBe('group-session');
    expect(kind({ conversationType: 'group' })).toBe('turn');
  });

  it('direct conversationType WITHOUT a sender is still a session type → turn', () => {
    expect(ec({ conversationType: 'direct' }).type).toBe('dm-session');
    expect(kind({ conversationType: 'direct' })).toBe('turn');
  });
});

describe('deriveDispatchKind — flag OFF is inert (§2 regression)', () => {
  let oldFlag: string | undefined;
  beforeEach(() => {
    oldFlag = process.env[FLAG];
    delete process.env[FLAG];
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = oldFlag;
  });

  it('a bare task-run resolves to turn (would be run if flag ON)', () => {
    expect(kind({ taskId: 't-kanban', metadata: { workspaceId: 'ws-1' } })).toBe('turn');
  });

  it('a chat turn also resolves to turn (unchanged)', () => {
    expect(kind({ conversationType: 'group', currentMessageSender: 'winshare' })).toBe('turn');
  });

  it('explicit falsey flag values are treated as OFF', () => {
    for (const v of ['false', '0', 'no', '']) {
      process.env[FLAG] = v;
      expect(kind({ metadata: { workspaceId: 'ws-1' } })).toBe('turn');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// S7 (spec 07 Task 2) — Phase-A source-eligibility gate.
//
// Flipping `HERMES_TASK_RUNS_DISPATCH` ON must not turn EVERY senderless
// task-run into a run — that would sweep in task-API `on-assign` dispatches
// (which rely on the sessions path's DM anchoring, release203/19 A2) in the
// same flip. Phase A therefore admits only sources the wire already stamps:
//
//   dispatchedFrom='task_projection'          kanban transition→running
//   sourceKind='schedule'                     scheduled fire
//   dispatchedFrom='task_comment_continuation' Task 4 comment continuation
//
// Phase B (owner-gated, D5) deletes the gate and derives purely from
// type + sender. Rows 4/5 below are the negative controls: an unstamped
// `kind:'agent_run'` and a chat sender must both stay on sessions.
// ════════════════════════════════════════════════════════════════════════

describe('deriveDispatchKind — Phase-A source eligibility gate (S7 Task 2)', () => {
  let oldFlag: string | undefined;
  beforeEach(() => {
    oldFlag = process.env[FLAG];
    process.env[FLAG] = 'true';
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = oldFlag;
  });

  it('kanban projection run (dispatchedFrom=task_projection) → run', () => {
    expect(kind({ metadata: { dispatchedFrom: 'task_projection' } })).toBe('run');
  });

  it('schedule run (sourceKind=schedule) → run', () => {
    expect(kind({ metadata: { sourceKind: 'schedule', kind: 'agent_run' } })).toBe('run');
  });

  it('comment continuation run (dispatchedFrom=task_comment_continuation) → run', () => {
    expect(kind({ metadata: { dispatchedFrom: 'task_comment_continuation' } })).toBe('run');
  });

  // NEGATIVE CONTROL — the whole point of the gate.
  it('on-assign task-API dispatch (no eligibility stamp) stays turn in Phase A', () => {
    expect(kind({ metadata: { kind: 'agent_run' } })).toBe('turn');
    expect(kind({ metadata: { workspaceId: 'ws-1', prismerTaskId: 'k1' } })).toBe('turn');
  });

  // NEGATIVE CONTROL — a near-miss stamp must not be accepted.
  it('an unknown dispatchedFrom value stays turn', () => {
    expect(kind({ metadata: { dispatchedFrom: 'some_future_source' } })).toBe('turn');
  });

  it('chat mention run stays turn (sender present, group-session)', () => {
    expect(
      deriveDispatchKind(
        {
          taskId: 't-mention',
          prompt: 'x',
          conversationType: 'group',
          currentMessageSender: 'alice',
          metadata: { triggerSenderUsername: 'alice', conversationId: 'conv-1' },
        } as TaskInput,
        'group-session',
      ),
    ).toBe('turn');
  });

  // Double insurance (裁决 D): even a stamped source cannot promote a chat
  // turn — the sender signal alone keeps it on sessions.
  it('an eligibility stamp does NOT overcome a present chat sender', () => {
    expect(
      deriveDispatchKind(
        {
          taskId: 't-mention',
          prompt: 'x',
          currentMessageSender: 'alice',
          metadata: { dispatchedFrom: 'task_projection', triggerSenderUsername: 'alice' },
        } as TaskInput,
        'task-run',
      ),
    ).toBe('turn');
  });

  it('an eligibility stamp does NOT promote a group/dm execution context', () => {
    expect(
      deriveDispatchKind(
        { taskId: 't-g', prompt: 'x', metadata: { dispatchedFrom: 'task_projection' } } as TaskInput,
        'group-session',
      ),
    ).toBe('turn');
    expect(
      deriveDispatchKind(
        { taskId: 't-d', prompt: 'x', metadata: { sourceKind: 'schedule' } } as TaskInput,
        'dm-session',
      ),
    ).toBe('turn');
  });

  it('flag OFF → always turn, stamped or not (existing regression, must not regress)', () => {
    delete process.env[FLAG];
    expect(kind({ metadata: { dispatchedFrom: 'task_projection' } })).toBe('turn');
    expect(kind({ metadata: { sourceKind: 'schedule', kind: 'agent_run' } })).toBe('turn');
    expect(kind({ metadata: { dispatchedFrom: 'task_comment_continuation' } })).toBe('turn');
  });
});

describe('isPhaseAEligibleRunDispatch — the Phase-B single deletion point (S7 Task 2)', () => {
  it('accepts exactly the three Phase-A sources', () => {
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 'task_projection' })).toBe(true);
    expect(isPhaseAEligibleRunDispatch({ sourceKind: 'schedule' })).toBe(true);
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 'task_comment_continuation' })).toBe(true);
  });

  it('rejects everything else, including non-string stamps and prototype names', () => {
    expect(isPhaseAEligibleRunDispatch({})).toBe(false);
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 'task_projection_ish' })).toBe(false);
    expect(isPhaseAEligibleRunDispatch({ sourceKind: 'work_item' })).toBe(false);
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 42 })).toBe(false);
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 'constructor' })).toBe(false);
    expect(isPhaseAEligibleRunDispatch({ dispatchedFrom: 'toString' })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// S7 (spec 07 Task 1) — runs-dispatcher modernization for the v2026.9.14
// upstream contract. These call dispatchViaRuns() DIRECTLY (no service, no
// router) so the transport contract is pinned without the sessions shield.
//
//   * idempotency header: standard `Idempotency-Key` (the old
//     `X-Prismer-Idempotency-Key` was never read upstream — idempotency never
//     actually took effect), value `runs:<runId>:<nonce8>` — stable across the
//     daemon P2 retry loop (same nonce ⇒ same key), never derived from the
//     prompt.
//   * frozen <now>: taken from metadata.dispatchedAt so a retry seconds later
//     is byte-identical — the upstream fingerprint is sha256(whole body), so a
//     re-computed timestamp would turn every retry into a 409 conflict.
//   * 429 → limiter-class WORDING (the daemon classifier keys on `HTTP 429`)
//     so the existing P2 backoff + cloud requeue channel take over — the
//     adapter grows no retry loop of its own.
//   * 409 idempotency_key_conflict → terminal `idempotency_conflict`.
// ════════════════════════════════════════════════════════════════════════

interface CapturedRunsRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody?: string;
}

const RUN_TASK: TaskInput = {
  taskId: 'run_abc123',
  prompt: 'do the kanban work',
  currentPrompt: 'do the kanban work',
  metadata: { workspaceId: 'ws-1', dispatchedAt: '2026-09-20T10:00:00+08:00' },
};

function runsDeps(overrides: Partial<RunsDispatchDeps> = {}): RunsDispatchDeps {
  return {
    baseUrl: 'http://hermes.local',
    apiKey: 'sk-test',
    model: 'claude-test',
    supportsVision: false,
    profileName: 'p',
    instructions: 'CAPS',
    idempotencyKey: 'llm:deadbeefdeadbeefdeadbeefdeadbeef',
    idempotencyNonce: '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071',
    ...overrides,
  };
}

/** fetch stub that captures url/method/headers/RAW body (no JSON round-trip). */
function makeCapturingFetch(
  captured: CapturedRunsRequest[],
  reply: { status: number; headers?: Record<string, string>; body?: unknown } = {
    status: 202,
    body: { run_id: 'run-1' },
  },
): typeof fetch {
  return vi.fn(
    async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const method = init?.method ?? 'GET';
      captured.push({
        url,
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        rawBody: init?.body,
      });
      if (url.endsWith('/v1/runs') && method === 'POST') {
        const text = JSON.stringify(reply.body ?? {});
        return {
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          headers: {
            get: (k: string) => reply.headers?.[k] ?? reply.headers?.[k.toLowerCase()] ?? null,
          } as unknown as Headers,
          json: async () => reply.body ?? {},
          text: async () => text,
        } as Response;
      }
      if (url.includes('/v1/runs/') && url.endsWith('/events')) return sseResponse(buildSse('run-ack'));
      return { ok: false, status: 404, text: async () => `unexpected ${url}` } as Response;
    },
  ) as unknown as typeof fetch;
}

function posts(captured: CapturedRunsRequest[]): CapturedRunsRequest[] {
  return captured.filter((r) => r.url.endsWith('/v1/runs') && r.method === 'POST');
}

describe('runs-dispatcher — v2026.9.14 idempotency + frozen body (S7 Task 1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('buildRunIdempotencyKey: runs:<runId>:<nonce8>, prompt-independent', () => {
    expect(buildRunIdempotencyKey('run_abc123', '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071')).toBe(
      'runs:run_abc123:3f1a2b4c',
    );
    // 负控: two different prompts on the same (run, nonce) MUST NOT change the
    // key — the old llmIdempotencyKey hashed the prompt, which is exactly the
    // semantic that made the runs path replay-miss.
    expect(buildRunIdempotencyKey('run_abc123', '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071')).toBe(
      buildRunIdempotencyKey('run_abc123', '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071'),
    );
  });

  it('sends standard Idempotency-Key (stable across in-loop retries), not X-Prismer-*', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured));
    const deps = runsDeps();
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, deps);
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, deps); // same nonce ⇒ same key

    const hits = posts(captured);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.headers['Idempotency-Key']).toMatch(/^runs:run_[a-z0-9]+:[0-9a-f]{8}$/);
    expect(hits[1]!.headers['Idempotency-Key']).toBe(hits[0]!.headers['Idempotency-Key']);
    // 负控: the old header is gone (upstream never read it).
    expect(hits[0]!.headers['X-Prismer-Idempotency-Key']).toBeUndefined();
    // same nonce + same taskInput ⇒ byte-identical body (fingerprint premise).
    expect(hits[0]!.rawBody).toBe(hits[1]!.rawBody);
  });

  it('a NEW nonce produces a NEW key (cloud requeue = a real new execution)', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured));
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps({ idempotencyNonce: 'aaaaaaaa-1111' }));
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps({ idempotencyNonce: 'bbbbbbbb-2222' }));

    const hits = posts(captured);
    expect(hits[0]!.headers['Idempotency-Key']).toBe('runs:run_abc123:aaaaaaaa');
    expect(hits[1]!.headers['Idempotency-Key']).toBe('runs:run_abc123:bbbbbbbb');
  });

  it('freezes <now> from deps.nowIso so a retry seconds later is byte-identical', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured));
    const deps = runsDeps({ nowIso: '2026-09-20T10:00:00+08:00' });
    vi.setSystemTime(new Date('2026-09-20T10:00:00+08:00'));
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, deps);
    // > 1s of real-ish clock movement between the two attempts.
    vi.setSystemTime(new Date('2026-09-20T10:00:04+08:00'));
    await dispatchViaRuns({ ...RUN_TASK } as TaskInput, deps);

    const hits = posts(captured);
    expect(hits[0]!.rawBody).toBe(hits[1]!.rawBody);
    expect(hits[0]!.rawBody).toContain('<now>2026-09-20T10:00:00+08:00</now>');
  });

  it('Phase A never sends session_id, even when the reserved dep is passed (裁决 A)', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured));
    await dispatchViaRuns(
      { ...RUN_TASK } as TaskInput,
      runsDeps({ sessionId: 'sess-should-not-be-sent' }),
    );
    expect(posts(captured)[0]!.rawBody).not.toContain('session_id');
    expect(posts(captured)[0]!.rawBody).not.toContain('sess-should-not-be-sent');
  });

  it('without metadata.dispatchedAt the <now> is still live (no regression)', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured));
    const liveNow = new Date('2026-09-20T10:00:00+08:00');
    vi.setSystemTime(liveNow);
    await dispatchViaRuns(
      { ...RUN_TASK, metadata: { workspaceId: 'ws-1' } } as TaskInput,
      runsDeps(),
    );
    const nowMatch = /<now>([^<]+)<\/now>/.exec(posts(captured)[0]!.rawBody);
    expect(nowMatch?.[1]).toBeTruthy();
    expect(Date.parse(nowMatch![1]!)).toBe(liveNow.getTime());
  });
});

describe('runs-dispatcher — 429 / 409 attribution (S7 Task 1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('429 maps into limiter-class wording so the P2 loop backs off and cloud requeues', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal(
      'fetch',
      makeCapturingFetch(captured, {
        status: 429,
        headers: { 'Retry-After': '1' },
        body: { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } },
      }),
    );
    const out = await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps());

    expect(out.result.ok).toBe(false);
    expect(out.result.error!.message).toMatch(/HTTP 429/); // isLimiterClassError 判据
    expect(out.result.error!.message).toMatch(/Retry-After: 1/); // resolveRetryBackoffMs 判据
    // oracle: the authored wording must actually trip the REAL daemon
    // classifier — a passing regex on our side is not evidence.
    expect(isLimiterClassError(out.result.error!.message)).toBe(true);
    const hermes = out.result.metadata!.hermes as Record<string, unknown>;
    expect(hermes.rateLimited).toBe(true);
    expect(hermes.retryAfterMs).toBe(1000);
    // No new retry loop inside the adapter: exactly one POST attempt.
    expect(posts(captured)).toHaveLength(1);
  });

  it('409 idempotency_key_conflict is terminal (code idempotency_conflict, not limiter-class)', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal(
      'fetch',
      makeCapturingFetch(captured, {
        status: 409,
        body: { error: { code: 'idempotency_key_conflict' } },
      }),
    );
    const out = await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps());

    expect(out.result.ok).toBe(false);
    expect(out.result.error!.code).toBe('idempotency_conflict');
    // terminal: never requeued as capacity pressure, never retried by us.
    expect(isLimiterClassError(out.result.error!.message)).toBe(false);
    expect(posts(captured)).toHaveLength(1);
  });

  it('other non-2xx keeps the legacy adapter_dispatch_failed shape', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured, { status: 500, body: 'boom' }));
    const out = await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps());
    expect(out.result.ok).toBe(false);
    expect(out.result.error!.code).toBe('adapter_dispatch_failed');
    expect(isLimiterClassError(out.result.error!.message)).toBe(false);
  });

  it('failure metadata carries the idempotency key + dispatch nonce for correlation', async () => {
    const captured: CapturedRunsRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captured, { status: 500, body: 'boom' }));
    const out = await dispatchViaRuns({ ...RUN_TASK } as TaskInput, runsDeps());
    const hermes = out.result.metadata!.hermes as Record<string, unknown>;
    expect(hermes.idempotencyKey).toBe('runs:run_abc123:3f1a2b4c');
    expect(hermes.dispatchNonce).toBe('3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071');
  });
});
