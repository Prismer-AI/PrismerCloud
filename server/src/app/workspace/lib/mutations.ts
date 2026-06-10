/**
 * Workspace mutation helpers — typed wrappers around the IM HTTP contract used
 * by /workspace mutation modals.
 *
 * The wire shape comes straight from the cookbooks:
 *   - docs/cookbook/im-full-lifecycle.md  (register / groups / messages / kick)
 *   - docs/cookbook/task-agent-orchestration.md  (tasks)
 *   - docs/cookbook/group-human-agent.md  (group + mention routing)
 *
 * Each helper returns the typed `FetchResult<T>` from `imFetch`, so callers can
 * branch on `.ok` for toast / error UX without re-parsing the envelope.
 */

import { imFetch, type FetchResult } from './im-api';
import { uploadAssetWithDirectFallback } from './asset-upload';
import { PROJECT_FILTER_ALL, PROJECT_FILTER_UNSCOPED, readActiveProjectFromStorage } from './projects-api';
import type {
  AgentDTO,
  AgentProfileDTO,
  ApprovalDTO,
  AssetDTO,
  ConversationDTO,
  GoalPriority,
  GoalStatus,
  GoalTaskDTO,
  LocalDaemonHealthDTO,
  RuntimeInstallAgentResultDTO,
  TaskDTO,
  WorkspaceFileDTO,
} from './types';

// ───────────────────────── 1. Agent registration ─────────────────────────

export type AgentTypeEnum = 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';

export interface RegisterAgentInput {
  /** Agent username — 3-32 chars, [a-zA-Z0-9_-]+ per cookbook §3 */
  username: string;
  displayName: string;
  agentType: AgentTypeEnum;
  /** Current workspace for the AgentCard. Defaults to the owner's default workspace. */
  workspaceId?: string;
  /** Optional adapter hint stored in metadata so daemon owners can pick it up. */
  adapter?: string;
  /** Runtime binding: one local daemon/device can host many agents. */
  daemonId?: string;
  /** Discovery tags used by mention routing and workspace/runtime UI. */
  capabilities?: string[];
  description?: string;
}

export interface RegisterAgentResult {
  imUserId: string;
  username: string;
  displayName: string;
  role: 'agent';
  token: string;
  expiresIn: string;
  capabilities?: string[];
  isNew: boolean;
}

/**
 * POST /api/im/register {type:'agent'} — see cookbook 1 §3.
 *
 * The cloud's register handler creates a sibling agent IMUser under the
 * current human caller (jwtSelfIsHuman + registeringAgent). On first agent
 * register the human's default Personal workspace is also created.
 */
export async function createAgent(input: RegisterAgentInput): Promise<FetchResult<RegisterAgentResult>> {
  return imFetch<RegisterAgentResult>('/register', {
    method: 'POST',
    body: JSON.stringify({
      type: 'agent',
      username: input.username,
      displayName: input.displayName,
      agentType: input.agentType,
      workspaceId: input.workspaceId,
      capabilities: input.capabilities ?? [],
      description: input.description ?? undefined,
      metadata:
        input.adapter || input.daemonId
          ? {
              ...(input.adapter ? { adapter: input.adapter } : {}),
              ...(input.daemonId ? { daemonId: input.daemonId } : {}),
            }
          : undefined,
    }),
  });
}

export async function installAgentToRuntime(input: {
  runtimeInstallationId: string;
  agentImUserId: string;
  adapterName: string;
  profileId?: string;
  profileName?: string;
  config?: Record<string, unknown>;
}): Promise<FetchResult<RuntimeInstallAgentResultDTO>> {
  return imFetch<RuntimeInstallAgentResultDTO>(
    `/api/workspace/runtime-installations/${encodeURIComponent(input.runtimeInstallationId)}/agents`,
    {
      method: 'POST',
      body: JSON.stringify({
        agentImUserId: input.agentImUserId,
        adapterName: input.adapterName,
        profileId: input.profileId,
        profileName: input.profileName ?? 'default',
        config: input.config ?? {},
      }),
    },
  );
}

const LOCAL_DAEMON_BASE = 'http://127.0.0.1:3210';

