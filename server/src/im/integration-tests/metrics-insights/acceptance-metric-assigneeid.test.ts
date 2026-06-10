/**
 * Phase 2 v2.0.8 — E1 fix: acceptance metric emit must include assigneeId.
 *
 * Background: release201/20 F5 ships getAgentMetrics → BFF
 * `/insights/agent/:id` exposes `metrics.acceptanceRate`. The aggregation
 * filters `task.acceptance.status_changed` events by `dims.assigneeId`.
 * Pre-E1 the emit site (task-acceptance.service.ts) only set
 * { workspaceId, taskId, projectId, capability } — no assigneeId — so
 * acceptanceRate stayed `available: false` forever in the prod path.
 *
 * E1 fix: add `assigneeId: task.assigneeId ?? undefined` to dims (and
 * select assigneeId from prisma alongside the other dim sources).
 *
 * This test drives the *real* emit path (no manual /metrics/emit):
 *   1. Bootstrap workspace + assignee (`ctx.member`).
 *   2. Create a task with assigneeId=member, attach a criterion.
 *   3. POST /tasks/:id/criteria/:cid/verify with outcome=passed
 *      → service recompute → emit `task.acceptance.status_changed`.
 *   4. Wait ≥ 6.5s for the metric flush timer (default 5s + safety).
 *   5. GET /metrics/aggregate filtered by workspaceId + assigneeId
 *      → count must be ≥ 1 (E1 pre-fix would be 0).
 *   6. GET /insights/agent/:assigneeId → metrics.acceptanceRate.available
 *      must be `true` (the user-visible F5 outcome).
 *
 * Hard expectations:
 *   - MetricService flushIntervalMs = 5000 (metric.service.ts DEFAULT_OPTS).
 *   - The criterion verify path only emits status_changed when the overall
 *     acceptance status transitions (recompute() guards via `previous !== overall`).
 *     A fresh task starts at 'none'; a single required passed criterion
 *     flips it to 'passed' — one emit guaranteed.
 *   - Integration tests require the dev Hono server running on localhost:3000.
 *     Under Turbopack HMR the in-process IM does NOT reload — restart
 *     dev-stack (or use standalone src/im/start.ts on :3300) before running.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

const FLUSH_WAIT_MS = 6500;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface Env<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface AggregateBucket {
  ts: string | null;
  groups: Array<{ groupKey: Record<string, string | null>; value: number | null }>;
}
interface AggregateData {
  namespace: string;
  name: string;
  agg: string;
  range: { from: string; to: string };
  buckets: AggregateBucket[];
}

function sumOfBuckets(buckets: AggregateBucket[] | undefined): number {
  if (!buckets) return 0;
  let s = 0;
  for (const b of buckets) for (const g of b.groups) s += Number(g.value ?? 0);
  return s;
}

interface AvailableValueDTO<T = number> {
  value?: T;
  available: boolean;
  reason?: string;
}
interface AgentResponseData {
  workspaceId: string;
  agentId: string;
  metrics: {
    acceptanceRate: AvailableValueDTO;
    dispatchLatencyP95Ms: AvailableValueDTO;
    totalDispatchedTasks: AvailableValueDTO;
  };
}

describe('acceptance metric emit — E1 assigneeId dim (v2.0.8)', () => {
  let ctx: SuiteContext;
  let taskId = '';
  let criterionId = '';

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2e1aid');
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  }, 30_000);

  test('verifying a passed criterion emits status_changed with dims.assigneeId', async () => {
    const ws = ctx.workspace.id;

    // 1. Create task assigned to ctx.member.
    // release201/10 §5.3 — task.service auto-applies a default criteria
    // template per capability ('general' currently seeds a placeholder
    // criterion). Opt out via metadata.skipAcceptanceTemplate=true so the
    // single hand-attached criterion below is the *only* criterion → one
    // `passed` flips overall to 'passed' (recomputeAcceptanceStatus rule:
    // every passed/n-a → 'passed'). Otherwise overall stays 'partial' and
    // the status_changed emit fires with status=partial, not passed.
    const createRes = await api<Env<{ id: string }>>('POST', '/tasks', {
      actor: ctx.owner,
      body: {
        title: 'E1 assigneeId emit fixture',
        description: 'verifies task-acceptance.service.ts dims include assigneeId',
        capability: 'general',
        workspaceId: ws,
        assigneeId: ctx.member.imUserId,
        metadata: { skipAcceptanceTemplate: true },
      },
      expectStatus: 201,
    });
    expect(createRes.data.ok).toBe(true);
    taskId = createRes.data.data!.id;

    // 2. Add one required qualitative criterion.
    const critRes = await api<Env<{ criterion: { id: string } }>>('POST', `/tasks/${taskId}/criteria`, {
      actor: ctx.owner,
      body: {
        verifyMode: 'qualitative',
        expectation: 'E1 fixture — passes immediately on verify',
        required: true,
      },
    });
    expect(critRes.data.ok).toBe(true);
    criterionId = critRes.data.data!.criterion.id;

    // 3. Verify passed → recompute → emit status_changed.
    const verifyRes = await api<Env<{ overall: string }>>('POST', `/tasks/${taskId}/criteria/${criterionId}/verify`, {
      actor: ctx.member,
      body: { outcome: 'passed', note: 'E1 self-check' },
    });
    expect(verifyRes.data.ok).toBe(true);
    expect(verifyRes.data.data?.overall).toBe('passed');

    // 4. Wait for metric flush.
    await sleep(FLUSH_WAIT_MS);

    // 5. Aggregate count filtered by assigneeId — must be ≥ 1 post-E1.
    const aggRes = await api<Env<AggregateData>>('GET', '/metrics/aggregate', {
      actor: ctx.owner,
      query: {
        namespace: 'task.acceptance',
        name: 'status_changed',
        agg: 'count',
        range: '1h',
        filter: `workspaceId:${ws},assigneeId:${ctx.member.imUserId}`,
      },
    });
    expect(aggRes.status).toBe(200);
    expect(aggRes.data.ok).toBe(true);
    const cnt = sumOfBuckets(aggRes.data.data?.buckets);
    expect(cnt, `count by dims.assigneeId=${ctx.member.imUserId} must be ≥ 1 (E1)`).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('getAgentMetrics returns acceptanceRate.available=true for the assignee', async () => {
    // The previous test already emitted + waited for flush; one passed event
    // is enough for the BFF (denominator=1, numerator=1 → ratio=1.0).
    const r = await api<Env<AgentResponseData>>('GET', `/insights/agent/${ctx.member.imUserId}`, {
      actor: ctx.owner,
      // Distinct range vs prior call sidesteps the 30s response cache.
      query: { workspaceId: ctx.workspace.id, range: '7d' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);

    const m = r.data.data?.metrics;
    expect(m, 'metrics block present').toBeDefined();
    if (!m) return;

    expect(m.acceptanceRate.available, 'E1 fix: acceptanceRate available').toBe(true);
    expect(typeof m.acceptanceRate.value).toBe('number');
    expect(m.acceptanceRate.value!).toBeGreaterThan(0);
    expect(m.acceptanceRate.value!).toBeLessThanOrEqual(1);
  }, 30_000);
});
