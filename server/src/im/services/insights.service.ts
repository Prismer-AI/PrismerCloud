/**
 * Prismer IM — Insights Service (v2.0.7 release201/12 §7)
 *
 * Workspace-owner-facing observability surface BFF data assembler.
 * Consumes release201/11 metric aggregate channel (via the exported
 * `runAggregate` helper from `metrics.ts`) plus direct IMProject/IMTask
 * SELECTs for current-state widgets that are not event-streamed
 * (e.g. "active projects" §4.2).
 *
 * Forbidden patterns (12 §0.2.4):
 *   - log "[insights] aggregate N+1"
 *   - log "[insights] missing workspaceId filter"
 *   - log "[insights] cache stale beyond 60s"
 *
 * All endpoint handlers must call assertWorkspaceMember() before invoking
 * any aggregate (cross-workspace leakage prevention).
 */
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { runAggregate, type BucketResult } from '../api/metrics';

const log = createModuleLogger('InsightsService');

export type InsightsRange = '24h' | '7d' | '30d' | '90d';

const RANGE_MS: Record<InsightsRange, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

export interface RangeWindow {
  from: Date;
  to: Date;
  previous: { from: Date; to: Date };
}

export function resolveRange(range: InsightsRange, now = new Date()): RangeWindow {
  const ms = RANGE_MS[range] ?? RANGE_MS['7d'];
  const to = now;
  const from = new Date(to.getTime() - ms);
  return {
    from,
    to,
    previous: {
      from: new Date(from.getTime() - ms),
      to: from,
    },
  };
}

export type WidgetType = 'counter' | 'sparkline' | 'timeseries' | 'bar' | 'table' | 'grid';

export interface CounterWidget {
  type: 'counter';
  value: number;
  delta?: number | null;
  unit?: string;
}

export interface SparklineWidget {
  type: 'sparkline';
  buckets: Array<{ ts: string; value: number | null }>;
  summary?: { avgMs?: number; total?: number };
}

export interface TimeseriesWidget {
  type: 'timeseries';
  buckets: Array<{ ts: string; value: number | null }>;
}

export interface BarItem {
  label: string;
  value: number;
}
export interface BarWidget {
  type: 'bar';
  items: BarItem[];
}

export interface TableRow {
  id: string;
  cells: Array<{ key: string; value: string | number | null }>;
}
export interface TableWidget {
  type: 'table';
  columns: string[];
  rows: TableRow[];
}

export interface StatusGridWidget {
  type: 'grid';
  columns: string[];
  /**
   * Optional `unscoped=true` flag marks rows whose source tasks had
   * `projectId IS NULL`. Frontend may render those in italic + show a
   * tooltip explaining the row aggregates tasks not yet assigned to a
   * project. v2.0.8 hotfix Bug 1.
   */
  rows: Array<{ label: string; counts: Record<string, number>; unscoped?: boolean }>;
}

export type AnyWidget = CounterWidget | SparklineWidget | TimeseriesWidget | BarWidget | TableWidget | StatusGridWidget;