export async function getLocalDaemonHealth(): Promise<FetchResult<LocalDaemonHealthDTO>> {
  try {
    const res = await fetch(`${LOCAL_DAEMON_BASE}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(1_500) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error ?? `HTTP_${res.status}`,
        message: data?.message ?? `HTTP ${res.status}`,
        raw: data,
      };
    }
    return { ok: true, data: data as LocalDaemonHealthDTO };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'LOCAL_DAEMON_UNAVAILABLE',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CreateAgentProfileInput {
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: Record<string, unknown>;
}

/**
 * POST /api/im/agent_profiles — creates the adapter-local runtime config used
 * by daemon dispatch. This is intentionally generic: local daemon, managed k8s,
 * Hermes, OpenClaw, Codex and Claude Code all consume the same profile model.
 */
export async function createAgentProfile(input: CreateAgentProfileInput): Promise<FetchResult<AgentProfileDTO>> {
  return imFetch<AgentProfileDTO>('/agent_profiles', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      agentImUserId: input.agentImUserId,
      adapterName: input.adapterName,
      name: input.name,
      config: input.config,
    }),
  });
}

export async function preinstallRoleTemplateSkills(input: {
  agentImUserId: string;
  roleTemplate: string;
  workspaceId?: string;
}): Promise<FetchResult<unknown>> {
  return imFetch<unknown>('/skills/preinstall', {
    method: 'POST',
    body: JSON.stringify({
      agentId: input.agentImUserId,
      roleTemplateSlugOrId: input.roleTemplate,
      workspaceId: input.workspaceId,
    }),
  });
}

/**
 * PATCH /api/im/agent_profiles/:id — update profile config with optimistic
 * concurrency via `version`. Used by the inspector's model editor.
 */
export async function updateAgentProfileConfig(
  profileId: string,
  config: Record<string, unknown>,
  version: number,
): Promise<FetchResult<AgentProfileDTO>> {
  return imFetch<AgentProfileDTO>(`/agent_profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ config, version }),
  });
}

// ───────────────────────── 2. Conversation creation ─────────────────────────

export interface CreateGroupInput {
  title: string;
  description?: string;
  /** imUserIds of additional members (caller is auto-added as owner). */
  members: string[];
}

export interface CreateGroupResult {
  groupId: string;
  title: string;
  members: Array<{ userId: string; username: string; displayName: string; role: string }>;
}

export async function createDirectConversation(
  otherUserId: string,
  workspaceId?: string | null,
): Promise<FetchResult<ConversationDTO>> {
  return imFetch<ConversationDTO>('/conversations/direct', {
    method: 'POST',
    body: JSON.stringify({ otherUserId, workspaceId: workspaceId ?? undefined }),
  });
}

/**
 * POST /api/im/groups — see cookbook 1 §4 / cookbook 3 §1.
 *
 * Used for both 1:1 (members:[singleAgent]) and group flows; the cookbook
 * scripts use the same endpoint for both. Caller is auto-added as `owner`,
 * so we never have to pass `members:[selfId]`.
 */
export async function createGroupConversation(input: CreateGroupInput): Promise<FetchResult<CreateGroupResult>> {
  return imFetch<CreateGroupResult>('/groups', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      description: input.description ?? undefined,
      members: input.members,
    }),
  });
}

// ───────────────────────── 3. Send message ─────────────────────────

export interface SendMessageInput {
  conversationId: string;
  content: string;
  /** Defaults to 'text' per cookbook §5. */
  type?: 'text' | 'markdown';
  parentId?: string;
  quotedMessageId?: string;
  metadata?: Record<string, unknown>;
  attachments?: MessageAttachmentDTO[] | null;
  /**
   * v2.0 §4.1 — client-supplied idempotency key. Cloud reads `X-Idempotency-Key`
   * AND `metadata._idempotencyKey`; surfacing it as a first-class field on the
   * SDK avoids the metadata-poking pattern from im-channel.tsx.
   *
   * If omitted, the cloud will not dedupe — caller must pass the same key
   * across retries to get DB-level (conversationId, idempotencyKey) UNIQUE
   * dedup. The cloud also echoes the key back on `message.idempotencyKey`
   * so the front-end can match optimistic rows with their SSE echoes.
   */
  idempotencyKey?: string;
}

export interface MessageAttachmentDTO {
  kind: 'file' | 'image' | 'audio' | 'video' | 'asset';
  assetId: string;
  title?: string;
  filename?: string;
  mime?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
  /** release202/13 §3b① — base64 thumbHash for an instant blurred placeholder. */
  blurHash?: string | null;
  /** release202/13 §L1 — short text excerpt for the card (small md/txt only). */
  previewText?: string | null;
  revision?: number | null;
  role?: 'attachment' | 'context' | 'output';
}

export interface SendMessageResult {
  message: {
    id: string;
    conversationId: string;
    senderId: string;
    type: string;
    content: string;
    metadata?: string | Record<string, unknown>;
    attachments?: MessageAttachmentDTO[] | null;
    createdAt: string;
    parentId?: string | null;
    quotedMessageId?: string | null;
    /** v2.0 §4.1 — per-conversation monotonic seq, present when cloud allocates it. */
    boundarySeq?: number | null;
    /** v2.0 §4.1 — echo of the client-supplied idempotency key. */
    idempotencyKey?: string | null;
  };
  routing?: {
    mode: 'explicit' | 'capability' | 'broadcast' | 'none';
    targets: Array<{ userId: string; username?: string; displayName?: string }>;
    cleanText?: string;
  };
}

