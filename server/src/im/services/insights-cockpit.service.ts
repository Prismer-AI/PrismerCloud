/**
 * Prismer IM — Insights Cockpit Service (v2.0.8 "one-person company")
 *
 * Powers GET /api/im/insights/cockpit — the workspace owner's single-pane
 * cockpit view. Frontend contract is fixed (see release201 cockpit doc); do
 * NOT mutate the response shape without coordinating with the FE squad
 * (track E-Y).
 *
 * Layer-rule note: this file lives next to insights.service.ts but is
 * intentionally separated to keep the cockpit fan-out (heartbeat + approval
 * + agent-roster joins) from the 12 §7 widget builders. They share the same
 * IMTask source but compose very differently — coupling them would force
 * every cockpit change through the 8-widget cache key surface.
 *
 * Range semantics:
 *   - `24h` → 24 hourly buckets ending now
 *   - `7d` / `30d` / `90d` → N daily buckets ending today (inclusive)
 *
 * All time math is UTC. Heartbeat-stuck window is hard-coded to 45s
 * (matches doc 04 §3.4 daemon heartbeat budget).
 */
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import type { ApprovalService } from './approval.service';

// Local row shapes — `prisma` is dynamically typed (lib/prisma.ts returns
// `any` to bridge the SQLite ⇄ MySQL client union), so we annotate the
// projections we use here to keep tsc strict-mode happy.
type TaskCostRow = { id: string; cost: number | null };
type TaskBucketRow = { completedAt: Date | null; cost: number | null };
type TaskCostOnlyRow = { cost: number | null };
type AgentCardLite = { imUserId: string; name: string; status: string };
type AgentCardNameLite = { imUserId: string; name: string };
type AgentTaskRow = {
  assigneeId: string | null;
  status: string;
  currentPhase: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cost: number | null;
  lastHeartbeatAt: Date | null;
};
type StuckTaskRow = {
  id: string;
  title: string;
  assigneeId: string | null;
  currentPhase: string | null;
  updatedAt: Date;
};
type AssigneeGroupRow = { assigneeId: string | null };

const log = createModuleLogger('InsightsCockpitService');

export type CockpitRange = '24h' | '7d' | '30d' | '90d';

const VALID_RANGES = new Set<CockpitRange>(['24h', '7d', '30d', '90d']);
const HEARTBEAT_STUCK_MS = 45_000;
const STUCK_OVER_4H_MS = 4 * 3600_000;
const AGENT_AVG_LOOKBACK_MS = 30 * 86_400_000;
const STUCK_TASKS_LIMIT = 20;

function isValidRange(r: string): r is CockpitRange {
  return VALID_RANGES.has(r as CockpitRange);
}

// ── Time helpers (UTC) ────────────────────────────────────────────────────────

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function addHoursUtc(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3600_000);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── Response shape ────────────────────────────────────────────────────────────

export interface CockpitTodaySection {
  tasksCompleted: { value: number; deltaVsYesterday: number };
  costToday: { value: number; deltaVsYesterday: number; currency: 'credits' };
  running: number;
  stuck: number;
  pendingApprovals: number;
  stuckOver4h: number;
}

export interface CockpitTrendsSection {
  deliveryDaily: Array<{ ts: string; value: number }>;
  spendDaily: Array<{ ts: string; value: number }>;
  monthSpendToDate: number;
  monthSpendLast: number;
}

export interface CockpitAgentRow {
  agentId: string;
  displayName: string;
  avatarSeed: string;
  todayDone: number;
  weekDone: number;
  avgDurationMs: number | null;
  avgCost: number | null;
  statusDot: 'running' | 'idle' | 'stuck' | 'offline';
}

export interface CockpitStuckTask {
  id: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  stuckSinceMs: number;
  currentPhase: string | null;
}

export interface CockpitResponse {
  workspaceId: string;
  range: { from: string; to: string };
  today: CockpitTodaySection;
  trends: CockpitTrendsSection;
  agents: CockpitAgentRow[];
  stuckTasks: CockpitStuckTask[];
  asOf: string;
}

