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
}

export interface TaskListFilter {
  status?: TaskStatus;
  capability?: string;
  assigneeId?: string;
  creatorId?: string;
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

export class TaskModel {
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
        scope: data.scope ?? 'global',
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
        maxRetries: data.maxRetries ?? 0,
        retryDelayMs: data.retryDelayMs ?? 60000,
        budget: data.budget,
        metadata: data.metadata ?? '{}',
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
    if (filter.scope) where.scope = filter.scope;
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
        NOT: { scheduleType: null },
        nextRunAt: { lte: now },
        status: { in: ['pending', 'assigned'] },
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
}
