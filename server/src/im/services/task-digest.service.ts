/**
 * Prismer IM — Task Digest Service (release 200 §9 / P9)
 *
 * The "conversation digest" abstraction: every task that lives inside a
 * conversation gets **exactly one** rolling digest message in that
 * conversation. Each task transition (or other lifecycle update) upserts
 * that single message — same row, fresh content + metadata — instead of
 * appending another system event.
 *
 * Why: pre-P9 the chat surface received an `IMMessage` per terminal status
 * change (`task_status_event` for completed / failed / cancelled). Repeat
 * cycles (fail → retry → complete) bloated chat with redundant rows, and
 * non-terminal transitions (assigned / running / review / blocked) had no
 * representation at all. The digest model unifies both ends:
 *
 *   • One message per task, regardless of how many transitions it goes
 *     through (the row's `metadata.taskDigest` reflects the latest state).
 *   • All transitions surface — not just terminal ones — so a creator can
 *     see "review pending your approval" without the assignee having to
 *     also post a chat message.
 *
 * Inbox bell notifications (`pc_notifications` via `notification-emitter`)
 * are a **parallel, independent path** and intentionally untouched by this
 * service — the bell drawer surfaces "approval requested" / "task assigned"
 * etc. as their own rows, regardless of whether the conversation has a
 * digest.
 *
 * Storage approach: we use the existing `IMMessage` table (no new schema).
 * The digest message is identified by `metadata.taskDigest.taskId`, and
 * uniqueness is enforced by the lookup itself (we always findFirst before
 * insert). Stringified-JSON `metadata.contains` is used for the find — this
 * is portable across SQLite and MySQL since `metadata` is a TEXT column.
 *
 * Design ref: `docs/release200/15-task-state-machine-and-kanban.md` §7
 * (UI dual-track) end paragraph + §9 P9.
 */

import type { MessageEmitter } from './task-message-bridge';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('TaskDigestService');

export type DigestStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'review'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DigestTaskRef {
  id: string;
  title: string;
  conversationId: string | null;
  creatorId: string;
  assigneeId: string | null;
  workspaceId?: string | null;
}

/**
 * Lightweight projection of a deliverable IMAsset surfaced on the digest so
 * the chat card can render a "N 个产物" affordance without a follow-up
 * `/assets` query. Intentionally minimal — the full asset (and its preview /
 * download) lives in the task drawer Artifacts tab; this is just a teaser.
 */
export interface DigestAssetRef {
  assetId: string;
  filename?: string | null;
  mime?: string | null;
}

export interface DigestTransition {
  from: DigestStatus | null;
  to: DigestStatus;
  by?: string | null;
  reason?: string | null;
  /** ISO timestamp; the service stamps `Date.now()` when omitted. */
  at?: string;
  /** Optional payload echoed back to the renderer (errors, output preview). */
  error?: string | null;
  outputPreview?: string | null;
  /**
   * B-line (release201/3x) — count of task-bound deliverable assets produced
   * by this run. Surfaces the "result is a product, not inline prose" model:
   * the completed digest card renders a chip routing to the drawer Artifacts
   * tab instead of echoing output text. Derived from
   * `task.result.assetIds` / `metadata.outputAssetIds` at the emit site —
   * NOT by mirroring `output` into an IMAsset (Wave-9 dropped that path).
   */
  resultAssetCount?: number | null;
  /** Up to a few lightweight refs for richer teaser copy (capped by caller). */
  resultAssets?: DigestAssetRef[] | null;
}

/** Stable marker — used to scope the metadata.contains LIKE filter. */
const DIGEST_MARKER_KEY = '"digestKind":"task_digest"';

