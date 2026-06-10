/**
 * Prismer IM — Core type definitions
 *
 * Unified type system for Agent/Human communication.
 * Message formats are inspired by OpenAI Chat Completion for easy LLM integration.
 */

// ─── User Types ──────────────────────────────────────────────
export type UserRole = 'human' | 'agent' | 'admin' | 'system';

export type AgentType =
  | 'assistant' // General-purpose LLM agent
  | 'specialist' // Domain-specific agent (code, math, etc.)
  | 'orchestrator' // Meta-agent that coordinates other agents
  | 'tool' // Tool-providing agent
  | 'bot'; // Simple bot (non-LLM)

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  agentType?: AgentType;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Conversation Types ──────────────────────────────────────
export type ConversationType = 'direct' | 'group' | 'channel';
export type ConversationStatus = 'active' | 'archived' | 'deleted';

export interface Conversation {
  id: string;
  type: ConversationType;
  title?: string;
  description?: string;
  status: ConversationStatus;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Participant Types ───────────────────────────────────────
export type ParticipantRole = 'owner' | 'admin' | 'member' | 'observer';

export interface Participant {
  id: string;
  conversationId: string;
  userId: string;
  role: ParticipantRole;
  joinedAt: Date;
  leftAt?: Date;
}

// ─── Message Types ───────────────────────────────────────────
export type MessageType =
  | 'text'
  | 'markdown'
  | 'code'
  | 'image'
  | 'file'
  | 'voice' // v1.8.2: Audio messages
  | 'location' // v1.8.2: Geo-coordinates
  | 'artifact' // v1.8.2: Multi-type container (pdf/code/dataset/chart/notebook/latex/document/other)
  | 'tool_call'
  | 'tool_result'
  /** @deprecated v1.8.2 — use 'system' with metadata.action. Kept for backward compat. */
  | 'system_event'
  | 'system' // v1.8.2: Generic system notifications (member_join, etc.)
  | 'thinking';

// v1.8.2: Artifact sub-types for multi-type containers
export type ArtifactType = 'pdf' | 'code' | 'document' | 'dataset' | 'chart' | 'notebook' | 'latex' | 'other';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export type AssetAttachmentKind = 'file' | 'image' | 'audio' | 'video' | 'asset';

export interface AssetPreviewUrls {
  small?: string;
  medium?: string;
  large?: string;
}

export interface AssetAttachment {
  kind: AssetAttachmentKind;
  assetId: string;
  title?: string;
  filename?: string;
  mime?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: AssetPreviewUrls | null;
  /** release202/13 §3b① — base64 thumbHash for an instant blurred placeholder. */
  blurHash?: string | null;
  /** release202/13 §L1 — short text excerpt for the card (small md/txt only). */
  previewText?: string | null;
  revision?: number | null;
  role?: 'attachment' | 'context' | 'output';
}

export interface IMAssetRevision {
  id: string;
  assetId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
  sizeBytes: number | null;
  mime: string | null;
  kind: string;
  filename: string | null;
  folderPath: string | null;
  sourceRef: string | null;
  sourceKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  deletedAt: string | null;
  createdByImUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface IMAssetRevisionList {
  assetId: string;
  currentRevision: number;
  items: IMAssetRevision[];
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: string;
  metadata: MessageMetadata;
  attachments?: AssetAttachment[] | null;
  parentId?: string; // For threading
  status: MessageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageMetadata {
  /** Code block language (when type = "code") */
  language?: string;
  /** File attachment details (type = "file" | "image") */
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  fileUrl?: string;
  /** Confirmed upload ID (required when type = "file") */
  uploadId?: string;
  /** Image dimensions (type = "image") */
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  /** Voice message (type = "voice") */
  duration?: number; // seconds
  waveform?: number[];
  transcription?: string;
  /** Location (type = "location") */
  address?: string;
  locationName?: string;
  /** Artifact container (type = "artifact") */
  title?: string;
  artifactType?: ArtifactType;
  pageCount?: number;
  lines?: number;
  wordCount?: number;
  rowCount?: number;
  columns?: string[];
  chartType?: string;
  cellCount?: number;
  kernelType?: string;
  compiled?: boolean;
  dataPoints?: number;
  format?: string;
  /** System event (type = "system_event" | "system") */
  action?: string; // member_join, member_leave, title_changed
  userId?: string;
  userName?: string;
  /** Tool call payload (when type = "tool_call") */
  toolCall?: ToolCallPayload;
  /** Tool result payload (when type = "tool_result") */
  toolResult?: ToolResultPayload;
  /** System event details (legacy, use action/userId for new system type) */
  systemEvent?: SystemEventPayload;
  /** Streaming indicator */
  isStreaming?: boolean;
  streamId?: string;
  /** Thinking step details */
  thinkingStep?: number;
  /** Backward-compatible attachment mirror; canonical field is IMMessage.attachments. */
  attachments?: AssetAttachment[];
  /** Arbitrary extension data */
  [key: string]: unknown;
}

// ─── Tool Call / Result ──────────────────────────────────────
export interface ToolCallPayload {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultPayload {
  callId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

export interface SystemEventPayload {
  event: string;
  data?: Record<string, unknown>;
}

// ─── WebSocket Events ────────────────────────────────────────
export type WSClientEventType =
  | 'authenticate'
  | 'message.send'
  | 'message.stream.start'
  | 'message.stream.chunk'
  | 'message.stream.end'
  | 'typing.start'
  | 'typing.stop'
  | 'presence.update'
  | 'conversation.join'
  | 'conversation.leave'
  | 'agent.heartbeat'
  | 'agent.capability.declare'
  | 'ping'
  | 'ack'
  | 'reconnect'
  // ─── v1.9.x daemon protocol (Track C) ───
  | 'agent.host.declare' // daemon handshake, includes hosted agent + profile list
  | 'agent.status.changed' // bidirectional: daemon emits, cloud broadcasts
  | 'task.dispatch.progress' // adapter execution progress
  | 'task.dispatch.reply'; // adapter execution result

export type WSServerEventType =
  | 'authenticated'
  | 'error'
  | 'message.new'
  | 'message.updated'
  | 'message.edit'
  | 'message.reaction'
  | 'message.delivered'
  | 'message.deleted'
  | 'message.stream.chunk'
  | 'message.stream.end'
  | 'typing.indicator'
  | 'presence.changed'
  | 'conversation.updated'
  | 'participant.joined'
  | 'participant.left'
  | 'agent.registered'
  | 'agent.status'
  | 'task.notification'
  | 'event.subscription'
  | 'contact.request'
  | 'contact.accepted'
  | 'contact.rejected'
  | 'contact.cancelled'
  | 'contact.removed'
  | 'contact.blocked'
  | 'message.read'
  | 'community.reply'
  | 'community.vote'
  | 'community.answer.accepted'
  | 'community.mention'
  | 'reconnect.ack'
  | 'pong'
  // ─── v1.9.x daemon protocol (Track C) ───
  | 'host.acked' // ACK reply for `agent.host.declare`
  | 'agent.status.changed' // bidirectional: daemon emits, cloud broadcasts
  | 'task.dispatch.request' // cloud dispatches a task to a daemon
  | 'task.cancel' // cloud asks daemon to cancel a running task
  | 'approval.requested'
  | 'approval.decided'
  | 'task.approval.resolve' // release201/25 §16.4 A6 — cloud forwards user approval choice to daemon for hermes-native /v1/runs/{id}/approval
  // ─── v1.9.x schema-derived broadcasts (Track C / Track A) ───
  | 'agent.changed' // PATCH /agents/:id rename; cloud → user broadcast
  | 'workspace.changed' // im_workspaces row change; cloud → user broadcast
  | 'agent_profile.changed' // im_agent_profiles row change; cloud → user broadcast
  | 'workspace_file.changed' // im_workspace_files create/update/delete; cloud → user broadcast
  | 'asset.changed' // im_assets create/update/delete; cloud → user broadcast
  // ─── v5.4 memory layer (Memory Line A · A3) ───
  | 'memory.invalidate' // page soft-delete / visibility change; daemon refreshes its mirror
  // ─── v2.0.8 P0 (doc 21 §5) — chat dispatch in-flight lifecycle ───
  // Non-persistent fan-out signalling so AgentStateStrip can render the
  // active agent count in real time. Independent of the persisted task
  // step stream (im_task_run_steps) — those carry phase/tool granularity;
  // this carries just the coarse received → started → completed/failed
  // transitions a chat UI cares about.
  | 'dispatch.lifecycle'
  // ─── release201/09 §9.4b (2026-05-30) — workspace clear cascade ───
  // Final cascade step: cloud → daemon fan-out so daemon wipes local hermes
  // profile memories + per-agent memory dir cloud can't see.
  | 'workspace.clear.daemon-cleanup';

export interface WSMessage<T = unknown> {
  type: WSClientEventType | WSServerEventType;
  payload: T;
  requestId?: string;
  timestamp: number;
}

// ─── Agent Protocol ──────────────────────────────────────────
export type AgentStatus = 'online' | 'busy' | 'idle' | 'offline';

export interface AgentCapability {
  name: string;
  description: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AgentCard {
  agentId: string;
  name: string;
  description: string;
  agentType: AgentType;
  capabilities: AgentCapability[];
  protocolVersion: string;
  endpoint?: string;
  metadata: Record<string, unknown>;
}

export interface AgentHeartbeat {
  agentId: string;
  status: AgentStatus;
  load?: number; // 0-1 utilization
  activeConversations?: number;
  timestamp: number;
}

// ─── Presence ────────────────────────────────────────────────
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export interface PresenceInfo {
  userId: string;
  status: PresenceStatus;
  lastSeen: number;
  device?: string;
}

// ─── Webhook ─────────────────────────────────────────────────
export interface WebhookEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface WebhookPayload {
  source: 'prismer_im';
  event: string;
  timestamp: number;
  message: {
    id: string;
    type: string;
    content: string;
    senderId: string;
    conversationId: string;
    parentId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  };
  sender: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
  conversation: {
    id: string;
    type: string;
    title: string | null;
  };
}

// ─── API Response ────────────────────────────────────────────
export interface ApiErrorObject {
  code: string;
  message: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string | ApiErrorObject;
  meta?: Record<string, unknown>;
  /**
   * v2.0 release 200 P8 — non-blocking deprecation notice. Present on
   * legacy task action endpoints (start / complete / approve / reject /
   * cancel) and on PATCH /tasks/:id when deprecated body fields are
   * supplied. Callers should switch to POST /tasks/:id/transition. See
   * docs/migrations/v2.0/tasks-endpoint-migration.md.
   */
  _deprecation?: {
    endpoint: string;
    successor: string;
    sunset: string;
    note: string;
    fields?: string[];
  };
}

// ─── Registration ───────────────────────────────────────────
export interface RegisterInput {
  type: 'agent' | 'human';
  username: string;
  displayName: string;
  agentType?: AgentType;
  /** Optional target workspace for agent cards. Must be owned by the caller. */
  workspaceId?: string;
  capabilities?: string[];
  description?: string;
  endpoint?: string;
  webhookSecret?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterResult {
  imUserId: string;
  username: string;
  displayName: string;
  role: UserRole;
  token: string;
  expiresIn: string;
  capabilities?: string[];
  isNew: boolean;
}

// ─── Contacts ───────────────────────────────────────────────
export interface Contact {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  avatarUrl?: string;
  lastMessageAt: string;
  lastMessage?: string;
  unreadCount: number;
  conversationId: string;
  conversationType: ConversationType;
}

// ─── Discovery ──────────────────────────────────────────────
export interface DiscoverResult {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  agentType?: AgentType;
  capabilities?: string[];
  description?: string;
  status?: AgentStatus;
  isContact: boolean;
}

// ─── Pagination ──────────────────────────────────────────────
export interface PaginationParams {
  page?: number;
  pageSize?: number;
  cursor?: string;
  direction?: 'forward' | 'backward';
}

// ─── v0.3.0: Social Bindings ────────────────────────────────
export type BindingPlatform = 'telegram' | 'discord' | 'slack';
export type BindingStatus = 'pending' | 'active' | 'failed' | 'revoked';

export interface CreateBindingInput {
  platform: BindingPlatform;
  botToken?: string;
  chatId?: string;
  channelId?: string;
  webhookUrl?: string;
}

export interface VerifyBindingInput {
  code: string;
}

export interface BindingInfo {
  id: string;
  platform: BindingPlatform;
  status: BindingStatus;
  externalId?: string | null;
  externalName?: string | null;
  capabilities: string[];
  createdAt: Date;
}

// ─── v0.3.0: Credits ────────────────────────────────────────
export interface CreditBalance {
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

export interface DeductResult {
  success: boolean;
  balanceAfter: number;
  error?: string;
}

export interface CreditTx {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export interface TransferResult {
  success: boolean;
  senderBalanceAfter: number;
  recipientBalanceAfter: number;
  error?: string;
}

// ─── v0.3.0: Message Bridge ─────────────────────────────────
export type BridgeDirection = 'inbound' | 'outbound';
export type BridgeMessageStatus = 'sent' | 'delivered' | 'failed';

export interface BridgeResult {
  success: boolean;
  externalMessageId?: string;
  error?: string;
}

export interface InboundMessage {
  bindingId: string;
  externalMessageId: string;
  content: string;
  senderName: string;
  senderId: string;
  timestamp: Date;
}

// ─── v0.4.0: File Upload ────────────────────────────────
export type FileUploadStatus = 'pending' | 'uploaded' | 'confirmed' | 'failed';

export interface PresignInput {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface PresignResult {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface ConfirmResult {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export interface MultipartInitInput {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface MultipartInitResult {
  uploadId: string;
  parts: Array<{ partNumber: number; url: string }>;
  expiresAt: string;
}

export interface MultipartCompleteInput {
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface FileQuota {
  used: number;
  limit: number;
  tier: string;
  fileCount: number;
}

// ─── v1.7.2: Task Orchestration ─────────────────────────────

// v2.0 (release 200) §5.1: 9 statuses, 'blocked' between running and failed,
// 'awaiting_approval' for runs suspended on a human-approval gate.
//   pending → assigned → running → review → completed | failed | cancelled
//                              ↘ blocked ↗                ↑
//                              ↘ awaiting_approval ↗
//   blocked: agent self-reports stuck, needs human/orchestrator intervention.
//   awaiting_approval (2026-05-22, doc 12): agent invoked
//     `prismer.approval.request_human_approval` and the daemon-side reaper
//     would otherwise mark the run failed. The run is parked here until
//     the human decides; cloud then redispatches via `approval.decided`
//     (task.service.ts `applyApprovalDecisionAndRedispatch`) and the
//     status returns to running on the next dispatch.
export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'review'
  | 'blocked'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ScheduleType = 'once' | 'interval' | 'cron';
export type TaskDelivery = 'message' | 'webhook' | 'none';
export type SessionTarget = 'main' | 'isolated';
export type WakeMode = 'now' | 'nextHeartbeat';
export type TaskProductKind = 'work_item' | 'goal' | 'agent_run';

export interface TaskMetadata {
  /**
   * Product semantic carried by the reused /api/im/tasks endpoint.
   * - work_item/goal: board/task projections
   * - agent_run: bounded execution record spawned by chat/mention/task/goal
   */
  kind?: TaskProductKind | string;
  session_target?: SessionTarget;
  delivery?: TaskDelivery;
  wake_mode?: WakeMode;
  report_to?: string;
  format?: string;
  [key: string]: unknown;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  capability?: string;
  input?: Record<string, unknown>;
  contextUri?: string;
  assigneeId?: string; // Target agent (or "self")
  workspaceId?: string; // Target workspace (1.9.x; replaces scope)
  /** @deprecated v1.9.x dropped im_tasks.scope; use workspaceId. */
  scope?: string;
  conversationId?: string; // Associated conversation (v1.8.2)
  scheduleType?: ScheduleType;
  scheduleAt?: string; // ISO 8601 for "once"
  scheduleCron?: string; // Cron expression
  intervalMs?: number; // For "interval"
  maxRuns?: number;
  timeoutMs?: number;
  deadline?: string; // ISO 8601
  maxRetries?: number;
  retryDelayMs?: number;
  budget?: number;
  metadata?: TaskMetadata;
  /**
   * Cloud 3 / S3: execution surface.
   *   - 'agent'   (default): dispatch to a daemon-attached agent via IM
   *   - 'sandbox': spawn/reuse an IMContainer + run the task command in-pod
   *   - 'shell'   (reserved): direct shell exec, no sandbox
   */
  runtimeRoute?: 'agent' | 'sandbox' | 'shell';
  /**
   * release201/09 §4.1 — Project scope (Phase 2). Opt-in; NULL = workspace-
   * level task. Must reference an active IMProject in the same workspace.
   */
  projectId?: string | null;
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string | null;
  capability: string | null;
  input: Record<string, unknown>;
  contextUri: string | null;
  creatorId: string;
  assigneeId: string | null;
  workspaceId: string | null; // v1.9.x; replaces scope (column dropped in m3 phase 2)
  /** release201/09 Phase 2 — project scope. NULL = workspace-level. */
  projectId?: string | null;
  conversationId: string | null; // v1.8.2
  status: TaskStatus;
  progress: number | null; // v1.8.2: 0.0-1.0
  statusMessage: string | null; // v1.8.2
  scheduleType: ScheduleType | null;
  scheduleCron: string | null;
  intervalMs: number | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  runCount: number;
  maxRuns: number | null;
  result: unknown | null;
  resultUri: string | null;
  error: string | null;
  budget: number | null;
  cost: number;
  timeoutMs: number;
  deadline: Date | null;
  completedAt: Date | null; // v1.8.2
  maxRetries: number;
  retryDelayMs: number;
  retryCount: number;
  metadata: TaskMetadata;
  createdAt: Date;
  updatedAt: Date;
  // release201/10 — acceptance rolled-up summary (server-computed by
  // TaskAcceptanceService.recomputeStatus). 'none' when the task carries
  // no criteria.
  acceptanceStatus?: 'none' | 'pending' | 'partial' | 'passed' | 'failed';
  acceptanceCompletedCount?: number;
  acceptanceTotalCount?: number;
}

export interface TaskLogEntry {
  id: string;
  taskId: string;
  actorId: string | null;
  action: string;
  message: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ─── Approval Types (ACP) ───────────────────────────────────
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ApprovalInfo {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  taskId: string | null;
  requestedById: string;
  decidedById: string | null;
  category: string;
  /**
   * v2.0 §4.4.8.3 — server-side intent dedup hash. Computed at create-time
   * as sha256(workspace + conv + category + metadata.taskId + 1h-bucket).
   * `null` for legacy rows minted before migration 411. C3 UI groups
   * adjacent rows sharing the same `intentHash` under "Similar to above —
   * dedup proposed".
   */
  intentHash: string | null;
  title: string;
  context: string | null;
  options: ApprovalOption[];
  status: ApprovalStatus;
  selectedValue: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

export interface TaskProgressInput {
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskCompleteInput {
  result?: unknown;
  resultUri?: string;
  cost?: number;
}

export interface TaskFailInput {
  error: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface TaskListQuery {
  status?: TaskStatus;
  capability?: string;
  kind?: string | string[];
  view?: 'board' | 'runs' | 'all' | string;
  assigneeId?: string;
  creatorId?: string;
  workspaceId?: string;
  /** @deprecated v1.9.x dropped im_tasks.scope; use workspaceId. */
  scope?: string;
  conversationId?: string; // v1.8.2
  scheduleType?: ScheduleType;
  /**
   * release201/09 §4.2 — Project scope filter. Accepts:
   *   - `undefined` / empty / `'all'`  → no filter (default; same as Phase 1)
   *   - `'__unscoped'`                → projectId IS NULL
   *   - `'<id>'`                      → exact match
   *   - `'<id1>,<id2>,...'`           → IN list (multi-select chip)
   */
  projectId?: string;
  /**
   * Internal service hint from API auth middleware. When present, concrete
   * project filters are intersected with the actor's project membership.
   */
  requesterId?: string;
  limit?: number;
  cursor?: string;
}

// ─── v1.7.2: Identity & Signing (E2E Encryption) ────────────

export type DerivationMode = 'generated' | 'derived' | 'imported';
export type SigningPolicy = 'optional' | 'recommended' | 'required';

export interface IdentityKeyInfo {
  imUserId: string;
  publicKey: string; // Base64 Ed25519 public key
  keyId: string; // SHA-256(publicKey)[0:8] hex (16 chars)
  didKey?: string; // did:key:z... canonical DID derived from publicKey (AIP)
  attestation: string | null;
  derivationMode: DerivationMode;
  registeredAt: Date;
  revokedAt: Date | null;
}

export interface RegisterIdentityKeyInput {
  publicKey: string; // Base64 Ed25519 public key (32 bytes)
  derivationMode?: DerivationMode;
}

export interface KeyAuditEntry {
  id: number;
  imUserId: string;
  action: string; // register | rotate | revoke
  publicKey: string;
  keyId: string;
  attestation: string;
  prevLogHash: string | null;
  createdAt: Date;
}

export interface SignedMessageEnvelope {
  secVersion: number; // 1
  senderKeyId: string; // 16 hex chars
  sequence: number; // monotonic per (senderId, conversationId)
  contentHash: string; // SHA-256(content) hex
  prevHash: string | null; // previous message's contentHash
  signature: string; // Ed25519 signature (Base64)
}

export interface ConversationSecurityInfo {
  conversationId: string;
  signingPolicy: SigningPolicy;
  encryptionMode: string;
}

export interface ReplayWindow {
  highestSeq: number;
  windowBitmap: string; // BigInt serialized as string for JSON compat
}

// ─── v1.7.2: Memory Layer ───────────────────────────────────

export type MemoryOwnerType = 'user' | 'agent' | 'workspace';
export type MemoryFileOperation = 'append' | 'replace' | 'replace_section';

export interface MemoryFileInfo {
  id: string;
  workspaceId: string;
  ownerId: string;
  ownerType: MemoryOwnerType;
  scope: string;
  path: string;
  version: number;
  contentLength: number;
  memoryType?: string | null;
  description?: string | null;
  stale?: boolean;
  visibility?: string;
  aclJson?: string | null;
  encrypted?: boolean;
  contentHash?: string;
  etag?: string | null;
  sourceKind?: string | null;
  sourceRef?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryFileDetail extends MemoryFileInfo {
  content: string;
}

export interface CreateMemoryFileInput {
  path: string;
  content: string;
  /** v2.0: storage bucket; 'global' is accepted as workspace-shared alias. */
  scope?: string;
  ownerType?: MemoryOwnerType;
}

export interface UpdateMemoryFileInput {
  operation: MemoryFileOperation;
  content: string;
  section?: string;
  version?: number;
}

export interface CompactionSummary {
  id: string;
  conversationId: string;
  summary: string;
  messageRangeStart: string | null;
  messageRangeEnd: string | null;
  tokenCount: number;
  createdAt: Date;
}

export interface CompactInput {
  conversationId: string;
  summary?: string;
}

// ─── v1.7.2: Skill Evolution ────────────────────────────────

export type GeneCategory = 'repair' | 'optimize' | 'innovate' | 'diagnostic';

/**
 * GeneSelector: pluggable interface for gene selection algorithms (§3.3).
 *
 * Implementations receive pre-loaded data (genes, edges, global priors) and
 * return scored candidates. DB queries remain in EvolutionService.
 *
 * Built-in implementations:
 *   - ThompsonSelector (default): Beta posterior sampling × tag coverage
 *   - LaplaceSelector (legacy): deterministic point estimate + drift noise
 */
export interface GeneSelectorInput {
  genes: PrismerGene[];
  signalTags: SignalTag[];
  edgeMap: Map<string, { success: number; failure: number; lastScore: number | null; lastUsedAt: Date | null }>;
  globalEdges: Array<{ geneId: string; _sum: { successCount: number | null; failureCount: number | null } }>;
  wGlobal: number;
  breakerCheck: (geneId: string) => { allowed: boolean; state: string };
  semanticCache?: Map<string, number>; // Layer 3: LLM signal-pair similarity cache
  banThreshold?: number; // v1.8.0: override default BAN_THRESHOLD for fallback (default 0.18)
}

export interface ScoredGene {
  gene: PrismerGene;
  score: number;
  confidence: number;
  coverageScore: number;
  // v0.4.0: multi-dimensional rank
  matchLayer?: 'exact' | 'prefix' | 'semantic' | 'none';
  rankScore?: number;
  providerMatch?: boolean;
  stageMatch?: boolean;
}

export interface GeneSelector {
  readonly name: string;
  score(input: GeneSelectorInput): ScoredGene[];
}
export type EvolutionOutcome = 'success' | 'failed' | 'pending';
export type GeneVisibility = 'private' | 'canary' | 'published' | 'quarantined' | 'seed';

/**
 * SignalTag: hierarchical label set for a trigger dimension (v0.3.0).
 *
 * A signal event = a set of SignalTags describing the current situation's multi-dimensional facets.
 * Backward compat: old string[] signals are normalized to [{ type: signal }].
 *
 * Example: { type: "error:500", provider: "openai", stage: "api_call" }
 */
export interface SignalTag {
  type: string; // Required. Coarse category. "error:500" | "task:refactor" | "error:rateLimit"
  provider?: string; // Optional. Source. "openai" | "mysql" | "exa" | "github"
  stage?: string; // Optional. Execution phase. "api_call" | "data_fetch" | "batch_write"
  severity?: string; // Optional. Severity. "critical" | "transient" | "degraded"
  [key: string]: string | undefined; // Extensible, not exhaustively enumerated
}

export interface PrismerGene {
  type: 'Gene';
  id: string;
  category: GeneCategory;
  title?: string;
  description?: string;
  visibility?: GeneVisibility;
  signals_match: SignalTag[]; // v0.3.0: hierarchical tag sets (was string[])
  preconditions: string[];
  strategy: string[];
  constraints: {
    max_credits: number;
    max_retries: number;
    required_capabilities: string[];
  };
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  created_by: string;
  distilled_from?: string[];
  parentGeneId?: string | null;
  forkCount?: number;
  generation?: number;
  qualityScore?: number; // 0..1 normalized quality score (anti-cheat / leaderboard)
}

export interface AgentPersonality {
  rigor: number;
  creativity: number;
  risk_tolerance: number;
}

export interface PersonalityStats {
  [configKey: string]: {
    success: number;
    failure: number;
    avg_score: number;
  };
}

export interface EvolutionAdvice {
  action: 'apply_gene' | 'explore' | 'none' | 'create_suggested';
  gene_id?: string;
  gene?: PrismerGene;
  strategy?: string[];
  confidence: number;
  signals: SignalTag[]; // v0.3.0: hierarchical tags (was string[])
  coverageScore?: number; // v0.3.0: tag coverage score for best match
  alternatives?: Array<{ gene_id: string; confidence: number }>;
  reason?: string;
  suggestion?: {
    category: GeneCategory;
    signals_match: SignalTag[]; // v0.3.0: hierarchical tags (was string[])
    title: string;
    description: string;
    similar_genes: Array<{ gene_id: string; title: string; similarity: number }>;
  };
  // v0.4.0: multi-dimensional rank
  rank?: Array<{
    gene_id: string;
    title?: string;
    rankScore: number;
    matchLayer: 'exact' | 'prefix' | 'semantic' | 'none';
    confidence: number;
    reason: string;
  }>;
  // v1.8.0: related memory files for cross-layer context
  relatedMemories?: Array<{
    id: string;
    path: string;
    snippet: string;
    relevance: number;
  }>;
  fallback?: 'relaxed_ban' | 'hypergraph_neighbor' | 'baseline'; // v1.8.0: which fallback level was used
}

export interface EvolutionRecordInput {
  gene_id: string;
  signals: string[] | SignalTag[]; // v0.3.0: accepts both formats (backward compat)
  outcome: 'success' | 'failed';
  score?: number;
  summary: string;
  cost_credits?: number;
  metadata?: Record<string, unknown>;
  raw_context?: string; // v0.4.0: optional raw context for LLM enrichment (async)
  strategy_used?: string[]; // v0.4.0: actual steps agent executed (for attribution scoring)
  transition_reason?: string; // v1.8.0: 'gene_applied' | 'fallback_relaxed' | 'fallback_neighbor' | 'baseline'
  context_snapshot?: Record<string, unknown>; // v1.8.0: execution context (signals, memoryCount, etc.)
}

/** v0.4.0 — Evolution report input (async LLM aggregation) */
export interface EvolutionReportInput {
  raw_context: string; // REQUIRED: error message, log excerpt, task output (max 4KB)
  task?: string; // Task description
  outcome: 'success' | 'failed'; // REQUIRED
  score?: number; // 0-1
  provider?: string; // k8s, openai, aws...
  stage?: string; // deploy, fetch, build...
  severity?: string; // low, medium, high, critical
  gene_id?: string; // If executing a specific gene
}

/** Extraction trace stored in capsule.metadata */
export interface ExtractionTrace {
  raw_context: string; // Original input
  extraction_method: 'llm' | 'regex' | 'regex_fallback' | 'cached';
  extraction_model?: string; // LLM model used
  extraction_latency_ms: number;
  extracted_signals: SignalTag[];
  root_cause?: string;
  gene_alternatives?: Array<{ id: string; title?: string; score: number; reason?: string }>;
  gene_match_confidence?: number;
}

export interface EvolutionAnalyzeInput {
  context?: string;
  signals?: string[] | SignalTag[]; // v0.3.0: accepts both formats
  task_id?: string;
}

export interface EvolutionEdgeInfo {
  signal_key: string;
  gene_id: string;
  success_count: number;
  failure_count: number;
  confidence: number;
  last_score: number | null;
  last_used_at: string | null;
}

export interface EvolutionReport {
  agent_id: string;
  total_capsules: number;
  success_rate: number;
  top_genes: Array<{ gene_id: string; uses: number; success_rate: number }>;
  personality: AgentPersonality;
  recent_trend: 'improving' | 'declining' | 'stable';
}

// ─── v1.7.3: Event Subscriptions ─────────────────────────────

export interface PlatformEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  source?: string;
}

export interface SubscriptionFilter {
  capability?: string;
  conversationId?: string;
  agentId?: string;
  creatorId?: string;
  source?: string;
  [key: string]: unknown;
}

export interface CreateSubscriptionInput {
  events: string[];
  filter?: SubscriptionFilter;
  delivery?: 'message' | 'webhook' | 'sync';
  webhookUrl?: string;
  webhookSecret?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

// ─── Contact System Events (v1.8.0 P9) ──────────────────
export type ContactEventType =
  | 'contact.request'
  | 'contact.accepted'
  | 'contact.rejected'
  | 'contact.cancelled'
  | 'contact.removed'
  | 'contact.blocked';

export interface ContactRequestPayload {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  fromUsername?: string;
  fromDisplayName?: string;
  reason?: string;
  source?: string;
  createdAt: string;
}

export interface ContactAcceptedPayload {
  fromUserId: string;
  toUserId: string;
  conversationId: string;
  username?: string;
  displayName?: string;
  acceptedAt: string;
}

export interface ContactRejectedPayload {
  fromUserId: string;
  toUserId: string;
  requestId: string;
  rejectedAt: string;
}

export interface ContactCancelledPayload {
  fromUserId: string;
  toUserId: string;
  requestId: string;
  cancelledAt: string;
}

export interface ContactRemovedPayload {
  userId: string;
  removedUserId: string;
  removedAt: string;
}

export interface ContactBlockedPayload {
  userId: string;
  blockedUserId: string;
  blockedAt: string;
}

export interface ConversationCreatedPayload {
  conversationId: string;
  type: string;
  participants: string[];
  createdAt: string;
}

export interface MessageDeliveredPayload {
  conversationId: string;
  messageIds: string[];
  userId: string;
  deliveredAt: string;
}

export interface MessageReadPayload {
  conversationId: string;
  messageIds: string[];
  userId: string;
  readAt: string;
}

// ─── v1.9.x event payload types (Track C) ────────────────────
export * from './im-events';

// ─── Conversation context envelope (release201/26 Phase 1) ───
export * from './conversation-envelope';
