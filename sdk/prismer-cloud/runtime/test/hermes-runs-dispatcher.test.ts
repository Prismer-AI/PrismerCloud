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
import { HERMES_TASK_RUNS_DISPATCH_ENV, deriveDispatchKind } from '../src/adapters/hermes/flag.js';
import { deriveExecutionContext } from '../src/adapters/hermes/sessions-dispatcher.js';

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
  captured: Array<{ url: string; method?: string; body?: unknown }>,
): typeof fetch {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
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
    captured.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
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
  }) as unknown as typeof fetch;
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
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(null);
  });

  async function dispatch(task: Partial<TaskInput>, requests: Array<{ url: string; method?: string; body?: unknown }>) {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
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
        metadata: { workspaceId: 'ws-1', prismerTaskId: 'task-9' },
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
        metadata: { workspaceId: 'ws-1' },
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
    expect(kind({ taskId: 't-kanban', metadata: { workspaceId: 'ws-1', prismerTaskId: 'k1' } })).toBe(
      'run',
    );
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
