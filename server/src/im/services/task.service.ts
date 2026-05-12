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

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { TaskModel } from '../models/task';
import type { MessageService } from './message.service';
import type { ConversationService } from './conversation.service';
import type { SyncService } from './sync.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import { buildTaskDispatchRequest } from '../ws/v19x-helpers';
import type { AssetRef } from '../types/im-events';
import prisma from '../db';
import { K8sSandboxError, k8sSandbox } from '../../lib/k8s-sandbox';
import { getK8sNamespace } from '../../lib/k8s-client';
import {
  emitTaskAssignedNotification,
  emitTaskApprovalRequestedNotification,
  emitTaskStatusNotification,
} from '../../lib/notification-emitter';
import { isDaemonForgotten } from './runtime-binding.service';
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
const DAEMON_ROUTE_PREFIX = 'daemon:';
const TASK_RETRYABLE_ERROR_CODES = new Set(['daemon_task_timeout', 'adapter_timeout', 'shell_timeout']);

type DaemonRouteResolution =
  | { kind: 'none' }
  | { kind: 'active'; daemonId: string; workspaceId: string | null }
  | { kind: 'forgotten'; daemonId: string; workspaceId: string };

function daemonRouteKey(daemonId: string): string {
  return `${DAEMON_ROUTE_PREFIX}${daemonId}`;
}

function daemonActorId(daemonId: string): string {
  return daemonRouteKey(daemonId).slice(0, 36);
}

