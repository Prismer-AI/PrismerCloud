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
import type { CreditService } from './credit.service';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('TaskService');

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

export class InsufficientBudgetError extends Error {
  constructor(required: number, available: number) {
    super(`Insufficient credits for task budget: required ${required}, available ${available}`);
    this.name = 'InsufficientBudgetError';
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
  creditService?: CreditService;
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

    // P9: Block check — assignee may have blocked the creator
    if (assigneeId && assigneeId !== creatorId) {
      const { ContactService } = await import('./contact.service');
      const contactSvc = new ContactService();
      const blocked = await contactSvc.isBlocked(assigneeId, creatorId);
      if (blocked) {
        throw Object.assign(new Error('Assignee has blocked the task creator'), {
          status: 409,
          code: 'ASSIGNEE_BLOCKED',
        });
      }
    }

    // Escrow: pre-deduct budget from creator's credits before creating the task.
    // If deduction fails (insufficient balance), the task is NOT created.
    const escrowed = input.budget && input.budget > 0;
    if (escrowed) {
      const credit = this.deps.creditService;
      if (!credit) {
        throw new Error('Credit service unavailable — cannot escrow budget');
      }
      const deductResult = await credit.deduct(
        creatorId,
        input.budget!,
        `Escrow for task: ${input.title}`,
        'task.escrow',
      );
      if (!deductResult.success) {
        throw new InsufficientBudgetError(input.budget!, deductResult.balanceAfter);
      }
      log.info(`Escrowed ${input.budget} credits from ${creatorId} for task "${input.title}"`);
    }

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

    let task;
    try {
      task = await this.taskModel.create({
        title: input.title,
        description: input.description,
        capability: input.capability,
        input: input.input ? JSON.stringify(input.input) : '{}',
        contextUri: input.contextUri,
        creatorId,
        assigneeId,
        scope: input.scope,
        conversationId: input.conversationId,
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
    } catch (err) {
      // Refund escrowed credits if task creation fails — prevents credit loss
      if (escrowed) {
        await this.deps
          .creditService!.credit(
            creatorId,
            input.budget!,
            'refund',
            `Escrow refund: task creation failed for "${input.title}"`,
          )
          .catch((refundErr) => {
            log.error(
              `CRITICAL: Escrow refund failed after task creation error for "${input.title}": ${(refundErr as Error).message}`,
            );
          });
      }
      throw err;
    }

    // Log creation
    await this.taskModel.createLog({
      taskId: task.id,
      actorId: creatorId,
      action: 'created',
      message: `Task "${task.title}" created`,
    });

    log.info(`Created: ${task.id} "${task.title}" (${status}, schedule=${input.scheduleType ?? 'immediate'})`);

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
        log.warn(`Failed to notify assignee: ${err.message}`),
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
      scope: query.scope,
      conversationId: query.conversationId,
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
    updates: {
      title?: string;
      description?: string;
      assigneeId?: string;
      status?: TaskStatus;
      progress?: number;
      statusMessage?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<TaskInfo> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);

    const isCreator = task.creatorId === actorId;
    const isAssignee = task.assigneeId === actorId;

    if (!isCreator && !isAssignee) {
      throw new TaskAccessError(id, 'only the task creator or assignee can update this task');
    }

    const data: Record<string, unknown> = {};

    // Creator-only fields: title, description, assigneeId
    if (updates.title !== undefined || updates.description !== undefined || updates.assigneeId !== undefined) {
      if (!isCreator) {
        throw new TaskAccessError(id, 'only the task creator can update title, description, or assignee');
      }
      if (updates.title !== undefined) data.title = updates.title;
      if (updates.description !== undefined) data.description = updates.description;
      if (updates.assigneeId !== undefined) {
        data.assigneeId = updates.assigneeId;
        if (task.status === 'pending') {
          data.status = 'assigned';
        }
      }
    }

    // Creator-only: cancel
    if (updates.status === 'cancelled') {
      if (!isCreator) {
        throw new TaskAccessError(id, 'only the task creator can cancel a task');
      }
      data.status = 'cancelled';
    }

    // Assignee-only fields: progress, statusMessage
    if (updates.progress !== undefined || updates.statusMessage !== undefined) {
      if (!isAssignee) {
        throw new TaskAccessError(id, 'only the assigned agent can update progress or statusMessage');
      }
      if (updates.progress !== undefined) {
        if (typeof updates.progress !== 'number' || updates.progress < 0 || updates.progress > 1) {
          throw new TaskStateError(id, 'progress', 'a number between 0.0 and 1.0');
        }
        data.progress = updates.progress;
      }
      if (updates.statusMessage !== undefined) data.statusMessage = updates.statusMessage;
      // Auto-transition assigned → running on first progress update
      if (task.status === 'assigned') {
        data.status = 'running';
      }
    }

    // Assignee status transitions with state machine validation
    const ASSIGNEE_TRANSITIONS: Record<string, string[]> = {
      assigned: ['running'],
      running: ['review', 'completed', 'failed'],
      review: [], // only creator via approve/reject
    };
    if (
      updates.status &&
      ['running', 'review', 'completed', 'failed'].includes(updates.status) &&
      updates.status !== 'cancelled'
    ) {
      if (!isAssignee) {
        throw new TaskAccessError(id, 'only the assigned agent can change task execution status');
      }
      const currentStatus = (data.status as string) ?? task.status;
      const allowed = ASSIGNEE_TRANSITIONS[currentStatus];
      if (allowed && !allowed.includes(updates.status)) {
        throw new TaskStateError(id, currentStatus, allowed.join(' or ') || 'no assignee transitions allowed');
      }
      data.status = updates.status;
      if (updates.status === 'completed') {
        data.completedAt = new Date();
      }
    }

    if (updates.metadata) {
      const existing = this.parseJson(task.metadata);
      data.metadata = JSON.stringify({ ...existing, ...updates.metadata });
    }

    if (Object.keys(data).length === 0) {
      return this.toTaskInfo(task);
    }

    const updated = await this.taskModel.update(id, data);
    if (!updated) throw new TaskNotFoundError(id);

    // Log the update
    const logAction = data.status === 'cancelled' ? 'cancelled' : data.assigneeId ? 'assigned' : 'progress';
    const logMessage =
      data.status === 'cancelled'
        ? ((updates.metadata?.reason as string) ?? `Task cancelled by ${actorId}`)
        : data.assigneeId
          ? `Task assigned to ${updates.assigneeId}`
          : (updates.statusMessage ?? `Task updated by ${actorId}`);
    await this.taskModel.createLog({ taskId: id, actorId, action: logAction, message: logMessage });

    // Cancel: refund escrowed budget + publish event + notify assignee
    if (data.status === 'cancelled') {
      await this._refundEscrow(task, 'cancelled');
      this.deps.eventBusService
        ?.publish({
          type: 'task.cancelled',
          timestamp: Date.now(),
          data: {
            taskId: id,
            title: updated.title,
            creatorId: task.creatorId,
            assigneeId: task.assigneeId,
            reason: logMessage,
          },
        })
        .catch(() => {});
      if (task.assigneeId) {
        this.notifyAgent(task.assigneeId, updated, 'task.cancelled').catch(() => {});
      }
    }

    // Publish task.updated event for progress/status changes
    if (
      data.progress !== undefined ||
      data.statusMessage !== undefined ||
      (data.status && data.status !== 'cancelled')
    ) {
      this.deps.eventBusService
        ?.publish({
          type: 'task.updated',
          timestamp: Date.now(),
          data: {
            taskId: id,
            title: updated.title,
            status: updated.status,
            progress: (updated as any).progress,
            statusMessage: (updated as any).statusMessage,
          },
        })
        .catch((err: any) => log.warn(`EventBus publish failed for task.updated: ${err.message}`));
    }

    // Notify new assignee
    if (updates.assigneeId && data.status === 'assigned') {
      this.notifyAgent(updates.assigneeId, updated, 'task.assigned').catch((err: any) =>
        log.warn(`Failed to notify assignee: ${err.message}`),
      );
    }

    return this.toTaskInfo(updated);
  }

  /**
   * Creator approves a task in review status → completed.
   * Idempotent: re-approving a completed task returns 200.
   */
  async approveTask(taskId: string, actorId: string): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.creatorId !== actorId) {
      throw new TaskAccessError(taskId, 'only the task creator can approve');
    }
    // Idempotent: already completed
    if (task.status === 'completed') return this.toTaskInfo(task);
    if (task.status !== 'review') throw new TaskStateError(taskId, task.status, 'review');

    const updated = await this.taskModel.update(taskId, { status: 'completed', completedAt: new Date() });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({ taskId, actorId, action: 'completed', message: 'Task approved by creator' });
    this.deps.eventBusService
      ?.publish({
        type: 'task.completed',
        timestamp: Date.now(),
        data: { taskId, title: updated.title, creatorId: updated.creatorId, assigneeId: updated.assigneeId },
      })
      .catch((err: any) => log.warn(`EventBus publish failed for task.completed: ${err.message}`));
    if (task.assigneeId) {
      this.notifyAgent(task.assigneeId, updated, 'task.approved').catch((err: any) =>
        log.warn(`Failed to notify assignee of approval: ${err.message}`),
      );
      this.recordEvolutionOutcome(task.assigneeId, task, 'success', null).catch((err: any) =>
        log.error({ err }, `Evolution record FAILED for approved task ${taskId}`),
      );
    }
    // Auto-reward on approve
    const taskMeta = this.parseJson(task.metadata);
    if (task.budget && task.budget > 0 && taskMeta.autoReward && !taskMeta.rewarded) {
      this.rewardTask(task.id, task.creatorId).catch((err: any) =>
        log.warn(`Auto-reward failed for task ${taskId}: ${(err as Error).message}`),
      );
    }
    return this.toTaskInfo(updated);
  }