/** POST /api/im/messages/:conversationId — cookbook 1 §5, cookbook 3 §2. */
export async function sendMessage(input: SendMessageInput): Promise<FetchResult<SendMessageResult>> {
  const headers: Record<string, string> = {};
  if (input.idempotencyKey) {
    headers['X-Idempotency-Key'] = input.idempotencyKey;
  }
  return imFetch<SendMessageResult>(`/messages/${encodeURIComponent(input.conversationId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: input.type ?? 'text',
      content: input.content,
      metadata: input.metadata,
      attachments: input.attachments,
      parentId: input.parentId,
      quotedMessageId: input.quotedMessageId,
    }),
  });
}

// ───────────────────────── 4. Group members lookup + kick ─────────────────────────

export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  role: 'owner' | 'admin' | 'member' | string;
}

export interface GroupDetails {
  groupId: string;
  title: string | null;
  description: string | null;
  members: GroupMember[];
}

/** GET /api/im/groups/:groupId — used by the mention picker + member list. */
export async function getGroupDetails(groupId: string): Promise<FetchResult<GroupDetails>> {
  return imFetch<GroupDetails>(`/groups/${encodeURIComponent(groupId)}`);
}

/** DELETE /api/im/groups/:groupId/members/:userId — cookbook 3 §5 (Kick). */
export async function kickGroupMember(groupId: string, userId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/**
 * POST /api/im/groups/:groupId/members — add member to a group.
 *
 * Server resolves `userId` either as an `imu_*` direct id or a username string
 * (see `resolveTargetUser` in src/im/utils/resolve-user.ts). Mirrors how
 * NewChannelDialog adds humans by username.
 */
export async function addGroupMember(
  groupId: string,
  userId: string,
  role: 'member' | 'admin' = 'member',
): Promise<FetchResult<unknown>> {
  return imFetch(`/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId, role }),
  });
}

// ───────────────────────── 4b. Conversation settings (rename / pin / mute) ─────────────────────────

/** PATCH /api/im/conversations/:id — update title/description. */
export async function renameConversation(conversationId: string, title: string): Promise<FetchResult<unknown>> {
  return imFetch(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: title.trim() }),
  });
}

/** PATCH /api/im/conversations/:id/pin — toggle pin (participant flag). */
export async function pinConversation(conversationId: string, pinned: boolean): Promise<FetchResult<unknown>> {
  return imFetch(`/conversations/${encodeURIComponent(conversationId)}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });
}

/** PATCH /api/im/conversations/:id/mute — toggle mute (participant flag). */
export async function muteConversation(conversationId: string, muted: boolean): Promise<FetchResult<unknown>> {
  return imFetch(`/conversations/${encodeURIComponent(conversationId)}/mute`, {
    method: 'PATCH',
    body: JSON.stringify({ muted }),
  });
}

/** POST /api/im/conversations/:id/archive — archive a conversation. */
export async function archiveConversation(conversationId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/conversations/${encodeURIComponent(conversationId)}/archive`, {
    method: 'POST',
  });
}

/**
 * DELETE /api/im/conversations/:id — soft-delete (leaves the conversation
 * for the caller; owner-side delete vs leave is enforced server-side via the
 * participant role). LeftRail drops it on next reload.
 */
export async function deleteConversation(conversationId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

// ───────────────────────── 5. Task creation + cancel ─────────────────────────

/**
 * Wave-8 W1 / L1 — structured asset reference attached to a task.
 *
 * Mirrors `AssetRef` from `sdk/prismer-cloud/runtime/src/types/im-events.ts`
 * (the wire shape consumed by the daemon's `resolveAssetRefs`). The cloud
 * accepts this shape on POST /tasks (and PATCH /tasks/:id), validates each
 * `assetId` against the task's workspace, then folds the ids into
 * `metadata.assets.linkedAssetIds` so the existing dispatch hydrator picks
 * them up at dispatch time.
 *
 * Only `assetId` is REQUIRED on the wire — server re-hydrates contentHash /
 * mime / sizeBytes / kind from im_assets so a stale client cache can't poison
 * the dispatch payload. The other fields are accepted for forward-compat
 * (and lets clients echo what they expect for debug logging).
 */
export interface AssetRefInput {
  assetId: string;
  contentHash?: string;
  mime?: string | null;
  sizeBytes?: number | null;
  /**
   * When provided, server rejects cross-workspace references with a 400 —
   * cheap defence against UI bugs that mix workspaces.
   */
  workspaceId?: string;
}

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  /**
   * Task body — single source of truth for "what the agent (and human)
   * should do." Surfaced verbatim on Task cards (markdown rendered) and
   * forwarded to the daemon as the executing LLM's prompt. May contain
   * `prismer://` / `https://` links for future extensibility.
   */
  description?: string;
  /** Agent IMUser ID (optional; falls back to marketplace=pending). */
  assigneeId?: string;
  capability?: string;
  /** Daemon profile id (optional — daemon resolves first profile if omitted). */
  profileId?: string;
  conversationId?: string;
  timeoutMs?: number;
  runtimeRoute?: 'agent' | 'sandbox' | 'shell';
  metadata?: Record<string, unknown>;
  /**
   * Wave-8 W1 / L1 — structured asset attachments. Both this AND in-prompt
   * `prismer://workspace/<wsId>/asset/<hash>` URIs are honoured by the
   * daemon (the resolver handles in-text URIs; `assetRefs[]` is the
   * structured channel). Empty / omitted means "no attached assets."
   */
  assetRefs?: AssetRefInput[];
  /**
   * release201/09 §4.1 — Project scope. Optional; NULL = workspace-level.
   * Must reference an active IMProject in the same workspace; service
   * rejects archived / cross-workspace ids.
   */
  projectId?: string | null;
}

