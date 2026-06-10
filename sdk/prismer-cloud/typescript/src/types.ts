/**
 * Prismer Cloud SDK — Type definitions
 */

import type { StorageAdapter } from './storage';

// ============================================================================
// Environment
// ============================================================================

export type Environment = 'production';

export const ENVIRONMENTS: Record<Environment, string> = {
  production: 'https://prismer.cloud',
} as const;

// ============================================================================
// Config
// ============================================================================

export interface PrismerConfig {
  /** API Key (starts with sk-prismer-) or IM JWT token. Optional for anonymous IM registration. */
  apiKey?: string;
  /** Environment preset (default: 'production'). Sets the base URL automatically. */
  environment?: Environment;
  /** Base URL override. Takes priority over `environment` if both are set. */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
  /** Default X-IM-Agent header for IM requests (select which agent identity to use) */
  imAgent?: string;
  /**
   * Default X-IM-Workspace header for IM requests (release202/09 §3.6 B).
   * Lets the cloud agent-proxy reach its workspace-scoped fallback when the
   * owner `userId`/`numericId` bridge can't resolve the agent. Optional —
   * absent header preserves legacy behavior.
   */
  imWorkspace?: string;
  /** Enable offline-first mode for IM with local persistence and sync */
  offline?: OfflineConfig;
  /**
   * AIP identity for automatic message signing (v1.8.0 S1).
   * - `'auto'`: derive Ed25519 key from apiKey via SHA-256
   * - `{ privateKey: string }`: Base64-encoded Ed25519 private key
   * When set, all IM send requests auto-include senderDid + signature.
   */
  identity?: 'auto' | { privateKey: string };
  /** v1.8.0 CommunityHub cache tuning (`im.community`) */
  community?: CommunityHubConfig;
}

/** Options for `CommunityHub` (see `community-hub.ts`) */
export interface CommunityHubConfig {
  feedTTLMs?: number;
  statsTTLMs?: number;
}

// ============================================================================
// Context API Types
// ============================================================================

export interface LoadOptions {
  inputType?: 'auto' | 'url' | 'urls' | 'query';
  processUncached?: boolean;
  search?: { topK?: number };
  processing?: { strategy?: 'auto' | 'fast' | 'quality'; maxConcurrent?: number };
  return?: { format?: 'hqcc' | 'raw' | 'both'; topK?: number };
  ranking?: {
    preset?: 'cache_first' | 'relevance_first' | 'balanced';
    custom?: { cacheHit?: number; relevance?: number; freshness?: number; quality?: number };
  };
}

export interface RankingFactors {
  cache: number;
  relevance: number;
  freshness: number;
  quality: number;
}

export interface LoadResultItem {
  rank?: number;
  url: string;
  title?: string;
  hqcc?: string | null;
  raw?: string;
  cached: boolean;
  cachedAt?: string;
  processed?: boolean;
  found?: boolean;
  error?: string;
  ranking?: { score: number; factors: RankingFactors };
  meta?: Record<string, any>;
}

export interface SingleUrlCost { credits: number; cached: boolean }
export interface BatchUrlCost { credits: number; cached: number }
export interface QueryCost { searchCredits: number; compressionCredits: number; totalCredits: number; savedByCache: number }

export interface BatchSummary { total: number; found: number; notFound: number; cached: number; processed: number }
export interface QuerySummary { query: string; searched: number; cacheHits: number; compressed: number; returned: number }

export interface LoadResult {
  success: boolean;
  requestId?: string;
  mode?: 'single_url' | 'batch_urls' | 'query';
  result?: LoadResultItem;
  results?: LoadResultItem[];
  summary?: BatchSummary | QuerySummary;
  cost?: SingleUrlCost | BatchUrlCost | QueryCost;
  processingTime?: number;
  error?: { code: string; message: string };
}

export interface SaveOptions {
  url: string;
  hqcc: string;
  raw?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  meta?: Record<string, any>;
}

export interface SaveBatchOptions {
  items: SaveOptions[];
}

export interface SaveResult {
  success: boolean;
  status?: string;
  url?: string;
  content_uri?: string;
  visibility?: string;
  results?: Array<{ url: string; status: string; content_uri?: string }>;
  summary?: { total: number; created: number; updated?: number; failed?: number; exists?: number };
  error?: { code: string; message: string };
}

// ============================================================================
// Parse API Types
// ============================================================================

export interface ParseOptions {
  url?: string;
  base64?: string;
  filename?: string;
  mode?: 'fast' | 'hires' | 'auto';
  output?: 'markdown' | 'json';
  image_mode?: 'embedded' | 's3';
  wait?: boolean;
}

export interface ParseDocumentImage {
  page: number;
  url: string;
  caption?: string;
}

export interface ParseDocument {
  markdown?: string;
  text?: string;
  pageCount: number;
  metadata?: { title?: string; author?: string; [key: string]: any };
  images?: ParseDocumentImage[];
  estimatedTime?: number;
}

export interface ParseUsage {
  inputPages: number;
  inputImages: number;
  outputChars: number;
  outputTokens: number;
}

export interface ParseCostBreakdown {
  pages: number;
  images: number;
}

export interface ParseCost {
  credits: number;
  breakdown?: ParseCostBreakdown;
}

export interface ParseResult {
  success: boolean;
  requestId?: string;
  mode?: string;
  async?: boolean;
  document?: ParseDocument;
  usage?: ParseUsage;
  cost?: ParseCost;
  taskId?: string;
  status?: string;
  endpoints?: { status: string; result: string; stream: string };
  processingTime?: number;
  error?: { code: string; message: string };
}

// ============================================================================
// IM API Types
// ============================================================================

export interface IMRegisterOptions {
  type: 'agent' | 'human';
  username: string;
  displayName: string;
  agentType?: 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';
  capabilities?: string[];
  description?: string;
  endpoint?: string;
}

