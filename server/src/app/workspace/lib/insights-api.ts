/**
 * Workspace Insights API client (release201/12 §7).
 *
 * Thin typed wrapper around the BFF endpoints. Caching policy: relies on the
 * BFF Cache-Control private,max-age=30 — we don't add a second layer here.
 */
import { imFetch } from './im-api';

export type InsightsRange = '24h' | '7d' | '30d' | '90d';

export interface CounterWidgetDTO {
  type: 'counter';
  value: number;
  delta?: number | null;
  unit?: string;
}
export interface SparklineWidgetDTO {
  type: 'sparkline';
  buckets: Array<{ ts: string; value: number | null }>;
  summary?: { avgMs?: number; total?: number };
}
export interface TimeseriesWidgetDTO {
  type: 'timeseries';
  buckets: Array<{ ts: string; value: number | null }>;
}
export interface BarWidgetDTO {
  type: 'bar';
  items: Array<{ label: string; value: number }>;
}
export interface TableWidgetDTO {
  type: 'table';
  columns: string[];
  rows: Array<{ id: string; cells: Array<{ key: string; value: string | number | null }> }>;
}
export interface StatusGridWidgetDTO {
  type: 'grid';
  columns: string[];
  /**
   * `unscoped=true` rows aggregate tasks without a `projectId` (workspace-level
   * tasks). v2.0.8 Bug 1 — frontend renders these in italic with a tooltip.
   */
  rows: Array<{ label: string; counts: Record<string, number>; unscoped?: boolean }>;
}

export interface OverviewResponse {
  workspaceId: string;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: {
    tasksCompleted: CounterWidgetDTO;
    acceptancePassRate: CounterWidgetDTO;
    skillsPublished: CounterWidgetDTO;
    activeProjects: CounterWidgetDTO;
    taskVelocity: TimeseriesWidgetDTO;
    approvalLatency: SparklineWidgetDTO;
    topCapabilities: BarWidgetDTO;
    acceptanceByProject: StatusGridWidgetDTO;
  };
  asOf: string;
}

export type ProjectAcceptanceStatusDTO = 'passing' | 'failing' | 'unknown' | 'none';

/**
 * Doc 20 §3.3 Gap C F4 — Project view 3 extra aggregates exposed as a sibling
 * of `widgets` so the 8-widget contract stays binary-compatible. Each carries
 * `available` so the UI can distinguish "metric not ingested" from "0 today".
 */
export interface ProjectAggregatesDTO {
  activeMemberCount: { count: number; available: boolean };
  acceptanceByStatus: {
    buckets: Array<{ status: ProjectAcceptanceStatusDTO; count: number }>;
    available: boolean;
  };
  activityTimeseries: {
    points: Array<{ ts: string; count: number }>;
    available: boolean;
  };
}

export interface ProjectResponse {
  workspaceId: string;
  projectId: string;
  projectName: string;
  status: 'active' | 'archived';
  memberCount: number;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: {
    openTasks: CounterWidgetDTO;
    acceptance: CounterWidgetDTO;
    /** SUM(IMTask.cost) in credits over completedAt-in-window tasks. */
    cost: CounterWidgetDTO;
    daysUntilArchive: CounterWidgetDTO;
    burndown: TimeseriesWidgetDTO;
    acceptanceByCapability: BarWidgetDTO;
    contributors: TableWidgetDTO;
    recentFailedTasks: TableWidgetDTO;
    pendingApprovals: TableWidgetDTO;
  };
  aggregates: ProjectAggregatesDTO;
  asOf: string;
}

/**
 * release201/20 Gap C F5 — AvailableValue wrapper for 11-doc metric outbox
 * passthrough. Allows the widget to distinguish "metric never ingested" from
 * "real zero" instead of rendering "0%" in both cases.
 */
export type AvailableValueDTO<T> = { value: T; available: true } | { available: false; reason: string };

export interface AgentMetricsDTO {
  acceptanceRate: AvailableValueDTO<number>;
  dispatchLatencyP95Ms: AvailableValueDTO<number>;
  totalDispatchedTasks: AvailableValueDTO<number>;
}

export interface AgentResponse {
  workspaceId: string;
  agentId: string;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: {
    tasksDone: CounterWidgetDTO;
    avgLatency: CounterWidgetDTO;
    acceptanceRate: CounterWidgetDTO;
    skillsUsed: CounterWidgetDTO;
    dispatchVolume: TimeseriesWidgetDTO;
    skillInvocation: BarWidgetDTO;
    recentTasks: TableWidgetDTO;
  };
  /** release201/20 Gap C F5 — 11-doc metric outbox passthrough. */
  metrics: AgentMetricsDTO;
  asOf: string;
}

export async function fetchOverview(workspaceId: string, range: InsightsRange): Promise<OverviewResponse> {
  const res = await imFetch<OverviewResponse>(
    `/insights/overview?workspaceId=${encodeURIComponent(workspaceId)}&range=${range}`,
  );
  if (!res.ok) throw new Error(res.message ?? `Insights overview failed (${res.status})`);
  return res.data;
}

export async function fetchProject(projectId: string, range: InsightsRange): Promise<ProjectResponse> {
  const res = await imFetch<ProjectResponse>(`/insights/project/${encodeURIComponent(projectId)}?range=${range}`);
  if (!res.ok) throw new Error(res.message ?? `Insights project failed (${res.status})`);
  return res.data;
}

export async function fetchAgent(agentId: string, workspaceId: string, range: InsightsRange): Promise<AgentResponse> {
  const res = await imFetch<AgentResponse>(
    `/insights/agent/${encodeURIComponent(agentId)}?workspaceId=${encodeURIComponent(workspaceId)}&range=${range}`,
  );
  if (!res.ok) throw new Error(res.message ?? `Insights agent failed (${res.status})`);
  return res.data;
}

// ─── Cockpit (一人公司) — release 2.1 E-X BFF contract ───────────────
//
// `GET /api/im/insights/cockpit?workspaceId=&range=` returns the cockpit DTO
// below. The fetcher calls the BFF directly — no mock fallback. If the BFF
// errors, the UI shows the error state; we never silently render fake data.

export type CockpitAgentStatusDot = 'running' | 'idle' | 'stuck' | 'offline';

export interface CockpitDeltaValue {
  value: number;
  deltaVsYesterday: number;
}

export interface CockpitTodaySummary {
  tasksCompleted: CockpitDeltaValue;
  costToday: CockpitDeltaValue & { currency: 'credits' };
  running: number;
  stuck: number;
  pendingApprovals: number;
  stuckOver4h: number;
}

export interface CockpitTrendPoint {
  ts: string;
  value: number;
}

export interface CockpitTrends {
  deliveryDaily: CockpitTrendPoint[];
  spendDaily: CockpitTrendPoint[];
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
  statusDot: CockpitAgentStatusDot;
}

export interface CockpitStuckTaskRow {
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
  today: CockpitTodaySummary;
  trends: CockpitTrends;
  agents: CockpitAgentRow[];
  stuckTasks: CockpitStuckTaskRow[];
  asOf: string;
}

/** Fetch the cockpit DTO. Errors propagate — the UI shows them, never fakes data. */
export async function fetchCockpit(workspaceId: string, range: InsightsRange): Promise<CockpitResponse> {
  const res = await imFetch<CockpitResponse>(
    `/insights/cockpit?workspaceId=${encodeURIComponent(workspaceId)}&range=${range}`,
  );
  if (!res.ok) {
    throw new Error(res.message ?? `Insights cockpit failed (${res.status})`);
  }
  return res.data;
}