/** POST /api/im/tasks — task-agent-orchestration.md §API. */
export async function createTask(input: CreateTaskInput): Promise<FetchResult<TaskDTO>> {
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (!metadata.kind) metadata.kind = 'work_item';
  if (input.profileId) metadata.profileId = input.profileId;
  return imFetch<TaskDTO>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      capability: input.capability,
      assigneeId: input.assigneeId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runtimeRoute: input.runtimeRoute ?? 'agent',
      timeoutMs: input.timeoutMs,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      // L1: forward structured asset attachments. Server validates each ref
      // is in the same workspace, then folds them into metadata.assets.linkedAssetIds.
      ...(input.assetRefs && input.assetRefs.length > 0 ? { assetRefs: input.assetRefs } : {}),
      // release201/09 §4.1 — forward projectId when set (non-null + non-empty).
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }),
  });
}

/** DELETE /api/im/tasks/:id — task-agent-orchestration.md §DELETE / Path 2. */
export async function cancelTask(taskId: string): Promise<FetchResult<unknown>> {
  return imFetch(`/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
}

/**
 * POST /api/im/tasks/:id/approve — Creator approves a `review`-status task,
 * transitioning it to `completed`. See cookbook task-agent-orchestration.md
 * §approve and `src/im/api/tasks.ts` `/:id/approve` handler.
 */
export async function approveTask(taskId: string): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * POST /api/im/tasks/:id/reject — Creator rejects a `review`-status task,
 * transitioning it to `failed`. `reason` is required by the cloud handler.
 */
export async function rejectTask(taskId: string, reason: string): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function listApprovals(input: {
  workspaceId?: string;
  conversationId?: string;
  taskId?: string;
  status?: string;
}): Promise<FetchResult<ApprovalDTO[]>> {
  const params = new URLSearchParams();
  if (input.workspaceId) params.set('workspaceId', input.workspaceId);
  if (input.conversationId) params.set('conversationId', input.conversationId);
  if (input.taskId) params.set('taskId', input.taskId);
  if (input.status) params.set('status', input.status);
  return imFetch<ApprovalDTO[]>(`/approvals?${params.toString()}`);
}

export async function decideApproval(
  approvalId: string,
  selectedValue: string,
  comment?: string,
): Promise<FetchResult<ApprovalDTO>> {
  return imFetch<ApprovalDTO>(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ selectedValue, ...(comment?.trim() ? { comment: comment.trim() } : {}) }),
  });
}

/**
 * POST /api/im/tasks/:id/start — transition a task into the running state.
 * Optional `reason` is forwarded in the body when provided (omitted otherwise).
 */
export async function startTask(taskId: string, opts?: { reason?: string }): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/start`, {
    method: 'POST',
    body: JSON.stringify(opts?.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

/**
 * POST /api/im/tasks/:id/pause — pause a running task. Optional `reason` is
 * forwarded in the body when provided (omitted otherwise).
 */
export async function pauseTask(taskId: string, opts?: { reason?: string }): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(opts?.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

/**
 * POST /api/im/tasks/:id/reopen — reopen a closed/failed task. Optional
 * `reason` is forwarded in the body when provided (omitted otherwise).
 */
export async function reopenTask(taskId: string, opts?: { reason?: string }): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/reopen`, {
    method: 'POST',
    body: JSON.stringify(opts?.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

/**
 * PATCH /api/im/tasks/:id — partial update of a task. Used by the kanban
 * board for drag-to-column status changes and by the detail drawer for
 * inline edits. Only fields present in `patch` are sent on the wire.
 *
 * Status-mapping table for kanban drops (callers should pre-map column
 * key → wire status before calling):
 *   backlog / todo  → 'pending'
 *   in_progress     → 'running'
 *   review          → 'review'
 *   done            → 'completed'
 */
export interface UpdateTaskPatch {
  status?: TaskDTO['status'];
  forceExecutionStatus?: boolean;
  title?: string;
  description?: string | null;
  assigneeId?: string | null;
  progress?: number | null;
  statusMessage?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Wave-8 W1 / L1 — structured asset attachments. Same semantics as on
   * create: server validates against im_assets in the task's workspace and
   * folds into `metadata.assets.linkedAssetIds`. Send an empty array to
   * clear the attachment list (server still rewrites `linkedAssetIds`
   * only when the array is non-empty; pass `metadata.assets.linkedAssetIds=[]`
   * if you want an explicit clear).
   */
  assetRefs?: AssetRefInput[];
}

export async function updateTask(taskId: string, patch: UpdateTaskPatch): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Convenience: updates only the status field. */
export async function updateTaskStatus(
  taskId: string,
  status: TaskDTO['status'],
  opts?: { forceExecutionStatus?: boolean; reason?: string },
): Promise<FetchResult<TaskDTO>> {
  return updateTask(taskId, {
    status,
    forceExecutionStatus: opts?.forceExecutionStatus,
    metadata: opts?.reason ? { reason: opts.reason } : undefined,
  });
}

// ─────────────────── 5b. State-machine transition (v2.0 / release 200 P3) ───────────────────
//
// `POST /api/im/tasks/:id/transition` is the unified entry point for every
// task status change — kanban drag, assign/unassign, start/pause, approve,
// reject, cancel. Server enforces the TRANSITIONS matrix + per-tier
// permissions, so the client cannot accidentally break invariants.
//
// Old per-action endpoints (`/start`, `/pause`, `/approve`, `/reject`,
// `/cancel`) still exist and respond identically — P8 will deprecate them.
// New code should always use `transitionTask`.

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'review'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export interface TransitionTaskInput {
  /** Target status. See docs/release200/15-task-state-machine-and-kanban.md §6.1. */
  to: TaskStatus;
  /**
   * Set / clear assignee atomically with the status change. `null` clears,
   * `undefined` leaves the existing value. Required when transitioning
   * pending → assigned (server returns invalid-transition otherwise).
   */
  assigneeId?: string | null;
  /**
   * Numeric position for B-tree midpoint ordering inside a kanban column.
   * See `computeKanbanPosition` in task-board.tsx. Server stores in the
   * `position DOUBLE` column (migration 342).
   */
  position?: number;
  /** Free-form transition reason. Recorded in the task log. */
  reason?: string;
  /** Only meaningful for review → assigned (rejection comment). */
  reviewComment?: string;
}

/**
 * Transition envelope from the server — sibling to the enriched task in the
 * `meta` field of the response. Captured for telemetry only.
 */
export interface TransitionMeta {
  from: string | null;
  to: string;
  by: string;
  at: string;
}

/**
 * Structured error fields surfaced by the P3 transition endpoint. We don't
 * widen the FetchResult shape; callers should inspect `result.raw` when
 * `result.error === 'invalid-transition' | 'forbidden'`.
 */
export interface TransitionErrorEnvelope {
  ok: false;
  error: {
    code: 'invalid-transition' | 'forbidden' | string;
    message: string;
    /** invalid-transition only */
    from?: string;
    to?: string;
    allowedFromHere?: string[];
    /** forbidden only */
    actorTier?: string;
    requiredTiers?: string[];
  };
}

/** POST /api/im/tasks/:id/transition — v2.0 §6.1. */
export async function transitionTask(taskId: string, input: TransitionTaskInput): Promise<FetchResult<TaskDTO>> {
  return imFetch<TaskDTO>(`/tasks/${encodeURIComponent(taskId)}/transition`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createShellTask(input: {
  workspaceId: string;
  title?: string;
  command: string;
  targetDaemonId: string;
  cwd?: string;
  shell?: 'bash' | 'zsh' | 'sh';
  timeoutMs?: number;
}): Promise<FetchResult<TaskDTO>> {
  const command = input.command.trim();
  return createTask({
    workspaceId: input.workspaceId,
    title: input.title ?? `Shell: ${command.slice(0, 72)}`,
    description: command,
    capability: 'shell',
    runtimeRoute: 'shell',
    timeoutMs: input.timeoutMs ?? 60_000,
    metadata: {
      execution: {
        kind: 'shell',
        command,
        targetDaemonId: input.targetDaemonId,
        cwd: input.cwd,
        shell: input.shell,
        requiresConfirmation: true,
      },
    },
  });
}

// ───────────────────────── 6. Helpers ─────────────────────────

/**
 * Username regex matches the cookbook (`[a-zA-Z0-9_-]+`, 3-32 chars).
 */
export function isValidAgentUsername(s: string): boolean {
  return /^[a-zA-Z0-9_-]{3,32}$/.test(s);
}

/** Build a clean kebab-cased slug seed from a display name. No suffix. */
export function suggestUsernameSeed(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/**
 * @deprecated Prefer `suggestUsernameSeed`. Discord-2023 lesson: don't
 *  hide a random suffix from the user. Kept for `new-agent-dialog.tsx`
 *  and the legacy fallback in `use-simple-provisioning.ts`.
 */
export function suggestUsername(displayName: string): string {
  const base = suggestUsernameSeed(displayName);
  if (!base) return '';
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}-${rand}`.slice(0, 32);
}

/** True if this DTO refers to a status where Cancel is meaningful. */
export function isCancellableStatus(status: string): boolean {
  return ['pending', 'assigned', 'running', 'in_progress'].includes(status);
}

// ───────────────────────── 7. Goal task projections ─────────────────────────

export interface CreateGoalInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: GoalPriority;
  agentImUserId?: string | null;
  linkedTaskId?: string | null;
  linkedConversationId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  priority?: GoalPriority;
  status?: GoalStatus;
  agentImUserId?: string | null;
  linkedTaskIds?: string[];
  linkedConversationIds?: string[];
  metadata?: Record<string, unknown>;
}

function goalMetadata(input: {
  status?: GoalStatus;
  priority?: GoalPriority;
  linkedTaskIds?: string[];
  linkedConversationIds?: string[];
  extra?: Record<string, unknown>;
}) {
  return {
    ...(input.extra ?? {}),
    kind: 'goal',
    intent: 'standing_objective',
    goal: {
      status: input.status ?? 'active',
      priority: input.priority ?? 'medium',
      linkedTaskIds: input.linkedTaskIds ?? [],
      linkedConversationIds: input.linkedConversationIds ?? [],
      lastActivityAt: new Date().toISOString(),
    },
  };
}

export async function listWorkspaceGoals(workspaceId: string): Promise<FetchResult<GoalTaskDTO[]>> {
  const result = await imFetch<TaskDTO[]>(
    `/tasks?workspaceId=${encodeURIComponent(workspaceId)}&view=board&kind=goal&limit=100`,
  );
  if (!result.ok) return result as FetchResult<GoalTaskDTO[]>;
  return {
    ...result,
    data: result.data.filter(
      (task) => task.metadata?.kind === 'goal' || task.metadata?.intent === 'standing_objective',
    ) as GoalTaskDTO[],
  };
}

export async function getWorkspaceGoal(goalId: string, _workspaceId: string): Promise<FetchResult<GoalTaskDTO>> {
  const result = await imFetch<{ task: TaskDTO }>(`/tasks/${encodeURIComponent(goalId)}`);
  if (!result.ok) return result as FetchResult<GoalTaskDTO>;
  return { ok: true, data: result.data.task as GoalTaskDTO };
}

export async function createWorkspaceGoal(input: CreateGoalInput): Promise<FetchResult<GoalTaskDTO>> {
  const linkedTaskIds = input.linkedTaskId ? [input.linkedTaskId] : [];
  const linkedConversationIds = input.linkedConversationId ? [input.linkedConversationId] : [];
  return createTask({
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description ?? input.title,
    assigneeId: input.agentImUserId ?? undefined,
    conversationId: input.linkedConversationId ?? undefined,
    metadata: goalMetadata({
      priority: input.priority,
      linkedTaskIds,
      linkedConversationIds,
      extra: input.metadata,
    }),
  }) as Promise<FetchResult<GoalTaskDTO>>;
}

function mergeGoalPatch(existing: Record<string, unknown>, patch: UpdateGoalInput): Record<string, unknown> {
  const existingGoal =
    existing.goal && typeof existing.goal === 'object' && !Array.isArray(existing.goal)
      ? (existing.goal as Record<string, unknown>)
      : {};
  const goal: Record<string, unknown> = {
    ...existingGoal,
    lastActivityAt: new Date().toISOString(),
  };
  if (patch.status) goal.status = patch.status;
  if (patch.priority) goal.priority = patch.priority;
  if (patch.linkedTaskIds) goal.linkedTaskIds = patch.linkedTaskIds;
  if (patch.linkedConversationIds) goal.linkedConversationIds = patch.linkedConversationIds;
  return {
    ...existing,
    ...(patch.metadata ?? {}),
    kind: 'goal',
    intent: 'standing_objective',
    goal,
  };
}

export async function updateWorkspaceGoal(
  goalId: string,
  workspaceId: string,
  patch: UpdateGoalInput,
): Promise<FetchResult<GoalTaskDTO>> {
  const existing = await getWorkspaceGoal(goalId, workspaceId);
  if (!existing.ok) return existing;
  return updateTask(goalId, {
    title: patch.title,
    description: patch.description,
    assigneeId: patch.agentImUserId,
    metadata: mergeGoalPatch(existing.data.metadata, patch),
  }) as Promise<FetchResult<GoalTaskDTO>>;
}

export async function pauseWorkspaceGoal(goalId: string, workspaceId: string): Promise<FetchResult<GoalTaskDTO>> {
  return updateWorkspaceGoal(goalId, workspaceId, { status: 'paused' });
}

export async function resumeWorkspaceGoal(goalId: string, workspaceId: string): Promise<FetchResult<GoalTaskDTO>> {
  return updateWorkspaceGoal(goalId, workspaceId, { status: 'active' });
}

export async function completeWorkspaceGoal(goalId: string, _workspaceId: string): Promise<FetchResult<GoalTaskDTO>> {
  const existing = await getWorkspaceGoal(goalId, _workspaceId);
  if (!existing.ok) return existing;
  return updateTask(goalId, {
    status: 'completed',
    forceExecutionStatus: true,
    metadata: mergeGoalPatch(existing.data.metadata, { status: 'completed' }),
  });
}

// Re-export the conversation/agent DTOs callers need.
export type { AgentDTO, ConversationDTO };

// ─────────────────── §30 B3.1 — UnifiedCreationModal preference ───────────────────
//
// `preferredCreationMode` lives in user.metadata so it survives across
// devices. Local cache (localStorage) shadows it for instant reads at
// modal-open time without waiting on a network roundtrip. Server write is
// fire-and-forget — if it fails, the local cache still gives the user the
// expected experience on the current device.

export type CreationMode = 'simple' | 'pro';

const CREATION_MODE_LS_KEY = 'prismer:workspace:preferredCreationMode';

/** Synchronous read from localStorage. Safe in SSR (returns null). */
export function loadPreferredCreationMode(): CreationMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CREATION_MODE_LS_KEY);
    return raw === 'simple' || raw === 'pro' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist the chosen mode. Writes localStorage synchronously (so the next
 * modal open reflects the choice immediately) AND PATCHes user.metadata
 * (best-effort — server errors are swallowed by callers).
 *
 * IMPORTANT: `PATCH /users/me` REPLACES the entire `metadata` blob server-
 * side (UserModel.update stringifies whatever is passed in). To avoid
 * clobbering unrelated preferences, we read-then-merge-then-write.
 */
export async function setPreferredCreationMode(mode: CreationMode): Promise<FetchResult<unknown>> {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CREATION_MODE_LS_KEY, mode);
    } catch {
      /* quota / private mode — ignore */
    }
  }
  // Read existing metadata first so we can merge without clobber.
  const me = await imFetch<{ metadata?: Record<string, unknown> }>('/users/me');
  const existing = me.ok ? (me.data?.metadata ?? {}) : {};
  return imFetch('/users/me', {
    method: 'PATCH',
    body: JSON.stringify({ metadata: { ...existing, preferredCreationMode: mode } }),
  });
}

