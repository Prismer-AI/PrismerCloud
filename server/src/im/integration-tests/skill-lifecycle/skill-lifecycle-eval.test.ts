/**
 * Phase 2D — skill lifecycle eval session protocol (doc 08 §3).
 * release201/08-skill-lifecycle-sop.md §3.2 daemon-side EvalSessionRunner +
 * §10 endpoints (POST /:id/eval/runs, GET /:id/eval/runs/:runId).
 *
 * No daemon is started — cloud writes IMSkillEvalRun rows with status='queued'
 * and waits for a daemon to pick them up. This test verifies ONLY the cloud
 * endpoint contracts:
 *   - POST /skills/:id/eval/runs creates a queued run
 *   - GET  /skills/:id/eval/runs/:runId surfaces run state + progress fields
 *   - Invalid empty testCases → 400
 *   - SSE emit on startEvalRun (release201/08 §10.6: skill.authoring.smoke_started
 *     fires as the first eval-side event; skill.eval.progress is only emitted
 *     for in-flight per-case updates — confirm via /sync/stream subscriber)
 *
 * Runs against live `npm run dev` at 127.0.0.1:3000. No mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, subscribeSSE } from '../_helpers';
import type { SSEEvent } from '../_helpers';
import { buildDraftBody, uniqueSlug } from './_skill-fixtures';

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string };

interface PromoteResult {
  skill: { id: string; lifecycleStage: string; status: string };
  taskId: string | null;
}

interface DraftCreated {
  id: string;
  slug: string;
  reviewTaskId: string | null;
}

interface EvalRunSummary {
  runId: string;
  skillId: string;
  status: 'queued' | 'running' | 'finished' | 'aborted' | 'error';
  passCount: number;
  failCount: number;
  testCases: Array<{ id: string; input: string }>;
  results?: unknown[];
  daemonId?: string | null;
  agentTraceUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

async function newDraftInEval(
  owner: { imUserId: string; token: string },
  workspaceId: string,
  slugPrefix = 'eval',
): Promise<DraftCreated> {
  const slug = uniqueSlug(slugPrefix);
  const body = buildDraftBody({ slug, workspaceId, ownerAgentId: owner.imUserId });
  const r = await api<Envelope<DraftCreated>>('POST', '/skills/draft', { actor: owner as any, body });
  expect(r.status).toBe(201);
  const draft = r.data.data!;
  // promote draft → eval so /eval/runs is accepted by the service (it also
  // accepts draft via auto-promote, but be explicit).
  const promote = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
    actor: owner as any,
    body: { to: 'eval' },
  });
  expect(promote.status).toBe(200);
  expect(promote.data.data!.skill.lifecycleStage).toBe('eval');
  return draft;
}

describe('skill-lifecycle eval session (doc 08 §3)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2dev');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('POST /skills/:id/eval/runs creates a queued run + returns runId/status fields', async () => {
    const draft = await newDraftInEval(ctx.owner, ctx.workspace.id);
    const testCases = [
      { id: 'tc1', input: 'first prompt', timeout_ms: 5000 },
      { id: 'tc2', input: 'second prompt', timeout_ms: 5000 },
    ];
    const r = await api<Envelope<EvalRunSummary>>('POST', `/skills/${draft.id}/eval/runs`, {
      actor: ctx.owner,
      body: { testCases, allowlistBuiltins: ['tasks'] },
    });
    // The endpoint returns 202 (Accepted) per skills-lifecycle.ts:85.
    expect(r.status).toBe(202);
    expect(r.data.ok).toBe(true);
    const run = r.data.data!;
    expect(run.runId).toMatch(/^er_/);
    expect(run.skillId).toBe(draft.id);
    expect(run.status).toBe('queued');
    expect(run.passCount).toBe(0);
    expect(run.failCount).toBe(0);
    expect(run.testCases).toHaveLength(2);
  });

  test('GET /skills/:id/eval/runs/:runId returns run summary; status stays queued without daemon', async () => {
    const draft = await newDraftInEval(ctx.owner, ctx.workspace.id, 'evalget');
    const start = await api<Envelope<EvalRunSummary>>('POST', `/skills/${draft.id}/eval/runs`, {
      actor: ctx.owner,
      body: { testCases: [{ id: 'tc-only', input: 'hello', timeout_ms: 5000 }] },
    });
    expect(start.status).toBe(202);
    const runId = start.data.data!.runId;

    const get = await api<Envelope<EvalRunSummary>>('GET', `/skills/${draft.id}/eval/runs/${runId}`, {
      actor: ctx.owner,
    });
    expect(get.status).toBe(200);
    expect(get.data.ok).toBe(true);
    expect(get.data.data!.runId).toBe(runId);
    // Without a daemon picking it up, status MUST stay 'queued'.
    expect(get.data.data!.status).toBe('queued');
    expect(get.data.data!.startedAt).toBeNull();
    expect(get.data.data!.finishedAt).toBeNull();
    expect(get.data.data!.daemonId).toBeNull();
  });

  test('POST /skills/:id/eval/runs with empty testCases → 400 no_test_cases', async () => {
    const draft = await newDraftInEval(ctx.owner, ctx.workspace.id, 'evalbad');
    const r = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/eval/runs`, {
      actor: ctx.owner,
      body: { testCases: [] },
    });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    if (r.data.code) {
      expect(r.data.code).toBe('no_test_cases');
    }
  });

  test('POST /skills/:id/eval/runs with missing testCases → 400', async () => {
    const draft = await newDraftInEval(ctx.owner, ctx.workspace.id, 'evalmissing');
    const r = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/eval/runs`, {
      actor: ctx.owner,
      body: {},
    });
    expect(r.status).toBe(400);
  });

  test('eval/runs startup emits skill.authoring.smoke_started SSE (no skill.eval.progress on queue)', async () => {
    const draft = await newDraftInEval(ctx.owner, ctx.workspace.id, 'evalsse');

    // Subscribe to the sync stream BEFORE invoking startEvalRun.
    const events: SSEEvent[] = [];
    const ctrl = new AbortController();
    const subPromise = subscribeSSE('/sync/stream', ctx.owner, {
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    });

    // Give the SSE subscriber a moment to connect before triggering the
    // server-side emit so we don't race past the snapshot phase.
    await new Promise((res) => setTimeout(res, 800));

    const start = await api<Envelope<EvalRunSummary>>('POST', `/skills/${draft.id}/eval/runs`, {
      actor: ctx.owner,
      body: { testCases: [{ id: 'tc1', input: 'hello' }] },
    });
    expect(start.status).toBe(202);
    const runId = start.data.data!.runId;

    // Allow ~1.5s for the lifecycle event to fan out via SyncService.
    await new Promise((res) => setTimeout(res, 1500));
    ctrl.abort();
    await subPromise.catch(() => undefined);

    // sync-stream.ts envelope shape: { event: 'sync', data: { type, data: <real-payload>, seq, ... } }
    // Real type lives at envelope.data.type; the payload SkillLifecycleService
    // wrote is envelope.data.data (sync.service.writeEvent passes payload as
    // `data`, JSON.parse'd at publish time).
    const skillEvents = events
      .map((e) => {
        const outer = e.data as Record<string, unknown> | string | undefined;
        if (!outer || typeof outer !== 'object') return null;
        const type = (outer.type as string | undefined) ?? '';
        const inner = (outer.data as Record<string, unknown> | undefined) ?? {};
        return { type, payload: inner };
      })
      .filter((x): x is { type: string; payload: Record<string, unknown> } => Boolean(x))
      .filter(({ type, payload }) => {
        if (!type.startsWith('skill.')) return false;
        const skillId =
          (payload._skillId as string | undefined) ??
          (payload.skillId as string | undefined) ??
          (payload.draftId as string | undefined);
        return skillId === draft.id || payload.runId === runId;
      });

    const allSkillTypes = events
      .map((e) => (e.data as any)?.type as string | undefined)
      .filter((t): t is string => Boolean(t && t.startsWith('skill.')));

    // Per release201/08 §10.6 + skill-lifecycle.service.ts:500, startEvalRun
    // emits `skill.authoring.smoke_started`. Initial queue emits do NOT
    // include `skill.eval.progress` (that's per-case progress, emitted from
    // emitEvalProgress which the daemon drives).
    const smokeStarted = skillEvents.find((d) => d.type === 'skill.authoring.smoke_started');
    if (!smokeStarted) {
      console.warn(
        `[debug] received ${events.length} envelopes; ${skillEvents.length} matching this draft. All skill.* types seen: ${allSkillTypes.join(', ') || '(none)'}.`,
      );
      expect.fail(
        '[doc-drift] startEvalRun did not propagate skill.authoring.smoke_started SSE to the owner (workspace-owner recipient scoping)',
      );
    }
    // No skill.eval.progress should fire on queue.
    const progress = skillEvents.find((d) => d.type === 'skill.eval.progress');
    expect(progress, 'skill.eval.progress should only fire per-case (daemon driven), not at queue').toBeUndefined();
  }, 20_000);
});
