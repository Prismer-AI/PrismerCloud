/**
 * release201/20 Gap C F4 — Project view 3 extra aggregates.
 *
 * Asserts that GET /insights/project/:id returns the new `aggregates` block
 * alongside the existing `widgets` envelope:
 *
 *   data.aggregates.activeMemberCount   { count, available }
 *   data.aggregates.acceptanceByStatus  { buckets: [{status, count}…], available }
 *   data.aggregates.activityTimeseries  { points: [{ts, count}…], available }
 *
 * The legacy 8-widget contract (covered by insights-project-agent-bff.test.ts)
 * stays untouched — this suite ONLY asserts the new fields. We do not duplicate
 * the existing widget assertions here so a future widget addition doesn't break
 * both suites in lock-step.
 *
 * Notes:
 *   - `acceptanceByStatus.available === true` requires at least one task to
 *     have been created in the range. Tasks are created via POST /tasks with
 *     workspaceId + projectId; the BFF reads IMTask.acceptanceStatus directly
 *     (no metric outbox involvement) so this signal is deterministic.
 *   - `activeMemberCount.available` is hard-wired to true (membership-table
 *     query, not a metric). The `count` reflects rows in
 *     im_agent_project_memberships, which a fresh project starts with 0 rows
 *     (the workspace owner is implicitly the project owner but is NOT
 *     auto-rowed into the memberships table — that's the project.service
 *     contract). We assert the field shape + non-negative count rather than a
 *     specific number to stay robust to future implicit-owner-row changes.
 *   - `activityTimeseries.available === true` would require live metric
 *     emission via /metrics/emit; we don't drive that here (covered in
 *     metric-emit-aggregate.test.ts) — we only assert the field shape +
 *     `available=false` empty-state is sane.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

interface ProjectAggregatesData {
  activeMemberCount: { count: number; available: boolean };
  acceptanceByStatus: {
    buckets: Array<{ status: 'passing' | 'failing' | 'unknown' | 'none'; count: number }>;
    available: boolean;
  };
  activityTimeseries: {
    points: Array<{ ts: string; count: number }>;
    available: boolean;
  };
}

interface ProjectData {
  workspaceId: string;
  projectId: string;
  projectName: string;
  status: string;
  memberCount: number;
  widgets: Record<string, unknown>;
  aggregates: ProjectAggregatesData;
  asOf: string;
}

interface Env<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('Project view 3 aggregates (doc 20 §3.3 Gap C F4)', () => {
  let ctx: SuiteContext;
  let projectId: string;
  let emptyProjectId: string;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2eF4agg');

    // Populated project — owner creates 3 tasks scoped to it. We don't drive
    // the full acceptance state machine; default acceptanceStatus='none' is
    // enough to exercise the bucketing path and confirm available=true once
    // tasks exist in the window.
    const pop = await api<{ ok: boolean; data?: { id: string } }>('POST', '/projects', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        slug: `f4pop-${Date.now().toString(36)}`,
        name: 'F4 populated probe',
      },
      expectStatus: 201,
    });
    projectId = pop.data.data!.id;

    for (let i = 0; i < 3; i++) {
      await api('POST', '/tasks', {
        actor: ctx.owner,
        body: {
          workspaceId: ctx.workspace.id,
          projectId,
          title: `F4 probe task ${i + 1}`,
          capability: 'generic',
        },
      });
    }

    // Empty project — for the "available=true + count=0 (not undefined)" test.
    const empty = await api<{ ok: boolean; data?: { id: string } }>('POST', '/projects', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        slug: `f4emp-${Date.now().toString(36)}`,
        name: 'F4 empty probe',
      },
      expectStatus: 201,
    });
    emptyProjectId = empty.data.data!.id;
  }, 90_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  }, 30_000);

  test('GET /insights/project/:id includes 3 new aggregate fields with correct shape', async () => {
    const r = await api<Env<ProjectData>>('GET', `/insights/project/${projectId}`, {
      actor: ctx.owner,
      query: { range: '7d' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);

    const a = r.data.data?.aggregates;
    expect(a, 'aggregates block must be present on /insights/project response').toBeDefined();
    if (!a) return;

    // activeMemberCount: shape only — the count depends on whether the
    // workspace owner is auto-rowed into im_agent_project_memberships, which
    // is a project.service implementation detail we don't pin here.
    expect(a.activeMemberCount).toBeDefined();
    expect(typeof a.activeMemberCount.count).toBe('number');
    expect(a.activeMemberCount.count).toBeGreaterThanOrEqual(0);
    expect(a.activeMemberCount.available).toBe(true);

    // acceptanceByStatus: 4 canonical buckets always present, sum equals
    // the number of tasks created in the window (3 created in beforeAll).
    expect(a.acceptanceByStatus).toBeDefined();
    expect(Array.isArray(a.acceptanceByStatus.buckets)).toBe(true);
    expect(a.acceptanceByStatus.buckets.length).toBe(4);
    const statuses = a.acceptanceByStatus.buckets.map((b) => b.status).sort();
    expect(statuses).toEqual(['failing', 'none', 'passing', 'unknown']);
    const totalTasks = a.acceptanceByStatus.buckets.reduce((s, b) => s + b.count, 0);
    expect(totalTasks).toBe(3);
    expect(a.acceptanceByStatus.available).toBe(true);

    // activityTimeseries: shape — points array (possibly empty if metric
    // outbox didn't see emit during the test window). available may be
    // false in that case.
    expect(a.activityTimeseries).toBeDefined();
    expect(Array.isArray(a.activityTimeseries.points)).toBe(true);
    expect(typeof a.activityTimeseries.available).toBe('boolean');
    for (const p of a.activityTimeseries.points) {
      expect(typeof p.ts).toBe('string');
      expect(typeof p.count).toBe('number');
    }
  });

  test('empty project — aggregates returns available + sentinel counts (not undefined)', async () => {
    const r = await api<Env<ProjectData>>('GET', `/insights/project/${emptyProjectId}`, {
      actor: ctx.owner,
      query: { range: '7d' },
    });
    expect(r.status).toBe(200);
    const a = r.data.data?.aggregates;
    expect(a).toBeDefined();
    if (!a) return;

    // The field MUST exist (even with no tasks) — undefined would force the
    // UI into a defensive `??` everywhere instead of trusting the contract.
    expect(a.activeMemberCount).toBeDefined();
    expect(a.activeMemberCount.available).toBe(true);
    expect(a.activeMemberCount.count).toBeGreaterThanOrEqual(0);

    // No tasks → 4 buckets all zero, available=false (UI shows empty hint).
    expect(a.acceptanceByStatus.buckets.length).toBe(4);
    const total = a.acceptanceByStatus.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(0);
    expect(a.acceptanceByStatus.available).toBe(false);

    // No metric events → empty points, available=false.
    expect(a.activityTimeseries.points.length).toBe(0);
    expect(a.activityTimeseries.available).toBe(false);
  });

  test('non-member returns 403 (existing ACL preserved by the extra aggregates fan-out)', async () => {
    // The 3 new aggregates run AFTER buildProject() in the router. buildProject
    // throws WorkspaceForbiddenError on a non-member which short-circuits the
    // fan-out — outsider must still see 403, not a leaked aggregates payload.
    const r = await api<Env<unknown>>('GET', `/insights/project/${projectId}`, {
      actor: ctx.outsider,
    });
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_FORBIDDEN');
  });
});
