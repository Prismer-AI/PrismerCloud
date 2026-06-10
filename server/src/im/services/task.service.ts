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
import type { MessageEmitter } from './task-message-bridge';
import type { ConversationService } from './conversation.service';
import { TaskDigestService, type DigestStatus } from './task-digest.service';
import type { SyncService } from './sync.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import { buildTaskDispatchRequest } from '../ws/v19x-helpers';
import type { AssetRef } from '../types/im-events';
import prisma from '../db';
import { K8sSandboxError, k8sSandbox } from '../../lib/k8s-sandbox';
import { getDaemonImage } from '../../lib/sandbox/image-pin';
import { getK8sNamespace } from '../../lib/k8s-client';
import { calculateLLMCredits } from '../../lib/llm-pricing';
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
import { metricEmit } from './metric.service';
import {
  getTaskAcceptanceService,
  extractEvidenceAssetIds,
  AcceptanceError,
  type Criterion,
  type EvidenceRef,
  type EvidenceEntry,
} from './task-acceptance.service';
import { createModuleLogger } from '../../lib/logger';
import {
  loadTaskActor,
  resolveTaskMutationPermission,
  resolveDispatchPermission,
  isForceTransitionAllowed,
  isOrchestratorOf,
  TRANSITIONS,
  type TaskActionKind,
  type TaskRef,
  type PermissionResult,
  type SideEffect,
} from './task-permission';

const log = createModuleLogger('TaskService');
const DAEMON_ROUTE_PREFIX = 'daemon:';
const TASK_RETRYABLE_ERROR_CODES = new Set(['daemon_task_timeout', 'adapter_timeout', 'shell_timeout']);

type DaemonRouteResolution =
  | { kind: 'none' }
  | { kind: 'active'; daemonId: string; workspaceId: string | null }
  | { kind: 'forgotten'; daemonId: string; workspaceId: string };

type ProjectMembershipRole = 'owner' | 'contributor' | 'observer';
type ProjectEffectiveRole = ProjectMembershipRole | 'none';
type ProjectFilterShape = string | { in: string[] } | { isNull: true } | undefined;
type ProjectAccessRow = {
  id: string;
  workspaceId: string;
  status: string;
  ownerUserId: string;
};

function daemonRouteKey(daemonId: string): string {
  return `${DAEMON_ROUTE_PREFIX}${daemonId}`;
}

function daemonActorId(daemonId: string): string {
  return daemonRouteKey(daemonId).slice(0, 36);
}

/**
 * release201/09 §4.2 — parse `?projectId=` query value into a Prisma-friendly
 * filter shape.
 *
 *   - `undefined` / `''` / `'all'`      → undefined (no filter)
 *   - `'__unscoped'`                    → { isNull: true } (projectId IS NULL)
 *   - `'id1'`                           → 'id1' (exact match)
 *   - `'id1,id2,id3'`                   → { in: ['id1','id2','id3'] } (multi-select)
 *
 * Whitespace / empty items in CSV are trimmed silently. Mixed `'__unscoped'`
 * in a CSV is not supported (UI should send a single value when filtering
 * for unscoped); collapses to the first non-`__unscoped` id if present, or
 * to `{ isNull: true }` if `__unscoped` is the only one.
 */
function parseProjectIdFilter(raw: string | undefined): ProjectFilterShape {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') return undefined;
  if (trimmed === '__unscoped') return { isNull: true };
  if (!trimmed.includes(',')) return trimmed;
  const ids = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '__unscoped');
  if (ids.length === 0) return { isNull: true };
  if (ids.length === 1) return ids[0]!;
  return { in: ids };
}

function isProjectMembershipRole(role: unknown): role is ProjectMembershipRole {
  return role === 'owner' || role === 'contributor' || role === 'observer';
}

function canReadProjectRole(role: ProjectEffectiveRole): boolean {
  return role === 'owner' || role === 'contributor' || role === 'observer';
}

function canWriteProjectRole(role: ProjectEffectiveRole): boolean {
  return role === 'owner' || role === 'contributor';
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

/**
 * v2.0 release 200 §6.1 — structurally invalid transition (HTTP 409).
 *
 * Distinct from `TaskStateError` (legacy "wrong precondition" 409): this
 * carries the explicit `from`/`to`/`allowedFromHere` triple so the API
 * envelope can render an actionable error per spec.
 */
export class InvalidTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly allowedFromHere: string[];
  constructor(id: string, from: string, to: string, allowedFromHere: string[]) {
    super(
      `Invalid transition ${from} → ${to} for task ${id}. ` +
        (allowedFromHere.length > 0
          ? `Allowed from here: ${allowedFromHere.join(', ')}`
          : 'No transitions allowed from this state.'),
    );
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.allowedFromHere = allowedFromHere;
  }
}

/**
 * v2.0 release 200 §6.1 — actor lacks the required tier (HTTP 403).
 *
 * Like `TaskAccessError` but carries structured `actorTier`/`requiredTiers`
 * so the API envelope matches the spec:
 *   { code: 'forbidden', actorTier, requiredTiers }
 */
export class TaskForbiddenError extends Error {
  public readonly actorTier: string;
  public readonly requiredTiers: string[];
  constructor(id: string, actorTier: string, requiredTiers: string[], reason?: string) {
    super(
      reason ??
        `Actor (tier=${actorTier}) is not permitted to perform this action on task ${id}. ` +
          `Required tiers: ${requiredTiers.join(', ')}`,
    );
    this.name = 'TaskForbiddenError';
    this.actorTier = actorTier;
    this.requiredTiers = requiredTiers;
  }
}

export class OrchestratorRequiredError extends Error {
  constructor(id: string) {
    super(
      `Task ${id} requires orchestrator authority. Use an agent profile with taskAuthority=orchestrator in this workspace, or ask the task creator/admin to perform this action.`,
    );
    this.name = 'OrchestratorRequiredError';
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
  messageService: MessageEmitter;
  conversationService: ConversationService;
  syncService?: SyncService;
  evolutionService?: EvolutionService;
  eventBusService?: EventBusService;
  creditService?: CreditService;
  /**
   * release201/08 §10.6 / S21 — optional skill-lifecycle hook. When the
   * caller of completeTask completes a task with `capability='skill-tryout'`,
   * TaskService fans out `skill.authoring.sample_task_completed` through
   * this service. Wiring is optional so unit tests that don't exercise the
   * skill sub-system continue to work.
   */
  skillLifecycleService?: import('./skill-lifecycle.service').SkillLifecycleService;
}

function parseMetadataObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 2026-05-22 — outbox asset rollup at task completion.
 *
 * The asset upload endpoint (POST /api/im/assets/) appends every newly
 * created assetId to `task.metadata.outputAssetIds` whenever it can resolve
 * a `sourceTaskId`. On completion this helper folds that list into the
 * canonical `task.result.assetIds` shape so downstream readers (mobile,
 * search, external webhooks) can list a task's deliverables off the result
 * payload alone — no separate IMAsset query needed.
 *
 * Idempotent: if `result` already carries `assetIds`, the union is taken
 * (preserves agent-supplied IDs that aren't in outbox). Returns `undefined`
 * to signal "no result to write" so the caller can pass NULL through.
 */
function safeParseJsonInline(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // treat as plain text if not JSON
  }
}

function mergeResultWithOutputAssetIds(inputResult: unknown, taskMetadata: Record<string, unknown>): unknown {
  const outputAssetIds = Array.isArray(taskMetadata.outputAssetIds)
    ? (taskMetadata.outputAssetIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (outputAssetIds.length === 0) {
    return inputResult === undefined ? undefined : inputResult;
  }

  // Result may be a string, primitive, array, object, or undefined.
  // Only an object shape can carry the `assetIds` projection without
  // losing the original payload. For non-object results (string output,
  // numbers, arrays) we wrap into `{ output, assetIds }` — same shape
  // mobile already reads via `task.result.assetIds`.
  if (inputResult !== null && typeof inputResult === 'object' && !Array.isArray(inputResult)) {
    const existing = inputResult as Record<string, unknown>;
    const existingIds = Array.isArray(existing.assetIds)
      ? (existing.assetIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    const merged = Array.from(new Set([...existingIds, ...outputAssetIds]));
    return { ...existing, assetIds: merged };
  }
  if (inputResult === undefined || inputResult === null) {
    return { assetIds: outputAssetIds };
  }
  return { output: inputResult, assetIds: outputAssetIds };
}

/**
 * B-line — coerce an unknown array-ish value into a deduped, non-empty
 * string-id list. Shared by both completion-asset extractors below.
 */
function coerceAssetIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}

/**
 * B-line — extract the deliverable asset IDs from a (possibly merged) result
 * payload. Only object-shaped results carry `assetIds` (see
 * `mergeResultWithOutputAssetIds`); everything else has none. Used to seed the
 * digest's `resultAssetCount` chip at completion — does NOT mirror `output`
 * into an IMAsset (Wave-9 dropped that).
 */
function extractResultAssetIds(result: unknown): string[] {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return coerceAssetIdList((result as Record<string, unknown>).assetIds);
  }
  return [];
}

/**
 * B-line — extract deliverable asset IDs from `metadata.outputAssetIds`.
 * `metadata` may be the raw JSON string (DB column) or an already-parsed
 * object; both are accepted so callers don't double-parse.
 */
function extractMetadataAssetIds(metadata: string | Record<string, unknown> | null | undefined): string[] {
  if (metadata == null) return [];
  let obj: Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return [];
    }
  } else {
    obj = metadata;
  }
  return coerceAssetIdList(obj.outputAssetIds);
}

/**
 * B-line — single source of truth for "the deliverable asset IDs surfaced on
 * the completion digest". Unions the result projection (`result.assetIds`) and
 * the outbox rollup (`metadata.outputAssetIds`), deduped + empty-filtered.
 * Callers supply whichever inputs they hold:
 *   - complete*: `{ result: mergedResult }` (metadata already folded in)
 *   - record-completion: `{ metadata: ctx.task.metadata }`
 *   - forceTransition: `{ metadata: updated.metadata }`
 */
function extractCompletionAssetIds(input: {
  result?: unknown;
  metadata?: string | Record<string, unknown> | null;
}): string[] {
  const fromResult = input.result === undefined ? [] : extractResultAssetIds(input.result);
  const fromMetadata = extractMetadataAssetIds(input.metadata ?? null);
  return Array.from(new Set([...fromResult, ...fromMetadata]));
}

function readCeoCanDispatch(metadata: string | null | undefined): boolean {
  const node = parseMetadataObject(metadata).ceoPermissions;
  return Boolean(
    node && typeof node === 'object' && !Array.isArray(node) && (node as Record<string, unknown>).canDispatch === true,
  );
}

async function hasHumanCeoDispatchAuthorization(actorId: string, workspaceId: string | null): Promise<boolean> {
  const actor = await prisma.iMUser.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, userId: true, metadata: true },
  });
  if (!actor) return false;
  if (actor.role !== 'agent') return true;

  if (actor.userId) {
    const owner = await prisma.iMUser.findFirst({
      where: { role: 'human', userId: actor.userId },
      select: { metadata: true },
    });
    if (readCeoCanDispatch(owner?.metadata)) return true;
  }

  if (workspaceId) {
    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (workspace?.ownerImUserId) {
      const owner = await prisma.iMUser.findUnique({
        where: { id: workspace.ownerImUserId },
        select: { metadata: true },
      });
      if (readCeoCanDispatch(owner?.metadata)) return true;
    }
  }

  return false;
}

/**
 * Check if the actor has orchestrator authority (or is the creator) for a task.
 *
 * Authority hierarchy — v2.0 release 200 §4 + 30-acp §3.2 (fallback):
 * 1. Admin (role='admin' or trustTier >= 4) — always passes
 * 2. Human creator / human workspace owner — always passes
 * 3. **NEW (v2.0 §4.2):** `workspace.orchestratorAgentId === actorId` and
 *    `orchestratorRevokedAt IS NULL` — passes (the authoritative source).
 * 4. **Fallback (legacy 30-acp, retained 3 sprints):** Orchestrator agent in
 *    the task's workspace — passes when `config.taskAuthority === 'orchestrator'`
 *    AND the human owner enabled `/settings` CEO canDispatch authorization.
 * 5. Otherwise — returns false.
 *
 * Callers (kept stable across the P2 refactor): updateTask, approveTask,
 * rejectTask, cancelTask, forceExecutionStatus. The new
 * `resolveTaskMutationPermission` in `task-permission.ts` shares the same
 * workspace-field path via the exported `isOrchestratorOf` helper.
 */
export async function hasTaskOrchestratorAuthority(
  taskId: string,
  actorId: string,
  creatorId: string,
): Promise<boolean> {
  // Admin always passes
  const user = await prisma.iMUser.findUnique({ where: { id: actorId } });
  if (user?.role === 'admin' || (user?.trustTier ?? 0) >= 4) return true;

  // Human creator always passes. Agent creators act as delegated operators,
  // so they must still be backed by the human-owned /settings authorization.
  if (actorId === creatorId && user?.role !== 'agent') return true;

  // Human owner/admin in the same workspace passes.
  const task = await prisma.iMTask.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
  if (!task?.workspaceId) return false;

  if (user?.role !== 'agent') {
    const workspaceAccess = await prisma.iMWorkspace.findFirst({
      where: {
        id: task.workspaceId,
        deletedAt: null,
        OR: [
          { ownerImUserId: actorId },
          { members: { some: { memberImUserId: actorId, role: { in: ['owner', 'admin'] } } } },
        ],
      },
      select: { id: true },
    });
    if (workspaceAccess) return true;
  }

  // v2.0 release 200 §4.2 primary path: workspace.orchestratorAgentId.
  // The legacy-fallback flag preserves the 30-acp behavior (agent profile
  // taskAuthority='orchestrator' + owner ceoPermissions.canDispatch=true)
  // for the 3-sprint transition window after release 200.
  const { isOrchestratorOf } = await import('./task-permission');
  return isOrchestratorOf(task.workspaceId, actorId, { includeLegacyFallback: true });
}

export class TaskService {
  private taskModel = new TaskModel();
  private deps: TaskServiceDeps;
  /**
   * P9 — single rolling digest message per task within its conversation.
   * Lazy so tests can stub the messageService dep without wiring digest
   * explicitly; constructed once per TaskService instance.
   */
  private _taskDigestService: TaskDigestService | null = null;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  /**
   * Lazy-initialised TaskDigestService — bound to the same messageService
   * already in `deps`. Tests that override `emitTaskStatusChat` directly do
   * not pay any cost; production callers reuse a single instance.
   */
  protected get taskDigestService(): TaskDigestService {
    if (!this._taskDigestService) {
      this._taskDigestService = new TaskDigestService({
        messageService: this.deps.messageService,
      });
    }
    return this._taskDigestService;
  }

  // ═══════════════════════════════════════════════════════════
  // Permission gate (v2.0 release 200 §3 + §5)
  // ═══════════════════════════════════════════════════════════

  /**
   * Resolve a mutation permission decision for the given actor + task.
   * The 6 release-200-§11 gates (updateTask access check, assign /
   * edit-content / transition / metadata edit, approve / reject / cancel)
   * all route through this helper instead of inline `isCreator`/`isAssignee`
   * chains.
   *
   * Returns the decision (allow/deny) so the caller can layer additional
   * structural checks (e.g. "must have assigneeId before running") between
   * the permission gate and the actual mutation.
   */
  private async gateMutation(
    task: { id: string; creatorId: string; assigneeId: string | null; workspaceId: string | null; status: string },
    actorId: string,
    action: TaskActionKind,
  ): Promise<PermissionResult> {
    const workspaceId = task.workspaceId ?? '';
    const actor = await loadTaskActor(actorId, workspaceId);
    if (!actor) {
      return {
        allow: false,
        reason: 'actor not found',
        requiredTiers: ['owner', 'admin', 'orchestrator', 'creator'],
      };
    }
    const taskRef: TaskRef = {
      id: task.id,
      creatorId: task.creatorId,
      assigneeId: task.assigneeId,
      workspaceId,
      status: task.status as TaskStatus,
    };
    return resolveTaskMutationPermission(actor, taskRef, action);
  }