function parseRetryableErrorCode(metadata: unknown): string | null {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try {
      return parseRetryableErrorCode(JSON.parse(metadata) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const code = (metadata as Record<string, unknown>).errorCode;
  return typeof code === 'string' && TASK_RETRYABLE_ERROR_CODES.has(code) ? code : null;
}

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

export interface TaskRunInfo {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  conversationId: string | null;
  triggerMessageId: string | null;
  creatorId: string;
  assigneeId: string | null;
  actorId: string | null;
  sourceKind: string;
  capability: string | null;
  status: string;
  runtimeRoute: string | null;
  input: Record<string, unknown>;
  output: unknown | null;
  outputUri: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  legacyTaskId?: string;
  source?: 'task_run' | 'legacy_task';
}

export interface TaskEventInfo {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceId: string | null;
  conversationId: string | null;
  actorId: string | null;
  type: string;
  level: string;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
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
    } else if (input.runtimeRoute === 'shell' && !input.scheduleType) {
      status = 'assigned';
    }

    // Compute nextRunAt for scheduled tasks
    let nextRunAt: Date | undefined;
    if (input.scheduleType) {
      nextRunAt = this.computeNextRunAt(input);
      // Scheduled tasks start as pending regardless of assignee
      status = 'pending';
    }

    const metadata = this.normalizeCreatedTaskMetadata(input.metadata);
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
        workspaceId: input.workspaceId,
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
        metadata: JSON.stringify(metadata),
        runtimeRoute: input.runtimeRoute ?? 'agent',
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
        data: {
          taskId: task.id,
          title: task.title,
          capability: task.capability,
          creatorId,
          assigneeId,
          conversationId: task.conversationId ?? null,
        },
      })
      .catch(() => {});

    const taskMeta = this.parseJson(task.metadata);
    const taskKind = this.taskKind(taskMeta);
    // Notify assigned agent (if not scheduled — scheduled tasks dispatch on schedule)
    if (assigneeId && !input.scheduleType) {
      if (this.isProjectionTaskKind(taskKind)) {
        // Assigning a board/goal projection should not execute it immediately.
        // Execution is an explicit status transition (for example dragging a
        // card into Running), which forks a single agent_run via
        // forceExecutionStatus. This keeps Kanban cards stable and prevents
        // Goal projections from becoming one-off execution tasks.
        this.notifyAgent(assigneeId, task, 'task.assigned').catch((err) =>
          log.warn(`Failed to notify projection assignee: ${err.message}`),
        );
      } else {
        this.notifyAgent(assigneeId, task, 'task.assigned').catch((err) =>
          log.warn(`Failed to notify assignee: ${err.message}`),
        );

        // v1.9.x: also fire `task.dispatch.request` for daemon listeners.
        this.emitDaemonDispatchRequest(assigneeId, task).catch((err) =>
          log.warn(`Daemon dispatch failed: ${(err as Error).message}`),
        );
      }

      // Publish assigned event
      this.deps.eventBusService
        ?.publish({
          type: 'task.assigned',
          timestamp: Date.now(),
          data: {
            taskId: task.id,
            title: task.title,
            capability: task.capability,
            creatorId,
            assigneeId,
            conversationId: task.conversationId ?? null,
          },
        })
        .catch(() => {});

      // Wave-8 W9: surface the assignment in the recipient's Bell drawer.
      // Skipped silently for agent-only assignees (no cloud account).
      void emitTaskAssignedNotification({
        taskId: task.id,
        title: task.title,
        assigneeImUserId: assigneeId,
        creatorImUserId: creatorId,
        conversationId: task.conversationId ?? null,
        workspaceId: task.workspaceId ?? null,
      });
      void this.fanOutBellSync(assigneeId, 'task.assigned', {
        taskId: task.id,
        title: task.title,
        creatorId,
      });
    }

    // S3: fan out by runtimeRoute. The agent path above remains unchanged.
    // Sandbox dispatch is fire-and-forget — caller gets the task back
    // immediately; status transitions to in_progress / done / failed are
    // driven by dispatchToSandbox.
    if (input.runtimeRoute === 'sandbox' && !input.scheduleType) {
      void this.dispatchToSandbox(task.id).catch((err) => {
        log.error(`dispatchToSandbox failed for task ${task.id}: ${(err as Error).message}`);
        void prisma.iMTask
          .update({
            where: { id: task.id },
            data: {
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
              completedAt: new Date(),
            },
          })
          .catch(() => {
            /* secondary failure — no recovery path, swallow */
          });
      });
    }

    if (input.runtimeRoute === 'shell' && !input.scheduleType) {
      await this.taskModel.createLog({
        taskId: task.id,
        actorId: creatorId,
        action: 'dispatched',
        message: `Shell dispatch requested for ${this.readTargetDaemonId(task.metadata) ?? 'unknown daemon'}`,
      });
      void this.emitShellDispatchRequest(task).catch((err) => {
        log.warn(`Shell dispatch failed: ${(err as Error).message}`);
      });
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
   * Wave-9 (Phase 1) — canonical task result reader.
   *
   * Replaces the legacy IMAsset(kind=task-result) mirror. Shape locked by
   * the design review:
   *   { taskId, status, output, metrics?, assetIds: string[],
   *     resultUri?: string|null, completedAt: string }
   *
   * Notes:
   *   - `output` is the agent's primary text reply (string), normalised
   *     from `task.result.output` when present, else falling back to a
   *     stringified result for legacy tasks that stored raw JSON.
   *   - `assetIds` holds the daemon-collected outbox attachments
   *     (Wave-9). Always an array (possibly empty), never undefined,
   *     so SDK callers can iterate without null-check noise.
   *   - `metrics` is the adapter's TaskResult.metrics blob (cost /
   *     duration / tokensUsed). Optional — older tasks may lack it.
   *   - `completedAt` ISO string. For pending/running tasks that have
   *     no completion timestamp yet we fall back to updatedAt so the
   *     field is always populated.
   */
  async getTaskResult(
    id: string,
    requesterId: string,
  ): Promise<{
    taskId: string;
    status: string;
    output: string | null;
    metrics?: Record<string, unknown> | null;
    assetIds: string[];
    resultUri?: string | null;
    completedAt: string;
  }> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);
    this.checkReadAccess(task, requesterId);
    return this.shapeTaskResult({
      id: task.id,
      status: task.status,
      result: task.result,
      resultUri: task.resultUri ?? null,
      completedAt: task.completedAt ?? task.updatedAt ?? new Date(),
    });
  }

  async getRunResult(
    runId: string,
    requesterId: string,
  ): Promise<{
    taskId: string;
    status: string;
    output: string | null;
    metrics?: Record<string, unknown> | null;
    assetIds: string[];
    resultUri?: string | null;
    completedAt: string;
  }> {
    const run = await this.taskModel.findRunById(runId);
    if (!run) throw new TaskNotFoundError(runId);
    await this.checkRunReadAccess(run, requesterId);
    return this.shapeTaskResult({
      id: run.id,
      status: run.status,
      result: run.output,
      resultUri: run.outputUri ?? null,
      completedAt: run.completedAt ?? run.updatedAt ?? new Date(),
    });
  }

  /**
   * Internal: project a task or run row into the locked result shape.
   * `result` is the JSON string column; we parse leniently so a legacy
   * row whose `output` is a bare string instead of `{ output, ... }`
   * still surfaces `output` and an empty assetIds array.
   */
  private shapeTaskResult(input: {
    id: string;
    status: string;
    result: string | null;
    resultUri: string | null;
    completedAt: Date;
  }): {
    taskId: string;
    status: string;
    output: string | null;
    metrics?: Record<string, unknown> | null;
    assetIds: string[];
    resultUri?: string | null;
    completedAt: string;
  } {
    let parsed: unknown = null;
    if (input.result) {
      try {
        parsed = JSON.parse(input.result);
      } catch {
        // Non-JSON legacy rows — treat the string as the output.
        parsed = { output: input.result };
      }
    }
    const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<
      string,
      unknown
    >;
    const rawOutput = obj.output;
    const output =
      typeof rawOutput === 'string'
        ? rawOutput
        : rawOutput == null
          ? typeof parsed === 'string'
            ? parsed
            : null
          : JSON.stringify(rawOutput);
    const assetIds = Array.isArray(obj.assetIds)
      ? (obj.assetIds.filter((v): v is string => typeof v === 'string' && v.length > 0) as string[])
      : [];
    const metrics =
      obj.metrics && typeof obj.metrics === 'object' && !Array.isArray(obj.metrics)
        ? (obj.metrics as Record<string, unknown>)
        : null;
    return {
      taskId: input.id,
      status: input.status,
      output,
      metrics,
      assetIds,
      resultUri: input.resultUri ?? null,
      completedAt: input.completedAt.toISOString(),
    };
  }

  /**
   * Get task with logs, with access control.
   */
  async getTaskWithLogs(
    id: string,
    requesterId?: string,
  ): Promise<{
    task: TaskInfo;
    logs: TaskLogEntry[];
    subtasks: TaskInfo[];
    summary: {
      total: number;
      completed: number;
      failed: number;
      pending: number;
      running: number;
      allDone: boolean;
    };
  }> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);
    if (requesterId) {
      this.checkReadAccess(task, requesterId);
    }

    const [logs, subtasks] = await Promise.all([
      this.taskModel.getLogsByTaskId(id),
      this.taskModel.findByParentTaskId(id),
    ]);
    const completed = subtasks.filter((t: any) => t.status === 'completed').length;
    const failed = subtasks.filter((t: any) => t.status === 'failed').length;
    const pending = subtasks.filter((t: any) => t.status === 'pending').length;
    const running = subtasks.filter((t: any) => ['assigned', 'running', 'in_progress'].includes(t.status)).length;

    return {
      task: this.toTaskInfo(task),
      logs: logs.map((l: any) => this.toLogEntry(l)),
      subtasks: subtasks.map((t: any) => this.toTaskInfo(t)),
      summary: {
        total: subtasks.length,
        completed,
        failed,
        pending,
        running,
        allDone: subtasks.length > 0 && completed + failed === subtasks.length,
      },
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
    if (query.view === 'runs') {
      return [];
    }
    const kinds = this.normalizeKindFilter(query.kind, query.view);
    const requestedLimit = query.limit;
    const tasks = await this.taskModel.list({
      status: query.status,
      capability: query.capability,
      assigneeId: query.assigneeId,
      creatorId: query.creatorId,
      workspaceId: query.workspaceId,
      conversationId: query.conversationId,
      scheduleType: query.scheduleType,
      limit: kinds ? 100 : query.limit,
      cursor: query.cursor,
    });
    return tasks
      .filter((task: any) => this.matchesTaskKindFilter(task, kinds, query.view))
      .slice(0, Math.min(requestedLimit ?? 20, 100))
      .map((t: any) => this.toTaskInfo(t));
  }

  // ═══════════════════════════════════════════════════════════
  // Task Runs / Events
  // ═══════════════════════════════════════════════════════════

  async createTaskRun(
    taskId: string | null,
    actorId: string,
    input: {
      workspaceId?: string | null;
      conversationId?: string | null;
      triggerMessageId?: string | null;
      creatorId?: string;
      assigneeId?: string | null;
      sourceKind?: string;
      capability?: string | null;
      status?: string;
      runtimeRoute?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      outputUri?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<TaskRunInfo> {
    const task = taskId ? await this.taskModel.findById(taskId) : null;
    if (taskId && !task) throw new TaskNotFoundError(taskId);
    if (task) this.checkReadAccess(task, actorId);

    const now = new Date();
    const status = input.status ?? 'running';
    const run = await this.taskModel.createRun({
      taskId,
      workspaceId: input.workspaceId ?? task?.workspaceId ?? null,
      conversationId: input.conversationId ?? task?.conversationId ?? null,
      triggerMessageId: input.triggerMessageId ?? null,
      creatorId: input.creatorId ?? task?.creatorId ?? actorId,
      assigneeId: input.assigneeId ?? task?.assigneeId ?? null,
      actorId,
      sourceKind: input.sourceKind ?? 'task',
      capability: input.capability ?? task?.capability ?? undefined,
      status,
      runtimeRoute: input.runtimeRoute ?? task?.runtimeRoute ?? 'agent',
      input: JSON.stringify(input.input ?? (task ? this.parseJson(task.input) : {})),
      output: input.output === undefined ? undefined : JSON.stringify(input.output),
      outputUri: input.outputUri,
      error: input.error,
      startedAt: status === 'pending' ? undefined : now,
      completedAt: ['completed', 'failed', 'cancelled'].includes(status) ? now : undefined,
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    await this.taskModel.createRunEvent({
      runId: run.id,
      taskId,
      workspaceId: run.workspaceId ?? null,
      conversationId: run.conversationId ?? null,
      actorId,
      type: 'run.created',
      message: `Task run ${run.id} created`,
      payload: JSON.stringify({ status, runtimeRoute: run.runtimeRoute }),
    });

    // Publish task.assigned for run-style dispatches (chat @-mentions land
    // here via MessageService.dispatchToAgent → createTaskRun). The SSE
    // relay in src/im/api/tasks.ts /events filters task.* events by
    // creator/assignee and projects them through buildTaskSSEPayload, so
    // the chat surface's typing-dot row in im-channel.tsx fires off the
    // run.id like it would off a task.id. Without this, run-style runs
    // are silent end-to-end and the user sees no thinking animation.
    if (run.assigneeId && (status === 'assigned' || status === 'running')) {
      const meta = this.parseJson(run.metadata);
      const titleFromMeta = typeof meta.title === 'string' ? meta.title : null;
      this.deps.eventBusService
        ?.publish({
          type: 'task.assigned',
          timestamp: Date.now(),
          data: {
            taskId: run.id,
            title: titleFromMeta,
            capability: run.capability ?? null,
            creatorId: run.creatorId,
            assigneeId: run.assigneeId,
            conversationId: run.conversationId ?? null,
          },
        })
        .catch((err) => log.warn(`EventBus publish failed for run task.assigned: ${(err as Error).message}`));
    }

    return this.toTaskRunInfo(run);
  }

  async listTaskRuns(
    query: {
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
    },
    requesterId: string,
  ): Promise<TaskRunInfo[]> {
    const runs = await this.taskModel.listRuns(query);
    const visibleRuns: TaskRunInfo[] = [];
    const taskAccess = new Map<string, boolean>();

    for (const run of runs as any[]) {
      let visible = run.creatorId === requesterId || run.assigneeId === requesterId || run.actorId === requesterId;
      if (!visible && run.taskId) {
        visible = taskAccess.get(run.taskId) ?? false;
      }
      if (!visible && run.taskId && !taskAccess.has(run.taskId)) {
        const task = await this.taskModel.findById(run.taskId);
        visible = Boolean(task);
        if (task) {
          try {
            this.checkReadAccess(task, requesterId);
          } catch {
            visible = false;
          }
        }
        taskAccess.set(run.taskId, visible);
      }
      if (visible) visibleRuns.push(this.toTaskRunInfo(run));
    }

    const includeLegacy =
      !query.cursor && (!query.status || ['assigned', 'running', 'completed', 'failed'].includes(query.status));
    if (includeLegacy) {
      const legacy = await this.listLegacyAgentRuns(
        query,
        requesterId,
        Math.max(0, (query.limit ?? 20) - visibleRuns.length),
      );
      visibleRuns.push(...legacy);
    }

    const seen = new Set<string>();
    const deduped = visibleRuns.filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    });
    return deduped.slice(0, Math.min(query.limit ?? 20, 100));
  }

  async getTaskRunWithEvents(
    runId: string,
    requesterId: string,
  ): Promise<{ run: TaskRunInfo; events: TaskEventInfo[] }> {
    const run = await this.taskModel.findRunById(runId);
    if (run) {
      await this.checkRunReadAccess(run, requesterId);
      const events = await this.taskModel.listRunEvents(runId);
      return {
        run: this.toTaskRunInfo(run),
        events: events.map((event: any) => this.toTaskEventInfo(event)),
      };
    }

    const legacy = await this.getLegacyAgentRun(runId, requesterId);
    if (legacy) return legacy;
    throw new TaskNotFoundError(runId);
  }

  async updateTaskRun(
    runId: string,
    actorId: string,
    updates: {
      status?: string;
      output?: unknown;
      outputUri?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<TaskRunInfo> {
    const run = await this.taskModel.findRunById(runId);
    if (!run) throw new TaskNotFoundError(runId);
    await this.checkRunReadAccess(run, actorId);

    const completedAt =
      updates.status && ['completed', 'failed', 'cancelled'].includes(updates.status) ? new Date() : undefined;
    const updated = await this.taskModel.updateRun(runId, {
      status: updates.status,
      output: updates.output === undefined ? undefined : JSON.stringify(updates.output),
      outputUri: updates.outputUri,
      error: updates.error,
      completedAt,
      metadata: updates.metadata === undefined ? undefined : JSON.stringify(updates.metadata),
    });
    if (!updated) throw new TaskNotFoundError(runId);

    await this.taskModel.createRunEvent({
      runId,
      taskId: run.taskId,
      workspaceId: run.workspaceId ?? null,
      conversationId: run.conversationId ?? null,
      actorId,
      type: 'run.updated',
      message: updates.status ? `Task run ${runId} marked ${updates.status}` : `Task run ${runId} updated`,
      payload: JSON.stringify({ status: updates.status, outputUri: updates.outputUri, error: updates.error }),
    });

    // Wave-9 (Phase 1): task result is canonical in IMTaskRun.output (JSON
    // column above). Clients fetch via GET /api/im/runs/:id/result. We no
    // longer mirror the output text into an IMAsset (kind=task-result) —
    // that wrote a duplicate of im_messages.content with no read path,
    // polluting the workspace asset library.

    if (run.taskId && updates.status && ['completed', 'failed'].includes(updates.status)) {
      const updatedMeta = this.parseJson(updated.metadata);
      await this.reconcileProjectionFromAgentRun(
        run.taskId,
        {
          id: updated.id,
          title:
            typeof updatedMeta.title === 'string'
              ? updatedMeta.title
              : typeof updatedMeta.parentTitle === 'string'
                ? updatedMeta.parentTitle
                : `[run] ${updated.id}`,
          metadata: updated.metadata,
        },
        updates.status === 'completed' ? 'completed' : 'failed',
        {
          actorId,
          result: updates.output,
          resultUri: updates.outputUri ?? null,
          error: updates.error,
        },
      );
    }

    // Publish terminal task.* SSE for run-style dispatches. Mirrors the
    // task.* publishes that completeTask/failTask/cancelTask do for board
    // tasks, so the chat surface drops its typing-dot row when the daemon
    // closes the run. Output is projected to a string for the SSE wire
    // (cookbook §events `task.completed.output`).
    if (updates.status && ['completed', 'failed', 'cancelled'].includes(updates.status)) {
      const eventType =
        updates.status === 'completed'
          ? 'task.completed'
          : updates.status === 'failed'
            ? 'task.failed'
            : 'task.cancelled';
      let outputText: string | null = null;
      if (eventType === 'task.completed' && updates.output !== undefined) {
        const recordOutput = this.readObject(updates.output);
        if (typeof recordOutput.output === 'string') {
          outputText = recordOutput.output;
        } else if (typeof updates.output === 'string') {
          outputText = updates.output;
        } else if (updates.output != null) {
          outputText = JSON.stringify(updates.output);
        }
      }
      const data: Record<string, unknown> = {
        taskId: updated.id,
        creatorId: updated.creatorId,
        assigneeId: updated.assigneeId,
        conversationId: updated.conversationId ?? null,
      };
      if (eventType === 'task.completed') {
        data.output = outputText;
        data.metrics = null;
      } else if (eventType === 'task.failed') {
        data.error = updated.error ?? updates.error ?? null;
      } else {
        data.by = actorId;
      }
      this.deps.eventBusService
        ?.publish({ type: eventType, timestamp: Date.now(), data })
        .catch((err) => log.warn(`EventBus publish failed for run ${eventType}: ${(err as Error).message}`));
    }

    return this.toTaskRunInfo(updated);
  }

  async appendTaskRunEvent(
    runId: string,
    actorId: string,
    input: { type: string; level?: string; message?: string; payload?: Record<string, unknown> },
  ): Promise<TaskEventInfo> {
    const run = await this.taskModel.findRunById(runId);
    if (!run) throw new TaskNotFoundError(runId);
    await this.checkRunReadAccess(run, actorId);

    const event = await this.taskModel.createRunEvent({
      runId,
      taskId: run.taskId,
      workspaceId: run.workspaceId ?? null,
      conversationId: run.conversationId ?? null,
      actorId,
      type: input.type,
      level: input.level,
      message: input.message,
      payload: JSON.stringify(input.payload ?? {}),
    });
    return this.toTaskEventInfo(event);
  }

  /**
   * Daemon-reported progress for a run-style dispatch. Counterpart to
   * reportProgress (board task) and reportRuntimeProgress (shell): writes
   * a run.progress event and publishes task.progress to EventBus so the
   * SSE relay drives the chat surface's typing-dot updates with the
   * run.id as taskId.
   */
  async reportRunProgress(
    runId: string,
    agentImUserId: string,
    input: { message?: string; progress?: number | null; detail?: Record<string, unknown> },
  ): Promise<void> {
    const run = await this.taskModel.findRunById(runId);
    if (!run) throw new TaskNotFoundError(runId);
    if (run.assigneeId !== agentImUserId) {
      throw new TaskAccessError(runId, 'run is not assigned to this agent');
    }
    await this.taskModel.createRunEvent({
      runId,
      taskId: run.taskId,
      workspaceId: run.workspaceId ?? null,
      conversationId: run.conversationId ?? null,
      actorId: agentImUserId,
      type: 'run.progress',
      message: input.message,
      payload: JSON.stringify({
        progress: input.progress ?? null,
        ...(input.detail ?? {}),
      }),
    });
    this.deps.eventBusService
      ?.publish({
        type: 'task.progress',
        timestamp: Date.now(),
        data: {
          taskId: runId,
          progress: typeof input.progress === 'number' ? input.progress : null,
          statusMessage: input.message ?? null,
          creatorId: run.creatorId,
          assigneeId: run.assigneeId,
          conversationId: run.conversationId ?? null,
        },
      })
      .catch((err) => log.warn(`EventBus publish failed for run task.progress: ${(err as Error).message}`));
  }

  async dispatchTaskRun(runId: string, agentImUserId: string, event: string = 'task.dispatched'): Promise<void> {
    const run = await this.taskModel.findRunById(runId);
    if (!run) throw new TaskNotFoundError(runId);
    if (!run.assigneeId || run.assigneeId !== agentImUserId) {
      throw new TaskAccessError(runId, 'run is not assigned to this agent');
    }
    await this.emitDaemonDispatchRequest(agentImUserId, this.runAsDispatchTask(run), event);
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
      assigneeId?: string | null;
      status?: TaskStatus;
      forceExecutionStatus?: boolean;
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

    if (updates.forceExecutionStatus && updates.status) {
      const nextAssigneeId = updates.assigneeId === undefined ? task.assigneeId : (updates.assigneeId ?? null);
      if (updates.status === 'running' && !nextAssigneeId) {
        throw new TaskStateError(id, 'unassigned', 'an assigned agent before starting execution');
      }
      return this.forceExecutionStatus(id, actorId, updates.status, {
        reason:
          typeof updates.metadata?.reason === 'string'
            ? updates.metadata.reason
            : typeof updates.statusMessage === 'string'
              ? updates.statusMessage
              : undefined,
        metadata: updates.metadata,
        assigneeId: updates.assigneeId,
      });
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
        if (task.status === 'pending' && updates.assigneeId) {
          data.status = 'assigned';
        } else if (task.status === 'assigned' && updates.assigneeId === null) {
          data.status = 'pending';
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
      if (!isCreator) {
        throw new TaskAccessError(id, 'only the task creator can update task metadata');
      }
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
            conversationId: task.conversationId ?? null,
            reason: logMessage,
            // `by` is the actor that triggered cancellation — passed
            // through to SSE per cookbook §events. May be a creator's
            // imUserId, or a system actor (reaper / admin).
            by: actorId ?? null,
          },
        })
        .catch(() => {});
      if (task.assigneeId) {
        this.notifyAgent(task.assigneeId, updated, 'task.cancelled').catch(() => {});
        // v1.9.x: also fire `task.cancel` for the daemon to SIGTERM the adapter.
        this.emitDaemonCancel(task.assigneeId, id, logMessage);
      }
      if (task.runtimeRoute === 'shell') {
        const targetDaemonId = this.readTargetDaemonId(task.metadata);
        if (targetDaemonId) this.emitRuntimeCancel(targetDaemonId, id, logMessage);
      }
      // Wave-8 W7: surface cancellation in chat (same Q-B = C path as
      // completion / failure). `by` carries the actor id so the system
      // message represents whoever pressed cancel.
      void this.emitTaskStatusChat(updated, 'cancelled', { by: actorId });
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
            creatorId: task.creatorId,
            assigneeId: task.assigneeId,
            conversationId: task.conversationId ?? null,
          },
        })
        .catch((err: any) => log.warn(`EventBus publish failed for task.updated: ${err.message}`));
    }

    // Notify new assignee
    if (updates.assigneeId && data.status === 'assigned') {
      this.notifyAgent(updates.assigneeId, updated, 'task.assigned').catch((err: any) =>
        log.warn(`Failed to notify assignee: ${err.message}`),
      );
      // Wave-8 W9: Bell row for the new assignee + sync ping.
      void emitTaskAssignedNotification({
        taskId: updated.id,
        title: updated.title,
        assigneeImUserId: updates.assigneeId,
        creatorImUserId: updated.creatorId,
        conversationId: updated.conversationId ?? null,
        workspaceId: updated.workspaceId ?? null,
      });
      void this.fanOutBellSync(updates.assigneeId, 'task.assigned', {
        taskId: updated.id,
        title: updated.title,
      });
    }

    // Wave-8 W9: assignee submits work for creator review → notify creator's
    // Bell. Skipped when the actor IS the creator (force-status path) since
    // there's no one new to inform.
    if (data.status === 'review' && task.creatorId !== actorId) {
      void emitTaskApprovalRequestedNotification({
        taskId: updated.id,
        title: updated.title,
        creatorImUserId: updated.creatorId,
        assigneeImUserId: updated.assigneeId,
        conversationId: updated.conversationId ?? null,
        workspaceId: updated.workspaceId ?? null,
      });
      void this.fanOutBellSync(updated.creatorId, 'task.approval_requested', {
        taskId: updated.id,
        title: updated.title,
      });
    }

    return this.toTaskInfo(updated);
  }

  /**
   * Creator-initiated execution-state override.
   *
   * This is intentionally separate from the assignee status machine above:
   * a kanban drag by a human is an explicit operational command, not an
   * agent progress report. Moving to running re-dispatches the task to the
   * assigned daemon; moving a running task to review/completed sends a
   * task.cancel so the daemon can interrupt the in-flight adapter.
   */
  async forceExecutionStatus(
    id: string,
    actorId: string,
    status: TaskStatus,
    opts: { reason?: string; metadata?: Record<string, unknown>; assigneeId?: string | null } = {},
  ): Promise<TaskInfo> {
    const task = await this.taskModel.findById(id);
    if (!task) throw new TaskNotFoundError(id);
    if (task.creatorId !== actorId) {
      throw new TaskAccessError(id, 'only the task creator can force task execution status');
    }

    if (!['pending', 'running', 'review', 'completed'].includes(status)) {
      throw new TaskStateError(id, status, 'pending, running, review, or completed');
    }
    if (task.status === 'cancelled' && status !== 'pending') {
      throw new TaskStateError(id, task.status, 'a non-cancelled task');
    }

    const previousStatus = task.status as TaskStatus;
    const effectiveAssigneeId = opts.assigneeId === undefined ? task.assigneeId : opts.assigneeId;
    const assigneeChanged = opts.assigneeId !== undefined && opts.assigneeId !== task.assigneeId;
    const metadataChanged = opts.metadata !== undefined && Object.keys(opts.metadata).length > 0;
    if (previousStatus === status && !assigneeChanged && !metadataChanged) return this.toTaskInfo(task);

    if (status === 'running' && task.runtimeRoute !== 'shell' && !effectiveAssigneeId) {
      throw new TaskStateError(id, 'unassigned', 'an assigned agent before starting execution');
    }

    const reason = opts.reason ?? `Execution status forced to ${status} by creator`;
    const forcedMeta = {
      status,
      previousStatus,
      by: actorId,
      at: new Date().toISOString(),
      reason,
    };
    const existingMeta = this.parseJson(task.metadata);
    const existingExecution = this.readObject(existingMeta.execution);
    const activeRunTaskId =
      typeof existingExecution.activeRunTaskId === 'string' && existingExecution.activeRunTaskId.trim()
        ? existingExecution.activeRunTaskId.trim()
        : null;
    const nextExecution =
      status === 'pending' || status === 'review' || status === 'completed'
        ? {
            ...existingExecution,
            activeRunTaskId: null,
            ...(activeRunTaskId
              ? {
                  lastInterruptedRunTaskId: activeRunTaskId,
                  lastInterruptedAt: forcedMeta.at,
                  lastInterruptReason: reason,
                }
              : {}),
          }
        : existingExecution;
    const data: Record<string, unknown> = {
      status,
      metadata: JSON.stringify({
        ...existingMeta,
        ...(opts.metadata ?? {}),
        execution: nextExecution,
        humanForcedExecutionStatus: forcedMeta,
      }),
    };
    if (opts.assigneeId !== undefined) {
      data.assigneeId = opts.assigneeId;
    }

    if (status === 'running') {
      data.completedAt = null;
      data.result = null;
      data.resultUri = null;
      data.error = null;
      data.lastRunAt = new Date();
      data.runCount = { increment: 1 };
    }
    if (status === 'review') {
      data.completedAt = null;
    }
    if (status === 'completed') {
      data.completedAt = new Date();
      data.progress = 1;
    }
    if (status === 'pending') {
      data.completedAt = null;
      data.result = null;
      data.resultUri = null;
      data.error = null;
    }

    const updated = await this.taskModel.update(id, data);
    if (!updated) throw new TaskNotFoundError(id);

    await this.taskModel.createLog({
      taskId: id,
      actorId,
      action: `human_forced_${status}`,
      message: reason,
      metadata: JSON.stringify(forcedMeta),
    });

    this.deps.eventBusService
      ?.publish({
        type: 'task.updated',
        timestamp: Date.now(),
        data: {
          taskId: id,
          title: updated.title,
          status: updated.status,
          progress: (updated as any).progress,
          statusMessage: reason,
          creatorId: task.creatorId,
          assigneeId: updated.assigneeId,
          conversationId: task.conversationId ?? null,
        },
      })
      .catch((err: any) => log.warn(`EventBus publish failed for forced task.updated: ${err.message}`));

    const updatedMeta = this.parseJson(updated.metadata);
    if (status === 'running' && updated.assigneeId) {
      if (this.isProjectionTaskKind(this.taskKind(updatedMeta))) {
        await this.createAndDispatchAgentRun(updated, {
          actorId,
          reason,
        });
      } else {
        await this.emitDaemonDispatchRequest(updated.assigneeId, updated);
        this.notifyAgent(updated.assigneeId, updated, 'task.dispatched').catch(() => {});
      }
    }
    if (status === 'running' && task.runtimeRoute === 'shell') {
      await this.emitShellDispatchRequest(updated);
    }

    if (
      (status === 'pending' || status === 'review' || status === 'completed') &&
      task.assigneeId &&
      previousStatus === 'running'
    ) {
      const activeRunTaskId = this.readActiveRunTaskId(updated.metadata);
      this.emitDaemonCancel(task.assigneeId, activeRunTaskId ?? id, reason);
      this.notifyAgent(task.assigneeId, updated, 'task.interrupted').catch(() => {});
    }
    if (
      (status === 'pending' || status === 'review' || status === 'completed') &&
      task.runtimeRoute === 'shell' &&
      previousStatus === 'running'
    ) {
      const targetDaemonId = this.readTargetDaemonId(task.metadata);
      if (targetDaemonId) this.emitRuntimeCancel(targetDaemonId, id, reason);
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
        data: {
          taskId,
          title: updated.title,
          creatorId: updated.creatorId,
          assigneeId: updated.assigneeId,
          conversationId: updated.conversationId ?? null,
        },
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
    // Wave-8 W7: chat surface — approval is the creator-driven path to
    // `completed`, mirror it back into the linked conversation.
    void this.emitTaskStatusChat(updated, 'completed', {});
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
        data: {
          taskId,
          title: updated.title,
          creatorId: updated.creatorId,
          assigneeId: updated.assigneeId,
          conversationId: updated.conversationId ?? null,
          reason,
        },
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
    // Wave-8 W7: chat surface — rejection is the creator-driven path to
    // `failed`, mirror it back into the linked conversation.
    void this.emitTaskStatusChat(updated, 'failed', { error: reason });
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
          conversationId: claimed.conversationId ?? null,
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

    // Wave-5 typed SSE: publish task.progress so the SSE relay can fan it
    // out to creator + assignee. Mirrors the cookbook §events table —
    // emitted on every daemon `task.dispatch.progress` (which is what
    // routes through reportProgress via WS handler).
    const meta = input.metadata as { progress?: number } | undefined;
    this.deps.eventBusService
      ?.publish({
        type: 'task.progress',
        timestamp: Date.now(),
        data: {
          taskId,
          progress: typeof meta?.progress === 'number' ? meta.progress : null,
          statusMessage: input.message ?? null,
          creatorId: task.creatorId,
          assigneeId: task.assigneeId,
          conversationId: task.conversationId ?? null,
        },
      })
      .catch((err) => log.warn(`EventBus publish failed for task.progress: ${(err as Error).message}`));

    log.info(`Progress: ${taskId} — ${input.message ?? '(no message)'}`);
  }

  /**
   * Runtime/device progress for runtimeRoute='shell'. This is deliberately
   * separate from agent progress: device/runtime is 1:1, runtime hosts many
   * agents, and shell execution belongs to the runtime/device surface.
   */
  async reportRuntimeProgress(taskId: string, daemonId: string, input: TaskProgressInput): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.assertShellTaskTargetsDaemon(task, daemonId);

    if (task.status !== 'running' && task.status !== 'assigned') {
      throw new TaskStateError(taskId, task.status, 'running or assigned');
    }

    if (task.status === 'assigned') {
      await this.taskModel.update(taskId, { status: 'running', lastRunAt: new Date() });
    }

    await this.taskModel.createLog({
      taskId,
      actorId: daemonActorId(daemonId),
      action: 'progress',
      message: input.message,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });

    const meta = input.metadata as { progress?: number } | undefined;
    this.deps.eventBusService
      ?.publish({
        type: 'task.progress',
        timestamp: Date.now(),
        data: {
          taskId,
          progress: typeof meta?.progress === 'number' ? meta.progress : null,
          statusMessage: input.message ?? null,
          creatorId: task.creatorId,
          assigneeId: null,
          conversationId: task.conversationId ?? null,
          runtimeRoute: 'shell',
          targetDaemonId: daemonId,
        },
      })
      .catch((err) => log.warn(`EventBus publish failed for shell task.progress: ${(err as Error).message}`));

    log.info(`Runtime progress: ${taskId} daemon=${daemonId} — ${input.message ?? '(no message)'}`);
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

    // Wave-9 (Phase 1): canonical result is IMTask.result (column above).
    // Clients fetch via GET /api/im/tasks/:id/result. The legacy IMAsset
    // (kind=task-result) mirror is dropped — it duplicated im_messages
    // content with no reader.

    // Wave-8 W7: post a system message into the linked conversation so the
    // user sees task closure inline (Q-B = C "both" decision).
    void this.emitTaskStatusChat(updated, 'completed', {
      output:
        typeof input.result === 'string' ? input.result : input.result == null ? null : JSON.stringify(input.result),
    });

    // Publish event — cookbook §events `task.completed` payload carries
    // `output` (adapter's text) + `metrics` (cost/duration). `result` may
    // be any JSON; SSE clients project to `output` for display.
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
          conversationId: updated.conversationId ?? null,
          output:
            typeof input.result === 'string'
              ? input.result
              : input.result == null
                ? null
                : JSON.stringify(input.result),
          metrics: { cost: updated.cost ?? task.cost ?? null },
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
    if (taskMeta.kind === 'agent_run' && typeof taskMeta.parentTaskId === 'string') {
      this.reconcileProjectionFromAgentRun(taskMeta.parentTaskId, task, 'completed', {
        result: input.result,
        resultUri: input.resultUri,
        actorId: agentId,
      }).catch((err) => log.warn(`projection reconcile failed for run ${taskId}: ${(err as Error).message}`));
    }

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

  async completeRuntimeTask(taskId: string, daemonId: string, input: TaskCompleteInput): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.assertShellTaskTargetsDaemon(task, daemonId);

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
      actorId: daemonActorId(daemonId),
      action: 'completed',
      message: 'Runtime command completed',
      metadata: input.result ? JSON.stringify({ resultPreview: String(input.result).slice(0, 200) }) : undefined,
    });

    this.deps.eventBusService
      ?.publish({
        type: 'task.completed',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          capability: updated.capability,
          creatorId: updated.creatorId,
          assigneeId: null,
          conversationId: updated.conversationId ?? null,
          runtimeRoute: 'shell',
          targetDaemonId: daemonId,
          output:
            typeof input.result === 'string'
              ? input.result
              : input.result == null
                ? null
                : JSON.stringify(input.result),
          metrics: { cost: updated.cost ?? task.cost ?? null },
        },
      })
      .catch(() => {});

    this.notifyUser(updated.creatorId, updated, 'task.completed').catch(() => {});
    // Wave-9 (Phase 1): runtime/shell result canonical in IMTask.result.

    // Wave-8 W7: surface runtime completion in chat (same Q-B = C path as
    // agent completion, but the runtime row has no assignee).
    void this.emitTaskStatusChat(updated, 'completed', {
      output:
        typeof input.result === 'string' ? input.result : input.result == null ? null : JSON.stringify(input.result),
    });

    log.info(`Runtime completed: ${taskId} daemon=${daemonId}`);
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

    const retryableErrorCode = parseRetryableErrorCode(input.metadata);

    // Check if we can retry. Generic failures keep the configured backoff;
    // daemon timeouts are retried immediately because the previous attempt
    // already consumed the full execution window.
    if (task.retryCount < task.maxRetries) {
      // Exponential backoff: retryDelayMs * 2^retryCount
      const delay = retryableErrorCode ? 0 : task.retryDelayMs * Math.pow(2, task.retryCount);
      const nextRetryAt = new Date(Date.now() + delay);

      const updated = await this.taskModel.update(taskId, {
        status: task.assigneeId ? 'assigned' : 'pending',
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
      if (task.assigneeId && !task.scheduleType && task.runtimeRoute !== 'shell' && delay === 0) {
        void this.emitDaemonDispatchRequest(task.assigneeId, updated).catch((err) =>
          log.warn(`retry daemon dispatch failed for ${taskId}: ${(err as Error).message}`),
        );
      }
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
          conversationId: updated.conversationId ?? null,
          error: input.error,
        },
      })
      .catch(() => {});

    // Notify creator
    this.notifyUser(updated.creatorId, updated, 'task.failed').catch(() => {});

    // Wave-8 W7: surface failure in chat. Only emitted on terminal failure
    // (after retries exhaust); intermediate retries are not user-visible.
    void this.emitTaskStatusChat(updated, 'failed', { error: input.error });

    const taskMeta = this.parseJson(task.metadata);
    if (taskMeta.kind === 'agent_run' && typeof taskMeta.parentTaskId === 'string') {
      this.reconcileProjectionFromAgentRun(taskMeta.parentTaskId, task, 'failed', {
        error: input.error,
        actorId: agentId,
      }).catch((err) => log.warn(`projection reconcile failed for run ${taskId}: ${(err as Error).message}`));
    }

    // Evolution hook: auto-record failed outcome
    this.recordEvolutionOutcome(agentId, task, 'failed', undefined, input.error).catch((err) =>
      log.error(`Evolution record FAILED for failed task ${taskId}: ${(err as Error).message}`),
    );

    return this.toTaskInfo(updated);
  }

  async failRuntimeTask(taskId: string, daemonId: string, input: TaskFailInput): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.assertShellTaskTargetsDaemon(task, daemonId);

    if (!['assigned', 'running'].includes(task.status)) {
      throw new TaskStateError(taskId, task.status, 'assigned or running');
    }

    const updated = await this.taskModel.update(taskId, {
      status: 'failed',
      error: input.error,
      completedAt: new Date(),
    });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({
      taskId,
      actorId: daemonActorId(daemonId),
      action: 'failed',
      message: input.error,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });

    this.deps.eventBusService
      ?.publish({
        type: 'task.failed',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          capability: updated.capability,
          creatorId: updated.creatorId,
          assigneeId: null,
          conversationId: updated.conversationId ?? null,
          runtimeRoute: 'shell',
          targetDaemonId: daemonId,
          error: input.error,
        },
      })
      .catch(() => {});

    this.notifyUser(updated.creatorId, updated, 'task.failed').catch(() => {});

    // Wave-8 W7: surface runtime failure in chat.
    void this.emitTaskStatusChat(updated, 'failed', { error: input.error });

    log.info(`Runtime failed: ${taskId} daemon=${daemonId} — ${input.error}`);
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

        // v1.9.x: scheduled task → also fire daemon dispatch envelope.
        // Only emit when there's a real assignee (not creator self-dispatch).
        if (task.assigneeId) {
          await this.emitDaemonDispatchRequest(task.assigneeId, updated);
        }

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

  // ═══════════════════════════════════════════════════════════
  // Cloud 3 / S3: Sandbox dispatch (daemon-first)
  //
  // For tasks with runtimeRoute='sandbox', the cloud spawns/reuses an
  // IMContainer in the task's workspace, then POSTs a task envelope to
  // the in-pod daemon's local HTTP RPC (controller proxies to
  // localhost:7878/v1/runs). Daemon owns adapter selection + subprocess
  // spawn + cloud WS upstream that reports completion.
  //
  // S3 Phase 1 simplification: dispatch is fire-and-forget. The daemon's
  // cloud WS upstream channel reports progress + completion separately
  // (out of S3 Phase 1 scope — to be wired in S4 / daemon-completion-
  // handler follow-up). On dispatch failure the task is marked failed
  // immediately; on dispatch ack the task stays 'running' until the WS
  // upstream transitions it.
  //
  // Asset enrichment (assetIds) is now part of the daemon-completion
  // handler, not this synchronous dispatch path.
  // ═══════════════════════════════════════════════════════════

  /**
   * Dispatch a task to a sandbox container via the in-pod daemon.
   *
   * Workflow:
   *   1. Reuse an existing IMContainer in the workspace if one is alive
   *      (status ∈ [warming|bound|running]); else create one via
   *      k8sSandbox.provisionContainer (apiKeyTtlSeconds = task.timeoutMs/1000+300)
   *   2. Cross-link IMTask.containerId; flip status → running
   *   3. Build daemon task envelope (adapter from task.metadata.adapter,
   *      default 'hermes'; prompt from task.input.prompt or input.command)
   *   4. Call k8sSandbox.daemonDispatch (in-process K8s SDK proxies to the
   *      in-pod daemon at localhost:7878/v1/runs)
   *   5a. On dispatch ack: write IMSandboxRunLog with exitReason=
   *      'dispatch_ok_pending' (endedAt=null), leave task 'running'.
   *   5b. On dispatch fail: write IMSandboxRunLog with exitReason=
   *      'dispatch_failed', mark task 'failed', emit task.dispatch.reply.
   *
   * Failure modes:
   *   - provisionContainer fails → throws, caller swallows + marks task failed
   *   - daemonDispatch k8s error → task failed with controller error
   *   - daemonDispatch unreachable → task failed with transport error
   *
   * Errors thrown from this method propagate to the .catch in createTask
   * which marks the task failed.
   */
  private async dispatchToSandbox(taskId: string): Promise<void> {
    const task = await prisma.iMTask.findUnique({ where: { id: taskId } });
    if (!task) throw new TaskNotFoundError(taskId);
    if (!task.workspaceId) {
      throw new TaskStateError(taskId, task.status, 'a task with workspaceId set');
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: task.workspaceId, deletedAt: null },
    });
    if (!ws) {
      throw new TaskStateError(taskId, 'unknown-workspace', 'an existing non-deleted workspace');
    }
    const tenantId = ws.ownerImUserId;

    // 1. Reuse an alive container if any
    const existing = await prisma.iMContainer.findFirst({
      where: {
        workspaceId: task.workspaceId,
        status: { in: ['warming', 'bound', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    let containerRow = existing;
    if (existing) {
      log.info(`reusing container ${existing.id} (pod=${existing.podName}) for task ${taskId}`);
    } else {
      const ttlSeconds = Math.ceil(task.timeoutMs / 1000) + 300;
      // Cloud 3 S3 reconcile (2026-05-04): prefer Nacos-injected
      // CONTAINER_IMAGE (the controller-side default has the same precedence),
      // fall back to the legacy SANDBOX_DEFAULT_IMAGE name (S2 spec), and
      // finally the daemon-first default. The earlier `prismer-academic:
      // v5.1-lite-s3` tag was the OpenClaw plugin host image (drift #4
      // legacy) — replaced by daemon-first image lineage per
      // docs/54release/13-sandbox-daemon-first-architecture.md.
      const sandboxImage =
        process.env.CONTAINER_IMAGE ??
        process.env.SANDBOX_DEFAULT_IMAGE ??
        'dockerhub.services/prismer/library/sandbox:daemon-v1.0';

      // S3 default footprint matches the cherry-picked S2 baseline.
      const cpuRequest = '250m';
      const cpuLimit = '2000m';
      const memoryRequest = '2Gi';
      const memoryLimit = '4Gi';

      const createArgs = {
        workspaceId: task.workspaceId,
        tenantId,
        taskId,
        image: sandboxImage,
        cpuRequest,
        cpuLimit,
        memoryRequest,
        memoryLimit,
        apiKeyTtlSeconds: ttlSeconds,
      };
      const ctlResp = await k8sSandbox.provisionContainer(createArgs);

      containerRow = await prisma.iMContainer.create({
        data: {
          workspaceId: task.workspaceId,
          tenantId,
          taskId,
          podName: ctlResp.container.podName,
          namespace: getK8sNamespace(),
          image: sandboxImage,
          imageTag: sandboxImage.split(':').pop() ?? 'latest',
          status: ctlResp.container.status,
          cpuRequest,
          cpuLimit,
          memoryRequest,
          memoryLimit,
          gatewayUrl: ctlResp.container.gatewayUrl ?? null,
          startedAt: new Date(),
        },
      });
      log.info(`spawned container ${containerRow.id} (pod=${containerRow.podName}) for task ${taskId}`);
    }

    if (!containerRow) {
      throw new TaskStateError(taskId, task.status, 'a reusable or spawnable container');
    }

    // 2. Cross-link + transition to running
    await prisma.iMTask.update({
      where: { id: taskId },
      data: { containerId: containerRow.id, status: 'running' },
    });

    // 3. Build daemon task envelope.
    //    - adapter: from task.metadata.adapter (escape hatch); default
    //      'hermes' (general-purpose adapter per S3 spec).
    //    - prompt: prefer task.input.prompt; fall back to joined command
    //      array, then raw input string.
    const taskMeta = this.parseJson(task.metadata);
    const adapter = typeof taskMeta.adapter === 'string' ? taskMeta.adapter : 'hermes';

    let parsedInput: { command?: string[] | string; prompt?: string } = {};
    try {
      parsedInput = JSON.parse(task.input);
    } catch {
      /* raw input string */
    }
    const prompt =
      parsedInput.prompt ??
      (Array.isArray(parsedInput.command) ? parsedInput.command.join(' ') : String(parsedInput.command ?? task.input));

    const startedAtMs = Date.now();
    let dispatchOk = false;
    let runId: string | undefined;
    let dispatchError: string | undefined;

    // Phase 1 escape hatch: forward task.metadata.shellCommand when caller
    // supplies it, so daemon's LocalServer can spawn it directly (test
    // affordance until S4 wires real adapter dispatch + completion). See
    // sdk/prismer-cloud/runtime/src/daemon/local-server.ts DispatchPayload.
    const shellCommand =
      typeof taskMeta.shellCommand === 'string' && taskMeta.shellCommand.length > 0 ? taskMeta.shellCommand : undefined;

    try {
      const dispatchPayload = {
        taskId,
        adapter,
        prompt,
        ...(shellCommand ? { shellCommand } : {}),
      };
      const dispatch = await k8sSandbox.daemonDispatch(containerRow.podName, dispatchPayload);
      runId = dispatch.runId;
      dispatchOk = true;
      log.info(`task ${taskId} dispatched to daemon (pod=${containerRow.podName}, adapter=${adapter}, runId=${runId})`);
    } catch (err) {
      if (err instanceof K8sSandboxError) {
        dispatchError = `k8s sandbox error (${err.code} / ${err.status}): ${err.body}`;
        log.warn(
          `daemonDispatch k8s error for task ${taskId} (pod=${containerRow.podName}, code=${err.code}, status=${err.status}): ${err.body}`,
        );
      } else {
        dispatchError = err instanceof Error ? err.message : String(err);
        log.warn(`daemonDispatch threw for task ${taskId}: ${dispatchError}`);
      }
    }

    const endedAt = new Date();
    const durationMs = Date.now() - startedAtMs;

    // 4a. Dispatch ack — leave task in 'running'. Daemon's cloud WS
    //     upstream completes the task asynchronously (out of S3 Phase 1
    //     scope). Asset enrichment also happens there.
    if (dispatchOk) {
      await prisma.iMSandboxRunLog.create({
        data: {
          containerId: containerRow.id,
          workspaceId: task.workspaceId,
          tenantId,
          startedAt: new Date(startedAtMs),
          endedAt: null,
          durationMs: null,
          trigger: 'task',
          taskId,
          exitReason: 'dispatch_ok_pending',
          exitCode: null,
        },
      });
      await this.taskModel
        .createLog({
          taskId,
          action: 'dispatched',
          message: `sandbox dispatch acked (adapter=${adapter}, runId=${runId ?? 'unknown'})`,
          metadata: JSON.stringify({
            containerId: containerRow.id,
            podName: containerRow.podName,
            adapter,
            runId,
          }),
        })
        .catch((logErr) => log.warn(`task log write failed for ${taskId}: ${(logErr as Error).message}`));
      log.info(
        `task.dispatch.ack taskId=${taskId} runId=${runId} containerId=${containerRow.id} (pending daemon completion)`,
      );
      return;
    }

    // 4b. Dispatch failed — mark task failed immediately + emit reply.
    await prisma.iMSandboxRunLog.create({
      data: {
        containerId: containerRow.id,
        workspaceId: task.workspaceId,
        tenantId,
        startedAt: new Date(startedAtMs),
        endedAt,
        durationMs,
        trigger: 'task',
        taskId,
        exitReason: 'dispatch_failed',
        exitCode: 1,
      },
    });

    const failedStatus: TaskStatus = 'failed';
    const errorMessage = dispatchError ?? 'unknown dispatch failure';
    await prisma.iMTask.update({
      where: { id: taskId },
      data: {
        status: failedStatus,
        error: errorMessage,
        completedAt: endedAt,
      },
    });

    await this.taskModel
      .createLog({
        taskId,
        action: failedStatus,
        message: `sandbox dispatch failed: ${errorMessage}`,
        metadata: JSON.stringify({
          containerId: containerRow.id,
          podName: containerRow.podName,
          adapter,
          durationMs,
        }),
      })
      .catch((logErr) => log.warn(`task log write failed for ${taskId}: ${(logErr as Error).message}`));

    // Note on escrow: failed sandbox dispatches do NOT auto-refund here —
    // existing call-sites (cancel / reject / timeout sweep / retry-exhausted
    // failTask) own that lifecycle.

    log.info(
      `task.dispatch.reply taskId=${taskId} status=${failedStatus} error=${errorMessage} containerId=${containerRow.id}`,
    );

    this.deps.eventBusService
      ?.publish({
        type: 'task.dispatch.reply',
        timestamp: Date.now(),
        data: {
          taskId,
          status: failedStatus,
          ok: false,
          containerId: containerRow.id,
          durationMs,
          error: { code: 'sandbox_dispatch_failed', message: errorMessage },
        },
      })
      .catch(() => {
        /* event bus best-effort */
      });
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

  // ═══════════════════════════════════════════════════════════
  // v1.9.x daemon protocol — `task.dispatch.request` / `task.cancel`
  //
  // Sent in addition to the legacy `task.notification` envelope. Daemons
  // (Track B) listen for `task.dispatch.request`; mobile / SDKs continue to
  // get `task.notification` over SSE. Both go to the same agentImUserId
  // connection — daemon picks the daemon-protocol type, mobile picks the
  // notification type.
  //
  // `profileId` is read from task.metadata.profileId when present (set by
  // the @-mention dispatcher in message.service). When absent (e.g. mobile
  // creates a task directly), the daemon resolves the profile itself by
  // looking at the agent's first profile in the workspace — the cloud does
  // not block on that lookup here.
  // ═══════════════════════════════════════════════════════════

  /**
   * Emit `task.dispatch.request` to the agent's daemon (if online).
   *
   * Idempotent on the daemon side via `requestId`: dispatchDueTasks /
   * redispatchPending / mention-driven createTask all use the same task.id
   * as request id. Daemon dedupes by taskId in its running_tasks table.
   */
  private async emitDaemonDispatchRequest(
    agentImUserId: string,
    task: {
      id: string;
      title: string;
      // description is the primary "what to do" text — surfaced verbatim
      // on the UI and forwarded to the daemon as the executing LLM's prompt.
      // Single source of truth (see v19x-helpers.ts fallback chain).
      description?: string | null;
      status: string;
      capability?: string | null;
      input?: string;
      metadata?: string;
      timeoutMs?: number | null;
      assigneeId?: string | null;
      conversationId?: string | null;
      creatorId?: string | null;
      workspaceId?: string | null;
      runtimeRoute?: string | null;
    },
    event: string = 'task.assigned',
  ): Promise<void> {
    const payload = buildTaskDispatchRequest(task, agentImUserId);

    // Wave-8 W1: hydrate asset references attached by user.
    const taskMeta = this.parseJson(task.metadata);
    const assetSourceTaskId = typeof taskMeta.parentTaskId === 'string' ? taskMeta.parentTaskId : task.id;
    const assetRefs = await this.resolveAssetRefs(assetSourceTaskId, task.metadata);
    if (assetRefs && assetRefs.length > 0) {
      payload.assetRefs = assetRefs;
      await this.recordAssetRequestObservability(assetSourceTaskId, assetRefs);
    }

    // Wave-7 ζ: route to daemon shadow key when agent is hosted by a
    // specific daemon. If the daemon was forgotten from the workspace, block
    // dispatch explicitly instead of falling back to the agent user channel.
    const route = await this.resolveAgentDaemonRoute(agentImUserId);
    if (route.kind === 'forgotten') {
      await this.recordDaemonUnboundDispatch(task, route.daemonId, route.workspaceId, agentImUserId);
      return;
    }
    const targetDaemonId = route.kind === 'active' ? route.daemonId : null;
    const routeKey = targetDaemonId ? daemonRouteKey(targetDaemonId) : agentImUserId;
    if (targetDaemonId) payload.targetDaemonId = targetDaemonId;

    const conns = this.deps.rooms.getClientConnections(routeKey);
    log.info(
      `[v1.9.x] task.dispatch.request → ${routeKey} (agent=${agentImUserId}, task=${task.id}, conns=${conns.size})`,
    );
    if (conns.size === 0) {
      if (taskMeta.kind === 'agent_run' && taskMeta.runId === task.id) {
        await this.appendTaskRunEvent(task.id, task.assigneeId ?? agentImUserId, {
          type: 'run.dispatch_pending',
          level: 'warn',
          message: 'Daemon offline; run dispatch pending',
          payload: targetDaemonId ? { targetDaemonId } : {},
        }).catch((err) => log.warn(`run pending event write failed: ${(err as Error).message}`));
      } else {
        await this.markPendingDispatch(task.id, 'daemon_offline', targetDaemonId ? { targetDaemonId } : {});
      }
      // Don't actually send — the sendToUser would no-op anyway. The
      // next host.declare will pick the task up via redispatchPending.
      return;
    }
    try {
      this.deps.rooms.sendToUser(routeKey, ServerEvents.taskDispatchRequest(payload, task.id));
    } catch (err) {
      log.warn(`task.dispatch.request push failed for ${routeKey}: ${(err as Error).message}`);
    }
  }

  private async resolveAgentDaemonRoute(agentImUserId: string): Promise<DaemonRouteResolution> {
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentImUserId },
      select: { metadata: true, workspaceId: true },
    });
    if (!card?.metadata) return { kind: 'none' };
    try {
      const meta = JSON.parse(card.metadata) as { daemonId?: unknown };
      const daemonId = typeof meta.daemonId === 'string' && meta.daemonId.trim() ? meta.daemonId.trim() : '';
      if (!daemonId) return { kind: 'none' };
      const workspace = await prisma.iMWorkspace.findFirst({
        where: { id: card.workspaceId, deletedAt: null },
        select: { id: true, metadata: true },
      });
      if (workspace && isDaemonForgotten(workspace.metadata, daemonId)) {
        return { kind: 'forgotten', daemonId, workspaceId: workspace.id };
      }
      return { kind: 'active', daemonId, workspaceId: workspace?.id ?? card.workspaceId ?? null };
    } catch {
      return { kind: 'none' };
    }
  }

  private async emitShellDispatchRequest(task: {
    id: string;
    title: string;
    // description is the primary "what to do" text (single source of truth).
    description?: string | null;
    status: string;
    capability?: string | null;
    input?: string;
    metadata?: string;
    timeoutMs?: number | null;
    conversationId?: string | null;
    creatorId?: string | null;
    workspaceId?: string | null;
    runtimeRoute?: string | null;
  }): Promise<void> {
    const targetDaemonId = this.readTargetDaemonId(task.metadata);
    if (!targetDaemonId) {
      throw new Error(`shell task ${task.id} is missing metadata.execution.targetDaemonId`);
    }
    const workspace = await this.resolveRuntimeTaskWorkspace(task);
    if (workspace && isDaemonForgotten(workspace.metadata, targetDaemonId)) {
      await this.recordDaemonUnboundDispatch(task, targetDaemonId, workspace.id);
      return;
    }

    const routeKey = daemonRouteKey(targetDaemonId);
    const payload = buildTaskDispatchRequest(task, '');
    payload.targetDaemonId = targetDaemonId;
    payload.runtimeRoute = 'shell';

    const conns = this.deps.rooms.getClientConnections(routeKey);
    log.info(`[v1.9.x] shell task.dispatch.request → ${routeKey} (task=${task.id}, conns=${conns.size})`);
    if (conns.size === 0) {
      await this.markPendingDispatch(task.id, 'daemon_offline', { targetDaemonId });
      return;
    }

    try {
      this.deps.rooms.sendToUser(routeKey, ServerEvents.taskDispatchRequest(payload, task.id));
    } catch (err) {
      log.warn(`shell task.dispatch.request push failed for ${routeKey}: ${(err as Error).message}`);
    }
  }

  private async resolveRuntimeTaskWorkspace(task: {
    workspaceId?: string | null;
    conversationId?: string | null;
    creatorId?: string | null;
  }): Promise<{ id: string; metadata: string } | null> {
    if (task.workspaceId) {
      const workspace = await prisma.iMWorkspace.findFirst({
        where: { id: task.workspaceId, deletedAt: null },
        select: { id: true, metadata: true },
      });
      if (workspace) return workspace;
    }
    if (task.conversationId) {
      const conversation = await prisma.iMConversation.findUnique({
        where: { id: task.conversationId },
        select: { workspaceId: true },
      });
      if (conversation?.workspaceId) {
        const workspace = await prisma.iMWorkspace.findFirst({
          where: { id: conversation.workspaceId, deletedAt: null },
          select: { id: true, metadata: true },
        });
        if (workspace) return workspace;
      }
    }
    if (task.creatorId) {
      return prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: task.creatorId, isDefault: true, deletedAt: null },
        select: { id: true, metadata: true },
      });
    }
    return null;
  }

  private async recordDaemonUnboundDispatch(
    task: {
      id: string;
      metadata?: string | null;
      assigneeId?: string | null;
      creatorId?: string | null;
      runtimeRoute?: string | null;
    },
    daemonId: string,
    workspaceId: string | null,
    agentImUserId?: string,
  ): Promise<void> {
    await this.markPendingDispatch(task.id, 'daemon_unbound', {
      targetDaemonId: daemonId,
      workspaceId,
      agentImUserId,
    });
    const taskMeta = this.parseJson(task.metadata);
    if (taskMeta.kind === 'agent_run' && taskMeta.runId === task.id) {
      await this.appendTaskRunEvent(
        task.id,
        task.assigneeId ?? agentImUserId ?? task.creatorId ?? daemonActorId(daemonId),
        {
          type: 'run.dispatch_blocked',
          level: 'warn',
          message: 'Daemon forgotten from workspace; dispatch blocked',
          payload: { targetDaemonId: daemonId, workspaceId, reason: 'daemon_unbound' },
        },
      ).catch((err) => log.warn(`run blocked event write failed: ${(err as Error).message}`));
    }
    log.warn(
      `task.dispatch.request blocked: task=${task.id} daemon=${daemonId} workspace=${workspaceId ?? '(unknown)'} reason=daemon_unbound`,
    );
  }

  private async markPendingDispatch(
    taskId: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const existingTask = await prisma.iMTask.findUnique({
        where: { id: taskId },
        select: { metadata: true, status: true },
      });
      if (
        existingTask &&
        existingTask.status !== 'completed' &&
        existingTask.status !== 'cancelled' &&
        existingTask.status !== 'failed'
      ) {
        let prevMeta: Record<string, unknown> = {};
        try {
          prevMeta = JSON.parse(existingTask.metadata ?? '{}');
        } catch {
          /* fall through with empty meta */
        }
        await prisma.iMTask.update({
          where: { id: taskId },
          data: {
            metadata: JSON.stringify({
              ...prevMeta,
              pendingDispatchReason: reason,
              pendingSince: new Date().toISOString(),
              ...extra,
            }),
          },
        });
      }
    } catch (err) {
      log.warn(`failed to record pendingDispatch on task ${taskId}: ${(err as Error).message}`);
    }
  }

  /**
   * Wave-8 W1: hydrate `assetRefs` for a dispatch payload.
   *
   * Sources of asset IDs (deduplicated, dropped if missing in im_assets):
   *   - `metadata.assets.linkedAssetIds` — caller-supplied (task creation
   *     directly attached files; e.g. mobile compose, REST POST /tasks).
   *   - `metadata.assets.aggregatedAssetIds` — collected from chat messages
   *     in the dispatch context window by message.service.
   *
   * Returns `undefined` when no assets are referenced (so the wire payload
   * stays clean). Logs and continues for each missing asset row — a stale
   * id shouldn't block the rest of the dispatch.
   */
  private async resolveAssetRefs(
    taskId: string,
    metadataJson: string | null | undefined,
  ): Promise<AssetRef[] | undefined> {
    let metaObj: Record<string, unknown> = {};
    try {
      metaObj = metadataJson ? JSON.parse(metadataJson) : {};
    } catch {
      return undefined;
    }
    const assetsMeta = metaObj.assets;
    if (!assetsMeta || typeof assetsMeta !== 'object') return undefined;
    const linked = (assetsMeta as Record<string, unknown>).linkedAssetIds;
    const aggregated = (assetsMeta as Record<string, unknown>).aggregatedAssetIds;

    const ids: string[] = [];
    const seen = new Set<string>();
    const collect = (raw: unknown, source: 'linked' | 'aggregated') => {
      if (!Array.isArray(raw)) {
        if (raw !== undefined) {
          log.warn(`task ${taskId}: metadata.assets.${source}AssetIds is not an array — skipping`);
        }
        return;
      }
      for (const v of raw) {
        if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
          seen.add(v);
          ids.push(v);
        }
      }
    };
    collect(linked, 'linked');
    collect(aggregated, 'aggregated');
    if (ids.length === 0) return undefined;

    const rows = await prisma.iMAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, contentHash: true, mime: true, sizeBytes: true, kind: true, workspaceId: true },
    });
    type AssetRow = {
      id: string;
      contentHash: string;
      mime: string | null;
      sizeBytes: bigint | null;
      kind: string;
      workspaceId: string;
    };
    const byId = new Map<string, AssetRow>(rows.map((r: AssetRow) => [r.id, r]));

    const refs: AssetRef[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        log.warn(`task ${taskId}: assetId ${id} not found in im_assets — dropping from dispatch`);
        continue;
      }
      refs.push({
        assetId: row.id,
        contentHash: row.contentHash,
        mime: row.mime,
        sizeBytes: row.sizeBytes !== null ? Number(row.sizeBytes) : null,
        kind: row.kind,
        workspaceId: row.workspaceId,
        role: 'attachment',
      });
    }
    return refs.length > 0 ? refs : undefined;
  }

  /**
   * Wave-8 W1: stamp `metadata.observability.assets.requested` so the
   * dispatcher / e2e can tell *what was asked of the daemon*. The matching
   * `strategies` + `resolved` count get filled in by the dispatch reply
   * handler (handler.ts handleTaskDispatchReply).
   */
  private async recordAssetRequestObservability(taskId: string, refs: AssetRef[]): Promise<void> {
    try {
      const row = await prisma.iMTask.findUnique({
        where: { id: taskId },
        select: { metadata: true },
      });
      if (!row) return;
      let prev: Record<string, unknown> = {};
      try {
        prev = JSON.parse(row.metadata ?? '{}');
      } catch {
        prev = {};
      }
      const observability = (
        prev.observability && typeof prev.observability === 'object'
          ? { ...(prev.observability as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      observability.assets = {
        ...((observability.assets as Record<string, unknown> | undefined) ?? {}),
        requested: refs.length,
        requestedRefs: refs.map((r) => ({ assetId: r.assetId, mime: r.mime, sizeBytes: r.sizeBytes, kind: r.kind })),
      };
      await prisma.iMTask.update({
        where: { id: taskId },
        data: { metadata: JSON.stringify({ ...prev, observability }) },
      });
    } catch (err) {
      log.warn(`failed to record asset observability for task ${taskId}: ${(err as Error).message}`);
    }
  }

  /**
   * Re-dispatch every pending/assigned/running task this user owns.
   *
   * Called from the WS handler on `agent.host.declare` so a daemon that
   * crashed mid-task picks up where it left off when it reconnects. The
   * daemon dedupes by taskId server-side via `requestId === task.id`.
   *
   * Scope: tasks where `creatorId === userId` AND status ∈
   * {pending, assigned, running}. Includes tasks whose assignee is offline
   * at scan time — by definition only the just-reconnected daemon will
   * receive the broadcast (RoomManager.sendToUser is a no-op for offline
   * users).
   */
  async redispatchPending(userId: string): Promise<number> {
    log.info(`[v1.9.x] redispatchPending called for userId=${userId}`);
    const tasks = await prisma.iMTask.findMany({
      where: {
        creatorId: userId,
        status: { in: ['pending', 'assigned', 'running'] },
        OR: [{ assigneeId: { not: null } }, { runtimeRoute: 'shell' }],
      },
      select: {
        id: true,
        title: true,
        status: true,
        capability: true,
        input: true,
        metadata: true,
        timeoutMs: true,
        conversationId: true,
        assigneeId: true,
        creatorId: true,
        workspaceId: true,
        runtimeRoute: true,
      },
      take: 200, // bound the work; sweep again on next reconnect if more
    });

    log.info(`[v1.9.x] redispatchPending found ${tasks.length} task(s) for ${userId}`);
    let count = 0;
    for (const task of tasks) {
      if (task.runtimeRoute === 'shell') {
        await this.emitShellDispatchRequest(task);
        count++;
        continue;
      }
      if (!task.assigneeId) continue;
      await this.emitDaemonDispatchRequest(task.assigneeId, task);
      count++;
    }
    if (count > 0) {
      log.info(`Redispatched ${count} pending task(s) for user ${userId}`);
    }
    return count;
  }

  /**
   * Emit `task.cancel` to the agent's daemon. Caller (cancelTask /
   * updateTask cancelled branch) is also responsible for the legacy
   * `task.notification { event: 'task.cancelled' }` via notifyAgent.
   */
  private emitDaemonCancel(agentImUserId: string, taskId: string, reason?: string): void {
    try {
      this.deps.rooms.sendToUser(agentImUserId, ServerEvents.taskCancel({ taskId, reason }));
    } catch (err) {
      log.warn(`task.cancel push failed for ${agentImUserId}: ${(err as Error).message}`);
    }
  }

  emitRuntimeCancel(targetDaemonId: string, taskId: string, reason?: string): void {
    try {
      this.deps.rooms.sendToUser(daemonRouteKey(targetDaemonId), ServerEvents.taskCancel({ taskId, reason }));
    } catch (err) {
      log.warn(`runtime task.cancel push failed for ${targetDaemonId}: ${(err as Error).message}`);
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

  /**
   * Wave-8 W7 — emit a system message into the task's linked conversation
   * when the task reaches a terminal state (completed / failed / cancelled).
   *
   * Per `docs/54release/16-workspace-uiux-final.md` §5 Q-B = C decision the
   * UI surfaces the change in two complementary ways:
   *   1. centred chip row in chat (this method posts the system message)
   *   2. inline ✓/✗ on the trigger message (UI looks up `triggerMessageId`
   *      from this message's metadata)
   *
   * Mute is honoured client-side (the row is filtered out when
   * conversation.muted is true) so the audit trail stays in the DB even
   * when the user has muted the session.
   *
   * Fire-and-forget — failures here MUST NOT bubble up and abort the task
   * lifecycle (the task already moved to its terminal state on disk).
   */
  private async emitTaskStatusChat(
    task: {
      id: string;
      title: string;
      conversationId: string | null;
      assigneeId: string | null;
      creatorId: string;
      metadata: string;
      runtimeRoute?: string | null;
    },
    status: 'completed' | 'failed' | 'cancelled',
    opts: { error?: string | null; output?: string | null; by?: string | null } = {},
  ): Promise<void> {
    if (!task.conversationId) return;
    const conversationId = task.conversationId;

    // The system message is sent under whichever participant best represents
    // the actor: the assignee for completion / failure (it's their work that
    // closed), the creator for cancel. Runtime/shell tasks have no agent —
    // fall back to creator (always a participant).
    const senderId = status === 'cancelled' ? (opts.by ?? task.creatorId) : (task.assigneeId ?? task.creatorId);

    // Pull triggerMessageId from task metadata (set by the @-mention
    // dispatcher in MessageService.dispatchToAgent). Optional — only
    // mention-driven tasks carry it.
    let triggerMessageId: string | undefined;
    try {
      const meta = this.parseJson(task.metadata);
      if (typeof meta.triggerMessageId === 'string' && meta.triggerMessageId) {
        triggerMessageId = meta.triggerMessageId;
      }
    } catch {
      /* fall through — metadata is best-effort */
    }

    const titleSafe = task.title.length > 80 ? `${task.title.slice(0, 77)}…` : task.title;
    let content: string;
    if (status === 'completed') {
      content = `✅ Task completed: **${titleSafe}**`;
    } else if (status === 'failed') {
      const err = (opts.error ?? '').trim();
      content = err ? `❌ Task failed: **${titleSafe}** · ${err.slice(0, 200)}` : `❌ Task failed: **${titleSafe}**`;
    } else {
      content = `🚫 Task cancelled: **${titleSafe}**`;
    }

    try {
      await this.deps.messageService.send({
        conversationId,
        senderId,
        type: 'system',
        content,
        metadata: {
          kind: 'task_status_event',
          taskId: task.id,
          status,
          taskTitle: task.title,
          agentImUserId: task.assigneeId ?? null,
          ...(triggerMessageId ? { triggerMessageId } : {}),
          ...(opts.error ? { error: opts.error.slice(0, 500) } : {}),
          ...(opts.output ? { outputPreview: opts.output.slice(0, 200) } : {}),
        },
      });
    } catch (err) {
      // Critical-but-non-fatal: the task lifecycle already settled, but the
      // user lost visibility on it. Log loud so the owner can backfill.
      log.warn(
        `task_status_event post failed for task ${task.id} (${status}) on conversation ${conversationId}: ${(err as Error).message}`,
      );
    }

    // Wave-8 W9: notify the creator's Bell drawer in addition to the chat
    // chip. Creator is always the appropriate recipient — they own the task,
    // the assignee already has their own affordance (assignee saw the task
    // run; the creator is the one who needs to know it closed).
    void emitTaskStatusNotification({
      taskId: task.id,
      title: task.title,
      recipientImUserId: task.creatorId,
      status,
      error: opts.error ?? null,
      conversationId: task.conversationId ?? null,
      workspaceId: (task as { workspaceId?: string | null }).workspaceId ?? null,
    });
    void this.fanOutBellSync(task.creatorId, `task.${status}`, {
      taskId: task.id,
      title: task.title,
      status,
    });
  }

  /**
   * Wave-8 W9 — push a `bell.refresh` sync event to the recipient so their
   * workspace shell SSE subscriber re-pulls /api/notifications. Cheap fan-out:
   * the actual row already lives in pc_notifications, this is just the kick.
   * Recipient is an IM cuid; sync.service reaches them via
   * `im:sync:<imUserId>` Redis pub/sub.
   */
  private async fanOutBellSync(
    imUserId: string | null,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!imUserId || !this.deps.syncService) return;
    try {
      await this.deps.syncService.writeEvent(eventType, data, null, imUserId);
    } catch (err) {
      // Best-effort — the Bell row is already persisted, the user will see it
      // on the next manual reload regardless.
      log.warn(`fanOutBellSync failed for ${imUserId}: ${(err as Error).message}`);
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

  private parseJsonValue<T = unknown>(value: string | null | undefined): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private taskKind(metadata: Record<string, unknown>): string | null {
    const kind = metadata.kind;
    return typeof kind === 'string' && kind.trim() ? kind.trim() : null;
  }

  private normalizeCreatedTaskMetadata(metadata?: TaskMetadata): TaskMetadata {
    const next: TaskMetadata = { ...(metadata ?? {}) };
    if (!this.taskKind(next)) {
      next.kind = 'work_item';
    }
    if (next.schemaVersion === undefined) {
      next.schemaVersion = 1;
    }
    return next;
  }

  private inferTaskKind(
    task: { capability?: string | null; conversationId?: string | null; metadata?: string | null },
    meta: Record<string, unknown> = this.parseJson(task.metadata),
  ): string {
    const explicit = this.taskKind(meta);
    if (explicit) return explicit;
    if (meta.intent === 'standing_objective' || meta.goal !== undefined) return 'goal';
    if (this.isImplicitLegacyAgentRun(task, meta)) return 'agent_run';
    return 'work_item';
  }

  private isProjectionTaskKind(kind: string | null): boolean {
    return kind === 'work_item' || kind === 'goal';
  }

  private readObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private readActiveRunTaskId(metadata?: string | null): string | null {
    const meta = this.parseJson(metadata);
    const execution = this.readObject(meta.execution);
    const active = execution.activeRunTaskId;
    return typeof active === 'string' && active.trim() ? active.trim() : null;
  }

  private async createAndDispatchAgentRun(
    parent: {
      id: string;
      title: string;
      description: string | null;
      capability: string | null;
      input: string;
      contextUri: string | null;
      creatorId: string;
      assigneeId: string | null;
      workspaceId: string | null;
      conversationId: string | null;
      timeoutMs: number;
      maxRetries: number;
      retryDelayMs: number;
      metadata: string;
    },
    opts: { actorId: string; reason: string },
  ): Promise<void> {
    if (!parent.assigneeId) {
      throw new TaskStateError(parent.id, 'unassigned', 'an assigned agent before creating an agent run');
    }

    const parentMeta = this.parseJson(parent.metadata);
    const sourceKind = this.taskKind(parentMeta) ?? 'work_item';
    const now = new Date().toISOString();
    const runMetadata: Record<string, unknown> = {
      kind: 'agent_run',
      parentTaskId: parent.id,
      parentTitle: parent.title,
      parentDescription: parent.description,
      sourceKind,
      triggerKind: opts.reason,
      dispatchedFrom: 'task_projection',
      dispatchedAt: now,
    };
    for (const key of ['profileId', 'context', 'adapter', 'delivery', 'wake_mode', 'session_target']) {
      if (parentMeta[key] !== undefined) runMetadata[key] = parentMeta[key];
    }
    if (sourceKind === 'goal') {
      runMetadata.goalTaskId = parent.id;
    }

    const run = await this.taskModel.createRun({
      taskId: parent.id,
      workspaceId: parent.workspaceId,
      conversationId: parent.conversationId,
      creatorId: parent.creatorId,
      assigneeId: parent.assigneeId,
      actorId: opts.actorId,
      sourceKind: sourceKind === 'goal' ? 'goal' : 'work_item',
      capability: parent.capability ?? undefined,
      status: 'assigned',
      runtimeRoute: 'agent',
      input: parent.input,
      metadata: JSON.stringify({
        ...runMetadata,
        parentTaskId: parent.id,
      }),
    });

    await this.taskModel.createLog({
      taskId: parent.id,
      actorId: opts.actorId,
      action: 'agent_run_created',
      message: `Created agent run ${run.id} from ${sourceKind}`,
      metadata: JSON.stringify({ runTaskId: run.id, reason: opts.reason, at: now }),
    });
    // Why removed: im_task_logs.taskId has a FK to im_tasks(id), but run.id
    // lives in im_task_runs. The original code here violated that FK and
    // crashed the whole forceExecutionStatus flow with a 500, leaving the
    // run row stranded with no dispatch. The next call to createRunEvent
    // already records the dispatch in the proper table (im_task_events,
    // keyed by runId), so this log entry was redundant on top of being
    // schema-illegal. See `Fix 11`.

    await this.taskModel.createRunEvent({
      runId: run.id,
      taskId: parent.id,
      workspaceId: parent.workspaceId,
      conversationId: parent.conversationId,
      actorId: opts.actorId,
      type: 'run.dispatched',
      message: `Agent run created from task ${parent.id}`,
      payload: JSON.stringify({ parentTaskId: parent.id, sourceKind, at: now }),
    });

    const parentExecution = this.readObject(parentMeta.execution);
    await this.taskModel.update(parent.id, {
      lastRunAt: new Date(),
      runCount: { increment: 1 },
      metadata: JSON.stringify({
        ...parentMeta,
        execution: {
          ...parentExecution,
          activeRunTaskId: run.id,
          lastRunTaskId: run.id,
          lastDispatchedAt: now,
          dispatchReason: opts.reason,
        },
      }),
    });

    this.deps.eventBusService
      ?.publish({
        type: 'task.created',
        timestamp: Date.now(),
        data: {
          taskId: run.id,
          title: run.title,
          capability: run.capability,
          creatorId: run.creatorId,
          assigneeId: run.assigneeId,
          conversationId: run.conversationId ?? null,
          parentTaskId: parent.id,
          kind: 'agent_run',
        },
      })
      .catch(() => {});

    this.notifyAgent(parent.assigneeId, run, 'task.assigned').catch((err) =>
      log.warn(`Failed to notify assignee for run ${run.id}: ${err.message}`),
    );
    await this.dispatchTaskRun(run.id, parent.assigneeId, 'task.assigned');
  }

  private async reconcileProjectionFromAgentRun(
    parentTaskId: string,
    runTask: { id: string; title: string; metadata: string },
    outcome: 'completed' | 'failed',
    opts: { actorId: string; result?: unknown; resultUri?: string | null; error?: string },
  ): Promise<void> {
    const parent = await this.taskModel.findById(parentTaskId);
    if (!parent) return;
    const parentMeta = this.parseJson(parent.metadata);
    const parentKind = this.taskKind(parentMeta);
    if (!this.isProjectionTaskKind(parentKind)) return;

    const now = new Date().toISOString();
    const execution = this.readObject(parentMeta.execution);
    const activeRunTaskId =
      typeof execution.activeRunTaskId === 'string' && execution.activeRunTaskId.trim()
        ? execution.activeRunTaskId.trim()
        : null;
    if (parentKind === 'work_item' && !['assigned', 'running'].includes(parent.status)) {
      await this.taskModel.createLog({
        taskId: parentTaskId,
        actorId: opts.actorId,
        action: `agent_run_${outcome}_ignored`,
        message: `Ignored agent run ${runTask.id} ${outcome} because parent status is ${parent.status}`,
        metadata: JSON.stringify({ runTaskId: runTask.id, parentStatus: parent.status, at: now }),
      });
      return;
    }
    if (activeRunTaskId && activeRunTaskId !== runTask.id) {
      await this.taskModel.createLog({
        taskId: parentTaskId,
        actorId: opts.actorId,
        action: `agent_run_${outcome}_ignored`,
        message: `Ignored stale agent run ${runTask.id}; active run is ${activeRunTaskId}`,
        metadata: JSON.stringify({ runTaskId: runTask.id, activeRunTaskId, at: now }),
      });
      return;
    }
    const nextExecution: Record<string, unknown> = {
      ...execution,
      lastRunTaskId: runTask.id,
      lastOutcome: outcome,
      lastSyncedAt: now,
    };
    if (execution.activeRunTaskId === runTask.id) {
      nextExecution.activeRunTaskId = null;
    }
    if (outcome === 'completed') {
      nextExecution.lastCompletedAt = now;
      if (opts.result !== undefined) nextExecution.lastResultPreview = String(opts.result).slice(0, 500);
    } else {
      nextExecution.lastFailedAt = now;
      nextExecution.lastError = opts.error ?? 'unknown';
    }

    const runMeta = this.parseJson(runTask.metadata);
    const parentBridge = this.readObject(parentMeta.bridge);
    const runBridge = this.readObject(runMeta.bridge);
    const mergedBridge = Object.keys(runBridge).length > 0 ? { ...parentBridge, ...runBridge } : parentBridge;

    const nextMeta: Record<string, unknown> = {
      ...parentMeta,
      execution: nextExecution,
    };
    if (Object.keys(mergedBridge).length > 0) {
      nextMeta.bridge = mergedBridge;
    }

    const data: Record<string, unknown> = {
      metadata: JSON.stringify(nextMeta),
    };
    if (parentKind === 'work_item') {
      if (outcome === 'completed' && parent.status !== 'completed') {
        data.status = 'review';
        data.progress = 1;
        if (opts.result !== undefined) {
          data.result = JSON.stringify(opts.result);
        }
        if (opts.resultUri !== undefined) {
          data.resultUri = opts.resultUri;
        }
      }
      if (outcome === 'failed') {
        data.status = 'failed';
        data.error = opts.error ?? 'agent run failed';
      }
    }

    await this.taskModel.update(parentTaskId, data);
    // Wave-9 (Phase 1): projection inherits the run's result via IMTask.result
    // (data.result set above when outcome === 'completed'). Clients fetch
    // through GET /api/im/tasks/:parentId/result. No separate asset row.
    await this.taskModel.createLog({
      taskId: parentTaskId,
      actorId: opts.actorId,
      action: `agent_run_${outcome}`,
      message:
        outcome === 'completed'
          ? `Agent run ${runTask.id} completed; projection moved to review`
          : `Agent run ${runTask.id} failed: ${opts.error ?? 'unknown'}`,
      metadata: JSON.stringify({ runTaskId: runTask.id, outcome, at: now }),
    });

    this.deps.eventBusService
      ?.publish({
        type: 'task.updated',
        timestamp: Date.now(),
        data: {
          taskId: parentTaskId,
          title: parent.title,
          status: typeof data.status === 'string' ? data.status : parent.status,
          progress: typeof data.progress === 'number' ? data.progress : parent.progress,
          statusMessage: outcome === 'completed' ? 'Agent run completed' : (opts.error ?? 'Agent run failed'),
          creatorId: parent.creatorId,
          assigneeId: parent.assigneeId,
          conversationId: parent.conversationId ?? null,
          childRunTaskId: runTask.id,
        },
      })
      .catch(() => {});
  }

  private readTargetDaemonId(metadata?: string | null): string | null {
    const meta = this.parseJson(metadata);
    const execution = meta.execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null;
    const target = (execution as Record<string, unknown>).targetDaemonId;
    return typeof target === 'string' && target.trim() ? target.trim() : null;
  }

  private assertShellTaskTargetsDaemon(
    task: { id: string; runtimeRoute?: string | null; metadata?: string | null },
    daemonId: string,
  ): void {
    if (task.runtimeRoute !== 'shell') {
      throw new TaskAccessError(task.id, 'runtime daemon can only report shell tasks');
    }
    const targetDaemonId = this.readTargetDaemonId(task.metadata);
    if (!targetDaemonId || targetDaemonId !== daemonId) {
      throw new TaskAccessError(task.id, 'runtime daemon does not own this shell task');
    }
  }

  private isLegacyAgentRunTask(task: {
    id: string;
    metadata: string;
    creatorId: string;
    assigneeId: string | null;
    status: string;
    capability?: string | null;
    conversationId?: string | null;
  }): boolean {
    const meta = this.parseJson(task.metadata);
    return this.isImplicitLegacyAgentRun(task, meta);
  }

  private normalizeKindFilter(kind: TaskListQuery['kind'], view?: TaskListQuery['view']): string[] | null {
    if (view === 'all') return null;
    const raw = Array.isArray(kind)
      ? kind
      : typeof kind === 'string'
        ? kind.split(',')
        : view === 'board' || (view === undefined && kind === undefined)
          ? ['work_item', 'goal']
          : null;
    const kinds = raw?.map((entry) => entry.trim()).filter(Boolean) ?? null;
    return kinds && kinds.length > 0 ? kinds : null;
  }

  private matchesTaskKindFilter(
    task: { capability?: string | null; conversationId?: string | null; metadata: string },
    kinds: string[] | null,
    view?: TaskListQuery['view'],
  ): boolean {
    if (!kinds) return true;
    const meta = this.parseJson(task.metadata);
    const kind = this.taskKind(meta);
    if (kind && kinds.includes(kind)) return true;
    if (kind) return false;
    if (kinds.includes('goal') && meta.intent === 'standing_objective') return true;
    if (kinds.includes('agent_run') && this.isImplicitLegacyAgentRun(task, meta)) return true;
    if (view === 'board' && kinds.some((entry) => entry === 'work_item' || entry === 'goal')) {
      return !this.isImplicitLegacyAgentRun(task, meta);
    }
    return false;
  }

  private isImplicitLegacyAgentRun(
    task: { capability?: string | null; conversationId?: string | null; metadata?: string | null },
    meta: Record<string, unknown> = this.parseJson(task.metadata),
  ): boolean {
    if (this.taskKind(meta) === 'agent_run') return true;
    if (meta.triggerKind === 'mention' || typeof meta.triggerMessageId === 'string') return true;
    return task.capability === 'chat' && Boolean(task.conversationId);
  }

  private runAsDispatchTask(run: {
    id: string;
    status: string;
    capability?: string | null;
    runtimeRoute?: string | null;
    input?: string;
    metadata?: string;
    creatorId?: string;
    assigneeId?: string | null;
    conversationId?: string | null;
    triggerMessageId?: string | null;
  }) {
    const metadata = this.parseJson(run.metadata);
    return {
      id: run.id,
      title:
        typeof metadata.title === 'string'
          ? metadata.title
          : typeof metadata.parentTitle === 'string'
            ? metadata.parentTitle
            : `[run] ${run.id}`,
      status: run.status,
      capability: run.capability ?? null,
      runtimeRoute: run.runtimeRoute ?? 'agent',
      input: run.input,
      assigneeId: run.assigneeId ?? null,
      conversationId: run.conversationId ?? null,
      metadata: JSON.stringify({
        ...metadata,
        kind: 'agent_run',
        runId: run.id,
        triggerMessageId: run.triggerMessageId ?? metadata.triggerMessageId,
      }),
    };
  }

  private async checkRunReadAccess(
    run: {
      taskId?: string | null;
      creatorId?: string | null;
      assigneeId?: string | null;
      actorId?: string | null;
    },
    requesterId: string,
  ): Promise<void> {
    if (run.creatorId === requesterId || run.assigneeId === requesterId || run.actorId === requesterId) return;
    if (run.taskId) {
      const task = await this.taskModel.findById(run.taskId);
      if (!task) throw new TaskNotFoundError(run.taskId);
      this.checkReadAccess(task, requesterId);
      return;
    }
    throw new TaskAccessError(run.taskId ?? 'run', 'you do not have access to this run');
  }

  private toTaskRunInfo(record: {
    id: string;
    taskId: string | null;
    workspaceId?: string | null;
    conversationId?: string | null;
    triggerMessageId?: string | null;
    creatorId?: string | null;
    assigneeId?: string | null;
    actorId: string | null;
    sourceKind?: string | null;
    capability?: string | null;
    status: string;
    runtimeRoute: string | null;
    input: string;
    output: string | null;
    outputUri: string | null;
    error: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
    legacyTaskId?: string | null;
  }): TaskRunInfo {
    return {
      id: record.id,
      taskId: record.taskId,
      workspaceId: record.workspaceId ?? null,
      conversationId: record.conversationId ?? null,
      triggerMessageId: record.triggerMessageId ?? null,
      creatorId: record.creatorId ?? record.actorId ?? 'unknown',
      assigneeId: record.assigneeId ?? null,
      actorId: record.actorId,
      sourceKind: record.sourceKind ?? 'task',
      capability: record.capability ?? null,
      status: record.status,
      runtimeRoute: record.runtimeRoute,
      input: this.parseJson(record.input),
      output: this.parseJsonValue(record.output),
      outputUri: record.outputUri,
      error: record.error,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      metadata: this.parseJson(record.metadata),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      legacyTaskId: record.legacyTaskId ?? undefined,
      source: record.legacyTaskId ? 'legacy_task' : 'task_run',
    };
  }

  private toTaskEventInfo(record: {
    id: string;
    runId: string;
    taskId: string | null;
    workspaceId?: string | null;
    conversationId?: string | null;
    actorId: string | null;
    type: string;
    level: string;
    message: string | null;
    payload: string;
    createdAt: Date;
  }): TaskEventInfo {
    return {
      id: record.id,
      runId: record.runId,
      taskId: record.taskId,
      workspaceId: record.workspaceId ?? null,
      conversationId: record.conversationId ?? null,
      actorId: record.actorId,
      type: record.type,
      level: record.level,
      message: record.message,
      payload: this.parseJson(record.payload),
      createdAt: record.createdAt,
    };
  }

  private async listLegacyAgentRuns(
    query: {
      taskId?: string;
      actorId?: string;
      creatorId?: string;
      assigneeId?: string;
      status?: string;
      limit?: number;
    },
    requesterId: string,
    limit: number,
  ): Promise<TaskRunInfo[]> {
    if (limit <= 0) return [];
    const legacyTasks = await prisma.iMTask.findMany({
      where: {
        ...(query.taskId ? { metadata: { contains: query.taskId } } : { metadata: { contains: 'agent_run' } }),
        ...(query.actorId || query.creatorId || query.assigneeId
          ? {
              OR: [
                ...(query.actorId ? [{ creatorId: query.actorId }, { assigneeId: query.actorId }] : []),
                ...(query.creatorId ? [{ creatorId: query.creatorId }] : []),
                ...(query.assigneeId ? [{ assigneeId: query.assigneeId }] : []),
              ],
            }
          : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const visible = legacyTasks.filter((task: any) => {
      try {
        this.checkReadAccess(task, requesterId);
        return this.isLegacyAgentRunTask(task);
      } catch {
        return false;
      }
    });

    return visible.map((task: any) => {
      const meta = this.parseJson(task.metadata);
      return this.toTaskRunInfo({
        id: task.id,
        taskId: typeof meta.parentTaskId === 'string' ? meta.parentTaskId : task.id,
        workspaceId: task.workspaceId ?? null,
        conversationId: task.conversationId ?? null,
        triggerMessageId: typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : null,
        creatorId: task.creatorId,
        assigneeId: task.assigneeId,
        actorId: task.assigneeId ?? task.creatorId ?? null,
        sourceKind: typeof meta.triggerKind === 'string' ? meta.triggerKind : 'legacy_agent_run',
        capability: task.capability,
        status: task.status,
        runtimeRoute: task.runtimeRoute ?? 'agent',
        input: task.input,
        output: task.result,
        outputUri: task.resultUri,
        error: task.error,
        startedAt: task.lastRunAt ?? task.createdAt,
        completedAt: task.completedAt,
        metadata: task.metadata,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        legacyTaskId: task.id,
      });
    });
  }

  private async getLegacyAgentRun(
    runId: string,
    requesterId: string,
  ): Promise<{ run: TaskRunInfo; events: TaskEventInfo[] } | null> {
    const task = await prisma.iMTask.findUnique({ where: { id: runId } });
    if (!task || !this.isLegacyAgentRunTask(task)) return null;
    this.checkReadAccess(task, requesterId);
    const logs = await this.taskModel.getLogsByTaskId(task.id, 100);
    const meta = this.parseJson(task.metadata);
    const parentTaskId = typeof meta.parentTaskId === 'string' ? meta.parentTaskId : task.id;
    return {
      run: this.toTaskRunInfo({
        id: task.id,
        taskId: parentTaskId,
        workspaceId: task.workspaceId ?? null,
        conversationId: task.conversationId ?? null,
        triggerMessageId: typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : null,
        creatorId: task.creatorId,
        assigneeId: task.assigneeId,
        actorId: task.assigneeId ?? task.creatorId ?? null,
        sourceKind: typeof meta.triggerKind === 'string' ? meta.triggerKind : 'legacy_agent_run',
        capability: task.capability,
        status: task.status,
        runtimeRoute: task.runtimeRoute ?? 'agent',
        input: task.input,
        output: task.result,
        outputUri: task.resultUri,
        error: task.error,
        startedAt: task.lastRunAt ?? task.createdAt,
        completedAt: task.completedAt,
        metadata: task.metadata,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        legacyTaskId: task.id,
      }),
      events: logs.map((log: any) =>
        this.toTaskEventInfo({
          id: log.id,
          runId: task.id,
          taskId: parentTaskId,
          workspaceId: task.workspaceId ?? null,
          conversationId: task.conversationId ?? null,
          actorId: log.actorId,
          type: log.action,
          level: 'info',
          message: log.message,
          payload: log.metadata,
          createdAt: log.createdAt,
        }),
      ),
    };
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
    workspaceId?: string | null;
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
    const metadata = this.parseJson(record.metadata) as TaskMetadata;
    if (!this.taskKind(metadata)) {
      metadata.kind = this.inferTaskKind(record, metadata);
    }
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      capability: record.capability,
      input: this.parseJson(record.input),
      contextUri: record.contextUri,
      creatorId: record.creatorId,
      assigneeId: record.assigneeId,
      workspaceId: record.workspaceId ?? null,
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
      metadata,
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