// ─────────────────── Task 43 — Launch-tour seed ───────────────────
//
// After Simple-Mode creation lands, pre-seed a demo task + a product-intro
// markdown asset so the post-creation launch tour has real cards to
// highlight. Best-effort: both creation paths swallow their own errors so a
// partial failure (e.g. task created, asset failed) still yields a usable
// `LaunchTourSeed` with the surviving id and a `null` for the failed one.
//
// IMPORTANT: this helper must NEVER throw — callers wire it as a
// post-success seed alongside navigation, and a thrown exception would
// block the redirect into the new conversation. All HTTP failures are
// logged + reported as `null` ids.

export interface LaunchTourSeed {
  /** Task id of the demo "introduce Prismer Cloud" task, or null on failure. */
  demoTaskId: string | null;
  /** Asset id of the seeded product-intro markdown, or null on failure. */
  sampleAssetId: string | null;
  /** Agent ids forwarded from the simple-team event — convenience for the tour. */
  agentIds: string[];
  /** Conversation id forwarded from the simple-team event. */
  conversationId: string;
}

const LAUNCH_TOUR_ASSET_CONTENT = `# 欢迎使用 Prismer Cloud

你的 AI 团队已经上岗。这里是你刚刚组建的工作区入口:

## 你可以做什么
- **看板**:让 agent 接手任务,跟踪进度
- **会话**:跟单个 agent 1:1,或拉一个群讨论
- **资产**:把企业文档投进来,agent 自动有上下文
- **设备**:你的本地/云端 daemon 在这里编排

## 下一步建议
1. 在群里发一条 "团队介绍一下自己" 看 agent 各自的人设
2. 给看板上的 demo task 加几个子任务
3. 把任何 PDF/PPTX/Markdown 拖到 Asset 面板
`;

