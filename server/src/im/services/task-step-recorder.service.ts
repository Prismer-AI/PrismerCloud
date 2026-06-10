/**
 * Prismer IM — TaskStepRecorder Service (Wave 3.5 / W4 P4a)
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4
 *       (Activity timeline backend) + §3.0.2 Gap C-④.
 *
 * Responsibility: persist daemon-pushed `task.step.append` frames into
 *   `im_task_run_steps` and fan-out an `IMSyncEvent` of type
 *   `task.step.appended` so subscribers (Wave 4 front-end
 *   InlineActivityStream) can render in real time.
 *
 * Idempotency invariant
 * ---------------------
 * Daemon allocates `seq` monotonically per `taskRunId` (cloud MUST NOT
 * renumber). After a WS reconnect race the daemon may re-send the same
 * `(taskRunId, seq)` frame. We must drop the duplicate silently rather
 * than write a second row.
 *
 * The schema (migration 405) ships `KEY (taskRunId, seq)` (non-unique)
 * because spec §4.4 §1425 explicitly modelled it as a query index, not a
 * constraint. To still get idempotence we derive a deterministic `id`
 * from `(taskRunId, seq)` via SHA-256 and use `INSERT IGNORE` on the
 * PRIMARY KEY — same effect as a unique constraint, no schema delta.
 *
 * SSE event payload
 * -----------------
 * Type: `task.step.appended` (NOT `task.heartbeat` — those remain B3's
 * sibling channel for phase-level liveness).
 * Data: `{ taskRunId, taskId, step: { seq, kind, payload, occurredAt,
 * durationMs } }` — front-end has everything it needs without a refetch.
 */

import crypto from 'node:crypto';
import prisma from '../db';
import type { SyncService } from './sync.service';

const log = (msg: string, extra?: Record<string, unknown>) => {
  // Match the rest of the codebase's `[Module]` prefix convention.
  if (extra) console.log(`[TaskStepRecorder] ${msg}`, extra);
  else console.log(`[TaskStepRecorder] ${msg}`);
};
const warn = (msg: string, extra?: Record<string, unknown>) => {
  if (extra) console.warn(`[TaskStepRecorder] ${msg}`, extra);
  else console.warn(`[TaskStepRecorder] ${msg}`);
};

export type TaskStepKind =
  | 'phase_change'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning_chunk'
  | 'progress'
  | 'error';

export interface RecordStepInput {
  /** Daemon-allocated, per-taskRun monotonic. seq >= 1. */
  seq: number;
  kind: TaskStepKind | string;
  payload: Record<string, unknown>;
  /** Daemon wall-clock ms or ISO string. */
  occurredAt: number | string;
  /** Optional measured duration of the step (e.g. tool call latency). */
  durationMs?: number | null;
}

export interface RecordedStep {
  id: string;
  taskRunId: string;
  taskId: string;
  seq: number;
  kind: string;
  payload: unknown;
  occurredAt: Date;
  durationMs: number | null;
  /** `true` when a duplicate `(taskRunId, seq)` was suppressed. */
  duplicate: boolean;
}

export interface ListStepsResult {
  steps: Array<{
    id: string;
    seq: number;
    kind: string;
    payloadJson: unknown;
    occurredAt: string;
    durationMs: number | null;
  }>;
  hasMore: boolean;
  /** When `hasMore`, the seq of the last returned row (caller passes as next `afterSeq`). */
  cursor: number | null;
}

export interface TaskStepRecorderDeps {
  syncService?: SyncService;
}

export class TaskStepRecorderService {
  constructor(private readonly deps: TaskStepRecorderDeps = {}) {}

  /**
   * Resolve the taskId for a given taskRunId. Returns null if the run is
   * unknown so callers can short-circuit before doing any IO. The handler
   * uses this for ownership checks before calling {@link recordStep}.
   */
  async resolveRun(taskRunId: string): Promise<{
    id: string;
    taskId: string | null;
    assigneeId: string | null;
    conversationId: string | null;
    creatorId: string | null;
  } | null> {
    if (!taskRunId || typeof taskRunId !== 'string') return null;
    const run = await prisma.iMTaskRun
      .findUnique({
        where: { id: taskRunId },
        select: {
          id: true,
          taskId: true,
          assigneeId: true,
          conversationId: true,
          creatorId: true,
        },
      })
      .catch(() => null);
    return run ?? null;
  }

  /**
   * Persist one step frame + emit `task.step.appended` SyncEvent.
   *
   * Returns `{ duplicate: true }` (no row written) when `(taskRunId, seq)`
   * already exists — callers don't need to inspect, just observability.
   *
   * SSE is still emitted on duplicates? No — we only fire the event when
   * a NEW row landed. Replaying duplicate frames downstream is wasteful
   * and would confuse the front-end gap-detector.
   */
  async recordStep(
    taskRunId: string,
    taskId: string,
    input: RecordStepInput,
    opts: { conversationId?: string | null; recipientImUserId?: string | null } = {},
  ): Promise<RecordedStep> {
    if (!taskRunId) throw new Error('taskRunId required');
    if (!taskId) throw new Error('taskId required');
    if (!Number.isFinite(input.seq) || input.seq < 1) {
      throw new Error(`invalid step.seq: ${input.seq}`);
    }
    if (!input.kind || typeof input.kind !== 'string') {
      throw new Error('step.kind required');
    }

    const occurredAt =
      typeof input.occurredAt === 'number'
        ? new Date(input.occurredAt)
        : typeof input.occurredAt === 'string'
          ? new Date(input.occurredAt)
          : new Date();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error(`invalid step.occurredAt: ${input.occurredAt}`);
    }

