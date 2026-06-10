/**
 * Prismer IM — TaskSpecService (release201/10 rev 2 §5.3)
 *
 * Thin wrapper around IMAsset (boundKind='task-bound', filename='SPEC.md',
 * sourceTaskId=<tid>). Each owner edit writes a new IMAssetRevision and
 * (when the task is post-assignment) emits SSE `task.spec.updated` so the
 * assignee surface can ack.
 *
 * Suggested SPEC.md structure (not enforced — §2.3):
 *   ## Goal
 *   ## Background
 *   ## Constraints (or Objective)
 *   ## Out of scope
 *
 * Forbidden patterns (§0.2.4):
 *   - log "[spec] update after assignment without ack"
 *   - direct IMAsset.storageUri UPDATE
 */

import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { metricEmit } from './metric.service';

const log = createModuleLogger('TaskSpecService');

const RESERVED_FILENAME_SPEC = 'SPEC.md';

export interface SpecView {
  markdown: string;
  revision: number;
  updatedAt: Date | null;
}

export interface TaskSpecServiceDeps {
  eventBusService?: {
    publish: (msg: any) => any;
  };
}

export class SpecError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.status = status;
  }
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

function makeAssetId(): string {
  return 'a' + crypto.randomBytes(12).toString('base64url').slice(0, 14);
}

function makeRevisionId(): string {
  return 'r' + crypto.randomBytes(12).toString('base64url').slice(0, 14);
}

export class TaskSpecService {
  private deps: TaskSpecServiceDeps;
  constructor(deps: TaskSpecServiceDeps = {}) {
    this.deps = deps;
  }

  async get(taskId: string): Promise<SpecView> {
    const asset = await this.findLatestAsset(taskId);
    if (!asset) return { markdown: '', revision: 0, updatedAt: null };
    const md = await this.readLatestBody(asset.id);
    return { markdown: md, revision: asset.revision ?? 1, updatedAt: asset.updatedAt ?? null };
  }

  /**
   * Set SPEC.md content. Returns the new revision number. Emits SSE
   * `task.spec.updated` when this is an UPDATE (not the first set).
   * Also emits the anti-drift metric `task.spec.updated_after_assignment`
   * if the task is no longer in pending state.
   */
  async set(taskId: string, markdown: string, actorId: string): Promise<{ revision: number; updatedAt: Date }> {
    if (typeof markdown !== 'string') throw new SpecError('validation', 'markdown is required');
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true, status: true, assigneeId: true } as never,
    });
    if (!task) throw new SpecError('task_not_found', `task ${taskId} not found`, 404);

    const workspaceId = (task as { workspaceId: string }).workspaceId;
    const contentHash = sha256Hex(markdown);
    const storageUri = `inline-markdown://spec/${taskId}/${contentHash.slice(0, 12)}`;
    const sizeBytes = BigInt(Buffer.byteLength(markdown, 'utf-8'));

    const existing = await this.findLatestAsset(taskId);
    const isUpdate = !!existing;
    let assetId: string;
    let nextRevision: number;

    if (!existing) {
      assetId = makeAssetId();
      nextRevision = 1;
      await prisma.iMAsset.create({
        data: {
          id: assetId,
          workspaceId,
          ownerImUserId: actorId,
          contentHash,
          storageUri,
          sizeBytes,
          mime: 'text/markdown',
          kind: 'document',
          sourceTaskId: taskId,
          metadata: JSON.stringify({ reservedFilename: RESERVED_FILENAME_SPEC, source: 'spec-service' }),
          revision: 1,
          visibility: 'task',
          filename: RESERVED_FILENAME_SPEC,
          boundKind: 'task-bound',
        } as never,
      });
    } else {
      assetId = existing.id;
      nextRevision = (existing.revision ?? 1) + 1;
      await prisma.iMAsset.update({
        where: { id: assetId },
        data: { contentHash, storageUri, sizeBytes, revision: nextRevision } as never,
      });
    }

    await prisma.iMAssetRevision.create({
      data: {
        id: makeRevisionId(),
        assetId,
        workspaceId,
        revision: nextRevision,
        contentHash,
        storageUri,
        sizeBytes,
        mime: 'text/markdown',
        kind: 'document',
        ownerImUserId: actorId,
        sourceTaskId: taskId,
        metadata: JSON.stringify({ reservedFilename: RESERVED_FILENAME_SPEC, body: markdown }),
        ingestStatus: 'ready',
        ingestVersion: 1,
        filename: RESERVED_FILENAME_SPEC,
        visibility: 'task',
        createdByImUserId: actorId,
        reason: 'spec.set',
      } as never,
    });

    const now = new Date();

    // §6.5 SSE — push to assignee on update so they can ack.
    if (isUpdate && this.deps.eventBusService) {
      try {
        const ret = this.deps.eventBusService.publish({
          type: 'task.spec.updated',
          timestamp: Date.now(),
          data: {
            taskId,
            byActorId: actorId,
            revision: nextRevision,
            recipientHint: (task as { assigneeId: string | null }).assigneeId ?? null,
          },
        });
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow */
      }
    }

    // §F1 anti-drift metric — only when SPEC changes AFTER assignment.
    const status = (task as { status: string }).status;
    if (isUpdate && status !== 'pending') {
      try {
        metricEmit({
          namespace: 'task.spec',
          name: 'updated_after_assignment',
          value: 1,
          dims: { workspaceId, taskId, status },
        });
      } catch {
        /* swallow */
      }
    }

    return { revision: nextRevision, updatedAt: now };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async findLatestAsset(taskId: string): Promise<{
    id: string;
    storageUri: string;
    revision: number | null;
    updatedAt: Date | null;
  } | null> {
    const row = (await prisma.iMAsset.findFirst({
      where: {
        sourceTaskId: taskId,
        filename: RESERVED_FILENAME_SPEC,
        boundKind: 'task-bound',
        deletedAt: null,
      } as never,
      select: { id: true, storageUri: true, revision: true, updatedAt: true } as never,
    })) as unknown as {
      id: string;
      storageUri: string;
      revision: number | null;
      updatedAt: Date | null;
    } | null;
    return row;
  }

  private async readLatestBody(assetId: string): Promise<string> {
    const rev = await prisma.iMAssetRevision.findFirst({
      where: { assetId, deletedAt: null } as never,
      orderBy: { revision: 'desc' } as never,
      select: { metadata: true } as never,
    });
    if (!rev) return '';
    try {
      const md = JSON.parse((rev as { metadata: string }).metadata);
      if (md && typeof md === 'object' && typeof (md as { body?: string }).body === 'string') {
        return (md as { body: string }).body;
      }
    } catch {
      /* fall through */
    }
    log.warn({ assetId }, 'SPEC.md content not available inline — caller should re-write via TaskSpecService.set');
    return '';
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: TaskSpecService | null = null;
export function getTaskSpecService(deps?: TaskSpecServiceDeps): TaskSpecService {
  if (!_singleton) {
    _singleton = new TaskSpecService(deps);
  } else if (deps?.eventBusService && !(_singleton as any).deps?.eventBusService) {
    (_singleton as any).deps = { ...((_singleton as any).deps ?? {}), eventBusService: deps.eventBusService };
  }
  return _singleton;
}

export function __setTaskSpecServiceForTests(svc: TaskSpecService | null): void {
  _singleton = svc;
}