const LAUNCH_TOUR_ASSET_FILENAME = 'workspace-intro.md';
const LAUNCH_TOUR_ASSET_MIME = 'text/markdown';

/**
 * Build a File from the canned markdown blob — extracted so unit tests
 * (and the helper below) can both reach it without duplicating the literal.
 */
function buildLaunchTourAssetFile(): File {
  return new File([LAUNCH_TOUR_ASSET_CONTENT], LAUNCH_TOUR_ASSET_FILENAME, {
    type: LAUNCH_TOUR_ASSET_MIME,
  });
}

export interface SeedLaunchTourInput {
  workspaceId: string | null;
  conversationId: string;
  agentIds: string[];
  organizationName: string | null;
}

/**
 * Seed a demo task + a product-intro markdown asset after Simple-Mode
 * creation completes. Returns the seeded ids (each may be null on
 * individual failure). Returns `null` only when there is no workspace
 * to attach to — caller should treat that as "no seed available."
 *
 * release201 v2.0.8 UX A3 — projectId 继承:
 *   Simple-mode 引导流程在 device step 前会调 `ensureSimpleModeProject`,
 *   把 "{org} 主项目" 的 id 写入 `prismer_active_project_<wsId>`. 之后
 *   reloadTasks 也带着这个 id 当 query 过滤. 如果 demo task 不继承同一
 *   projectId, board 视图会过滤掉 (server `parseProjectIdFilter` 把
 *   `<id>` 解为 "WHERE projectId = <id>", NULL 不匹配). 这里显式从
 *   localStorage 读 active filter 并 forward 给 createTask, 保证
 *   "向我介绍 Prismer Cloud" 这张卡在引导完成后立刻可见.
 *
 *   `'all'` / `'__unscoped'` / `null` 三个 sentinel 都映射成 "task 不带
 *   projectId" — 落 NULL, "Unscoped" / "All" 两种过滤都能看见.
 *
 *   `_readActiveProject` 可选注入, 仅供测试 mock; 生产路径走默认
 *   `readActiveProjectFromStorage`.
 */
