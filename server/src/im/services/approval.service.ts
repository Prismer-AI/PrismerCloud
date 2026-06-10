import { createHash } from 'crypto';
import prisma from '../db';
import { ServerEvents } from '../ws/events';
import type { RoomManager } from '../ws/rooms';
import type { TaskService } from './task.service';
import type { ApprovalInfo, ApprovalOption, ApprovalStatus } from '../types';
import { createModuleLogger } from '../../lib/logger';
import { emitHumanApprovalRequestedNotification } from '../../lib/notification-emitter';
import { metricEmit } from './metric.service';

const log = createModuleLogger('ApprovalService');

/**
 * Normalize metadata.taskId for intentHash computation.
 *
 * - Plain string taskIds pass through as-is
 * - undefined / null / non-string → 'none' placeholder (so a missing taskId
 *   still forms a stable hash for the (workspace, conv, category) tuple)
 * - Empty strings are also treated as 'none' to avoid collisions with the
 *   "no task" bucket
 */
export function normalizeTaskId(taskId: unknown): string {
  if (typeof taskId !== 'string') return 'none';
  const trimmed = taskId.trim();
  return trimmed.length === 0 ? 'none' : trimmed;
}

/**
 * Truncate an ISO timestamp to an hour bucket so approvals created within
 * the same 1h window dedup against each other.
 *
 * `2026-05-21T13:42:11.123Z` → `2026-05-21T13`
 */
export function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/**
 * v2.0 §4.4.8.3 — server-side intent dedup hash.
 *
 * sha256(workspaceId + '|' + conversationId + '|' + category + '|' +
 *        normalizeTaskId(metadata.taskId) + '|' + hourBucket(createdAt))
 *
 * The pipe `|` delimiter prevents collisions between adjacent fields
 * (e.g. `"a|b"` + `"c"` vs `"a"` + `"b|c"`). Returned as lowercase hex,
 * 64 chars (fits the VARCHAR(64) column).
 */
export function computeIntentHash(parts: {
  workspaceId: string;
  conversationId: string | null;
  category: string;
  taskId: unknown;
  createdAt: Date;
}): string {
  const payload = [
    parts.workspaceId,
    parts.conversationId ?? '',
    parts.category,
    normalizeTaskId(parts.taskId),
    hourBucket(parts.createdAt),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

const DEFAULT_OPTIONS: ApprovalOption[] = [
  { value: 'approve', label: 'Approve' },
  { value: 'reject', label: 'Reject' },
];

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalValidationError';
  }
}

