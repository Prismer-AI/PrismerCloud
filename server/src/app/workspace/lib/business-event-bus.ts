/**
 * `business-event-bus` — workspace-wide singleton that maps raw `/sync/stream`
 * SSE events to a normalised `WorkspaceBusinessEvent` union (release201/12
 * §8c.2) so chat business cards / SessionContextSidebar / NotificationBell can
 * subscribe to a single stable schema rather than each component parsing raw
 * SSE envelopes.
 *
 * Why a bus (not direct EventSource per consumer):
 *   - Components mount/unmount frequently (channel switches); a per-component
 *     EventSource thrashes the cloud SSE fan-out.
 *   - Multiple cards listen to the same event type (skill.authoring.failed
 *     fires both the "red action required" card and the notification bell);
 *     normalising once on receipt avoids drift between consumers.
 *
 * Lifecycle: first subscribe() call opens the underlying `/api/im/sync/stream`
 * EventSource; the last unsubscribe() closes it. Cursor persistence reuses
 * the existing `sse-cursor` helper so reconnects pick up where we left off.
 */

import { useEffect, useState } from 'react';

import { getWorkspaceToken } from './im-api';
import { loadCursor, saveCursor } from './sse-cursor';

// ─── Public event union (release201/12 §8c.2) ────────────────────────────────

export interface SkillAuthoringEventPayload {
  skillId: string;
  stage: string;
  state: 'started' | 'in_progress' | 'completed';
  draftId?: string | null;
  workspaceId?: string | null;
}

export interface SkillAuthoringFailurePayload {
  skillId: string;
  stage: string;
  severity: 'warning' | 'error';
  reason: string;
  draftId?: string | null;
}

export interface SkillSmokePayload {
  skillId: string;
  draftId?: string | null;
  passed: boolean;
  evidenceUri?: string | null;
}

export interface TaskAcceptancePayload {
  taskId: string;
  workspaceId: string;
  acceptanceStatus: 'none' | 'pending' | 'partial' | 'passed' | 'failed';
  passedCount?: number;
  totalCount?: number;
}

export interface TaskEvidencePayload {
  taskId: string;
  workspaceId: string;
  evidenceId: string;
  kind: 'artifact' | 'note' | 'link';
  mime?: string | null;
  thumbnailUri?: string | null;
}

export interface ProjectMetricPayload {
  projectId: string;
  workspaceId: string;
  metricId: string;
  name: string;
  status: 'passing' | 'failing' | 'unknown';
  current?: number | null;
  target?: number | null;
}

export type WorkspaceBusinessEvent =
  | { type: 'skill.authoring.state_changed'; receivedAt: number; payload: SkillAuthoringEventPayload }
  | { type: 'skill.authoring.failed'; receivedAt: number; payload: SkillAuthoringFailurePayload }
  | { type: 'skill.authoring.smoke_completed'; receivedAt: number; payload: SkillSmokePayload }
  | { type: 'task.acceptance.changed'; receivedAt: number; payload: TaskAcceptancePayload }
  | { type: 'task.evidence.attached'; receivedAt: number; payload: TaskEvidencePayload }
  | { type: 'project.metric.snapshot_updated'; receivedAt: number; payload: ProjectMetricPayload };

export type BusinessEventListener = (event: WorkspaceBusinessEvent) => void;

// ─── Internal state ──────────────────────────────────────────────────────────

const listeners = new Set<BusinessEventListener>();
let es: EventSource | null = null;
let activeSubs = 0;
let history: WorkspaceBusinessEvent[] = [];
const HISTORY_CAP = 200;

const CURSOR_STREAM = 'business-events';

function resolveCursorUserKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem('prismer_auth');
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { user?: { id?: number | string } };
    const id = parsed?.user?.id;
    return id == null ? '' : String(id);
  } catch {
    return '';
  }
}

function pushAndNotify(event: WorkspaceBusinessEvent): void {
  history.push(event);
  if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      // listener threw — keep others alive
    }
  }
}

// ─── Raw → normalised mapping (test-only export) ─────────────────────────────

interface RawSseEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
  seq?: number;
}