export async function seedLaunchTourContent(
  input: SeedLaunchTourInput,
  _readActiveProject: typeof readActiveProjectFromStorage = readActiveProjectFromStorage,
): Promise<LaunchTourSeed | null> {
  if (!input.workspaceId) {
    console.warn('[Workspace] seedLaunchTourContent: no workspaceId, skipping seed');
    return null;
  }

  const workspaceId = input.workspaceId;
  const assigneeId = input.agentIds[0];

  // A3 — Inherit the active project filter so the seeded task lands in the
  // same scope the board is currently filtering by. Sentinel values map to
  // "no projectId" (task lands NULL, visible in both "All" and "Unscoped").
  const activeFilter = _readActiveProject(workspaceId);
  const seededProjectId =
    activeFilter && activeFilter !== PROJECT_FILTER_ALL && activeFilter !== PROJECT_FILTER_UNSCOPED
      ? activeFilter
      : undefined;

  // Demo task: assign to the first agent (CEO/lead in the simple-team flow).
  // If no agent ids are forwarded, leave assignee unset — the marketplace
  // pending path is still preferable to dropping the seed entirely.
  const taskPromise: Promise<string | null> = (async () => {
    try {
      const res = await createTask({
        workspaceId,
        title: '向我介绍 Prismer Cloud 这个产品',
        description: '请用 markdown 写一份简短的产品介绍,包含核心能力、典型场景和我能立刻上手的下一步。',
        assigneeId,
        conversationId: input.conversationId,
        metadata: { kind: 'work_item', launchTourSeed: true },
        ...(seededProjectId ? { projectId: seededProjectId } : {}),
      });
      if (!res.ok) {
        console.warn('[Workspace] seedLaunchTourContent: task creation failed', res.message);
        return null;
      }
      return res.data?.id ?? null;
    } catch (err) {
      console.warn('[Workspace] seedLaunchTourContent: task creation threw', err);
      return null;
    }
  })();

  // Sample asset: multipart upload using the same direct-fallback path the
  // regular asset uploader uses, then register the WorkspaceFile so the
  // Library surface shows the row.
  const assetPromise: Promise<string | null> = (async () => {
    try {
      const file = buildLaunchTourAssetFile();
      const res = await uploadAssetWithDirectFallback({
        file,
        workspaceId,
        metadata: { title: LAUNCH_TOUR_ASSET_FILENAME, launchTourSeed: true },
        imFetch,
      });
      if (!res.ok) {
        console.warn('[Workspace] seedLaunchTourContent: asset upload failed', res.message);
        return null;
      }
      const asset: AssetDTO = res.data;
      // Mirror the page.tsx upload flow: register the file row so Library
      // shows the new asset. Failures here aren't fatal — the asset is
      // already in the workspace, only the Library row is missing.
      try {
        await imFetch<WorkspaceFileDTO>(`/workspaces/${encodeURIComponent(workspaceId)}/files`, {
          method: 'POST',
          body: JSON.stringify({ path: LAUNCH_TOUR_ASSET_FILENAME, assetId: asset.id }),
        });
      } catch (err) {
        console.warn('[Workspace] seedLaunchTourContent: file row registration failed', err);
      }
      return asset.id;
    } catch (err) {
      console.warn('[Workspace] seedLaunchTourContent: asset upload threw', err);
      return null;
    }
  })();

  const [demoTaskId, sampleAssetId] = await Promise.all([taskPromise, assetPromise]);
  return {
    demoTaskId,
    sampleAssetId,
    agentIds: input.agentIds,
    conversationId: input.conversationId,
  };
}
