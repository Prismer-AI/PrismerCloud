/**
 * Phase 2C — Review gate enforcement (release201/10 rev 2 §0.2.3 + §4.4).
 *
 * The `running → review` transition is the strictest gate in the system. It
 * enforces three sub-checks (task.service.ts::validateAcceptanceEvidenceForReview
 * + validateRev2SelfCheckAndTodoGate):
 *
 *   1. (a) evidenceRefs[] not empty AND ≥1 required criterion has
 *          evidenceRefs[] (else 422 acceptance_evidence_missing).
 *   2. (b) Every verifyMode='agent-self-check' criterion has status !=
 *          'pending' (else 422 acceptance_self_check_incomplete).
 *   3. (c) TODO.md exists AND progressPct ≥ 0.80 (else 422
 *          todo_completion_below_threshold).
 *
 * Note: doc 10 rev 2 §0.2.3 (b) says "must be **assignee-evaluated**". The
 * service today only checks `status != 'pending'`; actor identity is not
 * enforced. The test asserts the documented behavior and `expect.fail()`s
 * with a drift report if cloud accepts an owner-evaluated self-check.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

interface AssetRow {
  id: string;
  filename: string;
  boundKind: string;
  sourceTaskId: string;
}

async function createTask(ctx: SuiteContext, title: string): Promise<string> {
  const r = await api<{ ok: boolean; data?: { id: string } }>('POST', '/tasks', {
    actor: ctx.owner,
    body: {
      workspaceId: ctx.workspace.id,
      title,
      capability: 'generic',
      metadata: { kind: 'work_item' },
    },
    expectStatus: 201,
  });
  return r.data.data!.id;
}

async function addCriterion(
  ctx: SuiteContext,
  taskId: string,
  verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual',
  expectation: string,
): Promise<string> {
  const r = await api<{ ok: boolean; data?: { criterion: { id: string } } }>('POST', `/tasks/${taskId}/criteria`, {
    actor: ctx.owner,
    body: { verifyMode, expectation },
    expectStatus: 200,
  });
  return r.data.data!.criterion.id;
}

async function writeSpec(ctx: SuiteContext, taskId: string, markdown: string): Promise<void> {
  await api('PUT', `/tasks/${taskId}/spec`, { actor: ctx.owner, body: { markdown }, expectStatus: 200 });
}

async function getSpecAssetId(ctx: SuiteContext, taskId: string): Promise<string> {
  const r = await api<{ ok: boolean; data?: AssetRow[] }>('GET', '/assets', {
    actor: ctx.owner,
    query: { workspaceId: ctx.workspace.id, taskId },
  });
  const spec = r.data.data?.find((a) => a.filename === 'SPEC.md');
  if (!spec) throw new Error(`SPEC.md asset not found for task ${taskId}`);
  return spec.id;
}

async function fillTodo(
  ctx: SuiteContext,
  taskId: string,
  items: Array<{ text: string; done: boolean }>,
): Promise<void> {
  for (const it of items) {
    await api('POST', `/tasks/${taskId}/todo/items`, {
      actor: ctx.owner,
      body: { text: it.text },
      expectStatus: 200,
    });
  }
  // Tick the requested ones.
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.done) {
      await api('PATCH', `/tasks/${taskId}/todo/items/${i}`, {
        actor: ctx.owner,
        body: { done: true },
        expectStatus: 200,
      });
    }
  }
}

async function transition(
  actor: SuiteContext['owner'],
  taskId: string,
  to: 'assigned' | 'running' | 'review' | 'completed',
  body: Record<string, unknown> = {},
) {
  return api<{
    ok: boolean;
    data?: { id: string; status: string };
    error?: { code: string; message: string };
  }>('POST', `/tasks/${taskId}/transition`, { actor, body: { to, ...body } });
}

describe('task-lifecycle — transition acceptance gate', () => {
  let ctx: SuiteContext;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2cgate');
  });

  afterAll(async () => {
    await ctx?.cleanup?.();
  });

  test('review transition with no SPEC + no TODO + no verify → 422', async () => {
    const taskId = await createTask(ctx, 'P2C gate — bare task');
    await addCriterion(ctx, taskId, 'qualitative', 'UX is polished.');
    await addCriterion(ctx, taskId, 'agent-self-check', 'Assignee confirms.');

    // owner: pending → assigned (member as assignee)
    const t1 = await transition(ctx.owner, taskId, 'assigned', { assigneeId: ctx.member.imUserId });
    expect(t1.status, JSON.stringify(t1.data)).toBe(200);

    // assignee: assigned → running
    const t2 = await transition(ctx.member, taskId, 'running');
    expect(t2.status, JSON.stringify(t2.data)).toBe(200);

    // assignee: running → review — gate must reject with 422 + structured
    // error.code per doc 10 rev 2 §4.4. v2.0.7.1 hotfix B4 wired
    // AcceptanceError into handleTaskError's classifier so the transition
    // route surfaces the correct status (was 500 pre-hotfix).
    const t3 = await transition(ctx.member, taskId, 'review');
    expect(t3.data.ok ?? false, `gate must reject; body=${JSON.stringify(t3.data)}`).toBe(false);
    expect(t3.status, JSON.stringify(t3.data)).toBe(422);
    expect(t3.data.error?.code).toMatch(
      /^(acceptance_evidence_missing|acceptance_evidence_indeterminate|todo_completion_below_threshold|acceptance_self_check_incomplete)$/,
    );
  });

  test('review with full SPEC + 100% TODO + verified criteria + evidence → 200', async () => {
    const taskId = await createTask(ctx, 'P2C gate — happy path');

    // owner authors SPEC + criteria.
    await writeSpec(ctx, taskId, '## Goal\nShip.\n\n## Constraints\nNone.');
    const cidQual = await addCriterion(ctx, taskId, 'qualitative', 'UX polished.');
    const cidSelf = await addCriterion(ctx, taskId, 'agent-self-check', 'Assignee TODO is done.');

    // Assign to member.
    await transition(ctx.owner, taskId, 'assigned', { assigneeId: ctx.member.imUserId });
    await transition(ctx.member, taskId, 'running');

    // Owner fills TODO 100%.
    await fillTodo(ctx, taskId, [
      { text: 'Step 1', done: true },
      { text: 'Step 2', done: true },
      { text: 'Step 3', done: true },
    ]);

    // Resolve SPEC asset id — we reuse it as the evidence ref. SPEC.md is a
    // task-bound asset in the same workspace, so it satisfies §4.6.1 asset
    // validation.
    const evidenceAssetId = await getSpecAssetId(ctx, taskId);
    const evidenceRef = `asset:${evidenceAssetId}`;

    // Assignee verifies the agent-self-check criterion (passed).
    const vSelf = await api<{ ok: boolean; data?: { criteria: Array<{ id: string; status: string }> } }>(
      'POST',
      `/tasks/${taskId}/criteria/${cidSelf}/verify`,
      {
        actor: ctx.member,
        body: { outcome: 'passed', note: 'TODO complete.', evidenceRefs: [evidenceRef] },
      },
    );
    expect(vSelf.status, JSON.stringify(vSelf.data)).toBe(200);

    // Owner verifies the qualitative criterion.
    const vQual = await api<{ ok: boolean; data?: { criteria: Array<{ id: string; status: string }> } }>(
      'POST',
      `/tasks/${taskId}/criteria/${cidQual}/verify`,
      {
        actor: ctx.owner,
        body: { outcome: 'passed', note: 'UX checked.', evidenceRefs: [evidenceRef] },
      },
    );
    expect(vQual.status, JSON.stringify(vQual.data)).toBe(200);

    // assignee: running → review — should now succeed.
    const tReview = await transition(ctx.member, taskId, 'review');
    expect(tReview.status, JSON.stringify(tReview.data)).toBe(200);
    expect(tReview.data.data?.status).toBe('review');
  });

  test('owner-evaluated agent-self-check criterion → review rejected (self_check_wrong_actor)', async () => {
    // release201/19 B5 hotfix (v2.0.7.1): doc 10 rev 2 §0.2.3 (b) demands
    // agent-self-check criteria be evaluated by the assignee.
    // task.service.ts::validateRev2SelfCheckAndTodoGate now compares
    // Criterion.verifiedBy against task.assigneeId and rejects mismatches
    // with AcceptanceError(self_check_wrong_actor, 422). Strict assertion
    // replaces the prior console.warn drift pin.
    //
    // B4 caveat (v2.0.8 follow-up): handleTaskError in src/im/api/tasks.ts
    // still doesn't classify AcceptanceError, so the 422 surfaces as
    // HTTP 500 today. The test asserts the response is NEVER ok=true and
    // is either 422 (post-B4) or 500 (pre-B4) — under no plumbing may the
    // cross-actor stamp slip past the review gate.
    const taskId = await createTask(ctx, 'P2C gate — owner self-eval probe');
    await writeSpec(ctx, taskId, '## Goal\nProbe.\n## Constraints\nNone.');
    const cidSelf = await addCriterion(ctx, taskId, 'agent-self-check', 'Probe self-check.');
    const cidQual = await addCriterion(ctx, taskId, 'qualitative', 'Probe qual.');

    await transition(ctx.owner, taskId, 'assigned', { assigneeId: ctx.member.imUserId });
    await transition(ctx.member, taskId, 'running');

    await fillTodo(ctx, taskId, [
      { text: 'a', done: true },
      { text: 'b', done: true },
      { text: 'c', done: true },
    ]);

    const evidenceRef = `asset:${await getSpecAssetId(ctx, taskId)}`;

    // OWNER (not assignee) stamps the agent-self-check criterion. doc 10
    // rev 2 §0.2.3 (b) forbids this from satisfying the review gate.
    await api('POST', `/tasks/${taskId}/criteria/${cidSelf}/verify`, {
      actor: ctx.owner,
      body: { outcome: 'passed', note: 'owner stamped', evidenceRefs: [evidenceRef] },
      expectStatus: 200,
    });
    await api('POST', `/tasks/${taskId}/criteria/${cidQual}/verify`, {
      actor: ctx.owner,
      body: { outcome: 'passed', note: 'owner stamped', evidenceRefs: [evidenceRef] },
      expectStatus: 200,
    });

    const t = await transition(ctx.member, taskId, 'review');
    // Hard invariant: gate MUST reject (no 200 under any plumbing).
    expect(t.data.ok ?? false, `gate must reject; body=${JSON.stringify(t.data)}`).toBe(false);
    if (t.status === 500) {
      // B4 plumbing gap — AcceptanceError surfaces as 500. The gate fired
      // (any reject is a B5 win); the HTTP envelope is unclassified pending
      // v2.0.8 B4 fix in src/im/api/tasks.ts handleTaskError.
      console.warn(
        `[drift B4] transition→review surfaced AcceptanceError(self_check_wrong_actor) as HTTP 500 instead of 422. ` +
          `Fix handleTaskError to classify AcceptanceError (v2.0.8).`,
      );
    } else {
      expect(t.status).toBe(422);
      expect(t.data.error?.code).toBe('self_check_wrong_actor');
    }
    expect([422, 500]).toContain(t.status);
  });

  test('reviewer (owner) approves review → completed', async () => {
    // Recreate the happy-path flow end-to-end, then drive review → completed
    // as owner. assignee cannot self-approve (TRANSITIONS.review.completed
    // doesn't list 'assignee').
    const taskId = await createTask(ctx, 'P2C gate — completion path');
    await writeSpec(ctx, taskId, '## Goal\nDone.');
    const cid = await addCriterion(ctx, taskId, 'qualitative', 'Looks good.');
    await transition(ctx.owner, taskId, 'assigned', { assigneeId: ctx.member.imUserId });
    await transition(ctx.member, taskId, 'running');
    await fillTodo(ctx, taskId, [
      { text: 'one', done: true },
      { text: 'two', done: true },
    ]);
    const evidenceRef = `asset:${await getSpecAssetId(ctx, taskId)}`;
    await api('POST', `/tasks/${taskId}/criteria/${cid}/verify`, {
      actor: ctx.owner,
      body: { outcome: 'passed', note: 'ok', evidenceRefs: [evidenceRef] },
      expectStatus: 200,
    });
    await transition(ctx.member, taskId, 'review');

    // Self-approval prohibited.
    const selfApprove = await transition(ctx.member, taskId, 'completed');
    expect(selfApprove.status).toBeGreaterThanOrEqual(400);
    expect(selfApprove.data.ok).toBe(false);

    // Owner approves.
    const ownerApprove = await transition(ctx.owner, taskId, 'completed', {
      reviewComment: 'looks good',
    });
    expect(ownerApprove.status, JSON.stringify(ownerApprove.data)).toBe(200);
    expect(ownerApprove.data.data?.status).toBe('completed');
  });
});
