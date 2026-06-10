/**
 * Phase 2C — Verifier dispatch on `running → review` (release201/10 rev 2 §4.2 + §4.4).
 *
 * When a task enters `review`, cloud dispatches `task.verify.requested` to
 * each criterion's verifier:
 *   - verifyMode='qualitative'|'quantitative' → push to
 *     criterion.verifierAgentId ?? task.creatorId. Both NULL → manual fallback.
 *   - verifyMode='agent-self-check' → SKIP (assignee already self-evaluated).
 *   - verifyMode='manual' → SKIP (reviewer interacts via ApprovalCard).
 *
 * The push has 3 fan-out lanes:
 *   1. eventBusService.publish — SSE for connected verifier
 *   2. rooms.sendToUser       — WS for online verifier
 *   3. syncService.writeEvent — IMSyncEvent row for offline pickup via GET /sync
 *
 * We assert on lane 3 (durable sync log) because it's the one we can probe
 * deterministically over plain HTTP from a test process.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

interface SyncEvent {
  seq: number;
  type: string;
  data: { taskId?: string; criterionId?: string; verifyMode?: string; verifierAgentId?: string };
  conversationId: string | null;
  at: string;
}

async function pollSyncForEvent(
  actor: SuiteContext['owner'],
  predicate: (e: SyncEvent) => boolean,
  opts: { since?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<SyncEvent | null> {
  const since = opts.since ?? 0;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  let cursor = since;
  while (Date.now() < deadline) {
    const r = await api<{
      ok: boolean;
      data?: { events: SyncEvent[]; cursor: number; hasMore: boolean };
    }>('GET', '/sync', { actor, query: { since: cursor, limit: 200 } });
    if (r.status === 200 && r.data.ok) {
      const events = r.data.data?.events ?? [];
      for (const e of events) {
        if (predicate(e)) return e;
      }
      if (events.length > 0) cursor = r.data.data!.cursor;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return null;
}

async function createTaskFull(
  ctx: SuiteContext,
  title: string,
  criteria: Array<{
    verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
    expectation: string;
    verifierAgentId?: string;
  }>,
): Promise<{ taskId: string; criterionIds: string[]; evidenceRef: string }> {
  // Create task (creator = owner → fallback verifier = owner).
  const created = await api<{ ok: boolean; data?: { id: string } }>('POST', '/tasks', {
    actor: ctx.owner,
    body: {
      workspaceId: ctx.workspace.id,
      title,
      capability: 'generic',
      metadata: { kind: 'work_item' },
    },
    expectStatus: 201,
  });
  const taskId = created.data.data!.id;

  // SPEC.md so we have an evidence asset and the gate clears.
  await api('PUT', `/tasks/${taskId}/spec`, {
    actor: ctx.owner,
    body: { markdown: '## Goal\nVerify dispatch.\n## Constraints\nNone.' },
    expectStatus: 200,
  });
  const assets = await api<{
    ok: boolean;
    data?: Array<{ id: string; filename: string }>;
  }>('GET', '/assets', { actor: ctx.owner, query: { workspaceId: ctx.workspace.id, taskId } });
  const spec = assets.data.data?.find((a) => a.filename === 'SPEC.md');
  if (!spec) throw new Error('SPEC.md asset not created');
  const evidenceRef = `asset:${spec.id}`;

  // Create criteria with evidenceRefs baked in at creation. NOTE: PATCH
  // /criteria/:cid with only `evidenceRefs` currently *wipes* verifierAgentId
  // because the endpoint normalises missing fields to `undefined` and the
  // service spread overwrites the prior value. Tracking the drift in the
  // gate test; here we just sidestep it by setting refs at create time.
  const criterionIds: string[] = [];
  for (const c of criteria) {
    const body: Record<string, unknown> = {
      verifyMode: c.verifyMode,
      expectation: c.expectation,
      evidenceRefs: [evidenceRef],
    };
    if (c.verifierAgentId !== undefined) body.verifierAgentId = c.verifierAgentId;
    const r = await api<{ ok: boolean; data?: { criterion: { id: string } } }>('POST', `/tasks/${taskId}/criteria`, {
      actor: ctx.owner,
      body,
      expectStatus: 200,
    });
    criterionIds.push(r.data.data!.criterion.id);
  }

  // pending → assigned → running.
  await api('POST', `/tasks/${taskId}/transition`, {
    actor: ctx.owner,
    body: { to: 'assigned', assigneeId: ctx.member.imUserId },
    expectStatus: 200,
  });
  await api('POST', `/tasks/${taskId}/transition`, {
    actor: ctx.member,
    body: { to: 'running' },
    expectStatus: 200,
  });

  // Fill TODO 100% (gate (c)).
  for (const text of ['s1', 's2']) {
    await api('POST', `/tasks/${taskId}/todo/items`, {
      actor: ctx.owner,
      body: { text },
      expectStatus: 200,
    });
  }
  await api('PATCH', `/tasks/${taskId}/todo/items/0`, {
    actor: ctx.owner,
    body: { done: true },
    expectStatus: 200,
  });
  await api('PATCH', `/tasks/${taskId}/todo/items/1`, {
    actor: ctx.owner,
    body: { done: true },
    expectStatus: 200,
  });

  // Pre-resolve agent-self-check criteria so gate (b) clears. Pre-stamp via
  // assignee actor — closest to doc 10 rev 2 intent.
  for (let i = 0; i < criteria.length; i++) {
    if (criteria[i]!.verifyMode === 'agent-self-check') {
      await api('POST', `/tasks/${taskId}/criteria/${criterionIds[i]!}/verify`, {
        actor: ctx.member,
        body: { outcome: 'passed', note: 'self-checked' },
        expectStatus: 200,
      });
    }
  }

  return { taskId, criterionIds, evidenceRef };
}

describe('task-lifecycle — verifier dispatch on review entry', () => {
  let ctx: SuiteContext;
  let baselineSince: number;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2cvd');
    // Capture current sync cursor so per-test polls only inspect *new* events.
    const r = await api<{ ok: boolean; data?: { cursor: number } }>('GET', '/sync', {
      actor: ctx.owner,
      query: { since: 0, limit: 500 },
    });
    baselineSince = r.data.data?.cursor ?? 0;
  });

  afterAll(async () => {
    await ctx?.cleanup?.();
  });

  test('dispatch to explicit verifierAgentId on review entry', async () => {
    // verifier = member (different from creator/owner).
    const { taskId, criterionIds } = await createTaskFull(ctx, 'P2C verifier — explicit', [
      { verifyMode: 'qualitative', expectation: 'looks good', verifierAgentId: ctx.member.imUserId },
    ]);

    // running → review.
    const t = await api<{ ok: boolean; data?: { status: string }; error?: { code: string } }>(
      'POST',
      `/tasks/${taskId}/transition`,
      { actor: ctx.member, body: { to: 'review' } },
    );
    expect(t.status, JSON.stringify(t.data)).toBe(200);

    // member is the verifier, so they should see the event via GET /sync.
    const event = await pollSyncForEvent(
      ctx.member,
      (e) => e.type === 'task.verify.requested' && e.data.taskId === taskId && e.data.criterionId === criterionIds[0],
      { timeoutMs: 6000 },
    );
    if (!event) {
      // Drift: event may have been emitted only via SSE/WS and not the durable
      // sync log. Doc 10 rev 2 §6.5 lists `task.verify.requested` as an SSE
      // event; release201/10 §5.2 dispatch service writes the sync log too.
      // Surface the gap rather than silently passing.
      expect.fail(
        `no task.verify.requested found in GET /sync for verifier ${ctx.member.imUserId} (task ${taskId}, criterion ${criterionIds[0]}). Lane 3 (syncService.writeEvent) appears not to be wired.`,
      );
    }
    expect(event!.data.verifierAgentId).toBe(ctx.member.imUserId);
    expect(event!.data.verifyMode).toBe('qualitative');
  });

  test('fallback to task.creatorId when verifierAgentId is null', async () => {
    // No explicit verifier → falls back to creator (owner).
    const { taskId, criterionIds } = await createTaskFull(ctx, 'P2C verifier — fallback', [
      { verifyMode: 'quantitative', expectation: 'p95 < 200ms' /* no verifierAgentId */ },
    ]);

    const t = await api<{ ok: boolean; data?: { status: string } }>('POST', `/tasks/${taskId}/transition`, {
      actor: ctx.member,
      body: { to: 'review' },
    });
    expect(t.status, JSON.stringify(t.data)).toBe(200);

    const event = await pollSyncForEvent(
      ctx.owner,
      (e) => e.type === 'task.verify.requested' && e.data.taskId === taskId && e.data.criterionId === criterionIds[0],
      { since: baselineSince, timeoutMs: 6000 },
    );
    if (!event) {
      expect.fail(
        `no fallback dispatch to creator (owner ${ctx.owner.imUserId}) found in GET /sync (task ${taskId}). VerifierDispatchService.fallback path may be silent on lane 3.`,
      );
    }
    expect(event!.data.verifierAgentId).toBe(ctx.owner.imUserId);
  });

  test('skip dispatch for agent-self-check + manual criteria', async () => {
    // Only self-check + manual → 0 dispatches.
    const { taskId, criterionIds } = await createTaskFull(ctx, 'P2C verifier — skip', [
      { verifyMode: 'agent-self-check', expectation: 'self-check only' },
      { verifyMode: 'manual', expectation: 'manual only' },
    ]);

    const t = await api<{ ok: boolean; data?: { status: string } }>('POST', `/tasks/${taskId}/transition`, {
      actor: ctx.member,
      body: { to: 'review' },
    });
    expect(t.status, JSON.stringify(t.data)).toBe(200);

    // No task.verify.requested event should appear for this taskId on either
    // member or owner's sync stream within the short poll window.
    const memberEv = await pollSyncForEvent(
      ctx.member,
      (e) =>
        e.type === 'task.verify.requested' &&
        e.data.taskId === taskId &&
        (e.data.criterionId === criterionIds[0] || e.data.criterionId === criterionIds[1]),
      { timeoutMs: 2500 },
    );
    const ownerEv = await pollSyncForEvent(
      ctx.owner,
      (e) =>
        e.type === 'task.verify.requested' &&
        e.data.taskId === taskId &&
        (e.data.criterionId === criterionIds[0] || e.data.criterionId === criterionIds[1]),
      { since: baselineSince, timeoutMs: 2500 },
    );
    expect(memberEv, 'agent-self-check / manual must not trigger dispatch').toBeNull();
    expect(ownerEv, 'agent-self-check / manual must not trigger dispatch').toBeNull();
  });

  test('mixed criteria: dispatch only the qualitative one', async () => {
    const { taskId, criterionIds } = await createTaskFull(ctx, 'P2C verifier — mixed', [
      { verifyMode: 'qualitative', expectation: 'mix qual', verifierAgentId: ctx.member.imUserId },
      { verifyMode: 'agent-self-check', expectation: 'mix self' },
      { verifyMode: 'manual', expectation: 'mix manual' },
    ]);
    const t = await api('POST', `/tasks/${taskId}/transition`, {
      actor: ctx.member,
      body: { to: 'review' },
    });
    expect(t.status, JSON.stringify(t.data)).toBe(200);

    const qual = await pollSyncForEvent(
      ctx.member,
      (e) => e.type === 'task.verify.requested' && e.data.taskId === taskId && e.data.criterionId === criterionIds[0],
      { timeoutMs: 6000 },
    );
    if (!qual) {
      expect.fail(
        `expected dispatch for qualitative criterion ${criterionIds[0]} (task ${taskId}) to verifier ${ctx.member.imUserId}; nothing seen on lane 3.`,
      );
    }
    // No dispatch for the other two.
    const self = await pollSyncForEvent(
      ctx.member,
      (e) => e.type === 'task.verify.requested' && e.data.taskId === taskId && e.data.criterionId === criterionIds[1],
      { timeoutMs: 1500 },
    );
    const manual = await pollSyncForEvent(
      ctx.member,
      (e) => e.type === 'task.verify.requested' && e.data.taskId === taskId && e.data.criterionId === criterionIds[2],
      { timeoutMs: 1500 },
    );
    expect(self).toBeNull();
    expect(manual).toBeNull();
  });
});
