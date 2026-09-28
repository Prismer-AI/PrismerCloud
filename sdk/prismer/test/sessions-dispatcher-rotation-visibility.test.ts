// S5 §3.4-4 (docs/organization/specs/05 Task 6) — a rotation is visible to the
// human.
//
// Rotation is the repair path, and it used to be completely silent: the agent
// lost its transcript, the cloud rebuilt from a summary, and the user saw a
// reply that stopped referencing the conversation — with nothing in the
// timeline explaining why. Every rotation that mints a new session while a
// previous one existed now emits one `system_event`.
//
// fixture shape copied from sessions-dispatcher-empty-reply.test.ts.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/adapters/persistence/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {},
}));

let sseBehavior: (state?: { runId: string | null }) => Promise<Record<string, unknown>>;
vi.mock('../src/adapters/persistence/hermes/sessions-sse.js', () => ({
  consumeSessionsSse: vi.fn(async (_body: unknown, _task: unknown, state?: { runId: string | null }) =>
    sseBehavior(state),
  ),
}));

vi.mock('../src/daemon/memory/run-session-map.js', () => ({
  getRunSessionRegistry: () => null,
}));

import { dispatchViaSessions } from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { setHermesCloudIO } from '../src/adapters/persistence/hermes/cloud-io.js';
import { __resetSessionHealth } from '../src/adapters/persistence/hermes/session-health.js';
import type { TaskInput } from '../src/adapters/contract.js';

const TASK_ID = 'run_t5ls4nzr1hdxmjr7trldf';

function makeTask(): TaskInput {
  return {
    taskId: TASK_ID,
    prompt: 'ignored',
    currentPrompt: '第二轮问题',
    conversationType: 'direct',
    conversationId: 'cv_1',
    profileAgentUsername: 'engineer',
    profileAgentImUserId: 'u_engineer',
    metadata: { conversationId: 'cv_1', agentImUserId: 'u_engineer', workspaceId: 'ws_1' },
  } as unknown as TaskInput;
}

function depsWithMapperReturning(mappedSessionId: string | null) {
  return {
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'test-key',
    profileName: 'engineer',
    serviceId: 'svc_test',
    model: 'hermes-test',
    capabilities: {},
    instructions: 'You are a test agent.',
    idempotencyKey: 'idem-1',
    sessionMapper: {
      get: () =>
        mappedSessionId
          ? {
              conversationId: 'cv_1',
              agentImUserId: 'u_engineer',
              hermesSessionId: mappedSessionId,
              hermesSessionKey: null,
            }
          : null,
      createForConversation: async () => ({
        conversationId: 'cv_1',
        agentImUserId: 'u_engineer',
        hermesSessionId: 'hs_new',
        hermesSessionKey: null,
      }),
      invalidate: vi.fn(),
    },
  } as unknown as Parameters<typeof dispatchViaSessions>[1];
}

const postSystemEvent = vi.fn(async (_c: string, _content: string, _meta: Record<string, unknown>) => {});
let deadSessions: Set<string> = new Set();

beforeEach(() => {
  deadSessions = new Set();
  postSystemEvent.mockClear();
  sseBehavior = async () => ({ output: 'ok 回复', runId: 'run_new', approvalRequested: false });
  __resetSessionHealth();
  setHermesCloudIO({
    readRecentMessages: async () => [],
    postSystemEvent,
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/chat/stream')) {
      const sid = decodeURIComponent((url.split('/api/sessions/')[1] ?? '').split('/')[0] ?? '');
      if (deadSessions.has(sid)) {
        return new Response(JSON.stringify({ error: { code: 'session_not_found' } }), { status: 404 });
      }
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  setHermesCloudIO(null);
  vi.restoreAllMocks();
});

describe('S5 §3.4-4 rotation visibility', () => {
  it('posts one context_rebuilt system_event on a 404 rotation', async () => {
    deadSessions = new Set(['hs_dead']);

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![0]).toBe('cv_1');
    // S5 §3.4-7 — the honest state statement, identical on every rotation
    // surface. Not "something went wrong" and not silence: what was kept and
    // what was reloaded, plus the one thing the user can do about it.
    expect(postSystemEvent.mock.calls[0]![1]).toBe(
      '上下文窗口已重建：更早的对话内容已按摘要保留，最近的交流已重新载入。如有需要请提醒我补充关键背景。',
    );
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_rebuilt',
      reason: 'session_not_found',
      previousSessionId: 'hs_dead',
      // No transcript readback happened on this path (the gateway served an
      // empty transcript) — the count must be an honest 0, not absent.
      reseededRows: 0,
    });
  });

  it('reports the number of transcript rows the new session was reseeded with', async () => {
    deadSessions = new Set(['hs_dead']);
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/chat/stream')) {
        const sid = decodeURIComponent((url.split('/api/sessions/')[1] ?? '').split('/')[0] ?? '');
        if (deadSessions.has(sid)) {
          return new Response(JSON.stringify({ error: { code: 'session_not_found' } }), { status: 404 });
        }
        return new Response(new ReadableStream(), { status: 200 });
      }
      if (url.includes('/messages')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { role: 'assistant', content: '上一答', timestamp: 1727000060 },
              { role: 'user', content: '上一问', timestamp: 1727000000 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_rebuilt',
      reseededRows: 2,
    });
  });

  it('does not post on a plain reused session (no rotation happened)', async () => {
    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_live'));

    expect(outcome.result.ok).toBe(true);
    expect(postSystemEvent).not.toHaveBeenCalled();
  });

  it('skips the visibility post when the cloud IO seam is unwired, without throwing', async () => {
    setHermesCloudIO(null);
    deadSessions = new Set(['hs_dead']);

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    expect(postSystemEvent).not.toHaveBeenCalled();
  });
});
