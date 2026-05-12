/**
 * Prismer IM — Task Model
 *
 * CRUD operations for im_tasks + im_task_logs (Cloud Task Store).
 */

import prisma from '../db';
import type { TaskStatus, ScheduleType } from '../types';

export interface CreateTaskData {
  title: string;
  description?: string;
  capability?: string;
  input?: string; // JSON
  contextUri?: string;
  creatorId: string;
  assigneeId?: string;
  workspaceId?: string;
  /** @deprecated v1.9.x dropped im_tasks.scope; use workspaceId. Accepted for legacy callers but ignored. */
  scope?: string;
  conversationId?: string;
  status?: TaskStatus;
  scheduleType?: ScheduleType;
  scheduleAt?: Date;
  scheduleCron?: string;
  intervalMs?: number;
  nextRunAt?: Date;
  maxRuns?: number;
  timeoutMs?: number;
  deadline?: Date;
  maxRetries?: number;
  retryDelayMs?: number;
  budget?: number;
  metadata?: string; // JSON
  /** Cloud 3 / S3: 'agent' | 'sandbox' | 'shell' (defaults to 'agent' at the column level). */
  runtimeRoute?: string;
}

export interface TaskListFilter {
  status?: TaskStatus;
  capability?: string;
  assigneeId?: string;
  creatorId?: string;
  workspaceId?: string;
  /** @deprecated use workspaceId */
  scope?: string;
  conversationId?: string;
  scheduleType?: ScheduleType;
  limit?: number;
  cursor?: string;
}

export interface CreateTaskLogData {
  taskId: string;
  actorId?: string;
  action: string;
  message?: string;
  metadata?: string; // JSON
}

export interface CreateTaskRunData {
  taskId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  triggerMessageId?: string | null;
  creatorId: string;
  assigneeId?: string | null;
  actorId?: string;
  sourceKind?: string;
  capability?: string;
  status?: string;
  runtimeRoute?: string;
  input?: string; // JSON
  output?: string; // JSON/string
  outputUri?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: string; // JSON
}

export interface TaskRunListFilter {
  taskId?: string;
  workspaceId?: string;
  conversationId?: string;
  creatorId?: string;
  assigneeId?: string;
  actorId?: string;
  sourceKind?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateTaskRunData {
  status?: string;
  output?: string;
  outputUri?: string;
  error?: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  metadata?: string;
}

export interface CreateTaskEventData {
  runId: string;
  taskId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  actorId?: string;
  type: string;
  level?: string;
  message?: string;
  payload?: string; // JSON
}

export class TaskModel {
  static readonly DEFAULT_MAX_RETRIES = 3;

  async create(data: CreateTaskData) {
    return prisma.iMTask.create({
      data: {
        title: data.title,
        description: data.description,
        capability: data.capability,
        input: data.input ?? '{}',
        contextUri: data.contextUri,
        creatorId: data.creatorId,
        assigneeId: data.assigneeId,
        workspaceId: data.workspaceId,
        conversationId: data.conversationId,
        status: data.status ?? 'pending',
        scheduleType: data.scheduleType,
        scheduleAt: data.scheduleAt,
        scheduleCron: data.scheduleCron,
        intervalMs: data.intervalMs,
        nextRunAt: data.nextRunAt,
        maxRuns: data.maxRuns,
        timeoutMs: data.timeoutMs ?? 300000,
        deadline: data.deadline,
        maxRetries: data.maxRetries ?? TaskModel.DEFAULT_MAX_RETRIES,
        retryDelayMs: data.retryDelayMs ?? 60000,
        budget: data.budget,
        metadata: data.metadata ?? '{}',
        runtimeRoute: data.runtimeRoute ?? 'agent',
      },
    });
  }

  async findById(id: string) {
    return prisma.iMTask.findUnique({ where: { id } });
  }

