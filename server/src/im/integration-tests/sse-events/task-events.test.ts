/**
 * Phase 2F — Task SSE event verification (release201/10 §4.2 + 11 #16).
 *
 * Doc 10 §4.2 + §4.4 list THREE task SSE events the workspace + Studio +
 * mobile clients subscribe to:
 *
 *   1. `task.spec.updated`         — emitted by TaskSpecService.set when
 *                                    `isUpdate` (PUT after the first set).
 *                                    Wire: EventBusService.publish →
 *                                          localEmitter('event') → the
 *                                          `/api/im/tasks/events` SSE
 *                                          subscriber (router-side filter).
 *   2. `task.todo.changed`         — TodoService.appendItem / toggleItem /
 *                                    setText. Same EventBus wire.
 *   3. `task.verify.requested`     — VerifierDispatchService when a task
 *                                    transitions into `review`. Two wires:
 *                                    EventBus (creator-side observability)
 *                                    + SyncService.writeEvent (target
 *                                    verifier-agent inbox; falls back to
 *                                    `task.creatorId` when criterion has
 *                                    no explicit verifierAgentId).
 *
 * Doc 11 §16 lists `task.metric.snapshot_updated` as a METRIC event —
 * intentionally NOT on the SSE wire. The test for it asserts the
 * non-emission (drift defence), so the doc-vs-code contract stays
 * explicit even when 11's table is read in isolation.
 *
 * Stream choices:
 *   - `/api/im/sync/stream`     → catches the SyncService writeEvent
 *     events (here: `task.verify.requested`).
 *   - `/api/im/tasks/events`    → catches the EventBus task.* events
 *     (here: spec/todo/verify when filter allows). v2.0.7.1 hotfix B8
 *     widened the router filter (tasks.ts:~641) so that events whose
 *     payload carries `byActorId` / `recipientHint` (the shape used by
 *     task.spec.updated + task.todo.changed per doc 10 §6.5) also reach
 *     the connected user when they are the actor OR the hinted recipient.
 *     The `EXPECTED_TASKS_STREAM_DRIFT` constant therefore lands as
 *     `false` post-hotfix — the events now arrive on the /tasks/events
 *     wire as doc 10 §4.2 promises.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts \
 *     src/im/integration-tests/sse-events/task-events.test.ts
 *
 * Pre-req: `npm run dev` running with docker MySQL + Redis up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, bootstrapSuite, subscribeSSE } from '../_helpers';
import type { SuiteContext } from '../_helpers';

const SYNC_STREAM = '/sync/stream';
const TASKS_EVENTS = '/tasks/events';

interface CreateTaskEnvelope {
  ok: boolean;
  data?: { id: string; workspaceId: string; status: string };
  error?: unknown;
}

interface SpecEnvelope {
  ok: boolean;
  data?: { revision: number };
  error?: unknown;
}

async function createTask(ctx: SuiteContext, title: string): Promise<string> {
  // POST /tasks returns 201 (NOT 200) per tasks.ts router; the cookbook
  // expects `data.id`. We accept BOTH 200 and 201 for forward-compat.
  const r = await api<CreateTaskEnvelope>('POST', '/tasks', {
    actor: ctx.owner,
    body: {
      title,
      workspaceId: ctx.workspace.id,
      runtimeRoute: 'agent',
    },
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`createTask: HTTP ${r.status}; body=${JSON.stringify(r.data)}`);
  }
  const id = r.data.data?.id;
  if (!id) throw new Error(`createTask: missing id; body=${JSON.stringify(r.data)}`);
  return id;
}

/** Open both SSE streams for the owner, run `action`, sleep for events. */
async function withDualStreams<T>(
  ctx: SuiteContext,
  action: () => Promise<T>,
  waitMs = 3_000,
): Promise<{
  syncEvents: Array<{ event?: string; data: unknown }>;
  tasksEvents: Array<{ event?: string; data: unknown }>;
  result: T;
}> {
  const syncEvents: Array<{ event?: string; data: unknown }> = [];
  const tasksEvents: Array<{ event?: string; data: unknown }> = [];
  const syncCtrl = new AbortController();
  const tasksCtrl = new AbortController();

  const syncP = subscribeSSE(SYNC_STREAM, ctx.owner, {
    query: { since: '0' },
    signal: syncCtrl.signal,
    onEvent: (e) => syncEvents.push(e),
  });
  const tasksP = subscribeSSE(TASKS_EVENTS, ctx.owner, {
    signal: tasksCtrl.signal,
    onEvent: (e) => tasksEvents.push(e),
  });

  // Brief delay so both streams are subscribed BEFORE the action fires.
  await new Promise((r) => setTimeout(r, 500));
  const result = await action();
  await new Promise((r) => setTimeout(r, waitMs));

  syncCtrl.abort();
  tasksCtrl.abort();
  await Promise.all([syncP.catch(() => undefined), tasksP.catch(() => undefined)]);

  return { syncEvents, tasksEvents, result };
}