// ── Workspace member assertion ─────────────────────────────────────────────────
// release201/12 §0.2.4 — every endpoint MUST gate on workspace membership
// before invoking aggregate (cross-workspace leakage prevention).
export class WorkspaceForbiddenError extends Error {
  readonly status = 403 as const;
  readonly code = 'WORKSPACE_FORBIDDEN' as const;
  constructor(workspaceId: string) {
    super(`Not a member of workspace ${workspaceId}`);
  }
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = 'WORKSPACE_NOT_FOUND' as const;
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} not found`);
  }
}

export async function assertWorkspaceMember(workspaceId: string, actorImUserId: string): Promise<void> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { ownerImUserId: true },
  });
  if (!ws) throw new WorkspaceNotFoundError(workspaceId);
  if (ws.ownerImUserId === actorImUserId) return;
  const member = await prisma.iMWorkspaceMember.findFirst({
    where: { workspaceId, memberImUserId: actorImUserId },
    select: { id: true },
  });
  if (!member) throw new WorkspaceForbiddenError(workspaceId);
}

// ── Aggregate helpers ──────────────────────────────────────────────────────────

interface AggOptions {
  namespace: string;
  name: string;
  // release201/20 Gap C F5 — p50/p95/p99 enabled so getAgentMetrics can
  // surface dispatch latency percentiles via the same callAggregate path.
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p95' | 'p99';
  from: Date;
  to: Date;
  workspaceId: string;
  filter?: Record<string, string>;
  groupBy?: string[];
  bucket?: '1d' | '1h' | '5m';
}

async function callAggregate(opts: AggOptions): Promise<BucketResult[]> {
  const filter = { workspaceId: opts.workspaceId, ...(opts.filter ?? {}) };
  return runAggregate({
    namespace: opts.namespace,
    name: opts.name,
    agg: opts.agg,
    from: opts.from,
    to: opts.to,
    filter,
    groupBy: opts.groupBy ?? [],
    bucket: opts.bucket,
  });
}

function totalFromBuckets(buckets: BucketResult[]): number {
  let total = 0;
  for (const b of buckets) for (const g of b.groups) total += Number(g.value ?? 0);
  return total;
}

function timeseriesFromBuckets(buckets: BucketResult[]): TimeseriesWidget {
  const out: TimeseriesWidget = { type: 'timeseries', buckets: [] };
  for (const b of buckets) {
    if (!b.ts) continue;
    const value = b.groups.reduce((sum, g) => sum + Number(g.value ?? 0), 0);
    out.buckets.push({ ts: b.ts, value });
  }
  return out;
}

function sparklineFromBuckets(buckets: BucketResult[], summary?: SparklineWidget['summary']): SparklineWidget {
  const out: SparklineWidget = { type: 'sparkline', buckets: [], summary };
  for (const b of buckets) {
    if (!b.ts) continue;
    const value = b.groups.length ? Number(b.groups[0].value ?? 0) : null;
    out.buckets.push({ ts: b.ts, value });
  }
  return out;
}

function barFromBuckets(buckets: BucketResult[], groupKey: string, limit = 5): BarWidget {
  const flat = new Map<string, number>();
  for (const b of buckets) {
    for (const g of b.groups) {
      const key = g.groupKey[groupKey] ?? '(none)';
      flat.set(key, (flat.get(key) ?? 0) + Number(g.value ?? 0));
    }
  }
  const items = [...flat.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
  return { type: 'bar', items };
}

// Status string-value metrics (namespace=`task.acceptance`, name=`status_changed`)
// bucket their outcomes by the embedded `dims.acceptanceStatus` enum that
// the emitter mirrors alongside `value_string`. Aggregate rows arrive with
// value=null for string metrics (the SQL only sums value_numeric), so the
// rate is computed by issuing two `count` aggregates: one unfiltered (the
// denominator), one filtered to `acceptanceStatus:passed` (the numerator).
// Without the dim mirror the rate would always read 0/N because filtering
// by raw value_string is not exposed by /aggregate (only JSON dims).

// ── Overview view (§4) ─────────────────────────────────────────────────────────

export interface OverviewResponse {
  workspaceId: string;
  range: {
    from: string;
    to: string;
    previous: { from: string; to: string };
  };
  widgets: {
    tasksCompleted: CounterWidget;
    acceptancePassRate: CounterWidget;
    skillsPublished: CounterWidget;
    activeProjects: CounterWidget;
    taskVelocity: TimeseriesWidget;
    approvalLatency: SparklineWidget;
    topCapabilities: BarWidget;
    acceptanceByProject: StatusGridWidget;
  };
  asOf: string;
}

export async function buildOverview(args: { workspaceId: string; range: InsightsRange }): Promise<OverviewResponse> {
  const window = resolveRange(args.range);
  const { workspaceId } = args;

  // Fan-out 8 widget queries in parallel — never serial (12 §0.2.4 "N+1").
  const [
    tasksCompletedCur,
    tasksCompletedPrev,
    acceptanceCur,
    skillsPublishedCur,
    skillsPublishedPrev,
    activeProjectList,
    taskVelocity,
    approvalLatencyBuckets,
    approvalLatencyCur,
    topCapabilities,
    acceptanceByProject,
  ] = await Promise.all([
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.previous.from,
      to: window.previous.to,
      workspaceId,
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
    }),
    callAggregate({
      namespace: 'skill',
      name: 'published',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
    }),
    callAggregate({
      namespace: 'skill',
      name: 'published',
      agg: 'count',
      from: window.previous.from,
      to: window.previous.to,
      workspaceId,
    }),
    // v2.0.8 Bug 1: also surface project names so buildAcceptanceGrid can
    // rename the "(workspace)" pseudo-row when there's exactly one active
    // project (the common single-project workspace case). We previously only
    // queried the count.
    prisma.iMProject.findMany({
      where: { workspaceId, status: 'active' },
      select: { id: true, name: true },
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'approval',
      name: 'decided',
      agg: 'avg',
      from: window.from,
      to: window.to,
      workspaceId,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'approval',
      name: 'decided',
      agg: 'avg',
      from: window.from,
      to: window.to,
      workspaceId,
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      groupBy: ['capability'],
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      groupBy: ['projectId'],
    }),
  ]);

  const tasksCompletedTotal = totalFromBuckets(tasksCompletedCur);
  const tasksCompletedPrevTotal = totalFromBuckets(tasksCompletedPrev);

  // Acceptance pass rate (release201 S13 P0-3):
  //   • emitter writes `value_string='passed'|'failed'|'partial'|'none'`
  //     AND mirrors the status into `dims.acceptanceStatus` (task-acceptance
  //     service §11 emit). Aggregate filter can only target dims, so we
  //     query a second time with `filter=acceptanceStatus:passed`.
  //   • acceptanceTotal denominator = unfiltered count over the same window.
  const acceptancePassedBuckets = await callAggregate({
    namespace: 'task.acceptance',
    name: 'status_changed',
    agg: 'count',
    from: window.from,
    to: window.to,
    workspaceId,
    filter: { acceptanceStatus: 'passed' },
  });

  const acceptanceTotal = totalFromBuckets(acceptanceCur);
  const passedTotal = totalFromBuckets(acceptancePassedBuckets);
  const acceptanceRate = acceptanceTotal > 0 ? passedTotal / acceptanceTotal : 0;

  const approvalAvgMs = (() => {
    let n = 0;
    let sum = 0;
    for (const b of approvalLatencyCur)
      for (const g of b.groups)
        if (g.value != null) {
          sum += Number(g.value);
          n++;
        }
    return n > 0 ? sum / n : 0;
  })();

  return {
    workspaceId,
    range: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previous: {
        from: window.previous.from.toISOString(),
        to: window.previous.to.toISOString(),
      },
    },
    widgets: {
      tasksCompleted: {
        type: 'counter',
        value: tasksCompletedTotal,
        delta: tasksCompletedPrevTotal > 0 ? tasksCompletedTotal - tasksCompletedPrevTotal : null,
      },
      acceptancePassRate: {
        type: 'counter',
        value: acceptanceRate,
        delta: null,
        unit: 'ratio',
      },
      skillsPublished: {
        type: 'counter',
        value: totalFromBuckets(skillsPublishedCur),
        delta: totalFromBuckets(skillsPublishedCur) - totalFromBuckets(skillsPublishedPrev),
      },
      activeProjects: { type: 'counter', value: activeProjectList.length, delta: null },
      taskVelocity: timeseriesFromBuckets(taskVelocity),
      approvalLatency: sparklineFromBuckets(approvalLatencyBuckets, { avgMs: approvalAvgMs }),
      topCapabilities: barFromBuckets(topCapabilities, 'capability', 5),
      acceptanceByProject: buildAcceptanceGrid(acceptanceByProject, activeProjectList),
    },
    asOf: new Date().toISOString(),
  };
}

function buildAcceptanceGrid(
  buckets: BucketResult[],
  activeProjects: Array<{ id: string; name: string }> = [],
): StatusGridWidget {
  // Group by projectId only — release201/11 aggregate does not surface the
  // raw value_string in groupBy mode. v2.0.7 surfaces counts by project; the
  // status breakdown column requires a refined aggregator path documented as
  // future work (Phase 5 acceptance).
  //
  // v2.0.8 Bug 1 — label refinement for the unscoped row:
  //   • If the workspace has exactly 1 active project, rename the
  //     "(workspace)" pseudo-row to that project's name + `unscoped=true`
  //     so the single-project common case shows a friendlier label.
  //   • If 0 or ≥ 2 active projects, keep the literal "(workspace)" label
  //     (and still tag `unscoped=true`) so the frontend can render it in
  //     italic with a tooltip.
  //   • Project rows with a real `projectId` are looked up in
  //     `activeProjects` and replaced with their display name (falls back
  //     to the id if not found, e.g. archived).
  const projectsById = new Map(activeProjects.map((p) => [p.id, p.name]));
  const singleProjectName = activeProjects.length === 1 ? activeProjects[0].name : null;

  const rows: StatusGridWidget['rows'] = [];
  for (const b of buckets) {
    for (const g of b.groups) {
      const projectId = g.groupKey['projectId'];
      const isUnscoped = projectId == null;
      let label: string;
      if (isUnscoped) {
        label = singleProjectName ?? '(workspace)';
      } else {
        label = projectsById.get(projectId) ?? projectId;
      }
      const row: StatusGridWidget['rows'][number] = {
        label,
        counts: { total: Number(g.value ?? 0) },
      };
      if (isUnscoped) row.unscoped = true;
      rows.push(row);
    }
  }
  return {
    type: 'grid',
    columns: ['total'],
    rows,
  };
}

// ── Project view (§5) ──────────────────────────────────────────────────────────

export interface ProjectResponse {
  workspaceId: string;
  projectId: string;
  projectName: string;
  status: 'active' | 'archived';
  memberCount: number;
  range: {
    from: string;
    to: string;
    previous: { from: string; to: string };
  };
  widgets: {
    openTasks: CounterWidget;
    acceptance: CounterWidget;
    /** SUM(IMTask.cost) in credits over completedAt-in-window tasks. */
    cost: CounterWidget;
    daysUntilArchive: CounterWidget;
    burndown: TimeseriesWidget;
    acceptanceByCapability: BarWidget;
    contributors: TableWidget;
    recentFailedTasks: TableWidget;
    pendingApprovals: TableWidget;
  };
  asOf: string;
}

export async function buildProject(args: {
  projectId: string;
  range: InsightsRange;
  actorImUserId: string;
}): Promise<ProjectResponse> {
  const project = await prisma.iMProject.findUnique({
    where: { id: args.projectId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      status: true,
      metadata: true,
    },
  });
  if (!project) throw new WorkspaceNotFoundError(args.projectId);
  await assertWorkspaceMember(project.workspaceId, args.actorImUserId);

  const window = resolveRange(args.range);
  const wsId = project.workspaceId;
  const filter = { projectId: args.projectId };

  const [
    tasksCreatedBuckets,
    tasksCompletedBuckets,
    tasksFailedBuckets,
    acceptanceCount,
    acceptancePassed,
    burndownCreated,
    burndownCompleted,
    burndownFailed,
    acceptanceByCapability,
    contributorAgentBuckets,
    recentFailedTasks,
    pendingApprovals,
    memberCount,
    costAgg,
  ] = await Promise.all([
    callAggregate({
      namespace: 'task',
      name: 'created',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task',
      name: 'failed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      // release201 S13 P0-3 — filter by mirrored acceptanceStatus dim, not
      // `name` (which is the metric name itself, not the value).
      filter: { ...filter, acceptanceStatus: 'passed' },
    }),
    callAggregate({
      namespace: 'task',
      name: 'created',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'task',
      name: 'failed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      groupBy: ['capability'],
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      groupBy: ['assigneeId'],
    }),
    prisma.iMTask.findMany({
      where: {
        workspaceId: wsId,
        projectId: args.projectId,
        status: 'failed',
      },
      select: {
        id: true,
        title: true,
        capability: true,
        assigneeId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.iMTask.findMany({
      where: {
        workspaceId: wsId,
        projectId: args.projectId,
        status: 'review',
        acceptanceStatus: { not: 'passed' },
      },
      select: {
        id: true,
        title: true,
        capability: true,
        assigneeId: true,
        acceptanceStatus: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.iMAgentProjectMembership.count({ where: { projectId: args.projectId } }),
    // Spend: SUM(IMTask.cost) over the project's completedAt-in-window tasks —
    // mirrors the cockpit's cost semantics (keyed off completedAt). Populated
    // by the task-completion cost roll-up in task.service.ts.
    prisma.iMTask.aggregate({
      _sum: { cost: true },
      where: {
        workspaceId: wsId,
        projectId: args.projectId,
        completedAt: { gte: window.from, lte: window.to },
      },
    }),
  ]);

  // Resolve assignee imUserIds → human agent names for the contributors /
  // failed-task / approval tables. Without this the UI rendered the raw CUID
  // (e.g. n3wgczwi1vi) instead of the agent's "CEO" display name.
  const assigneeIds = new Set<string>();
  for (const b of contributorAgentBuckets) {
    for (const g of b.groups) {
      const id = g.groupKey['assigneeId'];
      if (typeof id === 'string' && id) assigneeIds.add(id);
    }
  }
  for (const t of recentFailedTasks as Array<{ assigneeId: string | null }>) {
    if (t.assigneeId) assigneeIds.add(t.assigneeId);
  }
  for (const t of pendingApprovals as Array<{ assigneeId: string | null }>) {
    if (t.assigneeId) assigneeIds.add(t.assigneeId);
  }
  const agentNameMap = new Map<string, string>();
  if (assigneeIds.size > 0) {
    const cards = (await prisma.iMAgentCard.findMany({
      where: { imUserId: { in: [...assigneeIds] } },
      select: { imUserId: true, name: true },
    })) as Array<{ imUserId: string; name: string }>;
    for (const c of cards) agentNameMap.set(c.imUserId, c.name);
  }

  const created = totalFromBuckets(tasksCreatedBuckets);
  const completed = totalFromBuckets(tasksCompletedBuckets);
  const failed = totalFromBuckets(tasksFailedBuckets);
  const openTasks = Math.max(0, created - completed - failed);

  const acceptanceTotal = totalFromBuckets(acceptanceCount);
  const passedTotal = totalFromBuckets(acceptancePassed);

  // BFF-computed daily burndown (12 §5.2 — compute server-side to avoid
  // timezone drift between client browsers in different locales).
  const burndown = computeBurndown(burndownCreated, burndownCompleted, burndownFailed);

  const meta = safeParseJSON(project.metadata);
  const targetIso = typeof meta.targetArchiveAt === 'string' ? meta.targetArchiveAt : null;
  const daysUntilArchive = targetIso
    ? Math.max(0, Math.ceil((new Date(targetIso).getTime() - Date.now()) / 86_400_000))
    : 0;

  return {
    workspaceId: wsId,
    projectId: args.projectId,
    projectName: project.name,
    status: project.status === 'archived' ? 'archived' : 'active',
    memberCount,
    range: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previous: {
        from: window.previous.from.toISOString(),
        to: window.previous.to.toISOString(),
      },
    },
    widgets: {
      openTasks: { type: 'counter', value: openTasks, delta: null },
      acceptance: {
        type: 'counter',
        value: passedTotal,
        delta: acceptanceTotal > 0 ? Math.round((passedTotal / acceptanceTotal) * 100) : null,
        unit: `/${acceptanceTotal}`,
      },
      cost: {
        type: 'counter',
        value: Math.round(((costAgg?._sum?.cost ?? 0) || 0) * 10000) / 10000,
        delta: null,
        unit: 'credits',
      },
      daysUntilArchive: {
        type: 'counter',
        value: daysUntilArchive,
        delta: null,
        unit: 'days',
      },
      burndown,
      acceptanceByCapability: barFromBuckets(acceptanceByCapability, 'capability', 5),
      contributors: buildContributorsTable(contributorAgentBuckets, agentNameMap),
      recentFailedTasks: {
        type: 'table',
        columns: ['title', 'capability', 'assignee'],
        rows: recentFailedTasks.map(
          (t: { id: string; title: string; capability: string | null; assigneeId: string | null }) => ({
            id: t.id,
            cells: [
              { key: 'title', value: t.title },
              { key: 'capability', value: t.capability ?? '' },
              { key: 'assignee', value: t.assigneeId ? agentNameMap.get(t.assigneeId) ?? t.assigneeId : '' },
            ],
          }),
        ),
      },
      pendingApprovals: {
        type: 'table',
        columns: ['title', 'capability', 'acceptance'],
        rows: pendingApprovals.map(
          (t: { id: string; title: string; capability: string | null; acceptanceStatus: string }) => ({
            id: t.id,
            cells: [
              { key: 'title', value: t.title },
              { key: 'capability', value: t.capability ?? '' },
              { key: 'acceptance', value: t.acceptanceStatus },
            ],
          }),
        ),
      },
    },
    asOf: new Date().toISOString(),
  };
}

function buildContributorsTable(buckets: BucketResult[], nameMap?: Map<string, string>): TableWidget {
  const flat = new Map<string, number>();
  for (const b of buckets) {
    for (const g of b.groups) {
      const id = g.groupKey['assigneeId'] ?? '(unassigned)';
      flat.set(id, (flat.get(id) ?? 0) + Number(g.value ?? 0));
    }
  }
  const rows = [...flat.entries()]
    .map(([id, value]) => ({
      id,
      cells: [
        // `name` is what the UI renders; `assignee` keeps the raw imUserId for
        // the drill-down link. Without the resolved name the table showed the
        // opaque CUID (e.g. n3wgczwi1vi) instead of the agent's "CEO" label.
        { key: 'name', value: nameMap?.get(id) ?? id },
        { key: 'assignee', value: id },
        // FE (project-view contributors) reads the count via `done` / `value`;
        // emit `done` so the "完成 N" line isn't stuck at 0.
        { key: 'done', value },
      ],
    }))
    .sort((a, b) => Number(b.cells[2].value ?? 0) - Number(a.cells[2].value ?? 0))
    .slice(0, 10);
  return { type: 'table', columns: ['name', 'assignee', 'done'], rows };
}

function computeBurndown(created: BucketResult[], completed: BucketResult[], failed: BucketResult[]): TimeseriesWidget {
  // Build sorted per-day map; compute cumulative open = cum(created) -
  // cum(completed) - cum(failed). This is the daily burndown curve.
  const days = new Map<string, { created: number; completed: number; failed: number }>();
  for (const b of created)
    if (b.ts) {
      const d = days.get(b.ts) ?? { created: 0, completed: 0, failed: 0 };
      d.created += b.groups.reduce((s, g) => s + Number(g.value ?? 0), 0);
      days.set(b.ts, d);
    }
  for (const b of completed)
    if (b.ts) {
      const d = days.get(b.ts) ?? { created: 0, completed: 0, failed: 0 };
      d.completed += b.groups.reduce((s, g) => s + Number(g.value ?? 0), 0);
      days.set(b.ts, d);
    }
  for (const b of failed)
    if (b.ts) {
      const d = days.get(b.ts) ?? { created: 0, completed: 0, failed: 0 };
      d.failed += b.groups.reduce((s, g) => s + Number(g.value ?? 0), 0);
      days.set(b.ts, d);
    }
  const ordered = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let cum = 0;
  const buckets: TimeseriesWidget['buckets'] = [];
  for (const [ts, day] of ordered) {
    cum += day.created - day.completed - day.failed;
    buckets.push({ ts, value: Math.max(0, cum) });
  }
  return { type: 'timeseries', buckets };
}

function safeParseJSON(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Project view extras — doc 20 §3.3 Gap C F4 ────────────────────────────────
//
// `buildProject` (above) is intentionally untouched: its widget envelope is
// already pinned by integration test `insights-project-agent-bff.test.ts`
// (8-widget assert) and unit test `insights-service.test.ts` (10 runAggregate
// fan-out sequence). Doc 20 §3.3 asks for three additional aggregates exposed
// as a sibling `aggregates` block on the /project response so:
//   • the existing widget contract stays binary-compatible,
//   • each new aggregate carries its own `available` flag so the UI can
//     distinguish "metric not ingested" from "0 today" (12-doc §3.1 empty-state
//     contract),
//   • callers that don't need them pay no extra cost (router fan-outs all
//     three in parallel with buildProject — see api/insights.ts).

export type ProjectAcceptanceStatus = 'passing' | 'failing' | 'unknown' | 'none';

export interface ProjectActiveMemberCount {
  count: number;
  available: boolean;
}

export interface ProjectAcceptanceByStatus {
  buckets: Array<{ status: ProjectAcceptanceStatus; count: number }>;
  available: boolean;
}

export interface ProjectActivityTimeseries {
  points: Array<{ ts: string; count: number }>;
  available: boolean;
}

/**
 * Count distinct active members (any role) tied to the project via
 * `im_agent_project_memberships`. `available=true` whenever the membership
 * table can be queried — count of 0 is a *real* zero (workspace owner alone),
 * not a "metric not wired" sentinel.
 */
export async function getProjectActiveMemberCount(args: { projectId: string }): Promise<ProjectActiveMemberCount> {
  const count = await prisma.iMAgentProjectMembership.count({
    where: { projectId: args.projectId },
  });
  return { count, available: true };
}

/**
 * Group project tasks created within the range by acceptanceStatus. Returns
 * 4 fixed buckets so the UI can render a stable grid even when categories are
 * empty:
 *   passing → IMTask.acceptanceStatus === 'passed'
 *   failing → 'failed' | 'partial'
 *   unknown → any non-canonical value (defensive — older rows)
 *   none    → default 'none' (no acceptance run yet)
 * `available=true` when ANY task exists in the project (regardless of bucket
 * spread). Empty project → available=false so the widget shows the
 * `projectNoTasks` empty-hint, not a zero grid.
 */
export async function getProjectAcceptanceByStatus(args: {
  projectId: string;
  range: InsightsRange;
}): Promise<ProjectAcceptanceByStatus> {
  const window = resolveRange(args.range);
  const grouped = await prisma.iMTask.groupBy({
    by: ['acceptanceStatus'],
    where: {
      projectId: args.projectId,
      createdAt: { gte: window.from, lt: window.to },
    },
    _count: { _all: true },
  });
  const counts: Record<ProjectAcceptanceStatus, number> = {
    passing: 0,
    failing: 0,
    unknown: 0,
    none: 0,
  };
  let total = 0;
  for (const row of grouped) {
    const n = row._count?._all ?? 0;
    total += n;
    switch (row.acceptanceStatus) {
      case 'passed':
        counts.passing += n;
        break;
      case 'failed':
      case 'partial':
        counts.failing += n;
        break;
      case 'none':
      case '':
      case null:
      case undefined:
        counts.none += n;
        break;
      default:
        counts.unknown += n;
        break;
    }
  }
  return {
    buckets: [
      { status: 'passing', count: counts.passing },
      { status: 'failing', count: counts.failing },
      { status: 'unknown', count: counts.unknown },
      { status: 'none', count: counts.none },
    ],
    available: total > 0,
  };
}

/**
 * Daily / hourly activity bucket count drawn from `im_metric_events` filtered
 * by `dims.projectId`. Bucket granularity follows the same heuristic as
 * Overview taskVelocity: 24h → 1h, all others → 1d. Workspace id is required
 * by runAggregate; we look it up from the project row (single point query —
 * not on the hot fan-out path).
 * `available=true` when at least one bucket has count > 0; otherwise the
 * widget shows the `noActivity`/`metricNotIngested` hint instead of a flat 0
 * line that users mis-read as "project dead".
 */
export async function getProjectActivityTimeseries(args: {
  projectId: string;
  workspaceId: string;
  range: InsightsRange;
}): Promise<ProjectActivityTimeseries> {
  const window = resolveRange(args.range);
  const bucket: '1h' | '1d' = args.range === '24h' ? '1h' : '1d';

  // `task.created` is the lowest-cardinality activity event scoped to a
  // project (every other activity emits a follow-on task.* metric anyway).
  // If the metric outbox has nothing for this project the result will be
  // empty buckets — we surface available=false in that case so the UI shows
  // a single clear empty-hint instead of a noisy flat line.
  const buckets = await callAggregate({
    namespace: 'task',
    name: 'created',
    agg: 'count',
    from: window.from,
    to: window.to,
    workspaceId: args.workspaceId,
    filter: { projectId: args.projectId },
    bucket,
  });

  const points: ProjectActivityTimeseries['points'] = [];
  let total = 0;
  for (const b of buckets) {
    if (!b.ts) continue;
    const count = b.groups.reduce((s, g) => s + Number(g.value ?? 0), 0);
    total += count;
    points.push({ ts: b.ts, count });
  }
  return { points, available: total > 0 };
}

// ── Agent view (§6) ────────────────────────────────────────────────────────────

/**
 * release201/20 Gap C F5 — AvailableValue wrapper distinguishing
 * "no metric ingested" from "true zero". Without this wrapper the agent-view
 * widget reads "0%" identically when the outbox is empty AND when the agent
 * legitimately had zero acceptance decisions, hiding pipeline regressions.
 *
 *   - `available: true, value: 0`            → outbox ingested, real zero
 *   - `available: false, reason: '…'`        → metric pipeline empty / never
 *                                              recorded this dimension
 */
export type AvailableValue<T> = { value: T; available: true } | { available: false; reason: string };

export interface AgentMetrics {
  /** 0..1 — share of `task.acceptance.status_changed` events with status=passed. */
  acceptanceRate: AvailableValue<number>;
  /** p95 of `agent.dispatch` value (duration_ms). */
  dispatchLatencyP95Ms: AvailableValue<number>;
  /** Count of `agent.dispatch` events. */
  totalDispatchedTasks: AvailableValue<number>;
}

export interface AgentResponse {
  workspaceId: string;
  agentId: string;
  range: {
    from: string;
    to: string;
    previous: { from: string; to: string };
  };
  widgets: {
    tasksDone: CounterWidget;
    avgLatency: CounterWidget;
    acceptanceRate: CounterWidget;
    skillsUsed: CounterWidget;
    dispatchVolume: TimeseriesWidget;
    skillInvocation: BarWidget;
    recentTasks: TableWidget;
  };
  /**
   * release201/20 Gap C F5 — 11-doc metric outbox passthrough. Lives
   * alongside `widgets` so the UI can render empty-state hints when the
   * pipeline has nothing to report instead of showing a misleading "0".
   * Existing `widgets.acceptanceRate` is retained for backwards compat
   * (returns 0 on empty); the new `metrics.acceptanceRate.available` flag
   * is what agent-view.tsx consults for the empty-state branch.
   */
  metrics: AgentMetrics;
  asOf: string;
}

/**
 * release201/20 Gap C F5 — surface 11-doc metric outbox counters directly.
 *
 * Reads `im_metric_events` through the shared aggregate path:
 *   - acceptance rate: `task.acceptance.status_changed` filtered to
 *     `assigneeId=agentImUserId` for the workspace range. Denominator is the
 *     count of all status_changed events for this agent; numerator filters
 *     `acceptanceStatus=passed` (mirrored dim, see release201 S13 P0-3
 *     comment in callAggregate calls below).
 *   - dispatch latency p95: `agent.dispatch` namespace/name filtered to
 *     `agentId`; value_numeric is duration_ms — `runAggregate`'s `p95` agg
 *     computes the percentile over rows.
 *   - total dispatched: same `agent.dispatch` query, `count` agg.
 *
 * Empty branches:
 *   - acceptance: 0 rows → `available: false, reason: 'no_acceptance_recorded'`
 *   - dispatch p95 + count: both → `available: false, reason: 'no_outbox_ingested'`
 *
 * Note: 11-doc emit for `task.acceptance.status_changed` does NOT currently
 * include `assigneeId` in dims (task-acceptance.service.ts:482 builds
 * dims = { workspaceId, taskId, projectId, capability }). Until that dim is
 * added the acceptance rate will read `available: false` for every agent —
 * which is the correct behaviour: "we didn't ingest per-agent data, don't
 * render a fake 0". Fix tracked separately; this function honours whatever
 * the registry emits.
 */
export async function getAgentMetrics(args: {
  agentImUserId: string;
  workspaceId: string;
  range: InsightsRange;
}): Promise<AgentMetrics> {
  const window = resolveRange(args.range);
  const { workspaceId, agentImUserId } = args;

  const [acceptanceAllBuckets, acceptancePassedBuckets, dispatchP95Buckets, dispatchCountBuckets] = await Promise.all([
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      filter: { assigneeId: agentImUserId },
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      filter: { assigneeId: agentImUserId, acceptanceStatus: 'passed' },
    }),
    callAggregate({
      namespace: 'agent',
      name: 'dispatch',
      agg: 'p95',
      from: window.from,
      to: window.to,
      workspaceId,
      filter: { agentId: agentImUserId },
    }),
    callAggregate({
      namespace: 'agent',
      name: 'dispatch',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId,
      filter: { agentId: agentImUserId },
    }),
  ]);

  const acceptanceTotal = totalFromBuckets(acceptanceAllBuckets);
  const acceptancePassed = totalFromBuckets(acceptancePassedBuckets);
  const acceptanceRate: AvailableValue<number> =
    acceptanceTotal > 0
      ? { value: acceptancePassed / acceptanceTotal, available: true }
      : { available: false, reason: 'no_acceptance_recorded' };

  // runAggregate's p95 returns the 95th percentile of value_numeric;
  // pick the first non-null group value (no bucket / no groupBy → single
  // row carrying the overall percentile).
  const p95Raw = (() => {
    for (const b of dispatchP95Buckets) {
      for (const g of b.groups) {
        if (g.value != null && Number.isFinite(Number(g.value))) return Number(g.value);
      }
    }
    return null;
  })();
  const dispatchCount = totalFromBuckets(dispatchCountBuckets);

  const dispatchLatencyP95Ms: AvailableValue<number> =
    dispatchCount > 0 && p95Raw != null
      ? { value: Math.round(p95Raw), available: true }
      : { available: false, reason: 'no_outbox_ingested' };
  const totalDispatchedTasks: AvailableValue<number> =
    dispatchCount > 0 ? { value: dispatchCount, available: true } : { available: false, reason: 'no_outbox_ingested' };

  return { acceptanceRate, dispatchLatencyP95Ms, totalDispatchedTasks };
}

export class AgentNotInWorkspaceError extends Error {
  readonly status = 404 as const;
  readonly code = 'AGENT_NOT_IN_WORKSPACE' as const;
  constructor(agentId: string, workspaceId: string) {
    super(`Agent ${agentId} is not bound to workspace ${workspaceId}`);
  }
}

export async function buildAgent(args: {
  agentId: string;
  workspaceId: string;
  range: InsightsRange;
  actorImUserId: string;
}): Promise<AgentResponse> {
  await assertWorkspaceMember(args.workspaceId, args.actorImUserId);
  // release201/19 D4 — doc 12 §6 expects 404 when agentId is not bound to
  // the target workspace. Probe via IMAgentCard (the canonical
  // workspace↔agent join row); fall back to "is this user a member?" so an
  // owner who has not yet generated an AgentCard but is otherwise scoped to
  // the workspace still resolves. Returning 404 here keeps the cross-workspace
  // anti-enumeration posture: callers cannot probe whether an agentId exists
  // in another workspace.
  const [agentCard, memberRow] = await Promise.all([
    prisma.iMAgentCard.findFirst({
      where: { workspaceId: args.workspaceId, imUserId: args.agentId },
      select: { id: true },
    }),
    prisma.iMWorkspaceMember.findUnique({
      where: {
        workspaceId_memberImUserId: { workspaceId: args.workspaceId, memberImUserId: args.agentId },
      },
      select: { id: true },
    }),
  ]);
  if (!agentCard && !memberRow) {
    throw new AgentNotInWorkspaceError(args.agentId, args.workspaceId);
  }
  const window = resolveRange(args.range);
  const wsId = args.workspaceId;
  const filter = { assigneeId: args.agentId };

  const [
    tasksDoneBuckets,
    tasksDonePrevBuckets,
    latencyAvgBuckets,
    acceptanceCount,
    acceptancePassed,
    skillsUsedBuckets,
    dispatchVolumeBuckets,
    skillInvocationBuckets,
    recentTasks,
    metrics,
  ] = await Promise.all([
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.previous.from,
      to: window.previous.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'avg',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
    }),
    callAggregate({
      namespace: 'task.acceptance',
      name: 'status_changed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      // release201 S13 P0-3 — filter by mirrored acceptanceStatus dim, not
      // `name` (which is the metric name itself, not the value).
      filter: { ...filter, acceptanceStatus: 'passed' },
    }),
    callAggregate({
      namespace: 'skill',
      name: 'invoked',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter: { agentId: args.agentId },
      groupBy: ['skillId'],
    }),
    callAggregate({
      namespace: 'task',
      name: 'completed',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter,
      bucket: '1d',
    }),
    callAggregate({
      namespace: 'skill',
      name: 'invoked',
      agg: 'count',
      from: window.from,
      to: window.to,
      workspaceId: wsId,
      filter: { agentId: args.agentId },
      // Group by the human-readable slug (e.g. "webapp-testing"), NOT the
      // opaque skillId CUID — this feeds the 「常用能力」 bar labels.
      groupBy: ['slug'],
    }),
    prisma.iMTask.findMany({
      where: {
        workspaceId: wsId,
        assigneeId: args.agentId,
        completedAt: { not: null },
      },
      select: {
        id: true,
        title: true,
        capability: true,
        projectId: true,
        acceptanceStatus: true,
        completedAt: true,
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    // release201/20 Gap C F5 — 11-doc metric outbox passthrough. Fan out
    // in the same Promise.all to stay within the §0.2.4 parallel-fanout
    // contract (never serialise widget fetches).
    getAgentMetrics({
      agentImUserId: args.agentId,
      workspaceId: wsId,
      range: args.range,
    }),
  ]);

  const tasksDone = totalFromBuckets(tasksDoneBuckets);
  const tasksDonePrev = totalFromBuckets(tasksDonePrevBuckets);
  const latencyAvg = (() => {
    let n = 0;
    let sum = 0;
    for (const b of latencyAvgBuckets)
      for (const g of b.groups)
        if (g.value != null) {
          sum += Number(g.value);
          n++;
        }
    return n > 0 ? sum / n : 0;
  })();
  const acceptanceTotal = totalFromBuckets(acceptanceCount);
  const acceptancePassedTotal = totalFromBuckets(acceptancePassed);
  const acceptanceRate = acceptanceTotal > 0 ? acceptancePassedTotal / acceptanceTotal : 0;

  // unique skills used = number of distinct skillId groups across buckets
  const uniqueSkillIds = new Set<string>();
  for (const b of skillsUsedBuckets)
    for (const g of b.groups) {
      const sid = g.groupKey['skillId'];
      if (sid) uniqueSkillIds.add(sid);
    }

  return {
    workspaceId: wsId,
    agentId: args.agentId,
    range: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previous: {
        from: window.previous.from.toISOString(),
        to: window.previous.to.toISOString(),
      },
    },
    widgets: {
      tasksDone: { type: 'counter', value: tasksDone, delta: tasksDone - tasksDonePrev },
      avgLatency: { type: 'counter', value: latencyAvg, unit: 'ms' },
      acceptanceRate: { type: 'counter', value: acceptanceRate, unit: 'ratio' },
      skillsUsed: { type: 'counter', value: uniqueSkillIds.size },
      dispatchVolume: timeseriesFromBuckets(dispatchVolumeBuckets),
      skillInvocation: barFromBuckets(skillInvocationBuckets, 'slug', 5),
      recentTasks: {
        type: 'table',
        columns: ['title', 'capability', 'project', 'acceptance', 'completedAt'],
        rows: recentTasks.map(
          (t: {
            id: string;
            title: string;
            capability: string | null;
            projectId: string | null;
            acceptanceStatus: string;
            completedAt: Date | null;
          }) => ({
            id: t.id,
            cells: [
              { key: 'title', value: t.title },
              { key: 'capability', value: t.capability ?? '' },
              { key: 'project', value: t.projectId ?? '' },
              { key: 'acceptance', value: t.acceptanceStatus },
              { key: 'completedAt', value: t.completedAt ? t.completedAt.toISOString() : '' },
            ],
          }),
        ),
      },
    },
    metrics,
    asOf: new Date().toISOString(),
  };
}

// ── Tiny in-process response cache (30s TTL, 12 §0.2.2 / §7.4 step 4) ─────────

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export function cacheKey(parts: string[]): string {
  return parts.join('::');
}

export function getCached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return e.data as T;
}

export function setCached(key: string, data: unknown): void {
  // Crude cap to avoid unbounded growth in dev/test.
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort(([, a], [, b]) => a.expiresAt - b.expiresAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
}

export function __clearInsightsCacheForTests(): void {
  cache.clear();
}

// Surface a no-op log target so the warning path is grep-able without
// matching the forbidden patterns (§0.2.4).
export function _logForTest(msg: string): void {
  log.info({}, msg);
}
