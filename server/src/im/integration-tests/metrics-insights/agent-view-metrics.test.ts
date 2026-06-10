/**
 * Phase 2E — release201/20 Gap C F5.
 *
 * Drives GET /insights/agent/:agentId's new `metrics` block (11-doc metric
 * outbox passthrough) end-to-end against the live cloud + dev MySQL.
 *
 * Hard expectations:
 *   - MetricService.flushIntervalMs = 5000 (metric.service.ts DEFAULT_OPTS)
 *     → wait ≥ 6500ms after emit before query, otherwise the row hasn't been
 *     flushed and the BFF reads `available: false`.
 *   - The acceptance metric (`task.acceptance.status_changed`) is currently
 *     emitted *without* an `assigneeId` dim (task-acceptance.service.ts:482
 *     builds dims = {workspaceId, taskId, projectId, capability}). Seeding
 *     acceptance via the public `/metrics/emit` endpoint with our own
 *     assigneeId dim is the only way to populate the dimension this BFF
 *     filters by — until the §10 emit path is updated.
 *   - The `agent.dispatch` metric is emitted by the daemon outbox in prod;
 *     for this test we seed via `/metrics/emit` directly.
 *
 * Empty-state assertion: a freshly-bootstrapped workspace has 0 outbox
 * rows for the agent → every `metrics.*` field returns `available: false`
 * with the documented reason strings.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

const FLUSH_WAIT_MS = 6500;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

interface Env<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function emitMetric(
  actor: SuiteContext['owner'],
  body: {
    namespace: string;
    name: string;
    value?: number | string | null;
    dims: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  const r = await api<{ ok: boolean }>('POST', '/metrics/emit', { actor, body });
  if (r.status !== 202 && r.status !== 200) {
    throw new Error(
      `emit failed (${r.status}): namespace=${body.namespace} name=${body.name} body=${JSON.stringify(r.data)}`,
    );
  }
}

describe('Agent view metrics (release201/20 Gap C F5)', () => {
  let ctx: SuiteContext;
  let agentImUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2gcf5');
    // Use the suite owner as the "agent" identity. The BFF treats agentId as
    // a filter-dim only (no existence check, see
    // insights-project-agent-bff.test.ts line 215). The acceptance metric is
    // filtered by `assigneeId` and dispatch by `agentId`, so we just need a
    // stable ID to round-trip through `/metrics/emit` dims.
    agentImUserId = ctx.owner.imUserId;
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  }, 30_000);

  test('empty workspace → every metric returns available=false with documented reason', async () => {
    const r = await api<Env<AgentResponseData>>('GET', `/insights/agent/${agentImUserId}`, {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, range: '24h' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);

    const m = r.data.data?.metrics;
    expect(m, 'metrics block present on response').toBeDefined();
    if (!m) return;

    expect(m.acceptanceRate.available).toBe(false);
    expect(m.acceptanceRate.reason).toBe('no_acceptance_recorded');
    expect(m.dispatchLatencyP95Ms.available).toBe(false);
    expect(m.dispatchLatencyP95Ms.reason).toBe('no_outbox_ingested');
    expect(m.totalDispatchedTasks.available).toBe(false);
    expect(m.totalDispatchedTasks.reason).toBe('no_outbox_ingested');
  }, 30_000);

  test('after seeded acceptance events — acceptanceRate.available=true and value > 0', async () => {
    const ws = ctx.workspace.id;
    // Seed 3 passed + 1 failed acceptance rows for this agent. The §10 emit
    // site does not currently include assigneeId — we set it ourselves so
    // the BFF filter matches.
    for (let i = 0; i < 3; i++) {
      await emitMetric(ctx.owner, {
        namespace: 'task.acceptance',
        name: 'status_changed',
        value: 'passed',
        dims: {
          workspaceId: ws,
          taskId: `gcf5-pass-${i}`,
          capability: 'general',
          assigneeId: agentImUserId,
          acceptanceStatus: 'passed',
        },
      });
    }
    await emitMetric(ctx.owner, {
      namespace: 'task.acceptance',
      name: 'status_changed',
      value: 'failed',
      dims: {
        workspaceId: ws,
        taskId: 'gcf5-fail-0',
        capability: 'general',
        assigneeId: agentImUserId,
        acceptanceStatus: 'failed',
      },
    });
    await sleep(FLUSH_WAIT_MS);

    // 30s response cache busts when we use a different range than the prior
    // test (24h). Use 7d here to skip the in-memory cache hit.
    const r = await api<Env<AgentResponseData>>('GET', `/insights/agent/${agentImUserId}`, {
      actor: ctx.owner,
      query: { workspaceId: ws, range: '7d' },
    });
    expect(r.status).toBe(200);
    const m = r.data.data?.metrics;
    expect(m).toBeDefined();
    if (!m) return;

    expect(m.acceptanceRate.available, 'acceptance rate now available').toBe(true);
    expect(typeof m.acceptanceRate.value).toBe('number');
    // 3 passed / 4 total = 0.75
    expect(m.acceptanceRate.value!).toBeGreaterThan(0);
    expect(m.acceptanceRate.value!).toBeLessThanOrEqual(1);
  }, 60_000);

  test('after seeded dispatch events — dispatchLatencyP95Ms + totalDispatchedTasks available with value > 0', async () => {
    const ws = ctx.workspace.id;
    // Seed 5 dispatch durations in ms — p95 of {100,200,300,400,500} ≈ 500.
    const durations = [100, 200, 300, 400, 500];
    for (const [i, v] of durations.entries()) {
      await emitMetric(ctx.owner, {
        namespace: 'agent',
        name: 'dispatch',
        value: v,
        dims: {
          workspaceId: ws,
          agentId: agentImUserId,
          taskId: `gcf5-disp-${i}`,
        },
      });
    }
    await sleep(FLUSH_WAIT_MS);

    // Different range again to dodge the 30s response cache from prior test.
    const r = await api<Env<AgentResponseData>>('GET', `/insights/agent/${agentImUserId}`, {
      actor: ctx.owner,
      query: { workspaceId: ws, range: '30d' },
    });
    expect(r.status).toBe(200);
    const m = r.data.data?.metrics;
    expect(m).toBeDefined();
    if (!m) return;

    expect(m.dispatchLatencyP95Ms.available, 'p95 latency available').toBe(true);
    expect(typeof m.dispatchLatencyP95Ms.value).toBe('number');
    expect(m.dispatchLatencyP95Ms.value!).toBeGreaterThan(0);

    expect(m.totalDispatchedTasks.available, 'total dispatched available').toBe(true);
    expect(m.totalDispatchedTasks.value!).toBeGreaterThanOrEqual(5);
  }, 60_000);

  test('non-member returns 403 (existing ACL preserved by buildAgent → assertWorkspaceMember)', async () => {
    const r = await api<Env<unknown>>('GET', `/insights/agent/${agentImUserId}`, {
      actor: ctx.outsider,
      query: { workspaceId: ctx.workspace.id, range: '24h' },
    });
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_FORBIDDEN');
  }, 30_000);
});
