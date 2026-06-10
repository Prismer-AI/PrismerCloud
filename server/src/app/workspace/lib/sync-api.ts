/**
 * Wave 3 §4.1 helpers — gap-fill REST endpoint client.
 *
 * `GET /api/im/sync/events?conversationId=X&afterSeq=N&limit=200` is the
 * boundarySeq-based catch-up endpoint added by Wave 2-B1. The reconcile
 * hook calls into here whenever it detects a missing seq in the SSE stream.
 *
 * Wire format (per `evidence/14-p1-server-wave2-b1.md` §6.C):
 *   { ok: true, data: { events: [{ id, boundarySeq, type, data, conversationId, at }], hasMore, cursor } }
 */

import { imFetch, type FetchResult } from './im-api';

export interface SyncEventEnvelope {
  /** IMSyncEvent.id (global auto-increment). */
  id: number;
  /** Per-conversation monotonic seq. NULL for events with no conversationId. */
  boundarySeq: number | null;
  type: string;
  data: unknown;
  conversationId: string | null;
  at: string;
}

export interface SyncEventsResponse {
  events: SyncEventEnvelope[];
  hasMore: boolean;
  cursor: number;
}

export async function fetchSyncEvents(args: {
  conversationId: string;
  afterSeq: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FetchResult<SyncEventsResponse>> {
  const limit = args.limit ?? 200;
  const path = `/sync/events?conversationId=${encodeURIComponent(args.conversationId)}&afterSeq=${args.afterSeq}&limit=${limit}`;
  return imFetch<SyncEventsResponse>(path, { signal: args.signal });
}

/**
 * §4.4.2 — page-load hydration helper.
 *
 * Hydrates from the dedicated server endpoint rather than the broad
 * `/tasks?conversationId=` fallback. The fallback included pending/assigned
 * board cards and showed false "agents working" rows when a user reopened an
 * older workspace. The server endpoint only returns active execution states
 * (`running` / `review` / `blocked`) and carries phase/heartbeat metadata.
 */
export interface ActiveTaskPhase {
  taskId: string;
  status: string;
  currentPhase: string | null;
  lastHeartbeatAt: string | null;
  progress: number | null;
  statusMessage: string | null;
  assigneeId: string | null;
}

/**
 * §4.4.4 — Activity timeline (W4) read endpoint.
 *
 * Wire contract (from `evidence/14-w4-activity-timeline-server.md` §2):
 *   GET /api/im/tasks/:taskRunId/timeline?afterSeq=<N>&limit=<K>
 *   → { ok:true, data: { steps:[{id,seq,kind,payloadJson,occurredAt,durationMs}], hasMore, cursor } }
 *
 * - `afterSeq` is **exclusive** (matches the hook's `lastSeq` semantics).
 * - `limit` defaults server-side to 200, capped at 500.
 * - `cursor` is `null` when `!hasMore`.
 *
 * The `taskRunId` is the `IMTaskRun.id` (per-run, not per-task). Callers that
 * only have a `taskId` should first resolve the latest run via
 * `GET /api/im/tasks/:id` and use `runs[runs.length - 1].id`. If no real
 * `IMTaskRun` row exists yet (daemon hasn't dispatched, or legacy
 * agent-run path), step list will be empty — that's expected.
 */
export interface ActivityTimelineStep {
  id: string;
  seq: number;
  kind: string;
  payloadJson: unknown;
  occurredAt: string;
  durationMs: number | null;
}

export interface TaskTimelineResponse {
  steps: ActivityTimelineStep[];
  hasMore: boolean;
  cursor: number | null;
}

export async function fetchTaskTimeline(args: {
  taskRunId: string;
  afterSeq?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FetchResult<TaskTimelineResponse>> {
  const params: string[] = [];
  if (typeof args.afterSeq === 'number' && args.afterSeq > 0) {
    params.push(`afterSeq=${args.afterSeq}`);
  }
  if (typeof args.limit === 'number' && args.limit > 0) {
    params.push(`limit=${args.limit}`);
  }
  const qs = params.length ? `?${params.join('&')}` : '';
  return imFetch<TaskTimelineResponse>(`/tasks/${encodeURIComponent(args.taskRunId)}/timeline${qs}`, {
    signal: args.signal,
  });
}

/**
 * Resolve the latest `IMTaskRun.id` for a given `taskId`. Returns `null` if
 * the task has no runs yet (e.g. daemon hasn't dispatched), in which case
 * the InlineActivityStream falls back to using the taskId itself (matches
 * the timeline endpoint's legacy-agent-run resolution path).
 */
interface TaskDetailResponse {
  task?: { id: string };
  runs?: Array<{ id: string; createdAt?: string }>;
}

export async function resolveLatestTaskRunId(args: {
  taskId: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const res = await imFetch<TaskDetailResponse>(`/tasks/${encodeURIComponent(args.taskId)}`, {
    signal: args.signal,
  });
  if (!res.ok) return null;
  const runs = res.data?.runs ?? [];
  if (runs.length === 0) return null;
  // Server returns runs in `createdAt: 'asc'` order (task.service.ts:867).
  // Latest = last element.
  return runs[runs.length - 1].id;
}

export async function fetchActiveTaskPhases(args: {
  conversationId: string;
  signal?: AbortSignal;
}): Promise<FetchResult<{ tasks: ActiveTaskPhase[] }>> {
  return imFetch<{ tasks: ActiveTaskPhase[] }>(
    `/conversations/${encodeURIComponent(args.conversationId)}/active-task-phases`,
    { signal: args.signal },
  );
}