export interface IMRegisterData {
  imUserId: string;
  username: string;
  displayName: string;
  role: string;
  token: string;
  expiresIn: string;
  capabilities?: string[];
  isNew: boolean;
}

export interface IMUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string;
}

export interface IMAgentCard {
  agentType: string;
  capabilities: string[];
  description?: string;
  status: string;
}

export interface IMMeData {
  user: IMUser;
  agentCard?: IMAgentCard;
  stats: { conversationCount: number; directCount?: number; groupCount?: number; contactCount: number; messagesSent: number; unreadCount: number };
  bindings: Array<{ platform: string; status: string; externalName?: string }>;
  credits: { balance: number; totalSpent: number };
}

export interface IMTokenData {
  token: string;
  expiresIn: string;
}

export interface IMMessageAttachment {
  kind: 'file' | 'image' | 'audio' | 'video' | 'asset';
  assetId: string;
  title?: string;
  filename?: string;
  mime?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
  revision?: number | null;
  role?: 'attachment' | 'context' | 'output';
}

// ── v2.0 §4.6 ContentBlock — multimodal protocol-layer typing ───────────────
//
// Anthropic-shape discriminated union ("kind" tag). NOT OpenAI's
// `{ type: 'image_url', image_url: { url } }` shape — adapters translate to
// vendor-specific wire format at dispatch time. See docs/release200/14-…md
// §4.6 + 14b "与 14 主文档的关系" for the source-of-truth definition.
//
// All 8 variants are surfaced here so message senders, daemon runtime, and
// built-in skill outputs can speak the same protocol.

/** MIME types accepted for inline images (extend as needed). */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | (string & {});
/** MIME types accepted for inline audio. */
export type AudioMime = 'audio/mpeg' | 'audio/wav' | 'audio/webm' | 'audio/ogg' | (string & {});
/** MIME types accepted for inline video. */
export type VideoMime = 'video/mp4' | 'video/webm' | 'video/quicktime' | (string & {});

export type ContentBlockText      = { kind: 'text';        text: string };
export type ContentBlockImage     = { kind: 'image';       assetId: string; mediaType: ImageMime; alt?: string };
export type ContentBlockAudio     = { kind: 'audio';       assetId: string; mediaType: AudioMime; durationMs?: number };
export type ContentBlockVideo     = { kind: 'video';       assetId: string; mediaType: VideoMime; durationMs?: number; thumbnailUrl?: string };
export type ContentBlockFile      = { kind: 'file';        assetId: string; mediaType: string; filename: string };
export type ContentBlockToolUse   = { kind: 'tool_use';    toolCallId: string; toolName: string; inputJson: unknown };
export type ContentBlockToolResult = { kind: 'tool_result'; toolCallId: string; output: ContentBlock[] };
export type ContentBlockReasoning = { kind: 'reasoning';   text: string; redacted?: boolean };

/** v2.0 §4.6 ContentBlock discriminated union (Anthropic-shape, 8 variants). */
export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockAudio
  | ContentBlockVideo
  | ContentBlockFile
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockReasoning;

/**
 * v2.0 §4.6 ChatMessage — used by TaskInput.messages and other multi-turn
 * dispatch shapes. Content may be a plain string (legacy / single-text) or a
 * ContentBlock[] (multimodal). Adapters MUST handle both forms.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  /** Optional name (tool message provenance, OpenAI-compat). */
  name?: string;
  /** Optional tool_call_id (for role='tool' responses). */
  toolCallId?: string;
}

/**
 * Task input payload (v2.0 — adds optional `messages` for native multimodal
 * dispatch). `prompt` remains for legacy single-text path. Daemon adapters
 * prefer `messages` when present; `prompt` is converted to a single user
 * ChatMessage when `messages` is omitted.
 */
export interface TaskInput {
  /** Legacy single-text prompt. Kept for backward compatibility. */
  prompt?: string;
  /** v2.0 §4.6 multi-turn message array (preferred path for multimodal). */
  messages?: ChatMessage[];
  /** Arbitrary capability-specific input fields. */
  [k: string]: unknown;
}

export interface IMMessage {
  id: string;
  conversationId?: string;
  content: string;
  type: string;
  senderId: string;
  parentId?: string | null;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, any> | string;
  attachments?: IMMessageAttachment[] | null;
  /**
   * v2.0 §4.6 — multimodal content blocks. Coexists with `content` (single
   * string) and `attachments` (legacy) for the 6-sprint double-write window.
   * When the server returns ContentBlock[], renderers should prefer this.
   */
  contentBlocks?: ContentBlock[] | null;
  /**
   * v2.0 §4.1 — per-conversation strictly monotonic boundary sequence number
   * stamped by the server inside the same tx as the message insert.
   * SDK clients persist this as their reconcile cursor.
   */
  boundarySeq?: number;
}

export interface IMRouting {
  mode: string;
  targets: Array<{ userId: string; username?: string }>;
}

export interface IMMessageData {
  conversationId: string;
  message: IMMessage;
  routing?: IMRouting;
}

export interface IMGroupMember {
  userId: string;
  username: string;
  displayName?: string;
  role: string;
}

export interface IMGroupData {
  groupId: string;
  title: string;
  description?: string;
  members: IMGroupMember[];
}

export interface IMContact {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  isAgent?: boolean;
  institution?: string;
  lastSeenAt?: string;
  remark?: string;
  addedAt?: string;
  lastMessageAt?: string;
  lastMessage?: string;
  unreadCount: number;
  conversationId: string;
  conversationType?: string;
}

export interface IMUserProfile {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  status?: string;
  isAgent?: boolean;
  agentType?: string;
  capabilities?: string[];
  description?: string;
  institution?: string;
  did?: string;
  isContact?: boolean;
  lastSeenAt?: string;
}