    // Deterministic id from (taskRunId, seq) — see header. Truncated SHA-256
    // hex (32 chars) keeps us inside VARCHAR(40) with room to spare.
    const id = crypto
      .createHash('sha256')
      .update(`${taskRunId}:${input.seq}`)
      .digest('hex')
      .slice(0, 32);

    // INSERT IGNORE — PK collision on duplicate (taskRunId, seq) becomes a
    // silent no-op. Prisma's typed iMTaskRunStep.create would throw P2002;
    // raw SQL is cleaner here. NOTE: column "payloadJson" is a reserved
    // word in zero engines we care about; quote with backticks for safety.
    //
    // Returns affectedRows: 0 → duplicate, 1 → new row.
    const affected = await prisma.$executeRaw`
      INSERT IGNORE INTO im_task_run_steps
        (id, taskRunId, taskId, seq, kind, payloadJson, occurredAt, durationMs)
      VALUES (
        ${id},
        ${taskRunId},
        ${taskId},
        ${input.seq},
        ${input.kind},
        ${JSON.stringify(input.payload ?? {})},
        ${occurredAt},
        ${input.durationMs ?? null}
      )
    `;

    const duplicate = Number(affected) === 0;

    const recorded: RecordedStep = {
      id,
      taskRunId,
      taskId,
      seq: input.seq,
      kind: input.kind,
      payload: input.payload ?? {},
      occurredAt,
      durationMs: input.durationMs ?? null,
      duplicate,
    };

    if (duplicate) {
      log(`duplicate step suppressed taskRunId=${taskRunId} seq=${input.seq}`);
      return recorded;
    }

    // Fire SSE only on new rows. Recipient defaults to run.assigneeId so
    // the daemon-side actor (and conversation participants, via the
    // publisher fan-out) get the update. SyncService.publishPending
    // expands participants for us when conversationId is set.
    if (this.deps.syncService) {
      const recipient = opts.recipientImUserId ?? null;
      try {
        await this.deps.syncService.writeEvent(
          'task.step.appended',
          {
            taskRunId,
            taskId,
            step: {
              seq: input.seq,
              kind: input.kind,
              payload: input.payload ?? {},
              occurredAt: occurredAt.toISOString(),
              durationMs: input.durationMs ?? null,
            },
          },
          opts.conversationId ?? null,
          recipient ?? '',
        );
      } catch (err) {
        warn(`writeEvent task.step.appended failed (non-fatal): ${(err as Error).message}`);
      }
    }

    return recorded;
  }

  /**
   * Read back steps for a taskRun, sorted by `seq` ascending.
   *
   * Cursor pagination: `afterSeq` is exclusive (caller passes `cursor`
   * from previous response). `limit` caps at 500 to keep payload size
   * predictable for the front-end timeline.
   */
  async listSteps(
    taskRunId: string,
    opts: { afterSeq?: number | null; limit?: number | null } = {},
  ): Promise<ListStepsResult> {
    if (!taskRunId) throw new Error('taskRunId required');
    const limitRaw = opts.limit;
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 200;
    const afterSeqRaw = opts.afterSeq;
    const afterSeq =
      typeof afterSeqRaw === 'number' && Number.isFinite(afterSeqRaw) && afterSeqRaw >= 0
        ? Math.floor(afterSeqRaw)
        : 0;

    // Fetch limit+1 to detect hasMore without a second roundtrip.
    const rows: Array<{
      id: string;
      seq: bigint | number;
      kind: string;
      payloadJson: unknown;
      occurredAt: Date;
      durationMs: number | null;
    }> = await prisma.$queryRaw`
      SELECT id, seq, kind, payloadJson, occurredAt, durationMs
      FROM im_task_run_steps
      WHERE taskRunId = ${taskRunId} AND seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const cursor = trimmed.length > 0 ? Number(trimmed[trimmed.length - 1].seq) : null;

    return {
      steps: trimmed.map((r) => ({
        id: r.id,
        seq: Number(r.seq),
        kind: r.kind,
        // MySQL JSON column is auto-parsed by the driver into a JS value,
        // but some legacy drivers surface a string. Be defensive.
        payloadJson:
          typeof r.payloadJson === 'string'
            ? safeJsonParse(r.payloadJson)
            : (r.payloadJson ?? {}),
        occurredAt: r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
        durationMs: r.durationMs ?? null,
      })),
      hasMore,
      cursor: hasMore ? cursor : null,
    };
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