  /**
   * Translate a deny decision into the existing error classes so the API
   * surface and integration tests don't shift.
   *
   * `defaultError='orchestrator'` throws OrchestratorRequiredError (used by
   * approve / reject / cancel / force-style gates). `defaultError='access'`
   * throws TaskAccessError (used by edit-content / assign gates).
   */
  private requirePermission(
    decision: PermissionResult,
    taskId: string,
    opts: { defaultError: 'orchestrator' | 'access'; accessReason?: string },
  ): void {
    if (decision.allow) return;
    if (opts.defaultError === 'orchestrator') {
      throw new OrchestratorRequiredError(taskId);
    }
    throw new TaskAccessError(taskId, opts.accessReason ?? decision.reason);
  }

  /**
   * release201/09 §5 — resolve the actor's effective role inside a project.
   *
   * Workspace owner is implicit owner. Otherwise humans use
   * principalKind='user' and agent IM users use principalKind='agent'.
   */
  private async getProjectEffectiveRole(project: ProjectAccessRow, actorId: string): Promise<ProjectEffectiveRole> {
    if (project.ownerUserId === actorId) return 'owner';

    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: project.workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (workspace?.ownerImUserId === actorId) return 'owner';

    const actor = await prisma.iMUser.findUnique({
      where: { id: actorId },
      select: { role: true },
    });
    const principalKind = actor?.role === 'agent' ? 'agent' : 'user';
    const row = await prisma.iMAgentProjectMembership.findUnique({
      where: {
        projectId_principalKind_principalId: {
          projectId: project.id,
          principalKind,
          principalId: actorId,
        },
      },
      select: { role: true },
    });
    return row && isProjectMembershipRole(row.role) ? row.role : 'none';
  }