export function mapRawSseToBusinessEvent(env: RawSseEnvelope): WorkspaceBusinessEvent | null {
  if (!env || typeof env.type !== 'string') return null;
  const now = Date.now();
  const p = (env.payload ?? {}) as Record<string, unknown>;
  switch (env.type) {
    case 'skill.authoring.started':
    case 'skill.authoring.state_changed':
      return {
        type: 'skill.authoring.state_changed',
        receivedAt: now,
        payload: {
          skillId: String(p.skillId ?? p.skill_id ?? ''),
          stage: String(p.stage ?? 'unknown'),
          state: (p.state as SkillAuthoringEventPayload['state']) ?? 'in_progress',
          draftId: typeof p.draftId === 'string' ? p.draftId : null,
          workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : null,
        },
      };
    case 'skill.authoring.failed':
      return {
        type: 'skill.authoring.failed',
        receivedAt: now,
        payload: {
          skillId: String(p.skillId ?? p.skill_id ?? ''),
          stage: String(p.stage ?? 'unknown'),
          severity: (p.severity as SkillAuthoringFailurePayload['severity']) ?? 'error',
          reason: String(p.reason ?? 'unknown failure'),
          draftId: typeof p.draftId === 'string' ? p.draftId : null,
        },
      };
    case 'skill.authoring.smoke_completed':
      return {
        type: 'skill.authoring.smoke_completed',
        receivedAt: now,
        payload: {
          skillId: String(p.skillId ?? p.skill_id ?? ''),
          draftId: typeof p.draftId === 'string' ? p.draftId : null,
          passed: Boolean(p.passed),
          evidenceUri: typeof p.evidenceUri === 'string' ? p.evidenceUri : null,
        },
      };
    case 'task.acceptance.changed':
    case 'task.acceptance.status_changed':
      return {
        type: 'task.acceptance.changed',
        receivedAt: now,
        payload: {
          taskId: String(p.taskId ?? ''),
          workspaceId: String(p.workspaceId ?? ''),
          acceptanceStatus: (p.acceptanceStatus as TaskAcceptancePayload['acceptanceStatus']) ?? 'none',
          passedCount: typeof p.passedCount === 'number' ? p.passedCount : undefined,
          totalCount: typeof p.totalCount === 'number' ? p.totalCount : undefined,
        },
      };
    case 'task.evidence.attached':
      return {
        type: 'task.evidence.attached',
        receivedAt: now,
        payload: {
          taskId: String(p.taskId ?? ''),
          workspaceId: String(p.workspaceId ?? ''),
          evidenceId: String(p.evidenceId ?? ''),
          kind: (p.kind as TaskEvidencePayload['kind']) ?? 'artifact',
          mime: typeof p.mime === 'string' ? p.mime : null,
          thumbnailUri: typeof p.thumbnailUri === 'string' ? p.thumbnailUri : null,
        },
      };
    case 'project.metric.snapshot_updated':
      return {
        type: 'project.metric.snapshot_updated',
        receivedAt: now,
        payload: {
          projectId: String(p.projectId ?? ''),
          workspaceId: String(p.workspaceId ?? ''),
          metricId: String(p.metricId ?? ''),
          name: String(p.name ?? ''),
          status: (p.status as ProjectMetricPayload['status']) ?? 'unknown',
          current: typeof p.current === 'number' ? p.current : null,
          target: typeof p.target === 'number' ? p.target : null,
        },
      };
    default:
      return null;
  }
}

// ─── SSE connection ──────────────────────────────────────────────────────────

const HANDLED_RAW_TYPES = [
  'skill.authoring.started',
  'skill.authoring.state_changed',
  'skill.authoring.failed',
  'skill.authoring.smoke_completed',
  'task.acceptance.changed',
  'task.acceptance.status_changed',
  'task.evidence.attached',
  'project.metric.snapshot_updated',
];

const CONTROL_EVENTS = ['sync.backfill.done', 'sync.backfill.truncated'];

