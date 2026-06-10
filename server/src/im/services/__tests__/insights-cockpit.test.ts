/**
 * Unit test for InsightsCockpitService (v2.0.8 one-person-company cockpit).
 *
 * Run:
 *   npx vitest run src/im/services/__tests__/insights-cockpit.test.ts
 *
 * Mocks prisma + ApprovalService. Covers:
 *   - today.tasksCompleted/costToday delta-vs-yesterday math
 *   - today.stuck three OR conditions (status='blocked', currentPhase='stuck',
 *     status='running' + lastHeartbeatAt < now-45s)
 *   - today.pendingApprovals comes from ApprovalService.listApprovals
 *   - trends.deliveryDaily/spendDaily bucket count + length per range
 *   - trends.monthSpendToDate / monthSpendLast accumulation
 *   - agents[] statusDot derivation (running / idle / stuck / offline)
 *   - stuckTasks[] shape + stuckSinceMs
 *   - response top-level shape
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaceFindFirst: vi.fn(),
  taskFindMany: vi.fn(),
  taskCount: vi.fn(),
  taskGroupBy: vi.fn(),
  agentCardFindMany: vi.fn(),
  listApprovals: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    iMWorkspace: { findFirst: mocks.workspaceFindFirst },
    iMTask: {
      findMany: mocks.taskFindMany,
      count: mocks.taskCount,
      groupBy: mocks.taskGroupBy,
    },
    iMAgentCard: { findMany: mocks.agentCardFindMany },
  },
}));

vi.mock('@/lib/logger', () => ({
  createModuleLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
}));

import { getCockpit, __testables } from '../insights-cockpit.service';

const WS = 'ws_test';
const OWNER = 'usr_owner';
const NOW = new Date('2026-05-30T12:00:00.000Z'); // mid-day UTC, mid-month

// ── prisma mock router ────────────────────────────────────────────────────────
//
// getCockpit fans out 4 parallel sub-queries (today / trends / agents /
// stuckTasks), and several of them issue multiple prisma calls. We route by
// inspecting the where clause shape — this keeps test setup readable while
// still giving each call a distinct response.

interface FindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
}

const startOfToday = __testables.startOfUtcDay(NOW);
const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
const startOfThisMonth = __testables.startOfUtcMonth(NOW);
const startOfLastMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));

function gteEquals(field: unknown, expected: Date): boolean {
  if (!field || typeof field !== 'object') return false;
  const f = field as { gte?: Date };
  return f.gte instanceof Date && f.gte.getTime() === expected.getTime();
}
function ltEquals(field: unknown, expected: Date): boolean {
  if (!field || typeof field !== 'object') return false;
  const f = field as { lt?: Date };
  return f.lt instanceof Date && f.lt.getTime() === expected.getTime();
}
function hasLte(field: unknown): boolean {
  if (!field || typeof field !== 'object') return false;
  return (field as { lte?: Date }).lte instanceof Date;
}

// Mock task population.
const COMPLETED_TODAY = [
  { id: 't1', cost: 0.5, completedAt: new Date('2026-05-30T08:00:00Z'), createdAt: new Date('2026-05-30T07:55:00Z') },
  { id: 't2', cost: 1.25, completedAt: new Date('2026-05-30T09:00:00Z'), createdAt: new Date('2026-05-30T08:50:00Z') },
];
const COMPLETED_YESTERDAY = [
  { id: 't3', cost: 0.4, completedAt: new Date('2026-05-29T08:00:00Z'), createdAt: new Date('2026-05-29T07:50:00Z') },
];

const STUCK_TASKS = [
  {
    id: 's1',
    title: 'stuck by blocked',
    assigneeId: 'agent_a',
    currentPhase: null,
    updatedAt: new Date(NOW.getTime() - 2 * 3600_000), // 2h ago
  },
  {
    id: 's2',
    title: 'stuck by phase',
    assigneeId: 'agent_b',
    currentPhase: 'stuck',
    updatedAt: new Date(NOW.getTime() - 5 * 3600_000), // 5h ago — over-4h
  },
];

function defaultRouter() {
  mocks.workspaceFindFirst.mockResolvedValue({ ownerImUserId: OWNER });

  mocks.taskFindMany.mockImplementation(async (args: FindManyArgs) => {
    const where = args.where ?? {};
    const completedAt = (where as { completedAt?: unknown }).completedAt;
    const orderBy = args.orderBy as { updatedAt?: string } | undefined;

    // today counters — completedToday (gte=startOfToday, lt=startOfTomorrow)
    if (gteEquals(completedAt, startOfToday)) {
      const lt = (completedAt as { lt?: Date }).lt;
      if (lt && lt.getTime() === startOfToday.getTime() + 86_400_000) {
        return COMPLETED_TODAY.map((t) => ({ id: t.id, cost: t.cost }));
      }
    }
    // today counters — completedYesterday (gte=startOfYesterday, lt=startOfToday)
    if (gteEquals(completedAt, startOfYesterday) && ltEquals(completedAt, startOfToday)) {
      return COMPLETED_YESTERDAY.map((t) => ({ id: t.id, cost: t.cost }));
    }
    // trends monthSpendToDate (gte=startOfThisMonth, lte=now)
    if (gteEquals(completedAt, startOfThisMonth) && hasLte(completedAt)) {
      return [{ cost: 5.5 }, { cost: 1.25 }];
    }
    // trends monthSpendLast (gte=startOfLastMonth)
    if (gteEquals(completedAt, startOfLastMonth)) {
      return [{ cost: 3 }, { cost: 0.75 }];
    }
    // trends bucket scan: gte=windowStart, lt=windowEnd (catch-all gte+lt pair)
    if (completedAt && (completedAt as { gte?: Date }).gte && (completedAt as { lt?: Date }).lt) {
      return [...COMPLETED_TODAY, ...COMPLETED_YESTERDAY].map((t) => ({
        completedAt: t.completedAt,
        cost: t.cost,
      }));
    }
    // agents roster — assignee task window
    if ((where as { assigneeId?: unknown }).assigneeId && (where as { OR?: unknown }).OR) {
      return [
        // agent_a: most recent task is running
        {
          assigneeId: 'agent_a',
          status: 'running',
          currentPhase: null,
          completedAt: null,
          createdAt: new Date(NOW.getTime() - 600_000),
          updatedAt: new Date(NOW.getTime() - 30_000),
          cost: 0,
          lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
        },
        // agent_a: prior completed task — drives avgDuration/avgCost
        {
          assigneeId: 'agent_a',
          status: 'completed',
          currentPhase: null,
          completedAt: new Date('2026-05-30T08:00:00Z'),
          createdAt: new Date('2026-05-30T07:55:00Z'),
          updatedAt: new Date('2026-05-30T08:00:00Z'),
          cost: 0.5,
          lastHeartbeatAt: null,
        },
        // agent_b: most recent task is stuck by phase
        {
          assigneeId: 'agent_b',
          status: 'running',
          currentPhase: 'stuck',
          completedAt: null,
          createdAt: new Date(NOW.getTime() - 3600_000),
          updatedAt: new Date(NOW.getTime() - 60_000),
          cost: 0,
          lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
        },
        // agent_c: only an old idle-ish update
        {
          assigneeId: 'agent_c',
          status: 'completed',
          currentPhase: null,
          completedAt: new Date('2026-05-25T08:00:00Z'),
          createdAt: new Date('2026-05-25T07:00:00Z'),
          updatedAt: new Date('2026-05-25T08:00:00Z'),
          cost: 1,
          lastHeartbeatAt: null,
        },
      ];
    }
    // stuck tasks list
    if (orderBy && orderBy.updatedAt === 'asc') {
      return STUCK_TASKS;
    }
    return [];
  });

  // today.running, today.stuck, today.stuckOver4h
  mocks.taskCount.mockImplementation(async (args: FindManyArgs) => {
    const where = args.where ?? {};
    if ((where as { status?: { in?: string[] } }).status?.in?.includes('running')) {
      return 3; // running count
    }
    if ((where as { updatedAt?: unknown }).updatedAt) {
      return 1; // stuckOver4h
    }
    return 2; // stuck
  });

  mocks.taskGroupBy.mockResolvedValue([
    { assigneeId: 'agent_a' },
    { assigneeId: 'agent_b' },
    { assigneeId: 'agent_c' },
  ]);

  mocks.agentCardFindMany.mockImplementation(async (args: FindManyArgs) => {
    const sel = args.select ?? {};
    const wantStatus = (sel as { status?: boolean }).status === true;
    if (wantStatus) {
      // roster card lookup
      return [
        { imUserId: 'agent_a', name: 'Alpha Agent', status: 'online' },
        { imUserId: 'agent_b', name: 'Beta Agent', status: 'online' },
        // agent_c: missing card → statusDot should be 'offline'
      ];
    }
    // stuck-tasks name lookup
    return [
      { imUserId: 'agent_a', name: 'Alpha Agent' },
      { imUserId: 'agent_b', name: 'Beta Agent' },
    ];
  });

  mocks.listApprovals.mockResolvedValue([{ id: 'ap1' }, { id: 'ap2' }, { id: 'ap3' }]);
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  defaultRouter();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getCockpit — top-level shape', () => {
  it('returns workspaceId / range / asOf and all four sections', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      range: '7d',
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.workspaceId).toBe(WS);
    expect(res.asOf).toBe(NOW.toISOString());
    expect(res.range.to).toBe(NOW.toISOString());
    expect(res.range.from).toBe(new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
    expect(res.today).toBeTruthy();
    expect(res.trends).toBeTruthy();
    expect(Array.isArray(res.agents)).toBe(true);
    expect(Array.isArray(res.stuckTasks)).toBe(true);
  });

  it('defaults range to 7d when omitted', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.trends.deliveryDaily).toHaveLength(7);
  });
});

describe('today section', () => {
  it('computes tasksCompleted.value + deltaVsYesterday correctly', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      range: '7d',
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.tasksCompleted.value).toBe(2); // 2 completed today
    expect(res.today.tasksCompleted.deltaVsYesterday).toBe(1); // 2 - 1
  });

  it('computes costToday + deltaVsYesterday (rounded to 4 decimals)', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.costToday.value).toBe(1.75); // 0.5 + 1.25
    expect(res.today.costToday.deltaVsYesterday).toBe(1.35); // 1.75 - 0.4
    expect(res.today.costToday.currency).toBe('credits');
  });

  it('counts running tasks via status IN (running, assigned)', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.running).toBe(3);
  });

  it('counts pendingApprovals via ApprovalService.listApprovals with workspace owner', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.pendingApprovals).toBe(3);
    expect(mocks.listApprovals).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ workspaceId: WS, status: 'pending' }),
    );
  });

  it('falls back to 0 pendingApprovals when service throws', async () => {
    mocks.listApprovals.mockRejectedValueOnce(new Error('boom'));
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.pendingApprovals).toBe(0);
  });

  it('stuck count is taken from prisma.count and stuckOver4h is the over-4h subset', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.today.stuck).toBe(2);
    expect(res.today.stuckOver4h).toBe(1);
  });

  it('stuck query covers all three OR branches (blocked / phase=stuck / heartbeat)', async () => {
    await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    const stuckCall = mocks.taskCount.mock.calls.find((args: unknown[]) => {
      const where = (args[0] as { where?: { OR?: unknown[] } })?.where;
      return where && Array.isArray(where.OR);
    });
    expect(stuckCall).toBeTruthy();
    const where = (stuckCall![0] as { where: { OR: Array<Record<string, unknown>> } }).where;
    expect(where.OR).toHaveLength(3);
    // 1) status=blocked
    expect(where.OR[0]).toEqual({ status: 'blocked' });
    // 2) currentPhase=stuck
    expect(where.OR[1]).toEqual({ currentPhase: 'stuck' });
    // 3) status=running AND lastHeartbeatAt < now-45s
    const branch3 = where.OR[2] as { AND: Array<Record<string, unknown>> };
    expect(branch3.AND[0]).toEqual({ status: 'running' });
    const hb = branch3.AND[1] as { lastHeartbeatAt: { lt: Date } };
    expect(hb.lastHeartbeatAt.lt.getTime()).toBe(NOW.getTime() - __testables.HEARTBEAT_STUCK_MS);
  });
});

describe('trends section', () => {
  it('produces 24 hourly buckets for range=24h', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      range: '24h',
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.trends.deliveryDaily).toHaveLength(24);
    expect(res.trends.spendDaily).toHaveLength(24);
  });

  it('produces N daily buckets for range=30d / 90d', async () => {
    const res30 = await getCockpit({
      workspaceId: WS,
      range: '30d',
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res30.trends.deliveryDaily).toHaveLength(30);
    const res90 = await getCockpit({
      workspaceId: WS,
      range: '90d',
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res90.trends.deliveryDaily).toHaveLength(90);
  });

  it('aggregates monthSpendToDate and monthSpendLast', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.trends.monthSpendToDate).toBe(6.75); // 5.5 + 1.25
    expect(res.trends.monthSpendLast).toBe(3.75); // 3 + 0.75
  });
});

describe('agents roster', () => {
  it('returns one row per assignee with correct displayName/avatarSeed', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    const byId = new Map(res.agents.map((a) => [a.agentId, a]));
    expect(byId.get('agent_a')?.displayName).toBe('Alpha Agent');
    expect(byId.get('agent_a')?.avatarSeed).toBe('agent_a');
    // agent_c has no card → falls back to id as displayName
    expect(byId.get('agent_c')?.displayName).toBe('agent_c');
  });

  it('derives statusDot: running (latest task running), stuck (phase=stuck), offline (no card)', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    const byId = new Map(res.agents.map((a) => [a.agentId, a]));
    expect(byId.get('agent_a')?.statusDot).toBe('running');
    expect(byId.get('agent_b')?.statusDot).toBe('stuck');
    expect(byId.get('agent_c')?.statusDot).toBe('offline');
  });

  it('computes avgDurationMs / avgCost from completed tasks in last 30 days', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    const a = res.agents.find((r) => r.agentId === 'agent_a');
    // agent_a has 1 completed task within 30d (cost=0.5, dur = 5min)
    expect(a?.avgCost).toBe(0.5);
    expect(a?.avgDurationMs).toBe(5 * 60_000);
  });
});

describe('stuckTasks list', () => {
  it('returns shape including stuckSinceMs and assigneeName lookup', async () => {
    const res = await getCockpit({
      workspaceId: WS,
      now: NOW,
      approvalService: { listApprovals: mocks.listApprovals },
    });
    expect(res.stuckTasks).toHaveLength(2);
    const [s1, s2] = res.stuckTasks;
    expect(s1.id).toBe('s1');
    expect(s1.assigneeName).toBe('Alpha Agent');
    expect(s1.stuckSinceMs).toBe(2 * 3600_000);
    expect(s2.id).toBe('s2');
    expect(s2.currentPhase).toBe('stuck');
  });
});