function truncate(value: string | null | undefined, max: number): string {
  const s = (value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Compute the human-readable headline for the digest message. This is the
 * `content` field — clients that do not understand the `taskDigest`
 * metadata still render a sensible one-liner.
 */
export function renderDigestContent(task: DigestTaskRef, to: DigestStatus, reason?: string | null): string {
  const t = truncate(task.title, 80);
  switch (to) {
    case 'pending':
      return `📋 Task pending: **${t}**`;
    case 'assigned':
      return `📨 Task assigned: **${t}**`;
    case 'running':
      return `▶ Task running: **${t}**`;
    case 'review':
      return `🔍 Task awaiting review: **${t}**`;
    case 'blocked':
      return reason ? `⚠️ Task blocked: **${t}** · ${truncate(reason, 160)}` : `⚠️ Task blocked: **${t}**`;
    case 'completed':
      return `✅ Task completed: **${t}**`;
    case 'failed':
      return reason ? `❌ Task failed: **${t}** · ${truncate(reason, 160)}` : `❌ Task failed: **${t}**`;
    case 'cancelled':
      return `🚫 Task cancelled: **${t}**`;
  }
}

export interface TaskDigestServiceDeps {
  messageService: MessageEmitter;
}

export class TaskDigestService {
  constructor(private deps: TaskDigestServiceDeps) {}

  /**
   * Upsert the digest message for `task` in its linked conversation. Same
   * `taskId` always reuses the same `IMMessage`. Fire-and-forget — failures
   * are logged but do not propagate (the lifecycle write already committed
   * before we are called).
   */
  async upsertTaskDigest(task: DigestTaskRef, transition: DigestTransition): Promise<void> {
    if (!task.conversationId) return;
    const conversationId = task.conversationId;

    // The digest is system-authored; pick the most representative
    // participant as sender so it shows up on the right side for the
    // "actor" of the latest change. Same defaulting as the legacy
    // emitTaskStatusChat path so the existing UI keeps its placement.
    const senderId =
      transition.to === 'cancelled' ? (transition.by ?? task.creatorId) : (task.assigneeId ?? task.creatorId);

    const at = transition.at ?? new Date().toISOString();
    const payload = {
      taskDigest: {
        taskId: task.id,
        taskTitle: task.title,
        status: transition.to,
        previousStatus: transition.from ?? null,
        latestTransition: {
          from: transition.from ?? null,
          to: transition.to,
          by: transition.by ?? null,
          reason: transition.reason ?? null,
          at,
        },
        creatorId: task.creatorId,
        assigneeId: task.assigneeId ?? null,
        workspaceId: task.workspaceId ?? null,
        ...(transition.error ? { error: truncate(transition.error, 500) } : {}),
        ...(transition.outputPreview ? { outputPreview: truncate(transition.outputPreview, 200) } : {}),
        ...(typeof transition.resultAssetCount === 'number' && transition.resultAssetCount > 0
          ? { resultAssetCount: transition.resultAssetCount }
          : {}),
        ...(transition.resultAssets && transition.resultAssets.length > 0
          ? {
              resultAssets: transition.resultAssets.slice(0, 4).map((a) => ({
                assetId: a.assetId,
                ...(a.filename ? { filename: truncate(a.filename, 120) } : {}),
                ...(a.mime ? { mime: a.mime } : {}),
              })),
            }
          : {}),
      },
      // Backward compat: pre-P9 chat clients keyed off `metadata.kind`. We
      // keep that shape for terminal states so the existing
      // `TaskStatusEventRow` renderer continues to work as a graceful
      // fallback (e.g. old mobile clients still on TaskStatusEvent code
      // paths). Modern clients prefer `taskDigest` and ignore `kind`.
      kind: 'task_digest' as const,
      taskId: task.id,
      taskTitle: task.title,
      status: transition.to,
      // Discriminator used by the metadata.contains lookup. Independent
      // from `kind` so clients can rename `kind` without breaking upsert.
      digestKind: 'task_digest' as const,
      ...(transition.error ? { error: truncate(transition.error, 500) } : {}),
    };

    const content = renderDigestContent(task, transition.to, transition.reason ?? null);

    try {
      const existing = await this.findExistingDigest(conversationId, task.id);
      if (existing) {
        await this.deps.messageService.update(existing.id, {
          content,
          metadata: payload,
        });
        return;
      }
      await this.deps.messageService.send({
        conversationId,
        senderId,
        type: 'system',
        content,
        metadata: payload,
      });
    } catch (err) {
      log.warn(
        `task_digest upsert failed for task ${task.id} in conversation ${conversationId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Find the digest message for this task within the conversation. Uses
   * `metadata.contains` LIKE — portable across MySQL TEXT and SQLite TEXT.
   * Returns null when none exists (first transition for this task).
   *
   * Performance: bounded by the conversation's system-message volume (which
   * is small — system events are an order of magnitude less frequent than
   * user chat). Adding a generated column + index later is straightforward
   * if a workspace hits a hot loop; not needed for v2.0 launch.
   */
  private async findExistingDigest(conversationId: string, taskId: string): Promise<{ id: string } | null> {
    const taskIdMarker = `"taskId":"${taskId}"`;
    // Two markers must both appear: digestKind (scopes to digest rows) and
    // the specific taskId. Prisma's filter combinator runs an AND so the
    // search collapses to a single LIKE+LIKE on the TEXT column.
    const row = await prisma.iMMessage.findFirst({
      where: {
        conversationId,
        type: 'system',
        AND: [{ metadata: { contains: DIGEST_MARKER_KEY } }, { metadata: { contains: taskIdMarker } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return row;
  }
}