// ── Workspace owner resolution (for ApprovalService.listApprovals actor) ─────

async function getWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { ownerImUserId: true },
  });
  return ws?.ownerImUserId ?? null;
}

// ── Today counters ────────────────────────────────────────────────────────────

interface TodayCountersDeps {
  approvalService?: Pick<ApprovalService, 'listApprovals'>;
}

async function getTodayCounters(
  workspaceId: string,
  now: Date,
  deps: TodayCountersDeps,
): Promise<CockpitTodaySection> {
  const startOfToday = startOfUtcDay(now);
  const startOfYesterday = addDaysUtc(startOfToday, -1);
  const heartbeatThreshold = new Date(now.getTime() - HEARTBEAT_STUCK_MS);
  const stuckOver4hThreshold = new Date(now.getTime() - STUCK_OVER_4H_MS);

  const stuckOr = {
    OR: [
      { status: 'blocked' },
      { currentPhase: 'stuck' },
      { AND: [{ status: 'running' }, { lastHeartbeatAt: { lt: heartbeatThreshold } }] },
    ],
  } as const;

  const [
    completedToday,
    completedYesterday,
    runningCount,
    stuckCount,
    stuckOver4hCount,
    workspaceOwner,
  ] = await Promise.all([
    prisma.iMTask.findMany({
      where: { workspaceId, completedAt: { gte: startOfToday, lt: addDaysUtc(startOfToday, 1) } },
      select: { id: true, cost: true },
    }),
    prisma.iMTask.findMany({
      where: { workspaceId, completedAt: { gte: startOfYesterday, lt: startOfToday } },
      select: { id: true, cost: true },
    }),
    prisma.iMTask.count({
      where: { workspaceId, status: { in: ['running', 'assigned'] } },
    }),
    prisma.iMTask.count({ where: { workspaceId, ...stuckOr } }),
    prisma.iMTask.count({
      where: {
        workspaceId,
        ...stuckOr,
        updatedAt: { lt: stuckOver4hThreshold },
      },
    }),
    getWorkspaceOwnerId(workspaceId),
  ]);

  const todayRows = completedToday as TaskCostRow[];
  const yesterdayRows = completedYesterday as TaskCostRow[];
  const todayCount = todayRows.length;
  const yesterdayCount = yesterdayRows.length;
  const todayCost = round4(todayRows.reduce((s: number, t: TaskCostRow) => s + (t.cost ?? 0), 0));
  const yesterdayCost = round4(
    yesterdayRows.reduce((s: number, t: TaskCostRow) => s + (t.cost ?? 0), 0),
  );

  // Pending approvals — uses workspace owner as actor (contract). Falls
  // back to 0 when no owner can be resolved (deleted workspace edge case;
  // assertWorkspaceMember in handler should have already 404'd).
  let pendingApprovals = 0;
  if (deps.approvalService && workspaceOwner) {
    try {
      const pending = await deps.approvalService.listApprovals(workspaceOwner, {
        workspaceId,
        status: 'pending',
        limit: 100,
      });
      pendingApprovals = pending.length;
    } catch (err) {
      log.warn?.(
        `[InsightsCockpit] pending approvals lookup failed for ws=${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  return {
    tasksCompleted: {
      value: todayCount,
      deltaVsYesterday: todayCount - yesterdayCount,
    },
    costToday: {
      value: todayCost,
      deltaVsYesterday: round4(todayCost - yesterdayCost),
      currency: 'credits',
    },
    running: runningCount,
    stuck: stuckCount,
    pendingApprovals,
    stuckOver4h: stuckOver4hCount,
  };
}

// ── Trends ────────────────────────────────────────────────────────────────────

interface BucketWindow {
  buckets: Array<{ start: Date; end: Date }>;
}

function buildBucketWindow(range: CockpitRange, now: Date): BucketWindow {
  const buckets: Array<{ start: Date; end: Date }> = [];
  if (range === '24h') {
    // 24 hourly buckets ending at the current top-of-hour-incl-now boundary.
    const top = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    const end = addHoursUtc(top, 1); // include current partial hour
    for (let i = 23; i >= 0; i--) {
      const s = addHoursUtc(end, -(i + 1));
      const e = addHoursUtc(s, 1);
      buckets.push({ start: s, end: e });
    }
  } else {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const today = startOfUtcDay(now);
    const end = addDaysUtc(today, 1);
    for (let i = days - 1; i >= 0; i--) {
      const s = addDaysUtc(end, -(i + 1));
      const e = addDaysUtc(s, 1);
      buckets.push({ start: s, end: e });
    }
  }
  return { buckets };
}

async function getTrends(workspaceId: string, range: CockpitRange, now: Date): Promise<CockpitTrendsSection> {
  const { buckets } = buildBucketWindow(range, now);
  const windowStart = buckets[0]?.start ?? now;
  const windowEnd = buckets[buckets.length - 1]?.end ?? now;

  // One scan over completed tasks in the window, then bucket in JS. Avoids
  // N round-trips (would trigger "[insights] aggregate N+1" forbidden log).
  const rows = (await prisma.iMTask.findMany({
    where: {
      workspaceId,
      completedAt: { gte: windowStart, lt: windowEnd },
    },
    select: { completedAt: true, cost: true },
  })) as TaskBucketRow[];

  const deliveryDaily = buckets.map((b) => ({ ts: b.start.toISOString(), value: 0 }));
  const spendDaily = buckets.map((b) => ({ ts: b.start.toISOString(), value: 0 }));

  for (const row of rows) {
    if (!row.completedAt) continue;
    const t = row.completedAt.getTime();
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (t >= b.start.getTime() && t < b.end.getTime()) {
        deliveryDaily[i].value += 1;
        spendDaily[i].value = round4(spendDaily[i].value + (row.cost ?? 0));
        break;
      }
    }
  }

  // Month-to-date spend + previous-month same-day-of-month accumulator.
  const startOfThisMonth = startOfUtcMonth(now);
  const elapsedSinceMonthStart = now.getTime() - startOfThisMonth.getTime();
  const startOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthCutoff = new Date(startOfLastMonth.getTime() + elapsedSinceMonthStart);

  const [monthRowsRaw, lastMonthRowsRaw] = await Promise.all([
    prisma.iMTask.findMany({
      where: { workspaceId, completedAt: { gte: startOfThisMonth, lte: now } },
      select: { cost: true },
    }),
    prisma.iMTask.findMany({
      where: { workspaceId, completedAt: { gte: startOfLastMonth, lt: lastMonthCutoff } },
      select: { cost: true },
    }),
  ]);
  const monthRows = monthRowsRaw as TaskCostOnlyRow[];
  const lastMonthRows = lastMonthRowsRaw as TaskCostOnlyRow[];

  const monthSpendToDate = round4(monthRows.reduce((s: number, r: TaskCostOnlyRow) => s + (r.cost ?? 0), 0));
  const monthSpendLast = round4(lastMonthRows.reduce((s: number, r: TaskCostOnlyRow) => s + (r.cost ?? 0), 0));

  return { deliveryDaily, spendDaily, monthSpendToDate, monthSpendLast };
}

// ── Agents roster ────────────────────────────────────────────────────────────

async function getAgentsRoster(workspaceId: string, now: Date): Promise<CockpitAgentRow[]> {
  const startOfToday = startOfUtcDay(now);
  const startOfWeek = addDaysUtc(startOfToday, -6); // last 7 days incl today
  const avgWindowStart = new Date(now.getTime() - AGENT_AVG_LOOKBACK_MS);
  const heartbeatThreshold = new Date(now.getTime() - HEARTBEAT_STUCK_MS);

  // Discover all assignees that have any task in this workspace ever (cheap
  // groupBy). For a cockpit we only show agents that produced work — empty
  // roster otherwise.
  const assigneeRows = (await prisma.iMTask.groupBy({
    by: ['assigneeId'],
    where: { workspaceId, assigneeId: { not: null } },
    _count: { _all: true },
  })) as AssigneeGroupRow[];
  const agentIds = assigneeRows
    .map((r: AssigneeGroupRow) => r.assigneeId)
    .filter((v: string | null): v is string => !!v);
  if (agentIds.length === 0) return [];

  const [cardsRaw, allTasksRaw] = await Promise.all([
    prisma.iMAgentCard.findMany({
      where: { imUserId: { in: agentIds } },
      select: { imUserId: true, name: true, status: true },
    }),
    prisma.iMTask.findMany({
      where: {
        workspaceId,
        assigneeId: { in: agentIds },
        OR: [
          { completedAt: { gte: avgWindowStart } },
          { status: { in: ['running', 'assigned', 'blocked'] } },
          { currentPhase: 'stuck' },
          { updatedAt: { gte: avgWindowStart } },
        ],
      },
      select: {
        assigneeId: true,
        status: true,
        currentPhase: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        cost: true,
        lastHeartbeatAt: true,
      },
    }),
  ]);
  const cards = cardsRaw as AgentCardLite[];
  const allTasks = allTasksRaw as AgentTaskRow[];

  const cardMap = new Map<string, AgentCardLite>(cards.map((c: AgentCardLite) => [c.imUserId, c]));
  const tasksByAgent = new Map<string, AgentTaskRow[]>();
  for (const t of allTasks) {
    if (!t.assigneeId) continue;
    const arr = tasksByAgent.get(t.assigneeId) ?? [];
    arr.push(t);
    tasksByAgent.set(t.assigneeId, arr);
  }

  const rows: CockpitAgentRow[] = agentIds.map((agentId: string) => {
    const card = cardMap.get(agentId);
    const tasks = tasksByAgent.get(agentId) ?? [];

    let todayDone = 0;
    let weekDone = 0;
    const completedRecent: Array<{ durationMs: number; cost: number }> = [];
    let latestTask: AgentTaskRow | null = null;

    for (const t of tasks) {
      if (t.completedAt) {
        if (t.completedAt >= startOfToday) todayDone++;
        if (t.completedAt >= startOfWeek) weekDone++;
        if (t.completedAt >= avgWindowStart) {
          const created = t.createdAt?.getTime() ?? t.completedAt.getTime();
          completedRecent.push({
            durationMs: Math.max(0, t.completedAt.getTime() - created),
            cost: t.cost ?? 0,
          });
        }
      }
      const tStamp = t.updatedAt ?? t.createdAt;
      if (tStamp && (!latestTask || (latestTask.updatedAt ?? latestTask.createdAt) < tStamp)) {
        latestTask = t;
      }
    }

    const avgDurationMs = completedRecent.length
      ? Math.round(completedRecent.reduce((s, r) => s + r.durationMs, 0) / completedRecent.length)
      : null;
    const avgCost = completedRecent.length
      ? round4(completedRecent.reduce((s, r) => s + r.cost, 0) / completedRecent.length)
      : null;

    let statusDot: CockpitAgentRow['statusDot'];
    const cardStatus = card?.status;
    if (!card || cardStatus === 'offline') {
      statusDot = 'offline';
    } else if (latestTask) {
      const stuckByPhase = latestTask.currentPhase === 'stuck';
      const stuckByStatus = latestTask.status === 'blocked';
      const stuckByHeartbeat =
        latestTask.status === 'running' &&
        latestTask.lastHeartbeatAt != null &&
        latestTask.lastHeartbeatAt < heartbeatThreshold;
      if (stuckByPhase || stuckByStatus || stuckByHeartbeat) statusDot = 'stuck';
      else if (latestTask.status === 'running' || latestTask.status === 'assigned') statusDot = 'running';
      else statusDot = 'idle';
    } else {
      statusDot = 'idle';
    }

    return {
      agentId,
      displayName: card?.name ?? agentId,
      avatarSeed: agentId,
      todayDone,
      weekDone,
      avgDurationMs,
      avgCost,
      statusDot,
    };
  });

  // Sort: most active today first, then weekDone, then alpha.
  rows.sort((a, b) => {
    if (b.todayDone !== a.todayDone) return b.todayDone - a.todayDone;
    if (b.weekDone !== a.weekDone) return b.weekDone - a.weekDone;
    return a.displayName.localeCompare(b.displayName);
  });

  return rows;
}

// ── Stuck tasks (top N) ──────────────────────────────────────────────────────

async function getStuckTasks(workspaceId: string, now: Date): Promise<CockpitStuckTask[]> {
  // Per contract: ONLY status='blocked' OR currentPhase='stuck' (not the
  // heartbeat-derived stuck — that one is a transient signal and we keep
  // the stuck-list scoped to the "needs human" set).
  const tasks = (await prisma.iMTask.findMany({
    where: {
      workspaceId,
      OR: [{ status: 'blocked' }, { currentPhase: 'stuck' }],
    },
    select: {
      id: true,
      title: true,
      assigneeId: true,
      currentPhase: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: STUCK_TASKS_LIMIT,
  })) as StuckTaskRow[];
  if (tasks.length === 0) return [];

  const assigneeIds = Array.from(
    new Set(tasks.map((t: StuckTaskRow) => t.assigneeId).filter((v: string | null): v is string => !!v)),
  );
  const cards = (assigneeIds.length
    ? await prisma.iMAgentCard.findMany({
        where: { imUserId: { in: assigneeIds } },
        select: { imUserId: true, name: true },
      })
    : []) as AgentCardNameLite[];
  const nameMap = new Map<string, string>(cards.map((c: AgentCardNameLite) => [c.imUserId, c.name]));

  return tasks.map((t: StuckTaskRow) => ({
    id: t.id,
    title: t.title,
    assigneeId: t.assigneeId ?? null,
    assigneeName: t.assigneeId ? nameMap.get(t.assigneeId) ?? null : null,
    stuckSinceMs: Math.max(0, now.getTime() - (t.updatedAt?.getTime() ?? now.getTime())),
    currentPhase: t.currentPhase ?? null,
  }));
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface GetCockpitArgs {
  workspaceId: string;
  range?: CockpitRange;
  now?: Date;
  approvalService?: Pick<ApprovalService, 'listApprovals'>;
}

export async function getCockpit(args: GetCockpitArgs): Promise<CockpitResponse> {
  const range: CockpitRange = args.range && isValidRange(args.range) ? args.range : '7d';
  const now = args.now ?? new Date();
  const { workspaceId } = args;

  // Range window for the response header (broad — last 24h | 7d | 30d | 90d).
  const rangeMs =
    range === '24h' ? 24 * 3600_000 : range === '7d' ? 7 * 86_400_000 : range === '30d' ? 30 * 86_400_000 : 90 * 86_400_000;
  const rangeFrom = new Date(now.getTime() - rangeMs);

  const [today, trends, agents, stuckTasks] = await Promise.all([
    getTodayCounters(workspaceId, now, { approvalService: args.approvalService }),
    getTrends(workspaceId, range, now),
    getAgentsRoster(workspaceId, now),
    getStuckTasks(workspaceId, now),
  ]);

  return {
    workspaceId,
    range: { from: rangeFrom.toISOString(), to: now.toISOString() },
    today,
    trends,
    agents,
    stuckTasks,
    asOf: now.toISOString(),
  };
}

// Exported for tests.
export const __testables = {
  startOfUtcDay,
  startOfUtcMonth,
  buildBucketWindow,
  round4,
  isValidRange,
  HEARTBEAT_STUCK_MS,
  STUCK_OVER_4H_MS,
};
