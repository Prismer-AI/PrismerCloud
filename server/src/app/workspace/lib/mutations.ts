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

import { imFetch, workspaceFetch, type FetchResult } from './im-api';
import type {
  AgentDTO,
  AgentProfileDTO,
  ConversationDTO,
  GoalPriority,
  GoalStatus,
  GoalTaskDTO,
  LocalDaemonHealthDTO,
  RuntimeInstallAgentResultDTO,
  TaskDTO,
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
}

export interface SendMessageResult {
  message: {
    id: string;
    conversationId: string;
    senderId: string;
    type: string;
    content: string;
    metadata?: string | Record<string, unknown>;
    createdAt: string;
    parentId?: string | null;
    quotedMessageId?: string | null;
  };
  routing?: {
    mode: 'explicit' | 'capability' | 'broadcast' | 'none';
    targets: Array<{ userId: string; username?: string; displayName?: string }>;
    cleanText?: string;
  };
}

/** POST /api/im/messages/:conversationId — cookbook 1 §5, cookbook 3 §2. */
export async function sendMessage(input: SendMessageInput): Promise<FetchResult<SendMessageResult>> {
  return imFetch<SendMessageResult>(`/messages/${encodeURIComponent(input.conversationId)}`, {
    method: 'POST',
    body: JSON.stringify({
      type: input.type ?? 'text',
      content: input.content,
      metadata: input.metadata,
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