  /**
   * Creator rejects a task in review status → failed.
   * Idempotent: re-rejecting a failed task returns 200.
   */
  async rejectTask(taskId: string, actorId: string, reason: string): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.creatorId !== actorId) throw new TaskAccessError(taskId, 'only the task creator can reject');
    if (task.status === 'failed') return this.toTaskInfo(task);
    if (task.status !== 'review') throw new TaskStateError(taskId, task.status, 'review');

    const updated = await this.taskModel.update(taskId, { status: 'failed', error: reason });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({ taskId, actorId, action: 'failed', message: `Task rejected: ${reason}` });

    // Refund escrowed budget to creator (rejection = task not rewarded)
    await this._refundEscrow(task, 'rejected');

    this.deps.eventBusService
      ?.publish({
        type: 'task.failed',
        timestamp: Date.now(),
        data: { taskId, title: updated.title, creatorId: updated.creatorId, assigneeId: updated.assigneeId, reason },
      })
      .catch((err: any) => log.warn(`EventBus publish failed for task.failed: ${err.message}`));
    if (task.assigneeId) {
      this.notifyAgent(task.assigneeId, updated, 'task.rejected').catch((err: any) =>
        log.warn(`Failed to notify assignee of rejection: ${err.message}`),
      );
      this.recordEvolutionOutcome(task.assigneeId, task, 'failed', undefined, reason).catch((err: any) =>
        log.error(`Evolution record FAILED for rejected task ${taskId}: ${(err as Error).message}`),
      );
    }
    return this.toTaskInfo(updated);
  }

  /**
   * Cancel a task (soft delete). Creator only.
   * Idempotent: re-cancelling returns 200.
   * Cannot cancel completed or failed tasks.
   */
  async cancelTask(taskId: string, actorId: string): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.creatorId !== actorId) throw new TaskAccessError(taskId, 'only the task creator can cancel');
    if (task.status === 'cancelled') return this.toTaskInfo(task);
    if (['completed', 'failed'].includes(task.status)) {
      throw new TaskStateError(taskId, task.status, 'pending, assigned, running, or review');
    }
    return this.updateTask(taskId, actorId, { status: 'cancelled' as TaskStatus });
  }

  // ═══════════════════════════════════════════════════════════
  // Task Lifecycle
  // ═══════════════════════════════════════════════════════════

  /**
   * Agent claims a pending task.
   * Atomic: only succeeds if task is still pending.
   */
  async claimTask(taskId: string, agentId: string): Promise<TaskInfo> {
    // P9: Block check — task creator may have blocked this agent
    const taskForBlockCheck = await this.taskModel.findById(taskId);
    if (taskForBlockCheck) {
      const { ContactService } = await import('./contact.service');
      const contactSvc = new ContactService();
      const blocked = await contactSvc.isBlocked(taskForBlockCheck.creatorId, agentId);
      if (blocked) {
        throw Object.assign(new Error('Task creator has blocked this agent'), { status: 409, code: 'CLAIMER_BLOCKED' });
      }
    }

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

    log.info(`Claimed: ${taskId} by ${agentId}`);

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

    log.info(`Progress: ${taskId} — ${input.message ?? '(no message)'}`);
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
      completedAt: new Date(),
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

    log.info(`Completed: ${taskId}`);

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
      log.error(`Evolution record FAILED for completed task ${taskId}: ${(err as Error).message}`),
    );

    // AIP: Auto-issue TaskCompletionCredential (fire-and-forget)
    this.issueTaskCompletionVC(agentId, task).catch((err) =>
      log.warn(`TaskCompletion VC issuance skipped: ${(err as Error).message}`),
    );

    // Auto-reward: if task has budget and metadata.autoReward is set
    const taskMeta = this.parseJson(task.metadata);
    if (task.budget && task.budget > 0 && taskMeta.autoReward && !taskMeta.rewarded) {
      this.rewardTask(task.id, task.creatorId).catch((err) =>
        log.warn(`Auto-reward failed for task ${taskId}: ${(err as Error).message}`),
      );
    }

    // Team task: check if this is a subtask and all siblings are done
    if (taskMeta.parentTaskId) {
      this.checkTeamTaskCompletion(taskMeta.parentTaskId as string).catch((err) =>
        log.warn(`Team task check failed: ${(err as Error).message}`),
      );
    }

    // Verification trigger: after N consecutive completions of same capability
    if (task.capability) {
      this.maybeCreateVerificationTask(agentId, task.capability).catch((err) =>
        log.warn(`Verification trigger failed: ${(err as Error).message}`),
      );
    }

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

      log.info(`Retrying: ${taskId} (${task.retryCount + 1}/${task.maxRetries}, next at ${nextRetryAt.toISOString()})`);

      if (!updated) throw new TaskNotFoundError(taskId);
      return this.toTaskInfo(updated);
    }

    // No more retries — mark as failed
    const updated = await this.taskModel.update(taskId, {
      status: 'failed',
      error: input.error,
    });
    if (!updated) throw new TaskNotFoundError(taskId);

    // Refund escrowed budget to creator on final failure
    await this._refundEscrow(task, 'failed (retries exhausted)');

    await this.taskModel.createLog({
      taskId,
      actorId: agentId,
      action: 'failed',
      message: input.error,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });

    log.info(`Failed: ${taskId} — ${input.error}`);

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
      log.error(`Evolution record FAILED for failed task ${taskId}: ${(err as Error).message}`),
    );

    return this.toTaskInfo(updated);
  }

  // ═══════════════════════════════════════════════════════════
  // Marketplace & Reward
  // ═══════════════════════════════════════════════════════════

  /**
   * Browse available tasks in the marketplace.
   * Returns pending tasks with no assignee (open for claiming).
   */
  async browseMarketplace(opts: {
    capability?: string;
    minReward?: number;
    sort?: 'reward' | 'newest';
    limit?: number;
  }): Promise<TaskInfo[]> {
    const tasks = await this.taskModel.browseMarketplace({
      capability: opts.capability,
      minReward: opts.minReward,
      sort: opts.sort ?? 'newest',
      limit: Math.min(opts.limit ?? 20, 50),
    });
    return tasks.map((t: any) => this.toTaskInfo(t));
  }

  /**
   * Issue reward credits from task creator to assignee.
   * Can be called manually by creator, or auto-triggered on completion.
   */
  async rewardTask(taskId: string, actorId: string): Promise<{ rewarded: number }> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.status !== 'completed') {
      throw new TaskStateError(taskId, task.status, 'completed');
    }
    if (task.creatorId !== actorId) {
      throw new TaskAccessError(taskId, 'only the task creator can issue reward');
    }
    if (!task.budget || task.budget <= 0) {
      return { rewarded: 0 };
    }
    if (!task.assigneeId) {
      throw new TaskStateError(taskId, 'no assignee', 'assigned');
    }

    // Atomic check-and-set: mark as rewarded ONLY if not already rewarded.
    // This prevents double-payout from concurrent calls.
    const metadata = this.parseJson(task.metadata);
    if (metadata.rewarded) {
      return { rewarded: 0 };
    }

    const updatedMeta = JSON.stringify({ ...metadata, rewarded: true, rewardedAt: new Date().toISOString() });
    const atomicResult = await this.taskModel.atomicReward(taskId, updatedMeta);
    if (!atomicResult) {
      // Another concurrent call already rewarded — no-op
      log.info(`Reward skipped (already rewarded): ${taskId}`);
      return { rewarded: 0 };
    }

    // Release escrowed credits to assignee.
    // Budget was already deducted from creator at task creation time (escrow),
    // so we credit the assignee directly instead of transferring from creator.
    const credit = this.deps.creditService;
    if (!credit) {
      log.warn(`creditService not available — reward recorded but no credits released for task ${taskId}`);
      return { rewarded: 0 };
    }

    try {
      await credit.credit(
        task.assigneeId,
        task.budget,
        'task_reward',
        `Task reward: ${task.title} (from ${task.creatorId})`,
      );
    } catch (err) {
      // Rollback the rewarded flag on credit failure
      await this.taskModel.update(taskId, { metadata: JSON.stringify(metadata) });
      throw err;
    }

    await this.taskModel.createLog({
      taskId,
      actorId,
      action: 'rewarded',
      message: `Rewarded ${task.budget} credits to ${task.assigneeId}`,
    });

    log.info(`Rewarded: ${taskId} — ${task.budget} credits to ${task.assigneeId}`);
    return { rewarded: task.budget };
  }

  // ═══════════════════════════════════════════════════════════
  // Subtask / Team Task
  // ═══════════════════════════════════════════════════════════

  /**
   * List subtasks of a parent task.
   */
  async listSubtasks(parentTaskId: string, requesterId?: string): Promise<TaskInfo[]> {
    // Verify parent exists and requester has access
    if (requesterId) {
      await this.getTask(parentTaskId, requesterId);
    }
    const tasks = await this.taskModel.findByParentTaskId(parentTaskId);
    return tasks.map((t: any) => this.toTaskInfo(t));
  }

  /**
   * Get summary of a parent task's subtask progress.
   */
  async getSubtaskSummary(
    parentTaskId: string,
    requesterId?: string,
  ): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    running: number;
    allDone: boolean;
  }> {
    if (requesterId) {
      await this.getTask(parentTaskId, requesterId);
    }
    const subtasks = await this.taskModel.findByParentTaskId(parentTaskId);
    const total = subtasks.length;
    const completed = subtasks.filter((t: any) => t.status === 'completed').length;
    const failed = subtasks.filter((t: any) => t.status === 'failed').length;
    const pending = subtasks.filter((t: any) => t.status === 'pending').length;
    const running = subtasks.filter((t: any) => ['assigned', 'running'].includes(t.status)).length;
    return { total, completed, failed, pending, running, allDone: total > 0 && completed + failed === total };
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
        log.info(`Dispatched: ${task.id} "${task.title}" (run #${updated.runCount})`);
      } catch (err) {
        log.error({ err }, `Dispatch error for task ${task.id}`);
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

        // Refund escrowed budget to creator on timeout failure
        await this._refundEscrow(task, 'timed out');

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

    log.info(`Evolution recorded: ${outcome} for gene ${geneId} (agent ${agentId})`);
  }

  /**
   * AIP: Issue a TaskCompletionCredential for a completed task.
   * Only issues if the agent has a registered DID identity.
   */
  private async issueTaskCompletionVC(
    agentId: string,
    task: { capability?: string | null; status: string },
  ): Promise<void> {
    const { IdentityService } = await import('./identity.service');
    const { CredentialService } = await import('./credential.service');

    const identityService = new IdentityService();
    const credentialService = new CredentialService();

    // Check if agent has a DID identity
    const agentKey = await identityService.lookupKey(agentId);
    if (!agentKey?.didKey) return;

    await credentialService.issueTaskCompletion({
      agentDid: agentKey.didKey,
      issuerDid: identityService.getServerDID(),
      issuerPrivateKey: identityService.getServerPrivateKey(),
      taskType: task.capability ?? 'unknown',
      outcome: 'success',
      score: 0.7,
    });

    log.info(`TaskCompletion VC issued for agent ${agentId} (did: ${agentKey.didKey})`);
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
      log.warn(`WS/SSE push failed for ${targetId}: ${(err as Error).message}`);
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
      ]).catch((err) => log.warn(`Sync event write failed: ${(err as Error).message}`));
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
  // Team Task + Verification Helpers
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if all subtasks of a parent task are done.
   * If so, publish team_task.all_subtasks_completed event.
   */
  private async checkTeamTaskCompletion(parentTaskId: string): Promise<void> {
    const summary = await this.getSubtaskSummary(parentTaskId);
    if (!summary.allDone) return;

    const parent = await this.taskModel.findById(parentTaskId);
    if (!parent) return;

    this.deps.eventBusService
      ?.publish({
        type: 'team_task.all_subtasks_completed',
        timestamp: Date.now(),
        data: {
          parentTaskId,
          title: parent.title,
          creatorId: parent.creatorId,
          total: summary.total,
          completed: summary.completed,
          failed: summary.failed,
        },
      })
      .catch(() => {});

    // Notify parent task creator
    this.notifyUser(parent.creatorId, parent, 'team_task.all_subtasks_completed').catch(() => {});
    log.info(`Team task completed: ${parentTaskId} (${summary.completed}/${summary.total} subtasks)`);
  }

  /**
   * After an agent completes N tasks of the same capability in 24h,
   * auto-create a verification task + evolution signal.
   */
  private async maybeCreateVerificationTask(agentId: string, capability: string): Promise<void> {
    const THRESHOLD = 3;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentCompleted = await this.taskModel.countRecentCompleted(agentId, capability, since);
    if (recentCompleted < THRESHOLD || recentCompleted % THRESHOLD !== 0) return;

    // Dedup: check if a verification task for this agent+capability already exists today
    const existing = await this.taskModel.list({
      creatorId: 'system',
      capability: 'verification',
      status: 'pending',
      limit: 1,
    });
    const alreadyExists = existing.some((t: any) => {
      try {
        const meta = JSON.parse(t.metadata || '{}');
        return meta.targetAgentId === agentId && meta.targetCapability === capability;
      } catch {
        return false;
      }
    });
    if (alreadyExists) return;

    // Create verification task
    await this.createTask('system', {
      title: `Verify recent ${capability} outputs`,
      description: `Agent ${agentId} completed ${recentCompleted} ${capability} tasks in 24h. Verify output quality.`,
      capability: 'verification',
      metadata: {
        verificationType: 'batch_quality_check',
        targetAgentId: agentId,
        targetCapability: capability,
        sampleSize: Math.min(recentCompleted, 5),
      },
    });

    // Evolution signal
    const evo = this.deps.evolutionService;
    if (evo) {
      const signals = evo.extractSignals({ taskCapability: capability, taskStatus: 'verification_triggered' });
      if (signals.length > 0) {
        await evo
          .recordOutcome(agentId, {
            gene_id: '',
            signals,
            outcome: 'success',
            score: 0.5,
            summary: `Verification triggered: ${recentCompleted} ${capability} tasks in 24h`,
            metadata: { verificationAutoTrigger: true },
          })
          .catch(() => {});
      }
    }

    log.info(`Verification triggered: ${agentId} completed ${recentCompleted} ${capability} tasks`);
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
      log.warn(`Invalid cron values: min=${minStr}, hour=${hourStr}, falling back to +1h`);
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

  /**
   * Refund escrowed budget to the task creator.
   * Shared by cancel, fail, and timeout paths. Only refunds if
   * the task has a positive budget and has not already been rewarded.
   */
  private async _refundEscrow(
    task: { id: string; creatorId: string; budget: number; title: string; metadata?: string | null },
    reason: string,
  ): Promise<void> {
    if (!task.budget || task.budget <= 0) return;
    const taskMeta = this.parseJson(task.metadata);
    if (taskMeta.rewarded || taskMeta.refunded) return;

    const credit = this.deps.creditService;
    if (!credit) return;

    try {
      // CAS: atomically mark refunded before issuing credit to prevent double-refund
      const updatedMeta = JSON.stringify({
        ...taskMeta,
        refunded: true,
        refundedAt: new Date().toISOString(),
      });
      const casResult = await this.taskModel.atomicRefund(task.id, updatedMeta);
      if (!casResult) {
        log.info(`Skipping refund for task ${task.id}: already refunded (concurrent call won)`);
        return;
      }

      await credit.credit(task.creatorId, task.budget, 'refund', `Escrow refund: task "${task.title}" ${reason}`);
      log.info(`Refunded ${task.budget} escrowed credits to ${task.creatorId} for task ${task.id} (${reason})`);
    } catch (err) {
      log.error(`Escrow refund failed for task ${task.id} (${reason}): ${(err as Error).message}`);
    }
  }

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
    scope: string;
    conversationId?: string | null;
    status: string;
    progress?: number | null;
    statusMessage?: string | null;
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
    completedAt?: Date | null;
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
      scope: record.scope,
      conversationId: record.conversationId ?? null,
      status: record.status as TaskStatus,
      progress: record.progress ?? null,
      statusMessage: record.statusMessage ?? null,
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
      completedAt: record.completedAt ?? null,
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
