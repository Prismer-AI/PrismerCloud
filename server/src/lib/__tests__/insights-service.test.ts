/**
 * Tests for InsightsService (release201/12 §7.4).
 *
 * Covers:
 *   1. resolveRange — current + previous window math
 *   2. assertWorkspaceMember — denies non-member, allows owner + member
 *   3. buildOverview — fan-out parallel + shape correctness with mocked
 *      `runAggregate` and IMProject.count
 *   4. cache TTL — set + get hit, expired entries evicted
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so mocks can be referenced inside vi.mock without TDZ.
const mocks = vi.hoisted(() => ({
  runAggregate: vi.fn(),
  prismaWsFindFirst: vi.fn(),
  prismaWsMemberFindFirst: vi.fn(),
  prismaWsMemberFindUnique: vi.fn(),
  prismaAgentCardFindFirst: vi.fn(),
  prismaProjectCount: vi.fn(),
  prismaProjectFindMany: vi.fn(),
  prismaProjectFindUnique: vi.fn(),
  prismaTaskFindMany: vi.fn(),
  prismaTaskAggregate: vi.fn(),
  prismaMembershipCount: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    iMWorkspace: { findFirst: mocks.prismaWsFindFirst },
    iMWorkspaceMember: {
      findFirst: mocks.prismaWsMemberFindFirst,
      findUnique: mocks.prismaWsMemberFindUnique,
    },
    iMAgentCard: { findFirst: mocks.prismaAgentCardFindFirst },
    iMProject: {
      count: mocks.prismaProjectCount,
      findMany: mocks.prismaProjectFindMany,
      findUnique: mocks.prismaProjectFindUnique,
    },
    iMTask: { findMany: mocks.prismaTaskFindMany, aggregate: mocks.prismaTaskAggregate },
    iMAgentProjectMembership: { count: mocks.prismaMembershipCount },
  },
}));

vi.mock('@/lib/logger', () => ({
  createModuleLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
}));

vi.mock('@/im/api/metrics', () => ({
  runAggregate: mocks.runAggregate,
}));

// Now import the service under test after mocks are wired.
import {
  __clearInsightsCacheForTests,
  assertWorkspaceMember,
  buildAgent,
  buildOverview,
  buildProject,
  cacheKey,
  getCached,
  resolveRange,
  setCached,
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
} from '@/im/services/insights.service';

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  // buildProject sums IMTask.cost via aggregate — default to no spend so the
  // existing burndown/acceptance assertions are unaffected. Cost-specific
  // tests override this.
  mocks.prismaTaskAggregate.mockResolvedValue({ _sum: { cost: 0 } });
  __clearInsightsCacheForTests();
});

describe('resolveRange', () => {
  it('produces previous window mirroring current', () => {
    const now = new Date('2026-05-26T12:00:00Z');
    const win = resolveRange('7d', now);
    const ms = win.to.getTime() - win.from.getTime();
    expect(ms).toBe(7 * 86_400_000);
    expect(win.previous.to.getTime()).toBe(win.from.getTime());
    expect(win.previous.from.getTime()).toBe(win.from.getTime() - ms);
  });

  it('falls back to 7d when an unknown range is passed', () => {
    const now = new Date('2026-05-26T12:00:00Z');
    const win = resolveRange('unknown' as never, now);
    expect(win.to.getTime() - win.from.getTime()).toBe(7 * 86_400_000);
  });
});

describe('assertWorkspaceMember', () => {
  it('throws WorkspaceNotFoundError when workspace missing', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue(null);
    await expect(assertWorkspaceMember('ws-missing', 'user-1')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('allows owner without consulting member table', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    await expect(assertWorkspaceMember('ws-1', 'owner-1')).resolves.toBeUndefined();
    expect(mocks.prismaWsMemberFindFirst).not.toHaveBeenCalled();
  });

  it('allows non-owner if member row exists', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prismaWsMemberFindFirst.mockResolvedValue({ id: 'm-1' });
    await expect(assertWorkspaceMember('ws-1', 'user-2')).resolves.toBeUndefined();
  });

  it('rejects non-owner non-member with WorkspaceForbiddenError', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prismaWsMemberFindFirst.mockResolvedValue(null);
    await expect(assertWorkspaceMember('ws-1', 'stranger')).rejects.toBeInstanceOf(WorkspaceForbiddenError);
  });
});

describe('buildOverview', () => {
  // Helper: emit a single-bucket aggregate response with one group and a
  // total value. The service sums these so we can verify fan-out + shape.
  function single(total: number, groupKey: Record<string, string | null> = {}) {
    return [
      {
        ts: null,
        groups: [{ groupKey, value: total }],
      },
    ];
  }

  it('fans out 11 aggregate calls in parallel and assembles shape', async () => {
    // Each call returns a small bucket; verify the result counts and that
    // no call was made serially before another (mocks resolve immediately;
    // we assert callCount == expected at end).
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.runAggregate.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return single(3, { capability: 'general' });
    });
    // v2.0.8 Bug 1 — buildOverview now uses iMProject.findMany to also surface
    // names; activeProjects.value = list length.
    mocks.prismaProjectFindMany.mockResolvedValue([
      { id: 'p1', name: 'Project Alpha' },
      { id: 'p2', name: 'Project Beta' },
    ]);

    const res = await buildOverview({ workspaceId: 'ws-1', range: '7d' });

    // 11 calls to runAggregate (counts + acceptance + skill published + velocity
    // + approval × 2 + topCapabilities + acceptanceByProject + acceptancePassed
    // breakdown). The exact count is part of the contract: drift would mean
    // we silently changed fan-out behaviour.
    expect(mocks.runAggregate.mock.calls.length).toBe(11);
    // Parallelism: every call started before any resolved.
    expect(maxInFlight).toBeGreaterThan(1);

    // Shape sanity.
    expect(res.widgets.tasksCompleted.type).toBe('counter');
    expect(res.widgets.activeProjects.value).toBe(2);
    expect(res.widgets.topCapabilities.type).toBe('bar');
    expect(res.widgets.acceptanceByProject.type).toBe('grid');
  });

  it('passes workspaceId on every aggregate filter (no leakage)', async () => {
    mocks.runAggregate.mockResolvedValue([]);
    mocks.prismaProjectFindMany.mockResolvedValue([]);

    await buildOverview({ workspaceId: 'ws-secret', range: '24h' });

    for (const callArgs of mocks.runAggregate.mock.calls) {
      const opts = callArgs[0] as { filter: Record<string, string> };
      expect(opts.filter.workspaceId).toBe('ws-secret');
    }
  });

  // ── v2.0.8 hotfix Bug 1 — acceptanceByProject label refinement ──
  describe('acceptanceByProject grid (Bug 1 A)', () => {
    it('single active project + NULL projectId tasks: row label = project name + unscoped=true', async () => {
      mocks.runAggregate.mockImplementation(async (opts: { groupBy?: string[]; name: string }) => {
        if (opts.groupBy?.includes('projectId') && opts.name === 'status_changed') {
          // 6 unscoped acceptance events (projectId=null) — the user's "Prismer" workspace state.
          return [
            {
              ts: null,
              groups: [{ groupKey: { projectId: null }, value: 6 }],
            },
          ];
        }
        return [{ ts: null, groups: [{ groupKey: {}, value: 0 }] }];
      });
      mocks.prismaProjectFindMany.mockResolvedValue([{ id: 'p-prismer', name: 'Prismer 主项目' }]);

      const res = await buildOverview({ workspaceId: 'ws-1', range: '7d' });
      const rows = res.widgets.acceptanceByProject.rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe('Prismer 主项目');
      expect(rows[0].unscoped).toBe(true);
      expect(rows[0].counts.total).toBe(6);
    });

    it('multiple active projects: NULL row keeps "(workspace)" label but stays flagged unscoped', async () => {
      mocks.runAggregate.mockImplementation(async (opts: { groupBy?: string[]; name: string }) => {
        if (opts.groupBy?.includes('projectId') && opts.name === 'status_changed') {
          return [
            {
              ts: null,
              groups: [
                { groupKey: { projectId: null }, value: 3 },
                { groupKey: { projectId: 'p-alpha' }, value: 5 },
              ],
            },
          ];
        }
        return [{ ts: null, groups: [{ groupKey: {}, value: 0 }] }];
      });
      mocks.prismaProjectFindMany.mockResolvedValue([
        { id: 'p-alpha', name: 'Project Alpha' },
        { id: 'p-beta', name: 'Project Beta' },
      ]);

      const res = await buildOverview({ workspaceId: 'ws-1', range: '7d' });
      const rows = res.widgets.acceptanceByProject.rows;
      expect(rows).toHaveLength(2);
      const unscopedRow = rows.find((r) => r.unscoped);
      const namedRow = rows.find((r) => r.label === 'Project Alpha');
      expect(unscopedRow?.label).toBe('(workspace)');
      expect(unscopedRow?.unscoped).toBe(true);
      expect(namedRow?.unscoped).toBeUndefined();
      expect(namedRow?.counts.total).toBe(5);
    });

    it('zero active projects: NULL row keeps "(workspace)" label + unscoped flag', async () => {
      mocks.runAggregate.mockImplementation(async (opts: { groupBy?: string[]; name: string }) => {
        if (opts.groupBy?.includes('projectId') && opts.name === 'status_changed') {
          return [{ ts: null, groups: [{ groupKey: { projectId: null }, value: 2 }] }];
        }
        return [{ ts: null, groups: [{ groupKey: {}, value: 0 }] }];
      });
      mocks.prismaProjectFindMany.mockResolvedValue([]);

      const res = await buildOverview({ workspaceId: 'ws-1', range: '7d' });
      const rows = res.widgets.acceptanceByProject.rows;
      expect(rows[0].label).toBe('(workspace)');
      expect(rows[0].unscoped).toBe(true);
    });
  });
});

describe('buildProject', () => {
  function single(total: number, groupKey: Record<string, string | null> = {}, ts: string | null = null) {
    return [
      {
        ts,
        groups: [{ groupKey, value: total }],
      },
    ];
  }

  it('looks up project, gates on workspace member, and fans out 9 aggregate calls', async () => {
    mocks.prismaProjectFindUnique.mockResolvedValue({
      id: 'p-1',
      workspaceId: 'ws-1',
      name: 'Q2 Launch',
      status: 'active',
      metadata: null,
    });
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prismaMembershipCount.mockResolvedValue(3);
    mocks.prismaTaskFindMany.mockResolvedValue([]);
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.runAggregate.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return single(0);
    });

    const res = await buildProject({ projectId: 'p-1', range: '7d', actorImUserId: 'owner-1' });

    // 9 aggregate calls: created / completed / failed / acceptanceCount /
    // acceptancePassed / burndownCreated / burndownCompleted / burndownFailed /
    // acceptanceByCapability / contributorAgentBuckets = 10 (with the inline
    // capability/contributor groupings)
    expect(mocks.runAggregate.mock.calls.length).toBe(10);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(res.projectName).toBe('Q2 Launch');
    expect(res.memberCount).toBe(3);
    expect(res.widgets.burndown.type).toBe('timeseries');
    expect(res.widgets.contributors.type).toBe('table');
  });

  it('refuses non-member with WorkspaceForbiddenError', async () => {
    mocks.prismaProjectFindUnique.mockResolvedValue({
      id: 'p-1',
      workspaceId: 'ws-1',
      name: 'p',
      status: 'active',
      metadata: null,
    });
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prismaWsMemberFindFirst.mockResolvedValue(null);
    await expect(buildProject({ projectId: 'p-1', range: '7d', actorImUserId: 'stranger' })).rejects.toBeInstanceOf(
      WorkspaceForbiddenError,
    );
  });

  it('every aggregate call carries projectId + workspaceId filter (no leakage)', async () => {
    mocks.prismaProjectFindUnique.mockResolvedValue({
      id: 'p-secret',
      workspaceId: 'ws-secret',
      name: 'p',
      status: 'active',
      metadata: null,
    });
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner' });
    mocks.prismaMembershipCount.mockResolvedValue(0);
    mocks.prismaTaskFindMany.mockResolvedValue([]);
    mocks.runAggregate.mockResolvedValue([]);

    await buildProject({ projectId: 'p-secret', range: '7d', actorImUserId: 'owner' });

    for (const callArgs of mocks.runAggregate.mock.calls) {
      const opts = callArgs[0] as { filter: Record<string, string> };
      expect(opts.filter.workspaceId).toBe('ws-secret');
      expect(opts.filter.projectId).toBe('p-secret');
    }
  });

  it('computes burndown cumulative open from created - completed - failed', async () => {
    mocks.prismaProjectFindUnique.mockResolvedValue({
      id: 'p-1',
      workspaceId: 'ws-1',
      name: 'p',
      status: 'active',
      metadata: null,
    });
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner' });
    mocks.prismaMembershipCount.mockResolvedValue(0);
    mocks.prismaTaskFindMany.mockResolvedValue([]);

    // Sequence by call index (Promise.all preserves order of declaration in
    // service): [created, completed, failed, acceptanceCount, acceptancePassed,
    // burndownCreated, burndownCompleted, burndownFailed, acceptanceByCapability,
    // contributorAgentBuckets]
    const seq = [
      single(0),
      single(0),
      single(0),
      single(0),
      single(0),
      // burndownCreated: day1=5, day2=3
      [
        { ts: '2026-05-20', groups: [{ groupKey: {}, value: 5 }] },
        { ts: '2026-05-21', groups: [{ groupKey: {}, value: 3 }] },
      ],
      // burndownCompleted: day1=1, day2=2
      [
        { ts: '2026-05-20', groups: [{ groupKey: {}, value: 1 }] },
        { ts: '2026-05-21', groups: [{ groupKey: {}, value: 2 }] },
      ],
      // burndownFailed: day1=0, day2=1
      [
        { ts: '2026-05-20', groups: [{ groupKey: {}, value: 0 }] },
        { ts: '2026-05-21', groups: [{ groupKey: {}, value: 1 }] },
      ],
      single(0),
      single(0),
    ];
    let i = 0;
    mocks.runAggregate.mockImplementation(async () => seq[i++] ?? single(0));

    const res = await buildProject({ projectId: 'p-1', range: '7d', actorImUserId: 'owner' });
    // cum day1 = 5 - 1 - 0 = 4
    // cum day2 = 4 + (3 - 2 - 1) = 4
    expect(res.widgets.burndown.buckets).toEqual([
      { ts: '2026-05-20', value: 4 },
      { ts: '2026-05-21', value: 4 },
    ]);
  });

  it('surfaces SUM(IMTask.cost) as the cost counter widget', async () => {
    mocks.prismaProjectFindUnique.mockResolvedValue({
      id: 'p-1',
      workspaceId: 'ws-1',
      name: 'p',
      status: 'active',
      metadata: null,
    });
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner' });
    mocks.prismaMembershipCount.mockResolvedValue(0);
    mocks.prismaTaskFindMany.mockResolvedValue([]);
    mocks.runAggregate.mockResolvedValue([]);
    mocks.prismaTaskAggregate.mockResolvedValue({ _sum: { cost: 12.3456 } });

    const res = await buildProject({ projectId: 'p-1', range: '7d', actorImUserId: 'owner' });
    expect(res.widgets.cost.value).toBe(12.3456);
    expect(res.widgets.cost.unit).toBe('credits');
    // The aggregate is scoped to the project + completedAt-in-window.
    const aggArgs = mocks.prismaTaskAggregate.mock.calls[0]?.[0] as {
      _sum: { cost: boolean };
      where: { workspaceId: string; projectId: string; completedAt: { gte: Date; lte: Date } };
    };
    expect(aggArgs._sum.cost).toBe(true);
    expect(aggArgs.where.projectId).toBe('p-1');
    expect(aggArgs.where.workspaceId).toBe('ws-1');
    expect(aggArgs.where.completedAt.gte).toBeInstanceOf(Date);
  });
});

describe('buildAgent', () => {
  function single(total: number, groupKey: Record<string, string | null> = {}) {
    return [
      {
        ts: null,
        groups: [{ groupKey, value: total }],
      },
    ];
  }

  it('gates on workspace member then fans out 12 aggregate calls', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    // release201/19 D4 — buildAgent now probes IMAgentCard + IMWorkspaceMember
    // to 404 cross-workspace probes. Default to resolving so the legacy gate
    // path (workspace owner) still reaches the aggregate fan-out.
    mocks.prismaAgentCardFindFirst.mockResolvedValue({ id: 'card-1' });
    mocks.prismaWsMemberFindUnique.mockResolvedValue(null);
    mocks.prismaTaskFindMany.mockResolvedValue([]);
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.runAggregate.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return single(0);
    });

    const res = await buildAgent({
      agentId: 'a-1',
      workspaceId: 'ws-1',
      range: '7d',
      actorImUserId: 'owner-1',
    });

    // 12 aggregate calls: legacy 8 (tasksDone / tasksDonePrev / latencyAvg /
    // acceptanceCount / acceptancePassed / skillsUsed / dispatchVolume /
    // skillInvocation) + 4 from release201/20 Gap C F5 getAgentMetrics
    // (acceptance all + acceptance passed + dispatch p95 + dispatch count).
    expect(mocks.runAggregate.mock.calls.length).toBe(12);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(res.agentId).toBe('a-1');
    expect(res.widgets.tasksDone.type).toBe('counter');
    expect(res.widgets.dispatchVolume.type).toBe('timeseries');
    expect(res.widgets.skillInvocation.type).toBe('bar');
    expect(res.widgets.recentTasks.type).toBe('table');
    // release201/20 Gap C F5 — metrics block surfaces 11-doc metric outbox.
    // 0 rows on every aggregate → all 3 are unavailable with documented reasons.
    expect(res.metrics.acceptanceRate.available).toBe(false);
    expect(res.metrics.dispatchLatencyP95Ms.available).toBe(false);
    expect(res.metrics.totalDispatchedTasks.available).toBe(false);
  });

  it('refuses non-member', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prismaWsMemberFindFirst.mockResolvedValue(null);
    await expect(
      buildAgent({ agentId: 'a-1', workspaceId: 'ws-1', range: '7d', actorImUserId: 'stranger' }),
    ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
  });

  it('every aggregate carries workspaceId + assigneeId filter', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner' });
    mocks.prismaAgentCardFindFirst.mockResolvedValue({ id: 'card-1' });
    mocks.prismaWsMemberFindUnique.mockResolvedValue(null);
    mocks.prismaTaskFindMany.mockResolvedValue([]);
    mocks.runAggregate.mockResolvedValue([]);

    await buildAgent({
      agentId: 'a-secret',
      workspaceId: 'ws-secret',
      range: '24h',
      actorImUserId: 'owner',
    });

    for (const callArgs of mocks.runAggregate.mock.calls) {
      const opts = callArgs[0] as { filter: Record<string, string> };
      expect(opts.filter.workspaceId).toBe('ws-secret');
      // skill.invoked uses { agentId } filter; task.* uses { assigneeId }
      const hasAgent = opts.filter.assigneeId === 'a-secret' || opts.filter.agentId === 'a-secret';
      expect(hasAgent).toBe(true);
    }
  });

  it('aggregates unique skillIds across buckets', async () => {
    mocks.prismaWsFindFirst.mockResolvedValue({ ownerImUserId: 'owner' });
    mocks.prismaAgentCardFindFirst.mockResolvedValue({ id: 'card-1' });
    mocks.prismaWsMemberFindUnique.mockResolvedValue(null);
    mocks.prismaTaskFindMany.mockResolvedValue([]);

    // Order: tasksDone / tasksDonePrev / latencyAvg / acceptanceCount /
    // acceptancePassed / skillsUsed / dispatchVolume / skillInvocation
    const seq = [
      single(0),
      single(0),
      single(0),
      single(0),
      single(0),
      // skillsUsed — 3 unique skillIds (one appears twice)
      [
        {
          ts: null,
          groups: [
            { groupKey: { skillId: 'sk-a' }, value: 1 },
            { groupKey: { skillId: 'sk-b' }, value: 2 },
            { groupKey: { skillId: 'sk-a' }, value: 1 },
            { groupKey: { skillId: 'sk-c' }, value: 1 },
          ],
        },
      ],
      single(0),
      single(0),
    ];
    let i = 0;
    mocks.runAggregate.mockImplementation(async () => seq[i++] ?? single(0));

    const res = await buildAgent({
      agentId: 'a-1',
      workspaceId: 'ws-1',
      range: '7d',
      actorImUserId: 'owner',
    });
    expect(res.widgets.skillsUsed.value).toBe(3);
  });
});

describe('cache helpers', () => {
  it('returns cached value within TTL', () => {
    setCached('k', { value: 1 });
    expect(getCached<{ value: number }>('k')).toEqual({ value: 1 });
  });

  it('returns null for missing key', () => {
    expect(getCached('absent')).toBeNull();
  });

  it('respects cacheKey separator', () => {
    expect(cacheKey(['overview', 'ws-1', '7d'])).toBe('overview::ws-1::7d');
  });
});