export interface IMFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  reason?: string;
  source?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  updatedAt: string;
  fromUser?: { username: string; displayName: string; avatarUrl?: string };
  toUser?: { username: string; displayName: string; avatarUrl?: string };
}

export interface IMBlockedUser {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  reason?: string;
  blockedAt: string;
}

export interface IMDiscoverAgent {
  username: string;
  displayName: string;
  agentType?: string;
  capabilities?: string[];
  status: string;
}

export interface IMBindingData {
  bindingId: string;
  platform: string;
  status: string;
  verificationCode: string;
}

export interface IMBinding {
  bindingId: string;
  platform: string;
  status: string;
  externalName?: string;
}

export interface IMCreditsData {
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

export interface IMTransaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

export interface IMConversation {
  id: string;
  type: string;
  title?: string;
  lastMessage?: IMMessage;
  unreadCount?: number;
  members?: IMGroupMember[];
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface IMWorkspaceData {
  workspaceId?: string;
  conversationId: string;
  user?: { imUserId: string; token: string };
  agent?: any;
}

export interface IMWorkspaceInitOptions {
  workspaceId: string;
  userId: string;
  userDisplayName: string;
  agentName?: string;
  agentDisplayName?: string;
  agentType?: string;
  agentCapabilities?: string[];
  force?: boolean;
}

export interface IMWorkspaceInitGroupOptions {
  workspaceId: string;
  title: string;
  description?: string;
  users?: Array<{ userId: string; displayName: string }>;
  agents?: Array<{ name: string; displayName?: string; type?: string; capabilities?: string[] }>;
  force?: boolean;
}

export interface IMAutocompleteResult {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

export interface IMCreateGroupOptions {
  title: string;
  description?: string;
  members?: string[];
  metadata?: Record<string, any>;
}

export interface IMCreateBindingOptions {
  platform: 'telegram' | 'discord' | 'slack' | 'wechat' | 'x' | 'line';
  botToken: string;
  chatId?: string;
  channelId?: string;
}

export interface IMSendOptions {
  type?: 'text' | 'markdown' | 'code' | 'image' | 'file' | 'voice' | 'location' | 'artifact' | 'tool_call' | 'tool_result' | 'system_event' | 'system' | 'thinking';
  metadata?: Record<string, any>;
  attachments?: IMMessageAttachment[] | null;
  parentId?: string;
  /** Quote-reply reference (v1.8.2). Distinct from parentId threading. */
  quotedMessageId?: string;
  /** Override auto-signing for this message (e.g., skip signing for system_event) */
  skipSigning?: boolean;
  /**
   * v2.0 §3.0.2 Gap A-④ — idempotency key for safe retry.
   *
   * If omitted, the SDK auto-generates a UUID (`crypto.randomUUID()`) per
   * send call and includes it in the `X-Idempotency-Key` HTTP header. The
   * server applies UNIQUE `(conversationId, idempotencyKey)` dedup
   * (see migration 401 + B1 server endpoint).
   *
   * Explicit callers (e.g. retry wrappers) should pass the same key across
   * all retry attempts to trigger server-side dedup. Pairs cleanly with the
   * server's P2002 race-safe re-read path (see message.service.ts).
   */
  idempotencyKey?: string;
  /**
   * v2.0 §4.6 — multimodal content blocks. When set, `content` is treated as
   * a fallback summary string for adapters that don't speak ContentBlock yet.
   */
  contentBlocks?: ContentBlock[];
}

export interface IMPaginationOptions {
  limit?: number;
  offset?: number;
}

export interface IMConversationsOptions {
  withUnread?: boolean;
  unreadOnly?: boolean;
}

export interface IMDiscoverOptions {
  type?: string;
  capability?: string;
  /** Filter agents by presence status (`online`, `all`). Contacts router. */
  status?: string;
  /** Convenience flag for agents router compat (`onlineOnly=true`). */
  onlineOnly?: string;
  /** Search query (username/displayName/DID prefix). */
  q?: string;
  /** Pagination limit. */
  limit?: string;
  /** Pagination offset. */
  offset?: string;
}

// ── File Upload ─────────────────────────────────────────────

export interface IMPresignOptions {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface IMPresignResult {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface IMConfirmResult {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export interface IMFileQuota {
  used: number;
  limit: number;
  tier: string;
  fileCount: number;
}

// ── File Upload (high-level) ─────────────────────────────

/** Input source for upload() — polymorphic across Node.js and browser */
export type FileInput = File | Blob | Buffer | Uint8Array | string;

export interface UploadOptions {
  /** File name (required if input is Buffer/Uint8Array/Blob without name) */
  fileName?: string;
  /** MIME type (auto-detected from fileName extension if not provided) */
  mimeType?: string;
  /** Progress callback */
  onProgress?: (uploaded: number, total: number) => void;
}

export interface UploadResult {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export interface SendFileOptions extends UploadOptions {
  /** Message content (defaults to fileName) */
  content?: string;
  /** Parent message ID for threading */
  parentId?: string;
}

export interface SendFileResult {
  upload: UploadResult;
  message: any;
}

export interface IMMultipartInitResult {
  uploadId: string;
  parts: Array<{ partNumber: number; url: string }>;
  expiresAt: string;
}

/** Generic IM API response wrapper */
export interface IMResult<T = any> {
  ok: boolean;
  data?: T;
  meta?: { total?: number; pageSize?: number };
  error?: { code: string; message: string };
}

// ── Offline Configuration ──────────────────────────────────────

export interface OfflineConfig {
  /** Storage adapter implementation (IndexedDBStorage, MemoryStorage, SQLiteStorage) */
  storage: StorageAdapter;
  /** Auto-sync on reconnect (default: true) */
  syncOnConnect?: boolean;
  /** Max retries per outbox operation (default: 5) */
  outboxRetryLimit?: number;
  /** Outbox flush interval in ms (default: 1000) */
  outboxFlushInterval?: number;
  /** Conflict strategy: 'server' = server wins, 'client' = client wins (default: 'server') */
  conflictStrategy?: 'server' | 'client';
  /** Custom conflict resolver — called when server and local message diverge */
  onConflict?: (local: import('./storage').StoredMessage, remote: { type: string; data: any; seq: number }) => 'keep_local' | 'accept_remote' | import('./storage').StoredMessage;
  /** Sync mode: 'push' = SSE continuous stream, 'poll' = periodic polling (default: 'push') */
  syncMode?: 'push' | 'poll';
  /** Enable multi-tab coordination via BroadcastChannel (default: true in browser, false in Node.js) */
  multiTab?: boolean;
  /** E2E encryption config */
  e2e?: {
    enabled: boolean;
    /** User passphrase for master key derivation (PBKDF2) */
    passphrase: string;
  };
  /** Storage quota config */
  quota?: {
    /** Max storage size in bytes (default: 500MB) */
    maxStorageBytes?: number;
    /** Warning threshold 0-1 (default: 0.9 = 90%) */
    warningThreshold?: number;
  };
}

// ============================================================================
// Tasks API Types
// ============================================================================

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled';
export type ScheduleType = 'once' | 'interval' | 'cron';

export interface IMCreateTaskOptions {
  title: string;
  description?: string;
  capability?: string;
  input?: Record<string, unknown>;
  contextUri?: string;
  assigneeId?: string;
  scheduleType?: ScheduleType;
  scheduleAt?: string;
  scheduleCron?: string;
  intervalMs?: number;
  maxRuns?: number;
  timeoutMs?: number;
  deadline?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  budget?: number;
  metadata?: Record<string, unknown>;
  /** v1.9.x: workspace scope. Defaults to caller's default workspace. */
  workspaceId?: string;
  /** release201/09 Phase 2: scope task to a project. null = workspace-level. */
  projectId?: string | null;
  /** v1.9.x: link task to a conversation thread. */
  conversationId?: string;
  /** v1.9.x: pick the executor — `agent` (default), `sandbox`, or `shell`. */
  runtimeRoute?: 'agent' | 'sandbox' | 'shell';
}

export interface IMUpdateTaskOptions {
  title?: string;
  description?: string;
  status?: TaskStatus;
  progress?: number;
  statusMessage?: string;
  assigneeId?: string;
  metadata?: Record<string, unknown>;
}

export interface IMTaskListOptions {
  status?: TaskStatus;
  capability?: string;
  /** Filter by task-store semantic kind. Defaults to board work items/goals. */
  kind?: string;
  /** Explicit view selection: board, runs, or all. */
  view?: 'board' | 'runs' | 'all';
  assigneeId?: string;
  creatorId?: string;
  scheduleType?: ScheduleType;
  limit?: number;
  cursor?: string;
  /** v1.9.x: filter by workspace. */
  workspaceId?: string;
  /** release201/09 Phase 2: project filter. Use '__unscoped' for NULL projectId. */
  projectId?: string;
  /** v1.9.x: filter by conversation. */
  conversationId?: string;
}

export interface IMCompleteTaskOptions {
  result?: unknown;
  resultUri?: string;
  cost?: number;
}

export interface IMTask {
  id: string;
  title: string;
  description: string | null;
  capability: string | null;
  input: Record<string, unknown>;
  contextUri: string | null;
  creatorId: string;
  assigneeId: string | null;
  status: TaskStatus;
  progress: number | null;
  statusMessage: string | null;
  conversationId: string | null;
  completedAt: string | null;
  ownerId: string;
  ownerType: string | null;
  ownerName: string | null;
  assigneeType: string | null;
  assigneeName: string | null;
  scheduleType: ScheduleType | null;
  scheduleCron: string | null;
  intervalMs: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
  result: unknown | null;
  resultUri: string | null;
  error: string | null;
  budget: number | null;
  cost: number;
  timeoutMs: number;
  deadline: string | null;
  maxRetries: number;
  retryDelayMs: number;
  retryCount: number;
  metadata: Record<string, unknown>;
  /** Workspace (1.9.x); null on legacy rows pre-workspace-scope. */
  workspaceId?: string | null;
  /** release201/09 Phase 2 — project scope. NULL = workspace-level. */
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IMTaskLog {
  id: string;
  taskId: string;
  actorId: string | null;
  action: string;
  message: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IMTaskDetail {
  task: IMTask;
  logs: IMTaskLog[];
}

/**
 * Wave-9 Phase 1 (v1.9.4) — canonical task / run result.
 *
 * Replaces the legacy IMAsset(kind=task-result) read pattern. Returned by
 * `tasks.getResult()` and `tasks.getRunResult()`. Shape locked by design
 * review and intentionally minimal.
 *
 *   - `output`      The agent's primary text reply, normalised from the
 *                   stored result JSON. May be null for tasks that
 *                   completed with no textual content.
 *   - `assetIds`    Daemon-collected outbox attachments (Wave-9). Always
 *                   an array (possibly empty); never undefined.
 *   - `metrics`     Adapter cost / duration / tokens. Optional — older
 *                   tasks predate the column.
 *   - `resultUri`   Optional prismer:// pointer for blob results. Most
 *                   tasks use the inline `output` field; this is for
 *                   cases that exceed the JSON column budget.
 *   - `completedAt` ISO string. For pending/running tasks falls back to
 *                   `updatedAt` so the field is always populated.
 */
export interface IMTaskResult {
  taskId: string;
  status: string;
  output: string | null;
  metrics?: Record<string, unknown> | null;
  assetIds: string[];
  resultUri?: string | null;
  completedAt: string;
}

// ============================================================================
// Memory API Types
// ============================================================================

export interface IMCreateMemoryFileOptions {
  path: string;
  content: string;
  scope?: string;
  ownerType?: 'user' | 'agent';
  /** v1.8.0 — semantic memory type (user | feedback | project | reference). */
  memoryType?: 'user' | 'feedback' | 'project' | 'reference';
  /** v1.8.0 — human-readable description shown in memory listings. */
  description?: string;
}

export interface IMUpdateMemoryFileOptions {
  operation: 'append' | 'replace' | 'replace_section';
  content: string;
  section?: string;
  version?: number;
}

export interface IMCompactOptions {
  conversationId: string;
  summary: string;
  messageRangeStart?: string;
  messageRangeEnd?: string;
}

export interface IMMemoryFile {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'agent' | 'workspace';
  scope: string;
  path: string;
  version: number;
  contentLength: number;
  createdAt: string;
  updatedAt: string;
}

export interface IMMemoryFileDetail extends IMMemoryFile {
  content: string;
}

export interface IMCompactionSummary {
  id: string;
  conversationId: string;
  summary: string;
  messageRangeStart: string | null;
  messageRangeEnd: string | null;
  tokenCount: number;
  createdAt: string;
}

export interface IMMemoryLoadResult {
  content: string | null;
  totalLines: number;
  totalBytes: number;
  version: number;
  id: string | null;
  scope: string;
  path: string;
  template: string;
}

// ============================================================================
// Knowledge Links API Types
// ============================================================================

export type KnowledgeLinkSource = 'memory' | 'gene' | 'capsule' | 'signal';
export type KnowledgeLinkType = 'related' | 'derived_from' | 'applied_in' | 'contradicts';

export interface IMKnowledgeLink {
  id: string;
  sourceType: KnowledgeLinkSource;
  sourceId: string;
  targetType: KnowledgeLinkSource;
  targetId: string;
  linkType: KnowledgeLinkType;
  strength: number;
  scope: string;
  createdAt: string;
}

export interface IMMemoryKnowledgeLinks {
  links: Array<{
    memoryId: string;
    memoryPath: string;
    genes: Array<{
      geneId: string;
      title: string;
      linkType: string;
      strength: number;
      successRate: number;
    }>;
  }>;
  unlinkedMemories: string[];
  totalLinks: number;
}

// ============================================================================
// Identity API Types
// ============================================================================

export type DerivationMode = 'generated' | 'derived' | 'imported';

export interface IMRegisterKeyOptions {
  publicKey: string;
  /** Legacy CLI compatibility. Identity keys are Ed25519; server currently ignores this field. */
  algorithm?: string;
  derivationMode?: DerivationMode;
}

export interface IMIdentityKey {
  imUserId: string;
  publicKey: string;
  keyId: string;
  attestation: string | null;
  derivationMode: DerivationMode;
  registeredAt: string;
  revokedAt: string | null;
  serverPublicKey?: string;
}

export interface IMKeyAuditEntry {
  id: number;
  imUserId: string;
  action: 'register' | 'rotate' | 'revoke';
  publicKey: string;
  keyId: string;
  attestation: string;
  prevLogHash: string | null;
  createdAt: string;
}

export interface IMKeyVerifyResult {
  valid: boolean;
  invalidAt?: number;
}

// ============================================================================
// Evolution API Types
// ============================================================================

export type GeneCategory = 'repair' | 'optimize' | 'innovate' | 'diagnostic';
export type GeneVisibility = 'private' | 'canary' | 'published' | 'quarantined' | 'seed';

/** v0.3.0 SignalTag — hierarchical label for a trigger dimension */
export interface SignalTag {
  type: string;
  provider?: string;
  stage?: string;
  severity?: string;
  [key: string]: string | undefined;
}

export interface IMCreateGeneOptions {
  category: GeneCategory;
  signals_match: string[] | SignalTag[];
  strategy: string[];
  title?: string;
  preconditions?: string[];
  constraints?: Record<string, unknown>;
}

export interface IMAnalyzeOptions {
  context?: string;
  signals?: string[] | SignalTag[];
  task_status?: string;
  task_capability?: string;
  error?: string;
  tags?: string[];
  custom_signals?: string[];
  provider?: string;
  stage?: string;
  severity?: string;
}

export interface IMRecordOutcomeOptions {
  gene_id: string;
  signals: string[] | SignalTag[];
  outcome: 'success' | 'failed';
  score?: number;
  summary: string;
  cost_credits?: number;
  metadata?: Record<string, unknown>;
  strategy_used?: string[];
}

export interface IMGene {
  type: string;
  id: string;
  category: GeneCategory;
  title?: string;
  description?: string;
  visibility?: GeneVisibility;
  signals_match: SignalTag[];
  preconditions: string[];
  strategy: string[];
  constraints: Record<string, unknown>;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  created_by: string;
  distilled_from?: string[];
  parentGeneId?: string | null;
  forkCount?: number;
  generation?: number;
}

export interface IMAnalyzeResult {
  action: 'apply_gene' | 'explore' | 'none' | 'create_suggested';
  gene_id?: string;
  gene?: IMGene;
  strategy?: string[];
  confidence: number;
  coverageScore?: number;
  signals: SignalTag[];
  alternatives?: Array<{ gene_id: string; confidence: number }>;
  reason?: string;
  suggestion?: {
    category: GeneCategory;
    signals_match: SignalTag[];
    title: string;
    description: string;
    similar_genes: Array<{ gene_id: string; title: string; similarity: number }>;
  };
}

export interface IMEvolutionStats {
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
}

export interface IMCapsule {
  id: string;
  gene_id: string;
  agent_id: string;
  signals: string[];
  outcome: string;
  score: number;
  summary: string;
  created_at: string;
}

export interface IMEvolutionEdge {
  signal_key: string;
  gene_id: string;
  success_count: number;
  failure_count: number;
  confidence: number;
  last_score: number | null;
  last_used_at: string | null;
}

export interface IMAgentPersonality {
  rigor: number;
  creativity: number;
  risk_tolerance: number;
}

export interface IMGeneListOptions {
  category?: GeneCategory;
  search?: string;
  sort?: 'newest' | 'most_used' | 'highest_success';
  page?: number;
  limit?: number;
}

export interface IMForkGeneOptions {
  gene_id: string;
  modifications?: Record<string, unknown>;
}

// ============================================================================
// Skill Ecosystem Types
// ============================================================================

export interface IMSkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  source: string;
  sourceUrl: string;
  installs: number;
  stars: number;
  status: string;
  version: string;
  compatibility: string[];
  signals: SignalTag[];
  geneId: string | null;
  hasPackage: boolean;
  fileCount: number;
}

export interface IMSkillSearchOptions {
  query?: string;
  category?: string;
  source?: string;
  compatibility?: string;
  sort?: 'newest' | 'most_installed' | 'most_starred' | 'name' | 'relevance' | 'recommended';
  page?: number;
  limit?: number;
}

export interface IMSkillCreateInput {
  name: string;
  description: string;
  category: string;
  tags?: string[];
  content?: string;
  signals?: Array<{ type: string }>;
  author?: string;
  sourceUrl?: string;
}

export interface IMSkillUpdateInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  content?: string;
  status?: string;
  geneId?: string;
}

export interface IMSkillInstallResult {
  agentSkill: { id: string; status: string; version: string; installedAt: string };
  gene: IMGene | null;
  skill: IMSkillInfo & { content: string };
  installGuide: Record<string, { auto?: string; manual?: string; command?: string; [key: string]: any }>;
}

export interface IMAgentSkillRecord {
  agentSkill: {
    id: string;
    skillId: string;
    geneId: string | null;
    status: string;
    version: string;
    installedAt: string;
    installedRevision?: string | null;
    lastSyncedAt?: string | null;
    lastSyncError?: string | null;
  };
  skill: IMSkillInfo;
  gene: IMGene | null;
  expectedRevision?: string | null;
  syncState?: 'pending' | 'synced' | 'error';
}

export interface IMSkillContent {
  content: string;
  packageUrl: string | null;
  files: Array<{ path: string; size: number }>;
  checksum: string | null;
}

export interface IMAgentSkillListOptions {
  agentId?: string;
  workspaceId?: string;
  includeInactive?: boolean;
}

export interface IMAgentSkillInstallOptions {
  workspaceId?: string;
  config?: Record<string, unknown>;
  version?: string;
}

export interface IMAgentSkillAckInput {
  skillId?: string;
  slug?: string;
  revision?: string;
  installedRevision?: string;
  status?: string;
  error?: string | null;
  lastSyncError?: string | null;
}

// ============================================================================
// Agent Spec / Lifecycle Types
// ============================================================================

export interface IMAgentSpec {
  identity: {
    did?: string | null;
    imUserId: string;
    displayName: string;
    username?: string;
    avatarUrl?: string;
  };
  definition: {
    roleTemplateSlug?: string;
    operatingPrinciples?: unknown;
    hermesConfig?: unknown;
    openclawConfig?: unknown;
    profileConfig: Record<string, unknown>;
    taskAuthority: 'executor' | 'orchestrator' | string;
    approvalPolicy: 'strict' | 'auto-low-risk' | 'autonomous' | string;
  };
  skills: Array<{
    skillSlug: string;
    version: string;
    source: string;
    config?: Record<string, unknown>;
    envDeps?: Record<string, unknown>;
    executable?: Record<string, unknown>;
  }>;
  memory: {
    scope: 'agent-private' | 'workspace-shared' | string;
    storeRef: string;
  };
  environment: {
    containerImage: string;
    containerSnapshot?: string | null;
    perAgentDirs: string[];
    envVars?: Record<string, unknown>;
    quotas?: Record<string, unknown>;
  };
  workspaceId?: string;
  agentCard?: Record<string, unknown>;
}

export interface IMAgentSnapshot {
  id: string;
  agentImUserId: string;
  workspaceId: string;
  definition: IMAgentSpec['definition'];
  skills: IMAgentSpec['skills'];
  containerSnapshotId?: string | null;
  perAgentDirManifest?: unknown;
  memoryDumpRef?: string | null;
  includeMemory: boolean;
  createdAt: string;
  createdBy?: string;
  status: string;
  sizeBytes?: number | null;
}

export interface IMAgentPack {
  id: string;
  slug: string;
  version: string;
  publisherImUserId: string;
  publisherDid: string;
  definition: IMAgentSpec['definition'];
  skills: IMAgentSpec['skills'];
  environment: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  license: string;
  curatedQuality: string;
  status: string;
  createdAt: string;
}

export interface IMAgentSnapshotOptions {
  includeMemory?: boolean;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface IMAgentRestoreOptions {
  snapshotId: string;
  overrideMemory?: boolean;
}

export interface IMAgentPublishOptions {
  slug?: string;
  version?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  stripMemory?: boolean;
}

export interface IMAgentPackListOptions {
  q?: string;
  curatedQuality?: string;
  license?: string;
  publisherDid?: string;
  cursor?: string;
  limit?: number;
}

export interface IMAgentForkOptions {
  targetWorkspaceId: string;
  displayName?: string;
  identityOptions?: {
    avatarUrl?: string;
    publicKeyBase64?: string;
  };
}

export interface IMAgentForkResult {
  agentSpec: IMAgentSpec;
  newDid?: string | null;
  newImUserId: string;
  package: IMAgentPack;
}

/**
 * Per-call options for the internal request function (v2.0).
 * `headers` — extra request headers to merge in (caller wins over default
 *   Authorization/X-IM-Agent on collision).
 */
export interface RequestOpts {
  headers?: Record<string, string>;
}

/**
 * Internal request function type.
 *
 * v2.0: added optional 5th `opts` parameter so callers can inject extra
 * headers (e.g. `X-Idempotency-Key` for message sends). Backward compatible —
 * existing 4-arg callsites still type-check.
 */
export type RequestFn = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>, opts?: RequestOpts) => Promise<T>;

// ============================================================================
// Evolution Mechanism Types (used by EvolutionCache, SignalEnrichment, Runtime)
// ============================================================================

export interface ExecutionContext {
  error?: string;
  provider?: string;
  stage?: string;
  severity?: string;
  taskStatus?: string;
  taskCapability?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SignalEnrichmentConfig {
  mode: 'rules' | 'llm';
  llmExtract?: (ctx: ExecutionContext) => Promise<SignalTag[]>;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface GeneSelectionResult {
  action: 'apply_gene' | 'create_suggested' | 'none';
  gene_id?: string;
  gene?: IMGene;
  strategy?: string[];
  confidence: number;
  coverageScore?: number;
  alternatives?: Array<{ gene_id: string; confidence: number; title?: string }>;
  reason?: string;
  fromCache: boolean;
}

export interface EvolutionSyncSnapshot {
  genes: IMGene[];
  edges: IMEvolutionEdge[];
  globalPrior: Record<string, { alpha: number; beta: number }>;
  cursor: number;
}

export interface EvolutionSyncDelta {
  pulled: {
    genes: IMGene[];
    edges: IMEvolutionEdge[];
    globalPrior: Record<string, { alpha: number; beta: number }>;
    promotions: string[];
    quarantines: string[];
    cursor: number;
  };
}

// ============================================================================
// v1.9.3 — Workspaces, Workspace Files, Assets, Runtime Installations,
// Account agents, Memory digest
// ============================================================================

/**
 * Top-level workspace resource (v1.9.x). 1.9.x is 1:1 — most accounts have a
 * single default workspace named "Personal". Multi-workspace promotion is a
 * 1.10+ concern.
 */
export interface IMWorkspace {
  id: string;
  ownerImUserId: string;
  name: string;
  /** URL-safe slug; immutable in 1.9.x. Pattern: `^[a-z0-9][a-z0-9-]{0,63}$`. */
  slug: string;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IMCreateWorkspaceOptions {
  name: string;
  slug: string;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
}

export interface IMUpdateWorkspaceOptions {
  /** Display name (immutable fields: slug, isDefault). */
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface IMWorkspaceSyncResult {
  items: IMWorkspace[];
  /** ISO timestamp cursor for next sync, or null when no rows returned. */
  cursor: string | null;
}

/**
 * Workspace orchestrator agent (release 200 §4 "Chief of Staff") — the single
 * agent per workspace authorized by the owner to perform high-trust task
 * actions (dispatch / approve / reject / cancel any task). Null on the GET
 * envelope when no active appointment exists.
 */
export interface IMWorkspaceOrchestrator {
  agentImUserId: string;
  agentUsername: string;
  agentDisplayName: string;
  /** ISO-8601 timestamp of appointment. */
  authorizedAt: string;
  authorizedByImUserId: string;
  authorizedByDisplayName: string;
}

export interface IMWorkspaceOrchestratorEnvelope {
  workspace: { id: string; name: string; ownerImUserId: string };
  orchestrator: IMWorkspaceOrchestrator | null;
}

/**
 * Workspace file = path → assetId binding inside a workspace. Auto-versions
 * on POST: previous binding at the same path is soft-deleted, version bumps,
 * and `parentVersionId` chains the history.
 */
export interface IMWorkspaceFile {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash?: string;
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface IMCreateWorkspaceFileOptions {
  /** Relative path; no `..`, no leading `/`, ≤ 700 chars. */
  path: string;
  /** Existing asset ID in the same workspace. */
  assetId: string;
}

export interface IMWorkspaceFileSyncResult {
  items: IMWorkspaceFile[];
  cursor: string | null;
}

export type IMAssetPreviewKind =
  | 'image'
  | 'pdf'
  | 'media'
  | 'text'
  | 'html'
  | 'table'
  | 'document'
  | 'code'
  | 'archive'
  | 'download-only';

export type IMAssetPreviewStatus = 'ready' | 'processing' | 'partial' | 'unsupported' | 'too_large' | 'failed';

export interface IMAssetPreviewContract {
  kind: IMAssetPreviewKind;
  status: IMAssetPreviewStatus;
  maxInlineBytes: number;
  contentLength?: number;
  byteRangeSupported?: boolean;
  preferredRenderer?:
    | 'native'
    | 'monaco'
    | 'markdown'
    | 'iframe-safe-html'
    | 'table-sample'
    | 'page-viewer'
    | 'video-js';
  inlinePolicy?: 'allow' | 'sample-only' | 'metadata-only' | 'download-only';
  pageCount?: number;
  rowCountApprox?: number;
  sheetCount?: number;
  extractorVersion?: string;
  etag?: string;
  derivatives: Array<{
    type:
      | 'thumbnail'
      | 'text'
      | 'html_safe'
      | 'table_sample'
      | 'schema'
      | 'page_text'
      | 'archive_listing'
      | 'pdf_linearized'
      | 'hls_manifest';
    assetId?: string;
    url?: string;
    endpoint?: string;
    metadata?: Record<string, unknown>;
  }>;
  warnings?: Array<{ code: string; message: string }>;
  securityWarnings?: Array<{ code: string; message: string }>;
}

/**
 * Asset = content-addressed immutable blob (sha256). Same hash + same workspace
 * dedupes to a single row.
 */
export interface IMAsset {
  id: string;
  workspaceId: string;
  ownerImUserId: string;
  contentHash: string;
  /** `file://...` for filesystem backend, `s3://bucket/key` for S3 backend. */
  storageUri: string;
  sizeBytes: number | null;
  mime: string | null;
  /** Caller-supplied row-level kind label. Common values: `sandbox-output`, `photo-memory-segment`, `user-upload`. */
  kind: string;
  sourceAgentImUserId: string | null;
  sourceTaskId: string | null;
  metadata: Record<string, unknown>;
  cdnUrl?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
  revision?: number;
  createdAt: string;
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

export interface IMAssetListOptions {
  workspaceId?: string;
  taskId?: string;
  kind?: string;
  /** Page size, 1–200. Default 50. */
  limit?: number;
}

export interface IMAssetUploadOptions {
  workspaceId: string;
  /** Row-level asset kind label (e.g. `sandbox-output`, `user-upload`). */
  kind?: string;
  sourceAgentImUserId?: string;
  sourceTaskId?: string;
  /** Override the auto-detected MIME type. */
  mimeType?: string;
  /** Override the file name when input has none (Buffer / Uint8Array). */
  fileName?: string;
  metadata?: Record<string, unknown>;
  /** Progress callback. */
  onProgress?: (uploaded: number, total: number) => void;
}

export interface IMAssetDetail extends IMAsset {
  /** Freshly-signed S3 URL when storage is S3, else `null`. Expires per `expiresIn` seconds. */
  url?: string | null;
  s3Url?: string | null;
  expiresIn?: number;
  preview?: IMAssetPreviewContract | null;
  /** Reverse-lookup of `photo-memory-segment` references when applicable. */
  photoRefs?: Array<{ localId: string; sourceHash: string; assetId: string }>;
}

/**
 * Runtime installation = long-running daemon host inside a workspace
 * (vs. short-lived per-task sandbox). Built on top of IMContainer rows
 * with `taskId === null`.
 */
export type RuntimePhase = 'provisioning' | 'online' | 'degraded' | 'stopped' | 'failed';

export interface IMRuntimeInstallation {
  id: string;
  workspaceId: string;
  /**
   * v2.0.8 M448 (release201/20 §1) — optional project scope. `null` means the
   * installation is workspace-level (default + every pre-M448 row). When set,
   * narrows UI scope filters / Insights aggregation; daemon dispatch routing
   * is unaffected (per-agent — see 09 §9.9).
   */
  projectId?: string | null;
  runtimeInstanceId: string;
  daemonId: string;
  podName: string;
  namespace: string;
  phase: RuntimePhase;
  desiredState: 'running' | 'stopped' | string;
  status: string;
  image: string;
  imageTag: string;
  warmPoolHit: boolean;
  resources: {
    cpuRequest: string;
    cpuLimit: string;
    memoryRequest: string;
    memoryLimit: string;
  };
  gatewayUrl: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metrics: {
    ageMs: number;
    provisionLatencyMs: number;
    heartbeatAgeMs: number | null;
    hostedAgents: number;
    onlineHostedAgents: number;
  };
  observability: {
    statusFreshness: string;
    logsPath: string;
    startPath: string;
    stopPath: string;
    snapshotPath: string;
  };
  events: Array<{
    at: string;
    kind: string;
    severity: string;
    message: string;
  }>;
}

export interface IMCreateRuntimeInstallationOptions {
  workspaceId: string;
  name?: string;
  image?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  /**
   * v2.0.8 M448 (release201/20 §1) — opt-in project scope. Must reference an
   * `active` project in the same workspace; omitting yields a workspace-level
   * installation (backward-compatible default).
   */
  projectId?: string;
}

/**
 * v2.0.8 M448 (release201/20 §1) — PATCH body for updating an existing
 * runtime installation's project binding. The only mutable field today.
 * Pass `null` to detach the installation from its current project.
 */
export interface IMPatchRuntimeInstallationOptions {
  projectId?: string | null;
}

export interface IMInstallAgentOnRuntimeOptions {
  agentImUserId: string;
  /** Existing AgentProfile id; if omitted, creates one with `adapterName` + `profileName`. */
  profileId?: string;
  adapterName?: string;
  profileName?: string;
  config?: Record<string, unknown>;
}

export interface IMInstallAgentOnRuntimeResult {
  runtimeInstallationId: string;
  podName: string;
  result: unknown;
  profile: {
    id: string;
    agentImUserId: string;
    adapterName: string;
    name: string;
    version: number;
  };
}

/** Row from `GET /api/im/me/agents` — agents owned by the current human. */
export interface IMOwnedAgent {
  id: string;
  username: string;
  displayName: string;
  agentType: string | null;
  avatarUrl: string | null;
  createdAt: string;
  card: {
    name: string;
    description: string | null;
    capabilities: string[];
    endpoint: string | null;
    status: string;
    workspaceId: string;
    lastHeartbeat: string | null;
  } | null;
}

export interface IMAccountDeleteResult {
  message: string;
  deletedAt: string;
  cascade: Record<string, unknown>;
}

/** Memory digest (CC-style always-load summary) */
export interface IMMemoryDigest {
  digest: string;
  totalLines: number;
  totalBytes: number;
  filesSummarized: number;
  filesTotal: number;
  truncated: boolean;
  generatedAt: string;
}

export interface IMMemoryDigestOptions {
  scope?: string;
  /** 10–1000 (clamped server-side); default 200. */
  maxLines?: number;
  /** 500–30000 (clamped server-side); default 6000. */
  maxBytes?: number;
}

/** Task SSE events (v1.8.2) */
export type TaskEventType =
  | 'connected'
  | 'task.created'
  | 'task.assigned'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.updated';

export interface TaskEventEnvelope<P = Record<string, unknown>> {
  /** Stable event id (`Last-Event-ID` for replay). */
  id?: string;
  type: TaskEventType;
  payload: P;
}

/** Task `kind` taxonomy (v1.9.x). Server reads `metadata.kind` to drive goal projections. */
export type TaskKind = 'work_item' | 'goal';

/** Task `runtimeRoute` taxonomy (v1.9.x). Picks which executor handles dispatch. */
export type RuntimeRoute = 'agent' | 'sandbox' | 'shell';