export class ApprovalAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalAccessError';
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval not found: ${id}`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export interface CreateApprovalInput {
  workspaceId?: string;
  conversationId?: string;
  taskId?: string;
  category: string;
  title: string;
  context?: string | null;
  options?: ApprovalOption[];
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface ApprovalListQuery {
  workspaceId?: string;
  conversationId?: string;
  taskId?: string;
  status?: ApprovalStatus;
  limit?: number;
  cursor?: string;
}

export interface ApprovalDecisionInput {
  selectedValue: string;
  status?: 'approved' | 'rejected';
  comment?: string;
  metadata?: Record<string, unknown>;
}

export class ApprovalService {
  constructor(
    private readonly deps: {
      rooms: RoomManager;
      taskService: TaskService;
    },
  ) {}

  async createApproval(requestedById: string, input: CreateApprovalInput): Promise<ApprovalInfo> {
    if (!input.conversationId && !input.taskId) {
      throw new ApprovalValidationError('conversationId or taskId is required');
    }
    if (!input.category || !input.title) {
      throw new ApprovalValidationError('category and title are required');
    }

    const workspaceId = await this.resolveAndValidateWorkspace(input);
    await this.requireWorkspaceVisible(requestedById, workspaceId);
    if (input.conversationId) await this.requireConversationVisible(requestedById, input.conversationId);
    if (input.taskId) await this.requireTaskVisible(requestedById, input.taskId);
    const now = new Date();
    const expiresAt = input.expiresInSeconds
      ? new Date(now.getTime() + Math.max(1, input.expiresInSeconds) * 1000)
      : new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // v2.0 §4.4.8.3 — compute intentHash from workspace + conv + category +
    // metadata.taskId + 1h bucket. metadata.taskId is preferred over the
    // top-level input.taskId so an agent emitting "same intent, different
    // task row" (e.g. a follow-up clone) still collapses against the prior
    // pending approval.
    const metadata = input.metadata ?? {};
    const metadataTaskId = (metadata as Record<string, unknown>).taskId ?? input.taskId;
    const intentHash = computeIntentHash({
      workspaceId,
      conversationId: input.conversationId ?? null,
      category: input.category,
      taskId: metadataTaskId,
      createdAt: now,
    });

    // Dedup: if a pending approval with the same intentHash already exists
    // in the same (workspace, conversation) bucket, return it instead of
    // minting a new row. The composite intent_idx (migration 411) keeps
    // this lookup O(log N).
    //
    // Note: status='pending' must be part of the query because a previously
    // decided approval should NOT block a fresh intent (the user has already
    // resolved that one).
    const existing = await this.findPendingByIntentHash({
      workspaceId,
      conversationId: input.conversationId ?? null,
      intentHash,
    });
    if (existing) {
      log.info?.(
        `[ApprovalService] dedup hit — returning existing approval ${existing.id} ` +
          `for intentHash ${intentHash.slice(0, 12)}…`,
      );
      return this.toApprovalInfo(existing);
    }

    const approval = await (prisma as any).iMApproval.create({
      data: {
        workspaceId,
        conversationId: input.conversationId ?? null,
        taskId: input.taskId ?? null,
        requestedById,
        category: input.category,
        intentHash,
        title: input.title,
        context: input.context ?? null,
        options: JSON.stringify(this.normalizeOptions(input.options)),
        metadata: JSON.stringify(metadata),
        expiresAt,
      },
    });

    const info = this.toApprovalInfo(approval);
    await this.emitBellNotifications(info);
    await this.emitRequested(info);
    return info;
  }

  /**
   * v2.0 §4.4.8.3 — lookup helper for intent dedup. Returns the earliest
   * pending approval row matching (workspaceId, conversationId, intentHash).
   *
   * Note: the composite index (migration 411) is `intent_idx` on
   * (workspaceId, conversationId, intentHash, status). It is **non-unique**
   * because race-condition writers can still create duplicate rows; we use
   * `findFirst` (oldest) so all concurrent writers converge onto the same
   * canonical id on retry/dedup. Exported as an instance method so callers
   * (and tests) can introspect raw row state.
   */
  async findPendingByIntentHash(params: {
    workspaceId: string;
    conversationId: string | null;
    intentHash: string;
  }): Promise<any | null> {
    return (prisma as any).iMApproval.findFirst({
      where: {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        intentHash: params.intentHash,
        status: 'pending',
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listApprovals(actorId: string, query: ApprovalListQuery): Promise<ApprovalInfo[]> {
    const where: Record<string, unknown> = {};
    if (query.workspaceId) {
      await this.requireWorkspaceVisible(actorId, query.workspaceId);
      where.workspaceId = query.workspaceId;
    }
    if (query.conversationId) {
      await this.requireConversationVisible(actorId, query.conversationId);
      where.conversationId = query.conversationId;
    }
    if (query.taskId) {
      await this.requireTaskVisible(actorId, query.taskId);
      where.taskId = query.taskId;
    }
    if (!query.workspaceId && !query.conversationId && !query.taskId) {
      const workspaceIds = await this.visibleWorkspaceIds(actorId);
      where.workspaceId = { in: workspaceIds };
    }
    if (query.status) where.status = query.status;
    if (query.cursor) where.id = { lt: query.cursor };

    const rows = await (prisma as any).iMApproval.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(query.limit ?? 50, 1), 100),
    });
    return rows.map((row: any) => this.toApprovalInfo(row));
  }

  async decideApproval(approvalId: string, actorId: string, input: ApprovalDecisionInput): Promise<ApprovalInfo> {
    const existing = await (prisma as any).iMApproval.findUnique({ where: { id: approvalId } });
    if (!existing) throw new ApprovalNotFoundError(approvalId);
    await this.requireWorkspaceVisible(actorId, existing.workspaceId);
    if (existing.conversationId) await this.requireConversationVisible(actorId, existing.conversationId);
    if (existing.taskId) await this.requireTaskVisible(actorId, existing.taskId);
    await this.requireHumanDecisionActor(actorId);

    if (existing.status !== 'pending') {
      throw new ApprovalConflictError(`approval is already ${existing.status}`);
    }
    if (existing.expiresAt && existing.expiresAt <= new Date()) {
      const expired = await (prisma as any).iMApproval.update({
        where: { id: approvalId },
        data: { status: 'expired' },
      });
      throw new ApprovalConflictError(`approval expired at ${expired.expiresAt.toISOString()}`);
    }
    if (!input.selectedValue || typeof input.selectedValue !== 'string') {
      throw new ApprovalValidationError('selectedValue is required');
    }
    if (input.status && !['approved', 'rejected'].includes(input.status)) {
      throw new ApprovalValidationError("status must be 'approved' or 'rejected'");
    }

    const options = this.parseOptions(existing.options);
    const selected = options.find((opt) => opt.value === input.selectedValue);
    // release201/25 §16.4 A6 — hermes-native `deny` joins legacy `reject`
    // as a denial. All other values (approve / once / session / always /
    // custom) resolve to 'approved' unless the caller overrode `status`.
    const isDenial = input.selectedValue === 'reject' || input.selectedValue === 'deny';
    const status = input.status ?? (isDenial ? 'rejected' : 'approved');
    const metadata = {
      ...this.parseObject(existing.metadata),
      ...(input.metadata ?? {}),
      decisionComment: input.comment,
      selectedLabel: selected?.label ?? null,
    };

    const updated = await (prisma as any).iMApproval.update({
      where: { id: approvalId },
      data: {
        status,
        selectedValue: input.selectedValue,
        decidedById: actorId,
        decidedAt: new Date(),
        metadata: JSON.stringify(metadata),
      },
    });

    const info = this.toApprovalInfo(updated);
    await this.emitDecided(info);

    // release201/11 §4 #11 — emit approval.decided metric.
    {
      const latencyMs =
        updated.decidedAt && updated.createdAt
          ? Math.max(0, new Date(updated.decidedAt).getTime() - new Date(updated.createdAt).getTime())
          : null;
      metricEmit({
        namespace: 'approval',
        name: 'decided',
        value: status === 'approved' ? 'approve' : 'reject',
        dims: {
          workspaceId: updated.workspaceId,
          taskId: updated.taskId ?? undefined,
          decisionBy: actorId,
          latencyMs: latencyMs ?? undefined,
        },
      });
    }

    void this.reDispatchAfterDecision(info).catch((err) =>
      log.warn(`approval decision redispatch failed for ${approvalId}: ${(err as Error).message}`),
    );
    return info;
  }

  private async resolveAndValidateWorkspace(input: CreateApprovalInput): Promise<string> {
    const derived = new Set<string>();
    if (input.taskId) {
      const task = await prisma.iMTask.findUnique({ where: { id: input.taskId }, select: { workspaceId: true } });
      if (task?.workspaceId) derived.add(task.workspaceId);
      const run = await prisma.iMTaskRun.findUnique({ where: { id: input.taskId }, select: { workspaceId: true } });
      if (run?.workspaceId) derived.add(run.workspaceId);
    }
    if (input.conversationId) {
      const conversation = await prisma.iMConversation.findUnique({
        where: { id: input.conversationId },
        select: { workspaceId: true },
      });
      if (conversation?.workspaceId) derived.add(conversation.workspaceId);
    }
    if (derived.size > 1) {
      throw new ApprovalValidationError('taskId and conversationId belong to different workspaces');
    }
    const derivedWorkspaceId = [...derived][0];
    if (input.workspaceId && derivedWorkspaceId && input.workspaceId !== derivedWorkspaceId) {
      throw new ApprovalValidationError('workspaceId does not match task or conversation workspace');
    }
    const workspaceId = input.workspaceId ?? derivedWorkspaceId;
    if (!workspaceId) throw new ApprovalValidationError('workspaceId is required when it cannot be derived');
    return workspaceId;
  }

  private async emitRequested(approval: ApprovalInfo): Promise<void> {
    const event = ServerEvents.approvalRequested({
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      conversationId: approval.conversationId,
      taskId: approval.taskId,
      requestedById: approval.requestedById,
      category: approval.category,
      title: approval.title,
      status: 'pending',
      createdAt: approval.createdAt.toISOString(),
      expiresAt: approval.expiresAt?.toISOString() ?? null,
    });
    await this.emitToApprovalAudience(approval.workspaceId, approval.conversationId, event);
  }

  private async emitDecided(approval: ApprovalInfo): Promise<void> {
    if (!approval.decidedById || !approval.decidedAt) return;
    const event = ServerEvents.approvalDecided({
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      conversationId: approval.conversationId,
      taskId: approval.taskId,
      requestedById: approval.requestedById,
      decidedById: approval.decidedById,
      status: approval.status as 'approved' | 'rejected' | 'expired',
      selectedValue: approval.selectedValue,
      decidedAt: approval.decidedAt.toISOString(),
    });
    await this.emitToApprovalAudience(approval.workspaceId, approval.conversationId, event);
  }

  private async emitToApprovalAudience(workspaceId: string, conversationId: string | null, event: any): Promise<void> {
    if (conversationId) {
      this.deps.rooms.broadcastToRoom(conversationId, event);
    }
    const users = await this.workspaceAudience(workspaceId);
    for (const userId of users) {
      this.deps.rooms.sendToUser(userId, event);
    }
  }

  private async emitBellNotifications(approval: ApprovalInfo): Promise<void> {
    const recipients = await this.workspaceAudience(approval.workspaceId);
    await Promise.allSettled(
      recipients
        .filter((userId) => userId !== approval.requestedById)
        .map((recipientImUserId) =>
          emitHumanApprovalRequestedNotification({
            approvalId: approval.id,
            recipientImUserId,
            requestedByImUserId: approval.requestedById,
            taskId: approval.taskId ?? '',
            title: approval.title,
            category: approval.category,
            context: approval.context,
            conversationId: approval.conversationId,
            workspaceId: approval.workspaceId,
          }),
        ),
    );
    for (const userId of recipients) {
      await this.deps.taskService.fanOutApprovalBellSync(userId, {
        approvalId: approval.id,
        workspaceId: approval.workspaceId,
        conversationId: approval.conversationId,
        taskId: approval.taskId,
      });
    }
  }

  private async workspaceAudience(workspaceId: string): Promise<string[]> {
    const [workspace, members] = await Promise.all([
      prisma.iMWorkspace.findUnique({ where: { id: workspaceId }, select: { ownerImUserId: true } }),
      prisma.iMWorkspaceMember.findMany({ where: { workspaceId }, select: { memberImUserId: true } }),
    ]);
    return [
      ...new Set(
        [workspace?.ownerImUserId, ...members.map((m: { memberImUserId: string }) => m.memberImUserId)].filter(
          Boolean,
        ) as string[],
      ),
    ];
  }

  private async reDispatchAfterDecision(approval: ApprovalInfo): Promise<void> {
    if (!approval.taskId) {
      await this.deps.taskService.dispatchApprovalDecisionToAgent(approval.requestedById, {
        approvalId: approval.id,
        workspaceId: approval.workspaceId,
        conversationId: approval.conversationId,
        title: approval.title,
        status: approval.status,
        selectedValue: approval.selectedValue,
        decidedById: approval.decidedById,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        comment: typeof approval.metadata.decisionComment === 'string' ? approval.metadata.decisionComment : null,
      });
      return;
    }
    await this.deps.taskService.applyApprovalDecisionAndRedispatch(approval.taskId, {
      approvalId: approval.id,
      title: approval.title,
      status: approval.status,
      selectedValue: approval.selectedValue,
      decidedById: approval.decidedById,
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      comment: typeof approval.metadata.decisionComment === 'string' ? approval.metadata.decisionComment : null,
    });
    // release201/25 §16.4 A6 — additionally forward the choice to the
    // assignee's daemon so the hermes adapter can call native
    // POST /v1/runs/{runId}/approval. Cloud-side persistence + redispatch
    // (above) is unchanged; this second emit only carries the
    // hermes-choice mapping needed for native HITL state alignment.
    //
    // Map cloud-side selectedValue → hermes-native choice:
    //   - 'once' / 'session' / 'always' / 'deny' pass through verbatim
    //   - legacy 'approve' → 'once', 'reject' → 'deny' for back-compat
    // No-op when the task has no assignee (orphan task) or when the
    // approval row is missing the cloud-side selectedValue (validation
    // already gated this on the decideApproval entrypoint).
    await this.forwardApprovalToDaemon(approval).catch((err) =>
      log.warn(
        `forward approval to daemon failed for ${approval.id}: ${(err as Error).message}`,
      ),
    );
  }

  private async forwardApprovalToDaemon(approval: ApprovalInfo): Promise<void> {
    if (!approval.taskId || !approval.selectedValue) return;
    const choice = this.mapSelectedValueToHermesChoice(approval.selectedValue);
    if (!choice) return;
    const task = await prisma.iMTask.findUnique({
      where: { id: approval.taskId },
      select: { assigneeId: true },
    });
    const assigneeId = task?.assigneeId ?? null;
    if (!assigneeId) {
      // Fallback: the redispatch path above already targeted the run's
      // assignee via the daemon dispatch pipeline. Without an
      // assignee row we can't address a specific daemon socket from
      // here — log and skip.
      log.warn(
        `approval ${approval.id} → no taskId assignee, skipping daemon-side hermes resolve forward`,
      );
      return;
    }
    const event = ServerEvents.taskApprovalResolve({
      taskId: approval.taskId,
      approvalId: approval.id,
      agentImUserId: assigneeId,
      choice,
      resolveAll: false,
    });
    this.deps.rooms.sendToUser(assigneeId, event);
  }

  private mapSelectedValueToHermesChoice(
    selectedValue: string,
  ): 'once' | 'session' | 'always' | 'deny' | null {
    switch (selectedValue) {
      case 'once':
      case 'session':
      case 'always':
      case 'deny':
        return selectedValue;
      case 'approve':
        return 'once';
      case 'reject':
        return 'deny';
      default:
        return null;
    }
  }

  private async visibleWorkspaceIds(actorId: string): Promise<string[]> {
    const [owned, agentProfiles, memberships] = await Promise.all([
      prisma.iMWorkspace.findMany({ where: { ownerImUserId: actorId, deletedAt: null }, select: { id: true } }),
      prisma.iMAgentProfile.findMany({
        where: { agentImUserId: actorId, deletedAt: null },
        select: { workspaceId: true },
      }),
      prisma.iMWorkspaceMember.findMany({ where: { memberImUserId: actorId }, select: { workspaceId: true } }),
    ]);
    return [
      ...new Set([
        ...owned.map((w: { id: string }) => w.id),
        ...agentProfiles.map((p: { workspaceId: string }) => p.workspaceId),
        ...memberships.map((m: { workspaceId: string }) => m.workspaceId),
      ]),
    ];
  }

  private async requireWorkspaceVisible(actorId: string, workspaceId: string): Promise<void> {
    const [workspace, agentProfile] = await Promise.all([
      prisma.iMWorkspace.findFirst({
        where: {
          id: workspaceId,
          OR: [{ ownerImUserId: actorId }, { members: { some: { memberImUserId: actorId } } }],
        },
        select: { id: true },
      }),
      prisma.iMAgentProfile.findFirst({
        where: { workspaceId, agentImUserId: actorId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!workspace && !agentProfile) throw new ApprovalAccessError('workspace approval access denied');
  }

  private async requireHumanDecisionActor(actorId: string): Promise<void> {
    const actor = await prisma.iMUser.findUnique({ where: { id: actorId }, select: { role: true } });
    if (actor?.role === 'human' || actor?.role === 'admin') return;
    throw new ApprovalAccessError('only human or admin users can decide approvals');
  }

  private async requireConversationVisible(actorId: string, conversationId: string): Promise<void> {
    const participant = await prisma.iMParticipant.findUnique({
      where: { conversationId_imUserId: { conversationId, imUserId: actorId } },
      select: { id: true },
    });
    if (participant) return;
    const conversation = await prisma.iMConversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true },
    });
    if (conversation?.workspaceId) {
      await this.requireWorkspaceVisible(actorId, conversation.workspaceId);
      return;
    }
    throw new ApprovalAccessError('conversation approval access denied');
  }

  private async requireTaskVisible(actorId: string, taskId: string): Promise<void> {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { creatorId: true, assigneeId: true, workspaceId: true },
    });
    if (task) {
      if (task.creatorId === actorId || task.assigneeId === actorId) return;
      if (task.workspaceId) return this.requireWorkspaceVisible(actorId, task.workspaceId);
    }
    const run = await prisma.iMTaskRun.findUnique({
      where: { id: taskId },
      select: { creatorId: true, assigneeId: true, actorId: true, workspaceId: true },
    });
    if (run) {
      if (run.creatorId === actorId || run.assigneeId === actorId || run.actorId === actorId) return;
      if (run.workspaceId) return this.requireWorkspaceVisible(actorId, run.workspaceId);
    }
    throw new ApprovalAccessError('task approval access denied');
  }

  private normalizeOptions(options: ApprovalOption[] | undefined): ApprovalOption[] {
    const list = Array.isArray(options) && options.length > 0 ? options : DEFAULT_OPTIONS;
    return list.map((option) => ({
      value: String(option.value),
      label: String(option.label ?? option.value),
      ...(option.hint ? { hint: String(option.hint) } : {}),
    }));
  }

  private parseOptions(raw: string): ApprovalOption[] {
    const parsed = this.parseArray(raw);
    return parsed.length > 0 ? (parsed as ApprovalOption[]) : DEFAULT_OPTIONS;
  }

  private parseArray(raw: string | null | undefined): unknown[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private parseObject(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private toApprovalInfo(row: any): ApprovalInfo {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      conversationId: row.conversationId ?? null,
      taskId: row.taskId ?? null,
      requestedById: row.requestedById,
      decidedById: row.decidedById ?? null,
      category: row.category,
      // v2.0 §4.4.8.3 — propagate intentHash so C3 UI ("Similar to above —
      // dedup proposed" hint) lights up. Legacy rows with NULL intentHash
      // surface as `null` — UI hides the hint gracefully.
      intentHash: row.intentHash ?? null,
      title: row.title,
      context: row.context ?? null,
      options: this.parseOptions(row.options),
      status: row.status,
      selectedValue: row.selectedValue ?? null,
      metadata: this.parseObject(row.metadata),
      createdAt: row.createdAt,
      decidedAt: row.decidedAt ?? null,
      expiresAt: row.expiresAt ?? null,
    };
  }
}
