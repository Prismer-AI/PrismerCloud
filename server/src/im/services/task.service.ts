/**
 * Prismer IM — Task Service
 *
 * Cloud Task Store: persistent task management with lifecycle.
 * Provides the foundation for agent orchestration — agents can create,
 * claim, progress, complete, and fail tasks. Cloud drives agents by
 * dispatching task notifications via IM messages, webhooks, or sync events.
 *
 * Design reference: docs/AGENT-ORCHESTRATION.md (Layer 2: Cloud Task Store)
 */

import type Redis from 'ioredis';
import { TaskModel } from '../models/task';
import type { MessageService } from './message.service';
import type { ConversationService } from './conversation.service';
import type { SyncService } from './sync.service';
import type { RoomManager } from '../ws/rooms';
import type {
  TaskStatus,
  ScheduleType,
  CreateTaskInput,
  TaskInfo,
  TaskLogEntry,
  TaskProgressInput,
  TaskCompleteInput,
  TaskFailInput,
  TaskListQuery,
  TaskMetadata,
} from '../types';
import type { EvolutionService } from './evolution.service';
import type { EventBusService } from './event-bus.service';

const LOG = '[TaskService]';

// ─── Error Types ────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskStateError extends Error {
  constructor(id: string, currentStatus: string, expectedStatus: string) {
    super(`Task ${id} is ${currentStatus}, expected ${expectedStatus}`);
    this.name = 'TaskStateError';
  }
}

export class TaskClaimError extends Error {
  constructor(id: string) {
    super(`Task ${id} is no longer available for claiming`);
    this.name = 'TaskClaimError';
  }
}

export class TaskAccessError extends Error {
  constructor(id: string, reason: string) {
    super(`Access denied for task ${id}: ${reason}`);
    this.name = 'TaskAccessError';
  }
}

// ─── Service ────────────────────────────────────────────────

export interface TaskServiceDeps {
  redis: Redis;
  rooms: RoomManager;
  messageService: MessageService;
  conversationService: ConversationService;
  syncService?: SyncService;
  evolutionService?: EvolutionService;
  eventBusService?: EventBusService;
}

export class TaskService {
  private taskModel = new TaskModel();
  private deps: TaskServiceDeps;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  // ═══════════════════════════════════════════════════════════
  // Task CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a new task.
   * If assigneeId is provided, status starts as 'assigned' and the agent is notified.
   * If scheduleType is set, nextRunAt is computed.
   */
  async createTask(creatorId: string, input: CreateTaskInput): Promise<TaskInfo> {
    // Resolve "self" assignee
    const assigneeId = input.assigneeId === 'self' ? creatorId : input.assigneeId;

    // Compute initial status
    let status: TaskStatus = 'pending';
    if (assigneeId && !input.scheduleType) {
      status = 'assigned';
    }

    // Compute nextRunAt for scheduled tasks
    let nextRunAt: Date | undefined;
    if (input.scheduleType) {
      nextRunAt = this.computeNextRunAt(input);
      // Scheduled tasks start as pending regardless of assignee
      status = 'pending';
    }

    const task = await this.taskModel.create({
      title: input.title,
      description: input.description,
      capability: input.capability,
      input: input.input ? JSON.stringify(input.input) : '{}',
      contextUri: input.contextUri,
      creatorId,
      assigneeId,
      status,
      scheduleType: input.scheduleType,
      scheduleAt: this.parseISODate(input.scheduleAt, 'scheduleAt'),
      scheduleCron: input.scheduleCron,
      intervalMs: input.intervalMs,
      nextRunAt,
      maxRuns: input.maxRuns,
      timeoutMs: input.timeoutMs,
      deadline: this.parseISODate(input.deadline, 'deadline'),
      maxRetries: input.maxRetries,
      retryDelayMs: input.retryDelayMs,
      budget: input.budget,
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
    });

    // Log creation
    await this.taskModel.createLog({
      taskId: task.id,
      actorId: creatorId,
      action: 'created',
      message: `Task "${task.title}" created`,
    });

    console.log(
      `${LOG} Created: ${task.id} "${task.title}" (${status}, schedule=${input.scheduleType ?? 'immediate'})`,
    );

    // Publish event
    this.deps.eventBusService
      ?.publish({
        type: 'task.created',
        timestamp: Date.now(),
        data: { taskId: task.id, title: task.title, capability: task.capability, creatorId, assigneeId },
      })
      .catch(() => {});

    // Notify assigned agent (if not scheduled — scheduled tasks dispatch on schedule)
    if (assigneeId && !input.scheduleType) {
      this.notifyAgent(assigneeId, task, 'task.assigned').catch((err) =>
        console.warn(`${LOG} Failed to notify assignee:`, err.message),
      );

      // Publish assigned event
      this.deps.eventBusService
        ?.publish({
          type: 'task.assigned',
          timestamp: Date.now(),
          data: { taskId: task.id, title: task.title, capability: task.capability, creatorId, assigneeId },
        })
        .catch(() => {});
    }

    return this.toTaskInfo(task);
  }