  async list(filter: TaskListFilter) {
    const limit = Math.min(filter.limit ?? 20, 100);
    const where: Record<string, unknown> = {};

    if (filter.status) where.status = filter.status;
    if (filter.capability) where.capability = filter.capability;
    if (filter.assigneeId) where.assigneeId = filter.assigneeId;
    if (filter.creatorId) where.creatorId = filter.creatorId;
    if (filter.workspaceId) where.workspaceId = filter.workspaceId;
    if (filter.conversationId) where.conversationId = filter.conversationId;
    if (filter.scheduleType) where.scheduleType = filter.scheduleType;

    return prisma.iMTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: filter.cursor ? 1 : 0,
      cursor: filter.cursor ? { id: filter.cursor } : undefined,
    });
  }

  /**
   * Update task fields. Returns the updated task or null if not found.
   */
  async update(id: string, data: Record<string, unknown>) {
    try {
      return await prisma.iMTask.update({
        where: { id },
        data,
      });
    } catch {
      return null;
    }
  }

  /**
   * Atomically claim a task: set assigneeId + status='assigned' only if status='pending'.
   * Returns the updated task or null if already claimed / not found.
   */
  async claim(id: string, assigneeId: string) {
    try {
      return await prisma.iMTask.update({
        where: { id, status: 'pending' },
        data: { assigneeId, status: 'assigned' },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find due scheduled tasks (next_run_at <= now, appropriate status).
   * For dev (SQLite) — simple query. Prod MySQL should use FOR UPDATE SKIP LOCKED.
   */
  async findDueTasks(limit: number = 50) {
    return prisma.iMTask.findMany({
      where: {
        scheduleType: { not: null },
        nextRunAt: { lte: new Date() },
        status: { in: ['pending', 'assigned'] },
        OR: [{ maxRuns: null }, { runCount: { lt: (prisma.iMTask.fields?.maxRuns as unknown as number) ?? 999999 } }],
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Find due tasks — simpler query that works with both SQLite and MySQL.
   */
  async findDueTasksSimple(limit: number = 50) {
    const now = new Date();
    const tasks = await prisma.iMTask.findMany({
      where: {
        nextRunAt: { lte: now },
        status: { in: ['pending', 'assigned'] },
        OR: [
          { scheduleType: { not: null } },
          {
            assigneeId: { not: null },
            retryCount: { gt: 0 },
          },
          { runtimeRoute: 'shell' },
        ],
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    });

    // Filter maxRuns in application layer (avoids Prisma field-comparison limitation)
    return tasks.filter((t: any) => t.maxRuns === null || t.runCount < t.maxRuns);
  }

  /**
   * Mark a task as dispatching: update status + increment runCount + set lastRunAt.
   * Returns null if the task was already picked up (optimistic concurrency).
   */
  async markDispatching(id: string, nextRunAt: Date | null) {
    try {
      return await prisma.iMTask.update({
        where: { id, status: { in: ['pending', 'assigned'] } },
        data: {
          status: 'running',
          runCount: { increment: 1 },
          lastRunAt: new Date(),
          nextRunAt,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find tasks that have been running past their timeout.
   */
  async findTimedOutTasks(limit: number = 20) {
    const tasks = await prisma.iMTask.findMany({
      where: { status: 'running' },
      take: limit * 2, // Over-fetch to filter in app
    });

    const now = Date.now();
    return tasks.filter((t: any) => {
      if (!t.lastRunAt) return false;
      return now - t.lastRunAt.getTime() > t.timeoutMs;
    });
  }

  // ─── Marketplace ──────────────────────────────────────────

  /**
   * Browse marketplace: pending tasks with no assignee.
   */
  async browseMarketplace(opts: { capability?: string; minReward?: number; sort: 'reward' | 'newest'; limit: number }) {
    const where: Record<string, unknown> = {
      status: 'pending',
      assigneeId: null,
      scheduleType: null, // Exclude scheduled tasks from marketplace
    };
    if (opts.capability) where.capability = { contains: opts.capability };
    if (opts.minReward) where.budget = { gte: opts.minReward };

    return prisma.iMTask.findMany({
      where,
      orderBy: opts.sort === 'reward' ? { budget: 'desc' } : { createdAt: 'desc' },
      take: opts.limit,
    });
  }

  /**
   * Atomically mark a task as rewarded.
   * Uses a conditional update: only succeeds if metadata does NOT already contain "rewarded":true.
   * Returns the updated task, or null if already rewarded (concurrent call won).
   */
  async atomicReward(taskId: string, newMetadata: string) {
    try {
      return await prisma.iMTask.update({
        where: {
          id: taskId,
          NOT: { metadata: { contains: '"rewarded":true' } },
        },
        data: { metadata: newMetadata },
      });
    } catch {
      return null; // Already rewarded or not found
    }
  }

  /**
   * Atomically mark a task as refunded.
   * Uses a conditional update: only succeeds if metadata does NOT already contain "refunded":true.
   * Returns the updated task, or null if already refunded (concurrent call won).
   */
  async atomicRefund(taskId: string, newMetadata: string) {
    try {
      return await prisma.iMTask.update({
        where: {
          id: taskId,
          NOT: { metadata: { contains: '"refunded":true' } },
        },
        data: { metadata: newMetadata },
      });
    } catch {
      return null; // Already refunded or not found
    }
  }

  /**
   * Find subtasks by parentTaskId stored in metadata JSON.
   * Uses string contains as initial filter, then validates in application layer.
   */
  async findByParentTaskId(parentTaskId: string) {
    const candidates = await prisma.iMTask.findMany({
      where: {
        metadata: { contains: parentTaskId },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Filter in application layer to avoid false positives from string contains
    return candidates.filter((t: any) => {
      try {
        const meta = JSON.parse(t.metadata || '{}');
        return meta.parentTaskId === parentTaskId;
      } catch {
        return false;
      }
    });
  }

  /**
   * Count recent completed tasks by agent + capability.
   */
  async countRecentCompleted(agentId: string, capability: string, since: Date): Promise<number> {
    return prisma.iMTask.count({
      where: {
        assigneeId: agentId,
        capability,
        status: 'completed',
        updatedAt: { gte: since },
      },
    });
  }

  // ─── Task Logs ────────────────────────────────────────────

  async createLog(data: CreateTaskLogData) {
    return prisma.iMTaskLog.create({
      data: {
        taskId: data.taskId,
        actorId: data.actorId,
        action: data.action,
        message: data.message,
        metadata: data.metadata ?? '{}',
      },
    });
  }

  async getLogsByTaskId(taskId: string, limit: number = 50) {
    return prisma.iMTaskLog.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ─── Task Runs / Events ───────────────────────────────────

  async createRun(data: CreateTaskRunData) {
    return (prisma as any).iMTaskRun.create({
      data: {
        taskId: data.taskId ?? undefined,
        workspaceId: data.workspaceId ?? undefined,
        conversationId: data.conversationId ?? undefined,
        triggerMessageId: data.triggerMessageId ?? undefined,
        creatorId: data.creatorId,
        assigneeId: data.assigneeId ?? undefined,
        actorId: data.actorId,
        sourceKind: data.sourceKind ?? 'task',
        capability: data.capability,
        status: data.status ?? 'running',
        runtimeRoute: data.runtimeRoute ?? 'agent',
        input: data.input ?? '{}',
        output: data.output,
        outputUri: data.outputUri,
        error: data.error,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        metadata: data.metadata ?? '{}',
      },
    });
  }

  async findRunById(id: string) {
    return (prisma as any).iMTaskRun.findUnique({ where: { id } });
  }

  async listRuns(filter: TaskRunListFilter) {
    const limit = Math.min(filter.limit ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (filter.taskId) where.taskId = filter.taskId;
    if (filter.workspaceId) where.workspaceId = filter.workspaceId;
    if (filter.conversationId) where.conversationId = filter.conversationId;
    if (filter.creatorId) where.creatorId = filter.creatorId;
    if (filter.assigneeId) where.assigneeId = filter.assigneeId;
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.sourceKind) where.sourceKind = filter.sourceKind;
    if (filter.status) where.status = filter.status;

    return (prisma as any).iMTaskRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: filter.cursor ? 1 : 0,
      cursor: filter.cursor ? { id: filter.cursor } : undefined,
    });
  }

  async updateRun(id: string, data: UpdateTaskRunData) {
    try {
      return await (prisma as any).iMTaskRun.update({
        where: { id },
        data,
      });
    } catch {
      return null;
    }
  }

  async createRunEvent(data: CreateTaskEventData) {
    return (prisma as any).iMTaskEvent.create({
      data: {
        runId: data.runId,
        taskId: data.taskId ?? undefined,
        workspaceId: data.workspaceId ?? undefined,
        conversationId: data.conversationId ?? undefined,
        actorId: data.actorId,
        type: data.type,
        level: data.level ?? 'info',
        message: data.message,
        payload: data.payload ?? '{}',
      },
    });
  }

  async listRunEvents(runId: string, limit: number = 100) {
    return (prisma as any).iMTaskEvent.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit, 500),
    });
  }
}