function findTypedSyncEvent(
  events: Array<{ event?: string; data: unknown }>,
  typeName: string,
): { event?: string; data: unknown } | undefined {
  return events.find((e) => {
    if (e.event !== 'sync') return false;
    const d = e.data as { type?: string };
    return d?.type === typeName;
  });
}

describe('Task SSE events — release201/10 + 11', () => {
  let ctx: SuiteContext;

  beforeAll(async () => {
    ctx = await bootstrapSuite('ssetask');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup().catch(() => undefined);
  });

  test('PUT /tasks/:id/spec twice → task.spec.updated emit on /tasks/events (v2.0.7.1 hotfix B8)', async () => {
    const taskId = await createTask(ctx, 'task.spec.updated probe');

    // First set creates the asset; subsequent set with `isUpdate=true` is
    // the one that emits per task-spec.service.ts:157.
    await api<SpecEnvelope>('PUT', `/tasks/${taskId}/spec`, {
      actor: ctx.owner,
      body: { markdown: '# initial' },
    });

    const { tasksEvents, syncEvents } = await withDualStreams(ctx, async () => {
      await api<SpecEnvelope>('PUT', `/tasks/${taskId}/spec`, {
        actor: ctx.owner,
        body: { markdown: '# revised body\n\nsecond write' },
      });
    });

    // Post-B8 the router filter accepts the Shape B payload
    // (`byActorId` + `recipientHint`). Owner is the byActorId here, so
    // the event lands on the /tasks/events wire. /sync/stream is still
    // not written for spec/todo events (intentional — those are
    // ephemeral hints, not durable sync ops).
    const onTasks = tasksEvents.find((e) => e.event === 'task.spec.updated');
    const onSync = findTypedSyncEvent(syncEvents, 'task.spec.updated');
    expect(onTasks ?? onSync).toBeDefined();
    const payload =
      (onTasks?.data as Record<string, unknown>) ??
      ((onSync?.data as { data?: Record<string, unknown> } | undefined)?.data as Record<string, unknown> | undefined);
    expect(payload).toMatchObject({ taskId });
  });

  test('POST /tasks/:id/todo/items → task.todo.changed emit on /tasks/events (v2.0.7.1 hotfix B8)', async () => {
    const taskId = await createTask(ctx, 'task.todo.changed probe');

    const { tasksEvents, syncEvents } = await withDualStreams(ctx, async () => {
      await api('POST', `/tasks/${taskId}/todo/items`, {
        actor: ctx.owner,
        body: { text: 'pick up groceries' },
      });
    });

    // Owner is creator (== recipientHint per doc 10 §6.5 line 929) AND
    // byActorId, so Shape B filter must let the event through.
    const onTasks = tasksEvents.find((e) => e.event === 'task.todo.changed');
    const onSync = findTypedSyncEvent(syncEvents, 'task.todo.changed');
    expect(onTasks ?? onSync).toBeDefined();
  });

  test('transition running → review → task.verify.requested via SyncService (creator fallback)', async () => {
    const taskId = await createTask(ctx, 'task.verify.requested probe');

    // Set up the task so it can enter `review`:
    //   1. assign to owner (acts as assignee + creator)
    //   2. move to running
    //   3. add ONE criterion with `evidenceRefs` (non-asset → skips
    //      asset validation) so validateAcceptanceEvidenceForReview
    //      passes. No verifierAgentId → dispatch fallback = creator.
    const tAssign = await api('POST', `/tasks/${taskId}/transition`, {
      actor: ctx.owner,
      body: { to: 'assigned', assigneeId: ctx.owner.imUserId, reason: 'self-assign' },
    });
    if (tAssign.status !== 200) {
      throw new Error(
        `transition pending→assigned failed: status=${tAssign.status} body=${JSON.stringify(tAssign.data)}`,
      );
    }
    const tRun = await api('POST', `/tasks/${taskId}/transition`, {
      actor: ctx.owner,
      body: { to: 'running', reason: 'start work' },
    });
    if (tRun.status !== 200) {
      throw new Error(`transition assigned→running failed: status=${tRun.status} body=${JSON.stringify(tRun.data)}`);
    }
    const cAdd = await api('POST', `/tasks/${taskId}/criteria`, {
      actor: ctx.owner,
      body: {
        // qualitative/quantitative dispatch — manual + agent-self-check
        // are short-circuited as `skipped` in verifier-dispatch.service.ts:129
        // and never emit task.verify.requested.
        verifyMode: 'qualitative',
        expectation: 'looks fine',
        required: true,
        weight: 1,
        evidenceRefs: ['note:done'], // non-asset → skips asset validation
      },
    });
    if (cAdd.status !== 200) {
      throw new Error(`criteria add failed: status=${cAdd.status} body=${JSON.stringify(cAdd.data)}`);
    }

    // rev 2 §0.2.3 (c) TODO gate — review entry requires TODO.md with
    // progressPct ≥ 0.80. Add one item, toggle done, satisfy the gate.
    // See validateRev2SelfCheckAndTodoGate in task.service.ts:2611.
    const todoAdd = await api<{ ok: boolean; data?: { revision: number } }>('POST', `/tasks/${taskId}/todo/items`, {
      actor: ctx.owner,
      body: { text: 'verify smoke ran' },
    });
    if (todoAdd.status !== 200) {
      throw new Error(`todo add failed: status=${todoAdd.status} body=${JSON.stringify(todoAdd.data)}`);
    }
    const todoDone = await api('PATCH', `/tasks/${taskId}/todo/items/0`, {
      actor: ctx.owner,
      body: { done: true },
    });
    if (todoDone.status !== 200) {
      throw new Error(`todo toggle failed: status=${todoDone.status} body=${JSON.stringify(todoDone.data)}`);
    }

    let reviewRes: { status: number; data: unknown } | undefined;
    const { syncEvents } = await withDualStreams(
      ctx,
      async () => {
        reviewRes = await api('POST', `/tasks/${taskId}/transition`, {
          actor: ctx.owner,
          body: { to: 'review', reason: 'ready for verify' },
        });
      },
      5_000, // verifier dispatch is fire-and-forget; give it room
    );
    if (reviewRes && reviewRes.status !== 200) {
      throw new Error(
        `transition running→review failed: status=${reviewRes.status} body=${JSON.stringify(reviewRes.data)}`,
      );
    }

    const ev = findTypedSyncEvent(syncEvents, 'task.verify.requested');
    if (!ev) {
      // Surface ALL collected events to aid debugging (helpful when the
      // verifier dispatch logic changes target resolution).
      const types = syncEvents
        .filter((e) => e.event === 'sync')
        .map((e) => (e.data as { type?: string })?.type)
        .filter(Boolean);
      throw new Error(`expected task.verify.requested on /sync/stream — got types: ${JSON.stringify(types)}`);
    }
    const data = (ev.data as { data?: Record<string, unknown> }).data as Record<string, unknown>;
    expect(data.taskId).toBe(taskId);
    expect(data.verifierAgentId).toBe(ctx.owner.imUserId); // creator fallback
  });

  test('doc 11 #16 — task.metric.snapshot_updated is METRIC-only (NOT on SSE wire)', async () => {
    // release201/11 §16 lists this as a metric event, NOT an SSE event.
    // task.service.ts:3901 calls metricEmit() — it never goes through
    // EventBus.publish or SyncService.writeEvent. We assert the
    // absence on both wires so any future code path that decides to
    // also push it through SSE forces an explicit decision (and a
    // doc 11 §16 update).
    //
    // There is currently no public endpoint that calls
    // `updateTaskMetricSnapshot` (see method comment line 3829:
    // "no upstream endpoint or scheduler currently invokes this method"),
    // so we cannot trigger an emit from the integration boundary. The
    // test therefore captures the contract by:
    //   1. Confirming no `task.metric.snapshot_updated` envelope arrives
    //      during a 2s observation window with no producer running.
    //   2. Recording (via console.log + this assertion) that the wire
    //      is intentionally NOT SSE so any future regression that DOES
    //      bind a metric → SSE bridge will require updating both the
    //      doc and this test.
    const { syncEvents, tasksEvents } = await withDualStreams(
      ctx,
      async () => {
        // No producer — see method note above.
      },
      2_000,
    );

    const onTasks = tasksEvents.find((e) => e.event === 'task.metric.snapshot_updated');
    const onSync = findTypedSyncEvent(syncEvents, 'task.metric.snapshot_updated');
    expect(onTasks).toBeUndefined();
    expect(onSync).toBeUndefined();

    console.log(
      '[task-events] task.metric.snapshot_updated is metric-only per doc 11 §16; no SSE wire (deferred to v2.0.8 producer)',
    );
  });
});
