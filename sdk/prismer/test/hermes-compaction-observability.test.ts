// S5 §3.4-3b (docs/organization/specs/05 Task 5) — daemon-side compaction
// silent failures become visible.
//
// `runBackgroundCompaction` had seven `traceLog`-and-return exits. Four of them
// are REAL failures (candidate GET died / the LLM produced nothing usable / the
// projection came back empty / the persist POST was refused) and three are
// ordinary gates. Before this change a real failure only produced a stdout
// trace line — invisible unless someone was already tailing the pod. Now the
// four real ones also ride a durable daemon→cloud event channel (assignee
// identity, lands as a row an operator can query) so a failed compaction is one
// DB query away.
//
// The three gates must stay silent, otherwise the channel becomes noise and
// stops meaning "something broke".
//
// LANDING TARGET (T1-2b R1): the first cut posted to
// `POST /api/im/tasks/:id/event`, but `ctx.taskId` in the post-turn hook is the
// RUN id of the dispatched turn — that route looks the id up in `im_tasks` and
// answers `400 RUN_ID_ON_TASK_ROUTE`, which the best-effort catch swallowed: the
// durable half was a silent no-op in production. It now posts to the
// run-scoped `POST /api/im/runs/:runId/events`, with a single task-scoped retry
// only when that answers 404 (kanban-task dispatches carry a task id in the same
// field — release202/09 §3.2 keeps that id space ambiguous on purpose).

import { describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../src/auth.js';
import {
  runBackgroundCompaction,
  resetMemoryStageCounters,
  getMemoryStageCounters,
} from '../src/daemon/memory/hook-server.js';
import type { HookResolverContext } from '../src/daemon/memory/hook-server.js';

/** Compaction polls every Nth turn (MEMORY_COMPACTION_POLL_EVERY_N default 5). */
const POLL_EVERY_N = 5;
/** Below this many turns of history the hook returns before polling. */
const MIN_HISTORY = 8;

interface PostedRequest {
  path: string;
  body: Record<string, unknown> | undefined;
}

/** CloudClient with a stubbed transport; records every non-GET request. */
function makeCloud(
  handlers: { candidateStatus?: number; eventsStatus?: number; eventsStatusFor?: (path: string) => number | undefined } = {},
) {
  const posts: PostedRequest[] = [];
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'test-key',
    fetchImpl: (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = String(input).replace('http://cloud.test', '');
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        let body: Record<string, unknown> | undefined;
        try {
          body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        } catch {
          body = undefined;
        }
        posts.push({ path, body });
      }
      let status = path.includes('/compaction-candidate') ? (handlers.candidateStatus ?? 200) : 200;
      if (path.endsWith('/events') || path.endsWith('/event')) {
        status = handlers.eventsStatusFor?.(path) ?? handlers.eventsStatus ?? 200;
      }
      return new Response(JSON.stringify({ ok: status === 200, data: { shouldCompact: false } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  return { cloud, posts };
}

function makeCtx(over: Partial<HookResolverContext> = {}): HookResolverContext {
  return {
    agentImUserId: 'u_agent',
    workspaceId: 'ws_1',
    profileId: 'p_1',
    profileName: 'engineer',
    roleTemplateSlug: null,
    conversationId: 'cv_1',
    taskId: 'run_x',
    messageId: null,
    adapterName: 'hermes',
    model: null,
    proxyProvider: null,
    ...over,
  };
}

function makeBody(over: Record<string, unknown> = {}): never {
  return {
    session_id: 'sess_1',
    extra: {
      conversation_history: Array.from({ length: MIN_HISTORY }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i}`,
      })),
    },
    ...over,
  } as never;
}

/** Let the fire-and-forget report settle before asserting. */
async function drain(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('S5 §3.4-3b compaction failure observability', () => {
  it('posts a COMPACTION_FAILED run event when the candidate GET fails', async () => {
    resetMemoryStageCounters();
    const { cloud, posts } = makeCloud({ candidateStatus: 500 });
    const ctx = makeCtx({ conversationId: 'cv_cand' });

    // The hook only polls every Nth turn on a conversation — walk to the Nth.
    for (let i = 0; i < POLL_EVERY_N; i++) {
      await runBackgroundCompaction(makeBody(), ctx, { cloud } as never, 'trace_1');
    }
    await drain();

    const report = posts.find((p) => p.path.endsWith('/events'));
    expect(report).toBeDefined();
    // Run-scoped route: `ctx.taskId` IS the run id (registry canonicalTurnId =
    // wire run id). The task-scoped route answers 400
    // RUN_ID_ON_TASK_ROUTE to this shape, so it must not be the landing target.
    expect(report!.path).toBe(`/api/im/runs/${ctx.taskId}/events`);
    expect(report!.body?.type).toBe('COMPACTION_FAILED');
    expect(report!.body?.payload).toMatchObject({ stage: 'candidate_get', status: 500 });
    // And it did NOT also spray the task route on the happy path.
    expect(posts.some((p) => p.path.includes('/api/im/tasks/'))).toBe(false);

    // Local counter moves too — /healthz `memory.counters` is the same story.
    expect(getMemoryStageCounters().compactionFailed).toBe(1);
  });

  it('retries the task-scoped route when the run route answers 404 (kanban-task id in the same field)', async () => {
    resetMemoryStageCounters();
    // `ctx.taskId` is ambiguous by design: a chat dispatch carries the run id,
    // a kanban-task dispatch carries the task id (release202/09 §3.2). The run
    // route 404s for the latter — one retry, then give up.
    const { cloud, posts } = makeCloud({
      candidateStatus: 500,
      eventsStatusFor: (path) => (path.startsWith('/api/im/runs/') ? 404 : 200),
    });
    const ctx = makeCtx({ conversationId: 'cv_taskid', taskId: 'cmpkanban1234' });

    for (let i = 0; i < POLL_EVERY_N; i++) {
      await runBackgroundCompaction(makeBody(), ctx, { cloud } as never, 'trace_fb');
    }
    await drain();

    expect(posts.map((p) => p.path)).toEqual([
      '/api/im/runs/cmpkanban1234/events',
      '/api/im/tasks/cmpkanban1234/event',
    ]);
    const retry = posts[1]!;
    expect(retry.body?.code).toBe('COMPACTION_FAILED');
    expect(retry.body?.payload).toMatchObject({ stage: 'candidate_get' });
  });

  it('NEGATIVE CONTROL: does not retry the task route when the run route fails for a non-id reason', async () => {
    resetMemoryStageCounters();
    // 403 (identity rejected) is not an id mismatch — retrying a different
    // route would be a different request that the same gate rejects, i.e.
    // pure noise. Only 404 means "wrong id space".
    const { cloud, posts } = makeCloud({
      candidateStatus: 500,
      eventsStatusFor: (path) => (path.startsWith('/api/im/runs/') ? 403 : 200),
    });

    for (let i = 0; i < POLL_EVERY_N; i++) {
      await runBackgroundCompaction(
        makeBody(),
        makeCtx({ conversationId: 'cv_403' }),
        { cloud } as never,
        'trace_403',
      );
    }
    await drain();

    expect(posts.map((p) => p.path)).toEqual(['/api/im/runs/run_x/events']);
    // The failure is still counted locally — the surviving signal when neither
    // route can carry it.
    expect(getMemoryStageCounters().compactionFailed).toBe(1);
  });

  it('does NOT post task events for the normal gates (no conversation / short history / poll gate)', async () => {
    resetMemoryStageCounters();
    const { cloud, posts } = makeCloud();

    // gate 1 — no conversationId resolved for this turn.
    await runBackgroundCompaction(
      makeBody(),
      makeCtx({ conversationId: null }),
      { cloud } as never,
      'trace_g1',
    );

    // gate 2 — history shorter than the compaction floor.
    await runBackgroundCompaction(
      makeBody({ extra: { conversation_history: [{ role: 'user', content: 'hi' }] } }),
      makeCtx({ conversationId: 'cv_short' }),
      { cloud } as never,
      'trace_g2',
    );

    // gate 3 — the every-Nth-turn poll gate (4 turns is below the 5th).
    for (let i = 0; i < POLL_EVERY_N - 1; i++) {
      await runBackgroundCompaction(
        makeBody(),
        makeCtx({ conversationId: 'cv_gate' }),
        { cloud } as never,
        'trace_g3',
      );
    }
    await drain();

    expect(posts).toHaveLength(0);
    expect(getMemoryStageCounters().compactionFailed).toBe(0);
  });

  it('swallows a failing failure-report upload instead of throwing out of the hook', async () => {
    resetMemoryStageCounters();
    // The candidate GET fails normally (HTTP 500 → `ok: false`, no throw), so
    // the hook reaches the report step — and THAT upload blows up. The report
    // is best-effort: it must never turn one failure into two.
    const cloud = {
      request: vi.fn(async (_method: string, path: string) => {
        if (path.includes('/compaction-candidate')) {
          return { ok: false, status: 500, error: { code: 'boom', message: 'candidate down' } };
        }
        throw new Error('event upload failed');
      }),
    };
    const ctx = makeCtx({ conversationId: 'cv_report_upload_fail' });

    for (let i = 0; i < POLL_EVERY_N; i++) {
      await expect(
        runBackgroundCompaction(makeBody(), ctx, { cloud } as never, 'trace_ru'),
      ).resolves.toBeUndefined();
    }
    await drain();

    // The report was attempted (the counter moved) even though it did not land.
    expect(getMemoryStageCounters().compactionFailed).toBeGreaterThanOrEqual(1);
  });
});