function applyRawEvent(eventName: string, raw: MessageEvent): void {
  if (eventName === 'sync.backfill.done') {
    // Advance the cursor to the replayed high-water seq so the next
    // reconnect resumes here rather than falling back to since=0.
    const uid = resolveCursorUserKey();
    let doneSeq: number | undefined;
    try {
      doneSeq = (JSON.parse(raw.data) as { seq?: number }).seq;
    } catch {
      /* ignore */
    }
    if (uid && typeof doneSeq === 'number' && doneSeq > 0) saveCursor(CURSOR_STREAM, uid, doneSeq);
    return;
  }
  if (eventName === 'sync.backfill.truncated') {
    // Resume from the newest replayed seq — NOT resetCursor(→0), which
    // makes the next reconnect re-replay the full history and re-truncate
    // forever (a since=0 storm). newestSeq drains the backlog in chunks.
    const uid = resolveCursorUserKey();
    let newestSeq: number | undefined;
    try {
      newestSeq = (JSON.parse(raw.data) as { newestSeq?: number }).newestSeq;
    } catch {
      /* ignore */
    }
    if (uid && typeof newestSeq === 'number' && newestSeq > 0) saveCursor(CURSOR_STREAM, uid, newestSeq);
    return;
  }
  let env: RawSseEnvelope;
  try {
    env = JSON.parse(raw.data) as RawSseEnvelope;
  } catch {
    return;
  }
  // Some raw streams have `{type:'...', data:{...}}` while others have
  // `{payload:{...}}`. Normalise: SSE event-type already carries the
  // logical name, so derive payload from either shape.
  if (!env.payload && (env as unknown as { data?: Record<string, unknown> }).data) {
    env.payload = (env as unknown as { data: Record<string, unknown> }).data;
  }
  // The `eventName` from EventSource is the authoritative type tag.
  env.type = eventName;
  if (typeof env.seq === 'number' && env.seq > 0) {
    const uid = resolveCursorUserKey();
    if (uid) saveCursor(CURSOR_STREAM, uid, env.seq);
  }
  const mapped = mapRawSseToBusinessEvent(env);
  if (mapped) pushAndNotify(mapped);
}

function open(): void {
  if (es) return;
  if (typeof window === 'undefined') return;
  const token = getWorkspaceToken();
  if (!token) return;
  const userKey = resolveCursorUserKey();
  const since = userKey ? loadCursor(CURSOR_STREAM, userKey) : 0;
  const url = `/api/im/sync/stream?token=${encodeURIComponent(token)}&since=${since}`;
  try {
    es = new EventSource(url);
  } catch {
    return;
  }
  for (const type of [...HANDLED_RAW_TYPES, ...CONTROL_EVENTS]) {
    es.addEventListener(type, (raw) => applyRawEvent(type, raw as MessageEvent));
  }
}

function close(): void {
  if (!es) return;
  es.close();
  es = null;
}

// ─── Public hooks ─────────────────────────────────────────────────────────────

export function subscribeBusinessEvents(listener: BusinessEventListener): () => void {
  listeners.add(listener);
  activeSubs += 1;
  if (activeSubs === 1) open();
  return () => {
    listeners.delete(listener);
    activeSubs = Math.max(0, activeSubs - 1);
    if (activeSubs === 0) close();
  };
}

/** Read-only recent-history snapshot (for `<NotificationBell>` etc). */
export function getBusinessEventHistory(): WorkspaceBusinessEvent[] {
  return history.slice();
}

/**
 * React hook returning the latest event matching `filter` (or any event when
 * `filter` is omitted). Returns null until the first matching event arrives.
 */
export function useLatestBusinessEvent<T extends WorkspaceBusinessEvent['type']>(
  filter?: T,
): Extract<WorkspaceBusinessEvent, { type: T }> | WorkspaceBusinessEvent | null {
  const [event, setEvent] = useState<WorkspaceBusinessEvent | null>(null);
  useEffect(() => {
    const unsub = subscribeBusinessEvents((ev) => {
      if (!filter || ev.type === filter) setEvent(ev);
    });
    return unsub;
  }, [filter]);
  return event;
}

/** Test-only: inject an event without going through SSE. */
export function __pushBusinessEventForTests(event: WorkspaceBusinessEvent): void {
  pushAndNotify(event);
}

export function __resetBusinessEventBusForTests(): void {
  history = [];
  listeners.clear();
  activeSubs = 0;
  if (es) {
    es.close();
    es = null;
  }
}
