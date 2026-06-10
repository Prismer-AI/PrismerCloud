/**
 * Cross-service structural interfaces shared by TaskService and MessageService.
 *
 * The two services collaborate during @-mention dispatch and task-status chat
 * digest emission, but importing each other's concrete classes for type
 * annotations creates a circular dependency that madge flags
 * (task.service.ts ↔ message.service.ts).
 *
 * Each service references the other by a minimal structural interface here,
 * so the runtime wiring (`MessageService.setTaskService(...)`,
 * `TaskServiceDeps.messageService`) keeps the same shape with zero behaviour
 * change but the static dependency graph is acyclic.
 *
 * Input shapes mirror the concrete TaskService.createTaskRun / send / update
 * signatures faithfully (extracted into named interfaces here) so consumers
 * can call through the bridge with their existing call sites unchanged.
 */

// ─── MessageEmitter — what TaskService needs from MessageService ────
//
// The input/output shapes intentionally re-derive from the canonical type
// module (`../types/index`) instead of `./message.service`, so the bridge
// stays import-free of MessageService.

import type { AssetAttachment, MessageMetadata, MessageType } from '../types/index';

export interface MessageEmitterSendInput {
  conversationId: string;
  senderId: string;
  type?: MessageType;
  content: string;
  metadata?: MessageMetadata;
  attachments?: AssetAttachment[] | null;
  parentId?: string;
  quotedMessageId?: string;
}

export interface MessageEmitterUpdateInput {
  content?: string;
  metadata?: MessageMetadata;
  attachments?: AssetAttachment[] | null;
}

/**
 * Surface that TaskService (and TaskDigestService) need to post status /
 * digest messages into IM conversations. Matches the public `send` + `update`
 * methods of MessageService structurally.
 *
 * Returns `unknown` because callers in the task-side path only need
 * fire-and-forget semantics (id is sometimes read but always via narrow
 * cast).
 */
export interface MessageEmitter {
  send(input: MessageEmitterSendInput): Promise<unknown>;
  update(messageId: string, input: MessageEmitterUpdateInput): Promise<unknown>;
}

// ─── TaskRunDispatcher — what MessageService needs from TaskService ──

/**
 * Shape mirrors `TaskService.createTaskRun`'s `input` parameter. Keep this
 * in lockstep with the concrete signature so the structural conformance
 * holds (any new field added on TaskService must also be reflected here, or
 * become an index-signature catch-all field).
 */
export interface TaskRunDispatcherInput {
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
}

/**
 * Surface that MessageService needs to spawn an @-mention task run on behalf
 * of a chat trigger. Matches `createTaskRun` + `dispatchTaskRun` of
 * TaskService structurally.
 */
export interface TaskRunDispatcher {
  createTaskRun(taskId: string | null, actorId: string, input: TaskRunDispatcherInput): Promise<{ id: string }>;
  dispatchTaskRun(taskId: string, agentUserId: string, action: string): Promise<void>;
  /**
   * release202/09 P1 — kanban sync for the cli-send / message-attach delivery
   * path. Appends the deliverable assetId to the task's
   * `metadata.outputAssetIds` and re-emits its terminal digest so a file sent
   * as a regular dispatch reply reaches the kanban card (mirrors the POST
   * /assets sandbox-output rollup). Optional: the concrete TaskService
   * implements it; structurally-conforming test doubles may omit it.
   */
  linkOutputAssetAndReemitDigest?(taskOrRunId: string, assetId: string): Promise<void>;
}