  /**
   * Get task by ID with access control.
   * Visible to: creator, assignee, or anyone if task is pending (marketplace).
   */
  async getTask(id: string, requesterId?: string): Promise<TaskInfo> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);
    if (requesterId) {
      this.checkReadAccess(task, requesterId);
    }
    return this.toTaskInfo(task);
  }

  /**
   * Get task with logs, with access control.
   */
  async getTaskWithLogs(id: string, requesterId?: string): Promise<{ task: TaskInfo; logs: TaskLogEntry[] }> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);
    if (requesterId) {
      this.checkReadAccess(task, requesterId);
    }

    const logs = await this.taskModel.getLogsByTaskId(id);

    return {
      task: this.toTaskInfo(task),
      logs: logs.map((l: any) => this.toLogEntry(l)),
    };
  }

  /**
   * Check if a user can read a task.
   * Allowed: creator, assignee, or pending unassigned tasks (marketplace).
   */
  private checkReadAccess(
    task: { creatorId: string; assigneeId: string | null; status: string },
    requesterId: string,
  ): void {
    if (task.creatorId === requesterId) return;
    if (task.assigneeId === requesterId) return;
    if (task.status === 'pending' && !task.assigneeId) return; // marketplace visibility
    throw new TaskAccessError(task.creatorId, 'you do not have access to this task');
  }

  /**
   * List tasks with filters.
   */
  async listTasks(query: TaskListQuery): Promise<TaskInfo[]> {
    const tasks = await this.taskModel.list({
      status: query.status,
      capability: query.capability,
      assigneeId: query.assigneeId,
      creatorId: query.creatorId,
      scheduleType: query.scheduleType,
      limit: query.limit,
      cursor: query.cursor,
    });
    return tasks.map((t: any) => this.toTaskInfo(t));
  }

  /**
   * Update task fields (assign, cancel, update metadata).
   */
  async updateTask(
    id: string,
    actorId: string,
    updates: { assigneeId?: string; status?: TaskStatus; metadata?: Record<string, unknown> },
  ): Promise<TaskInfo> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);

    // Only the creator can update/cancel/assign a task
    if (task.creatorId !== actorId) {
      throw new TaskAccessError(id, 'only the task creator can update this task');
    }

    const data: Record<string, unknown> = {};

    if (updates.assigneeId !== undefined) {
      data.assigneeId = updates.assigneeId;
      if (task.status === 'pending') {
        data.status = 'assigned';
      }
    }
    if (updates.status === 'cancelled') {
      data.status = 'cancelled';
    }
    if (updates.metadata) {
      const existing = this.parseJson(task.metadata);
      data.metadata = JSON.stringify({ ...existing, ...updates.metadata });
    }

    const updated = await this.taskModel.update(id, data);
    if (!updated) throw new TaskNotFoundError(id);

    // Log the update
    const action = updates.status === 'cancelled' ? 'cancelled' : 'assigned';
    await this.taskModel.createLog({
      taskId: id,
      actorId,
      action,
      message:
        updates.status === 'cancelled' ? `Task cancelled by ${actorId}` : `Task assigned to ${updates.assigneeId}`,
    });

    // Notify new assignee
    if (updates.assigneeId && data.status === 'assigned') {
      this.notifyAgent(updates.assigneeId, updated, 'task.assigned').catch((err) =>
        console.warn(`${LOG} Failed to notify assignee:`, err.message),
      );
    }

    return this.toTaskInfo(updated);
  }

  // ═══════════════════════════════════════════════════════════
  // Task Lifecycle
  // ═══════════════════════════════════════════════════════════

  /**
   * Agent claims a pending task.
   * Atomic: only succeeds if task is still pending.
   */
  async claimTask(taskId: string, agentId: string): Promise<TaskInfo> {
    const claimed = await this.taskModel.claim(taskId, agentId);
    if (!claimed) {
      const existing = await this.taskModel.findById(taskId);
      if (!existing) throw new TaskNotFoundError(taskId);
      throw new TaskClaimError(taskId);
    }

    await this.taskModel.createLog({
      taskId,
      actorId: agentId,
      action: 'claimed',
      message: `Task claimed by agent ${agentId}`,
    });

    console.log(`${LOG} Claimed: ${taskId} by ${agentId}`);

    // Publish event
    this.deps.eventBusService
      ?.publish({
        type: 'task.assigned',
        timestamp: Date.now(),
        data: {
          taskId,
          title: claimed.title,
          capability: claimed.capability,
          creatorId: claimed.creatorId,
          assigneeId: agentId,
        },
      })
      .catch(() => {});

    // Notify creator
    this.notifyUser(claimed.creatorId, claimed, 'task.claimed').catch(() => {});

    return this.toTaskInfo(claimed);
  }

  /**
   * Agent reports progress on a running task.
   */
  async reportProgress(taskId: string, agentId: string, input: TaskProgressInput): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Only the assignee can report progress
    if (task.assigneeId !== agentId) {
      throw new TaskAccessError(taskId, 'only the assigned agent can report progress');
    }

    if (task.status !== 'running' && task.status !== 'assigned') {
      throw new TaskStateError(taskId, task.status, 'running or assigned');
    }

    // If task is 'assigned', transition to 'running' on first progress
    if (task.status === 'assigned') {
      await this.taskModel.update(taskId, { status: 'running' });
    }

    await this.taskModel.createLog({
      taskId,
      actorId: agentId,
      action: 'progress',
      message: input.message,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });

    console.log(`${LOG} Progress: ${taskId} — ${input.message ?? '(no message)'}`);
  }

  /**
   * Agent marks task as completed.
   */
  async completeTask(taskId: string, agentId: string, input: TaskCompleteInput): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Only the assignee can complete the task
    if (task.assigneeId !== agentId) {
      throw new TaskAccessError(taskId, 'only the assigned agent can complete this task');
    }

    if (!['assigned', 'running'].includes(task.status)) {
      throw new TaskStateError(taskId, task.status, 'assigned or running');
    }

    const updated = await this.taskModel.update(taskId, {
      status: 'completed',
      result: input.result !== undefined ? JSON.stringify(input.result) : null,
      resultUri: input.resultUri,
      cost: input.cost ?? task.cost,
    });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({
      taskId,
      actorId: agentId,
      action: 'completed',
      message: 'Task completed',
      metadata: input.result ? JSON.stringify({ resultPreview: String(input.result).slice(0, 200) }) : undefined,
    });

    console.log(`${LOG} Completed: ${taskId}`);

    // Publish event
    this.deps.eventBusService
      ?.publish({
        type: 'task.completed',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          capability: updated.capability,
          creatorId: updated.creatorId,
          assigneeId: agentId,
        },
      })
      .catch(() => {});

    // Notify creator
    this.notifyUser(updated.creatorId, updated, 'task.completed').catch(() => {});

    // Evolution hook: auto-record successful outcome
    this.recordEvolutionOutcome(agentId, task, 'success', input.result).catch((err) =>
      console.error(`${LOG} ⚠️ Evolution record FAILED for completed task ${taskId}:`, (err as Error).message),
    );

    return this.toTaskInfo(updated);
  }

  /**
   * Agent marks task as failed. May trigger retry if max_retries not exhausted.
   */
  async failTask(taskId: string, agentId: string, input: TaskFailInput): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Only the assignee can mark the task as failed
    if (task.assigneeId !== agentId) {
      throw new TaskAccessError(taskId, 'only the assigned agent can fail this task');
    }

    if (!['assigned', 'running'].includes(task.status)) {
      throw new TaskStateError(taskId, task.status, 'assigned or running');
    }

    // Check if we can retry
    if (task.retryCount < task.maxRetries) {
      // Exponential backoff: retryDelayMs * 2^retryCount
      const delay = task.retryDelayMs * Math.pow(2, task.retryCount);
      const nextRetryAt = new Date(Date.now() + delay);

      const updated = await this.taskModel.update(taskId, {
        status: 'pending',
        retryCount: { increment: 1 },
        nextRunAt: nextRetryAt,
        error: input.error,
      });

      await this.taskModel.createLog({
        taskId,
        actorId: agentId,
        action: 'retried',
        message: `Failed: ${input.error}. Retry ${task.retryCount + 1}/${task.maxRetries} in ${delay}ms`,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      });

      console.log(
        `${LOG} Retrying: ${taskId} (${task.retryCount + 1}/${task.maxRetries}, next at ${nextRetryAt.toISOString()})`,
      );

      if (!updated) throw new TaskNotFoundError(taskId);
      return this.toTaskInfo(updated);
    }

    // No more retries — mark as failed
    const updated = await this.taskModel.update(taskId, {
      status: 'failed',
      error: input.error,
    });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({
      taskId,
      actorId: agentId,
      action: 'failed',
      message: input.error,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });

    console.log(`${LOG} Failed: ${taskId} — ${input.error}`);

    // Publish event (only on true failure, not retry)
    this.deps.eventBusService
      ?.publish({
        type: 'task.failed',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          capability: updated.capability,
          creatorId: updated.creatorId,
          assigneeId: agentId,
          error: input.error,
        },
      })
      .catch(() => {});

    // Notify creator
    this.notifyUser(updated.creatorId, updated, 'task.failed').catch(() => {});

    // Evolution hook: auto-record failed outcome
    this.recordEvolutionOutcome(agentId, task, 'failed', undefined, input.error).catch((err) =>
      console.error(`${LOG} ⚠️ Evolution record FAILED for failed task ${taskId}:`, (err as Error).message),
    );

    return this.toTaskInfo(updated);
  }

  // ═══════════════════════════════════════════════════════════
  // Scheduler Support
  // ═══════════════════════════════════════════════════════════

  /**
   * Find due scheduled tasks and dispatch them.
   * Called by SchedulerService on each tick.
   */
  async dispatchDueTasks(): Promise<number> {
    const dueTasks = await this.taskModel.findDueTasksSimple(50);
    let dispatched = 0;

    for (const task of dueTasks) {
      try {
        // Compute next run time for recurring tasks
        let nextRunAt: Date | null = null;
        if (task.scheduleType === 'cron' && task.scheduleCron) {
          nextRunAt = this.computeNextCronRun(task.scheduleCron);
        } else if (task.scheduleType === 'interval' && task.intervalMs) {
          nextRunAt = new Date(Date.now() + task.intervalMs);
        }
        // 'once' → nextRunAt = null (no more runs)

        // Atomically mark as dispatching
        const updated = await this.taskModel.markDispatching(task.id, nextRunAt);
        if (!updated) continue; // Another pod/tick got it

        await this.taskModel.createLog({
          taskId: task.id,
          action: 'dispatched',
          message: `Scheduled dispatch (run #${updated.runCount})`,
        });

        // Dispatch: notify the assignee or find a suitable agent
        const targetId = task.assigneeId ?? task.creatorId;
        await this.notifyAgent(targetId, updated, 'task.dispatched');

        dispatched++;
        console.log(`${LOG} Dispatched: ${task.id} "${task.title}" (run #${updated.runCount})`);
      } catch (err) {
        console.error(`${LOG} Dispatch error for task ${task.id}:`, err);
      }
    }

    return dispatched;
  }

  /**
   * Handle timed-out tasks: reset to pending for retry or mark as failed.
   */
  async handleTimeouts(): Promise<number> {
    const timedOut = await this.taskModel.findTimedOutTasks(20);
    let handled = 0;

    for (const task of timedOut) {
      if (task.retryCount < task.maxRetries) {
        // Retry
        const delay = task.retryDelayMs * Math.pow(2, task.retryCount);
        await this.taskModel.update(task.id, {
          status: 'pending',
          retryCount: { increment: 1 },
          nextRunAt: new Date(Date.now() + delay),
          error: `Timed out after ${task.timeoutMs}ms`,
        });

        await this.taskModel.createLog({
          taskId: task.id,
          action: 'retried',
          message: `Timed out. Retry ${task.retryCount + 1}/${task.maxRetries}`,
        });
      } else {
        // Final failure
        await this.taskModel.update(task.id, {
          status: 'failed',
          error: `Timed out after ${task.timeoutMs}ms (max retries exhausted)`,
        });

        await this.taskModel.createLog({
          taskId: task.id,
          action: 'failed',
          message: `Timed out — max retries (${task.maxRetries}) exhausted`,
        });

        // Notify creator
        this.notifyUser(task.creatorId, task, 'task.failed').catch(() => {});
      }
      handled++;
    }

    return handled;
  }

  // ═══════════════════════════════════════════════════════════
  // Notification (Agent Driving)
  // ═══════════════════════════════════════════════════════════

  /**
   * Auto-record task outcome into the evolution engine.
   * Extracts signals from task capability/status/error and finds the gene
   * (if any) from task metadata to record against.
   */
  private async recordEvolutionOutcome(
    agentId: string,
    task: { capability?: string | null; status: string; error?: string | null; metadata?: string },
    outcome: 'success' | 'failed',
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const evo = this.deps.evolutionService;
    if (!evo) return;

    // Extract signals from task context
    const signals = evo.extractSignals({
      taskStatus: outcome === 'success' ? 'completed' : 'failed',
      taskCapability: task.capability ?? undefined,
      error: error ?? task.error ?? undefined,
    });

    if (signals.length === 0) return;

    // Check if task metadata contains a gene_id (set by agents using evolution)
    const metadata = this.parseJson(task.metadata);
    const geneId = metadata.gene_id as string | undefined;

    if (!geneId) {
      // No gene was used for this task — nothing to record
      return;
    }

    await evo.recordOutcome(agentId, {
      gene_id: geneId,
      signals,
      outcome,
      score: outcome === 'success' ? 0.7 : 0.2,
      summary:
        outcome === 'success'
          ? `Task completed: ${task.capability ?? 'unknown'}`
          : `Task failed: ${error ?? task.error ?? 'unknown error'}`,
      metadata: { taskAutoRecord: true },
    });

    console.log(`${LOG} Evolution recorded: ${outcome} for gene ${geneId} (agent ${agentId})`);
  }

  /**
   * Notify an agent about a task event via WS/SSE push + sync event.
   * This is the core "reverse drive" mechanism — Cloud pushes to Agent.
   *
   * Uses direct WS/SSE push (lightweight, no message creation).
   * Offline agents pick up tasks via GET /tasks on reconnect.
   */
  private async notifyAgent(
    targetId: string,
    task: { id: string; title: string; status: string; capability?: string | null; input?: string; metadata?: string },
    event: string,
  ): Promise<void> {
    const metadata = this.parseJson(task.metadata);
    const delivery: string = (metadata.delivery as string) ?? 'message';

    if (delivery === 'none') return;

    const taskPayload = {
      event,
      taskId: task.id,
      title: task.title,
      status: task.status,
      capability: task.capability,
      input: this.parseJson(task.input),
    };

    // Push to online clients via WS/SSE
    try {
      this.deps.rooms.sendToUser(targetId, {
        type: 'task.notification',
        payload: taskPayload,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`${LOG} WS/SSE push failed for ${targetId}:`, (err as Error).message);
    }

    // Write sync event for offline-first SDK pickup (with 5s timeout to prevent scheduler stall)
    if (this.deps.syncService) {
      Promise.race([
        this.deps.syncService.writeEvent(
          'task.notification',
          taskPayload,
          null, // no conversationId
          targetId,
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 5000)),
      ]).catch((err) => console.warn(`${LOG} Sync event write failed:`, (err as Error).message));
    }
  }

  /**
   * Notify a user (creator) about task status changes.
   */
  private async notifyUser(
    userId: string,
    task: { id: string; title: string; status: string },
    event: string,
  ): Promise<void> {
    try {
      this.deps.rooms.sendToUser(userId, {
        type: 'task.notification',
        payload: { event, taskId: task.id, title: task.title, status: task.status },
        timestamp: Date.now(),
      });
    } catch {
      // Non-critical
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Schedule Computation
  // ═══════════════════════════════════════════════════════════

  private computeNextRunAt(input: CreateTaskInput): Date | undefined {
    switch (input.scheduleType) {
      case 'once':
        return input.scheduleAt ? new Date(input.scheduleAt) : new Date();

      case 'interval':
        return new Date(Date.now() + (input.intervalMs ?? 60000));

      case 'cron':
        if (!input.scheduleCron) return undefined;
        return this.computeNextCronRun(input.scheduleCron);

      default:
        return undefined;
    }
  }

  /**
   * Compute next cron run time.
   * Simple implementation: parses "min hour dom month dow" format.
   * For production, consider using 'cron-parser' npm package.
   */
  private computeNextCronRun(cronExpr: string): Date {
    // Lightweight cron parsing: handle common patterns
    // Full cron parser can be added as dependency later
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) {
      // Fallback: 1 hour from now
      return new Date(Date.now() + 3600_000);
    }

    const now = new Date();
    const [minStr, hourStr, , ,] = parts;

    // Handle simple cases: "0 9 * * *" (daily at 9:00)
    const min = minStr === '*' ? now.getMinutes() : parseInt(minStr, 10);
    const hour = hourStr === '*' ? now.getHours() : parseInt(hourStr, 10);

    // Validate parsed values
    if (isNaN(min) || min < 0 || min > 59 || isNaN(hour) || hour < 0 || hour > 23) {
      console.warn(`${LOG} Invalid cron values: min=${minStr}, hour=${hourStr}, falling back to +1h`);
      return new Date(Date.now() + 3600_000);
    }

    const next = new Date(now);
    next.setHours(hour, min, 0, 0);

    // If the computed time is in the past, move to next day
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private parseISODate(value: string | undefined, field: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid date for ${field}: ${value}`);
    }
    return d;
  }

  private parseJson(str?: string | null): Record<string, unknown> {
    if (!str) return {};
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  private toTaskInfo(record: {
    id: string;
    title: string;
    description: string | null;
    capability: string | null;
    input: string;
    contextUri: string | null;
    creatorId: string;
    assigneeId: string | null;
    status: string;
    scheduleType: string | null;
    scheduleCron: string | null;
    intervalMs: number | null;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    runCount: number;
    maxRuns: number | null;
    result: string | null;
    resultUri: string | null;
    error: string | null;
    budget: number | null;
    cost: number;
    timeoutMs: number;
    deadline: Date | null;
    maxRetries: number;
    retryDelayMs: number;
    retryCount: number;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
  }): TaskInfo {
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      capability: record.capability,
      input: this.parseJson(record.input),
      contextUri: record.contextUri,
      creatorId: record.creatorId,
      assigneeId: record.assigneeId,
      status: record.status as TaskStatus,
      scheduleType: record.scheduleType as ScheduleType | null,
      scheduleCron: record.scheduleCron,
      intervalMs: record.intervalMs,
      nextRunAt: record.nextRunAt,
      lastRunAt: record.lastRunAt,
      runCount: record.runCount,
      maxRuns: record.maxRuns,
      result: record.result ? this.parseJson(record.result) : null,
      resultUri: record.resultUri,
      error: record.error,
      budget: record.budget,
      cost: record.cost,
      timeoutMs: record.timeoutMs,
      deadline: record.deadline,
      maxRetries: record.maxRetries,
      retryDelayMs: record.retryDelayMs,
      retryCount: record.retryCount,
      metadata: this.parseJson(record.metadata) as TaskMetadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toLogEntry(record: {
    id: string;
    taskId: string;
    actorId: string | null;
    action: string;
    message: string | null;
    metadata: string;
    createdAt: Date;
  }): TaskLogEntry {
    return {
      id: record.id,
      taskId: record.taskId,
      actorId: record.actorId,
      action: record.action,
      message: record.message,
      metadata: this.parseJson(record.metadata),
      createdAt: record.createdAt,
    };
  }
}