  private async loadProjectForTaskScope(projectId: string, taskIdForError: string): Promise<ProjectAccessRow> {
    const project = await prisma.iMProject.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true, status: true, ownerUserId: true },
    });
    if (!project) {
      throw new TaskAccessError(taskIdForError, `project ${projectId} not found`);
    }
    return project;
  }

  private async validateProjectWriteScope(
    projectId: string,
    workspaceId: string,
    actorId: string,
    taskIdForError: string,
  ): Promise<string> {
    const project = await this.loadProjectForTaskScope(projectId, taskIdForError);
    if (project.workspaceId !== workspaceId) {
      throw new TaskAccessError(taskIdForError, 'project does not belong to this workspace');
    }
    if (project.status !== 'active') {
      throw new TaskAccessError(taskIdForError, 'cannot scope task to an archived project');
    }
    const role = await this.getProjectEffectiveRole(project, actorId);
    if (!canWriteProjectRole(role)) {
      throw new TaskAccessError(taskIdForError, 'project membership must be owner or contributor');
    }
    return project.id;
  }

  private async filterReadableProjectIds(
    projectIds: string[],
    requesterId: string | undefined,
    workspaceId: string | undefined,
  ): Promise<string[]> {
    const uniqueIds = Array.from(new Set(projectIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) return [];
    if (!requesterId) return uniqueIds;

    const readable: string[] = [];
    for (const projectId of uniqueIds) {
      const project = await prisma.iMProject.findUnique({
        where: { id: projectId },
        select: { id: true, workspaceId: true, status: true, ownerUserId: true },
      });
      if (!project) continue;
      if (workspaceId && project.workspaceId !== workspaceId) continue;
      const role = await this.getProjectEffectiveRole(project, requesterId);
      if (canReadProjectRole(role)) readable.push(project.id);
    }
    return readable;
  }

  private async applyProjectReadAccess(
    filter: ProjectFilterShape,
    requesterId: string | undefined,
    workspaceId: string | undefined,
  ): Promise<ProjectFilterShape | null> {
    if (!filter || (typeof filter === 'object' && 'isNull' in filter)) return filter;
    if (typeof filter === 'string') {
      const readable = await this.filterReadableProjectIds([filter], requesterId, workspaceId);
      return readable.length === 1 ? readable[0]! : null;
    }
    const readable = await this.filterReadableProjectIds(filter.in, requesterId, workspaceId);
    if (readable.length === 0) return null;
    if (readable.length === 1) return readable[0]!;
    return { in: readable };
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
    // release201/19 B1 — cross-workspace boundary gate.
    //
    // Before any side-effect (escrow / write / project validation), confirm
    // the caller is a member of the target workspace. Without this gate,
    // ws1.owner could POST /tasks { workspaceId: ws2.id } and the task would
    // land in ws2 (doc 16 §3.3.4 NOT_WORKSPACE_MEMBER). The projectId branch
    // already enforces membership via validateProjectWriteScope; the bare
    // workspaceId path was the open hole.
    //
    // Membership lookup uses prisma directly to avoid pulling in the full
    // WorkspaceMemberService (which carries ContactService deps). Owner is
    // covered because M444 backfill writes owner into iMWorkspaceMember.
    if (input.workspaceId) {
      const membership = await prisma.iMWorkspaceMember.findUnique({
        where: {
          workspaceId_memberImUserId: {
            workspaceId: input.workspaceId,
            memberImUserId: creatorId,
          },
        },
        select: { id: true },
      });
      if (!membership) {
        // release202/08 E2 — an active orchestrator agent has workspace-scoped
        // task authority (its job is to create+assign tasks) even though it is
        // not an `im_workspace_members` row. The rest of the permission system
        // (transition/assign via resolveDispatchPermission) already honours
        // `isOrchestratorOf`; the createTask membership gate was the one path
        // that didn't, blocking the orchestrator dispatch entry point.
        const orchestratorOk = await isOrchestratorOf(input.workspaceId, creatorId, {
          includeLegacyFallback: true,
        });
        if (!orchestratorOk) {
          throw new TaskAccessError(
            'new_task',
            `actor is not a member of workspace ${input.workspaceId} (NOT_WORKSPACE_MEMBER)`,
          );
        }
      }
    }

    // Resolve "self" assignee
    const assigneeId = input.assigneeId === 'self' ? creatorId : input.assigneeId;

    // release202/08 §3.2/§3.4 — config-driven dispatch gate.
    //
    // The initial assignee of a create goes through the SAME resolver as a
    // PATCH `assign` action (no-bypass invariant): a member who can't assign
    // to a human can't create+assign one to a human either. Scope is resolved
    // role-agnostically (workspace policy > role/profile config >
    // DEFAULT_DISPATCH_POLICY). Gated only when scoped to a workspace; bare
    // personal tasks (no workspaceId) keep the pre-existing behaviour.
    if (input.workspaceId) {
      const dispatchActor = await loadTaskActor(creatorId, input.workspaceId);
      if (dispatchActor) {
        const decision = await resolveDispatchPermission(
          dispatchActor,
          input.workspaceId,
          assigneeId,
        );
        if (!decision.allow) {
          const actorTier =
            dispatchActor.type === 'agent'
              ? 'executor'
              : (dispatchActor.role ?? 'observer');
          throw new TaskForbiddenError(
            'new_task',
            actorTier,
            decision.requiredTiers,
            decision.reason,
          );
        }
      }
    }

    if (assigneeId && assigneeId !== creatorId) {
      const creator = await prisma.iMUser.findUnique({
        where: { id: creatorId },
        select: { role: true },
      });
      if (
        creator?.role === 'agent' &&
        !(await hasHumanCeoDispatchAuthorization(creatorId, input.workspaceId ?? null))
      ) {
        throw new TaskAccessError(
          'new_task',
          'agent dispatch requires the human owner to enable CEO dispatch authorization in Settings',
        );
      }
    }

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

    // Shell tasks (runtimeRoute='shell' from device terminal panel) must NOT
    // be classified as 'work_item' — otherwise they leak onto the Kanban
    // board (which queries kind=work_item,goal). User-reported 2026-05-19:
    // typing `ls` in device terminal created a card on the board. Force
    // metadata.kind='shell_run' so the board's kind filter excludes them;
    // they remain queryable via runtimeRoute='shell' or capability='shell'
    // for the terminal panel's own task list.
    const metadataIn =
      input.runtimeRoute === 'shell' || input.capability === 'shell'
        ? { ...(input.metadata ?? {}), kind: 'shell_run' }
        : input.metadata;
    const metadata = this.normalizeCreatedTaskMetadata(metadataIn);
    let task;
    try {
      // release201/09 §4.1 + §5 — validate projectId if specified. Must be a
      // real, active project in the same workspace; actor must be workspace
      // owner or project owner/contributor. Observer is read-only.
      let validatedProjectId: string | null | undefined = undefined;
      if (input.projectId !== undefined && input.projectId !== null) {
        if (!input.workspaceId) {
          throw new TaskAccessError('', 'workspaceId required when projectId is specified');
        }
        validatedProjectId = await this.validateProjectWriteScope(
          input.projectId,
          input.workspaceId,
          creatorId,
          'new_task',
        );
      } else if (input.projectId === null) {
        validatedProjectId = null;
      }

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
        projectId: validatedProjectId,
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

    // release201/11 §4 #1 — emit task.created metric.
    metricEmit({
      namespace: 'task',
      name: 'created',
      value: 1,
      dims: {
        workspaceId: task.workspaceId ?? '',
        taskId: task.id,
        capability: task.capability ?? 'general',
        creatorId,
        assigneeId: assigneeId ?? undefined,
      },
    });

    // release201/10 §5.3 — auto-apply default criteria template by
    // capability. UI flow that hand-fills criteria sends `metadata.skipAcceptanceTemplate=true`
    // to opt out; the default path is silent best-effort.
    const skipTpl = (metadata as Record<string, unknown> | undefined)?.skipAcceptanceTemplate === true;
    if (!skipTpl) {
      void getTaskAcceptanceService({ eventBusService: this.deps.eventBusService })
        .applyDefaultTemplateOnCreate(task.id, task.capability, task.workspaceId, creatorId)
        .then((r) => {
          if (r.applied) {
            log.info(`Task ${task.id}: applied default criteria template ${r.templateId}`);
          }
        })
        .catch((err) => {
          log.warn(`applyDefaultTemplateOnCreate failed for ${task.id}: ${(err as Error).message}`);
        });
    }

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
      await this.checkTaskReadAccess(task, requesterId);
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
    await this.checkTaskReadAccess(task, requesterId);
    // Materialized result assets (markdown auto-mirror, drop-folder, etc.) are
    // recorded on `metadata.outputAssetIds` by the materializer — they are NOT
    // written back into `result.assetIds`. Union them here so GET /tasks/:id/result
    // reflects every deliverable asset, not just the ones attached at completion.
    const metaObj = parseMetadataObject(task.metadata);
    const outputAssetIds = Array.isArray(metaObj.outputAssetIds)
      ? (metaObj.outputAssetIds.filter((v): v is string => typeof v === 'string' && v.length > 0) as string[])
      : [];
    return this.shapeTaskResult(
      {
        id: task.id,
        status: task.status,
        result: task.result,
        resultUri: task.resultUri ?? null,
        completedAt: task.completedAt ?? task.updatedAt ?? new Date(),
      },
      outputAssetIds,
    );
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
  private shapeTaskResult(
    input: {
      id: string;
      status: string;
      result: string | null;
      resultUri: string | null;
      completedAt: Date;
    },
    extraAssetIds: string[] = [],
  ): {
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
    const baseAssetIds = Array.isArray(obj.assetIds)
      ? (obj.assetIds.filter((v): v is string => typeof v === 'string' && v.length > 0) as string[])
      : [];
    const assetIds = Array.from(new Set([...baseAssetIds, ...extraAssetIds]));
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
    runs: TaskRunInfo[];
    runEvents: TaskEventInfo[];
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
      await this.checkTaskReadAccess(task, requesterId);
    }

    const [logs, subtasks, directRuns] = await Promise.all([
      this.taskModel.getLogsByTaskId(id),
      this.taskModel.findByParentTaskId(id),
      prisma.iMTaskRun.findMany({
        where: {
          ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
          taskId: id,
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ]);
    const seenRunIds = new Set<string>();
    const runs = directRuns.filter((run: any) => {
      if (seenRunIds.has(run.id)) return false;
      seenRunIds.add(run.id);
      return true;
    });
    const runIds = runs.map((run: { id: string }) => run.id);
    const runEvents =
      runIds.length > 0
        ? await prisma.iMTaskEvent.findMany({
            where: { runId: { in: runIds } },
            orderBy: { createdAt: 'asc' },
            take: 300,
          })
        : [];
    const completed = subtasks.filter((t: any) => t.status === 'completed').length;
    const failed = subtasks.filter((t: any) => t.status === 'failed').length;
    const pending = subtasks.filter((t: any) => t.status === 'pending').length;
    const running = subtasks.filter((t: any) => ['assigned', 'running', 'in_progress'].includes(t.status)).length;

    return {
      task: this.toTaskInfo(task),
      logs: logs.map((l: any) => this.toLogEntry(l)),
      subtasks: subtasks.map((t: any) => this.toTaskInfo(t)),
      runs: runs.map((run: any) => this.toTaskRunInfo(run)),
      runEvents: runEvents.map((event: any) => this.toTaskEventInfo(event)),
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
    task: { id?: string; creatorId: string; assigneeId: string | null; status: string },
    requesterId: string,
  ): void {
    if (task.creatorId === requesterId) return;
    if (task.assigneeId === requesterId) return;
    if (task.status === 'pending' && !task.assigneeId) return; // marketplace visibility
    throw new TaskAccessError(task.id ?? task.creatorId, 'you do not have access to this task');
  }

  private async canAccessWorkspace(workspaceId: string | null | undefined, requesterId: string): Promise<boolean> {
    if (!workspaceId) return false;
    const workspace = await prisma.iMWorkspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        OR: [{ ownerImUserId: requesterId }, { members: { some: { memberImUserId: requesterId } } }],
      },
      select: { id: true },
    });
    return Boolean(workspace);
  }

  private async checkTaskReadAccess(
    task: { id: string; creatorId: string; assigneeId: string | null; status: string; workspaceId?: string | null },
    requesterId: string,
  ): Promise<void> {
    if (task.creatorId === requesterId) return;
    if (task.assigneeId === requesterId) return;
    // Workspaced task: read is gated on workspace membership. Members may see
    // the whole board — cards assigned to other roles AND unclaimed marketplace
    // cards (acting on a card that isn't yours is blocked by the mutation gates,
    // not here). Non-members — including agents from OTHER workspaces — are
    // denied even for pending+unassigned cards. This closes the cross-tenant
    // marketplace read leak: previously `checkReadAccess` returned success for
    // ANY pending+unassigned task globally, before any workspace check ran.
    if (task.workspaceId) {
      if (await this.canAccessWorkspace(task.workspaceId, requesterId)) return;
      throw new TaskAccessError(task.id, 'you do not have access to this task');
    }
    // Legacy workspace-less task — defer to the sync marketplace rule
    // (creator / assignee / globally-visible pending+unassigned).
    this.checkReadAccess(task, requesterId);
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
    // 2026-05-22 — Bump the hard cap from 100 → 500 so the workspace UI's
    // busy-state poller (`useAgentBusyState`, which now fetches
    // `?limit=200`) can actually see all in-flight tasks in a busy
    // workspace (50+ concurrent agents). Default is still 20 when the
    // client doesn't specify. When the optional `kind` filter is set we
    // need a larger pre-filter page so the in-memory `.filter()` doesn't
    // accidentally drop tasks the client asked for — match the new ceiling.
    const HARD_LIMIT = 500;
    const projectFilter = await this.applyProjectReadAccess(
      parseProjectIdFilter(query.projectId),
      query.requesterId,
      query.workspaceId,
    );
    if (projectFilter === null) {
      return [];
    }
    const tasks = await this.taskModel.list({
      status: query.status,
      capability: query.capability,
      assigneeId: query.assigneeId,
      creatorId: query.creatorId,
      workspaceId: query.workspaceId,
      conversationId: query.conversationId,
      scheduleType: query.scheduleType,
      // release201/09 §4.2 — parse the ?projectId= query string into the
      // model's filter shape. Phase 2 behavior:
      //   - `''` / `undefined` / `'all'` → no filter
      //   - `'__unscoped'`               → IS NULL
      //   - `'id1'`                       → exact
      //   - `'id1,id2,id3'`               → IN list
      projectId: projectFilter,
      limit: kinds ? HARD_LIMIT : query.limit,
      cursor: query.cursor,
    });
    return tasks
      .filter((task: any) => this.matchesTaskKindFilter(task, kinds, query.view))
      .slice(0, Math.min(requestedLimit ?? 20, HARD_LIMIT))
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
    if (task) await this.checkTaskReadAccess(task, actorId);

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
      if (!visible && run.workspaceId) {
        visible = await this.canAccessWorkspace(run.workspaceId, requesterId);
      }
      if (!visible && run.taskId) {
        visible = taskAccess.get(run.taskId) ?? false;
      }
      if (!visible && run.taskId && !taskAccess.has(run.taskId)) {
        const task = await this.taskModel.findById(run.taskId);
        visible = Boolean(task);
        if (task) {
          try {
            await this.checkTaskReadAccess(task, requesterId);
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

    // release201/26 Phase 3 — TaskTrace L2 segment (fire-and-forget).
    // On a COMPLETED run with a conversation, distil this run's IMTaskRunStep
    // sequence into a `segmentKind='task_trace'` L2 segment so the next
    // buildEnvelope can surface `recentTaskTrace`. §10: writes L2 ONLY (never an
    // IMMessage → signing chain untouched); NEVER throws / blocks completion.
    if (updates.status === 'completed' && updated.conversationId) {
      // Derive a plain-text final output from the persisted run row (the
      // block above's `outputText` is scoped to the SSE branch). `updated.output`
      // is a JSON string column ({output?: string} | raw).
      let finalOutput: string | null = null;
      if (typeof updated.output === 'string' && updated.output) {
        try {
          const parsed = JSON.parse(updated.output) as { output?: unknown };
          finalOutput =
            typeof parsed?.output === 'string' ? parsed.output : updated.output;
        } catch {
          finalOutput = updated.output;
        }
      }
      import('./conversation-task-trace.service')
        .then(({ conversationTaskTraceService }) =>
          conversationTaskTraceService.writeTaskTrace({
            taskRunId: updated.id,
            taskId: updated.taskId ?? null,
            conversationId: updated.conversationId ?? null,
            triggerMessageId: updated.triggerMessageId ?? null,
            finalOutput,
          }),
        )
        .catch((err) =>
          log.warn(`task_trace write error (non-blocking) for run ${updated.id}: ${(err as Error).message}`),
        );
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

  async applyApprovalDecisionAndRedispatch(taskOrRunId: string, decision: Record<string, unknown>): Promise<void> {
    const task = await this.taskModel.findById(taskOrRunId);
    if (task) {
      const metadata = this.parseJson(task.metadata);
      const updated = await this.taskModel.update(task.id, {
        metadata: JSON.stringify({ ...metadata, acpApprovalDecision: decision }),
      });
      if (updated?.assigneeId) {
        await this.emitDaemonDispatchRequest(updated.assigneeId, updated, 'approval.decided');
      }
      return;
    }

    const run = await this.taskModel.findRunById(taskOrRunId);
    if (!run) return;
    const metadata = this.parseJson(run.metadata);
    const updated = await prisma.iMTaskRun.update({
      where: { id: run.id },
      data: { metadata: JSON.stringify({ ...metadata, acpApprovalDecision: decision }) },
    });
    if (updated.assigneeId) {
      await this.emitDaemonDispatchRequest(updated.assigneeId, this.runAsDispatchTask(updated), 'approval.decided');
    }
  }

  async dispatchApprovalDecisionToAgent(agentImUserId: string, decision: Record<string, unknown>): Promise<void> {
    const approvalId = typeof decision.approvalId === 'string' ? decision.approvalId : crypto.randomUUID();
    const title = typeof decision.title === 'string' ? decision.title : 'Approval decision';
    const selected =
      typeof decision.selectedValue === 'string' ? decision.selectedValue : String(decision.status ?? 'decided');
    const comment =
      typeof decision.comment === 'string' && decision.comment.trim() ? `\nReason: ${decision.comment.trim()}` : '';
    await this.emitDaemonDispatchRequest(
      agentImUserId,
      {
        id: approvalId,
        title: `Approval decision: ${title}`,
        description: `[Approval decision]\nYour earlier request "${title}" was decided: ${selected}.${comment}`,
        status: 'assigned',
        assigneeId: agentImUserId,
        creatorId: typeof decision.decidedById === 'string' ? decision.decidedById : null,
        conversationId: typeof decision.conversationId === 'string' ? decision.conversationId : null,
        workspaceId: typeof decision.workspaceId === 'string' ? decision.workspaceId : null,
        metadata: JSON.stringify({ kind: 'approval_decision', acpApprovalDecision: decision }),
        runtimeRoute: 'agent',
      },
      'approval.decided',
    );
  }

  async fanOutApprovalBellSync(imUserId: string | null, data: Record<string, unknown>): Promise<void> {
    await this.fanOutBellSync(imUserId, 'approval.requested', data);
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
    const taskMeta = this.parseJson(task.metadata);
    const isProjectionTask = this.isProjectionTaskKind(this.taskKind(taskMeta));
    const isAssignmentOnly =
      updates.assigneeId !== undefined &&
      updates.title === undefined &&
      updates.description === undefined &&
      updates.progress === undefined &&
      updates.statusMessage === undefined &&
      updates.status === undefined &&
      !updates.metadata &&
      !updates.forceExecutionStatus;
    const isExecutionControlOnly =
      updates.status !== undefined &&
      ['pending', 'running', 'review', 'completed'].includes(updates.status) &&
      updates.progress === undefined &&
      updates.title === undefined &&
      updates.description === undefined &&
      updates.assigneeId === undefined &&
      !updates.metadata;

    if (!isCreator && !isAssignee) {
      // Two-tier auth (v2.0 §3):
      //   Tier 1 (WHO): hasTaskOrchestratorAuthority — admin / trustTier≥4 /
      //     creator / human workspace owner|admin / orchestrator-agent (via
      //     workspace.orchestratorAgentId or legacy 30-acp fallback).
      //   Tier 2 (WHAT): shape constraint applies ONLY to agent actors.
      //     Human operators (workspace owner/admin) get full PATCH rights —
      //     dragging a kanban card spreads existing metadata in the payload,
      //     which the legacy `isExecutionControlOnly` short-circuit rejected.
      if (!(await hasTaskOrchestratorAuthority(id, actorId, task.creatorId))) {
        throw new TaskAccessError(id, 'only the task creator or assignee can update this task');
      }
      const actor = await prisma.iMUser.findUnique({
        where: { id: actorId },
        select: { role: true },
      });
      if (actor?.role === 'agent') {
        if (!isAssignmentOnly && !isExecutionControlOnly) {
          throw new TaskAccessError(
            id,
            'orchestrator agents can only assign or change execution status (no content edits)',
          );
        }
      }
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

    // Gate #2 (v2.0 §3): editing title/description/assigneeId.
    //   - title/description → edit-content (creator OR orchestrator OR admin)
    //   - assigneeId-only   → assign (creator OR orchestrator OR admin)
    //   - both              → split: each field is gated by its own action
    //
    // Note: v2.0 spec §3.2 grants orchestrators write access to title/desc
    // (they act as the human's deputy). The pre-refactor behavior limited
    // orchestrators to assigneeId only; we widen here per spec.
    if (updates.title !== undefined || updates.description !== undefined || updates.assigneeId !== undefined) {
      if (!isCreator) {
        const wantsContentEdit = updates.title !== undefined || updates.description !== undefined;
        const wantsAssign = updates.assigneeId !== undefined;
        if (wantsContentEdit) {
          const editDecision = await this.gateMutation(task, actorId, { kind: 'edit-content' });
          this.requirePermission(editDecision, id, {
            defaultError: 'access',
            accessReason: 'only the task creator can update title, description, or assignee',
          });
        }
        if (wantsAssign) {
          const assignDecision = await this.gateMutation(task, actorId, { kind: 'assign' });
          this.requirePermission(assignDecision, id, { defaultError: 'orchestrator' });
        }
      }
      // release202/08 §3.4 no-bypass: an `assign` that sets a *new* assignee
      // must clear the SAME dispatch-scope gate as create (so you can't build
      // an unassigned task then PATCH-assign a human you couldn't dispatch to
      // at create time). Runs for ALL actors (incl. creator) when a non-null
      // assignee is being set on a workspace-scoped task.
      if (
        updates.assigneeId !== undefined &&
        updates.assigneeId !== null &&
        task.workspaceId
      ) {
        const dispatchActor = await loadTaskActor(actorId, task.workspaceId);
        if (dispatchActor) {
          const dispatchDecision = await resolveDispatchPermission(
            dispatchActor,
            task.workspaceId,
            updates.assigneeId,
          );
          if (!dispatchDecision.allow) {
            const actorTier =
              dispatchActor.type === 'agent'
                ? 'executor'
                : (dispatchActor.role ?? 'observer');
            throw new TaskForbiddenError(
              id,
              actorTier,
              dispatchDecision.requiredTiers,
              dispatchDecision.reason,
            );
          }
        }
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

    // Gate #3 (cancel): per TRANSITIONS, allowed actors are
    // owner/admin/orchestrator/creator from any non-terminal status.
    // The legacy gate was creator-only; the resolver broadens to
    // orchestrator/admin/owner per v2.0 spec.
    if (updates.status === 'cancelled') {
      const cancelDecision = await this.gateMutation(task, actorId, {
        kind: 'transition',
        from: task.status as TaskStatus,
        to: 'cancelled' as TaskStatus,
      });
      this.requirePermission(cancelDecision, id, {
        defaultError: 'access',
        accessReason: 'only the task creator, orchestrator, or admin can cancel a task',
      });
      data.status = 'cancelled';
    }

    if (!isAssignee && isExecutionControlOnly) {
      const canControl = await hasTaskOrchestratorAuthority(id, actorId, task.creatorId);
      if (canControl) {
        return this.forceExecutionStatus(id, actorId, updates.status!, {
          reason:
            typeof updates.statusMessage === 'string'
              ? updates.statusMessage
              : `Execution status set to ${updates.status} by orchestrator`,
        });
      }
    }

    // Assignee-only fields: progress, statusMessage
    if (updates.progress !== undefined || updates.statusMessage !== undefined) {
      if (!isAssignee) {
        throw new TaskAccessError(id, 'only the assigned agent can update progress or statusMessage');
      }
      if (isProjectionTask && !isCreator) {
        throw new TaskAccessError(id, 'board task progress is driven by an explicit execution run');
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

    // Gate #4 (status transitions via PATCH): assignee-driven transitions
    // go through the unified TRANSITIONS matrix in task-permission.ts.
    // The matrix enforces the v2.0 "no self-approval" contract for
    // running→completed (assignee can only running→review/blocked/failed).
    if (
      updates.status &&
      ['running', 'review', 'completed', 'failed'].includes(updates.status) &&
      updates.status !== 'cancelled'
    ) {
      if (isProjectionTask && !isCreator) {
        throw new TaskAccessError(id, 'board task execution status is controlled by explicit run dispatch');
      }
      const currentStatus = ((data.status as string) ?? task.status) as TaskStatus;
      const transitionDecision = await this.gateMutation(task, actorId, {
        kind: 'transition',
        from: currentStatus,
        to: updates.status as TaskStatus,
      });
      if (!transitionDecision.allow) {
        // Distinguish "invalid state" (409) from "forbidden" (403) by
        // checking if the transition rule exists at all.
        const ruleExists = !!TRANSITIONS[currentStatus]?.[updates.status as TaskStatus];
        if (!ruleExists) {
          const allowedTos = Object.keys(TRANSITIONS[currentStatus] ?? {}).join(' or ');
          throw new TaskStateError(id, currentStatus, allowedTos || 'no assignee transitions allowed');
        }
        throw new TaskAccessError(id, 'only the assigned agent can change task execution status');
      }
      data.status = updates.status;
      if (updates.status === 'completed') {
        data.completedAt = new Date();
      }
    }

    // Gate #5 (metadata edit): treated as edit-content per v2.0 §3.2 —
    // creator, orchestrator (deputy), admin, and owner can edit.
    if (updates.metadata) {
      const metaDecision = await this.gateMutation(task, actorId, { kind: 'edit-content' });
      this.requirePermission(metaDecision, id, {
        defaultError: 'access',
        accessReason: 'only the task creator can update task metadata',
      });
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
    // Gate #5: forceExecutionStatus is the escape-hatch (§5.3). v2.0 spec
    // restricts it to L0/L1 (owner/admin or trustTier>=4). For backward
    // compatibility with existing callers (orchestrator-driven Kanban
    // drag → updateTask delegates here), we accept orchestrator-tier as
    // well. The new /force-transition admin endpoint (P3) will enforce
    // strict L0/L1 via isForceTransitionAllowed.
    const canControlExecution = await hasTaskOrchestratorAuthority(id, actorId, task.creatorId);
    if (!canControlExecution) {
      throw new OrchestratorRequiredError(id);
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

  // ═══════════════════════════════════════════════════════════
  // v2.0 release 200 P3 — unified transition API (§5 + §6.1)
  // ═══════════════════════════════════════════════════════════

  /**
   * Unified state-machine transition entry point.
   *
   * This is the single source of truth for kanban drag / approve / reject /
   * cancel / blocked self-report / retry / restore. Routes the change through
   * `resolveTaskMutationPermission` (P2) which enforces:
   *
   *   - TRANSITIONS[from][to] — structural validity (else 409
   *     InvalidTransitionError)
   *   - allowedActors per the matrix — actor tier match (else 403
   *     TaskForbiddenError)
   *
   * Side effects are derived from the matched TRANSITIONS rule's
   * `sideEffects` list and execute fire-and-forget after the DB write
   * commits (matches existing approve / reject / cancel behaviour).
   *
   * Structural preconditions enforced before write:
   *   - pending → assigned MUST receive `assigneeId`
   *   - blocked / failed transitions SHOULD carry `reason` (we accept empty
   *     but log a warning so audit shows the actor neglected it)
   *
   * `position` is optional. We trust the caller's B-tree midpoint
   * calculation (P5) — no validation here.
   */
  async transitionTask(
    taskId: string,
    actorId: string,
    input: {
      to: TaskStatus;
      assigneeId?: string | null;
      position?: number;
      reason?: string;
      reviewComment?: string;
    },
  ): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const from = task.status as TaskStatus;
    const to = input.to;

    // Permission gate. The resolver also checks TRANSITIONS structural
    // validity — but it conflates "no rule" with "actor not allowed" in
    // a single deny envelope. We pre-check the rule existence to give
    // the API layer a clean 409 vs 403 distinction per spec.
    const rule = TRANSITIONS[from]?.[to];
    if (!rule) {
      const allowedFromHere = Object.keys(TRANSITIONS[from] ?? {});
      throw new InvalidTransitionError(taskId, from, to, allowedFromHere);
    }

    const decision = await this.gateMutation(task, actorId, {
      kind: 'transition',
      from,
      to,
    });
    if (!decision.allow) {
      // Map the resolver's denial to the API-shaped envelope. The actor
      // tier is best-effort — we infer it from the deny reason / the
      // resolved actor metadata.
      const actor = await loadTaskActor(actorId, task.workspaceId ?? '');
      const actorTier = actor
        ? actor.type === 'agent'
          ? task.assigneeId === actorId
            ? 'executor'
            : 'observer'
          : (actor.role ?? 'observer')
        : 'observer';
      throw new TaskForbiddenError(taskId, actorTier, decision.requiredTiers, decision.reason);
    }

    // ─── Structural preconditions ─────────────────────────────────
    let effectiveAssigneeId: string | null | undefined = task.assigneeId;
    if (from === 'pending' && to === 'assigned') {
      if (input.assigneeId === undefined || input.assigneeId === null || input.assigneeId === '') {
        throw new TaskStateError(taskId, 'unassigned', 'assigneeId required for pending → assigned');
      }
      effectiveAssigneeId = input.assigneeId;
    } else if (input.assigneeId !== undefined) {
      // Other transitions may carry an explicit reassignment (e.g. board
      // drag to assign+running). Honour it when the resolver already
      // allowed it; the matrix's owner/admin/orchestrator/creator tier
      // covers this case.
      effectiveAssigneeId = input.assigneeId;
    }

    if ((to === 'blocked' || to === 'failed') && !input.reason) {
      log.warn(`transitionTask ${taskId}: ${from} → ${to} with no reason — audit log will lack root cause`);
    }

    // ─── release201/10 §4.4 + §4.4.1: acceptance evidence gate ────
    // When transitioning into `review`, criteria with evidence are the
    // structured contract reviewer reads against. Three sub-checks:
    //   1. acceptanceCriteriaJson has at least 1 required criterion
    //      whose evidenceRefs[] is non-empty (or there are 0 criteria,
    //      in which case the task opted out of acceptance entirely)
    //   2. Every `asset:<id>` evidence ref resolves to an IMAsset in the
    //      same workspace with boundKind IN ('task-bound','workspace-file')
    //   3. Cross-task asset refs need explicit crossTaskConfirmed=true
    if (to === 'review') {
      const acceptanceErr = await this.validateAcceptanceEvidenceForReview(taskId, task);
      if (acceptanceErr) throw acceptanceErr;
      // release201/10 rev 2 §0.2.3 — extra gates:
      //   (b) all verifyMode='agent-self-check' criteria must be assignee-evaluated
      //   (c) TODO.md present + progressPct ≥ 0.80 (below threshold → 422 client confirm modal)
      const rev2Err = await this.validateRev2SelfCheckAndTodoGate(taskId, task.assigneeId ?? null);
      if (rev2Err) throw rev2Err;
    }

    // ─── Build write payload ──────────────────────────────────────
    const data: Record<string, unknown> = { status: to };
    if (input.assigneeId !== undefined) {
      data.assigneeId = input.assigneeId;
    } else if (from === 'pending' && to === 'assigned') {
      data.assigneeId = effectiveAssigneeId;
    }
    if (input.position !== undefined) {
      data.position = input.position;
    }
    if (rule.sideEffects.includes('record-completion')) {
      data.completedAt = new Date();
      data.progress = 1;
      // 2026-05-22 — state-machine completion path. The completeTask /
      // completeShellTask agent-driven entry points already roll up
      // metadata.outputAssetIds → result.assetIds; the human-driven PATCH
      // /transition path (review → completed via Approve button) must
      // mirror that so kanban shows the attachment chip on completion
      // regardless of which entry point reached the terminal state.
      const taskMeta = parseMetadataObject(task.metadata);
      const existingResult = task.result ? safeParseJsonInline(task.result) : undefined;
      const mergedResult = mergeResultWithOutputAssetIds(existingResult, taskMeta);
      if (mergedResult !== undefined) {
        data.result = JSON.stringify(mergedResult);
      }
    }
    if (to === 'running') {
      // Mirror forceExecutionStatus: reset terminal-shape fields so a
      // restart wipes prior result. Also bump runCount + lastRunAt.
      data.completedAt = null;
      data.error = null;
      data.lastRunAt = new Date();
      data.runCount = { increment: 1 };
    }
    if (to === 'failed' && input.reason) {
      data.error = input.reason;
    }
    if (to === 'pending') {
      // Restore from cancelled / un-assigned: clear terminal fields.
      data.completedAt = null;
      data.result = null;
      data.resultUri = null;
      data.error = null;
    }

    const updated = await this.taskModel.update(taskId, data);
    if (!updated) throw new TaskNotFoundError(taskId);

    // ─── Audit log entry ──────────────────────────────────────────
    const logMeta: Record<string, unknown> = {
      from,
      to,
      by: actorId,
      via: decision.allow ? decision.via : 'unknown',
      at: new Date().toISOString(),
    };
    if (input.reason) logMeta.reason = input.reason;
    if (input.reviewComment) logMeta.reviewComment = input.reviewComment;
    if (input.assigneeId !== undefined) logMeta.assigneeId = input.assigneeId;
    if (input.position !== undefined) logMeta.position = input.position;

    await this.taskModel.createLog({
      taskId,
      actorId,
      action: `transition_${from}_to_${to}`,
      message: input.reason ?? `Transition ${from} → ${to}`,
      metadata: JSON.stringify(logMeta),
    });

    // release201/11 §4 #4 — emit task.blocked_duration metric on blocked → running.
    // `task` is the pre-transition snapshot; task.updatedAt is the moment the task
    // last entered blocked (since this is the next mutation after that). value = ms.
    if (from === 'blocked' && to === 'running') {
      metricEmit({
        namespace: 'task',
        name: 'blocked_duration',
        source: 'cloud',
        value: Math.max(0, Date.now() - new Date(task.updatedAt).getTime()),
        dims: {
          workspaceId: task.workspaceId ?? '',
          projectId: task.projectId ?? undefined,
          taskId,
        },
      });
    }

    // 2026-05-29 Insights overview fix — emit task.completed / task.failed
    // metrics on terminal transitions through the unified state-machine path.
    // `completeTask` / `failTask` (agent-RPC entry points) already emit these
    // (lines ~3454 / ~3708); but the dominant human-driven path — review →
    // completed via the Approve button — flows through here and previously
    // emitted nothing, so /insights overview read 0 even when im_tasks had
    // multiple completed rows. Mirrors the dims contract used by completeTask
    // (workspaceId / taskId / capability / assigneeId / creatorId); value =
    // duration_ms from creation to terminal state.
    if (to === 'completed') {
      const durationMs = task.createdAt ? Math.max(0, Date.now() - new Date(task.createdAt).getTime()) : 0;
      metricEmit({
        namespace: 'task',
        name: 'completed',
        value: durationMs,
        dims: {
          workspaceId: updated.workspaceId ?? '',
          projectId: updated.projectId ?? undefined,
          taskId,
          capability: updated.capability ?? 'general',
          assigneeId: updated.assigneeId ?? undefined,
          creatorId: updated.creatorId,
        },
      });
    } else if (to === 'failed') {
      metricEmit({
        namespace: 'task',
        name: 'failed',
        value: 1,
        dims: {
          workspaceId: updated.workspaceId ?? '',
          projectId: updated.projectId ?? undefined,
          taskId,
          capability: updated.capability ?? 'general',
          assigneeId: updated.assigneeId ?? undefined,
          creatorId: updated.creatorId,
          errorCode: 'transition',
        },
      });
    }

    // ─── Side effects (fire-and-forget) ──────────────────────────
    void this.applyTransitionSideEffects(rule.sideEffects, {
      from,
      to,
      task: updated,
      previousTask: task,
      actorId,
      reason: input.reason,
    });

    log.info(`Transition ${taskId}: ${from} → ${to} by ${actorId} (via=${decision.allow ? decision.via : '?'})`);

    // release201/10 rev 2 §4.2 — when entering review, dispatch
    // task.verify.requested to each criterion's verifier agent. Cloud
    // does NOT run any specific verifier — verifier agents decide at
    // runtime. Fire-and-forget so transition isn't blocked on IM round-trip.
    if (to === 'review') {
      void (async () => {
        try {
          const { getVerifierDispatchService } = await import('./verifier-dispatch.service');
          await getVerifierDispatchService({
            eventBusService: this.deps.eventBusService,
            rooms: this.deps.rooms as any,
            syncService: this.deps.syncService as any,
          }).dispatchVerifyRequest(taskId);
        } catch (err) {
          log.warn(`verifier dispatch on review entry failed for ${taskId}: ${(err as Error).message}`);
        }
      })();
    }

    return this.toTaskInfo(updated);
  }

  /**
   * release201/10 §4.4 — validate acceptance evidence before allowing a
   * task to enter `review`. Returns an AcceptanceError to throw, or null
   * when the gate is satisfied (or there are no criteria at all — opt-out
   * is legal, the gate kicks in only when criteria exist).
   */
  private async validateAcceptanceEvidenceForReview(
    taskId: string,
    task: { id: string; workspaceId: string | null },
  ): Promise<AcceptanceError | null> {
    // release201/10 §0.2.3 — data integrity: a transition into `review` MUST
    // be hard-blocked when we cannot verify evidence. Previously this caught
    // getAcceptance() errors and returned null (soft-fail), letting tasks
    // sneak into review on a transient DB read failure. Per doc 10 §4.4 the
    // gate is a hard-fail boundary — surfaces 422 acceptance_evidence_*
    // codes — so any read error is reported as `acceptance_evidence_indeterminate`
    // and the transition is rejected. The reviewer can retry once the underlying
    // read works again; the alternative (let the task transition with unverified
    // evidence) is a silent integrity breach.
    let acceptance;
    try {
      acceptance = await getTaskAcceptanceService({ eventBusService: this.deps.eventBusService }).getAcceptance(taskId);
    } catch (err) {
      log.error(`getAcceptance failed for ${taskId} during review transition: ${(err as Error).message}`);
      return new AcceptanceError(
        'acceptance_evidence_indeterminate',
        'cannot verify acceptance evidence due to acceptance read error',
        422,
        { taskId, cause: (err as Error).message },
      );
    }
    if (acceptance.criteria.length === 0) return null; // opt-out

    // Collect all evidence refs across criteria.
    type RefBundle = { criterion: Criterion; entries: Array<EvidenceRef | EvidenceEntry> };
    const buckets: RefBundle[] = acceptance.criteria.map((c) => ({
      criterion: c,
      entries: c.evidenceRefs ?? [],
    }));
    const totalEvidence = buckets.reduce((sum, b) => sum + b.entries.length, 0);
    if (totalEvidence === 0) {
      return new AcceptanceError(
        'acceptance_evidence_missing',
        'transition to review requires at least one evidence ref',
        422,
        { taskId },
      );
    }
    const requiredWithEvidence = buckets.filter((b) => (b.criterion.required ?? true) && b.entries.length > 0);
    const requiredCount = buckets.filter((b) => b.criterion.required ?? true).length;
    if (requiredCount > 0 && requiredWithEvidence.length === 0) {
      return new AcceptanceError(
        'acceptance_evidence_missing',
        'at least one required criterion must have evidenceRefs[]',
        422,
        { taskId, requiredCount },
      );
    }

    // §4.4.1 — for each asset:<id> evidence ref, validate.
    const allAssetRefs = buckets.flatMap((b) =>
      extractEvidenceAssetIds(b.entries).map((r) => ({ ...r, criterionId: b.criterion.id })),
    );
    if (allAssetRefs.length === 0) return null;

    const uniqIds = Array.from(new Set(allAssetRefs.map((r) => r.assetId)));
    const assets = (await prisma.iMAsset.findMany({
      where: { id: { in: uniqIds } },
      select: {
        id: true,
        workspaceId: true,
        boundKind: true,
        deletedAt: true,
        sourceTaskId: true,
      },
    })) as Array<{
      id: string;
      workspaceId: string;
      boundKind: string | null;
      deletedAt: Date | null;
      sourceTaskId: string | null;
    }>;
    const byId = new Map(assets.map((a) => [a.id, a]));

    for (const ref of allAssetRefs) {
      const a = byId.get(ref.assetId);
      if (!a) {
        return new AcceptanceError(
          'acceptance_evidence_invalid_asset',
          `evidence asset ${ref.assetId} not found`,
          422,
          { assetId: ref.assetId, reason: 'asset_not_found' },
        );
      }
      if (a.deletedAt !== null) {
        return new AcceptanceError(
          'acceptance_evidence_invalid_asset',
          `evidence asset ${ref.assetId} is deleted`,
          422,
          { assetId: ref.assetId, reason: 'asset_deleted' },
        );
      }
      if (task.workspaceId && a.workspaceId !== task.workspaceId) {
        return new AcceptanceError(
          'acceptance_evidence_invalid_asset',
          `evidence asset ${ref.assetId} belongs to a different workspace`,
          422,
          { assetId: ref.assetId, reason: 'asset_workspace_mismatch' },
        );
      }
      if (a.boundKind !== 'task-bound' && a.boundKind !== 'workspace-file') {
        return new AcceptanceError(
          'acceptance_evidence_invalid_asset',
          `evidence asset ${ref.assetId} has unsupported boundKind=${a.boundKind ?? 'NULL'}`,
          422,
          { assetId: ref.assetId, reason: 'asset_boundkind_unsupported' },
        );
      }
      if (a.sourceTaskId && a.sourceTaskId !== task.id && !ref.crossTaskConfirmed) {
        return new AcceptanceError(
          'acceptance_evidence_invalid_asset',
          `evidence asset ${ref.assetId} references a different task — crossTaskConfirmed required`,
          422,
          { assetId: ref.assetId, reason: 'asset_cross_task_unconfirmed' },
        );
      }
    }
    return null;
  }

  /**
   * release201/10 rev 2 §0.2.3 — extra gates that fire on review transition:
   *   - All `verifyMode='agent-self-check'` criteria MUST have been
   *     self-evaluated by the assignee (status != 'pending'). Otherwise
   *     422 `acceptance_self_check_incomplete` so assignee runs
   *     `cloud task verify` before retrying.
   *   - TODO.md must exist AND completion ≥ 80%. <80% emits 422
   *     `todo_completion_below_threshold` so the UI can show a confirm
   *     modal. UI may resend transition with `?force=1` to override
   *     (handled at endpoint layer — service stays strict).
   *
   * Returns AcceptanceError to throw, or null when both gates clear.
   */
  private async validateRev2SelfCheckAndTodoGate(
    taskId: string,
    assigneeId: string | null,
  ): Promise<AcceptanceError | null> {
    let acceptance;
    try {
      acceptance = await getTaskAcceptanceService({
        eventBusService: this.deps.eventBusService,
      }).getAcceptance(taskId);
    } catch (err) {
      log.warn(`validateRev2 read acceptance failed for ${taskId}: ${(err as Error).message}`);
      return null; // fall back to base gate's read-error handling
    }
    // (b) self-check completeness
    const selfChecks = acceptance.criteria.filter((c) => c.verifyMode === 'agent-self-check');
    const pendingSelfChecks = selfChecks.filter((c) => c.status === 'pending');
    if (pendingSelfChecks.length > 0) {
      return new AcceptanceError(
        'acceptance_self_check_incomplete',
        `assignee has not self-evaluated ${pendingSelfChecks.length} agent-self-check criteria; run cloud task verify before review`,
        422,
        {
          taskId,
          pendingCriterionIds: pendingSelfChecks.map((c) => c.id),
        },
      );
    }
    // release201/19 B5 — actor identity gate on agent-self-check criteria.
    //
    // doc 10 rev 2 §0.2.3 (b): "all `verifyMode='agent-self-check'` criteria
    // must be **assignee-evaluated**". `Criterion.verifiedBy` records the
    // actorId of the most recent verify call. We reject any agent-self-check
    // criterion that was stamped by someone other than the current task
    // assignee (e.g. owner trying to bypass assignee self-eval).
    //
    // If assigneeId is null we cannot enforce — surface as 422 so the gate
    // doesn't silently let it through; this should not happen in practice
    // because review can only be reached from running, which already requires
    // an assignee.
    if (selfChecks.length > 0) {
      if (!assigneeId) {
        return new AcceptanceError(
          'self_check_wrong_actor',
          'task has no assignee but carries agent-self-check criteria; cannot verify assignee self-evaluation',
          422,
          { taskId },
        );
      }
      const wrongActor = selfChecks.filter((c) => !c.verifiedBy || c.verifiedBy !== assigneeId);
      if (wrongActor.length > 0) {
        return new AcceptanceError(
          'self_check_wrong_actor',
          `${wrongActor.length} agent-self-check criteria were not evaluated by the task assignee (doc 10 rev 2 §0.2.3 b)`,
          422,
          {
            taskId,
            assigneeId,
            wrongActorCriterionIds: wrongActor.map((c) => c.id),
          },
        );
      }
    }
    // (c) TODO threshold
    try {
      const { getTodoService } = await import('./todo.service');
      const todo = await getTodoService({ eventBusService: this.deps.eventBusService }).get(taskId);
      // If no TODO authored at all → block (rev 2 requires it for non-trivial tasks).
      // We treat tasks with 0 acceptance criteria as opt-out for BOTH gates —
      // §4.4 already lets them through; the rev 2 gate mirrors that escape hatch.
      if (acceptance.criteria.length === 0) return null;
      if (todo.totalCount === 0) {
        return new AcceptanceError(
          'todo_completion_below_threshold',
          'TODO.md missing or empty — assignee must author a TODO.md before status=review',
          422,
          { taskId, doneCount: 0, totalCount: 0, threshold: 0.8 },
        );
      }
      if (todo.progressPct < 0.8) {
        return new AcceptanceError(
          'todo_completion_below_threshold',
          `TODO completion ${Math.round(todo.progressPct * 100)}% is below the 80% threshold for review`,
          422,
          {
            taskId,
            doneCount: todo.doneCount,
            totalCount: todo.totalCount,
            progressPct: todo.progressPct,
            threshold: 0.8,
          },
        );
      }
    } catch (err) {
      log.warn(`validateRev2 TODO gate read failed for ${taskId}: ${(err as Error).message}`);
      // soft-fail TODO gate read errors (we already log; UI can retry)
    }
    return null;
  }

  /**
   * Admin escape-hatch — skip the TRANSITIONS matrix entirely.
   *
   * Used by ops for production incidents (force a stuck task to
   * cancelled / completed / pending without an agent finishing it).
   * Gated to L0 owner / L1 admin / trustTier>=4 via
   * `isForceTransitionAllowed`. UI does NOT expose this.
   */
  async forceTransitionTask(
    taskId: string,
    actorId: string,
    input: { to: TaskStatus; reason: string },
  ): Promise<TaskInfo> {
    if (!input.reason || !input.reason.trim()) {
      throw new TaskStateError(taskId, 'no-reason', 'reason is required for force-transition');
    }
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const actor = await loadTaskActor(actorId, task.workspaceId ?? '');
    if (!actor || !isForceTransitionAllowed(actor)) {
      throw new TaskForbiddenError(
        taskId,
        actor ? (actor.role ?? 'observer') : 'observer',
        ['owner', 'admin'],
        'force-transition requires workspace owner / admin tier',
      );
    }

    const from = task.status as TaskStatus;
    const to = input.to;
    if (from === to) return this.toTaskInfo(task);

    const data: Record<string, unknown> = { status: to };
    const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];
    if (to === 'completed') {
      data.completedAt = new Date();
      data.progress = 1;
    }
    if (to === 'pending') {
      data.completedAt = null;
      data.result = null;
      data.resultUri = null;
      data.error = null;
    }
    if (to === 'failed' && input.reason) {
      data.error = input.reason;
    }

    const updated = await this.taskModel.update(taskId, data);
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({
      taskId,
      actorId,
      action: `force_transition_${from}_to_${to}`,
      message: input.reason,
      metadata: JSON.stringify({
        force_transition: true,
        from,
        to,
        by: actorId,
        actorTier: actor.role ?? 'admin-trust-tier',
        reason: input.reason,
        at: new Date().toISOString(),
      }),
    });

    // Cancel any in-flight run when forcing into a terminal state from
    // running. We deliberately do not enqueue a new run on force; that
    // remains a deliberate transition through /transition.
    if (TERMINAL.includes(to) && from === 'running' && task.assigneeId) {
      this.emitDaemonCancel(task.assigneeId, taskId, input.reason);
    }
    if (TERMINAL.includes(to) && from === 'running' && task.runtimeRoute === 'shell') {
      const targetDaemonId = this.readTargetDaemonId(task.metadata);
      if (targetDaemonId) this.emitRuntimeCancel(targetDaemonId, taskId, input.reason);
    }

    log.warn(`Force transition ${taskId}: ${from} → ${to} by ${actorId} — reason: ${input.reason}`);

    this.deps.eventBusService
      ?.publish({
        type: 'task.updated',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          status: updated.status,
          creatorId: task.creatorId,
          assigneeId: updated.assigneeId,
          conversationId: task.conversationId ?? null,
          forced: true,
          reason: input.reason,
        },
      })
      .catch(() => {});

    // P9 — force-transition also upserts the digest so the chat reflects
    // the new state. Marks the digest's `forced` field so the renderer can
    // distinguish ops-driven changes from normal lifecycle.
    if (TERMINAL.includes(to)) {
      // B-line — a force-complete still produced deliverables; surface their
      // count in the digest the same way the normal record-completion path
      // does, so the chat chip is consistent regardless of how the task
      // reached `completed`.
      const forcedCompletionAssetIds =
        to === 'completed' ? extractCompletionAssetIds({ metadata: updated.metadata }) : [];
      void this.emitTaskStatusChat(
        {
          id: updated.id,
          title: updated.title,
          conversationId: updated.conversationId ?? null,
          assigneeId: updated.assigneeId,
          creatorId: updated.creatorId,
          metadata: updated.metadata,
          workspaceId: updated.workspaceId ?? null,
        },
        to as 'completed' | 'failed' | 'cancelled',
        {
          from: from as DigestStatus,
          by: actorId,
          error: input.reason,
          ...(forcedCompletionAssetIds.length > 0 ? { resultAssetIds: forcedCompletionAssetIds } : {}),
        },
      );
    } else {
      void this.emitTaskNonTerminalDigest(
        {
          id: updated.id,
          title: updated.title,
          conversationId: updated.conversationId ?? null,
          assigneeId: updated.assigneeId,
          creatorId: updated.creatorId,
          workspaceId: updated.workspaceId ?? null,
        },
        from as DigestStatus,
        to as DigestStatus,
        { by: actorId, reason: input.reason },
      );
    }

    return this.toTaskInfo(updated);
  }

  /**
   * Apply the TRANSITIONS rule's side-effect list. Each effect is dispatched
   * fire-and-forget so a side-effect failure cannot roll back the
   * already-committed status change. Failures are logged.
   */
  private async applyTransitionSideEffects(
    effects: readonly SideEffect[],
    ctx: {
      from: TaskStatus;
      to: TaskStatus;
      task: {
        id: string;
        title: string;
        creatorId: string;
        assigneeId: string | null;
        workspaceId: string | null;
        conversationId: string | null;
        status: string;
        runtimeRoute: string | null;
        metadata: string;
      };
      previousTask: { metadata: string; assigneeId: string | null; runtimeRoute: string | null };
      actorId: string;
      reason?: string;
    },
  ): Promise<void> {
    for (const effect of effects) {
      try {
        switch (effect) {
          case 'enqueue-run':
            if (ctx.task.assigneeId) {
              await this.emitDaemonDispatchRequest(ctx.task.assigneeId, ctx.task);
              this.notifyAgent(ctx.task.assigneeId, ctx.task, 'task.dispatched').catch(() => {});
            }
            if (ctx.task.runtimeRoute === 'shell') {
              await this.emitShellDispatchRequest(ctx.task);
            }
            break;
          case 'cancel-run':
            if (ctx.previousTask.assigneeId) {
              this.emitDaemonCancel(ctx.previousTask.assigneeId, ctx.task.id, ctx.reason);
            }
            if (ctx.previousTask.runtimeRoute === 'shell') {
              const targetDaemonId = this.readTargetDaemonId(ctx.previousTask.metadata);
              if (targetDaemonId) this.emitRuntimeCancel(targetDaemonId, ctx.task.id, ctx.reason);
            }
            break;
          case 'notify-creator':
            this.notifyUser(ctx.task.creatorId, ctx.task, `task.${ctx.to}`).catch(() => {});
            if (ctx.to === 'review') {
              void emitTaskApprovalRequestedNotification({
                taskId: ctx.task.id,
                title: ctx.task.title,
                creatorImUserId: ctx.task.creatorId,
                assigneeImUserId: ctx.task.assigneeId,
                conversationId: ctx.task.conversationId ?? null,
                workspaceId: ctx.task.workspaceId ?? null,
              });
              void this.fanOutBellSync(ctx.task.creatorId, 'task.approval_requested', {
                taskId: ctx.task.id,
                title: ctx.task.title,
              });
            }
            break;
          case 'notify-assignee':
            if (ctx.task.assigneeId) {
              // pending → assigned and review → assigned (rejection) both
              // hit this effect. Differentiate by `from` so the agent
              // sees the right event.
              const eventName = ctx.from === 'review' ? 'task.rejected' : 'task.assigned';
              this.notifyAgent(ctx.task.assigneeId, ctx.task, eventName).catch(() => {});
              if (ctx.from === 'pending') {
                // Bell row + sync ping mirror createTask's assignment path.
                void emitTaskAssignedNotification({
                  taskId: ctx.task.id,
                  title: ctx.task.title,
                  assigneeImUserId: ctx.task.assigneeId,
                  creatorImUserId: ctx.task.creatorId,
                  conversationId: ctx.task.conversationId ?? null,
                  workspaceId: ctx.task.workspaceId ?? null,
                });
                void this.fanOutBellSync(ctx.task.assigneeId, 'task.assigned', {
                  taskId: ctx.task.id,
                  title: ctx.task.title,
                });
              }
            }
            break;
          case 'record-completion': {
            // DB fields already written above (completedAt / progress=1).
            // Fire the chat surface + evolution outcome here. B-line — the
            // deliverable assets were rolled into metadata.outputAssetIds by
            // POST /assets during the run; surface them on the digest chip.
            const completionAssetIds = extractCompletionAssetIds({ metadata: ctx.task.metadata });
            void this.emitTaskStatusChat(ctx.task, 'completed', {
              from: ctx.from as DigestStatus,
              by: ctx.actorId,
              resultAssetIds: completionAssetIds,
            });
            if (ctx.task.assigneeId) {
              this.recordEvolutionOutcome(ctx.task.assigneeId, ctx.task, 'success', null).catch((err) =>
                log.error({ err }, `Evolution record FAILED for transitioned task ${ctx.task.id}`),
              );
            }
            break;
          }
        }
      } catch (err) {
        log.warn(
          `transition side-effect ${effect} for ${ctx.task.id} ${ctx.from}→${ctx.to} failed: ${(err as Error).message}`,
        );
      }
    }

    // EventBus publish — emit a generic task.updated so SSE relays see the
    // transition. Matches the existing approve / reject / cancel flow.
    this.deps.eventBusService
      ?.publish({
        type: ctx.to === 'completed' ? 'task.completed' : ctx.to === 'failed' ? 'task.failed' : 'task.updated',
        timestamp: Date.now(),
        data: {
          taskId: ctx.task.id,
          title: ctx.task.title,
          status: ctx.task.status,
          creatorId: ctx.task.creatorId,
          assigneeId: ctx.task.assigneeId,
          conversationId: ctx.task.conversationId ?? null,
          from: ctx.from,
          to: ctx.to,
          by: ctx.actorId,
          reason: ctx.reason,
        },
      })
      .catch(() => {});

    // P9 — every transition surfaces a digest upsert in chat. Terminal
    // transitions flowing through `record-completion` already called
    // emitTaskStatusChat above; transitions to `failed` / `cancelled` only
    // had `notify-creator` / no-effect rules, so the digest needs to fire
    // here for them. Non-terminal transitions (assigned / running / review
    // / blocked / pending) had no pre-P9 chat representation — same path.
    //
    // record-completion (completed) is the only case already covered by
    // emitTaskStatusChat from the side-effect loop; skip it to avoid a
    // double-upsert.
    const alreadyDigested = ctx.to === 'completed' && effects.includes('record-completion');
    if (!alreadyDigested) {
      if (ctx.to === 'failed' || ctx.to === 'cancelled') {
        void this.emitTaskStatusChat(
          {
            id: ctx.task.id,
            title: ctx.task.title,
            conversationId: ctx.task.conversationId ?? null,
            assigneeId: ctx.task.assigneeId,
            creatorId: ctx.task.creatorId,
            metadata: ctx.task.metadata,
            workspaceId: ctx.task.workspaceId ?? null,
          },
          ctx.to,
          { error: ctx.reason ?? null, by: ctx.actorId, from: ctx.from as DigestStatus },
        );
      } else {
        void this.emitTaskNonTerminalDigest(
          {
            id: ctx.task.id,
            title: ctx.task.title,
            conversationId: ctx.task.conversationId ?? null,
            assigneeId: ctx.task.assigneeId,
            creatorId: ctx.task.creatorId,
            workspaceId: ctx.task.workspaceId ?? null,
          },
          ctx.from as DigestStatus,
          ctx.to as DigestStatus,
          { by: ctx.actorId, reason: ctx.reason ?? null },
        );
      }
    }
  }

  /**
   * Creator approves a task in review status → completed.
   * Idempotent: re-approving a completed task returns 200.
   */
  async approveTask(taskId: string, actorId: string): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    // Gate #6a (release 200 §11): resolveTaskMutationPermission with
    // action=transition review→completed. The matrix's allowedActors
    // excludes 'assignee' — that's the v2.0 "no self-approval" contract.
    const decision = await this.gateMutation(task, actorId, {
      kind: 'transition',
      from: 'review' as TaskStatus,
      to: 'completed' as TaskStatus,
    });
    this.requirePermission(decision, taskId, { defaultError: 'orchestrator' });
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
    // Gate #6b: rejection is semantically `review → assigned` in TRANSITIONS
    // (which also excludes assignee). The legacy endpoint writes status
    // 'failed' for backward compat, so we evaluate the permission against
    // the new transition shape but keep the legacy write below.
    const decision = await this.gateMutation(task, actorId, {
      kind: 'transition',
      from: 'review' as TaskStatus,
      to: 'assigned' as TaskStatus,
    });
    this.requirePermission(decision, taskId, { defaultError: 'orchestrator' });
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
  /**
   * release201/09 §6.4 — Move a task to a different project (or unscoped).
   *
   * Permission contract (§5.1 + §5.2):
   *   - workspace owner can always move; OR
   *   - actor is owner of the source project (when task currently scoped)
   *     AND owner of the target project (when scoping to a project).
   *   - workspace-level → project additionally requires actor to be task creator.
   *
   * Invariants:
   *   - target project (if specified) must belong to the same workspace as
   *     the task + must be status='active' (no moving INTO archived projects)
   *   - source project may be archived (allowing rescue of orphaned tasks)
   */
  async moveTaskProject(taskId: string, actorId: string, targetProjectId: string | null): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (!task.workspaceId) throw new TaskAccessError(taskId, 'task has no workspaceId');

    // Workspace-owner short-circuit. §5.2: workspace owner has implicit
    // owner role on every project.
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: task.workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new TaskNotFoundError(taskId);
    const isWorkspaceOwner = ws.ownerImUserId === actorId;

    const existingProjectId =
      'projectId' in task && task.projectId !== undefined ? (task.projectId as string | null) : null;
    if (existingProjectId === targetProjectId) {
      return this.toTaskInfo(task);
    }

    // Target project validation.
    let targetProject: ProjectAccessRow | null = null;
    if (targetProjectId !== null) {
      targetProject = await this.loadProjectForTaskScope(targetProjectId, taskId);
      if (targetProject.workspaceId !== task.workspaceId) {
        throw new TaskAccessError(taskId, 'target project belongs to a different workspace');
      }
      if (targetProject.status !== 'active') {
        throw new TaskAccessError(taskId, 'cannot move task into archived project');
      }
    }

    if (!isWorkspaceOwner) {
      if (existingProjectId) {
        const sourceProject = await this.loadProjectForTaskScope(existingProjectId, taskId);
        const sourceRole = await this.getProjectEffectiveRole(sourceProject, actorId);
        if (sourceRole !== 'owner') {
          throw new TaskAccessError(taskId, 'only source project owner can move tasks out of a project');
        }
      } else if (targetProjectId === null) {
        throw new TaskAccessError(taskId, 'task is already workspace-level');
      } else if (task.creatorId !== actorId) {
        throw new TaskAccessError(taskId, 'only task creator or workspace owner can scope workspace-level tasks');
      }

      if (targetProject) {
        const targetRole = await this.getProjectEffectiveRole(targetProject, actorId);
        if (targetRole !== 'owner') {
          throw new TaskAccessError(taskId, 'only target project owner can move tasks into a project');
        }
      }
    }

    const updated = await this.taskModel.update(taskId, { projectId: targetProjectId });
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.taskModel.createLog({
      taskId,
      actorId,
      action: 'project_moved',
      message: `projectId ${existingProjectId ?? '(unscoped)'} → ${targetProjectId ?? '(unscoped)'}`,
    });
    return this.toTaskInfo(updated);
  }

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
      // Defense-in-depth (release202/09): a marketplace (pending + unassigned)
      // task scoped to a workspace must only be claimable by members of that
      // workspace. Without this, ANY agent on the instance — including agents
      // from other workspaces, or wrong-role agents who happened to see the
      // card — could claim it and become its assignee (which then satisfies
      // every downstream assignee gate). The primary protection is still that
      // a task assigned to a specific agent never reaches `pending`, so claim
      // fails on `status`; this guards the unassigned-card path.
      if (taskForBlockCheck.workspaceId) {
        const member = await this.canAccessWorkspace(taskForBlockCheck.workspaceId, agentId);
        if (!member) {
          throw Object.assign(new Error('only members of this workspace can claim this task'), {
            status: 403,
            code: 'CLAIM_NOT_WORKSPACE_MEMBER',
          });
        }
      }

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

    // 2026-05-22 — roll up outbox-uploaded asset IDs (recorded in
    // metadata.outputAssetIds by POST /assets when the daemon supplies
    // metadata.taskId) into the canonical task.result.assetIds shape so
    // mobile / search / external readers can list a task's deliverables
    // off the result payload without a separate IMAsset query.
    const mergedResult = mergeResultWithOutputAssetIds(input.result, this.parseJson(task.metadata));

    // Cost: explicit input.cost (deprecated v1 path) wins; otherwise price the
    // task's own bridge token usage so the canonical completion path populates
    // IMTask.cost (every insights spend widget reads it). Falls back to the
    // existing value when there's no usage to price.
    const resolvedCost = input.cost ?? this.ownBridgeCost(task.metadata) ?? task.cost;

    const updated = await this.taskModel.update(taskId, {
      status: 'completed',
      completedAt: new Date(),
      result: mergedResult !== undefined ? JSON.stringify(mergedResult) : null,
      resultUri: input.resultUri,
      cost: resolvedCost,
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
      resultAssetIds: extractCompletionAssetIds({ result: mergedResult }),
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

    // release201/11 §4 #2 — emit task.completed metric. value = duration_ms.
    {
      const durationMs = task.createdAt ? Math.max(0, Date.now() - new Date(task.createdAt).getTime()) : 0;
      metricEmit({
        namespace: 'task',
        name: 'completed',
        value: durationMs,
        dims: {
          workspaceId: updated.workspaceId ?? '',
          taskId,
          capability: updated.capability ?? 'general',
          assigneeId: agentId,
          creatorId: updated.creatorId,
        },
      });
    }

    // Notify creator
    this.notifyUser(updated.creatorId, updated, 'task.completed').catch(() => {});

    // release201/08 §10.6 / S21 — skill-tryout sample task completion
    // emits `skill.authoring.sample_task_completed` so Studio Lifecycle rail
    // closes the sample-task lane. `metadata.skillId` is the link back to
    // the skill row (createBoilerplateTask sets it; see
    // skill-lifecycle.service.ts createBoilerplateTask). Best-effort: if
    // dep absent or skillId missing we no-op.
    if (this.deps.skillLifecycleService && updated.capability === 'skill-tryout') {
      try {
        const meta = parseMetadataObject(updated.metadata);
        const skillId = typeof meta.skillId === 'string' ? meta.skillId : null;
        if (skillId) {
          const resultRecord =
            input.result && typeof input.result === 'object' && !Array.isArray(input.result)
              ? (input.result as Record<string, unknown>)
              : {};
          const evidenceAssetIds = Array.isArray(resultRecord.assetIds)
            ? (resultRecord.assetIds as string[])
            : Array.isArray((meta as any).outputAssetIds)
              ? ((meta as any).outputAssetIds as string[])
              : [];
          void this.deps.skillLifecycleService
            .notifySampleTaskCompleted({
              skillId,
              sampleTaskId: taskId,
              passed: true,
              evidenceAssetIds,
            })
            .catch((err) => log.warn(`sample_task_completed emit failed for ${taskId}: ${(err as Error).message}`));
        }
      } catch (err) {
        log.warn(`sample_task_completed dispatch failed: ${(err as Error).message}`);
      }
    }

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

    // 2026-05-22 — same outbox asset rollup as completeTask (see comment
    // above). Shell-route completion goes through this branch when the
    // daemon owns the runtime; both paths must converge on the same
    // result.assetIds projection.
    const mergedResult = mergeResultWithOutputAssetIds(input.result, this.parseJson(task.metadata));

    // Cost: explicit input.cost (deprecated v1 path) wins; otherwise price the
    // task's own bridge token usage so the canonical completion path populates
    // IMTask.cost (every insights spend widget reads it). Falls back to the
    // existing value when there's no usage to price.
    const resolvedCost = input.cost ?? this.ownBridgeCost(task.metadata) ?? task.cost;

    const updated = await this.taskModel.update(taskId, {
      status: 'completed',
      completedAt: new Date(),
      result: mergedResult !== undefined ? JSON.stringify(mergedResult) : null,
      resultUri: input.resultUri,
      cost: resolvedCost,
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
      resultAssetIds: extractCompletionAssetIds({ result: mergedResult }),
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

    // No more retries — mark as failed. A failed run still burnt tokens, so
    // record its bridge cost (insights / task detail read IMTask.cost).
    const updated = await this.taskModel.update(taskId, {
      status: 'failed',
      error: input.error,
      cost: this.ownBridgeCost(task.metadata) ?? task.cost,
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

    // release201/11 §4 #3 — emit task.failed metric (terminal failures only).
    metricEmit({
      namespace: 'task',
      name: 'failed',
      value: 1,
      dims: {
        workspaceId: updated.workspaceId ?? '',
        taskId,
        capability: updated.capability ?? 'general',
        assigneeId: agentId,
        creatorId: updated.creatorId,
        errorCode: parseRetryableErrorCode(input.metadata) ?? 'unknown',
      },
    });

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
      result: input.result !== undefined ? JSON.stringify(input.result) : null,
      completedAt: new Date(),
      // A failed run still burnt tokens — record its bridge cost.
      cost: this.ownBridgeCost(task.metadata) ?? task.cost,
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
  // release201/11 §8b — task-bound metric snapshot
  // ═══════════════════════════════════════════════════════════

  /**
   * Update one entry of `IMTask.metadata.metricsSnapshot[]` (§8b) and emit a
   * `task.metric.snapshot_updated` metric event so the global aggregate path
   * sees the change in lockstep with the task-local snapshot (the snapshot
   * is a derived "current state" view; the event is the audit log).
   *
   * Caller TODO (deferred to v2.0.8 — §0.2.5 联合验收 #10): there is no
   * upstream endpoint or scheduler that currently invokes this method.
   * Wiring options under consideration:
   *   - acceptance verifier finish → recompute snapshot + call this
   *   - asset_analysis cron → push computed `current` values
   *   - SDK `client.tasks.updateMetricSnapshot({...})` admin path
   *
   * v2.0.7 (THIS SESSION) lands only the emit path so consumers can wire
   * any of those producers without re-touching task.service. The shape of
   * `TaskMetricSnapshot` matches release201/11 §8b verbatim.
   *
   * Behaviour:
   *   - If `taskId` has no metadata.metricsSnapshot yet, the entry is
   *     created (new array with this single item).
   *   - If an entry with the same `metricId` exists, it is replaced
   *     in-place. `lastUpdatedAt` is set to now() server-side.
   *   - Always emits ONE `task.metric.snapshot_updated` event with
   *     value_string = status. dims include workspaceId, taskId,
   *     metricId, name.
   *   - Returns the updated snapshot entry (caller may want the
   *     normalised view).
   */
  async updateTaskMetricSnapshot(
    taskId: string,
    snapshot: {
      id: string;
      name: string;
      target: string | number | boolean;
      unit?: string;
      source: 'manual' | 'task_result' | 'asset_analysis' | 'external';
      current?: string | number | boolean | null;
      status: 'unknown' | 'passing' | 'failing';
    },
  ): Promise<{
    id: string;
    name: string;
    status: 'unknown' | 'passing' | 'failing';
    lastUpdatedAt: string;
  }> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const meta = this.parseJson(task.metadata);
    const existing = Array.isArray((meta as Record<string, unknown>).metricsSnapshot)
      ? ((meta as Record<string, unknown>).metricsSnapshot as Array<Record<string, unknown>>)
      : [];

    const nowIso = new Date().toISOString();
    const normalisedEntry = {
      id: snapshot.id,
      name: snapshot.name,
      target: snapshot.target,
      ...(snapshot.unit !== undefined ? { unit: snapshot.unit } : {}),
      source: snapshot.source,
      ...(snapshot.current !== undefined ? { current: snapshot.current } : {}),
      status: snapshot.status,
      lastUpdatedAt: nowIso,
    };

    let replaced = false;
    const merged = existing.map((entry) => {
      if (entry && typeof entry === 'object' && (entry as { id?: unknown }).id === snapshot.id) {
        replaced = true;
        return normalisedEntry;
      }
      return entry;
    });
    if (!replaced) merged.push(normalisedEntry);

    const nextMeta = { ...meta, metricsSnapshot: merged };
    await this.taskModel.update(taskId, { metadata: JSON.stringify(nextMeta) });

    // release201/11 §4 #16 — emit `task.metric.snapshot_updated`. value_string
    // is the status enum; dims carry the four required keys (workspaceId,
    // taskId, metricId, name).
    metricEmit({
      namespace: 'task.metric',
      name: 'snapshot_updated',
      value: snapshot.status,
      dims: {
        workspaceId: task.workspaceId ?? '',
        taskId,
        metricId: snapshot.id,
        name: snapshot.name,
      },
    });

    return {
      id: snapshot.id,
      name: snapshot.name,
      status: snapshot.status,
      lastUpdatedAt: nowIso,
    };
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
  // Phase-level heartbeat (v2.0 §4.2 Track B-1)
  // ═══════════════════════════════════════════════════════════

  /**
   * Record a per-task phase heartbeat from a daemon.
   *
   * Writes `lastHeartbeatAt` + `heartbeatVersion` + `currentPhase` columns —
   * **never touches `status`**. Per §4.2 + §12.4 contract, `currentPhase`
   * is a UI/observability signal decoupled from the canonical state machine.
   *
   * Heartbeats with a `heartbeatVersion` strictly older than the persisted
   * value are dropped (last-write-wins reconciliation; protects against
   * out-of-order WS delivery after reconnect).
   *
   * When the previous phase was `'stuck'` (written by the reaper) and the
   * new heartbeat arrives with a non-stuck phase, the value is replaced —
   * this is the natural "daemon resumed" recovery path; no force-transition
   * required.
   *
   * Returns `null` when:
   *   - Task not found
   *   - Heartbeat version is stale
   *   - Task is in a terminal status (`completed`/`failed`/`cancelled`) —
   *     heartbeats are only meaningful for `running`/`review`
   */
  async recordTaskHeartbeat(
    taskId: string,
    input: {
      heartbeatVersion: number;
      currentPhase: string;
      lastStepAt?: Date | number | string | null;
    },
  ): Promise<{
    taskId: string;
    currentPhase: string;
    heartbeatVersion: number;
    lastHeartbeatAt: Date;
    recoveredFromStuck: boolean;
  } | null> {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        currentPhase: true,
        heartbeatVersion: true,
        conversationId: true,
        creatorId: true,
        assigneeId: true,
      },
    });
    if (!task) return null;

    // Heartbeats only meaningful while task is alive. Terminal statuses are
    // silently no-op so a late retry doesn't resurrect phase signals.
    if (!['running', 'review', 'assigned', 'pending', 'blocked'].includes(task.status)) {
      return null;
    }

    // Last-write-wins reconciliation. Older heartbeats are dropped silently
    // (daemon will retry with a bumped version next tick).
    const persistedVersion =
      typeof task.heartbeatVersion === 'bigint' ? Number(task.heartbeatVersion) : (task.heartbeatVersion ?? 0);
    if (typeof input.heartbeatVersion === 'number' && input.heartbeatVersion < persistedVersion) {
      return null;
    }

    const recoveredFromStuck = task.currentPhase === 'stuck' && input.currentPhase !== 'stuck';
    const now = new Date();

    await prisma.iMTask.update({
      where: { id: taskId },
      data: {
        lastHeartbeatAt: now,
        heartbeatVersion: BigInt(Math.max(input.heartbeatVersion ?? 0, persistedVersion + 1)),
        currentPhase: input.currentPhase,
        // Crucial: do NOT touch `status`. Phase is a sibling signal.
      },
    });

    // Surface recovery to the UI so a "stuck" badge can clear immediately
    // rather than waiting for the next polling tick.
    if (recoveredFromStuck && this.deps.syncService) {
      const recipient = task.assigneeId ?? task.creatorId;
      await this.deps.syncService
        .writeEvent(
          'task.phase.recovered',
          { taskId, currentPhase: input.currentPhase, heartbeatVersion: persistedVersion + 1 },
          task.conversationId,
          recipient,
        )
        .catch((err) => log.warn({ err, taskId }, 'task.phase.recovered writeEvent failed (non-fatal)'));
    }

    return {
      taskId,
      currentPhase: input.currentPhase,
      heartbeatVersion: Math.max(input.heartbeatVersion ?? 0, persistedVersion + 1),
      lastHeartbeatAt: now,
      recoveredFromStuck,
    };
  }

  /**
   * Reaper sibling to {@link handleTimeouts}. Scans for tasks whose daemon
   * has gone silent for longer than `cutoffMs` (default 45s) and writes
   * `currentPhase='stuck'` — **does NOT** touch `status` or trigger retry.
   *
   * Co-existence with `handleTimeouts` (per §4.2 协同矩阵 + §12.4):
   *   - `handleTimeouts` operates on `task.timeoutMs` (default 5min) and is
   *     the final authority for moving status `running → pending|failed`.
   *   - `sweepStuckPhases` operates on `lastHeartbeatAt` (45s) and only
   *     writes the phase signal column. The two cannot race on the same row
   *     because they edit disjoint columns.
   *
   * Daemon reconnect naturally clears the stuck marker via
   * {@link recordTaskHeartbeat} (recoveredFromStuck path).
   */
  async sweepStuckPhases(opts: { cutoffMs?: number; limit?: number } = {}): Promise<number> {
    const cutoffMs = opts.cutoffMs ?? 45_000;
    const limit = opts.limit ?? 100;
    const cutoff = new Date(Date.now() - cutoffMs);

    const stuck = await prisma.iMTask.findMany({
      where: {
        status: { in: ['running', 'review'] },
        lastHeartbeatAt: { lt: cutoff },
        // currentPhase != 'stuck' AND currentPhase != null
        // (Prisma can't express NOT NULL combined with != on the same field
        // in one clause, so we filter NULL manually below.)
        NOT: { currentPhase: 'stuck' },
      },
      take: limit,
      select: {
        id: true,
        conversationId: true,
        creatorId: true,
        assigneeId: true,
        lastHeartbeatAt: true,
        currentPhase: true,
      },
    });

    let marked = 0;
    for (const t of stuck) {
      // Skip rows that have never received a heartbeat — the reaper only
      // flags daemons that *were* talking and went silent, not tasks the
      // daemon never picked up (those are handleTimeouts' problem).
      if (!t.lastHeartbeatAt) continue;
      try {
        await prisma.iMTask.update({
          where: { id: t.id },
          data: { currentPhase: 'stuck' },
          // Status column intentionally untouched.
        });
        if (this.deps.syncService) {
          await this.deps.syncService
            .writeEvent(
              'task.phase.stuck',
              {
                taskId: t.id,
                lastHeartbeatAt: t.lastHeartbeatAt.toISOString(),
                previousPhase: t.currentPhase,
              },
              t.conversationId,
              t.assigneeId ?? t.creatorId,
            )
            .catch((err) => log.warn({ err, taskId: t.id }, 'task.phase.stuck writeEvent failed (non-fatal)'));
        }
        marked++;
      } catch (err) {
        log.error({ err, taskId: t.id }, 'sweepStuckPhases update failed');
      }
    }

    return marked;
  }

  /**
   * Reaper for tasks that were `status='assigned'` but the daemon never
   * acknowledged the dispatch frame — i.e. `lastHeartbeatAt IS NULL` AND
   * `lastRunAt IS NULL` AND assignment is older than `cutoffMs`.
   *
   * Gap context (2026-05-23 forensic): `sweepStuckPhases` deliberately
   * skips never-heartbeated rows ("daemon never picked up = handleTimeouts'
   * problem") and `handleTimeouts → findTimedOutTasks` only scans
   * `status='running'`. So `assigned` tasks where the daemon was offline at
   * dispatch time fall through both reapers and pile up indefinitely.
   * Empirically 20+ such rows from 2026-04 still sat at `status='assigned'`
   * in test on 2026-05-23.
   *
   * Behaviour: marks `status='failed'` with `error='daemon-never-acknowledged'`.
   * Does NOT retry — the assignee was offline at dispatch time and there's
   * no signal another retry would succeed; pushing back to `pending` would
   * loop forever if the workspace has no working daemon.
   *
   * Refunds escrow + emits `task.failed` event so the UI clears typing/pill
   * indicators that hydrate off `status IN ('running','assigned',...)`.
   */
  async failNeverDispatchedTasks(opts: { cutoffMs?: number; limit?: number } = {}): Promise<number> {
    const cutoffMs = opts.cutoffMs ?? 30 * 60 * 1000; // 30min default
    const limit = opts.limit ?? 50;
    const cutoff = new Date(Date.now() - cutoffMs);

    const orphans = await prisma.iMTask.findMany({
      where: {
        status: 'assigned',
        lastHeartbeatAt: null,
        lastRunAt: null,
        createdAt: { lt: cutoff },
      },
      take: limit,
      select: {
        id: true,
        conversationId: true,
        creatorId: true,
        assigneeId: true,
        capability: true,
        metadata: true,
        error: true,
        timeoutMs: true,
      },
    });

    let failed = 0;
    for (const t of orphans) {
      const error = `daemon-never-acknowledged (assigned > ${Math.round(cutoffMs / 60_000)}min ago, no heartbeat, no run)`;
      try {
        await this.taskModel.update(t.id, {
          status: 'failed',
          error,
        });

        await this._refundEscrow(t as Parameters<typeof this._refundEscrow>[0], 'never-dispatched');

        await this.taskModel.createLog({
          taskId: t.id,
          action: 'failed',
          message: error,
        });

        if (this.deps.syncService) {
          await this.deps.syncService
            .writeEvent(
              'task.failed',
              { taskId: t.id, error, reason: 'never-dispatched' },
              t.conversationId,
              t.assigneeId ?? t.creatorId,
            )
            .catch((err) => log.warn({ err, taskId: t.id }, 'task.failed writeEvent failed (non-fatal)'));
        }

        this.notifyUser(t.creatorId, t as Parameters<typeof this.notifyUser>[1], 'task.failed').catch(() => {});

        failed++;
      } catch (err) {
        log.error({ err, taskId: t.id }, 'failNeverDispatchedTasks update failed');
      }
    }

    return failed;
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
      // T8 §08 §5.2 — image resolution via the canonical image-pin module
      // (honors CONTAINER_IMAGE env first, then infra/sandbox-image/image-
      // pin.yaml canonical). Removes the dead `daemon-v1.0` hardcoded
      // fallback that pre-T8 left task lifecycle pod creation failing with
      // ImagePullBackOff when both env vars were unset (default in local dev).
      const sandboxImage = getDaemonImage();

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
    let pushed = true;
    try {
      this.deps.rooms.sendToUser(routeKey, ServerEvents.taskDispatchRequest(payload, task.id));
    } catch (err) {
      pushed = false;
      log.warn(`task.dispatch.request push failed for ${routeKey}: ${(err as Error).message}`);
    }

    // 2026-05-28 (doc 21 §5.1) — emit dispatch.lifecycle 'received' so the
    // AgentStateStrip "N 活跃" counter flips immediately, without waiting for
    // the daemon's first phase_change step. Only fire when the frame
    // actually landed on a WS pipe (`pushed`) and we have a conversation
    // anchor — direct-message agent runs always carry conversationId via
    // task.metadata.triggerMessageId path; kanban-only tasks may not.
    if (pushed && task.conversationId && this.deps.syncService) {
      const recipient = task.creatorId ?? task.assigneeId ?? agentImUserId;
      void this.deps.syncService
        .writeEvent(
          'dispatch.lifecycle',
          {
            workspaceId: task.workspaceId ?? null,
            conversationId: task.conversationId,
            agentImUserId,
            dispatchId: task.id,
            lifecycle: 'received',
            occurredAt: Date.now(),
          },
          task.conversationId,
          recipient,
        )
        .catch((err) =>
          log.warn({ err, taskId: task.id }, 'dispatch.lifecycle(received) writeEvent failed (non-fatal)'),
        );
    }

    // 2026-05-22 — kanban "stuck at assigned" fix. Once the dispatch frame
    // actually lands on the daemon's WS pipe, advance task.status from
    // 'assigned' → 'running' so the kanban card flips out of the assignee
    // column without the agent having to first emit a synthetic
    // progress=0.1 just to trigger the legacy transition in updateTask().
    //
    // Guarded:
    //   - Only the "real task" path. Run-style dispatches (kind=agent_run)
    //     transition their own IMTaskRun.status separately and shouldn't
    //     mutate the parent task here.
    //   - Idempotent — predicate update (status='assigned') so a retry never
    //     bumps a task that's already running/review/completed/failed.
    //   - Best-effort — failures are logged, never surfaced. The legacy
    //     progress-triggered fallback at updateTask() line 1559 remains the
    //     safety net.
    if (pushed && event === 'task.assigned') {
      const taskMetaForRunCheck = this.parseJson(task.metadata);
      const isAgentRunWrapper = taskMetaForRunCheck.kind === 'agent_run' && taskMetaForRunCheck.runId === task.id;
      if (!isAgentRunWrapper && task.status === 'assigned') {
        await this.autoTransitionAssignedToRunning(task.id).catch((err) =>
          log.warn(`auto-transition assigned→running failed for ${task.id}: ${(err as Error).message}`),
        );
      }
    }
  }

  /**
   * Idempotent system-actor transition `assigned → running`. Predicate
   * update ensures a retry / second dispatch frame never moves a task that
   * has already advanced (running/review/completed/failed/cancelled).
   *
   * Emits `task.run.started` on the EventBus + the SSE bus's
   * `task.assigned` channel so the kanban refreshes via the existing
   * task-stream hook (see workspace/page.tsx useTaskStream).
   */
  private async autoTransitionAssignedToRunning(taskId: string): Promise<void> {
    type UpdatedTask = {
      id: string;
      status: string;
      creatorId: string;
      assigneeId: string | null;
      conversationId: string | null;
      workspaceId: string | null;
      title: string;
      capability: string | null;
    };
    let updated: UpdatedTask | null = null;
    try {
      const row = await prisma.iMTask.update({
        where: { id: taskId, status: 'assigned' },
        data: { status: 'running' },
        select: {
          id: true,
          status: true,
          creatorId: true,
          assigneeId: true,
          conversationId: true,
          workspaceId: true,
          title: true,
          capability: true,
        },
      });
      updated = row as UpdatedTask;
    } catch {
      // P2025 RecordNotFound — already-transitioned, treat as no-op.
      return;
    }
    if (!updated) return;

    await this.taskModel
      .createLog({
        taskId,
        actorId: 'system',
        action: 'progress',
        message: 'Auto-transitioned to running on daemon dispatch',
      })
      .catch((err) => log.warn(`createLog failed for auto-transition ${taskId}: ${(err as Error).message}`));

    this.deps.eventBusService
      ?.publish({
        type: 'task.run.started',
        timestamp: Date.now(),
        data: {
          taskId,
          title: updated.title,
          capability: updated.capability,
          creatorId: updated.creatorId,
          assigneeId: updated.assigneeId,
          conversationId: updated.conversationId,
          trigger: 'dispatch-frame',
        },
      })
      .catch((err) => log.warn(`EventBus publish failed for task.run.started: ${(err as Error).message}`));
  }

  private async resolveAgentDaemonRoute(agentImUserId: string): Promise<DaemonRouteResolution> {
    // v2.0 §4.8.2 (Wave 2-B2) — `im_agent_bindings.boundDaemonId` is the
    // authoritative ownership source for dispatch. The legacy
    // im_agent_cards.metadata.daemonId path is kept as a fallback ONLY for
    // agents that have not yet had a host.declare since migration 410 was
    // applied (binding row absent). Once a binding exists for an agent, we
    // route to its `boundDaemonId` — even if metadata says something else,
    // even if the binding is contested. That's the whole point of R7:
    // dispatch goes to the OWNER, never to the contender.
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentImUserId },
      select: { metadata: true, workspaceId: true },
    });
    const wsCard = card
      ? await prisma.iMWorkspace.findFirst({
          where: { id: card.workspaceId, deletedAt: null },
          select: { id: true, metadata: true },
        })
      : null;

    // Primary path: binding table.
    try {
      const binding = await prisma.iMAgentBinding.findUnique({
        where: { agentImUserId },
        select: { boundDaemonId: true },
      });
      if (binding?.boundDaemonId) {
        const daemonId = binding.boundDaemonId.trim();
        if (wsCard && isDaemonForgotten(wsCard.metadata, daemonId)) {
          return { kind: 'forgotten', daemonId, workspaceId: wsCard.id };
        }
        return { kind: 'active', daemonId, workspaceId: wsCard?.id ?? card?.workspaceId ?? null };
      }
    } catch (err) {
      // If im_agent_bindings query fails (migration not yet applied in
      // some env, transient DB blip), fall through to legacy metadata path
      // and emit a warn so the bug is visible in logs.
      log.warn(
        `[task.service] im_agent_bindings lookup failed for ${agentImUserId} — falling back to metadata: ${(err as Error).message}`,
      );
    }

    // Fallback: legacy metadata.daemonId. Emit a warn so we can quantify
    // how many dispatches are still using the legacy path post-deploy
    // (jasonzhou-class bug returns if this path stays dominant — see
    // §4.8.2 Wave 2-B2 hand-off note).
    if (!card?.metadata) return { kind: 'none' };
    try {
      const meta = JSON.parse(card.metadata) as { daemonId?: unknown };
      const daemonId = typeof meta.daemonId === 'string' && meta.daemonId.trim() ? meta.daemonId.trim() : '';
      if (!daemonId) return { kind: 'none' };
      log.warn(
        `[task.service] dispatch falling back to metadata.daemonId for ${agentImUserId} (no im_agent_bindings row); install Wave 2-B2 binding row by triggering host.declare`,
      );
      if (wsCard && isDaemonForgotten(wsCard.metadata, daemonId)) {
        return { kind: 'forgotten', daemonId, workspaceId: wsCard.id };
      }
      return { kind: 'active', daemonId, workspaceId: wsCard?.id ?? card.workspaceId ?? null };
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
      const requested = {
        requested: refs.length,
        requestedRefs: refs.map((r) => ({ assetId: r.assetId, mime: r.mime, sizeBytes: r.sizeBytes, kind: r.kind })),
      };
      const stampMetadata = (metadata: string | null | undefined) => {
        let prev: Record<string, unknown> = {};
        try {
          prev = JSON.parse(metadata ?? '{}');
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
          ...requested,
        };
        return JSON.stringify({ ...prev, observability });
      };

      const row = await prisma.iMTask.findUnique({
        where: { id: taskId },
        select: { metadata: true },
      });
      if (row) {
        await prisma.iMTask.update({
          where: { id: taskId },
          data: { metadata: stampMetadata(row.metadata) },
        });
        return;
      }

      const runRow = await prisma.iMTaskRun.findUnique({
        where: { id: taskId },
        select: { metadata: true },
      });
      if (!runRow) return;
      await prisma.iMTaskRun.update({
        where: { id: taskId },
        data: { metadata: stampMetadata(runRow.metadata) },
      });
    } catch (err) {
      log.warn(`failed to record asset observability for task ${taskId}: ${(err as Error).message}`);
    }
  }

  /**
   * Wave 3.5 W1 — Manually re-dispatch a stuck task to its bound daemon.
   *
   * Triggered by the chat panel's "重试 dispatch" button on a TaskDigestCard
   * marked stuck (§4.4.6). Pre-conditions:
   *   - task exists
   *   - task.status === 'running' AND task.currentPhase === 'stuck'
   *     (caller cannot retry tasks that are already done or never started)
   *   - actor passes §15 task-permission matrix (owner / admin / orchestrator
   *     / creator — assignee/observer denied because retry IS a control op)
   *
   * Re-uses `emitDaemonDispatchRequest` which already:
   *   - resolves the bound daemon via §4.8.2 binding (R7 owner, not contender)
   *   - dedupes server-side via requestId === task.id (daemon's running_tasks)
   *   - falls back to markPendingDispatch when daemon offline
   *
   * §4.3 two-phase commit idempotency is provided by the daemon: same task.id
   * + same idempotencyKey → daemon ignores duplicate. We pass `optReason`
   * through the task log only; the dispatch payload itself is unchanged.
   *
   * Returns the (unchanged) task. Caller emits the SSE/UI signal.
   */
  async retryDispatchTask(taskId: string, actorId: string, opts: { reason?: string } = {}): Promise<TaskInfo> {
    const task = await this.taskModel.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Pre-condition: must be running + stuck. Reject otherwise so callers
    // see a clear 409 instead of silently re-firing dispatch on a task that
    // is e.g. already completed (which would race with the daemon's view).
    if (task.status !== 'running') {
      throw new TaskStateError(taskId, task.status, 'running (retry-dispatch requires running task)');
    }
    if (task.currentPhase !== 'stuck') {
      throw new TaskStateError(
        taskId,
        `currentPhase=${task.currentPhase ?? 'null'}`,
        'stuck (retry-dispatch requires phase=stuck)',
      );
    }

    // Permission gate — re-use §15 matrix via resolveTaskMutationPermission.
    // We model retry as a 'transition' from 'running' → 'running' (a no-op
    // edge that exists ONLY for permission purposes — DOES NOT call
    // transitionTask). 'running → running' is not in TRANSITIONS, so we
    // route through the simpler "creator/orchestrator/owner/admin" gate
    // directly using loadTaskActor for tier resolution.
    if (!task.workspaceId) {
      // Without workspace context the matrix can't resolve orchestrator tier.
      // Fall back to creator-only allowance (legacy single-tenant path).
      if (task.creatorId !== actorId) {
        throw new TaskAccessError(taskId, 'only the task creator may retry dispatch (no workspace)');
      }
    } else {
      const actor = await loadTaskActor(actorId, task.workspaceId);
      if (!actor) {
        throw new TaskAccessError(taskId, 'actor not found');
      }
      const isCreator = task.creatorId === actorId;
      const isOwner = actor.type === 'human' && actor.role === 'owner';
      const isAdmin = actor.type === 'human' && actor.role === 'admin';
      const isAdminTrust = actor.trustTier >= 4;
      const isOrch =
        actor.type === 'agent' && (await isOrchestratorOf(task.workspaceId, actor.id, { includeLegacyFallback: true }));
      if (!(isCreator || isOwner || isAdmin || isAdminTrust || isOrch)) {
        throw new TaskAccessError(taskId, 'only creator / orchestrator / owner / admin may retry dispatch');
      }
    }

    if (!task.assigneeId) {
      throw new TaskStateError(taskId, 'unassigned', 'assigned (retry-dispatch requires an assignee)');
    }

    // Fire the dispatch. Same path that initial dispatch / heartbeat reaper
    // re-arm / approval-decided redispatch use — daemon dedupes by task.id.
    await this.emitDaemonDispatchRequest(task.assigneeId, task, 'task.assigned');

    await this.taskModel.createLog({
      taskId,
      actorId,
      action: 'retry-dispatch',
      message: opts.reason ?? 'manual retry-dispatch from chat panel',
      metadata: JSON.stringify({
        triggeredBy: actorId,
        previousPhase: task.currentPhase,
        reason: opts.reason ?? null,
      }),
    });

    log.info(`[Wave3.5-W1] retry-dispatch taskId=${taskId} actor=${actorId} assignee=${task.assigneeId}`);
    return this.toTaskInfo(task);
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
      const taskMeta = this.parseJson(task.metadata);
      if (this.isProjectionTaskKind(this.taskKind(taskMeta))) {
        continue;
      }
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
  /**
   * P9 (release 200 §9) — surface the task's latest state into its linked
   * conversation as a **single rolling digest message** (one message per
   * task, mutated in place across transitions). Replaces the pre-P9
   * `task_status_event` per-terminal-event row.
   *
   * The dual path is intentional:
   *   1. Chat → digest upsert (the visible "Task X is now Y" surface).
   *   2. Inbox bell → `pc_notifications` row via `emitTaskStatusNotification`
   *      (independent path; the bell remains the actionable inbox).
   *
   * Keeping the legacy name + signature avoids touching ~9 internal
   * call-sites and the test mocks; semantically this is now "upsert digest
   * + ring bell" rather than "post status chip + ring bell".
   *
   * `from` is optional; when present it lets the digest payload encode the
   * full transition (helps the renderer show "review → completed" etc).
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
      workspaceId?: string | null;
    },
    status: 'completed' | 'failed' | 'cancelled',
    opts: {
      error?: string | null;
      output?: string | null;
      by?: string | null;
      from?: DigestStatus | null;
      /**
       * B-line — task-bound deliverable asset IDs rolled up at completion
       * (from `task.result.assetIds` / `metadata.outputAssetIds`). When
       * present + non-empty the digest card surfaces a "N 个产物 →" chip
       * routing to the drawer Artifacts tab instead of inline output text.
       */
      resultAssetIds?: string[] | null;
    } = {},
  ): Promise<void> {
    if (!task.conversationId) return;

    // B-line — resolve lightweight refs for the deliverable assets so the
    // chat card can render filename/mime without a follow-up /assets query.
    // Best-effort: a failed lookup just degrades to count-only (or zero).
    let resultAssetCount: number | null = null;
    let resultAssets: { assetId: string; filename?: string | null; mime?: string | null }[] | null = null;
    // Dedup defensively (callers already dedup, but the chip/count must never
    // double-count a repeated id) before any DB lookup.
    const assetIds = Array.from(
      new Set((opts.resultAssetIds ?? []).filter((v) => typeof v === 'string' && v.length > 0)),
    );

    // release201/3x — "任务结果 = asset" 兜底。On completion, when the task
    // produced NO file deliverable but DID answer with substantive inline
    // markdown (CEO / advisor roles), materialize that text into a task-bound
    // markdown IMAsset so the产物列表 / drawer Artifacts / editor light up
    // automatically. Strictly gated (status, no deliverables, ≥ threshold,
    // idempotent) inside the materializer; best-effort (never throws). When it
    // creates an asset we fold its id into `assetIds` so THIS digest's
    // resultAssetCount/resultAssets reflect it without a follow-up re-emit.
    if (status === 'completed') {
      try {
        const { materializeTaskResultIfNeeded } = await import('./result-materializer');
        const outcome = await materializeTaskResultIfNeeded({
          taskId: task.id,
          output: opts.output ?? null,
          existingResultAssetIds: assetIds,
        });
        if (outcome.assetId && !assetIds.includes(outcome.assetId)) {
          assetIds.push(outcome.assetId);
        }
      } catch (err) {
        log.warn(`emitTaskStatusChat result materialize failed for task ${task.id}: ${(err as Error).message}`);
      }
    }
    if (assetIds.length > 0) {
      // Best-effort: degrade to the raw id count if the count query fails,
      // matching the ref-lookup degrade below.
      resultAssetCount = assetIds.length;
      try {
        // B-line — `resultAssetCount` must reflect assets that actually still
        // exist (the ref `findMany` already filters `deletedAt: null`, but it
        // only fetches the first 4). A deleted output asset would otherwise
        // make the chip claim "3 个产物" while the drawer shows 2. Count the
        // live rows independently so chip count == drawer reality.
        resultAssetCount = await prisma.iMAsset.count({
          where: { id: { in: assetIds }, deletedAt: null },
        });
      } catch (err) {
        log.warn(`emitTaskStatusChat asset count failed for task ${task.id}: ${(err as Error).message}`);
      }
      try {
        const rows = await prisma.iMAsset.findMany({
          where: { id: { in: assetIds.slice(0, 4) }, deletedAt: null },
          select: { id: true, filename: true, mime: true },
        });
        const byId = new Map(rows.map((r: { id: string; filename: string | null; mime: string | null }) => [r.id, r]));
        resultAssets = assetIds
          .slice(0, 4)
          .map((id) => byId.get(id))
          .filter((r): r is { id: string; filename: string | null; mime: string | null } => Boolean(r))
          .map((r) => ({ assetId: r.id, filename: r.filename, mime: r.mime }));
        if (resultAssets.length === 0) resultAssets = null;
      } catch (err) {
        log.warn(`emitTaskStatusChat asset ref lookup failed for task ${task.id}: ${(err as Error).message}`);
      }
    }

    await this.taskDigestService.upsertTaskDigest(
      {
        id: task.id,
        title: task.title,
        conversationId: task.conversationId,
        creatorId: task.creatorId,
        assigneeId: task.assigneeId,
        workspaceId: task.workspaceId ?? null,
      },
      {
        from: opts.from ?? null,
        to: status,
        by: opts.by ?? null,
        reason: opts.error ?? null,
        error: opts.error ?? null,
        outputPreview: opts.output ?? null,
        resultAssetCount,
        resultAssets,
      },
    );

    // Wave-8 W9 — bell drawer fan-out (untouched by P9). The creator's
    // inbox bell remains the actionable surface; the digest only affects
    // the chat timeline.
    void emitTaskStatusNotification({
      taskId: task.id,
      title: task.title,
      recipientImUserId: task.creatorId,
      status,
      error: opts.error ?? null,
      conversationId: task.conversationId ?? null,
      workspaceId: task.workspaceId ?? null,
    });
    void this.fanOutBellSync(task.creatorId, `task.${status}`, {
      taskId: task.id,
      title: task.title,
      status,
    });
  }

  /**
   * WS2 (release201/3x) — re-emit the rolling completion digest for a task
   * that is **already in a terminal state**, picking up late-arriving /
   * orphan deliverable assets that landed in `metadata.outputAssetIds` after
   * the task closed.
   *
   * Why this exists: a task's `task_digest` chat card snapshots
   * `resultAssetCount` / `resultAssets` at the moment the lifecycle wrote
   * `completed` / `failed`. But the daemon outbox can flush an asset *after*
   * that write (daemon dispatch.ts "uploaded but unflushed"); POST /assets
   * then appends the id to `metadata.outputAssetIds`, surfacing it in the
   * drawer Artifacts tab — yet the chat digest never updated, undercounting.
   * This method re-derives the asset set from the persisted task row and
   * re-`upsert`s the same rolling digest message (no new message — see
   * TaskDigestService.upsertTaskDigest, which reuses the existing row by
   * taskId), so chat eventually matches the drawer.
   *
   * Reuses `emitTaskStatusChat` verbatim — same live-row asset count
   * (`prisma.iMAsset.count({ deletedAt: null })`) and ref derivation — so
   * there is no second copy of the count/refs parsing to drift.
   *
   * Idempotent + best-effort:
   *  - Loads the task row; no-ops if the task is missing, has no linked
   *    conversation, or is NOT in a terminal status (we only ever *update* an
   *    existing terminal digest, never resurrect a running task's card).
   *  - Re-deriving from the same persisted row yields the same digest payload
   *    when nothing changed, so repeated calls converge (the upsert just
   *    re-writes identical content).
   *  - Callers are expected to wrap in `.catch` — a digest re-emit must never
   *    roll back the asset upload that triggered it.
   */
  /**
   * release202/09 P1 — kanban sync for the cli-send / message-attach delivery
   * path. The POST /assets sandbox-output branch wires the kanban card by
   * (1) appending the new assetId to `task.metadata.outputAssetIds` and
   * (2) re-emitting the terminal digest so the chat card / drawer catch up
   * (see assets.ts `rollupAndReemitDigest`). The cli-send path
   * (`deriveFileMessageAttachment`) creates the IMAsset directly and never hit
   * that rollup, so a `cloud file send` deliverable never reached the card.
   *
   * This method mirrors that rollup from the services layer (so message.service
   * stays inside its layer instead of importing the api/ helper): append +
   * reemit. The append is idempotent (skips when the id is already listed);
   * the reemit self-gates on terminal status. Best-effort — callers wrap in
   * `.catch` so a kanban-sync miss never rolls back the message send.
   *
   * `taskId` here may be a task id OR a run id (same id shape); we update
   * whichever row exists.
   */
  async linkOutputAssetAndReemitDigest(taskOrRunId: string, assetId: string): Promise<void> {
    const appended = await this.appendOutputAssetIdToTaskRow(taskOrRunId, assetId);
    if (!appended) return;
    await this.reemitTerminalDigestForAssetArrival(taskOrRunId);
  }

  /**
   * Append `assetId` to `IMTask.metadata.outputAssetIds`. Idempotent: returns
   * false (no reemit needed) when the id is already present or the task row is
   * missing. Mirrors assets.ts `appendOutputAssetIdToTask`.
   */
  private async appendOutputAssetIdToTaskRow(taskId: string, assetId: string): Promise<boolean> {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { metadata: true },
    });
    if (!task) return false;

    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(task.metadata || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed metadata — treat as empty so the new id is not lost
    }

    const existing = Array.isArray(meta.outputAssetIds)
      ? (meta.outputAssetIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    if (existing.includes(assetId)) return false; // idempotent

    await prisma.iMTask.update({
      where: { id: taskId },
      data: { metadata: JSON.stringify({ ...meta, outputAssetIds: [...existing, assetId] }) },
    });
    return true;
  }

  async reemitTerminalDigestForAssetArrival(taskId: string): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return;
    if (!task.conversationId) return;

    // Only re-emit for terminal states that own a digest. Non-terminal
    // transitions are driven by the lifecycle itself; a late asset never
    // changes a task's status, only its deliverable set.
    const terminal = task.status as DigestStatus;
    if (terminal !== 'completed' && terminal !== 'failed' && terminal !== 'cancelled') return;

    // Re-derive the deliverable asset IDs from the persisted row — union of
    // the canonical `result.assetIds` projection and the outbox rollup in
    // `metadata.outputAssetIds` (the column POST /assets just appended to).
    const assetIds = extractCompletionAssetIds({
      result: this.parseJson(task.result),
      metadata: task.metadata,
    });

    await this.emitTaskStatusChat(task, terminal, {
      // `from === to` marks a same-state refresh (asset arrival), not a real
      // lifecycle transition — keeps the digest's latestTransition honest
      // instead of fabricating a `null → completed` re-transition.
      from: terminal,
      resultAssetIds: assetIds,
    });
  }

  /**
   * P9 — emit a digest for **non-terminal** transitions (assigned, running,
   * review, blocked, pending). Called from `applyTransitionSideEffects`
   * after the DB write so the chat surface picks up "task is now in review"
   * etc. — pre-P9 these states had no chat representation at all.
   *
   * Bell drawer notifications for these states (e.g. approval_requested for
   * review) are handled separately by the matrix `notify-*` side effects so
   * we do NOT double-ring here.
   */
  private async emitTaskNonTerminalDigest(
    task: {
      id: string;
      title: string;
      conversationId: string | null;
      assigneeId: string | null;
      creatorId: string;
      workspaceId?: string | null;
    },
    from: DigestStatus,
    to: DigestStatus,
    opts: { by?: string | null; reason?: string | null } = {},
  ): Promise<void> {
    if (!task.conversationId) return;
    await this.taskDigestService.upsertTaskDigest(
      {
        id: task.id,
        title: task.title,
        conversationId: task.conversationId,
        creatorId: task.creatorId,
        assigneeId: task.assigneeId,
        workspaceId: task.workspaceId ?? null,
      },
      {
        from,
        to,
        by: opts.by ?? null,
        reason: opts.reason ?? null,
      },
    );
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

  /**
   * Derive the credits spent on an agent run from its bridge token usage.
   *
   * Adapters (hermes / codex / claude-code) stash per-run token counts at
   * `metadata.bridge.<adapter>.usage = { inputTokens, outputTokens,
   * cacheReadTokens?, cacheWriteTokens? }` plus a `model` string (see
   * runtime `sessions-sse.ts`). We price that through the shared cost-plus
   * table in `lib/llm-pricing.ts` so the value matches the LLM-proxy billing
   * the user is charged elsewhere. Returns 0 when no usable usage is present.
   *
   * This is the ONLY place IMTask.cost gets populated on the canonical
   * task lifecycle — completeTask's explicit `body.cost` is the deprecated
   * v1 path. Cockpit / project / agent insights all read IMTask.cost, so a
   * miss here keeps every spend widget at 0.
   */
  private computeRunCostCredits(bridge: Record<string, unknown>): number {
    let total = 0;
    for (const entry of Object.values(bridge)) {
      const adapter = this.readObject(entry);
      const usage = this.readObject(adapter.usage);
      const input = Number(usage.inputTokens ?? 0) || 0;
      const output = Number(usage.outputTokens ?? 0) || 0;
      const cached = Number(usage.cacheReadTokens ?? 0) || 0;
      if (input <= 0 && output <= 0) continue;
      const model = typeof adapter.model === 'string' && adapter.model.trim() ? adapter.model.trim() : 'unknown';
      const { credits } = calculateLLMCredits(model, {
        prompt_tokens: input,
        completion_tokens: output,
        prompt_tokens_details: cached > 0 ? { cached_tokens: cached } : undefined,
      });
      total += credits;
    }
    return Math.round(total * 10000) / 10000;
  }

  /**
   * Cost (credits) a task accrued from its OWN bridge token usage, for use
   * at the task's terminal transition (complete/fail). Returns undefined when
   * there is no usage to price, or when the task is an `agent_run` child —
   * those are internal and roll their cost up to the parent projection via
   * reconcileProjectionFromAgentRun, so costing them here too would
   * double-count in the workspace cockpit's cost sum.
   */
  private ownBridgeCost(metadata?: string | null): number | undefined {
    const meta = this.parseJson(metadata);
    if (this.taskKind(meta) === 'agent_run') return undefined;
    const bridge = this.readObject(meta.bridge);
    if (Object.keys(bridge).length === 0) return undefined;
    const credits = this.computeRunCostCredits(bridge);
    return credits > 0 ? credits : undefined;
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
    // Cost roll-up for the parent projection: when this run carried token
    // usage, accumulate its credits onto the parent's IMTask.cost. The run
    // task itself is also costed at its own terminal transition (see
    // applyOwnBridgeCost in completeTask/failTask), but agent_run children
    // are internal and never counted by the workspace cockpit (which sums
    // cost over completedAt-in-window tasks) — only the projection work_item
    // surfaces. So the parent must inherit the spend or it reads 0.
    // Idempotent via execution.lastCostedRunTaskId.
    const runCredits = this.computeRunCostCredits(runBridge);
    if (runCredits > 0 && execution.lastCostedRunTaskId !== runTask.id) {
      data.cost = Math.round(((Number(parent.cost ?? 0) || 0) + runCredits) * 10000) / 10000;
      nextExecution.lastCostedRunTaskId = runTask.id;
      nextExecution.lastRunCostCredits = runCredits;
      // nextExecution was already spread into nextMeta above by reference-copy;
      // re-stringify so the guard marker persists.
      data.metadata = JSON.stringify({ ...nextMeta, execution: nextExecution });
    }
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
      workspaceId?: string | null;
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
      await this.checkTaskReadAccess(task, requesterId);
      return;
    }
    if (await this.canAccessWorkspace(run.workspaceId, requesterId)) return;
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

    const visible: any[] = [];
    for (const task of legacyTasks as any[]) {
      try {
        await this.checkTaskReadAccess(task, requesterId);
        if (this.isLegacyAgentRunTask(task)) visible.push(task);
      } catch {
        // not visible
      }
    }

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
    await this.checkTaskReadAccess(task, requesterId);
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
    projectId?: string | null;
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
    acceptanceCriteriaJson?: string | null;
    acceptanceStatus?: string | null;
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
      projectId: record.projectId ?? null,
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
      // release201/10 — expose acceptance summary to enrichTask consumers
      // (UI uses these for the mini progress bar + drawer overall chip).
      acceptanceStatus: (record.acceptanceStatus as TaskInfo['acceptanceStatus']) ?? 'none',
      ...this.summariseAcceptance((record as any).acceptanceCriteriaJson ?? null),
    };
  }

  /** Light-weight roll-up for enrichTask — does NOT recompute status (already stored). */
  private summariseAcceptance(json: string | null): {
    acceptanceCompletedCount: number;
    acceptanceTotalCount: number;
  } {
    if (!json) return { acceptanceCompletedCount: 0, acceptanceTotalCount: 0 };
    try {
      const arr = JSON.parse(json) as unknown;
      if (!Array.isArray(arr)) return { acceptanceCompletedCount: 0, acceptanceTotalCount: 0 };
      const total = arr.length;
      const done = arr.filter((c) => {
        const s = (c as any)?.status;
        return s && s !== 'pending';
      }).length;
      return { acceptanceCompletedCount: done, acceptanceTotalCount: total };
    } catch {
      return { acceptanceCompletedCount: 0, acceptanceTotalCount: 0 };
    }
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
